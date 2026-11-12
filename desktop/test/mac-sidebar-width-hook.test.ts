// The sidebar's width, wired: the real Sidebar on the hooks host, its edge
// dragged with pointer events as the page sends them (a fake window, page
// storage and body), the width shown on the sidebar (--sb-w) frame by frame,
// kept when let go and read back by the next launch's sidebar; its minimum,
// the main pane's minimum, a window that narrows and grows again, and a
// double-click that puts the default back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { buildDesktopSidebar, type SidebarHost } from "../src/shared/desktop-sidebar";
import { HookHost, elements } from "./support/fake-hooks";
import { nowUnixMs } from "./support/sidebar-fixture";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { Sidebar } = await import("../src/renderer/components/Sidebar");
type SidebarProps = Parameters<typeof Sidebar>[0];

const host: SidebarHost = {
  id: "mini",
  name: "Mac mini",
  platform: "macOS",
  state: "connected",
  error: null,
  topology: decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "api", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "working" }],
    panes: [{ pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/srv/api", agent: "claude", agent_status: "working", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "working", status_since_unix_ms: nowUnixMs - 60_000 }],
  }),
};

const none = (): void => undefined;
const props: SidebarProps = {
  sidebar: buildDesktopSidebar([host], { nowUnixMs }),
  selectedKey: null,
  search: null,
  demo: false,
  foldedHosts: new Set(),
  onSelect: none,
  onRowMenu: none,
  onToggleHost: none,
  onHostMenu: none,
  onRetryHost: none,
  onMode: none,
  onToggleWorkspace: none,
  onToggleExpanded: none,
  onToggleSection: none,
  onSearch: none,
  onAddHost: none,
  onNewAgent: none,
  onWorkspaceMenu: none,
};

