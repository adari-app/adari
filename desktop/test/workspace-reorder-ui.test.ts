// The sidebar's workspaces moved by hand, wired.
//
// The real Sidebar on the hooks host, its workspace headers pressed and the
// window's pointer events sent as the page sends them (a fake window, list and
// body): a drag past two workspaces lands where its line showed, a short press
// is still a click, Esc cancels, the list scrolls near its edges, and nothing
// drags while searching.
//
// The window (App) over a fake bridge: the header menu's Move up and Move
// down (greyed at either end and while searching), the order kept in the page's
// storage and read back by the next launch, a second machine untouched, and
// ⇧⌘J walking in the new order. Nothing is sent to Herdr.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

import { buildDesktopSidebar, dropWorkspace, workspaceMoveTexts } from "../src/shared/desktop-sidebar";
import { emptyFoldState, type SidebarFoldState } from "../src/shared/sidebar-model";
import type { HostView } from "../src/shared/ipc-contract";
import { HookHost, elements } from "./support/fake-hooks";
import { MemoryStorage, page, settle } from "./support/manage-page";
import { reorderMachine } from "./support/reorder-hosts";
import { nowUnixMs } from "./support/sidebar-fixture";

const { Sidebar } = await import("../src/renderer/components/Sidebar");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { workspaceDragDistance } = await import("../src/renderer/components/workspace-drag");
type SidebarProps = Parameters<typeof Sidebar>[0];
type El = { type: unknown; props: Record<string, unknown> };

const none = (): void => undefined;
const four = reorderMachine("host", [
  ["w1", 1],
  ["w2", 2],
  ["w3", 3],
  ["w4", 4],
]);

/** Each section is 40 px tall with 8 px between them, the first at y 100 (less the list's scroll). */
const sectionTop = (index: number): number => 100 + index * 48;

/** The page under the sidebar: its window listeners, the list (its edges, scroll and sections as drawn) and the body. */
function fakePage(edges = { top: 0, bottom: 800 }) {
  const listeners: { type: string; listener: (event: unknown) => void }[] = [];
  const frames = new Map<number, () => void>();
  let next = 1;
  let scrollTop = 0;
  const scrolls: number[] = [];
  const body: Record<string, string> = {};
  let tree: () => unknown = () => null;
  const sections = (): El[] => (elements(tree()) as El[]).filter((element) => typeof element.props["data-ws-section"] === "string");
  const list = {
    getBoundingClientRect: () => edges,
    scrollBy: ({ top }: { top: number }) => {
      scrollTop += top;
      scrolls.push(top);
    },
    querySelectorAll: (selector: string) => {
      expect(selector).toBe('[data-host="host"] [data-ws-section]');
      return sections().map((section, index) => ({
        getAttribute: (name: string) => (name === "data-ws-section" ? (section.props["data-ws-section"] as string) : null),
        getBoundingClientRect: () => ({ top: sectionTop(index) - scrollTop, bottom: sectionTop(index) + 40 - scrollTop }),
      }));
    },
  };
  vi.stubGlobal("window", {
    innerWidth: 1440,
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.push({ type, listener }),
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      const at = listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
      if (at >= 0) listeners.splice(at, 1);
    },
  });
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    const id = next++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("document", {
    querySelector: (selector: string) => (selector === ".sb-list" ? list : null),
    body: {
      style: {
        removeProperty: (name: string) => delete body[name],
        set cursor(value: string) {
          body["cursor"] = value;
        },
        set userSelect(value: string) {
          body["user-select"] = value;
        },
      },
    },
  });
  const fire = (type: string, event: unknown): void => {
    for (const entry of listeners.filter((one) => one.type === type)) entry.listener(event);
  };
  return {
    body,
    scrolls,
    /** Frames queued now, and every listener on the window. */
    queued: () => frames.size,
    listenerCount: () => listeners.length,
    lost: () => fire("lostpointercapture", { button: 0, pointerId: 1, clientX: 60, clientY: 0 }),
    listening: (type: string) => listeners.some((entry) => entry.type === type),
    attach: (view: HookHost<SidebarProps>) => (tree = () => view.tree),
    frames: () => {
      const due = [...frames.values()];
      frames.clear();
      for (const frame of due) frame();
    },
    pointer: (type: "pointermove" | "pointerup" | "pointercancel", clientY: number, clientX = 60, buttons?: number) =>
      fire(type, { button: 0, pointerId: 1, clientX, clientY, ...(buttons === undefined ? {} : { buttons }) }),
    key: (key: string) => {
      const taken = { prevented: false, stopped: false };
      fire("keydown", { key, preventDefault: () => (taken.prevented = true), stopPropagation: () => (taken.stopped = true) });
      return taken;
    },
    blur: () => fire("blur", {}),
  };
}

