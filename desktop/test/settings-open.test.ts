// Settings opens in the main window from the sidebar footer's
// button, ⌘, (the page's key) and the menu's Settings…; Esc, its close button
// and ⌘, again go back to the pane, with the keyboard back on the text field
// it was on (focus-return.ts). The menu's entry is in the app menu on the Mac
// (Cmd+,) and the File menu elsewhere (Ctrl+,).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const template: { current: unknown[] | null } = { current: null };
vi.mock("electron", () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  app: { name: "Adari" },
  Menu: { buildFromTemplate: (items: unknown[]) => ((template.current = items), {}), setApplicationMenu: () => undefined },
}));

import { HookHost, elements } from "./support/fake-hooks";
import { one, page, settle } from "./support/manage-page";

const { escapeOwners, keyOwners } = await import("../src/renderer/components/escape-owners");
const { focusReturn } = await import("../src/renderer/components/focus-return");
const { unmountPanes } = await import("./support/manage-page");
const { SettingsPage } = await import("../src/renderer/settings/SettingsPage");

let cleanups: (() => void)[] = [];

beforeEach(() => {
  escapeOwners.reset();
  keyOwners.reset();
  focusReturn.reset();
});

afterEach(async () => {
  // The commands' acknowledgements (two frames after) land before the window goes.
  for (let i = 0; i < 6; i += 1) await settle();
  for (const run of cleanups.splice(0)) run();
  unmountPanes();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function open() {
  const p = await page();
  cleanups.push(p.unmount);
  p.select("w1:p1");
  return p;
}

/** The terminal's (or the Composer's) text field, recording each focus() on it. */
function textField() {
  const focused: string[] = [];
  return { tagName: "TEXTAREA", type: "text", isConnected: true, focus: () => focused.push("focus"), closest: () => null, focused };
}

type Page = Awaited<ReturnType<typeof open>>;

const settingsProps = (p: Page) => one(p.app.tree, "SettingsPage")?.props as Record<string, unknown> | undefined;
const appClass = (p: Page) => (p.app.tree as { props: { className: string } }).props.className;
const cmdComma = { key: ",", metaKey: true };

/** The page itself (App renders it; its own hooks run here), over the same window. */
function mountPage(p: Page) {
  const view = new HookHost<object>(SettingsPage as (props: object) => unknown, settingsProps(p)!);
  view.render();
  cleanups.push(() => view.unmount());
  return view;
}

describe("opening Settings", () => {
  it("the sidebar footer's button opens it over the main area, and again goes back", async () => {
    const p = await open();
    expect(settingsProps(p)).toBeUndefined();
    expect(p.sidebar()["settingsOpen"]).toBe(false);
    expect(p.sidebar()["settingsKey"]).toBe("⌘,");

    (p.sidebar()["onOpenSettings"] as () => void)();
    expect(settingsProps(p)?.["section"]).toBe("machines");
    expect(p.sidebar()["settingsOpen"]).toBe(true);
    expect(appClass(p)).toBe("app settings-open");
    // The pane stays under it as it was (its terminal and draft are not remounted).
    expect(p.main()?.["row"]).toBeDefined();

    (p.sidebar()["onOpenSettings"] as () => void)();
    expect(settingsProps(p)).toBeUndefined();
    expect(appClass(p)).toBe("app");
  });

  it("⌘, opens it (taken before the terminal sees it), and ⌘, again goes back with the focus where it was", async () => {
    const p = await open();
    const terminal = textField();
    p.fire("focusin", { target: terminal });
    vi.useFakeTimers({ toFake: ["Date"] });

    expect(p.key(cmdComma)).toBe(true);
    expect(settingsProps(p)).toBeDefined();
    vi.setSystemTime(Date.now() + 1_000);
    expect(p.key(cmdComma)).toBe(true);
    expect(settingsProps(p)).toBeUndefined();
    expect(terminal.focused).toEqual(["focus"]);
  });

  it("⌘, with Shift or Option is not Settings; Ctrl+, is not on the Mac", async () => {
    const p = await open();
    expect(p.key({ key: ",", metaKey: true, shiftKey: true })).toBe(false);
    expect(p.key({ key: ",", metaKey: true, altKey: true })).toBe(false);
    expect(p.key({ key: ",", ctrlKey: true })).toBe(false);
    expect(settingsProps(p)).toBeUndefined();
  });

  it("a rename field that owns the keys keeps ⌘, and the menu's Settings…", async () => {
    const p = await open();
    const release = keyOwners.hold();
    expect(p.key(cmdComma)).toBe(false);
    p.command({ id: "m1", type: "settings", open: "toggle" });
    expect(settingsProps(p)).toBeUndefined();
    release();
  });

  it("the menu's Settings… toggles it; the menu's echo of one ⌘, press counts once", async () => {
    const p = await open();
    vi.useFakeTimers({ toFake: ["Date"] });
    p.command({ id: "m1", type: "settings", open: "toggle" });
    expect(settingsProps(p)).toBeDefined();
    vi.setSystemTime(Date.now() + 1_000);
    p.command({ id: "m2", type: "settings", open: "toggle" });
    expect(settingsProps(p)).toBeUndefined();

    // One press both ways (the page's key, then the menu's), 50 ms apart: opened once, not closed again.
    vi.setSystemTime(Date.now() + 1_000);
    p.key(cmdComma);
    vi.setSystemTime(Date.now() + 50);
    p.command({ id: "m3", type: "settings", open: "toggle" });
    expect(settingsProps(p)).toBeDefined();
  });

  it("opens at the section asked for (the captures), and keeps the last section shown", async () => {
    const p = await open();
    p.command({ id: "c1", type: "settings", open: true, section: "about" });
    expect(settingsProps(p)?.["section"]).toBe("about");
    (settingsProps(p)!["onSection"] as (section: string) => void)("chat");
    expect(settingsProps(p)?.["section"]).toBe("chat");
    p.command({ id: "c2", type: "settings", open: false });
    expect(settingsProps(p)).toBeUndefined();
    (p.sidebar()["onOpenSettings"] as () => void)();
    expect(settingsProps(p)?.["section"]).toBe("chat");
  });

  it("a pane picked in the sidebar shows in place of Settings (the focus stays with the pane picked)", async () => {
    const p = await open();
    const terminal = textField();
    p.fire("focusin", { target: terminal });
    (p.sidebar()["onOpenSettings"] as () => void)();
    p.select("w1:p2");
    expect(settingsProps(p)).toBeUndefined();
    expect(p.selectedKey()).toContain("w1:p2");
    expect(terminal.focused).toEqual([]);
  });
});

describe("going back from Settings", () => {
  it("Esc goes back to the pane with the focus where it was", async () => {
    const p = await open();
    const composer = textField();
    p.fire("focusin", { target: composer });
    (p.sidebar()["onOpenSettings"] as () => void)();
    mountPage(p);
    expect(p.key({ key: "Escape" })).toBe(true);
    expect(settingsProps(p)).toBeUndefined();
    expect(composer.focused).toEqual(["focus"]);
  });

  it("its close button goes back the same way", async () => {
    const p = await open();
    const terminal = textField();
    p.fire("focusin", { target: terminal });
    (p.sidebar()["onOpenSettings"] as () => void)();
    const view = mountPage(p);
    const close = elements(view.tree).find((element) => element.props["aria-label"] === "Close Settings")!;
    (close.props["onClick"] as () => void)();
    expect(settingsProps(p)).toBeUndefined();
    expect(terminal.focused).toEqual(["focus"]);
  });

  it("Esc is the page's even with the box over the terminal open under it (a hold from before the page)", async () => {
    const p = await open();
    const box = escapeOwners.hold();
    (p.sidebar()["onOpenSettings"] as () => void)();
    mountPage(p);
    expect(p.key({ key: "Escape" })).toBe(true);
    expect(settingsProps(p)).toBeUndefined();
    box();
  });

  it("a dialog or menu over the page keeps its Esc (the page stays)", async () => {
    const p = await open();
    (p.sidebar()["onOpenSettings"] as () => void)();
    mountPage(p);
    const dialog = escapeOwners.hold();
    expect(p.key({ key: "Escape" })).toBe(false);
    expect(settingsProps(p)).toBeDefined();
    dialog();
  });
});

describe("the menu's Settings…", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => Object.defineProperty(process, "platform", platform));

  type Item = { label?: string; accelerator?: string; registerAccelerator?: boolean; submenu?: Item[]; click?: () => void };
  async function menu(os: string, openSettings: () => void): Promise<Item[]> {
    Object.defineProperty(process, "platform", { value: os });
    const { installApplicationMenu } = await import("../src/main/menu");
    installApplicationMenu({ updatesEnabled: false, checkForUpdates: () => undefined, viewCommand: () => undefined, openSettings });
    return template.current as Item[];
  }

  it("on the Mac: in the app menu, Cmd+, (the page takes the key; the menu shows it)", async () => {
    let opened = 0;
    const items = await menu("darwin", () => (opened += 1));
    const appMenu = items[0]!.submenu!;
    const entry = appMenu.find((item) => item.label === "Settings…")!;
    expect(entry.accelerator).toBe("Cmd+,");
    expect(entry.registerAccelerator).toBe(false);
    entry.click!();
    expect(opened).toBe(1);
    const file = items.find((item) => item.label === "File")!.submenu!;
    expect(file.some((item) => item.label === "Settings…")).toBe(false);
  });

  it("elsewhere: in the File menu, Ctrl+,", async () => {
    const items = await menu("linux", () => undefined);
    const file = items.find((item) => item.label === "File")!.submenu!;
    expect(file.find((item) => item.label === "Settings…")?.accelerator).toBe("Ctrl+,");
  });
});

describe("the captures' filter (Settings' captures on their own)", () => {
  it("--capture-only takes name prefixes in a development build, and is ignored in the shipped app", async () => {
    const { parseLaunchOptions } = await import("../src/main/launch-options");
    const argv = ["app", "--capture=/tmp/c", "--capture-only=106, 113,", "--capture-quit"];
    expect(parseLaunchOptions(argv).captureOnly).toEqual(["106", "113"]);
    expect(parseLaunchOptions(["app", "--capture=/tmp/c"]).captureOnly).toBeNull();
    const shipped = parseLaunchOptions(argv, { packaged: true });
    expect(shipped.captureOnly).toBeNull();
    expect(shipped.captureDir).toBeNull();
    expect(shipped.demo).toBe(false);
  });
});
