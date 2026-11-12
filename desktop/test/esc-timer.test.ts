// After an Esc stops Claude, the Working timer goes at once. Herdr reports
// the end of the turn a second or two after Claude Code stopped, so a Working
// row, Stop square and "Esc to stop" that followed Herdr's status only would
// keep "Working for Ns" counting for 1-2 s after the text came back to the box.
//
// - At the press of an Esc that went, the Working row reads "Stopping…" (no
//   counter, no "Esc to stop") until a read shows Claude's working line gone,
//   Herdr says not working, or 5 s pass.
// - The reads after an Esc (main) report each read's working line; the read
//   that shows it gone ends the turn on the page at once (the row, the square,
//   the hint), whether or not a message came back. They keep reading, within
//   the 5, until it is gone.
// - Herdr working with a newer status than the press (a new turn) is followed
//   at once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { afterStop, afterStopOnce, PaneTurns, SentTexts, type ClaudeBoxSite } from "../src/main/herdr/claude-box";
import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import { IPC } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
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
const { ChatView } = await import("../src/renderer/chat/ChatView");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const stopStores = (await import("../src/renderer/components/agent-stop")) as typeof import("../src/renderer/components/agent-stop") & {
  escTurns?: { clear(): void };
};
const { agentStops, armedStops } = stopStores;
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");

/** The channel main tells the page on (the read that showed Claude's working line gone). */
const escScreenChannel = "herdr:pane-esc-screen";

// MARK: - main: the reads after an Esc report Claude's working line

/** A pane whose screens come one per read (the last repeats); reads, keys and the working line reported are logged. */
function boxSite(screens: readonly string[]): ClaudeBoxSite & { log: unknown[][]; seen: (working: boolean) => void } {
  let read = 0;
  const log: unknown[][] = [];
  return {
    log,
    seen: (working) => void log.push(["working", working]),
    read: async () => {
      log.push(["read"]);
      const screen = screens[Math.min(read, screens.length - 1)]!;
      read += 1;
      return screen;
    },
    keys: async (keys) => {
      checkHerdrKeys(keys);
      log.push(["keys", [...keys]]);
    },
    wait: async () => undefined,
  };
}

const reads = (log: readonly unknown[][]): number => log.filter((entry) => entry[0] === "read").length;

describe("main: the reads after an Esc report Claude's working line", () => {
  it("send, then Esc: the message back in Claude's box with no working line is reported at that read, before the clear", async () => {
    const site = boxSite([claudeScreen({ draft: "test" }), claudeScreen()]);
    expect(await afterStop(site, "test", site.seen)).toEqual({ cancelled: "test", cleared: true });
    expect(site.log).toEqual([["read"], ["working", false], ["keys", ["ctrl+u", "Backspace"]], ["read"]]);
  });

  it("Esc mid-turn (the reply cut): reads on while the line shows, and reports it gone at the read that shows it", async () => {
    const site = boxSite([claudeScreen({ working: true }), claudeScreen({ working: true }), claudeScreen()]);
    expect(await afterStop(site, "an earlier message", site.seen)).toEqual({ cancelled: null, cleared: false });
    expect(site.log.slice(0, 6)).toEqual([["read"], ["working", true], ["read"], ["working", true], ["read"], ["working", false]]);
    // The box stays empty: the reads still look for the message put back, within the 5.
    expect(reads(site.log)).toBe(5);
  });

  it("the line gone and our message back: no more reads", async () => {
    const site = boxSite([claudeScreen({ working: true }), claudeScreen({ draft: "test" }), claudeScreen()]);
    expect(await afterStop(site, "test", site.seen)).toEqual({ cancelled: "test", cleared: true });
    expect(site.log).toEqual([["read"], ["working", true], ["read"], ["working", false], ["keys", ["ctrl+u", "Backspace"]], ["read"]]);
  });

  it("keeps reading for the working line even when no message came back (none sent, or other text in the box)", async () => {
    const none = boxSite([claudeScreen({ working: true }), claudeScreen()]);
    expect(await afterStop(none, null, none.seen)).toEqual({ cancelled: null, cleared: false });
    expect(none.log).toEqual([["read"], ["working", true], ["read"], ["working", false]]);
    const other = boxSite([claudeScreen({ working: true, draft: "typed in the terminal" }), claudeScreen({ draft: "typed in the terminal" })]);
    expect(await afterStop(other, "test", other.seen)).toEqual({ cancelled: null, cleared: false });
    expect(other.log).toEqual([["read"], ["working", true], ["read"], ["working", false]]);
  });

  it("5 reads that all still show working: 5 reads, never reported gone (left to Herdr)", async () => {
    const site = boxSite([claudeScreen({ working: true })]);
    expect(await afterStop(site, "test", site.seen)).toEqual({ cancelled: null, cleared: false });
    expect(reads(site.log)).toBe(5);
    expect(site.log.filter((entry) => entry[0] === "working")).toEqual(Array(5).fill(["working", true]));
  });

  it("a read with no box (a dialog) says nothing about the working line", async () => {
    const site = boxSite(["Do you want to proceed?\n 1. Yes\n 2. No", claudeScreen()]);
    await afterStop(site, null, site.seen);
    expect(site.log).toEqual([["read"], ["read"], ["working", false]]);
  });

  it("one at a time per pane, each run reporting its own reads", async () => {
    const writer = {};
    const sent = new SentTexts();
    sent.record(writer, "w1:p1", "test");
    const site = boxSite([claudeScreen({ draft: "test" }), claudeScreen()]);
    const found = await afterStopOnce(writer, "w1:p1", site, sent, new PaneTurns(), site.seen);
    expect(found).toEqual({ cancelled: "test", cleared: true });
    expect(site.log[1]).toEqual(["working", false]);
  });
});