/** The sidebar over `host` with `state`, its moves applied to that state as App applies them. */
function mount(dom: ReturnType<typeof fakePage>, options: { search?: string; host?: HostView } = {}) {
  let host: HostView | null = options.host ?? four;
  let foldedHosts = new Set<string>();
  let state: SidebarFoldState = emptyFoldState;
  const writes: SidebarFoldState[] = [];
  const moves: [string, string, string | null][] = [];
  const toggles: string[] = [];
  const props = (): SidebarProps => ({
    sidebar: buildDesktopSidebar(host === null ? [] : [host], { fold: state, search: options.search ?? "", nowUnixMs }),
    selectedKey: null,
    search: options.search ?? null,
    demo: false,
    foldedHosts,
    onSelect: none,
    onRowMenu: none,
    onToggleHost: none,
    onHostMenu: none,
    onRetryHost: none,
    onMode: none,
    onToggleWorkspace: (_hostId, workspaceId) => toggles.push(workspaceId),
    onToggleExpanded: none,
    onToggleSection: none,
    onSearch: none,
    onAddHost: none,
    onNewAgent: none,
    onWorkspaceMenu: none,
    onMoveWorkspace: (hostId, workspaceId, before) => {
      moves.push([hostId, workspaceId, before]);
      const next = dropWorkspace(state, host ?? undefined, workspaceId, before, nowUnixMs);
      if (next !== state) writes.push(next);
      state = next;
      view.render(props());
    },
  });
  const view = new HookHost<SidebarProps>(Sidebar, props());
  dom.attach(view);
  view.render();
  const all = (): El[] => elements(view.tree) as El[];
  const header = (workspaceId: string): El =>
    all().find((element) => (element.props["className"] === "ws-h" || element.props["className"] === "ws-h dim") && element.props["title"] === `label ${workspaceId}`)!;
  return {
    view,
    moves,
    toggles,
    /** Every changed order saved by a move. */
    writes,
    /** The machine as a new snapshot gives it (null: gone from the list). */
    updateHost: (next: HostView | null) => {
      host = next;
      view.render(props());
    },
    /** The machine folded to its header. */
    foldHost: (folded: boolean) => {
      foldedHosts = folded && host !== null ? new Set([host.id]) : new Set();
      view.render(props());
    },
    /** The sections top to bottom: id and drag classes. */
    sections: () => all().filter((element) => typeof element.props["data-ws-section"] === "string").map((element) => `${element.props["data-ws-section"] as string}:${element.props["className"] as string}`),
    order: () => all().filter((element) => typeof element.props["data-ws-section"] === "string").map((element) => element.props["data-ws-section"] as string),
    press: (workspaceId: string, clientY: number, clientX = 60, currentTarget?: unknown) =>
      (header(workspaceId).props["onPointerDown"] as (event: unknown) => void)({ button: 0, pointerId: 1, clientX, clientY, ...(currentTarget === undefined ? {} : { currentTarget }) }),
    click: (workspaceId: string) => (header(workspaceId).props["onClick"] as () => void)(),
  };
}

