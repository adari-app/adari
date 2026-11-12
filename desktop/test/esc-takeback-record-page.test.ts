// Esc take-back, the page's side. A press that waits (the
// second Esc during a take-back, or the first press's fallback when the read found no queue) is bound to the
// episode and dialog state it was pressed in, not only the pane, session and run: a dialog shown, or a new episode,
// while main answers calls it off, at once and for good. Its Stop goes through main's real stopAgent here, so an
// Escape it would write into the dialog shows. The real Composer on the small hooks host; a fake bridge only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import { stopAgent } from "../src/main/herdr/stop";
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
const { agentStops } = await import("../src/renderer/components/agent-stop");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { takeBacks } = await import("../src/renderer/chat/take-back");

const key = draftKey("mac-mini", "w1:p1");
let stopped: unknown[][] = [];
/** The keys main's real stopAgent wrote to the pane. */
let written: string[] = [];
let finish: (answer: QueuedTakeBack) => void = () => undefined;
const body = { classList: { add: () => undefined } };

interface View {
  readonly status?: string;
  readonly inputPending?: boolean;
  readonly seq?: number;
}

function topologyOf(view: View): SessionTopology {
  const status = view.status ?? "working";
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-0", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: status, revision: 1 }],
    layouts: [],
    agents: [
      {
        pane_id: "w1:p1",
        agent: "claude",
        agent_status: status,
        terminal_id: "t-0",
        state_change_seq: view.seq ?? 12,
        turn_epoch: 9,
        ...(view.inputPending === true ? { input_pending: true } : {}),
        agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-0" },
      },
    ],
  });
}

let shown: SessionTopology = topologyOf({});

function propsOf(view: View = {}) {
  shown = topologyOf(view);
  const status = view.status ?? "working";
  const host = { id: "mac-mini", name: "Mac mini", state: "connected", topology: shown, connection: 3, incarnation: 1, epoch: 7 } as HostView;
  const row = { paneID: "w1:p1", name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status, glyph: status === "blocked" ? "blocked" : "working" } as SidebarRow;
  return { host, row, floating: true, stops: true };
}

beforeEach(() => {
  stopped = [];
  written = [];
  composerDrafts.clear();
  agentStops.clear();
  pendingMessages.clear();
  takeBacks.clear();
  escapeOwners.reset();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: () => Promise.resolve(),
      // Main's real Stop (one plain Esc, as ordinary Stop always is), on the pane as Herdr shows it now.
      stopAgent: (hostId: string, paneId: string, binding: { terminalID: string; incarnation: number }) => {
        stopped.push(["stopAgent", hostId, paneId]);
        return stopAgent(
          {
            writer: { agentKeys: async (_pane: string, keys: readonly string[]) => void written.push(...keys) },
            machine: "Mac mini",
            pane: () => shown.panes[0] ?? null,
            identity: () => ({ incarnation: 1, connection: 3, epoch: 7 }),
          },
          paneId,
          binding,
        );
      },
      stopIfWorking: () => Promise.resolve({ sent: false, note: null }),
      takeBackQueued: () =>
        new Promise<QueuedTakeBack>((resolve) => {
          finish = resolve;
        }),
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

function queued(text: string): void {
  const id = pendingMessages.add(key, text, Date.now(), { terminalID: "t-0", session: "s-0" });
  pendingMessages.delivered(id);
}

function composer() {
  const ui = new HookHost(Composer as (p: object) => unknown, propsOf());
  ui.render();
  const press = () => {
    const textarea = elements(ui.tree).find((e) => e.type === "textarea")!;
    const event = { key: "Escape", metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false, nativeEvent: { isComposing: false }, preventDefault() { this.defaultPrevented = true; }, stopPropagation: () => undefined };
    (textarea.props["onKeyDown"] as (e: unknown) => void)(event);
  };
  return { ui, press };
}

const changes: [string, View][] = [
  ["a dialog (the agent blocked, a menu pending)", { status: "blocked", inputPending: true }],
  ["a new episode (another state_change_seq)", { seq: 14 }],
];

describe("a waiting Esc is bound to its episode and dialog state", () => {
  it.each(changes)("the second Esc waiting for a take-back, then %s shown: no stop, no Escape", async (_name, view) => {
    queued("abc");
    const { ui, press } = composer();
    press();
    press();
    ui.render(propsOf(view));
    // Main saw the dialog and refused the take-back (pressed: Up went first).
    finish({ type: "left", note: takeBackTexts.dialog, pressed: true });
    await flush();
    expect(stopped).toEqual([]);
    expect(written).toEqual([]);
    ui.unmount();
  });

  it.each(changes)("the first press's fallback (the read found no queue), then %s shown: no stop, no Escape", async (_name, view) => {
    queued("abc");
    const { ui, press } = composer();
    press();
    ui.render(propsOf(view));
    finish({ type: "none" });
    await flush();
    expect(stopped).toEqual([]);
    expect(written).toEqual([]);
    ui.unmount();
  });

  it("Herdr's input pending alone while it waits: no stop", async () => {
    queued("abc");
    const { ui, press } = composer();
    press();
    ui.render(propsOf({ inputPending: true }));
    finish({ type: "none" });
    await flush();
    expect(stopped).toEqual([]);
    ui.unmount();
  });

  it("a dialog shown and gone again before main answers: still called off (for good)", async () => {
    queued("abc");
    const { ui, press } = composer();
    press();
    press();
    ui.render(propsOf({ status: "blocked", inputPending: true }));
    ui.render(propsOf());
    finish({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    await flush();
    expect(stopped).toEqual([]);
    expect(written).toEqual([]);
    ui.unmount();
  });

  it("the same episode still shown: the waiting second Esc stops it (the control), one Escape", async () => {
    queued("abc");
    const { ui, press } = composer();
    press();
    press();
    ui.render(propsOf());
    finish({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    await flush();
    expect(stopped).toEqual([["stopAgent", "mac-mini", "w1:p1"]]);
    expect(written).toEqual(["Escape"]);
    ui.unmount();
  });

  it("the same episode still shown and no queue: the first press stops (the control)", async () => {
    queued("abc");
    const { ui, press } = composer();
    press();
    finish({ type: "none" });
    await flush();
    expect(stopped).toEqual([["stopAgent", "mac-mini", "w1:p1"]]);
    ui.unmount();
  });
});
