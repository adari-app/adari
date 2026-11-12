// Esc stops a working agent from its Chat, as the Stop
// square does, with text in the box too (the draft and its caret untouched).
// Never while something on top owns Esc (the picture viewer, the chip menus, a
// context menu, Send to…, the ring's card, a dialog, the box over the
// terminal): there Esc only closes that thing. Esc with ⌘ ⌥ ⌃ or ⇧ is not
// Stop. Terminal's Esc is the terminal's. The Working line says "Esc to stop"
// while Stop is possible. A split stops only the focused tile's agent. The real
// components run on the small hooks host with a fake window that dispatches a
// key as a browser does: window capture listeners, the focused element's React
// handler, then window bubble listeners.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer, MainPane } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { agentStops } = await import("../src/renderer/components/agent-stop");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { ContextMenu } = await import("../src/renderer/components/ContextMenu");
const { ChipMenu } = await import("../src/renderer/components/AgentChips");
const { ContextRing } = await import("../src/renderer/components/ContextRing");
const { ConfirmClose } = await import("../src/renderer/split/ConfirmClose");
const { ChatView, PictureViewer, pictureViewer } = await import("../src/renderer/chat/ChatView");

type Listener = { type: string; fn: (event: unknown) => void; capture: boolean };

let listeners: Listener[] = [];
let stops: { hostId: string; paneId: string; resolve(note: string | null): void }[] = [];
const body = { classList: { add: () => undefined } };
let active: unknown = body;

beforeEach(() => {
  listeners = [];
  stops = [];
  active = body;
  composerDrafts.clear();
  agentStops.clear();
  escapeOwners.reset();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: () => Promise.resolve(),
      stopAgent: (hostId: string, paneId: string) => new Promise<string | null>((resolve) => stops.push({ hostId, paneId, resolve })),
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
  });
  vi.stubGlobal("document", {
    body,
    get activeElement() {
      return active;
    },
    fonts: { ready: Promise.resolve() },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Keys {
  metaKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  /** An auto-repeat keydown (the key held down). */
  repeat?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing: boolean };
}

/** A keydown as the browser delivers it; `handler` is the focused element's React onKeyDown, if any. */
function press(key: string, keys: Keys = {}, handler?: (event: unknown) => void) {
  const event = {
    key,
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

function topologyOf(status = "working", panes: string[] = ["w1:p1"], seq = 12): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: panes.map((pane_id, i) => ({ pane_id, terminal_id: `t-${i}`, workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: status, revision: 1 })),
    layouts: [],
    agents: panes.map((pane_id, i) => ({
      pane_id,
      agent: "claude",
      agent_status: status,
      terminal_id: `t-${i}`,
      state_change_seq: seq,
      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: `s-${i}` },
    })),
  });
}

function hostOf(state: HostView["state"] = "connected", topology = topologyOf()): HostView {
  return { id: "mac-mini", name: "Mac mini", state, topology, connection: 3, incarnation: 1, epoch: 7 } as HostView;
}

const rowOf = (paneID = "w1:p1", status = "working") =>
  ({ paneID, name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status, glyph: status === "working" ? "working" : "idle" }) as SidebarRow;

function chatBox(props: Record<string, unknown> = {}) {
  const ui = new HookHost(Composer as (p: object) => unknown, { host: hostOf(), row: rowOf(), floating: true, stops: true, ...props });
  ui.render();
  const textarea = () => elements(ui.tree).find((e) => e.type === "textarea")!;
  return {
    ui,
    textarea,
    click: () => (elements(ui.tree).find((e) => e.props["aria-label"] === "Stop")!.props["onClick"] as () => void)(),
    type: (value: string) => (textarea().props["onChange"] as (e: unknown) => void)({ target: { value } }),
    keyInBox: (event: unknown) => (textarea().props["onKeyDown"] as (e: unknown) => void)(event),
  };
}

