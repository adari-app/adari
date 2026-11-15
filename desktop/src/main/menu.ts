// The application menu.
//
// Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.):
// apps/desktop/src/window/DesktopApplicationMenu.ts (App menu with About and
// Check for Updates…, Edit, View, Window), without its Effect wiring. Help
// holds Report a Problem… and Send Feedback… (feedback.ts: a new GitHub issue
// in the browser; Adari sends nothing); on the Mac it is the menu bar's Help
// menu (role "help", where macOS adds its search field).

import { app, Menu, type MenuItemConstructorOptions } from "electron";

import { feedbackMenuLabels, type FeedbackKind } from "../shared/feedback";
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
  /** Report a Problem… and Send Feedback…: the new issue in the default browser (never Adari's window). */
  readonly openFeedback?: (kind: FeedbackKind) => void;
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
  const openFeedback = handlers.openFeedback;
  const feedback: MenuItemConstructorOptions[] =
    openFeedback === undefined
      ? []
      : [
          { label: feedbackMenuLabels.problem, click: () => openFeedback("problem") },
          { label: feedbackMenuLabels.feedback, click: () => openFeedback("feedback") },
        ];
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
      // Close Window is ⌘W on the Mac: it puts the window away and Adari keeps running (stay-open.ts); no pane uses ⌘W.
      submenu: [...fileMenuItems(handlers.viewCommand, isMac), { type: "separator" }, ...(isMac ? [] : settings), isMac ? { role: "close" } : { role: "quit" }],
    },
    { role: "editMenu" },
    // The terminal's text size and the message box (view-menu.ts), not the page zoom.
    { label: "View", submenu: viewMenuItems(handlers.viewCommand, isMac) },
    { role: "windowMenu" },
    ...(isMac
      ? feedback.length === 0
        ? []
        : [{ label: "Help", role: "help", submenu: feedback } satisfies MenuItemConstructorOptions]
      : [{ label: "Help", submenu: [checkForUpdates, ...(feedback.length === 0 ? [] : [{ type: "separator" } as const, ...feedback])] } satisfies MenuItemConstructorOptions]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
