// The real NotifyPort (needs-notifier.ts): Electron's Notification, the Dock's
// badge and a Tray in the menu bar (macOS), and the main window. Nothing here
// leaves the Mac: the notification's words are made from the page's rows and
// shown by the system. The menu bar's mark is a template image (macOS tints
// it for a light or dark menu bar), 16 and 32 pixels, made from the app icon's
// artwork by scripts/mac-icon.mjs --menu-bar and carried in the main bundle
// as data URLs (scripts/build.mjs's png loader).
// The Dock badge and the menu bar item are macOS only (elsewhere these are
// no-ops); notifications show wherever the system has them.

import { app, Menu, nativeImage, Notification, Tray, type BrowserWindow, type MenuItemConstructorOptions, type NativeImage } from "electron";

import type { MenuBarView } from "../shared/needs-notify";
import type { MenuBarPick, NotifyPort, ShownNotification } from "./needs-notifier";
import { bringForward } from "./stay-open";
import mark1x from "./menu-bar/menuBarTemplate.png";
import mark2x from "./menu-bar/menuBarTemplate@2x.png";

export interface ElectronNotifyOptions {
  readonly platform: NodeJS.Platform;
  /** The main window now (null: none). */
  window(): BrowserWindow | null;
  /** Opens that agent in the window's page (the select-pane command). */
  select(window: BrowserWindow, hostId: string, paneId: string): void;
  /** Opens Settings in the window's page. */
  openSettings(window: BrowserWindow): void;
}

/** The menu bar's mark: Adari's A at 1x and 2x, a template image. */
function menuBarMark(): NativeImage {
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, dataURL: mark1x });
  image.addRepresentation({ scaleFactor: 2, dataURL: mark2x });
  image.setTemplateImage(true);
  return image;
}

function menuTemplate(view: MenuBarView, onPick: (pick: MenuBarPick) => void): MenuItemConstructorOptions[] {
  return view.items.map((item): MenuItemConstructorOptions => {
    switch (item.kind) {
      case "line":
        return { label: item.label, enabled: false };
      case "separator":
        return { type: "separator" };
      case "agent":
        return { label: item.label, click: () => onPick({ kind: "agent", hostId: item.hostId, paneId: item.paneId }) };
      case "open":
      case "settings":
      case "quit":
        return { label: item.label, click: () => onPick({ kind: item.kind }) };
    }
  });
}

export function electronNotifyPort(options: ElectronNotifyOptions): NotifyPort {
  const mac = options.platform === "darwin";
  let tray: Tray | null = null;
  const forward = (): BrowserWindow | null => {
    const window = options.window();
    return bringForward(window, () => {
      if (mac) app.focus({ steal: true });
    })
      ? window
      : null;
  };
  return {
    canNotify: () => Notification.isSupported(),
    notify: (content, onClick): ShownNotification => {
      const notification = new Notification({ title: content.title, body: content.body, silent: content.silent });
      notification.on("click", onClick);
      notification.show();
      return { close: () => notification.close() };
    },
    setBadge: (count) => {
      if (mac) app.dock?.setBadge(count > 0 ? String(count) : "");
    },
    setMenuBar: (view, onPick) => {
      if (!mac) return;
      if (view === null) {
        tray?.destroy();
        tray = null;
        return;
      }
      tray ??= new Tray(menuBarMark());
      tray.setTitle(view.title);
      tray.setToolTip(view.tooltip);
      tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(view, onPick)));
    },
    windowFocused: () => {
      const window = options.window();
      return window !== null && !window.isDestroyed() && window.isVisible() && window.isFocused();
    },
    reveal: (target) => {
      const window = forward();
      if (window !== null && target !== null) options.select(window, target.hostId, target.paneId);
    },
    openSettings: () => {
      const window = forward();
      if (window !== null) options.openSettings(window);
    },
    quit: () => app.quit(),
  };
}
