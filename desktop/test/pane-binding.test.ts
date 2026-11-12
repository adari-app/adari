// Every pane mutation is bound to what the user saw. Close, zoom, split, a divider's resize and New agent's Where
// carry the pane as the window showed it (shared/pane-binding.ts: the
// machine's connection, workspace, tab, pane, terminal and agent; a divider's
// split and path). The main process checks it against the sender's own
// window and a snapshot and layout read right before the request, and
// refuses a changed or unverifiable binding with a plain reason, sending
// nothing. Through the real IPC handlers, HostRegistry and LayoutService,
// over LiveHerdr (a Herdr whose state changes behind the app's cache): a
// reused pane id, a moved split, a forged IPC close.

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, run: (...args: unknown[]) => unknown) => electron.handles.set(channel, run), on: () => undefined },
  protocol: {},
}));

import { defaultTree, setRatioAt } from "../src/main/demo/demo-layout";
import { HostRegistry } from "../src/main/hosts";
import { LayoutService, type LayoutOwner } from "../src/main/layouts";
import { runPaneAction } from "../src/main/pane-actions";
import { APP_ORIGIN } from "../src/main/protocol";
import { IPC, type LayoutUpdateEvent, type PaneAction } from "../src/shared/ipc-contract";
import { paneBindingOf, splitPathOf, splitShapeOf, type PaneBinding } from "../src/shared/pane-binding";
import type { PaneLayout } from "../src/shared/pane-layout";
import { eventually } from "./support/chat-lines";
import { LiveHerdr } from "./support/live-herdr";

const { registerIpc } = await import("../src/main/ipc");

const descriptor = { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "fixture", platform: null };

/** A window (its WebContents as the main process sees it) and the layouts it was sent. */
function window_(id: number): LayoutOwner & { readonly updates: LayoutUpdateEvent[] } {
  const updates: LayoutUpdateEvent[] = [];
  return { id, updates, send: (_channel, payload) => updates.push(payload), isDestroyed: () => false };
}

/**
 * One machine over LiveHerdr: tab w1:t1 holds p1 (Claude) and p2 (a shell),
 * tab w1:t2 holds p3 and p4. The window shows w1:p1's tab.
 */
async function machine() {
  const live = new LiveHerdr();
  live.addTab("w1:t1", ["w1:p1", "w1:p2"], { "w1:p1": "claude" });
  live.addTab("w1:t2", ["w1:p3", "w1:p4"]);
  const registry = new HostRegistry(() => undefined);
  registry.add(descriptor, live.backend());
  await registry.refreshAll();
  const layouts = new LayoutService(registry, "layout");
  const page = window_(10);
  layouts.watch(page, "mini", "w1:p1");
  await eventually(() => page.updates.at(-1)?.layout != null);
  registerIpc({ hosts: registry, layouts, chat: {}, terminals: {}, ghostty: {} } as never);
  const event = (sender: LayoutOwner = page) => ({ sender, senderFrame: { url: `${APP_ORIGIN}/` } });
  /** The layout the window was last sent. */
  const shown = (): PaneLayout => page.updates.at(-1)!.layout!;
  /** The binding the page takes for `paneId`: the machine as listed and the layout `layout` (the shown one by default). */
  const bind = (paneId: string, layout: PaneLayout = shown()): PaneBinding => paneBindingOf(registry.list()[0]!, layout, paneId)!;
  const act = (action: unknown, sender?: LayoutOwner) => electron.handles.get(IPC.paneAction)!(event(sender), "mini", action) as Promise<unknown>;
  const where = (paneId: string, binding: PaneBinding | undefined, sender?: LayoutOwner) =>
    electron.handles.get(IPC.newAgent)!(event(sender), "mini", {
      workspaceId: "w1",
      folder: null,
      kind: "shell",
      where: { type: "split", direction: "down", targetPaneId: paneId, ...(binding === undefined ? {} : { binding }) },
    }) as Promise<unknown>;
  return { live, registry, layouts, page, shown, bind, act, where };
}

/** Herdr restarted: the same pane ids in a new tab, new terminals, no agent (a reused pane id). */
function restart(live: LiveHerdr): void {
  live.tabs.delete("w1:t1");
  live.addTab("w1:t9", ["w1:p1", "w1:p2"]);
  live.panes.get("w1:p1")!.terminal = "term-after-restart";
}

