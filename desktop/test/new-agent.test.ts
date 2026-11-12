// New agent, following the iPhone app's
// CompanionSidebarNewSheet / CompanionNewAgentEmpty and HerdrKit's
// WorkspaceActions.newAgent with AgentStartCommands: the start per kind with a
// fake Herdr (agent.start, the Mac's typed `cl`, a shell; a refused start
// closes its pane; no agent after the command leaves the pane), the demo's
// Herdr, the request the main process accepts, the sheet's model (workspaces,
// folders, kinds, the last kind), the dialog (Return starts, Esc cancels, ↑ ↓
// the kind), the sidebar's New agent row, each workspace header's + and its
// right-click, and ⌘N.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { DemoBackend, demoStartCommands } from "../src/main/demo/demo-backend";
import { demoHosts, type DemoFixtures } from "../src/main/demo/demo-hosts";
import { AgentStartFailed, newAgent, type NewAgentClock, type NewAgentHerdr, type NewAgentResult } from "../src/main/herdr/new-agent";
import { APIError, decodeSessionTopology, type AgentInfo, type TabCreation } from "../src/main/herdr/wire";
import { appShortcut } from "../src/shared/app-keys";
import { buildDesktopSidebar } from "../src/shared/desktop-sidebar";
import type { HostView } from "../src/shared/ipc-contract";
import {
  defaultPlace,
  lastKind,
  lastKindKey,
  newAgentKinds,
  newAgentNote,
  newAgentPlaces,
  rememberKind,
  shortFolder,
  type NewAgentPlace,
} from "../src/shared/new-agent";
import { emptyFoldState } from "../src/shared/sidebar-model";
import { absentStartCommands, parseStartCommands, startCommandsWith } from "../src/shared/start-commands";
import { HookHost, elements } from "./support/fake-hooks";
import { fixturesRoot } from "./support/swift-fixtures";

const { isNewAgentRequest } = await import("../src/main/ipc");
const { NewAgentDialog } = await import("../src/renderer/components/NewAgentDialog");
const { Sidebar } = await import("../src/renderer/components/Sidebar");
const { startCommandsStore } = await import("../src/renderer/components/resume");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");

const encode = (text: string) => new TextEncoder().encode(text);
const cl = parseStartCommands(encode('{"claude": "cl"}'));

// MARK: - The start, with a fake Herdr

class FakeHerdr implements NewAgentHerdr {
  readonly calls: string[] = [];
  agents: AgentInfo[] = [{ paneID: "w1:p1", name: "claude", agent: "claude" }];
  /** What `agent.list` reports for the new pane after the command is typed (null: never). */
  typedAgent: string | null = "claude";
  startError: Error | null = null;
  sendError: Error | null = null;
  private typed = false;

  agentList(): Promise<AgentInfo[]> {
    this.calls.push("agent.list");
    const typed = this.typed && this.typedAgent !== null ? [{ paneID: "w1:pn1", name: "claude-2", agent: this.typedAgent }] : [];
    return Promise.resolve([...this.agents, ...typed]);
  }

  createTerminalTab(workspaceID: string, label: string | null, cwd: string | null): Promise<TabCreation> {
    this.calls.push(`tab.create ${workspaceID} label=${label} cwd=${cwd}`);
    return Promise.resolve({
      tab: { tabID: "w1:tn1", workspaceID, label: label ?? "" },
      rootPane: { paneID: "w1:pn1", workspaceID, tabID: "w1:tn1" },
    } as unknown as TabCreation);
  }

  startAgent(name: string, kind: string, paneID: string): Promise<AgentInfo> {
    this.calls.push(`agent.start ${name} ${kind} ${paneID}`);
    if (this.startError !== null) return Promise.reject(this.startError);
    return Promise.resolve({ paneID, name, agent: kind });
  }

  closePane(paneID: string): Promise<void> {
    this.calls.push(`pane.close ${paneID}`);
    return Promise.resolve();
  }

