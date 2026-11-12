// Our icon in development. A packaged app has
// build/icon.icns from electron-builder; `electron .` would show Electron's
// own, so in development the dock (macOS) or the window (Windows, Linux)
// takes build/icon.png, the same artwork (both drawn from the iPhone app's).

import path from "node:path";

export interface DevelopmentIcon {
  /** app.dock.setIcon's file (macOS), or null. */
  readonly dock: string | null;
  /** The BrowserWindow's icon (Windows, Linux), or null. */
  readonly window: string | null;
}

export function developmentIcon(appPath: string, packaged: boolean, platform: NodeJS.Platform): DevelopmentIcon {
  if (packaged) return { dock: null, window: null };
  const file = path.join(appPath, "build", "icon.png");
  return platform === "darwin" ? { dock: file, window: null } : { dock: null, window: file };
}
