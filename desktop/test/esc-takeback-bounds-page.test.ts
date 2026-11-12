// Esc take-back, the page's side. A late "Taken back" for a message the transcript already shows puts nothing
// back and hides nothing; a refusal (a dialog, a read that failed, a request refused, too many queued) never
// stops on the same press; an Esc that waits acts only on the pane, machine, connection, session and run it was
// pressed for.
// The real Composer on the small hooks host; a fake bridge only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { takeBackMost, takeBackTexts, type QueuedTakeBack } from "../src/shared/claude-screen";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { agentStops } = await import("../src/renderer/components/agent-stop");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { takeBacks } = await import("../src/renderer/chat/take-back");

const key = draftKey("mac-mini", "w1:p1");
let calls: unknown[][] = [];
/** The take-back answers still to give, in order; one left pending until `finish` is called. */
let finish: (answer: QueuedTakeBack) => void = () => undefined;
let fail: (error: Error) => void = () => undefined;
const body = { classList: { add: () => undefined } };

beforeEach(() => {
  calls = [];
  composerDrafts.clear();
  agentStops.clear();
  pendingMessages.clear();
  takeBacks.clear();
  escapeOwners.reset();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: () => Promise.resolve(),
      stopAgent: (hostId: string, paneId: string, binding: { session: string | null }) => {
        calls.push(["stopAgent", hostId, paneId, binding.session]);
        return Promise.resolve(null);
      },
      stopIfWorking: () => {
        calls.push(["stopIfWorking"]);
        return Promise.resolve({ sent: true, note: null });
      },
      takeBackQueued: (hostId: string, paneId: string, _binding: unknown, texts: readonly string[]) => {
        calls.push(["takeBackQueued", hostId, paneId, [...texts]]);
        return new Promise<QueuedTakeBack>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      },
      openChat: () => undefined,
      closeChat: () => undefined,
      copyText: () => undefined,
      onChatUpdate: () => () => undefined,
    },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
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

interface Shown {
  readonly host?: string;
  readonly pane?: string;
  readonly session?: string;
  readonly connection?: number;
  readonly epoch?: number;
  readonly turnEpoch?: number;
}

function topologyOf(pane: string, session: string, turnEpoch: number): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: pane, terminal_id: "t-0", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "working", revision: 1 }],
    layouts: [],
    agents: [
      { pane_id: pane, agent: "claude", agent_status: "working", terminal_id: "t-0", state_change_seq: 12, turn_epoch: turnEpoch, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: session } },
    ],
  });
}

function propsOf(shown: Shown = {}) {
  const pane = shown.pane ?? "w1:p1";
  const host = {
    id: shown.host ?? "mac-mini",
    name: "Mac mini",
    state: "connected",
    topology: topologyOf(pane, shown.session ?? "s-0", shown.turnEpoch ?? 9),
    connection: shown.connection ?? 3,
    incarnation: 1,
    epoch: shown.epoch ?? 7,
  } as HostView;
  const row = { paneID: pane, name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status: "working", glyph: "working" } as SidebarRow;
  return { host, row, floating: true, stops: true };
}

/** The user's send from Chat that Herdr took: its bubble waits (Queued while Claude works). */
function queued(text: string, at = key): string {
  const id = pendingMessages.add(at, text, Date.now(), { terminalID: "t-0", session: "s-0" });
  pendingMessages.delivered(id);
  return id;
}

function composer(shown: Shown = {}) {
  const ui = new HookHost(Composer as (p: object) => unknown, propsOf(shown));
  ui.render();
  const press = (name = "Escape") => {
    const textarea = elements(ui.tree).find((e) => e.type === "textarea")!;
    const event = { key: name, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false, nativeEvent: { isComposing: false }, preventDefault() { this.defaultPrevented = true; }, stopPropagation: () => undefined };
    (textarea.props["onKeyDown"] as (e: unknown) => void)(event);
    return event;
  };
  return { ui, press };
}

const stops = (): unknown[][] => calls.filter((call) => call[0] === "stopAgent");

// MARK: - A late "Taken back" for a message the transcript shows