describe("Esc in a working agent's Chat", () => {
  it("stops it with focus anywhere in the conversation", () => {
    const c = chatBox();
    const event = press("Escape");
    expect(stops.map((s) => [s.hostId, s.paneId])).toEqual([["mac-mini", "w1:p1"]]);
    expect(event.defaultPrevented).toBe(true);
    c.ui.unmount();
  });

  it("stops it with text in the box and leaves the draft as it was", () => {
    const c = chatBox();
    c.type("half a thought");
    active = { tagName: "TEXTAREA" };
    press("Escape", {}, c.keyInBox);
    expect(stops).toHaveLength(1);
    expect(composerDrafts.get(draftKey("mac-mini", "w1:p1")).text).toBe("half a thought");
    expect(c.textarea().props["value"]).toBe("half a thought");
    c.ui.unmount();
  });

  it("sends one Esc per press, also while the first is under way, as the terminal would", async () => {
    const c = chatBox();
    press("Escape");
    press("Escape");
    expect(stops).toHaveLength(2);
    stops[0]!.resolve(null);
    stops[1]!.resolve(null);
    await tick();
    expect(agentStops.isStopping(draftKey("mac-mini", "w1:p1"))).toBe(true);
    c.ui.unmount();
  });

  it("is not Stop with ⌘, ⌥, ⌃ or ⇧", () => {
    const c = chatBox();
    for (const keys of [{ metaKey: true }, { altKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      press("Escape", keys);
      press("Escape", keys, c.keyInBox);
    }
    expect(stops).toEqual([]);
    c.ui.unmount();
  });

  it("does nothing for an agent not working, or a machine offline", () => {
    const idle = chatBox({ host: hostOf("connected", topologyOf("idle")), row: rowOf("w1:p1", "idle") });
    press("Escape");
    idle.ui.unmount();
    const offline = chatBox({ host: hostOf("offline") });
    press("Escape");
    offline.ui.unmount();
    expect(stops).toEqual([]);
  });
});

describe("Esc while something on top owns it closes that thing and sends nothing", () => {
  it("the picture viewer", async () => {
    const c = chatBox();
    const viewer = new HookHost(PictureViewer as (p: object) => unknown, {});
    pictureViewer.open({ url: "blob:shot", name: "shot.png" });
    viewer.render();
    press("Escape");
    expect(pictureViewer.get()).toBeNull();
    expect(stops).toEqual([]);
    viewer.unmount();
    await tick();
    press("Escape");
    expect(stops).toHaveLength(1);
    c.ui.unmount();
  });

  it("the Model and Effort chips' menu", () => {
    const c = chatBox();
    const onClose = vi.fn();
    const menu = new HookHost(ChipMenu as (p: object) => unknown, { items: [], onPick: () => undefined, onClose });
    menu.render();
    press("Escape");
    press("Escape", {}, c.keyInBox);
    expect(onClose).toHaveBeenCalled();
    expect(stops).toEqual([]);
    menu.unmount();
    c.ui.unmount();
  });

  it("a context menu (Copy, Send to… in the conversation)", () => {
    const c = chatBox();
    const onClose = vi.fn();
    const menu = new HookHost(ContextMenu as (p: object) => unknown, { x: 10, y: 10, items: [{ label: "Copy", onSelect: () => undefined }], onClose });
    menu.render();
    press("Escape");
    expect(onClose).toHaveBeenCalled();
    expect(stops).toEqual([]);
    menu.unmount();
    c.ui.unmount();
  });

  it("the context ring's card", () => {
    const c = chatBox();
    const ring = new HookHost(ContextRing as (p: object) => unknown, { host: hostOf(), row: rowOf() });
    ring.render();
    const button = () => elements(ring.tree).find((e) => e.type === "button")!;
    (button().props["onClick"] as () => void)();
    expect(button().props["aria-expanded"]).toBe(true);
    press("Escape");
    expect(button().props["aria-expanded"]).toBe(false);
    expect(stops).toEqual([]);
    ring.unmount();
    c.ui.unmount();
  });

  it("a dialog", () => {
    const c = chatBox();
    const onCancel = vi.fn();
    const dialog = new HookHost(ConfirmClose as (p: object) => unknown, { name: "claude 2", onConfirm: () => undefined, onCancel });
    dialog.render();
    const box = elements(dialog.tree).find((e) => e.props["role"] === "alertdialog")!;
    active = box;
    press("Escape", {}, box.props["onKeyDown"] as (e: unknown) => void);
    active = body;
    press("Escape");
    expect(onCancel).toHaveBeenCalled();
    expect(stops).toEqual([]);
    dialog.unmount();
    c.ui.unmount();
  });

  it("the box over the terminal", () => {
    const c = chatBox({ compact: true, takesKeys: false });
    const onDismiss = vi.fn();
    const over = new HookHost(Composer as (p: object) => unknown, { host: hostOf(), row: rowOf(), overlay: true, onDismiss });
    over.render();
    const textarea = elements(over.tree).find((e) => e.type === "textarea")!;
    press("Escape", {}, textarea.props["onKeyDown"] as (e: unknown) => void);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(stops).toEqual([]);
    over.unmount();
    c.ui.unmount();
  });

  it("Send to… holds Esc while it is open", async () => {
    const { useEscapeOwner } = await import("../src/renderer/components/escape-owners");
    const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/renderer/handoff/HandoffPicker.tsx", import.meta.url), "utf8"));
    expect(source).toContain("useEscapeOwner(");
    expect(typeof useEscapeOwner).toBe("function");
    for (const file of ["../src/renderer/components/NewAgentDialog.tsx", "../src/renderer/components/AddHostDialog.tsx", "../src/renderer/App.tsx"]) {
      const text = await import("node:fs").then((fs) => fs.readFileSync(new URL(file, import.meta.url), "utf8"));
      expect(text, file).toContain("useEscapeOwner(");
    }
  });
});

describe("Terminal's Esc and the split's tiles", () => {
  const mainProps = (tab: "chat" | "terminal", boxShown = false) => ({
    host: hostOf(),
    row: rowOf(),
    tab,
    onTab: () => undefined,
    mac: true,
    fontSize: 13,
    boxShown,
    onBoxShown: () => undefined,
    ghostty: { shown: false, enabled: false, reason: "" },
    onOpenInGhostty: () => undefined,
  });
  const composers = (tree: unknown) => elements(tree).filter((e) => e.type === Composer);

  it("gives Chat's box Stop, and never the box over the terminal", () => {
    const chat = new HookHost(MainPane as (p: object) => unknown, mainProps("chat"));
    chat.render();
    expect(composers(chat.tree).map((e) => e.props["stops"])).toEqual([true]);
    const terminal = new HookHost(MainPane as (p: object) => unknown, mainProps("terminal", true));
    terminal.render();
    expect(composers(terminal.tree).map((e) => e.props["stops"] === true)).toEqual([false]);
  });

  it("stops only the focused tile's agent in a split of two working agents", () => {
    const host = hostOf("connected", topologyOf("working", ["w1:p1", "w1:p2"]));
    const left = chatBox({ host, row: rowOf("w1:p1"), compact: true, takesKeys: false });
    const right = chatBox({ host, row: rowOf("w1:p2"), compact: true, takesKeys: true });
    press("Escape");
    expect(stops.map((s) => s.paneId)).toEqual(["w1:p2"]);
    press("Escape", {}, left.keyInBox);
    expect(stops.map((s) => s.paneId)).toEqual(["w1:p2", "w1:p1"]);
    left.ui.unmount();
    right.ui.unmount();
  });
});

describe("the Working line", () => {
  const line = (host: HostView, row: SidebarRow) => {
    const view = new HookHost(ChatView as (p: object) => unknown, { host, row, onShowTerminal: () => undefined });
    view.render();
    const pill = elements(view.tree).find((e) => e.props["className"] === "working");
    const words = elements(pill).filter((e) => typeof e.props["children"] === "string").map((e) => e.props["children"]);
    view.unmount();
    return words;
  };

  it("says Esc to stop while Stop is possible", () => {
    const words = line(hostOf(), rowOf());
    expect(words[0]).toMatch(/^Working for /);
    expect(words).toContain("Esc to stop");
  });

  it("does not while the machine is offline", () => {
    expect(line(hostOf("offline"), rowOf())).not.toContain("Esc to stop");
  });
});

// An auto-repeat keydown is
// never Stop, in the window's listener and in the box's own handler; a held Esc
// that closed something on top goes on closing nothing and stopping nothing.
describe("a held Esc never stops", () => {
  it("an auto-repeat Esc in the conversation or in the box sends nothing", () => {
    const c = chatBox();
    const event = press("Escape", { repeat: true });
    press("Escape", { repeat: true }, c.keyInBox);
    expect(stops).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    c.ui.unmount();
  });

  it("holding Esc after it closed the chips' menu does not stop the agent", async () => {
    const c = chatBox();
    let menu: HookHost<object>;
    menu = new HookHost<object>(ChipMenu as (p: object) => unknown, { items: [], onPick: () => undefined, onClose: () => menu.unmount() });
    menu.render();
    press("Escape");
    expect(stops).toEqual([]);
    await tick();
    expect(escapeOwners.any()).toBe(false);
    press("Escape", { repeat: true });
    press("Escape", { repeat: true });
    expect(stops).toEqual([]);
    c.ui.unmount();
  });

  it("an auto-repeat after an earlier stop came back sends nothing more", async () => {
    const c = chatBox();
    press("Escape");
    stops[0]!.resolve(null);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    press("Escape", { repeat: true });
    press("Escape", { repeat: true }, c.keyInBox);
    expect(stops).toHaveLength(1);
    c.ui.unmount();
  });

  it("ignores an Esc ending a composition, in the box and in the window, and keeps the draft", async () => {
    const c = chatBox();
    c.type("keep this draft");
    press("Escape", { isComposing: true, nativeEvent: { isComposing: true } }, c.keyInBox);
    expect(stops).toEqual([]);
    const key = draftKey("mac-mini", "w1:p1");
    const before = composerDrafts.get(key);
    press("Escape", {}, c.keyInBox);
    expect(stops).toHaveLength(1);
    stops[0]!.resolve("Esc did not go: test");
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(composerDrafts.get(key)).toBe(before);
    expect(agentStops.isStopping(key)).toBe(false);
    c.ui.unmount();
  });

  it("a plain Esc that is not a repeat still stops", () => {
    const c = chatBox();
    press("Escape", { repeat: false });
    expect(stops).toHaveLength(1);
    c.ui.unmount();
  });
});

// One Escape per press, however fast the reply: each press is one Esc, as in
// the terminal, the square and Esc alike, whatever came back before.
describe("one Escape per press, every press", () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };

  it("two clicks of the square with the reply settling between them send two", async () => {
    const c = chatBox();
    c.click();
    stops[0]!.resolve(null);
    await flush();
    c.click();
    expect(stops).toHaveLength(2);
    c.ui.unmount();
  });

  it("the square then Esc sends two; a note left by the first does not hold the second", async () => {
    const c = chatBox();
    c.click();
    stops[0]!.resolve("Esc did not go: Herdr refused it (agent_not_found)");
    await flush();
    press("Escape");
    expect(stops).toHaveLength(2);
    c.ui.unmount();
  });

  it("is the pane's own: another tile's agent stops at once", async () => {
    const two = topologyOf("working", ["w1:p1", "w1:p2"]);
    const a = chatBox({ host: hostOf("connected", two), compact: true, takesKeys: true });
    a.click();
    stops[0]!.resolve(null);
    await flush();
    const b = chatBox({ host: hostOf("connected", two), row: rowOf("w1:p2"), compact: true, takesKeys: false });
    b.click();
    expect(stops.map((s) => s.paneId)).toEqual(["w1:p1", "w1:p2"]);
    a.ui.unmount();
    b.ui.unmount();
  });
});

