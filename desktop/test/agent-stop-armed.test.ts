// Esc right after a send stops the turn
// it started. The user sent "h" and pressed Esc at once: Herdr had not reported
// the agent working yet, so Stop was not possible and Esc did nothing. Now an
// Esc pressed while their just-sent message is pending (and the agent not yet
// reported working) arms one stop for the pane: when Herdr reports the same
// agent (terminal, session) working in a new episode within 5 s of the press,
// exactly one Escape goes through the usual stop (main's fresh check, run for
// real here on a fake machine that counts the keys); otherwise none. The real
// Composer runs on the small hooks host with a fake window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import type { StopBinding } from "../src/shared/agent-stop";
import { timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer, justSentFrom } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { agentStops, armedStops, ArmedStops } = await import("../src/renderer/components/agent-stop");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { stopAgent } = await import("../src/main/herdr/stop");

type Listener = { type: string; fn: (event: unknown) => void; capture: boolean };

const key = draftKey("mac-mini", "w1:p1");
/** Every Chat box a test mounted (unmounted after it, whatever happened). */
const mounted: { unmount(): void }[] = [];
let listeners: Listener[] = [];
/** What the fake machine shows now (its snapshots, the fresh one too). */
let machine: SessionTopology;
/** Every key sent to the machine. */
let escapes: { paneID: string; keys: readonly string[] }[] = [];
let stopCalls = 0;
/** The command connection the machine is on now (its epoch). */
let commandEpoch = 7;
let clock = 1_762_000_000_000;
const body = { classList: { add: () => undefined } };
let active: unknown = body;

/** The machine's writer: a new one per test (main's one-Escape hold is per writer). */
let writer = { agentKeys: async (_paneID: string, _keys: readonly string[]): Promise<void> => undefined };

function site(paneID: string) {
  return {
    writer,
    machine: "Mac mini",
    fresh: async () => true,
    pane: () => machine.panes.find((pane) => pane.paneID === paneID) ?? null,
    agent: () => machine.agents.find((agent) => agent.paneID === paneID) ?? null,
    identity: () => ({ incarnation: 1, connection: 3, epoch: commandEpoch }),
    snapshotEpoch: () => commandEpoch,
    now: () => clock,
  };
}

function topologyOf(status: string, options: { seq?: number | null; session?: string; terminal?: string; turnEpoch?: number } = {}): SessionTopology {
  const terminal = options.terminal ?? "t-0";
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: terminal, workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: status, revision: 1 }],
    layouts: [],
    agents: [
      {
        pane_id: "w1:p1",
        agent: "claude",
        agent_status: status,
        terminal_id: terminal,
        ...(options.seq === null ? {} : { state_change_seq: options.seq ?? 12 }),
        ...(options.turnEpoch === undefined ? {} : { turn_epoch: options.turnEpoch }),
        agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: options.session ?? "s-0" },
      },
    ],
  });
}

const hostOf = (topology: SessionTopology, connection = 3): HostView =>
  ({ id: "mac-mini", name: "Mac mini", state: "connected", topology, connection, incarnation: 1, epoch: commandEpoch }) as HostView;

const rowOf = (status: string) =>
  ({ paneID: "w1:p1", name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status, glyph: status === "working" ? "working" : "idle" }) as SidebarRow;