describe("a message the transcript shows is never taken back on the page", () => {
  it("the transcript settles the same words while the take-back is pending: main's proved pull still comes back, the delivered message is never hidden", async () => {
    pendingMessages.observe(key, { turns: [] } as never);
    queued("abc");
    const { ui, press } = composer();
    press();
    // The transcript shows a message with the same words, and the bubble settles on it.
    pendingMessages.observe(key, { turns: [{ id: "turn-1", items: [{ type: "user", value: { id: "delivered", text: "abc", attachments: [], time: Date.now() / 1_000 } }] }] } as never);
    expect(pendingMessages.forPane(key)).toEqual([]);
    // Main says taken only on Claude Code's record of the pull (a
    // popAll of exactly "abc") with the row cleared: the words come back to the box, never nowhere, and the
    // delivered message stays visible.
    finish({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    await flush();
    expect(pendingMessages.takenBackFor(key).has("delivered")).toBe(false);
    expect(composerDrafts.get(key).text).toBe("abc");
    expect(agentStops.note(key)).toBe(takeBackTexts.taken);
    expect(stops()).toEqual([]);
    ui.unmount();
  });

  it("without the transcript settling first: main's refusal leaves the bubble and the box, and no stop", async () => {
    queued("abc");
    const { ui, press } = composer();
    press();
    finish({ type: "left", note: takeBackTexts.notSureTaken, pressed: true });
    await flush();
    expect(pendingMessages.forPane(key)).toHaveLength(1);
    expect(composerDrafts.get(key).text).toBe("");
    expect(agentStops.note(key)).toBe(takeBackTexts.notSureTaken);
    expect(stops()).toEqual([]);
    // The next Esc stops, as after any refusal.
    ui.render();
    press();
    await flush();
    expect(stops()).toEqual([["stopAgent", "mac-mini", "w1:p1", "s-0"]]);
    ui.unmount();
  });

  it("a genuine take-back still comes back (the control)", async () => {
    queued("abc");
    const { ui, press } = composer();
    press();
    finish({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    await flush();
    expect(composerDrafts.get(key).text).toBe("abc");
    expect(pendingMessages.forPane(key)).toEqual([]);
    expect(stops()).toEqual([]);
    ui.unmount();
  });
});

// MARK: - A refusal never stops on the same press

describe("an unknown read or a dialog is not no queue", () => {
  it.each([
    ["a dialog in the before-read", takeBackTexts.noBox],
    ["a read that failed", takeBackTexts.unread],
    ["the connection changed", takeBackTexts.connection],
  ])("%s: the note shows, and this press does not stop", async (_name, note) => {
    queued("abc");
    const { ui, press } = composer();
    press();
    finish({ type: "left", note, pressed: false });
    await flush();
    expect(agentStops.note(key)).toBe(note);
    expect(stops()).toEqual([]);
    ui.unmount();
  });

  it("the bridge's request fails (refused by main): said, and no stop; the next Esc stops", async () => {
    queued("abc");
    const { ui, press } = composer();
    press();
    fail(new Error("bad request"));
    await flush();
    expect(agentStops.note(key)).toBe(takeBackTexts.unread);
    expect(stops()).toEqual([]);
    ui.render();
    press();
    await flush();
    expect(stops()).toHaveLength(1);
    ui.unmount();
  });

  it(`nine queued (more than ${takeBackMost}): the limit in plain words, no request cut short, and no stop`, async () => {
    for (let index = 0; index < 9; index += 1) queued(`message ${index}`);
    const { ui, press } = composer();
    press();
    await flush();
    expect(calls.filter((call) => call[0] === "takeBackQueued")).toEqual([]);
    expect(agentStops.note(key)).toBe(takeBackTexts.tooMany);
    expect(takeBackTexts.tooMany).toContain(`more than ${takeBackMost}`);
    expect(stops()).toEqual([]);
    expect(pendingMessages.forPane(key)).toHaveLength(9);
    ui.render();
    press();
    await flush();
    expect(stops()).toHaveLength(1);
    ui.unmount();
  });

  it("a read that showed no queue (`none`) still stops on the same press (unchanged)", async () => {
    queued("abc");
    const { ui, press } = composer();
    press();
    finish({ type: "none" });
    await flush();
    expect(stops()).toEqual([["stopAgent", "mac-mini", "w1:p1", "s-0"]]);
    ui.unmount();
  });
});

// MARK: - A deferred Esc acts only on the pane it was pressed for

describe("an Esc that waits acts only on the pane it was pressed for", () => {
  const changes: [string, Shown][] = [
    ["another machine and pane", { host: "mac-studio", pane: "w2:p9" }],
    ["another pane on the same machine", { pane: "w1:p2" }],
    ["a new session in the same pane", { session: "s-1" }],
    ["a new run in the same pane", { turnEpoch: 10 }],
    ["a new connection to the machine", { connection: 4, epoch: 8 }],
  ];

  it.each(changes)("the second Esc waiting for a take-back, then %s shown: no stop at all", async (_name, shown) => {
    queued("abc");
    const { ui, press } = composer();
    press();
    press();
    ui.render(propsOf(shown));
    finish({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    await flush();
    expect(stops()).toEqual([]);
    ui.unmount();
  });

  it.each(changes)("the first press's fallback (no queue), then %s shown: no stop at all", async (_name, shown) => {
    queued("abc");
    const { ui, press } = composer();
    press();
    ui.render(propsOf(shown));
    finish({ type: "none" });
    await flush();
    expect(stops()).toEqual([]);
    ui.unmount();
  });

  it("the box gone while it waits: no stop", async () => {
    queued("abc");
    const { ui, press } = composer();
    press();
    press();
    ui.unmount();
    finish({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    await flush();
    expect(stops()).toEqual([]);
  });

  it("the same pane still shown: the waiting Esc stops it, with the binding of the press (the control)", async () => {
    queued("abc");
    const { ui, press } = composer();
    press();
    press();
    ui.render(propsOf());
    finish({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    await flush();
    expect(stops()).toEqual([["stopAgent", "mac-mini", "w1:p1", "s-0"]]);
    ui.unmount();
  });
});