beforeEach(() => {
  escapeOwners.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a workspace header dragged", () => {
  it("past two workspaces: its line shows before the third, and it lands there when let go", async () => {
    const dom = fakePage();
    const sidebar = mount(dom);
    expect(sidebar.order()).toEqual(["w1", "w2", "w3", "w4"]);
    sidebar.press("w1", 120);
    dom.pointer("pointermove", 120 + workspaceDragDistance - 3);
    // Under the activation distance: nothing drags yet.
    expect(sidebar.sections()).toEqual(["w1:ws", "w2:ws", "w3:ws", "w4:ws"]);
    expect(escapeOwners.any()).toBe(false);
    dom.pointer("pointermove", 200);
    expect(sidebar.sections()).toEqual(["w1:ws dragging", "w2:ws", "w3:ws drop-before", "w4:ws"]);
    expect(dom.body["cursor"]).toBe("grabbing");
    expect(escapeOwners.any()).toBe(true);
    // Past research's middle: the line moves above the fourth.
    dom.pointer("pointermove", 230);
    expect(sidebar.sections()).toEqual(["w1:ws dragging", "w2:ws", "w3:ws", "w4:ws drop-before"]);
    dom.pointer("pointerup", 230);
    expect(sidebar.moves).toEqual([["host", "w1", "w4"]]);
    expect(sidebar.order()).toEqual(["w2", "w3", "w1", "w4"]);
    expect(sidebar.sections()).toEqual(["w2:ws", "w3:ws", "w1:ws", "w4:ws"]);
    expect(dom.body["cursor"]).toBeUndefined();
    // The click the release sends neither folds nor opens it.
    sidebar.click("w1");
    expect(sidebar.toggles).toEqual([]);
    expect(dom.listening("pointermove")).toBe(false);
    await settle();
    sidebar.click("w1");
    expect(sidebar.toggles).toEqual(["w1"]);
    sidebar.view.unmount();
  });

  it("below the last one: the line under it, and it goes last", () => {
    const dom = fakePage();
    const sidebar = mount(dom);
    sidebar.press("w2", 170);
    dom.pointer("pointermove", 400);
    expect(sidebar.sections()).toEqual(["w1:ws", "w2:ws dragging", "w3:ws", "w4:ws drop-after"]);
    dom.pointer("pointerup", 400);
    expect(sidebar.moves).toEqual([["host", "w2", null]]);
    expect(sidebar.order()).toEqual(["w1", "w3", "w4", "w2"]);
    sidebar.view.unmount();
  });

  it("let go where it was (the line just above or below itself): nothing moves", () => {
    const dom = fakePage();
    const sidebar = mount(dom);
    sidebar.press("w2", 160);
    dom.pointer("pointermove", 175);
    expect(sidebar.sections()).toEqual(["w1:ws", "w2:ws dragging", "w3:ws drop-before", "w4:ws"]);
    dom.pointer("pointermove", 150);
    expect(sidebar.sections()).toEqual(["w1:ws", "w2:ws dragging drop-before", "w3:ws", "w4:ws"]);
    dom.pointer("pointerup", 150);
    expect(sidebar.moves).toEqual([["host", "w2", "w2"]]);
    expect(sidebar.order()).toEqual(["w1", "w2", "w3", "w4"]);
    sidebar.view.unmount();
  });

  it("a short press is still a click: it folds the workspace and nothing moves", () => {
    const dom = fakePage();
    const sidebar = mount(dom);
    sidebar.press("w3", 220);
    dom.pointer("pointermove", 222, 62);
    dom.pointer("pointerup", 222, 62);
    sidebar.click("w3");
    expect(sidebar.toggles).toEqual(["w3"]);
    expect(sidebar.moves).toEqual([]);
    expect(dom.listening("pointermove")).toBe(false);
    sidebar.view.unmount();
  });

  it("Esc cancels: the line goes, nothing moves, Esc is the drag's own, and the release does not fold it", async () => {
    const dom = fakePage();
    const sidebar = mount(dom);
    sidebar.press("w1", 120);
    dom.pointer("pointermove", 230);
    expect(sidebar.sections()).toContain("w4:ws drop-before");
    expect(dom.key("Escape")).toEqual({ prevented: true, stopped: true });
    expect(sidebar.sections()).toEqual(["w1:ws", "w2:ws", "w3:ws", "w4:ws"]);
    expect(dom.body["cursor"]).toBeUndefined();
    // Still pressed: moving draws nothing again; letting go moves nothing.
    dom.pointer("pointermove", 300);
    expect(sidebar.sections()).toEqual(["w1:ws", "w2:ws", "w3:ws", "w4:ws"]);
    dom.pointer("pointerup", 300);
    sidebar.click("w1");
    expect(sidebar.moves).toEqual([]);
    expect(sidebar.toggles).toEqual([]);
    expect(sidebar.order()).toEqual(["w1", "w2", "w3", "w4"]);
    // Esc stays the drag's for a task after (Stop does not see it), then is free.
    expect(escapeOwners.any()).toBe(true);
    await settle();
    expect(escapeOwners.any()).toBe(false);
    // Another key during a drag is not taken.
    sidebar.press("w1", 120);
    dom.pointer("pointermove", 230);
    expect(dom.key("a")).toEqual({ prevented: false, stopped: false });
    dom.blur();
    expect(sidebar.sections()).toEqual(["w1:ws", "w2:ws", "w3:ws", "w4:ws"]);
    expect(sidebar.moves).toEqual([]);
    sidebar.view.unmount();
  });

  it("scrolls the list while the pointer is near its top or bottom edge", () => {
    const dom = fakePage({ top: 90, bottom: 300 });
    const sidebar = mount(dom);
    sidebar.press("w2", 170);
    dom.pointer("pointermove", 292);
    dom.frames();
    dom.frames();
    expect(dom.scrolls.length).toBeGreaterThanOrEqual(2);
    expect(dom.scrolls.every((dy) => dy > 0)).toBe(true);
    dom.pointer("pointermove", 92);
    dom.scrolls.length = 0;
    dom.frames();
    dom.frames();
    expect(dom.scrolls.length).toBeGreaterThanOrEqual(1);
    expect(dom.scrolls.every((dy) => dy < 0)).toBe(true);
    // Away from the edges it stops.
    dom.pointer("pointermove", 200);
    dom.frames();
    dom.scrolls.length = 0;
    dom.frames();
    expect(dom.scrolls).toEqual([]);
    dom.pointer("pointercancel", 200);
    expect(sidebar.moves).toEqual([]);
    sidebar.view.unmount();
  });

  it("is off while searching (the list is filtered): a press and a move draw nothing and move nothing", () => {
    const dom = fakePage();
    const sidebar = mount(dom, { search: "label" });
    expect(sidebar.order()).toEqual(["w1", "w2", "w3", "w4"]);
    sidebar.press("w1", 120);
    dom.pointer("pointermove", 300);
    expect(sidebar.sections()).toEqual(["w1:ws", "w2:ws", "w3:ws", "w4:ws"]);
    expect(dom.listening("pointermove")).toBe(false);
    dom.pointer("pointerup", 300);
    expect(sidebar.moves).toEqual([]);
    sidebar.click("w1");
    expect(sidebar.toggles).toEqual(["w1"]);
    sidebar.view.unmount();
  });
});