  sendInput(pane: string, text: string, keys: readonly string[]): Promise<void> {
    this.calls.push(`pane.send_input ${pane} ${JSON.stringify(text)} ${keys.join(",")}`);
    if (this.sendError !== null) return Promise.reject(this.sendError);
    this.typed = true;
    return Promise.resolve();
  }
}

/** A clock whose sleeps pass at once (and move its time on). */
function fakeClock(): NewAgentClock & { slept: number } {
  let now = 0;
  const clock = {
    slept: 0,
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      clock.slept += 1;
      return Promise.resolve();
    },
  };
  return clock;
}

describe("New agent's start, per kind", () => {
  it("Claude with no agents.json: a tab named for it at the folder, then agent.start (a free name)", async () => {
    const herdr = new FakeHerdr();
    // The `~` folder goes as the machine's home joined with the rest.
    const machine = { name: "Mac mini", home: async () => "/Users/fixture" };
    const result = await newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: "~/code/app", kind: "claude" }, fakeClock(), 90_000, 1_000, machine);
    expect(herdr.calls).toEqual(["agent.list", "tab.create w1 label=claude-2 cwd=/Users/fixture/code/app", "agent.start claude-2 claude w1:pn1"]);
    expect(result).toMatchObject({ paneId: "w1:pn1", name: "claude-2", kind: "claude", start: { type: "herdr" }, summary: null });
  });

  it("Claude with the Mac's {\"claude\": \"cl\"}: cl and Return typed once, then agent.list until Claude is there", async () => {
    const herdr = new FakeHerdr();
    const result = await newAgent(herdr, cl, { workspaceId: "w1", folder: null, kind: "claude" }, fakeClock());
    expect(herdr.calls).toEqual(["agent.list", "tab.create w1 label=claude-2 cwd=null", 'pane.send_input w1:pn1 "cl" Enter', "agent.list"]);
    expect(result.start).toEqual({ type: "typed", command: "cl" });
  });

  it("Codex and Grok: Herdr starts them (agents.json names only Claude)", async () => {
    for (const kind of ["codex", "grok"]) {
      const herdr = new FakeHerdr();
      const result = await newAgent(herdr, cl, { workspaceId: "w1", folder: "", kind }, fakeClock());
      expect(herdr.calls).toEqual(["agent.list", `tab.create w1 label=${kind} cwd=null`, `agent.start ${kind} ${kind} w1:pn1`]);
      expect(result.start.type).toBe("herdr");
    }
  });

  it("a shell: tab.create alone, no name, no agent", async () => {
    const herdr = new FakeHerdr();
    const result = await newAgent(herdr, cl, { workspaceId: "w1", folder: "/srv", kind: "shell" }, fakeClock());
    expect(herdr.calls).toEqual(["tab.create w1 label=null cwd=/srv"]);
    expect(result).toMatchObject({ paneId: "w1:pn1", name: null, kind: "shell", start: { type: "shell" } });
  });

  it("a refused agent.start closes the pane it made, so a retry leaves no orphan tab", async () => {
    const herdr = new FakeHerdr();
    herdr.startError = new APIError("agent_start_failed", "codex is not installed");
    const failure = await newAgent(herdr, cl, { workspaceId: "w1", folder: null, kind: "codex" }, fakeClock()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentStartFailed);
    // Herdr's words, never its code.
    expect((failure as AgentStartFailed).message).toBe("Herdr did not start Codex: codex is not installed");
    expect(herdr.calls.at(-1)).toBe("pane.close w1:pn1");
  });

  it("typing refused closes the pane too; typing with no answer is never repeated and the wait decides", async () => {
    const refused = new FakeHerdr();
    refused.sendError = new APIError("pane_not_found", "gone");
    await expect(newAgent(refused, cl, { workspaceId: "w1", folder: null, kind: "claude" }, fakeClock())).rejects.toThrow("typing “cl” was refused");
    expect(refused.calls.at(-1)).toBe("pane.close w1:pn1");

    const silent = new FakeHerdr();
    silent.sendError = new Error("timed out");
    silent.typedAgent = null;
    const clock = fakeClock();
    const result = await newAgent(silent, cl, { workspaceId: "w1", folder: null, kind: "claude" }, clock, 5_000, 1_000);
    expect(silent.calls.filter((call) => call.startsWith("pane.send_input"))).toHaveLength(1);
    expect(silent.calls).not.toContain("pane.close w1:pn1");
    expect(result.start).toEqual({ type: "noAgent", command: "cl" });
  });

  it("no Claude after the command: the pane is left open with a line saying so", async () => {
    const herdr = new FakeHerdr();
    herdr.typedAgent = null;
    const clock = fakeClock();
    const result = await newAgent(herdr, cl, { workspaceId: "w1", folder: null, kind: "claude" }, clock, 90_000, 1_000);
    expect(result.start).toEqual({ type: "noAgent", command: "cl" });
    expect(result.summary).toBe("No Claude Code agent appeared after typing “cl”. The pane is left open.");
    expect(clock.slept).toBe(90);
    expect(herdr.calls).not.toContain("pane.close w1:pn1");
  });
});