beforeEach(() => electron.handles.clear());

describe("a pane action is bound to the pane as the window showed it", () => {
  it("goes through while the binding holds: zoom, unzoom, resize, split, close (each checked on fresh state)", async () => {
    const m = await machine();
    await m.act({ type: "zoom", paneId: "w1:p1", zoomed: true, binding: m.bind("w1:p1") });
    await m.act({ type: "zoom", paneId: "w1:p1", zoomed: false, binding: m.bind("w1:p1") });
    await m.act({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path: splitPathOf(m.shown(), "split_0_root"), shape: splitShapeOf(m.shown(), "split_0_root"), ratio: 0.6, binding: m.bind("w1:p1") });
    await m.act({ type: "split", paneId: "w1:p2", direction: "down", binding: m.bind("w1:p2") });
    await eventually(() => m.shown().panes.length === 3);
    await m.act({ type: "close", paneId: "w1:p2", binding: m.bind("w1:p2") });
    expect(m.live.mutations()).toEqual(["pane.zoom", "pane.zoom", "layout.set_split_ratio", "pane.split", "pane.close"]);
  });

  it("a forged IPC for a pane the sender does not show is refused, nothing sent", async () => {
    const m = await machine();
    // A well-formed binding for w1:p3, a listed pane of another tab, from Herdr's own layout of it.
    const other = await m.live.client.paneLayout("w1:p3");
    const binding = m.bind("w1:p3", other);
    await expect(m.act({ type: "close", paneId: "w1:p3", binding })).rejects.toThrow("That pane is not shown in this window.");
    await expect(m.act({ type: "zoom", paneId: "w1:p3", zoomed: true, binding })).rejects.toThrow("That pane is not shown in this window.");
    await expect(m.where("w1:p3", binding)).rejects.toThrow("That pane is not shown in this window.");
    // Another window that shows nothing cannot act on w1:p1 either.
    await expect(m.act({ type: "close", paneId: "w1:p1", binding: m.bind("w1:p1") }, window_(11))).rejects.toThrow("That pane is not shown in this window.");
    expect(m.live.mutations()).toEqual([]);
  });

  it("an action without a binding, or bound to another pane, is a bad request", async () => {
    const m = await machine();
    expect(() => m.act({ type: "close", paneId: "w1:p1" })).toThrow("bad request");
    expect(() => m.act({ type: "close", paneId: "w1:p2", binding: m.bind("w1:p1") })).toThrow("bad request");
    expect(() => m.act({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", ratio: 0.6, binding: m.bind("w1:p1") })).toThrow("bad request");
    await expect(m.where("w1:p1", undefined)).rejects.toThrow("bad request");
    expect(m.live.mutations()).toEqual([]);
  });

  it("close and zoom on a reused pane id after Herdr restarted are refused, nothing sent", async () => {
    const m = await machine();
    const binding = m.bind("w1:p1");
    restart(m.live);
    await expect(m.act({ type: "close", paneId: "w1:p1", binding })).rejects.toThrow("That pane is in another tab now.");
    await expect(m.act({ type: "zoom", paneId: "w1:p1", zoomed: true, binding })).rejects.toThrow("That pane is in another tab now.");
    expect(m.live.mutations()).toEqual([]);
  });

  it("a resize of split_0_root after its pane moved to another tab is refused, nothing set", async () => {
    const m = await machine();
    const binding = m.bind("w1:p1");
    const path = splitPathOf(m.shown(), "split_0_root");
    const shape = splitShapeOf(m.shown(), "split_0_root");
    restart(m.live);
    await expect(m.act({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path, shape, ratio: 0.6, binding })).rejects.toThrow("That pane is in another tab now.");
    expect(m.live.mutations()).toEqual([]);
  });

  it("another terminal, another agent or another session in the pane now: refused with what changed", async () => {
    const m = await machine();
    const binding = m.bind("w1:p1");
    m.live.panes.get("w1:p1")!.session = "session-another";
    await expect(m.act({ type: "close", paneId: "w1:p1", binding })).rejects.toThrow("That pane runs another claude session now.");
    m.live.panes.get("w1:p1")!.agent = "codex";
    await expect(m.act({ type: "close", paneId: "w1:p1", binding })).rejects.toThrow("That pane runs codex now, not claude.");
    m.live.panes.get("w1:p1")!.agent = null;
    await expect(m.act({ type: "close", paneId: "w1:p1", binding })).rejects.toThrow("The claude agent in that pane has left.");
    m.live.panes.get("w1:p1")!.terminal = "term-other";
    await expect(m.act({ type: "zoom", paneId: "w1:p1", zoomed: true, binding })).rejects.toThrow("That pane runs another terminal now.");
    expect(m.live.mutations()).toEqual([]);
  });

  it("a known session no longer reported is refused: the pane still lists claude in the same terminal", async () => {
    const m = await machine();
    const binding = m.bind("w1:p1");
    expect(binding.session).toBe("session-w1:p1");
    // The fresh snapshot keeps the pane, its terminal, tab and claude, but reports no session for it.
    m.live.panes.get("w1:p1")!.session = null;
    await expect(m.act({ type: "close", paneId: "w1:p1", binding })).rejects.toThrow(
      "That pane's claude session is no longer reported, so it could not be checked.",
    );
    await expect(m.act({ type: "zoom", paneId: "w1:p1", zoomed: true, binding })).rejects.toThrow("no longer reported");
    expect(m.live.mutations()).toEqual([]);
  });

  it("a binding whose snapshot never had a session keeps the rule it had: a session reported later is not compared", async () => {
    const m = await machine();
    m.live.panes.get("w1:p1")!.session = null;
    await m.registry.refresh("mini");
    const binding = m.bind("w1:p1");
    expect(binding.session).toBeNull();
    m.live.panes.get("w1:p1")!.session = "session-reported-later";
    await m.act({ type: "zoom", paneId: "w1:p1", zoomed: true, binding });
    expect(m.live.mutations()).toEqual(["pane.zoom"]);
  });

  it("the machine reconnected since the pane was shown: refused; not answering: refused, nothing sent", async () => {
    const m = await machine();
    const binding = m.bind("w1:p1");
    m.live.offline = true;
    await expect(m.act({ type: "zoom", paneId: "w1:p1", zoomed: true, binding })).rejects.toThrow("The machine did not answer, so the pane could not be checked.");
    m.live.offline = false;
    await expect(m.act({ type: "zoom", paneId: "w1:p1", zoomed: true, binding })).rejects.toThrow("The machine reconnected since the pane was shown.");
    expect(m.live.mutations()).toEqual([]);
    // Bound again on the new connection, it goes.
    await m.act({ type: "zoom", paneId: "w1:p1", zoomed: true, binding: m.bind("w1:p1") });
    expect(m.live.mutations()).toEqual(["pane.zoom"]);
  });

  it("a divider whose split now holds other panes in Herdr's tree is refused, nothing set", async () => {
    const m = await machine();
    // Four panes in the shown tab: two columns, each split down (split_1_0 holds p1 over p2).
    m.live.splitBehind("w1:t1", "w1:p2", "w1:p5");
    m.live.tabs.get("w1:t1")!.layout = { root: defaultTree(["w1:p1", "w1:p2", "w1:p5", "w1:p6"]), zoomed: false, focused: "w1:p1" };
    m.live.panes.set("w1:p6", { terminal: "term-w1:p6", agent: null, session: null });
    await m.registry.refresh("mini");
    m.layouts.refresh();
    await eventually(() => m.shown().panes.length === 4);
    const binding = m.bind("w1:p1");
    const path = splitPathOf(m.shown(), "split_1_0");
    expect(path).toEqual([false]);
    // Herdr's tree changes: split_1_0 (the first column) now holds p2 and p5; p1 is in the second column.
    m.live.tabs.get("w1:t1")!.layout = { root: defaultTree(["w1:p2", "w1:p5", "w1:p1", "w1:p6"]), zoomed: false, focused: "w1:p1" };
    const shape = splitShapeOf(m.shown(), "split_1_0");
    await expect(m.act({ type: "resize", paneId: "w1:p1", splitId: "split_1_0", path, shape, ratio: 0.3, binding })).rejects.toThrow(
      "Herdr's layout no longer has that divider where it was shown.",
    );
    expect(m.live.mutations()).toEqual([]);
  });

  /** The shown tab with four panes: two columns, each split down; `order` fills them as Herdr's defaultTree does (split_1_0 holds the first two). */
  async function fourPanes(m: Awaited<ReturnType<typeof machine>>) {
    m.live.splitBehind("w1:t1", "w1:p2", "w1:p5");
    m.live.panes.set("w1:p6", { terminal: "term-w1:p6", agent: null, session: null });
    m.live.tabs.get("w1:t1")!.layout = { root: defaultTree(["w1:p1", "w1:p2", "w1:p5", "w1:p6"]), zoomed: false, focused: "w1:p1" };
    await m.registry.refresh("mini");
    m.layouts.refresh();
    await eventually(() => m.shown().panes.length === 4);
    const binding = m.bind("w1:p1");
    const path = splitPathOf(m.shown(), "split_1_0");
    const shape = splitShapeOf(m.shown(), "split_1_0");
    expect(path).toEqual([false]);
    const rearrange = (order: readonly string[]) => (m.live.tabs.get("w1:t1")!.layout = { root: defaultTree(order), zoomed: false, focused: "w1:p1" });
    const resize = (ratio: number) => ({ type: "resize", paneId: "w1:p1", splitId: "split_1_0", path, shape, ratio, binding });
    return { binding, path, shape, rearrange, resize };
  }

  it("a divider whose opposite side was exchanged, its anchor, split id and path kept, is refused in main, nothing set", async () => {
    const m = await machine();
    const d = await fourPanes(m);
    // Before the action's fresh read, Herdr's tree changes: p6 is opposite p1 in split_1_0 now; p1 still first, same id, same path.
    d.rearrange(["w1:p1", "w1:p6", "w1:p5", "w1:p2"]);
    expect(splitPathOf(await m.live.client.paneLayout("w1:p1"), "split_1_0")).toEqual(d.path);
    await expect(m.act(d.resize(0.6))).rejects.toThrow("Herdr's layout no longer has that divider where it was shown.");
    // Sent as split, path and ratio with no shape, straight to the main process's action: refused too.
    await expect(
      runPaneAction(m.registry, m.layouts, m.page, "mini", { type: "resize", paneId: "w1:p1", splitId: "split_1_0", path: d.path, ratio: 0.6, binding: d.binding } as unknown as PaneAction),
    ).rejects.toThrow("Herdr's layout no longer has that divider where it was shown.");
    expect(m.live.mutations()).toEqual([]);
  });

  it("a divider the sender's window was since shown arranged otherwise is refused, though Herdr's tree is back as dragged", async () => {
    const m = await machine();
    const d = await fourPanes(m);
    d.rearrange(["w1:p1", "w1:p6", "w1:p5", "w1:p2"]);
    m.layouts.refresh();
    await eventually(() => splitShapeOf(m.shown(), "split_1_0") !== d.shape);
    d.rearrange(["w1:p1", "w1:p2", "w1:p5", "w1:p6"]);
    await expect(m.act(d.resize(0.6))).rejects.toThrow("Herdr's layout no longer has that divider where it was shown.");
    expect(m.live.mutations()).toEqual([]);
  });

  it("the same divider with another ratio (Herdr's or another client's) still goes: ratios are not its identity", async () => {
    const m = await machine();
    const d = await fourPanes(m);
    const tab = m.live.tabs.get("w1:t1")!;
    tab.layout = { ...tab.layout, root: setRatioAt(tab.layout.root, [false], 0.3)! };
    await m.act(d.resize(0.6));
    expect(m.live.mutations()).toEqual(["layout.set_split_ratio"]);
  });

  it("New agent's Where is bound to its pane: a changed pane refuses before pane.split", async () => {
    const m = await machine();
    const binding = m.bind("w1:p2");
    m.live.panes.get("w1:p2")!.terminal = "term-replaced";
    await expect(m.where("w1:p2", binding)).rejects.toThrow("That pane runs another terminal now.");
    expect(m.live.mutations()).toEqual([]);
    // As shown now, it splits.
    await m.registry.refresh("mini");
    await m.where("w1:p2", m.bind("w1:p2"));
    expect(m.live.mutations()).toEqual(["pane.split"]);
  });
});