describe("fix1: a drag ends when what it drags goes away, or when the button is no longer held", () => {
  /** Nothing left of a drag: no cursor, class, line, listener, frame or Esc hold, and nothing saved. */
  const nothingLeft = (dom: ReturnType<typeof fakePage>, sidebar: ReturnType<typeof mount>): void => {
    expect(dom.body["cursor"]).toBeUndefined();
    expect(dom.body["user-select"]).toBeUndefined();
    expect(sidebar.sections().every((section) => section.endsWith(":ws"))).toBe(true);
    expect(dom.queued()).toBe(0);
    expect(dom.listening("pointermove")).toBe(false);
    expect(dom.listening("pointerup")).toBe(false);
    expect(dom.listening("keydown")).toBe(false);
    expect(dom.listening("blur")).toBe(false);
    expect(sidebar.moves).toEqual([]);
    expect(sidebar.writes).toEqual([]);
  };

  const changes = {
    "the dragged workspace is removed": (sidebar: ReturnType<typeof mount>) =>
      sidebar.updateHost(reorderMachine("host", [["w2", 2], ["w3", 3], ["w4", 4]])),
    "its machine is removed": (sidebar: ReturnType<typeof mount>) => sidebar.updateHost(null),
    "its machine loses its snapshot (a disconnect)": (sidebar: ReturnType<typeof mount>) => sidebar.updateHost({ ...four, state: "offline", topology: null }),
    "its machine is folded to its header": (sidebar: ReturnType<typeof mount>) => sidebar.foldHost(true),
  } as const;

  for (const [what, change] of Object.entries(changes)) {
    it(`mid-drag, ${what}: the drag is cancelled at once and nothing is left`, async () => {
      const dom = fakePage({ top: 90, bottom: 300 });
      const sidebar = mount(dom);
      const listenersBefore = dom.listenerCount();
      sidebar.press("w1", 120);
      dom.pointer("pointermove", 292);
      expect(dom.body["cursor"]).toBe("grabbing");
      expect(dom.queued()).toBe(1);
      expect(escapeOwners.any()).toBe(true);
      change(sidebar);
      nothingLeft(dom, sidebar);
      expect(dom.listenerCount()).toBe(listenersBefore);
      dom.frames();
      expect(dom.scrolls).toEqual([]);
      // The release that follows moves nothing and is nobody's.
      dom.pointer("pointerup", 292);
      expect(sidebar.moves).toEqual([]);
      await settle();
      expect(escapeOwners.any()).toBe(false);
      // No click is swallowed: the next one on a header still shown does what it does.
      if (sidebar.order().includes("w2")) {
        sidebar.click("w2");
        expect(sidebar.toggles).toEqual(["w2"]);
      }
      sidebar.view.unmount();
    });
  }

  it("the source is checked again when the boxes are refreshed (a scroll frame finds it gone)", () => {
    const dom = fakePage({ top: 90, bottom: 300 });
    const sidebar = mount(dom);
    sidebar.press("w1", 120);
    dom.pointer("pointermove", 292);
    // The list drawn without w1 before the sidebar's own check runs: the frame's refresh finds it gone.
    const all = sidebar.view.tree;
    sidebar.view.tree = { type: "aside", props: { children: elements(all).filter((element) => element.props["data-ws-section"] !== "w1" && element.props["data-ws-section"] !== undefined) } };
    dom.frames();
    expect(dom.body["cursor"]).toBeUndefined();
    expect(dom.queued()).toBe(0);
    expect(dom.listening("pointermove")).toBe(false);
    expect(escapeOwners.any()).toBe(true);
    expect(sidebar.moves).toEqual([]);
    sidebar.view.tree = all;
    sidebar.view.unmount();
  });

  it("a move showing the button is no longer held (a release the window never heard of) ends it, nothing moves", () => {
    const dom = fakePage({ top: 90, bottom: 300 });
    const sidebar = mount(dom);
    sidebar.press("w1", 120);
    dom.pointer("pointermove", 230, 60, 1);
    expect(sidebar.sections()).toContain("w4:ws drop-before");
    dom.pointer("pointermove", 292, 60, 1);
    expect(dom.queued()).toBe(1);
    dom.pointer("pointermove", 292, 60, 0);
    nothingLeft(dom, sidebar);
    dom.frames();
    expect(dom.scrolls).toEqual([]);
    // No click is swallowed after it.
    sidebar.click("w2");
    expect(sidebar.toggles).toEqual(["w2"]);
    sidebar.view.unmount();
  });

  it("an active drag captures the pointer to its header and a lost capture cancels; a short press captures nothing and is still a click", () => {
    const dom = fakePage();
    const sidebar = mount(dom);
    const captured = new Set<number>();
    const header = {
      setPointerCapture: (id: number) => captured.add(id),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    };
    sidebar.press("w3", 220, 60, header);
    dom.pointer("pointermove", 223, 61, 1);
    expect(captured.size).toBe(0);
    dom.pointer("pointerup", 223, 61);
    sidebar.click("w3");
    expect(sidebar.toggles).toEqual(["w3"]);

    sidebar.press("w1", 120, 60, header);
    dom.pointer("pointermove", 230, 60, 1);
    expect(captured.has(1)).toBe(true);
    // The system takes the capture (the browser drops it, then sends lostpointercapture).
    captured.delete(1);
    dom.lost();
    nothingLeft(dom, sidebar);
    expect(escapeOwners.any()).toBe(true);

    // A drag let go normally gives its capture back.
    sidebar.press("w1", 120, 60, header);
    dom.pointer("pointermove", 230, 60, 1);
    dom.pointer("pointerup", 230);
    expect(captured.size).toBe(0);
    expect(sidebar.order()).toEqual(["w2", "w3", "w1", "w4"]);
    sidebar.view.unmount();
  });
});

