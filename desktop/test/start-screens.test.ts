// Codex's "Hooks need review" screen (read from Codex 0.167.0 in a clean home
// folder, word for word)
// while Herdr reports the pane idle. The matcher, conservatively; the main
// process's reads (src/main/start-screens.ts) on a real HostRegistry with a
// fake backend that records every call (only reads, never a key); the page
// showing the pane as needing you (the sidebar's glyph, the Needs you list);
// Chat's line and the card's; a send to the pane refused at main's door. No
// real Herdr, no socket, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { StartScreenService, startScreenWindowMs, startScreenReadMs } from "../src/main/start-screens";
import { applyStartScreens, readStartScreen, showsCodexHookReview, startScreenTexts } from "../src/shared/prompt/start-screen";
import { buildSidebarModel, sidebarInputFromTopology, type SidebarRow } from "../src/shared/sidebar-model";
import { emptyTimeline } from "../src/shared/chat/model";
import type { HostView } from "../src/shared/ipc-contract";
import { HookHost, elements } from "./support/fake-hooks";

const { ChatView } = await import("../src/renderer/chat/ChatView");
const { NeedsCard } = await import("../src/renderer/chat/NeedsCard");
const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

/** The screen, word for word as Codex 0.167.0 draws it. */
const hookReview = [
  "  Hooks need review",
  "  1 hook is new or changed.",
  "  Hooks can run outside the sandbox after you trust them.",
  "",
  "",
  "› 1. Review hooks",
  "  2. Trust all and continue",
  "  3. Continue without trusting (hooks won't run)",
  "",
  "  enter confirm · esc skip",
].join("\n");

/** Codex's own prompt after the choice. */
const codexPrompt = ["╭──────────────────────────────────────────────╮", "│ >_ OpenAI Codex (v0.167.0)                   │", "╰──────────────────────────────────────────────╯", "", "› Ask Codex to do anything", "", "  gpt-5.5 high · ~/fixture"].join("\n");

const line = "Codex is asking whether to trust Herdr's hook. Choose Trust all and continue in its terminal.";

describe("the matcher: Codex's hook review, conservatively", () => {
  it("the exact screen, and with Codex's curly quote, with output above it (never without its footer)", () => {
    expect(showsCodexHookReview(hookReview)).toBe(true);
    expect(showsCodexHookReview(hookReview.replace("won't", "won’t"))).toBe(true);
    // The footer is part of the live menu; without it, it is not the menu.
    expect(showsCodexHookReview(hookReview.replace("  enter confirm · esc skip", ""))).toBe(false);
    expect(showsCodexHookReview(`zsh % codex --no-daemon\n\n${hookReview}\n\n`)).toBe(true);
    expect(readStartScreen(hookReview, "codex")).toBe("codexHookReview");
    expect(readStartScreen(hookReview, "Codex")).toBe("codexHookReview");
  });

  it("near misses: the title alone, the title inside a line, the choices without the title, a trust choice missing", () => {
    expect(showsCodexHookReview("  Hooks need review\n  1 hook is new or changed.\n")).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("  Hooks need review", "  The docs say: Hooks need review"))).toBe(false);
    expect(showsCodexHookReview(hookReview.split("\n").slice(3).join("\n"))).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("  2. Trust all and continue\n", ""))).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("  3. Continue without trusting (hooks won't run)\n", ""))).toBe(false);
  });

  it("near misses: the words inside ordinary output (more output under the choices), or the choices numbered otherwise", () => {
    expect(showsCodexHookReview(`${hookReview}\n› Ask Codex to do anything`)).toBe(false);
    expect(showsCodexHookReview(`$ cat notes.md\n${hookReview.replace("  enter confirm · esc skip", "")}\n$ `)).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("› 1. Review hooks", "› 4. Review hooks"))).toBe(false);
    expect(showsCodexHookReview(codexPrompt)).toBe(false);
  });

  it("only a Codex pane is read so", () => {
    expect(readStartScreen(hookReview, "claude")).toBeNull();
    expect(readStartScreen(hookReview, null)).toBeNull();
    expect(line.includes("\u2014")).toBe(false);
    expect(startScreenTexts.codexHookReview).toBe(line);
  });
});