// MARK: - main: the IPC tells the page at the read

const binding = {
  terminalID: "t-7",
  kind: "claude",
  session: "s-1",
  episode: { status: "working", seq: "12", since: null },
  incarnation: 1,
  connection: 3,
  epoch: 7,
  name: "Claude Code",
};

function machine(screens: readonly string[]) {
  const log: unknown[][] = [];
  let read = 0;
  const backend = {
    agentKeys: async (paneID: string, keys: readonly string[]) => {
      checkHerdrKeys(keys);
      log.push(["agentKeys", paneID, [...keys]]);
    },
    promptIO: () => ({
      paneRead: async () => {
        log.push(["read"]);
        const screen = screens[Math.min(read, screens.length - 1)]!;
        read += 1;
        return screen;
      },
      paneSendKeys: async () => undefined,
    }),
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => ({ paneID: "w1:p1", terminalID: "t-7", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "working", revision: 1 }),
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
    refresh: async () => undefined,
  };
  registerIpc({ hosts } as never);
  const handler = registered.handles.get(IPC.paneAfterStop)!;
  const event = {
    senderFrame: { url: APP_ORIGIN },
    sender: {
      id: 1,
      send: (channel: string, value: unknown) => void log.push(["tell", channel, value]),
    },
  };
  return { log, afterStop: () => handler(event, "mac-mini", "w1:p1", binding) as Promise<{ cancelled: string | null; cleared: boolean; working?: boolean | null }> };
}

describe("main: the page is told at the read", () => {
  it("tells the page the moment a read shows the working line gone, and answers with it", async () => {
    vi.useRealTimers();
    const m = machine([claudeScreen({ working: true }), claudeScreen()]);
    const found = await m.afterStop();
    expect(found).toEqual({ cancelled: null, cleared: false, working: false });
    expect(m.log).toEqual([["read"], ["read"], ["tell", escScreenChannel, { hostId: "mac-mini", paneId: "w1:p1", working: false }]]);
  });

  it("all 5 reads still working: nothing told, the answer says working", async () => {
    vi.useRealTimers();
    const m = machine([claudeScreen({ working: true })]);
    const found = await m.afterStop();
    expect(found).toEqual({ cancelled: null, cleared: false, working: true });
    expect(m.log.filter((entry) => entry[0] === "tell")).toEqual([]);
  });
});

// MARK: - the page: the Working row, the square and "Esc to stop"

type Listener = { type: string; fn: (event: unknown) => void; capture: boolean };
let listeners: Listener[] = [];
let stopCalls: string[] = [];
let escScreen: ((event: { hostId: string; paneId: string; working: boolean }) => void) | null = null;
let answer: { resolve: (found: { cancelled: string | null; cleared: boolean; working?: boolean | null }) => void } | null = null;
const body = { classList: { add: () => undefined } };
/** Pages still shown: unmounted after each test, even a failed one, before the globals go. */
let shownPages: { unmount(): void }[] = [];

function topologyOf(status: string, seq: number): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-0", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: status, revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: status, terminal_id: "t-0", state_change_seq: seq, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-0" } }],
  });
}

