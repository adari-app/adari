// Settings… in the native menu: the app menu on the Mac
// (⌘,), the File menu on Windows and Linux (Ctrl+,). Its click toggles
// Settings in the focused window's page as ⌘, does (an AppCommand). The page
// takes the key itself (registerAccelerator false where Electron honours it,
// Windows and Linux), as New Workspace… does; on the Mac the menu and the page
// may both see ⌘,, and the page counts the two as one press (App.tsx). No
// Electron values here, so the item is tested as data.

import type { MenuItemConstructorOptions } from "electron";

export const settingsMenuLabel = "Settings…";

export function settingsMenuItem(open: () => void, isMac: boolean): MenuItemConstructorOptions {
  return { label: settingsMenuLabel, accelerator: isMac ? "Cmd+," : "Ctrl+,", registerAccelerator: false, click: () => open() };
}