// MARK: - the main process's reads

function topology(panes: readonly { id: string; status?: string; session?: string | null; kind?: string; terminal?: string }[]): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: panes.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: panes.length, agent_status: "idle" }],
    panes: panes.map((pane) => ({
      pane_id: pane.id,
      terminal_id: pane.terminal ?? `term-${pane.id}`,
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
      cwd: "/fixture",
      agent: pane.kind ?? "codex",
      agent_status: pane.status ?? "idle",
      revision: 1,
    })),
    layouts: [],
    agents: panes.map((pane) => ({
      pane_id: pane.id,
      agent: pane.kind ?? "codex",
      agent_status: pane.status ?? "idle",
      ...(pane.session === undefined || pane.session === null ? {} : { agent_session: { source: `herdr:${pane.kind ?? "codex"}`, agent: pane.kind ?? "codex", kind: "id", value: pane.session } }),
    })),
  });
}

function machine(panes: Parameters<typeof topology>[0]) {
  const calls: string[] = [];
  const screens = new Map<string, string>();
  let shown = topology(panes);
  let epoch = 1;
  /** A read held back until the test lets it go (null: answered at once). */
  let hold: Promise<void> | null = null;
  const refuse = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error(`${name} must never be called`));
  };
  const backend = {
    kind: "herdr-tui" as const,
    snapshot: () => Promise.resolve(shown),
    connectionEpoch: () => epoch,
    async paneText(paneId: string, lines: number): Promise<string> {
      calls.push(`pane.read ${paneId} ${lines}`);
      if (hold !== null) await hold;
      return screens.get(paneId) ?? "";
    },
    // Everything that would write to a pane: never called.
    sendInput: refuse("pane.send_input"),
    agentKeys: refuse("agent keys"),
    sendText: refuse("send text"),
    agentPrompt: refuse("agent.prompt"),
    paneSendKeys: refuse("pane.send_keys"),
    close: () => undefined,
  };
  return {
    descriptor: { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "me@mini", platform: "macOS" },
    backend,
    calls,
    screens,
    setPanes: (next: Parameters<typeof topology>[0]) => {
      shown = topology(next);
    },
    setEpoch: (value: number) => {
      epoch = value;
    },
    holdReads: () => {
      let release!: () => void;
      hold = new Promise<void>((done) => (release = done));
      return () => {
        hold = null;
        release();
      };
    },
    reads: () => calls.filter((call) => call.startsWith("pane.read")).length,
    writes: () => calls.filter((call) => !call.startsWith("pane.read")),
  };
}

async function world(panes: Parameters<typeof topology>[0] = [{ id: "w1:p1" }]) {
  let now = 1_000_000;
  let service: StartScreenService | null = null;
  const registry = new HostRegistry(() => service?.hostsChanged());
  service = new StartScreenService(registry, { now: () => now, every: () => () => undefined });
  const m = machine(panes);
  m.screens.set("w1:p1", hookReview);
  registry.add(m.descriptor, m.backend as never);
  await registry.refresh("mini");
  await flush();
  const host = (): HostView => registry.list().find((entry) => entry.id === "mini")!;
  /** The clock moves on and the timer ticks. */
  const tick = async (ms = startScreenReadMs): Promise<void> => {
    now += ms;
    service!.hostsChanged();
    await flush();
  };
  return { registry, service: service!, m, host, tick };
}

/** The page's sidebar for the machine as App shows it (applyStartScreens). */
function sidebarRow(host: HostView, paneId = "w1:p1") {
  const [shown] = applyStartScreens([host]);
  const model = buildSidebarModel(sidebarInputFromTopology(shown!.topology!, { macID: "mini", nowUnixMs: 1_800_000_000_000 }));
  const row = model.projects.flatMap((section) => section.rows).find((candidate) => candidate.paneID === paneId)!;
  return { row, model };
}