describe("the window: Move up, Move down and the kept order", () => {
  let cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const run of cleanups.splice(0)) run();
  });
  const open = async (options: Parameters<typeof page>[0]) => {
    const p = await page(options);
    cleanups.push(p.unmount);
    return p;
  };
  type Page = Awaited<ReturnType<typeof open>>;
  const order = (p: Page, hostId: string): string[] => {
    const sidebar = p.sidebar()["sidebar"] as ReturnType<typeof buildDesktopSidebar>;
    return sidebar.hosts.find((section) => section.host.id === hostId)!.model!.projects.map((section) => section.header.workspaceID);
  };
  const reason = (p: Page, label: string): string | null | undefined => p.menu()?.find((item) => item.label === label)?.disabledReason;
  const mini = reorderMachine("mini", [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  const studio = reorderMachine("studio", [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);

  it("the header's menu has Move up and Move down after its other items, greyed at either end", async () => {
    const p = await open({ hosts: [mini] });
    p.workspaceMenu("a", "mini");
    expect(p.menu()!.map((item) => item.label)).toEqual(["New agent here", "Rename workspace…", "Move up", "Move down"]);
    expect(reason(p, "Move up")).toBe(workspaceMoveTexts.top);
    expect(reason(p, "Move down")).toBeNull();
    p.workspaceMenu("c", "mini");
    expect(reason(p, "Move up")).toBeNull();
    expect(reason(p, "Move down")).toBe(workspaceMoveTexts.bottom);
    p.workspaceMenu("b", "mini");
    expect(reason(p, "Move up")).toBeNull();
    expect(reason(p, "Move down")).toBeNull();
  });

  it("Move down and Move up move one place, kept on this Mac per machine and read back by the next launch; nothing goes to Herdr", async () => {
    const storage = new MemoryStorage();
    const p = await open({ hosts: [mini, studio], storage });
    p.workspaceMenu("a", "mini");
    p.pick("Move down");
    expect(order(p, "mini")).toEqual(["b", "a", "c"]);
    p.workspaceMenu("c", "mini");
    p.pick("Move up");
    expect(order(p, "mini")).toEqual(["b", "c", "a"]);
    expect(order(p, "studio")).toEqual(["a", "b", "c"]);
    expect(p.actions).toEqual([]);
    expect(p.calls).toEqual([]);
    const kept = JSON.parse(storage.getItem("adari.sidebar.fold")!) as SidebarFoldState;
    expect(Object.keys(kept.workspaceOrder!)).toEqual(["mini"]);
    expect(kept.workspaceOrder!["mini"]!.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    p.unmount();

    // A relaunch over the same storage.
    const again = await open({ hosts: [mini, studio], storage });
    expect(order(again, "mini")).toEqual(["b", "c", "a"]);
    expect(order(again, "studio")).toEqual(["a", "b", "c"]);
    // A disconnect and a reconnect (no snapshot, then the same one back) keep it too.
    again.hosts([{ ...mini, state: "offline", topology: null }, studio]);
    again.hosts([{ ...mini, connection: 2, epoch: 2 }, studio]);
    expect(order(again, "mini")).toEqual(["b", "c", "a"]);
  });

  it("a header's drop from the sidebar is kept as the menu's moves are", async () => {
    const storage = new MemoryStorage();
    const p = await open({ hosts: [mini], storage });
    (p.sidebar()["onMoveWorkspace"] as (h: string, w: string, before: string | null) => void)("mini", "c", "a");
    expect(order(p, "mini")).toEqual(["c", "a", "b"]);
    expect((JSON.parse(storage.getItem("adari.sidebar.fold")!) as SidebarFoldState).workspaceOrder!["mini"]!.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
    (p.sidebar()["onMoveWorkspace"] as (h: string, w: string, before: string | null) => void)("mini", "gone", "a");
    expect(order(p, "mini")).toEqual(["c", "a", "b"]);
  });

  it("while searching, Move up and Move down are greyed", async () => {
    const p = await open({ hosts: [mini] });
    (p.sidebar()["onSearch"] as (text: string | null) => void)("label");
    p.workspaceMenu("b", "mini");
    expect(reason(p, "Move up")).toBe(workspaceMoveTexts.searching);
    expect(reason(p, "Move down")).toBe(workspaceMoveTexts.searching);
  });

  it("⇧⌘J walks the agents that need you in the new order", async () => {
    const needing = reorderMachine(
      "mini",
      [
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ],
      { a: "blocked", c: "blocked" },
    );
    const p = await open({ hosts: [needing] });
    const jump = (): void => void p.key({ key: "J", metaKey: true, shiftKey: true });
    jump();
    expect(p.selectedKey()).toBe("mini/a:p1");
    p.workspaceMenu("c", "mini");
    p.pick("Move up");
    p.workspaceMenu("c", "mini");
    p.pick("Move up");
    expect(order(p, "mini")).toEqual(["c", "a", "b"]);
    p.select("b:p1", "mini");
    jump();
    expect(p.selectedKey()).toBe("mini/c:p1");
    jump();
    expect(p.selectedKey()).toBe("mini/a:p1");
    jump();
    expect(p.selectedKey()).toBe("mini/c:p1");
  });
});