const hostOf = (status: string, seq = 12): HostView => ({ id: "mac-mini", name: "Mac mini", state: "connected", topology: topologyOf(status, seq), connection: 3, incarnation: 1, epoch: 7 }) as HostView;
const rowOf = (status: string) =>
  ({ paneID: "w1:p1", name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status, glyph: status === "working" ? "working" : "idle", statusSinceUnixMs: 1_000_000 - 4_000 }) as SidebarRow;
const key = "mac-mini/w1:p1";

beforeEach(() => {
  listeners = [];
  stopCalls = [];
  escScreen = null;
  answer = null;
  composerDrafts.clear();
  agentStops.clear();
  armedStops.clear();
  stopStores.escTurns?.clear();
  pendingMessages.clear();
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
      afterStop: () => {
        stopCalls.push("afterStop");
        return new Promise((resolve) => {
          answer = { resolve };
        });
      },
      onEscScreen: (listener: typeof escScreen) => {
        escScreen = listener;
        return () => {
          if (escScreen === listener) escScreen = null;
        };
      },
      paneQueued: () => Promise.resolve(null),
      openChat: () => undefined,
      closeChat: () => undefined,
      setChatFollowing: () => undefined,
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
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  });
  vi.stubGlobal("document", { body, activeElement: body, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  for (const shown of shownPages) shown.unmount();
  shownPages = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function pressEsc() {
  const event = { key: "Escape", metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false, nativeEvent: { isComposing: false }, preventDefault() { this.defaultPrevented = true; }, stopPropagation: () => undefined };
  for (const l of listeners.filter((x) => x.type === "keydown")) l.fn(event);
  return event;
}

/** Chat as the user sees it: the conversation (its Working row) and the box (its square), for one Herdr report. */
function page(status = "working", seq = 12) {
  const props = (s: string, q: number) => ({ host: hostOf(s, q), row: rowOf(s) });
  const chat = new HookHost(ChatView as (p: object) => unknown, { ...props(status, seq), onShowTerminal: () => undefined });
  const box = new HookHost(Composer as (p: object) => unknown, { ...props(status, seq), floating: true, stops: true });
  chat.render();
  box.render();
  let mounted = true;
  const shown = {
    unmount() {
      if (!mounted) return;
      mounted = false;
      chat.unmount();
      box.unmount();
    },
  };
  shownPages.push(shown);
  return {
    chat,
    box,
    /** Herdr reports `s` (its state_change_seq `q`). */
    herdr(s: string, q = seq) {
      box.render({ ...props(s, q), floating: true, stops: true });
      chat.render({ ...props(s, q), onShowTerminal: () => undefined });
    },
    rerender() {
      box.render();
      chat.render();
    },
    /** The Working row's words, or null when it is not shown. */
    workingRow(): string | null {
      const row = elements(chat.tree).find((e) => e.props["className"] === "working");
      if (row === undefined) return null;
      return elements(row)
        .filter((e) => typeof e.props["className"] === "string" && (e.props["className"] as string).startsWith("working-"))
        .map((e) => String(e.props["children"]))
        .join(" | ");
    },
    square(): "Stop" | "Send" | null {
      const labels = elements(box.tree).map((e) => e.props["aria-label"]);
      return labels.includes("Stop") ? "Stop" : labels.includes("Send") ? "Send" : null;
    },
    unmount: () => shown.unmount(),
  };
}

describe("page: after an Esc stops Claude, the Working timer goes at once", () => {
  it("send, then Esc, then Claude's box shows the message back with no working line (Herdr still working): the text is in our box, the row goes at that read, no timer after", async () => {
    pendingMessages.add(key, "test", Date.now() - 300);
    const p = page();
    expect(p.workingRow()).toBe("Working for 4s | Esc to stop");
    expect(p.square()).toBe("Stop");
    pressEsc();
    await flush();
    expect(stopCalls).toEqual(["stopAgent", "afterStop"]);
    // The read that shows the message back with no working line: main tells the page at once.
    escScreen?.({ hostId: "mac-mini", paneId: "w1:p1", working: false });
    p.rerender();
    expect(p.workingRow()).toBeNull();
    expect(p.square()).toBe("Send");
    answer!.resolve({ cancelled: "test", cleared: true, working: false });
    await flush();
    p.rerender();
    expect(composerDrafts.get(draftKey("mac-mini", "w1:p1")).text).toBe("test");
    // Herdr still says working for 2 s more: no row, no timer.
    vi.advanceTimersByTime(2_000);
    p.herdr("working");
    expect(p.workingRow()).toBeNull();
    expect(p.square()).toBe("Send");
    p.herdr("idle", 13);
    expect(p.workingRow()).toBeNull();
    p.unmount();
  });

  it("Esc mid-turn (the reply cut): \"Stopping…\" right after the press; the read with no working line ends the row while Herdr still says working", async () => {
    const p = page();
    pressEsc();
    p.rerender();
    expect(p.workingRow()).toBe("Stopping…");
    expect(p.square()).toBe("Stop");
    vi.advanceTimersByTime(600);
    p.rerender();
    expect(p.workingRow()).toBe("Stopping…");
    await flush();
    escScreen?.({ hostId: "mac-mini", paneId: "w1:p1", working: false });
    p.rerender();
    expect(p.workingRow()).toBeNull();
    expect(p.square()).toBe("Send");
    answer?.resolve({ cancelled: null, cleared: false, working: false });
    await flush();
    vi.advanceTimersByTime(1_000);
    p.herdr("working");
    expect(p.workingRow()).toBeNull();
    p.unmount();
  });

  it("the answer alone (no word at the read) also ends the row", async () => {
    const p = page();
    pressEsc();
    await flush();
    answer!.resolve({ cancelled: null, cleared: false, working: false });
    await flush();
    p.rerender();
    expect(p.workingRow()).toBeNull();
    p.unmount();
  });

  it("5 reads that all still show working: \"Stopping…\" until 5 s, then as today", async () => {
    const p = page();
    pressEsc();
    await flush();
    answer!.resolve({ cancelled: null, cleared: false, working: true });
    await flush();
    vi.advanceTimersByTime(4_000);
    p.rerender();
    expect(p.workingRow()).toBe("Stopping…");
    expect(p.square()).toBe("Stop");
    vi.advanceTimersByTime(1_000);
    p.rerender();
    expect(p.workingRow()).toBe("Working for 9s | Esc to stop");
    p.unmount();
  });

  it("5 reads that all still show working: \"Stopping…\" until Herdr says not working", async () => {
    const p = page();
    pressEsc();
    await flush();
    answer!.resolve({ cancelled: null, cleared: false, working: true });
    await flush();
    vi.advanceTimersByTime(2_000);
    p.herdr("working");
    expect(p.workingRow()).toBe("Stopping…");
    p.herdr("idle", 13);
    expect(p.workingRow()).toBeNull();
    expect(p.square()).toBe("Send");
    p.unmount();
  });

  it("a new turn (Herdr working with a newer status) after a local end: the Working row shows for it", async () => {
    const p = page();
    pressEsc();
    await flush();
    escScreen?.({ hostId: "mac-mini", paneId: "w1:p1", working: false });
    p.rerender();
    expect(p.workingRow()).toBeNull();
    p.herdr("working", 14);
    expect(p.workingRow()).toMatch(/^Working for \d+s \| Esc to stop$/);
    expect(p.square()).toBe("Stop");
    p.unmount();
  });

  it("a new turn after Herdr went idle, with the same status number reported: shown", async () => {
    const p = page();
    pressEsc();
    await flush();
    escScreen?.({ hostId: "mac-mini", paneId: "w1:p1", working: false });
    p.herdr("idle");
    p.herdr("working");
    expect(p.workingRow()).toMatch(/^Working for/);
    p.unmount();
  });

  it("an Esc that did not go (a note) shows no \"Stopping…\"", async () => {
    (window.herdrDesktop as unknown as { stopAgent: () => Promise<string | null> }).stopAgent = () => Promise.resolve("Not stopped: the agent changed");
    const p = page();
    pressEsc();
    await flush();
    p.rerender();
    expect(p.workingRow()).toBe("Working for 4s | Esc to stop");
    p.unmount();
  });

  it("another pane's read changes nothing here", async () => {
    const p = page();
    pressEsc();
    await flush();
    escScreen?.({ hostId: "mac-mini", paneId: "w1:p9", working: false });
    p.rerender();
    expect(p.workingRow()).toBe("Stopping…");
    p.unmount();
  });

  it("unchanged: one Esc per press", async () => {
    const p = page();
    pressEsc();
    await flush();
    pressEsc();
    await flush();
    expect(stopCalls.filter((call) => call === "stopAgent")).toEqual(["stopAgent", "stopAgent"]);
    p.unmount();
  });
});