// MARK: - The demo's Herdr

const read = (file: string): Buffer => readFileSync(path.join(fixturesRoot, file));
const json = (file: string): unknown => JSON.parse(read(file).toString("utf8"));
const fixtures: DemoFixtures = {
  sidebarWorkspaces: json("protocol22/sidebar-workspaces.json") as unknown[],
  sidebarTabs: json("protocol22/sidebar-tabs.json") as unknown[],
  sidebarPanes: json("protocol22/sidebar-panes.json") as unknown[],
  mockAgentList: json("protocol22/mock-agent-list.json"),
  idle: new Uint8Array(read("replay/idle.hfx")),
  heavy: new Uint8Array(read("replay/heavy-excerpt.hfx")),
  bashDialog: read("replay/claude-2.1.303-bash-dialog.txt").toString("utf8"),
};
const noTimers = { schedule: () => () => undefined };

describe("New agent on the demo's Herdr", () => {
  // The demo's ~/.adari/agents.json says {"claude": "claude"} (a personal alias such as `cl` belongs in no demo).
  it("claude typed starts Claude in a new tab of the workspace; Codex through agent.start; a shell has no agent", async () => {
    const [host] = demoHosts(fixtures, 1_800_000_000_000);
    const backend = new DemoBackend(host!, fixtures, noTimers);
    const before = await backend.snapshot();
    const workspace = before.workspaces[0]!.workspaceID;
    const commands = parseStartCommands(encode(demoStartCommands));
    const claude = await newAgent(backend.workspaceActions(), commands, { workspaceId: workspace, folder: "/fixture/app", kind: "claude" }, fakeClock());
    const codex = await newAgent(backend.workspaceActions(), commands, { workspaceId: workspace, folder: null, kind: "codex" }, fakeClock());
    const shell = await newAgent(backend.workspaceActions(), commands, { workspaceId: workspace, folder: null, kind: "shell" }, fakeClock());
    expect(claude.start).toEqual({ type: "typed", command: "claude" });
    expect(codex.start).toEqual({ type: "herdr" });
    const after = await backend.snapshot();
    const paneOf = (id: string) => after.panes.find((pane) => pane.paneID === id);
    expect(paneOf(claude.paneId)).toMatchObject({ workspaceID: workspace, agent: "claude", cwd: "/fixture/app" });
    expect(paneOf(codex.paneId)?.agent).toBe("codex");
    expect(paneOf(shell.paneId)?.agent).toBeUndefined();
    expect(after.panes).toHaveLength(before.panes.length + 3);
    backend.close();
  });
});

// MARK: - What the main process accepts

