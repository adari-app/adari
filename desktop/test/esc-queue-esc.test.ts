// Presses that send nothing. Herdr's
// status trails Claude's screen at a turn's edges, so Esc in Chat goes while
// Herdr's status or Claude's live screen shows working, and within 2 s after
// either stopped; never at a settled idle (two Escs there open Claude Code's
// rewind menu). A press while Herdr says idle and the last 2 s showed no work
// reads Claude's screen once (main) and sends one Esc only when its working
// line is on screen. The real Composer runs on the small hooks host.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type AgentInfo, type SessionTopology, type TopologyPaneInfo } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import { IPC } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { escGoes, escGraceMs, readClaudeScreenFacts } from "../src/shared/claude-screen";
import { WorkEdges } from "../src/renderer/chat/esc-back";
import { HookHost, elements } from "./support/fake-hooks";
import { claudeScreen } from "./support/claude-screens";
import { checkHerdrKeys } from "./support/herdr-keys";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { agentStops } = await import("../src/renderer/components/agent-stop");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");

// MARK: - the rule

describe("when Esc goes", () => {
  it("goes while Herdr or the screen shows working, and within 2 s after; never at a settled idle", () => {
    const now = 1_000_000;
    expect(escGoes({ herdrWorking: false, screenWorking: true, lastWorkingMs: null, nowMs: now })).toBe(true);
    expect(escGoes({ herdrWorking: true, screenWorking: false, lastWorkingMs: null, nowMs: now })).toBe(true);
    expect(escGoes({ herdrWorking: false, screenWorking: false, lastWorkingMs: now - escGraceMs + 1, nowMs: now })).toBe(true);
    expect(escGoes({ herdrWorking: false, screenWorking: false, lastWorkingMs: now - escGraceMs, nowMs: now })).toBe(false);
    expect(escGoes({ herdrWorking: false, screenWorking: false, lastWorkingMs: null, nowMs: now })).toBe(false);
  });

  it("reads the working line off Claude's screen", () => {
    expect(readClaudeScreenFacts(claudeScreen({ working: true })).working).toBe(true);
    expect(readClaudeScreenFacts(claudeScreen()).working).toBe(false);
    expect(readClaudeScreenFacts(claudeScreen({ working: true, queued: ["one"] })).queued).toBe(true);
  });

  it("keeps the edge where working stopped", () => {
    const edges = new WorkEdges();
    edges.observe("k", false, 10);
    expect(edges.endedAt("k")).toBeNull();
    edges.observe("k", true, 20);
    expect(edges.endedAt("k")).toBeNull();
    edges.observe("k", false, 30);
    edges.observe("k", false, 40);
    expect(edges.endedAt("k")).toBe(30);
  });
});

// MARK: - main: the press outside Herdr's working

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

function paneInfo(status: string): TopologyPaneInfo {
  return { paneID: "w1:p1", terminalID: "t-7", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: status, revision: 1 };
}

