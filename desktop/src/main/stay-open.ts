// Adari keeps running when its window is closed (macOS), so the notifications,
// the Dock badge and the menu bar item (needs-notifier.ts) keep working: the
// red button and File › Close Window (⌘W) put the window away (hidden, as it
// was: same selection, same connections, nothing reloaded); the Dock icon, Open
// Adari and a notification bring it back. What quits on purpose still quits:
// ⌘Q and Quit Adari (app.quit: before-quit comes first), the update's Restart
// (Squirrel.Mac's quitAndInstall closes the windows after
// before-quit-for-update, before before-quit; electron-updater's own fallback
// calls app.quit), and a second instance (it quits before it has a window).
// Not on Windows or Linux, and not in a run opened with a demo, capture or
// probe flag (launch-options.ts hasInstrumentFlag): there closing the window
// quits, as before.

import { hasInstrumentFlag } from "./launch-options";

/** Closing the window only puts it away: macOS, outside the instrument runs. */
export function staysOpenWhenClosed(platform: NodeJS.Platform, argv: readonly string[]): boolean {
  return platform === "darwin" && !hasInstrumentFlag(argv);
}

/** The window's part (Electron's BrowserWindow has it). */
export interface StayOpenWindow {
  on(event: "close", listener: (event: { preventDefault(): void }) => void): unknown;
  once(event: "leave-full-screen", listener: () => void): unknown;
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(on: boolean): void;
  hide(): void;
}

/** What says a quit is under way (Electron's app and autoUpdater). */
export interface QuitSignals {
  onBeforeQuit(listener: () => void): void;
  /** Squirrel.Mac's quitAndInstall, which closes the windows before before-quit (absent where updates are off). */
  onBeforeQuitForUpdate?(listener: () => void): void;
}

export class StayOpen {
  private quitting = false;

  constructor(
    readonly enabled: boolean,
    signals: QuitSignals,
  ) {
    const quit = (): void => {
      this.quitting = true;
    };
    signals.onBeforeQuit(quit);
    signals.onBeforeQuitForUpdate?.(quit);
  }

  /** A quit is under way: the window closes and the app goes. */
  isQuitting(): boolean {
    return this.quitting;
  }

  /** What closing the window does now: put it away, or close it (and quit, as window-all-closed does). */
  onClose(): "hide" | "close" {
    return this.enabled && !this.quitting ? "hide" : "close";
  }

  /** The window's close puts it away instead while onClose says so (out of full screen first, so no empty Space is left). */
  attach(window: StayOpenWindow): void {
    window.on("close", (event) => {
      if (this.onClose() === "close") return;
      event.preventDefault();
      if (window.isFullScreen()) {
        window.once("leave-full-screen", () => {
          if (!window.isDestroyed()) window.hide();
        });
        window.setFullScreen(false);
        return;
      }
      window.hide();
    });
  }
}

/** The window's part bringForward uses. */
export interface ForwardWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * The window back in front, as it was: un-minimized, shown (un-hidden), focused; `activate` brings the app
 * forward too (a click in the menu bar item's menu does not make Adari the active app on its own). False: no window.
 */
export function bringForward(window: ForwardWindow | null, activate: () => void = () => undefined): boolean {
  if (window === null || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  activate();
  window.focus();
  return true;
}
