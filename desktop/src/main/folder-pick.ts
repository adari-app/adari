// This Mac's Choose… beside the folder field (T3 Code's
// pickFolder: apps/desktop/src/preload.ts:198, its handler in
// apps/desktop/src/ipc/methods/window.ts:197): the macOS folder window
// (Electron's dialog.showOpenDialog with openDirectory), starting at the
// folder typed when it is one on this Mac, else at the home folder. Only for
// This Mac: a remote machine's folders are not on this disk, so its list is
// the picker (ipc.ts refuses Choose… for any other machine).

import os from "node:os";
import path from "node:path";
import { statSync } from "node:fs";

import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";

export const folderPickTexts = {
  title: "Choose a folder",
  button: "Choose",
  onlyThisMac: "Only This Mac's folders can be chosen in a window; type a folder on that machine to see its list.",
  notAvailable: "Choosing a folder is not available here.",
} as const;

/** The typed folder as a path on this Mac ("~" its home); null when it is not a folder path. */
export function typedFolderOnThisMac(typed: string, home: string): string | null {
  const value = typed.trim();
  if (value === "~") return home;
  const full = value.startsWith("~/") ? path.join(home, value.slice(2)) : value.startsWith("/") ? path.normalize(value) : null;
  return full !== null && full.length > 1 && full.endsWith("/") ? full.slice(0, -1) : full;
}

const isFolderHere = (target: string): boolean => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};

/** Where the window starts: the typed folder when it is a folder on this Mac, else the home folder. */
export function folderPickStart(typed: string, home: string, isFolder: (target: string) => boolean = isFolderHere): string {
  const wanted = typedFolderOnThisMac(typed, home);
  return wanted !== null && isFolder(wanted) ? wanted : home;
}

/** The options the folder window opens with. */
export function folderPickOptions(start: string): OpenDialogOptions {
  return { title: folderPickTexts.title, buttonLabel: folderPickTexts.button, defaultPath: start, properties: ["openDirectory", "createDirectory"] };
}

/** Opens the folder window (`open`: Electron's dialog.showOpenDialog, for the window asking); the folder chosen, or null. */
export async function pickFolderOnThisMac(
  open: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
  typed: string,
  home: string = os.homedir(),
  isFolder: (target: string) => boolean = isFolderHere,
): Promise<string | null> {
  const result = await open(folderPickOptions(folderPickStart(typed, home, isFolder)));
  return result.canceled ? null : (result.filePaths[0] ?? null);
}