function agentInfo(status: string): AgentInfo {
  return { paneID: "w1:p1", agent: "claude", agentStatus: status, terminalID: "t-7", stateChangeSeq: 12, agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" } };
}

function machine(screen: string) {
  const log: unknown[][] = [];
  const backend = {
    agentKeys: async (paneID: string, keys: readonly string[]) => {
      checkHerdrKeys(keys);
      log.push(["agentKeys", paneID, [...keys]]);
    },
    promptIO: () => ({
      paneRead: async () => {
        log.push(["read"]);
        return screen;
      },
      paneSendKeys: async () => undefined,
    }),
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => paneInfo("idle"),
    agent: () => agentInfo("idle"),
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
    refresh: async () => undefined,
  };
  registerIpc({ hosts } as never);
  const handler = registered.handles.get(IPC.paneStopIfWorking)!;
  return { log, press: () => handler(event, "mac-mini", "w1:p1", binding) as Promise<{ sent: boolean; note: string | null }> };
}

const binding = {
  terminalID: "t-7",
  kind: "claude",
  session: "s-1",
  episode: { status: "idle", seq: "12", since: null },
  incarnation: 1,
  connection: 3,
  epoch: 7,
  name: "Claude Code",
};

describe("main's read at the press", () => {
  it("the status lag: Herdr still reads idle while Claude's screen shows working: one press sends one Esc", async () => {
    const m = machine(claudeScreen({ working: true }));
    expect(await m.press()).toEqual({ sent: true, note: null });
    expect(m.log).toEqual([["read"], ["agentKeys", "w1:p1", ["Escape"]]]);
  });

  it("at a settled idle with an empty box, Esc sends nothing", async () => {
    const m = machine(claudeScreen());
    expect(await m.press()).toEqual({ sent: false, note: null });
    expect(m.log).toEqual([["read"]]);
  });
});

// MARK: - the page: the Composer's press

type Listener = { type: string; fn: (event: unknown) => void; capture: boolean };
let listeners: Listener[] = [];
let stopCalls: string[] = [];
const body = { classList: { add: () => undefined } };

beforeEach(() => {
  listeners = [];
  stopCalls = [];
  composerDrafts.clear();
  agentStops.clear();
  escapeOwners.reset();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: () => Promise.resolve(),
      stopAgent: () => {
        stopCalls.push("stopAgent");
        return Promise.resolve(null);
      },
      stopIfWorking: () => {
        stopCalls.push("stopIfWorking");
        return Promise.resolve({ sent: true, note: null });
      },
      openChat: () => undefined,
      closeChat: () => undefined,
      copyText: () => undefined,
      onChatUpdate: () => () => undefined,
    },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, fn: (event: unknown) => void, options?: boolean | { capture?: boolean }) =>
      listeners.push({ type, fn, capture: options === true || (typeof options === "object" && options.capture === true) }),
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners = listeners.filter((l) => l.type !== type || l.fn !== fn);
    },
    getSelection: () => null,
  });
  vi.stubGlobal("document", { body, activeElement: body, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function pressEsc(handler?: (event: unknown) => void) {
  const key = { key: "Escape", metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false, nativeEvent: { isComposing: false }, preventDefault() { this.defaultPrevented = true; }, stopPropagation: () => undefined };
  for (const l of listeners.filter((x) => x.type === "keydown" && x.capture)) l.fn(key);
  handler?.(key);
  for (const l of listeners.filter((x) => x.type === "keydown" && !x.capture)) l.fn(key);
  return key;
}

function topologyOf(status: string): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-0", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: status, revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: status, terminal_id: "t-0", state_change_seq: 12, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-0" } }],
  });
}

const hostOf = (status: string): HostView => ({ id: "mac-mini", name: "Mac mini", state: "connected", topology: topologyOf(status), connection: 3, incarnation: 1, epoch: 7 }) as HostView;
const rowOf = (status: string, kind = "claude") => ({ paneID: "w1:p1", name: "claude 1", workspaceLabel: "ops", isAgent: true, kind, status, glyph: status === "working" ? "working" : "idle" }) as SidebarRow;

describe("the Composer's press", () => {
  it("Herdr reads idle: one press asks Claude's screen (one Esc if it shows working), never a plain stop", () => {
    const ui = new HookHost(Composer as (p: object) => unknown, { host: hostOf("idle"), row: rowOf("idle"), floating: true, stops: true });
    ui.render();
    const pressed = pressEsc();
    expect(stopCalls).toEqual(["stopIfWorking"]);
    expect(pressed.defaultPrevented).toBe(true);
    ui.unmount();
  });

  it("goes as a plain Esc within 2 s after Herdr stopped showing working, and asks the screen after that", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const props = { floating: true, stops: true };
    const ui = new HookHost(Composer as (p: object) => unknown, { ...props, host: hostOf("working"), row: rowOf("working") });
    ui.render();
    ui.render({ ...props, host: hostOf("idle"), row: rowOf("idle") });
    vi.setSystemTime(1_000_000 + escGraceMs - 500);
    pressEsc();
    expect(stopCalls).toEqual(["stopAgent"]);
    vi.setSystemTime(1_000_000 + escGraceMs + 10);
    ui.render({ ...props, host: hostOf("idle"), row: rowOf("idle") });
    pressEsc();
    expect(stopCalls).toEqual(["stopAgent", "stopIfWorking"]);
    ui.unmount();
  });

  it("another agent at idle: Esc sends nothing, as before", () => {
    const ui = new HookHost(Composer as (p: object) => unknown, { host: hostOf("idle"), row: rowOf("idle", "codex"), floating: true, stops: true });
    ui.render();
    pressEsc();
    expect(stopCalls).toEqual([]);
    ui.unmount();
  });

  it("keeps the user's draft when Esc stops with text in our box", () => {
    const ui = new HookHost(Composer as (p: object) => unknown, { host: hostOf("working"), row: rowOf("working"), floating: true, stops: true });
    ui.render();
    const textarea = () => elements(ui.tree).find((e) => e.type === "textarea")!;
    (textarea().props["onChange"] as (e: unknown) => void)({ target: { value: "half a thought" } });
    pressEsc(textarea().props["onKeyDown"] as (e: unknown) => void);
    expect(stopCalls).toEqual(["stopAgent"]);
    expect(composerDrafts.get(draftKey("mac-mini", "w1:p1")).text).toBe("half a thought");
    ui.unmount();
  });
});
