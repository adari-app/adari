// The composer's "Send presses Return", set in Settings › Chat
// and read by every message box (MainPane.tsx Composer). Kept in the window's
// localStorage, so it holds across a relaunch; on
// by default. Also the platform, so ⌘Return (Ctrl+Return elsewhere) is the
// send key with the setting off.

import { loadSendPressesReturn, saveSendPressesReturn } from "../../shared/settings";

/** The window's localStorage, or null where it is not allowed (a test's window without one). */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

export class ComposerSettings {
  private pressesReturn: boolean | null = null;
  private mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform ?? "");
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Return sends (on, the default), or ⌘Return does (off); read from storage the first time it is asked. */
  sendPressesReturn = (): boolean => {
    this.pressesReturn ??= loadSendPressesReturn(storage());
    return this.pressesReturn;
  };

  setSendPressesReturn(on: boolean): void {
    if (this.sendPressesReturn() === on) return;
    this.pressesReturn = on;
    saveSendPressesReturn(storage(), on);
    for (const listener of this.listeners) listener();
  }

  /** The app's platform (AppInfo.platform), once the window knows it. */
  setMac(mac: boolean): void {
    if (this.mac === mac) return;
    this.mac = mac;
    for (const listener of this.listeners) listener();
  }

  isMac = (): boolean => this.mac;

  /** Tests: read from storage again (a relaunch). */
  reset(): void {
    this.pressesReturn = null;
  }
}

export const composerSettings = new ComposerSettings();
