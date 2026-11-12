// The main window: security defaults and title bar the way T3 Code makes its
// window, sized to the app's design.
//
// Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.):
// apps/desktop/src/window/DesktopWindow.ts (getWindowTitleBarOptions, the
// webPreferences of createWindow, setWindowOpenHandler / will-navigate guards,
// the traffic-light position from the top bar height), rewritten without Effect.

import path from "node:path";

import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from "electron";

import { isSafeExternalUrl } from "../shared/external-url";
import { APP_URL, isAppUrl } from "./protocol";

/** The app's main header (--mh: 46px); the traffic lights sit centred in it. */
export const TOP_BAR_HEIGHT = 46;
const MACOS_WINDOW_BUTTON_RADIUS = 7;
const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux (T3's note)
const TITLEBAR_SYMBOL_COLOR = "#C2C2BE"; // ink-2 (Halo)

export const DEFAULT_WINDOW = { width: 1280, height: 800, minWidth: 840, minHeight: 620 };

type TitleBarOptions = Pick<BrowserWindowConstructorOptions, "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition">;

export function titleBarOptions(platform: NodeJS.Platform): TitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: TOP_BAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS },
    };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: TITLEBAR_COLOR, height: TOP_BAR_HEIGHT, symbolColor: TITLEBAR_SYMBOL_COLOR },
  };
}

// The rule lives in src/shared/external-url.ts (Chat's and the Terminal's links ask it too).
export { isSafeExternalUrl };

export interface WindowOptions {
  readonly width?: number;
  readonly height?: number;
  /** Show without taking focus (the capture flag: nothing else comes forward). */
  readonly showInactive?: boolean;
  /** The window's icon in development on Windows and Linux (app-icon.ts). */
  readonly icon?: string;
  /** May be larger than the screen (macOS): the showcase's 2x capture on a 1x display. */
  readonly largerThanScreen?: boolean;
}

export function createMainWindow(options: WindowOptions = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: options.width ?? DEFAULT_WINDOW.width,
    height: options.height ?? DEFAULT_WINDOW.height,
    minWidth: DEFAULT_WINDOW.minWidth,
    minHeight: DEFAULT_WINDOW.minHeight,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    title: "Adari",
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    ...(options.largerThanScreen === true ? { enableLargerThanScreen: true } : {}),
    ...titleBarOptions(process.platform),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      // Hidden-renderer throttling stalls first paint (T3's note).
      backgroundThrottling: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());

  window.once("ready-to-show", () => {
    if (options.showInactive) window.showInactive();
    else window.show();
  });
  void window.loadURL(APP_URL);
  return window;
}
