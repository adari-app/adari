// About's one "Open-source licenses" link (T3 Code's About has
// the same one row: apps/web/src/components/settings/SettingsPanels.tsx, "Open-
// source licenses", View licenses). It opens THIRD_PARTY_NOTICES.md, the
// notices and licence texts every package ships (electron-builder.config.cjs
// `files`: the root of app.asar; desktop/THIRD_PARTY_NOTICES.md in the repo),
// in the Mac's own viewer. A file inside app.asar is no file to another app, so
// it is copied out first, byte for byte, into the app's own folder (userData);
// a development run's file (a real folder) opens where it is. When no app
// opens Markdown, the same text opens as a .txt, which every Mac opens
// (TextEdit). Nothing is fetched: the file is the one the build carries.

import fs from "node:fs/promises";
import path from "node:path";

export const noticesFileName = "THIRD_PARTY_NOTICES.md";

export interface LicensesSite {
  /** The app's own folder (app.getAppPath(): …/app.asar when packaged, desktop/ in a development run). */
  readonly appPath: string;
  /** Where a copy may be written (app.getPath("userData")). */
  readonly userData: string;
  /** Opens a file in its default app: "" when it opened, else why not (shell.openPath). */
  open(file: string): Promise<string>;
}

/** Whether `file` is inside an asar archive (Electron reads it; no other app can). */
export function insideAsar(file: string): boolean {
  return file.split(/[\\/]/).some((part) => part.endsWith(".asar"));
}

/** Opens the shipped notices: null once a viewer opened them, else why not, in words. */
export async function openShippedLicenses(site: LicensesSite): Promise<string | null> {
  const shipped = path.join(site.appPath, noticesFileName);
  let text: Buffer;
  try {
    text = await fs.readFile(shipped);
  } catch {
    return `${noticesFileName} is not in this build.`;
  }
  let file = shipped;
  if (insideAsar(shipped)) {
    file = path.join(site.userData, noticesFileName);
    try {
      await fs.mkdir(site.userData, { recursive: true });
      await fs.writeFile(file, text, { mode: 0o644 });
    } catch (error) {
      return `Could not copy ${noticesFileName} out of the app: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const opened = await site.open(file);
  if (opened === "") return null;
  // No viewer for Markdown here: the same text as plain text.
  const plain = path.join(site.userData, noticesFileName.replace(/\.md$/, ".txt"));
  try {
    await fs.mkdir(site.userData, { recursive: true });
    await fs.writeFile(plain, text, { mode: 0o644 });
  } catch {
    return `Could not open ${noticesFileName}: ${opened}`;
  }
  const again = await site.open(plain);
  return again === "" ? null : `Could not open ${noticesFileName}: ${again}`;
}
