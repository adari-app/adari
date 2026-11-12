// The application menu.
//
// Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.):
// apps/desktop/src/window/DesktopApplicationMenu.ts (App menu with About and
// Check for Updates…, Edit, View, Window), without its Effect wiring.

import { app, Menu, type MenuItemConstructorOptions } from "electron";

import type { ViewCommand } from "../shared/view-commands";
import { fileMenuItems, viewMenuItems } from "./view-menu";
import { settingsMenuItem } from "./settings-menu";

export interface MenuHandlers {
  readonly updatesEnabled: boolean;
  readonly checkForUpdates: () => void;
  /** Sends a View menu command to the focused window's page. */
  readonly viewCommand: (command: ViewCommand) => void;
  /** Settings… (⌘,, Ctrl+,): toggles Settings in the focused window's page. */
  readonly openSettings?: () => void;
}

export function installApplicationMenu(handlers: MenuHandlers): void {
  const isMac = process.platform === "darwin";
  const checkForUpdates: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    enabled: handlers.updatesEnabled,
    click: () => handlers.checkForUpdates(),
  };
  // Settings: in the app menu on the Mac, the File menu elsewhere.
  const settings: MenuItemConstructorOptions[] = handlers.openSettings === undefined ? [] : [settingsMenuItem(handlers.openSettings, isMac), { type: "separator" }];
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              checkForUpdates,
              { type: "separator" },
              ...settings,
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      // ⌘W stays free for the app's own panes (T3 leaves Close Window without a key too).
      submenu: [...fileMenuItems(handlers.viewCommand, isMac), { type: "separator" }, ...(isMac ? [] : settings), isMac ? { role: "close", accelerator: "" } : { role: "quit" }],
    },
    { role: "editMenu" },
    // The terminal's text size and the message box (view-menu.ts), not the page zoom.
    { label: "View", submenu: viewMenuItems(handlers.viewCommand, isMac) },
    { role: "windowMenu" },
    ...(isMac ? [] : [{ label: "Help", submenu: [checkForUpdates] } satisfies MenuItemConstructorOptions]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