describe("the herdr:new-agent request", () => {
  it("a workspace id, a folder or null, and a kind in Herdr's agent grammar (or shell)", () => {
    expect(isNewAgentRequest({ workspaceId: "w1", folder: null, kind: "claude" })).toBe(true);
    expect(isNewAgentRequest({ workspaceId: "w1", folder: "~/code", kind: "shell" })).toBe(true);
    expect(isNewAgentRequest({ workspaceId: "w1", folder: null, kind: "Claude; rm" })).toBe(false);
    expect(isNewAgentRequest({ workspaceId: "", folder: null, kind: "claude" })).toBe(false);
    expect(isNewAgentRequest({ workspaceId: "w1", folder: 3, kind: "claude" })).toBe(false);
    expect(isNewAgentRequest({ workspaceId: "w1", folder: "x".repeat(70_000), kind: "claude" })).toBe(false);
    expect(isNewAgentRequest(null)).toBe(false);
  });
});

// MARK: - The sheet's model

function twoWorkspaces() {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [
      { workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" },
      { workspace_id: "w2", number: 2, label: "ops", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w2:t1", agent_status: "idle" },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "", focused: true, pane_count: 2, agent_status: "idle" },
      { tab_id: "w2:t1", workspace_id: "w2", number: 1, label: "", focused: false, pane_count: 1, agent_status: "idle" },
    ],
    panes: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/Users/r/code/app", agent: "claude", agent_status: "idle", revision: 1 },
      { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/Users/r/code/app/web", agent_status: "unknown", revision: 1 },
      { pane_id: "w2:p1", terminal_id: "t3", workspace_id: "w2", tab_id: "w2:t1", focused: false, cwd: "/Users/r/ops", agent_status: "unknown", revision: 1 },
    ],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }],
  });
}

const mini: HostView = { id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null, state: "connected", error: null, fetchedAtMs: 0, topology: twoWorkspaces() };
const away: HostView = { ...mini, id: "away", name: "MacBook", state: "offline" };

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("the sheet's model", () => {
  it("every answering machine's workspaces in Herdr's order, each with its own folder and its panes' folders", () => {
    const places = newAgentPlaces([mini, away]);
    expect(places.map((place) => `${place.hostName} · ${place.workspace}`)).toEqual(["Mac mini · app", "Mac mini · ops"]);
    expect(places[0]).toMatchObject({ folder: "/Users/r/code/app", suggestions: ["/Users/r/code/app", "/Users/r/code/app/web"] });
  });

  it("opens for the wanted workspace (the selected pane's, a header's), else the first", () => {
    const places = newAgentPlaces([mini]);
    expect(defaultPlace(places, { hostId: "mini", workspaceId: "w2" })?.workspace).toBe("ops");
    expect(defaultPlace(places, { hostId: "away", workspaceId: "w2" })?.workspace).toBe("app");
    expect(defaultPlace(places, null)?.workspace).toBe("app");
    expect(defaultPlace([], null)).toBeNull();
  });

  // Every kind Herdr can start (test/mac-agents.test.ts has the whole list and its order).
  it("the kinds: Claude Code (cl from agents.json), Codex, every other kind Herdr starts, any other kind the file names, and a shell", () => {
    const kinds = newAgentKinds(startCommandsWith({ type: "read" }, { claude: "cl", aider: "aider --dark" }));
    const lines = kinds.map((kind) => `${kind.title}: ${kind.detail}`);
    expect(lines.slice(0, 3)).toEqual(["Claude Code: Runs cl", "Codex: Herdr starts codex", "Pi: Herdr starts pi"]);
    expect(lines).toContain("Grok Build: Herdr starts grok");
    expect(lines.slice(-2)).toEqual(["Aider: Runs aider --dark", "Shell: A shell in its own tab"]);
    expect(newAgentKinds(null).map((kind) => kind.kind).slice(0, 3)).toEqual(["claude", "codex", "pi"]);
    expect(newAgentKinds(null).at(-1)?.kind).toBe("shell");
  });

  it("the kind the user picked last comes back (Claude at first)", () => {
    const storage = new MemoryStorage();
    expect(lastKind(storage)).toBe("claude");
    rememberKind(storage, "codex");
    expect(storage.values.get(lastKindKey)).toBe("codex");
    expect(lastKind(storage)).toBe("codex");
    storage.setItem(lastKindKey, "<bad>");
    expect(lastKind(storage)).toBe("claude");
    expect(lastKind(null)).toBe("claude");
  });

  it("the footer says what Return does", () => {
    const [place] = newAgentPlaces([mini]);
    const kinds = newAgentKinds(cl);
    const [claude, shell] = [kinds[0], kinds.at(-1)];
    expect(newAgentNote(claude!, place!, "/Users/r/code/app/web")).toBe("Runs cl in …/code/app/web");
    expect(newAgentNote(shell!, place!, "")).toBe("Opens a shell in app");
    expect(shortFolder("~/code")).toBe("~/code");
  });
});