// The ring's card gives Esc back
// when it goes. Its Escape ownership and key listener are bound to a card that
// is shown and pinned; the pane's agent replaced by a kind the ring does not
// read (its card gone, the ring still mounted) unpins it and lets go of Esc.
describe("the ring's card gives Esc back when it goes", () => {
  const grok = (): SessionTopology => {
    const topology = topologyOf();
    return { ...topology, panes: topology.panes.map((p) => ({ ...p, agent: "grok" })), agents: topology.agents.map((a) => ({ ...a, agent: "grok" })) };
  };

  it("a pinned card whose context goes releases Esc, and Esc then stops the Chat's agent", async () => {
    const c = chatBox();
    const ring = new HookHost<object>(ContextRing as (p: object) => unknown, { host: hostOf(), row: rowOf() });
    ring.render();
    (elements(ring.tree).find((e) => e.type === "button")!.props["onClick"] as () => void)();
    expect(escapeOwners.any()).toBe(true);
    ring.render({ host: hostOf("connected", grok()), row: { ...rowOf(), kind: "grok" } });
    expect(ring.tree).toBeNull();
    await tick();
    expect(escapeOwners.any()).toBe(false);
    expect(listeners.filter((l) => l.capture && l.type === "keydown")).toEqual([]);
    press("Escape");
    expect(stops).toHaveLength(1);
    ring.unmount();
    c.ui.unmount();
  });

  it("the context back, the card is not open again and does not hold Esc", async () => {
    const ring = new HookHost<object>(ContextRing as (p: object) => unknown, { host: hostOf(), row: rowOf() });
    ring.render();
    const button = () => elements(ring.tree).find((e) => e.type === "button")!;
    (button().props["onClick"] as () => void)();
    (elements(ring.tree).find((e) => e.props["className"] === "ctx-ring-w open")!.props["onMouseEnter"] as () => void)();
    ring.render({ host: hostOf("connected", grok()), row: { ...rowOf(), kind: "grok" } });
    ring.render({ host: hostOf(), row: rowOf() });
    await tick();
    expect(button().props["aria-expanded"]).toBe(false);
    expect(elements(ring.tree).some((e) => e.props["role"] === "dialog")).toBe(false);
    expect(escapeOwners.any()).toBe(false);
    ring.unmount();
  });
});