describe("the main process reads it, and the page shows the pane as needing you", () => {
  it("a Codex pane with no session, idle, showing the hook review: marked; the sidebar's glyph and the Needs you list say so; no key ever sent", async () => {
    const { m, host } = await world();
    expect(m.reads()).toBe(1);
    expect(host().startScreens?.panes).toEqual([{ paneId: "w1:p1", kind: "codexHookReview", terminalID: "term-w1:p1" }]);
    const { row, model } = sidebarRow(host());
    expect(row.status).toBe("blocked");
    expect(row.glyph).toBe("needsYou");
    expect(model.priorityBadge).toBe(1);
    expect(model.priority.find((section) => section.kind === "needsYou")?.rows.map((each) => each.paneID)).toEqual(["w1:p1"]);
    expect(m.writes()).toEqual([]);
  });

  it("the state goes when the screen does (Trust all and continue chosen in the terminal); Herdr's idle shows again", async () => {
    const { m, host, tick } = await world();
    expect(host().startScreens).toBeDefined();
    m.screens.set("w1:p1", codexPrompt);
    await tick();
    expect(host().startScreens).toBeUndefined();
    expect(sidebarRow(host()).row.glyph).not.toBe("needsYou");
    expect(m.writes()).toEqual([]);
  });

  it("a near-miss screen marks nothing", async () => {
    const { m, host, tick } = await world();
    m.screens.set("w1:p1", `${hookReview}\n› Ask Codex to do anything`);
    await tick();
    expect(host().startScreens).toBeUndefined();
    m.screens.set("w1:p1", "  Hooks need review\n");
    await tick();
    expect(host().startScreens).toBeUndefined();
  });

  it("a pane with a session Herdr names, a working one, another kind, or a shell is never read", async () => {
    const { m, tick } = await world([
      { id: "w1:s", session: "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84" },
      { id: "w1:w", status: "working" },
      { id: "w1:c", kind: "claude" },
    ]);
    await tick();
    expect(m.reads()).toBe(0);
  });

  it("read every 2.5 s for its first 3 minutes in sight; after that not again while it never showed; a shown one stays read until it goes", async () => {
    const { m, host, tick } = await world();
    m.screens.set("w1:p1", codexPrompt);
    await tick();
    const early = m.reads();
    await tick(1_000);
    expect(m.reads(), "not again within 2.5 s").toBe(early);
    await tick(startScreenWindowMs);
    const after = m.reads();
    await tick();
    await tick();
    expect(m.reads(), "out of its window, never shown: not read").toBe(after);
    expect(host().startScreens).toBeUndefined();
  });

  it("a read that crossed a new command connection is dropped; the snapshot on the new one reads again", async () => {
    const { registry, m, host, tick } = await world();
    m.screens.set("w1:p1", codexPrompt);
    await tick();
    m.screens.set("w1:p1", hookReview);
    const release = m.holdReads();
    await tick();
    m.setEpoch(2);
    release();
    await flush();
    expect(host().startScreens, "the late answer is not used").toBeUndefined();
    await registry.refresh("mini");
    await flush();
    expect(host().startScreens?.epoch).toBe(2);
  });

  it("the pane gets a session (the user's first message after the choice): the mark goes without another read", async () => {
    const { registry, m, host } = await world();
    expect(host().startScreens).toBeDefined();
    m.setPanes([{ id: "w1:p1", session: "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84" }]);
    await registry.refresh("mini");
    await flush();
    expect(host().startScreens).toBeUndefined();
  });

  it("the page applies it only on the connection and terminal it was read on", async () => {
    const { host } = await world();
    const shown = host();
    expect(applyStartScreens([{ ...shown, epoch: 7 }])[0]!.topology).toBe(shown.topology);
    expect(applyStartScreens([{ ...shown, startScreens: { ...shown.startScreens!, panes: [{ ...shown.startScreens!.panes[0]!, terminalID: "another" }] } }])[0]!.topology).toBe(shown.topology);
  });
});