// MARK: - The dialog

type Element = { type: unknown; props: Record<string, unknown> };
const byClass = (tree: unknown, className: string) => elements(tree).filter((e) => e.props["className"] === className) as Element[];
const text = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && node !== null && "props" in node) return text((node as Element).props["children"]);
  return "";
};
const key = (name: string, extra: Record<string, unknown> = {}) => ({
  key: name,
  shiftKey: false,
  target: { tagName: "INPUT" },
  nativeEvent: { isComposing: false },
  preventDefault: () => undefined,
  ...extra,
});

function browser(): void {
  vi.stubGlobal("window", { herdrDesktop: { startCommands: () => Promise.resolve(cl) } });
}

afterEach(() => {
  startCommandsStore.clear();
  handoffStore.reset();
  vi.unstubAllGlobals();
});

function dialog(overrides: Record<string, unknown> = {}) {
  browser();
  const starts: { place: NewAgentPlace; folder: string | null; kind: string }[] = [];
  const started: NewAgentResult[] = [];
  let closed = 0;
  let answer: Promise<NewAgentResult> = Promise.resolve({ paneId: "w1:pn1", tabId: "w1:tn1", name: "claude-2", kind: "claude", start: { type: "typed", command: "cl" }, summary: null });
  const storage = new MemoryStorage();
  const props = {
    places: newAgentPlaces([mini]),
    wanted: { hostId: "mini", workspaceId: "w1" },
    storage,
    start: (place: NewAgentPlace, folder: string | null, kind: string) => {
      starts.push({ place, folder, kind });
      return answer;
    },
    onStarted: (_place: NewAgentPlace, result: NewAgentResult) => started.push(result),
    onClose: () => (closed += 1),
    ...overrides,
  };
  const view = new HookHost(NewAgentDialog as (props: object) => unknown, props);
  view.render();
  const root = () => elements(view.tree).find((e) => e.props["role"] === "dialog") as Element;
  return {
    view,
    starts,
    started,
    storage,
    closed: () => closed,
    fail: (error: Error) => (answer = Promise.reject(error)),
    press: (name: string, extra?: Record<string, unknown>) => (root().props["onKeyDown"] as (event: unknown) => void)(key(name, extra)),
    title: () => root().props["aria-label"],
    kinds: () => byClass(view.tree, "na-kind").concat(byClass(view.tree, "na-kind on")),
    chosen: () => byClass(view.tree, "na-kind on").map((e) => e.props["data-kind"]),
    note: () => text(elements(view.tree).find((e) => e.props["role"] === "status")),
    // The field after Change…, else the "Starts in …" line's folder.
    folder: () => {
      const field = elements(view.tree).find((e) => e.props["aria-label"] === "Folder");
      return field !== undefined ? field.props["value"] : elements(view.tree).find((e) => e.props["className"] === "na-in")?.props["data-folder"];
    },
    change: () => (elements(view.tree).find((e) => e.props["aria-label"] === "Change the folder")!.props["onClick"] as () => void)(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the New agent dialog", () => {
  it("opens for the wanted workspace with its folder; its kinds come from the Mac's agents.json", async () => {
    const d = dialog({ wanted: { hostId: "mini", workspaceId: "w2" } });
    expect(d.title()).toBe("New agent in ops");
    expect(d.folder()).toBe("/Users/r/ops");
    await settle();
    d.view.render();
    expect(d.kinds().map((e) => text(e.props["children"]))).toContain("Claude CodeRuns cl");
    expect(d.chosen()).toEqual(["claude"]);
    expect(d.note()).toBe("Runs cl in /Users/r/ops");
  });

  it("Return starts the chosen kind at the folder; the pane opens and the kind is remembered", async () => {
    const d = dialog();
    d.press("ArrowDown");
    expect(d.chosen()).toEqual(["codex"]);
    d.press("Enter");
    expect(d.starts).toEqual([{ place: expect.objectContaining({ workspaceId: "w1" }), folder: "/Users/r/code/app", kind: "codex" }]);
    expect(d.note()).toBe("Starting Codex…");
    d.press("Enter");
    expect(d.starts).toHaveLength(1);
    await settle();
    expect(d.started).toHaveLength(1);
    expect(d.storage.values.get(lastKindKey)).toBe("codex");
  });

  it("a shell, picked with the arrows, starts with no folder when the field is empty", () => {
    const d = dialog();
    // Past every kind Herdr starts (the arrows stop at the last, the shell).
    for (let i = 0; i < 40; i += 1) d.press("ArrowDown");
    expect(d.chosen()).toEqual(["shell"]);
    d.change();
    (elements(d.view.tree).find((e) => e.props["aria-label"] === "Folder")!.props["onChange"] as (event: unknown) => void)({ target: { value: "  " } });
    d.press("Enter");
    expect(d.starts[0]).toMatchObject({ folder: null, kind: "shell" });
  });

  it("Escape cancels: nothing starts, and a start under way opens nothing", async () => {
    const d = dialog();
    d.press("Escape");
    expect(d.closed()).toBe(1);
    expect(d.starts).toEqual([]);
    const late = dialog();
    late.press("Enter");
    late.press("Escape");
    await settle();
    expect(late.started).toEqual([]);
  });

  it("a refused start says so and stays open to try again", async () => {
    const d = dialog();
    d.fail(new Error("Error invoking remote method 'herdr:new-agent': Error: agent_start_failed: codex is not installed"));
    d.press("Enter");
    await settle();
    expect(d.note()).toBe("Not started: agent_start_failed: codex is not installed");
    expect(d.started).toEqual([]);
    expect(d.closed()).toBe(0);
  });
});

// MARK: - The sidebar and ⌘N

function sidebar(hosts: HostView[]) {
  const calls: unknown[] = [];
  const props = {
    sidebar: buildDesktopSidebar(hosts, { fold: emptyFoldState, search: "", nowUnixMs: 0, seenDone: {} }),
    selectedKey: null,
    search: null,
    demo: false,
    foldedHosts: new Set<string>(),
    onSelect: () => undefined,
    onRowMenu: () => undefined,
    onToggleHost: () => undefined,
    onMode: () => undefined,
    onToggleWorkspace: () => undefined,
    onToggleExpanded: () => undefined,
    onToggleSection: () => undefined,
    onSearch: () => undefined,
    onAddHost: () => undefined,
    onNewAgent: (place: unknown) => calls.push(["new", place]),
    onWorkspaceMenu: (...args: unknown[]) => calls.push(["menu", ...args]),
  };
  const view = new HookHost(Sidebar as (props: object) => unknown, props);
  view.render();
  return { tree: view.tree, calls };
}

describe("the sidebar's New agent", () => {
  it("a New agent row on top opens it for the selected workspace", () => {
    const { tree, calls } = sidebar([mini]);
    const row = byClass(tree, "sb-new")[0]!;
    expect(text(row.props["children"])).toBe("New agent⌘N");
    (row.props["onClick"] as () => void)();
    expect(calls).toEqual([["new", null]]);
  });

  it("each workspace header has a + beside its count, \"New agent in <workspace>\", for that workspace", () => {
    const { tree, calls } = sidebar([mini]);
    const plus = byClass(tree, "ws-add");
    expect(plus.map((e) => e.props["aria-label"])).toEqual(["New agent in app", "New agent in ops"]);
    (plus[1]!.props["onClick"] as () => void)();
    expect(calls).toEqual([["new", { hostId: "mini", workspaceId: "w2" }]]);
  });

  it("right-clicking a header opens its menu (New agent here) at the click", () => {
    const { tree, calls } = sidebar([mini]);
    const header = byClass(tree, "ws-hw")[0]!;
    (header.props["onContextMenu"] as (event: unknown) => void)({ preventDefault: () => undefined, clientX: 40, clientY: 90 });
    expect(calls).toEqual([["menu", "mini", "w1", 40, 90]]);
  });

  it("a machine not answering keeps its + in view, not usable", () => {
    const { tree } = sidebar([{ ...mini, state: "offline" }]);
    const plus = byClass(tree, "ws-add off");
    expect(plus).toHaveLength(2);
    expect(plus[0]!.props["disabled"]).toBe(true);
  });

  it("⌘N (Ctrl+N off the Mac) is New agent; ⇧⌘N (New workspace) and ⌥⌘N are not", () => {
    const press = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>) => ({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    });
    expect(appShortcut(press("n", { metaKey: true }), true)).toBe("newAgent");
    expect(appShortcut(press("n", { ctrlKey: true }), false)).toBe("newAgent");
    expect(appShortcut(press("n", { ctrlKey: true }), true)).toBeNull();
    expect(appShortcut(press("N", { metaKey: true, shiftKey: true }), true)).toBe("newWorkspace");
    expect(appShortcut(press("n", { metaKey: true, altKey: true }), true)).toBeNull();
    // ⌘J is the terminal drawer; the next pane that needs you is ⇧⌘J.
    expect(appShortcut(press("j", { metaKey: true }), true)).toBe("toggleTerminal");
    expect(appShortcut(press("J", { metaKey: true, shiftKey: true }), true)).toBe("nextNeedsYou");
    expect(appShortcut(press("f", { metaKey: true }), true)).toBe("search");
  });
});

