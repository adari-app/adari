// The View menu: the terminal's text size (⌘0 / ⌘+ / ⌘-, in place of the
// page zoom roles, which would scale the whole window), Show Message Box
// (⇧⌘T), Terminal (⌘J, the open pane's terminal drawer), and the While You Were
// Away and What Each Agent Changed screens, each sent to the focused window's
// page as a ViewCommand. No Electron values here, so the template is tested as
// data.

import type { MenuItemConstructorOptions } from "electron";

import type { ViewCommand } from "../shared/view-commands";

/**
 * The File menu's own items: New Workspace… (⇧⌘N, Ctrl+Shift+N),
 * sent to the page as the key would open it. The page's own key handler takes
 * the key (registerAccelerator false where Electron honours it, Linux and
 * Windows); on the Mac the menu and the page may both see it, and the page opens
 * the one dialog either way.
 */
export function fileMenuItems(send: (command: ViewCommand) => void, isMac: boolean): MenuItemConstructorOptions[] {
  return [{ label: "New Workspace…", accelerator: isMac ? "Shift+Cmd+N" : "Shift+Ctrl+N", registerAccelerator: false, click: () => send("new-workspace") }];
}

export function viewMenuItems(send: (command: ViewCommand) => void, isMac: boolean): MenuItemConstructorOptions[] {
  return [
    { role: "reload" },
    { role: "toggleDevTools" },
    { type: "separator" },
    { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => send("font-reset") },
    { label: "Bigger Text", accelerator: "CmdOrCtrl+Plus", click: () => send("font-bigger") },
    // ⌘= is the same key without Shift on most layouts.
    { label: "Bigger Text", accelerator: "CmdOrCtrl+=", visible: false, acceleratorWorksWhenHidden: true, click: () => send("font-bigger") },
    { label: "Smaller Text", accelerator: "CmdOrCtrl+-", click: () => send("font-smaller") },
    { type: "separator" },
    { label: "Show or Hide Message Box", accelerator: isMac ? "Shift+Cmd+T" : "Shift+Ctrl+T", click: () => send("toggle-box") },
    // ⌃⌘C, an agent pane's Changes and back to the view it covered (one path to the page).
    { label: "Changes", accelerator: isMac ? "Ctrl+Cmd+C" : "Ctrl+Alt+C", click: () => send("toggle-changes") },
    // The open pane's terminal drawer (T3 Code's ⌘J). The page's own key handler takes
    // the key before the terminal sees it (registerAccelerator false where Electron honours it); on the Mac the
    // menu and the key may both come, and the page takes one press once (shared/terminal-drawer.ts DrawerToggleGate).
    { label: "Terminal", accelerator: "CmdOrCtrl+J", registerAccelerator: false, click: () => send("toggle-terminal") },
    { type: "separator" },
    // While You Were Away and What Each Agent Changed open from here (no key of their own).
    { label: "While You Were Away", click: () => send("open-away") },
    { label: "What Each Agent Changed", click: () => send("open-changes") },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
}