/** The page: a window of `width`, its resize listeners, page storage, frames and the body's style. */
function fakePage(width: number) {
  const resizes = new Set<() => void>();
  const blurs = new Set<() => void>();
  const frames = new Map<number, () => void>();
  let next = 1;
  const stored = new Map<string, string>();
  const body: Record<string, string> = {};
  const win = {
    innerWidth: width,
    addEventListener: (type: string, listener: () => void) => (type === "resize" ? resizes : blurs).add(listener),
    removeEventListener: (type: string, listener: () => void) => (type === "resize" ? resizes : blurs).delete(listener),
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, String(value)),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    const id = next++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("document", {
    body: {
      style: {
        setProperty: (name: string, value: string) => (body[name] = value),
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
  return {
    stored,
    body,
    frames: () => {
      const due = [...frames.values()];
      frames.clear();
      for (const frame of due) frame();
    },
    resize: (to: number) => {
      win.innerWidth = to;
      for (const listener of resizes) listener();
    },
  };
}

type El = { type: unknown; props: Record<string, unknown> };

/** The sidebar on the hooks host: its aside's --sb-w, its edge, and the edge's parent (the aside in the page) and its style. */
function mount() {
  const view = new HookHost(Sidebar, props);
  view.render();
  const all = (): El[] => elements(view.tree) as El[];
  const aside = (): El => all().find((element) => element.type === "aside")!;
  const edge = (): El => all().find((element) => element.props["className"] === "sb-rail")!;
  const style: Record<string, string> = {};
  const captured = new Set<number>();
  const target = {
    parentElement: { style: { setProperty: (name: string, value: string) => (style[name] = value) } },
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  };
  const event = (clientX: number) => ({ button: 0, pointerId: 1, clientX, currentTarget: target, preventDefault: none, stopPropagation: none });
  const call = (name: string, clientX: number): void => (edge().props[name] as (event: unknown) => void)(event(clientX));
  return {
    view,
    width: () => (aside().props["style"] as Record<string, string>)["--sb-w"],
    edge,
    style,
    captured,
    drag: (from: number, to: number, frames: () => void) => {
      call("onPointerDown", from);
      call("onPointerMove", to);
      frames();
      const during = style["--sb-w"];
      call("onPointerUp", to);
      return during;
    },
    doubleClick: () => (edge().props["onDoubleClick"] as () => void)(),
  };
}

beforeEach(() => undefined);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the sidebar's edge, wired", () => {
  it("draws the edge with its resize cursor's words and the default width", () => {
    fakePage(1440);
    const sidebar = mount();
    expect(sidebar.width()).toBe("288px");
    expect(sidebar.edge().props["role"]).toBe("separator");
    expect(sidebar.edge().props["aria-orientation"]).toBe("vertical");
    expect(String(sidebar.edge().props["title"])).toMatch(/Drag to resize/);
    expect(String(sidebar.edge().props["title"])).toMatch(/double-click/i);
  });

  it("follows a drag frame by frame, keeps the width it is let go at, and the next launch opens at it", () => {
    const page = fakePage(1440);
    const sidebar = mount();
    const during = sidebar.drag(288, 440, page.frames);
    expect(during).toBe("440px");
    expect(page.body["cursor"]).toBeUndefined();
    expect(sidebar.width()).toBe("440px");
    expect(page.stored.get("adari.sidebar.width")).toBe("440");
    expect(sidebar.captured.size).toBe(0);
    sidebar.view.unmount();

    // A relaunch: a new sidebar on the same page storage.
    const next = mount();
    expect(next.width()).toBe("440px");
  });

  it("shows the resize cursor on the whole page while it drags, and lets it go after", () => {
    const page = fakePage(1440);
    const sidebar = mount();
    (sidebar.edge().props["onPointerDown"] as (event: unknown) => void)({
      button: 0,
      pointerId: 1,
      clientX: 288,
      currentTarget: { parentElement: { style: { setProperty: none } }, setPointerCapture: none, hasPointerCapture: () => true, releasePointerCapture: none },
      preventDefault: none,
      stopPropagation: none,
    });
    expect(page.body["cursor"]).toBe("col-resize");
    expect(page.body["user-select"]).toBe("none");
    sidebar.view.unmount();
    expect(page.body["cursor"]).toBeUndefined();
  });

  it("stops at its 256 px minimum and where the main pane keeps 552 px", () => {
    const page = fakePage(1440);
    const sidebar = mount();
    expect(sidebar.drag(288, 10, page.frames)).toBe("256px");
    expect(sidebar.width()).toBe("256px");
    expect(sidebar.drag(256, 1_400, page.frames)).toBe("888px");
    expect(sidebar.width()).toBe("888px");
    expect(page.stored.get("adari.sidebar.width")).toBe("888");

    // A smaller window: the main pane still keeps 552 px.
    const small = fakePage(1000);
    const narrow = mount();
    expect(narrow.width()).toBe("288px");
    narrow.drag(288, 900, small.frames);
    expect(narrow.width()).toBe("448px");
  });

  it("gives way while the window is too narrow for the kept width and takes it back when the window grows", () => {
    const page = fakePage(1440);
    page.stored.set("adari.sidebar.width", "440");
    const sidebar = mount();
    expect(sidebar.width()).toBe("440px");
    page.resize(900);
    expect(sidebar.width()).toBe("348px");
    expect(page.stored.get("adari.sidebar.width")).toBe("440");
    page.resize(1440);
    expect(sidebar.width()).toBe("440px");
  });

  it("puts the default back on a double-click and keeps nothing", () => {
    const page = fakePage(1440);
    const sidebar = mount();
    sidebar.drag(288, 440, page.frames);
    expect(page.stored.get("adari.sidebar.width")).toBe("440");
    sidebar.doubleClick();
    expect(sidebar.width()).toBe("288px");
    expect(page.stored.has("adari.sidebar.width")).toBe(false);
    sidebar.view.unmount();
    expect(mount().width()).toBe("288px");
  });
});