beforeEach(() => {
  listeners = [];
  escapes = [];
  stopCalls = 0;
  commandEpoch = 7;
  clock = 1_762_000_000_000;
  active = body;
  machine = topologyOf("idle");
  writer = {
    agentKeys: async (paneID: string, keys: readonly string[]) => {
      escapes.push({ paneID, keys });
    },
  };
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  composerDrafts.clear();
  agentStops.clear();
  armedStops.clear();
  pendingMessages.clear();
  escapeOwners.reset();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: () => Promise.resolve(),
      // The page's stop runs main's for real on the fake machine.
      stopAgent: (_hostId: string, paneId: string, binding: StopBinding) => {
        stopCalls += 1;
        return stopAgent(site(paneId), paneId, binding);
      },
      copyText: () => undefined,
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
  vi.stubGlobal("document", {
    body,
    get activeElement() {
      return active;
    },
    fonts: { ready: Promise.resolve() },
  });
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  // A test that failed before its unmount leaves no Chat behind to take the next test's keys.
  for (const ui of mounted.splice(0)) ui.unmount();
  armedStops.clear();
  pendingMessages.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function press(keyName: string, keys: Record<string, unknown> = {}, handler?: (event: unknown) => void) {
  const event = {
    key: keyName,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    nativeEvent: { isComposing: false },
    ...keys,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation: () => undefined,
  };
  for (const l of listeners.filter((x) => x.type === "keydown" && x.capture)) l.fn(event);
  handler?.(event);
  for (const l of listeners.filter((x) => x.type === "keydown" && !x.capture)) l.fn(event);
  return event;
}

/** Chat's box for the pane as the machine shows it now; `show` moves the machine (its snapshots) and the page on. */
function chatBox() {
  const props = () => ({ host: hostOf(machine), row: rowOf(machine.panes[0]!.agentStatus), floating: true, stops: true });
  const ui = new HookHost(Composer as (p: object) => unknown, props());
  mounted.push(ui);
  ui.render();
  const textarea = () => elements(ui.tree).find((e) => e.type === "textarea")!;
  return {
    ui,
    show: (next: SessionTopology, connection = 3) => {
      machine = next;
      ui.render({ host: hostOf(next, connection), row: rowOf(next.panes[0]!.agentStatus), floating: true, stops: true });
    },
    stopShown: () => elements(ui.tree).some((e) => e.props["aria-label"] === "Stop"),
    keyInBox: (event: unknown) => (textarea().props["onKeyDown"] as (e: unknown) => void)(event),
    type: (value: string) => (textarea().props["onChange"] as (e: unknown) => void)({ target: { value } }),
  };
}

/** The user just sent "h" from this Chat: its pending bubble. */
const sendH = (): string => pendingMessages.add(key, "h", clock, { terminalID: "t-0", session: "s-0" });

describe("Esc right after a send", () => {
  it("arms one stop: Herdr then reports the turn working, and one Escape goes", async () => {
    const c = chatBox();
    sendH();
    expect(c.stopShown()).toBe(false);
    const event = press("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(stopCalls).toBe(0);
    // The Stop square stands in Send's place while armed.
    expect(c.stopShown()).toBe(true);
    clock += 1_200;
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toEqual([{ paneID: "w1:p1", keys: ["Escape"] }]);
    expect(armedStops.isArmed(key)).toBe(false);
    c.ui.unmount();
  });

  it("arms from the box too, with text in it, the draft untouched", async () => {
    const c = chatBox();
    sendH();
    c.type("next thought");
    active = { tagName: "TEXTAREA" };
    press("Escape", {}, c.keyInBox);
    expect(armedStops.isArmed(key)).toBe(true);
    expect(composerDrafts.get(key).text).toBe("next thought");
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toHaveLength(1);
    c.ui.unmount();
  });

  it("sends nothing when working never comes within 5 s", async () => {
    const c = chatBox();
    sendH();
    press("Escape");
    clock += 5_000;
    c.ui.render();
    expect(c.stopShown()).toBe(false);
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(stopCalls).toBe(0);
    expect(escapes).toEqual([]);
    c.ui.unmount();
  });

  it("sends nothing for a status of a new session, another terminal, or another connection", async () => {
    for (const next of [
      { topology: topologyOf("working", { seq: 13, session: "s-9" }), connection: 3 },
      { topology: topologyOf("working", { seq: 13, terminal: "t-5" }), connection: 3 },
      { topology: topologyOf("working", { seq: 13 }), connection: 4 },
    ]) {
      machine = topologyOf("idle");
      const c = chatBox();
      sendH();
      press("Escape");
      c.show(next.topology, next.connection);
      await flush();
      // Nor later, once the first is dropped.
      c.show(topologyOf("working", { seq: 14 }));
      await flush();
      c.ui.unmount();
      pendingMessages.clear();
    }
    expect(stopCalls).toBe(0);
    expect(escapes).toEqual([]);
  });

  it("sends nothing when only the command connection was replaced (the same connection number, a new epoch)", async () => {
    const c = chatBox();
    sendH();
    press("Escape");
    commandEpoch = 8;
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    // Nor later on the new connection.
    c.show(topologyOf("working", { seq: 14 }));
    await flush();
    expect(armedStops.isArmed(key)).toBe(false);
    expect(escapes).toEqual([]);
    c.ui.unmount();
  });

  it("sends nothing when the send it was armed for failed before working came", async () => {
    const c = chatBox();
    const pending = sendH();
    press("Escape");
    expect(armedStops.isArmed(key)).toBe(true);
    pendingMessages.failed(pending);
    expect(armedStops.isArmed(key)).toBe(false);
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toEqual([]);
    c.ui.unmount();
  });

  it("a real Composer send rejected (never written) cancels the armed stop", async () => {
    const c = chatBox();
    let rejectSend!: (error: Error) => void;
    (window.herdrDesktop as unknown as { sendToPane: () => Promise<void> }).sendToPane = () =>
      new Promise((_resolve, reject) => {
        rejectSend = reject;
      });
    c.type("h");
    active = { tagName: "TEXTAREA" };
    press("Enter", {}, c.keyInBox);
    await flush();
    expect(pendingMessages.forPane(key)).toHaveLength(1);
    press("Escape", {}, c.keyInBox);
    expect(armedStops.isArmed(key)).toBe(true);
    rejectSend(new Error("Not sent: request was never written"));
    await flush();
    expect(pendingMessages.forPane(key)).toEqual([]);
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toEqual([]);
    c.ui.unmount();
  });

  it("keeps the arm when its bubble clears because the transcript has the message", async () => {
    const c = chatBox();
    sendH();
    press("Escape");
    // The transcript showed it (the bubble goes) before Herdr reports working.
    pendingMessages.clear();
    expect(armedStops.isArmed(key)).toBe(true);
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toHaveLength(1);
    c.ui.unmount();
  });

  it("is not armed by a bubble that aged past 30 s without a render, in the window or the box", async () => {
    const c = chatBox();
    sendH();
    clock += 30_001;
    press("Escape");
    expect(armedStops.isArmed(key)).toBe(false);
    active = { tagName: "TEXTAREA" };
    press("Escape", {}, c.keyInBox);
    expect(armedStops.isArmed(key)).toBe(false);
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toEqual([]);
    c.ui.unmount();
  });

  it("fires only for a higher sequence than at the press: a late snapshot of the old working episode is not it", async () => {
    const c = chatBox();
    sendH();
    press("Escape");
    // A delayed working snapshot from before the send: the sequence went back.
    c.show(topologyOf("working", { seq: 11 }));
    await flush();
    expect(escapes).toEqual([]);
    expect(armedStops.isArmed(key)).toBe(true);
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toHaveLength(1);
    c.ui.unmount();
  });

  it("drops the arm when the generation (turn_epoch) changes: a restarted counter proves nothing", async () => {
    machine = topologyOf("idle", { turnEpoch: 1 });
    const c = chatBox();
    sendH();
    press("Escape");
    c.show(topologyOf("working", { seq: 13, turnEpoch: 2 }));
    await flush();
    expect(armedStops.isArmed(key)).toBe(false);
    c.show(topologyOf("working", { seq: 14, turnEpoch: 2 }));
    await flush();
    expect(escapes).toEqual([]);
    c.ui.unmount();
    // The same generation, a higher sequence: one Escape.
    machine = topologyOf("idle", { turnEpoch: 1 });
    const d = chatBox();
    press("Escape");
    d.show(topologyOf("working", { seq: 13, turnEpoch: 1 }));
    await flush();
    expect(escapes).toHaveLength(1);
    d.ui.unmount();
  });

  it("with no sequence reported, a working episode other than the one at the press fires, the same one does not", async () => {
    machine = topologyOf("idle", { seq: null });
    const c = chatBox();
    sendH();
    press("Escape");
    c.show(topologyOf("working", { seq: null }));
    await flush();
    expect(escapes).toHaveLength(1);
    c.ui.unmount();
  });

  for (const [from, to] of [
    [12, null],
    [null, 13],
  ] as const) {
    it(`drops the arm when the sequence appears or disappears, straight to working: ${String(from)} -> ${String(to)}`, async () => {
      machine = topologyOf("idle", { seq: from, turnEpoch: 5 });
      const c = chatBox();
      sendH();
      press("Escape");
      c.show(topologyOf("working", { seq: to, turnEpoch: 5 }));
      await flush();
      expect(armedStops.isArmed(key)).toBe(false);
      expect(escapes).toEqual([]);
      c.ui.unmount();
    });

    it(`drops the arm when the sequence appears or disappears in an idle snapshot before working: ${String(from)} -> ${String(to)}`, async () => {
      machine = topologyOf("idle", { seq: from, turnEpoch: 5 });
      const c = chatBox();
      sendH();
      press("Escape");
      c.show(topologyOf("idle", { seq: to, turnEpoch: 5 }));
      expect(armedStops.isArmed(key)).toBe(false);
      c.show(topologyOf("working", { seq: 14, turnEpoch: 5 }));
      await flush();
      expect(escapes).toEqual([]);
      c.ui.unmount();
    });
  }

  it("a real send failure cancels its arm even after the transcript matched its bubble", async () => {
    const c = chatBox();
    pendingMessages.observe(key, timelineOf([]).timeline);
    let rejectSend!: (error: Error) => void;
    (window.herdrDesktop as unknown as { sendToPane: () => Promise<void> }).sendToPane = () =>
      new Promise((_resolve, reject) => {
        rejectSend = reject;
      });
    c.type("h");
    active = { tagName: "TEXTAREA" };
    press("Enter", {}, c.keyInBox);
    await flush();
    press("Escape", {}, c.keyInBox);
    // The transcript has the user's message first: the bubble goes, the arm stays.
    pendingMessages.observe(key, timelineOf([user("h", "new-user", 0)]).timeline);
    expect(pendingMessages.forPane(key)).toHaveLength(0);
    expect(armedStops.isArmed(key)).toBe(true);
    // Then main's answer: not taken (a failed send is never claimed as sent).
    rejectSend(new Error("Not sent: Claude Code did not take the message. It is still in the box."));
    await flush();
    expect(composerDrafts.get(key).error).toBe("Not sent: Claude Code did not take the message. It is still in the box.");
    expect(armedStops.isArmed(key)).toBe(false);
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toEqual([]);
    c.ui.unmount();
  });

  it("another send's failure never cancels the arm of the newest one", async () => {
    const c = chatBox();
    const older = pendingMessages.add(key, "first", clock - 1_000, { terminalID: "t-0", session: "s-0" });
    sendH();
    press("Escape");
    pendingMessages.failed(older);
    expect(armedStops.isArmed(key)).toBe(true);
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toHaveLength(1);
    c.ui.unmount();
  });

  it("sends nothing for another pane's working agent", async () => {
    const c = chatBox();
    sendH();
    press("Escape");
    const other = decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [],
      tabs: [],
      panes: [
        { pane_id: "w1:p1", terminal_id: "t-0", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "idle", revision: 2 },
        { pane_id: "w1:p2", terminal_id: "t-1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "working", revision: 1 },
      ],
      layouts: [],
      agents: [
        { pane_id: "w1:p1", agent: "claude", agent_status: "idle", terminal_id: "t-0", state_change_seq: 12, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-0" } },
        { pane_id: "w1:p2", agent: "claude", agent_status: "working", terminal_id: "t-1", state_change_seq: 3, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" } },
      ],
    });
    c.show(other);
    await flush();
    expect(escapes).toEqual([]);
    c.ui.unmount();
  });

  it("a second Esc while armed still sends one Escape", async () => {
    const c = chatBox();
    sendH();
    press("Escape");
    clock += 300;
    press("Escape");
    clock += 300;
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toHaveLength(1);
    c.ui.unmount();
  });

  it("Esc after working is today's path: one Escape", async () => {
    const c = chatBox();
    sendH();
    c.show(topologyOf("working", { seq: 13 }));
    press("Escape");
    await flush();
    expect(escapes).toHaveLength(1);
    c.ui.unmount();
  });

  it("drops it when the user sends again, or the box goes", async () => {
    const c = chatBox();
    sendH();
    press("Escape");
    c.type("one more");
    active = { tagName: "TEXTAREA" };
    press("Enter", {}, c.keyInBox);
    await flush();
    expect(armedStops.isArmed(key)).toBe(false);
    c.show(topologyOf("working", { seq: 13 }));
    await flush();
    expect(escapes).toEqual([]);
    c.ui.unmount();
    machine = topologyOf("idle");
    active = body;
    const d = chatBox();
    press("Escape");
    expect(armedStops.isArmed(key)).toBe(true);
    d.ui.unmount();
    expect(armedStops.isArmed(key)).toBe(false);
  });

  it("never arms with nothing just sent, for a held or modified Esc, or an agent waiting on a dialog", async () => {
    const c = chatBox();
    press("Escape");
    expect(armedStops.isArmed(key)).toBe(false);
    sendH();
    for (const keys of [{ repeat: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
      press("Escape", keys);
    }
    expect(armedStops.isArmed(key)).toBe(false);
    c.ui.unmount();
    machine = topologyOf("blocked");
    const d = chatBox();
    press("Escape");
    expect(armedStops.isArmed(key)).toBe(false);
    d.ui.unmount();
    // A send long ago is not just sent.
    pendingMessages.clear();
    machine = topologyOf("idle");
    pendingMessages.add(key, "old", clock - 60_000, null);
    const e = chatBox();
    press("Escape");
    expect(armedStops.isArmed(key)).toBe(false);
    e.ui.unmount();
    expect(escapes).toEqual([]);
  });

  it("never sends an Escape to an agent that went idle or done instead", async () => {
    const c = chatBox();
    sendH();
    press("Escape");
    c.show(topologyOf("done", { seq: 13 }));
    c.show(topologyOf("idle", { seq: 14 }));
    await flush();
    expect(escapes).toEqual([]);
    c.ui.unmount();
  });
});

describe("the armed store", () => {
  const scope = { terminalID: "t-0", kind: "claude", session: "s-0", incarnation: 1, connection: 3, epoch: 7, episode: "idle-12", seq: null, generation: null };
  it("expires after 5 s and fires once for a new working episode", () => {
    let now = 0;
    const timers: (() => void)[] = [];
    const store = new ArmedStops(() => now, (run) => timers.push(run), () => undefined);
    expect(store.arm("k", scope)).toBe(true);
    expect(store.arm("k", scope)).toBe(false);
    expect(store.take("k", scope, false)).toBe(false);
    expect(store.take("k", { ...scope, episode: "working-13" }, true)).toBe(true);
    expect(store.take("k", { ...scope, episode: "working-13" }, true)).toBe(false);
    store.arm("k", scope);
    now = 5_000;
    timers.at(-1)!();
    expect(store.isArmed("k")).toBe(false);
    expect(store.take("k", { ...scope, episode: "working-13" }, true)).toBe(false);
  });

  it("is just sent only for the newest bubble under 30 s, to the terminal shown", () => {
    const item = (sentAtMs: number, terminalID = "t-0") => ({ id: "p", key: "k", text: "h", match: "h", attachments: { paths: [], count: 0 }, sentAtMs, state: "sent" as const, scope: { terminalID, session: "s-0" } });
    expect(justSentFrom([], "t-0", 10_000)).toBe(false);
    expect(justSentFrom([item(9_000)], "t-0", 10_000)).toBe(true);
    expect(justSentFrom([item(9_000)], "t-5", 10_000)).toBe(false);
    expect(justSentFrom([item(0)], "t-0", 30_000)).toBe(false);
  });
});

// The armed store's boundaries: episodes, sequences and generations.
describe("the armed store's boundaries", () => {
  const scope = { terminalID: "t-0", kind: "claude", session: "s-0", incarnation: 1, connection: 3, epoch: 7, episode: "idle-12", seq: null, generation: null };

  it("does not use up an arm for the episode shown at the press", () => {
    const store = new ArmedStops();
    store.arm("k", scope);
    expect(store.take("k", scope, true)).toBe(false);
    expect(store.isArmed("k")).toBe(true);
    store.clear();
  });

  it("is never armed by Esc in an overlay, another field, a terminal, another tile, or a key that began in a field", () => {
    const c = chatBox();
    sendH();
    for (const tagName of ["TEXTAREA", "INPUT", "SELECT"]) {
      active = { tagName };
      press("Escape");
      expect(armedStops.isArmed(key)).toBe(false);
    }
    active = { tagName: "DIV", closest: (selector: string) => (selector === ".term-host" ? {} : null) };
    press("Escape");
    expect(armedStops.isArmed(key)).toBe(false);
    active = { tagName: "DIV", closest: (selector: string) => (selector === "[data-tile]" ? { getAttribute: () => "w1:p2" } : null) };
    press("Escape");
    expect(armedStops.isArmed(key)).toBe(false);
    active = body;
    press("Escape", { target: { tagName: "INPUT" } });
    expect(armedStops.isArmed(key)).toBe(false);
    const release = escapeOwners.hold();
    press("Escape");
    expect(armedStops.isArmed(key)).toBe(false);
    release();
    for (const keys of [{ altKey: true }, { ctrlKey: true }, { nativeEvent: { isComposing: true }, isComposing: true }]) press("Escape", keys);
    expect(armedStops.isArmed(key)).toBe(false);
    c.ui.unmount();
  });

  it("drops it for another kind or machine entry, and leaves no key listener once unmounted", async () => {
    const c = chatBox();
    sendH();
    press("Escape");
    const working = topologyOf("working", { seq: 13 });
    machine = working;
    c.ui.render({ host: { ...hostOf(working), incarnation: 2 }, row: rowOf("working"), floating: true, stops: true });
    await flush();
    expect(escapes).toEqual([]);
    c.ui.unmount();
    expect(armedStops.isArmed(key)).toBe(false);
    expect(listeners.filter((listener) => listener.type === "keydown")).toEqual([]);
    const store = new ArmedStops();
    store.arm("kind", scope);
    expect(store.take("kind", { ...scope, kind: "codex", episode: "working-13" }, true)).toBe(false);
    expect(store.isArmed("kind")).toBe(false);
  });

  it("hides the square at the deadline and clears its timer on unmount", () => {
    vi.useFakeTimers();
    try {
      const c = chatBox();
      sendH();
      press("Escape");
      expect(c.stopShown()).toBe(true);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      clock += 5_000;
      vi.advanceTimersByTime(5_000);
      expect(c.stopShown()).toBe(false);
      press("Escape");
      c.ui.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