// MARK: - Chat, the card and a send

const rowOf = (status = "blocked") => ({ paneID: "w1:p1", status, name: "fixture", workspaceLabel: "app", isAgent: true, kind: "codex" }) as unknown as SidebarRow;
const texts = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => {
    const children = element.props["children"];
    return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string");
  });
const labels = (tree: unknown) => elements(tree).filter((element) => element.type === "button").map((button) => button.props["children"]);
const named = (tree: unknown, name: string) => elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;
const bridgeCalls: string[] = [];

function browser(): void {
  vi.stubGlobal("window", {
    herdrDesktop: {
      onChatUpdate: (listener: Listener) => {
        chatListener = listener;
        return () => undefined;
      },
      openChat: () => undefined,
      closeChat: () => undefined,
      setChatFollowing: () => undefined,
      copyText: () => undefined,
      sendToPane: () => (bridgeCalls.push("sendToPane"), Promise.resolve()),
      answerPrompt: () => (bridgeCalls.push("answerPrompt"), Promise.resolve({ type: "refused", note: "" })),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection: () => null,
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  });
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
}

const views: HookHost<object>[] = [];
function mount(component: unknown, props: object): HookHost<object> {
  const view = new HookHost(component as (props: object) => unknown, props);
  views.push(view);
  view.render();
  return view;
}

beforeEach(() => {
  registered.handles.clear();
  bridgeCalls.length = 0;
  browser();
});

afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  chatListener = null;
  vi.unstubAllGlobals();
});

describe("Chat and the card say it; nothing answers it", () => {
  it("Chat for the pane with no session: the line and Show the terminal, no needs-you card saying it again, no key", async () => {
    const { host } = await world();
    const [shown] = applyStartScreens([host()]);
    let shownTerminal = 0;
    const view = mount(ChatView, { host: shown, row: rowOf(), onShowTerminal: () => (shownTerminal += 1) });
    chatListener?.({ hostId: "mini", paneId: "w1:p1", state: { status: "unavailable", reason: "noSession" }, timeline: emptyTimeline });
    view.render();
    expect(texts(view.tree)).toContain(line);
    expect(texts(view.tree)).not.toContain("Herdr names no session for this agent yet, so there is no transcript to show.");
    expect(named(view.tree, "ChatUnavailableLine")).toEqual([]); // The line lives in this element
    expect(named(view.tree, "NeedsCard")).toEqual([]);
    const show = elements(view.tree).find((element) => element.type === "button" && element.props["children"] === "Show the terminal")!;
    (show.props["onClick"] as () => void)();
    expect(shownTerminal).toBe(1);
    expect(bridgeCalls).toEqual([]);
  });

  it("the needs-you card (a pane with a transcript): Codex needs you, the line, only Show the terminal", async () => {
    const { host } = await world();
    const [shown] = applyStartScreens([host()]);
    const card = mount(NeedsCard, { host: shown, row: rowOf(), onShowTerminal: () => undefined });
    expect(texts(card.tree)).toContain("Codex needs you");
    expect(texts(card.tree)).toContain(line);
    expect(labels(card.tree)).toEqual(["Show the terminal"]);
    expect(bridgeCalls).toEqual([]);
  });

  it("a send to the pane while it shows is refused at main's door; nothing is written", async () => {
    const writes: string[] = [];
    const backend = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => void writes.push(`${String(name)} ${JSON.stringify(args)}`) });
    registerIpc({
      hosts: { backend: () => backend, list: () => [] },
      startScreens: { shows: (hostId: string, paneId: string) => hostId === "mini" && paneId === "w1:p1" },
    } as never);
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    const binding = { terminalID: "term-w1:p1", isAgent: true, kind: "codex", session: null };
    await expect(registered.handles.get(IPC.paneSend)!(event, "mini", "w1:p1", "hello", binding)).rejects.toThrow(startScreenTexts.notSent);
    expect(writes).toEqual([]);
  });
});
