// Esc take-back, the page's side: while the user's send from Chat still waits in Claude's queue (its bubble says
// Queued), Esc's first press, Up in an empty box, or the bubble's Take back asks main to take it back; taken, the
// text is back in the box, the bubble gone, and the note says "Taken back. Claude keeps working."; a second Esc
// stops. Nothing on Claude's screen to take back: the same press stops as before. Codex and an idle agent's armed
// stop are unchanged. The real Composer runs on the small hooks host.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { takeBackTexts, type QueuedTakeBack } from "../src/shared/claude-screen";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { agentStops, armedStops } = await import("../src/renderer/components/agent-stop");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { PendingBubble } = await import("../src/renderer/chat/ChatView");
const { putTakenBack, queuedSends, splitPictures, takeBacks } = await import("../src/renderer/chat/take-back");

const key = draftKey("mac-mini", "w1:p1");
let calls: unknown[][] = [];
let answers: QueuedTakeBack[] = [];
let listeners: { type: string; fn: (event: unknown) => void }[] = [];
const body = { classList: { add: () => undefined } };

beforeEach(() => {
  calls = [];
  answers = [];
  listeners = [];
  composerDrafts.clear();
  agentStops.clear();
  pendingMessages.clear();
  takeBacks.clear();
  escapeOwners.reset();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: () => Promise.resolve(),
      stopAgent: () => {
        calls.push(["stopAgent"]);
        return Promise.resolve(null);
      },
      stopIfWorking: () => {
        calls.push(["stopIfWorking"]);
        return Promise.resolve({ sent: true, note: null });
      },
      takeBackQueued: (hostId: string, paneId: string, _binding: unknown, texts: readonly string[]) => {
        calls.push(["takeBackQueued", hostId, paneId, [...texts]]);
        return Promise.resolve(answers.shift() ?? { type: "none" });
      },
      openChat: () => undefined,
      closeChat: () => undefined,
      copyText: () => undefined,
      onChatUpdate: () => () => undefined,
    },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.push({ type, fn }),
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners = listeners.filter((l) => l.type !== type || l.fn !== fn);
    },
    getSelection: () => null,
  });
  vi.stubGlobal("document", { body, activeElement: body, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function topologyOf(status: string, agent = "claude"): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-0", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent, agent_status: status, revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent, agent_status: status, terminal_id: "t-0", state_change_seq: 12, agent_session: { source: `herdr:${agent}`, agent, kind: "id", value: "s-0" } }],
  });
}

const hostOf = (status: string, agent = "claude"): HostView => ({ id: "mac-mini", name: "Mac mini", state: "connected", topology: topologyOf(status, agent), connection: 3, incarnation: 1, epoch: 7 }) as HostView;
const rowOf = (status: string, kind = "claude") => ({ paneID: "w1:p1", name: "claude 1", workspaceLabel: "ops", isAgent: true, kind, status, glyph: status === "working" ? "working" : "idle" }) as SidebarRow;

/** The user's send from Chat that Herdr took: its bubble waits (Queued while Claude works). */
function queued(text: string, nowMs = Date.now()): string {
  const id = pendingMessages.add(key, text, nowMs, { terminalID: "t-0", session: "s-0" });
  pendingMessages.delivered(id);
  return id;
}

function composer(status = "working", kind = "claude") {
  const ui = new HookHost(Composer as (p: object) => unknown, { host: hostOf(status, kind), row: rowOf(status, kind), floating: true, stops: true });
  ui.render();
  const textarea = () => elements(ui.tree).find((e) => e.type === "textarea")!;
  const press = (name: string) => {
    const event = { key: name, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false, nativeEvent: { isComposing: false }, preventDefault() { this.defaultPrevented = true; }, stopPropagation: () => undefined };
    (textarea().props["onKeyDown"] as (e: unknown) => void)(event);
    return event;
  };
  return { ui, textarea, press };
}

