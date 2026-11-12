// Whether a window is in sight: minimized or hidden
// it shows no tile, so its Chat feeds pause (ChatService.setPaused) until it
// is restored or shown again. Its terminals stay attached: a terminal's screen
// is the stream itself, and a re-attach that replays it is not confirmed.

/** The window events this follows (Electron's BrowserWindow has them). */
export interface SightWindow {
  on(event: "minimize" | "restore" | "hide" | "show", listener: () => void): unknown;
  removeListener(event: "minimize" | "restore" | "hide" | "show", listener: () => void): unknown;
  isMinimized(): boolean;
  isVisible(): boolean;
}

/** Calls `onPaused(true)` when the window goes out of sight and `onPaused(false)` when it is back; returns the stop. */
export function followWindowSight(window: SightWindow, onPaused: (paused: boolean) => void): () => void {
  let paused = false;
  const check = (): void => {
    const next = window.isMinimized() || !window.isVisible();
    if (next === paused) return;
    paused = next;
    onPaused(next);
  };
  const events = ["minimize", "restore", "hide", "show"] as const;
  for (const event of events) window.on(event, check);
  return () => {
    for (const event of events) window.removeListener(event, check);
  };
}
