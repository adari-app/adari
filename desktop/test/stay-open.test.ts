// Adari keeps running when its window is closed on the Mac (src/main/stay-open.ts): closing puts the window away;
// a real quit (⌘Q, Quit Adari: before-quit first) and the update's Restart (before-quit-for-update, which comes
// before the windows close) still close it and quit; a demo, capture or probe run, and Windows and Linux, quit when
// the window closes, as before. A Dock click, a notification and a second launch bring the window back as it was.
// File › Close Window is ⌘W on the Mac. And main.ts wires it so (read as text: main.ts runs only under Electron).

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const template = vi.hoisted(() => ({ current: null as unknown[] | null }));
vi.mock("electron", () => ({
  app: { name: "Adari" },
  Menu: { buildFromTemplate: (items: unknown[]) => ((template.current = items), {}), setApplicationMenu: () => undefined },
}));

const { bringForward, StayOpen, staysOpenWhenClosed } = await import("../src/main/stay-open");

class FakeWindow {
  closeListeners: ((event: { preventDefault(): void }) => void)[] = [];
  leaveFullScreen: (() => void) | null = null;
  fullScreen = false;
  hidden = 0;
  destroyed = false;
  on(_event: "close", listener: (event: { preventDefault(): void }) => void): void {
    this.closeListeners.push(listener);
  }
  once(_event: "leave-full-screen", listener: () => void): void {
    this.leaveFullScreen = listener;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  setFullScreen(on: boolean): void {
    this.fullScreen = on;
  }
  hide(): void {
    this.hidden += 1;
  }
  /** The red button or ⌘W: true when the window really closes. */
  close(): boolean {
    let prevented = false;
    for (const listener of this.closeListeners) listener({ preventDefault: () => (prevented = true) });
    return !prevented;
  }
}

function setup(enabled: boolean, withUpdates = true) {
  const quit: (() => void)[] = [];
  const update: (() => void)[] = [];
  const stay = new StayOpen(enabled, {
    onBeforeQuit: (listener) => quit.push(listener),
    ...(withUpdates ? { onBeforeQuitForUpdate: (listener: () => void) => update.push(listener) } : {}),
  });
  const window = new FakeWindow();
  stay.attach(window);
  return { stay, window, beforeQuit: () => quit.forEach((run) => run()), beforeQuitForUpdate: () => update.forEach((run) => run()) };
}

describe("closing the window", () => {
  it("stays open only on the Mac, and never in a demo, capture or probe run", () => {
    expect(staysOpenWhenClosed("darwin", ["/Applications/Adari.app/Contents/MacOS/Adari"])).toBe(true);
    expect(staysOpenWhenClosed("darwin", ["electron", ".", "--window-size=1440x900", "--herdr-user-data=/x"])).toBe(true);
    for (const flag of ["--demo", "--capture=/x", "--capture-quit", "--capture-only=240", "--look-probe=/x", "--flicker-probe=/x", "--splits-probe=/x", "--showcase", "--showcase-capture=/x"]) {
      expect(staysOpenWhenClosed("darwin", ["electron", ".", flag]), flag).toBe(false);
    }
    expect(staysOpenWhenClosed("linux", ["adari"])).toBe(false);
    expect(staysOpenWhenClosed("win32", ["adari.exe"])).toBe(false);
  });

  it("on the Mac puts the window away (hidden) and does not quit", () => {
    const { stay, window } = setup(true);
    expect(window.close()).toBe(false);
    expect(window.hidden).toBe(1);
    expect(stay.onClose()).toBe("hide");
    expect(window.close()).toBe(false);
    expect(window.hidden).toBe(2);
  });

  it("leaves full screen first, then hides (no empty Space left behind)", () => {
    const { window } = setup(true);
    window.fullScreen = true;
    expect(window.close()).toBe(false);
    expect(window.fullScreen).toBe(false);
    expect(window.hidden).toBe(0);
    window.leaveFullScreen!();
    expect(window.hidden).toBe(1);
  });

  it("a real quit (⌘Q, Quit Adari) closes it and quits", () => {
    const { stay, window, beforeQuit } = setup(true);
    beforeQuit();
    expect(stay.isQuitting()).toBe(true);
    expect(window.close()).toBe(true);
    expect(window.hidden).toBe(0);
  });

  it("the update's Restart (before-quit-for-update, before the windows close) still quits", () => {
    const { window, beforeQuitForUpdate } = setup(true);
    beforeQuitForUpdate();
    expect(window.close()).toBe(true);
  });

  it("in a capture or instrument run, or off the Mac, closing the window closes it (and the app quits as before)", () => {
    const { stay, window } = setup(false, false);
    expect(stay.onClose()).toBe("close");
    expect(window.close()).toBe(true);
    expect(window.hidden).toBe(0);
  });
});

describe("bringing the window back", () => {
  it("un-minimizes, shows, brings the app forward and focuses, as it was", () => {
    const calls: string[] = [];
    const window = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => calls.push("restore"),
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
    };
    expect(bringForward(window, () => calls.push("activate"))).toBe(true);
    expect(calls).toEqual(["restore", "show", "activate", "focus"]);
  });

  it("does nothing without a window", () => {
    expect(bringForward(null)).toBe(false);
    expect(bringForward({ isDestroyed: () => true, isMinimized: () => false, restore: () => undefined, show: () => undefined, focus: () => undefined })).toBe(false);
  });
});

describe("File › Close Window", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => Object.defineProperty(process, "platform", platform));

  type Item = { label?: string; role?: string; accelerator?: string; submenu?: Item[] };
  it("is ⌘W on the Mac (its default key, no longer taken off)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { installApplicationMenu } = await import("../src/main/menu");
    installApplicationMenu({ updatesEnabled: false, checkForUpdates: () => undefined, viewCommand: () => undefined });
    const file = (template.current as Item[]).find((item) => item.label === "File")!.submenu!;
    const close = file.find((item) => item.role === "close")!;
    expect(close).toBeDefined();
    expect("accelerator" in close).toBe(false);
  });
});

describe("main.ts's wiring", () => {
  const main = readFileSync(path.join(import.meta.dirname, "../src/main/main.ts"), "utf8");

  it("attaches the window to StayOpen, quits on before-quit and the update's before-quit-for-update, and still quits when every window closed", () => {
    expect(main).toContain("new StayOpen(staysOpenWhenClosed(process.platform, process.argv), {");
    expect(main).toContain('onBeforeQuit: (listener) => app.on("before-quit", listener)');
    expect(main).toContain('autoUpdater.on("before-quit-for-update", listener)');
    expect(main).toContain("stayOpen.attach(window);");
    expect(main).toMatch(/app\.on\("window-all-closed", \(\) => \{\n {2}app\.quit\(\);\n\}\);/);
    // A second instance still quits before it has a window; the first one's comes forward.
    expect(main).toMatch(/if \(!app\.requestSingleInstanceLock\(\)\) \{\n {2}app\.quit\(\);/);
    expect(main).toContain("bringForward(mainWindow);");
  });

  it("brings the window back on a Dock click only where closing does not quit, after it first showed", () => {
    expect(main).toContain("if (stayOpen.enabled && windowShown) bringForward(mainWindow);");
  });

  it("records, never shows, in a demo, capture or probe run, and lets go of the notifications on quit", () => {
    expect(main).toContain("options.demo || hasInstrumentFlag(process.argv)\n      ? new RecordedNotifyPort(notifyLog)");
    expect(main).toContain('app.on("before-quit", () => notifier.stop());');
  });
});