describe("Esc with a queued message", () => {
  it("takes it back instead of stopping: the text is in the box, the bubble gone, the note says so", async () => {
    queued("abc");
    answers.push({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    const { ui, press } = composer();
    expect(press("Escape").defaultPrevented).toBe(true);
    await flush();
    expect(calls).toEqual([["takeBackQueued", "mac-mini", "w1:p1", ["abc"]]]);
    expect(composerDrafts.get(key).text).toBe("abc");
    expect(pendingMessages.forPane(key)).toEqual([]);
    expect(agentStops.note(key)).toBe("Taken back. Claude keeps working.");
    ui.unmount();
  });

  it("the second Esc stops Claude as today", async () => {
    queued("abc");
    answers.push({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    const { ui, press } = composer();
    press("Escape");
    await flush();
    ui.render();
    press("Escape");
    await flush();
    expect(calls.map((call) => call[0])).toEqual(["takeBackQueued", "stopAgent"]);
    ui.unmount();
  });

  it("a second Esc while the take-back runs waits for it, then stops", async () => {
    queued("abc");
    answers.push({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    const { ui, press } = composer();
    press("Escape");
    press("Escape");
    expect(calls.map((call) => call[0])).toEqual(["takeBackQueued"]);
    await flush();
    expect(calls.map((call) => call[0])).toEqual(["takeBackQueued", "stopAgent"]);
    ui.unmount();
  });

  it("no queue on Claude's screen: the same press stops as before, and nothing comes back", async () => {
    queued("abc");
    answers.push({ type: "none" });
    const { ui, press } = composer();
    press("Escape");
    await flush();
    expect(calls.map((call) => call[0])).toEqual(["takeBackQueued", "stopAgent"]);
    expect(composerDrafts.get(key).text).toBe("");
    expect(pendingMessages.forPane(key)).toHaveLength(1);
    ui.unmount();
  });

  it("left (other text in Claude's box): the note says why, nothing stops; the next Esc stops without trying again", async () => {
    queued("abc");
    answers.push({ type: "left", note: takeBackTexts.boxHasText, pressed: false });
    const { ui, press } = composer();
    press("Escape");
    await flush();
    expect(calls.map((call) => call[0])).toEqual(["takeBackQueued"]);
    expect(agentStops.note(key)).toBe(takeBackTexts.boxHasText);
    expect(composerDrafts.get(key).text).toBe("");
    press("Escape");
    await flush();
    expect(calls.map((call) => call[0])).toEqual(["takeBackQueued", "stopAgent"]);
    ui.unmount();
  });

  it("two of the user's queued: both asked for, oldest first, and both come back in order", async () => {
    queued("one");
    queued("two");
    answers.push({ type: "taken", texts: ["one", "two"], note: takeBackTexts.taken });
    const { ui, press } = composer();
    press("Escape");
    await flush();
    expect(calls[0]).toEqual(["takeBackQueued", "mac-mini", "w1:p1", ["one", "two"]]);
    expect(composerDrafts.get(key).text).toBe("one\ntwo");
    expect(pendingMessages.forPane(key)).toEqual([]);
    ui.unmount();
  });

  it("nothing of the user's queued: Esc stops at once, as before", () => {
    const { ui, press } = composer();
    press("Escape");
    expect(calls.map((call) => call[0])).toEqual(["stopAgent"]);
    ui.unmount();
  });

  it("a Codex pane: Esc stops as before, never a take-back", () => {
    queued("abc");
    const { ui, press } = composer("working", "codex");
    press("Escape");
    expect(calls.map((call) => call[0])).toEqual(["stopAgent"]);
    ui.unmount();
  });

  it("an idle Claude right after a send: the armed stop as before, no take-back", () => {
    queued("abc");
    const { ui, press } = composer("idle");
    press("Escape");
    expect(calls.map((call) => call[0])).toEqual([]);
    expect(armedStops.isArmed(key)).toBe(true);
    ui.unmount();
  });
});

describe("Up in an empty box", () => {
  it("takes back the newest queued messages", async () => {
    queued("abc");
    answers.push({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    const { ui, press } = composer();
    expect(press("ArrowUp").defaultPrevented).toBe(true);
    await flush();
    expect(calls.map((call) => call[0])).toEqual(["takeBackQueued"]);
    expect(composerDrafts.get(key).text).toBe("abc");
    ui.unmount();
  });

  it("nothing of the user's on Claude's screen: it says so, and nothing stops", async () => {
    queued("abc");
    answers.push({ type: "none" });
    const { ui, press } = composer();
    press("ArrowUp");
    await flush();
    expect(calls.map((call) => call[0])).toEqual(["takeBackQueued"]);
    expect(agentStops.note(key)).toBe(takeBackTexts.noQueue);
    ui.unmount();
  });

  it("with text in the box Up is the box's own (the caret moves); nothing is asked", () => {
    queued("abc");
    const { ui, press, textarea } = composer();
    (textarea().props["onChange"] as (e: unknown) => void)({ target: { value: "draft" } });
    ui.render();
    expect(press("ArrowUp").defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    ui.unmount();
  });
});

/** The bubble rendered on the hooks host. */
function bubble(props: object): unknown {
  const ui = new HookHost(PendingBubble as (p: object) => unknown, props);
  ui.render();
  return ui.tree;
}

describe("the Queued bubble's Take back", () => {
  it("shows on a Queued bubble Herdr took, and its click takes back", () => {
    const id = queued("abc");
    const message = pendingMessages.forPane(key).find((item) => item.id === id)!;
    let clicked = 0;
    const tree = bubble({ message, working: true, now: Date.now(), onMenu: () => undefined, onTakeBack: () => (clicked += 1) });
    const button = elements(tree).find((e) => e.type === "button" && e.props["className"] === "pst-take")!;
    expect(button).toBeDefined();
    (button.props["onClick"] as () => void)();
    expect(clicked).toBe(1);
  });

  it("not on a bubble that is not Queued (the agent idle), nor without a take-back", () => {
    const id = queued("abc");
    const message = pendingMessages.forPane(key).find((item) => item.id === id)!;
    const idle = bubble({ message, working: false, now: Date.now(), onMenu: () => undefined, onTakeBack: () => undefined });
    expect(elements(idle).some((e) => e.props["className"] === "pst-take")).toBe(false);
    const plain = bubble({ message, working: true, now: Date.now(), onMenu: () => undefined });
    expect(elements(plain).some((e) => e.props["className"] === "pst-take")).toBe(false);
  });
});

describe("what comes back", () => {
  it("only bubbles Herdr took, to the terminal shown", () => {
    const sending = pendingMessages.add(key, "still going", Date.now(), { terminalID: "t-0", session: "s-0" });
    queued("abc");
    const other = pendingMessages.add(key, "elsewhere", Date.now(), { terminalID: "t-9", session: "s-0" });
    pendingMessages.delivered(other);
    expect(queuedSends(pendingMessages.forPane(key), "t-0").map((item) => item.text)).toEqual(["abc"]);
    void sending;
  });

  it("its pictures come back as chips when the box is empty, the caption as text", () => {
    const sent = "look at this /Users/demo/.adari/uploads/a1b2.png";
    expect(splitPictures([sent])).toEqual({ text: "look at this", chips: [{ path: "/Users/demo/.adari/uploads/a1b2.png", name: "a1b2.png", image: true }] });
    putTakenBack(composerDrafts, () => undefined, key, [sent]);
    expect(composerDrafts.get(key).text).toBe("look at this");
    expect(composerDrafts.get(key).chips.map((chip) => chip.state)).toEqual([expect.objectContaining({ kind: "uploaded", path: "/Users/demo/.adari/uploads/a1b2.png" })]);
  });

  it("with the user's typing in the box, the text goes first and their typing after it", () => {
    composerDrafts.edit(key, "more");
    putTakenBack(composerDrafts, () => undefined, key, ["abc"]);
    expect(composerDrafts.get(key).text).toBe("abc\nmore");
  });
});