// MARK: - Only a plain command is typed

describe("New agent types only a plain command", () => {
  const configured = (command: string) => parseStartCommands(encode(JSON.stringify({ claude: command })));
  const shellSyntax = ["cl 'work'", 'cl "work"', "cl; echo fixture", "cl && echo fixture", "cl $(echo fixture)", "cl `echo fixture`", "cl | tee x", "cl > out", "cl\techo"];

  it.each(shellSyntax)("%j is never typed: Herdr starts Claude and the line says why", async (command) => {
    const herdr = new FakeHerdr();
    const result = await newAgent(herdr, configured(command), { workspaceId: "w1", folder: null, kind: "claude" }, fakeClock());
    expect(herdr.calls.filter((call) => call.startsWith("pane.send_input"))).toEqual([]);
    expect(herdr.calls).toContain("agent.start claude-2 claude w1:pn1");
    expect(result.start).toEqual({ type: "herdr" });
    expect(result.summary).toMatch(/^Herdr started Claude Code: the claude command in ~\/\.adari\/agents\.json (has|is) .+; it was not typed\.$/);
  });

  it("a plain command with options and paths is still typed", async () => {
    for (const command of ["cl", "cl --model opus", "~/bin/cl --profile=dev", "/usr/local/bin/cl -p a,b"]) {
      const herdr = new FakeHerdr();
      const result = await newAgent(herdr, configured(command), { workspaceId: "w1", folder: null, kind: "claude" }, fakeClock());
      expect(herdr.calls).toContain(`pane.send_input w1:pn1 ${JSON.stringify(command)} Enter`);
      expect(result.start).toEqual({ type: "typed", command });
    }
  });

  it("the dialog says Herdr starts a kind whose command is not plain, and why", () => {
    const [claude] = newAgentKinds(configured("cl; echo fixture"));
    expect(claude).toMatchObject({ title: "Claude Code", detail: "Herdr starts claude (its agents.json command is not plain)" });
  });
});
