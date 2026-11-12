// A folder goes to Herdr as a cwd only as an absolute path on that machine.
// Herdr does not expand `~` (on a clean home with Herdr 0.9.5,
// `workspace.create` with cwd `~/code/hello-app` gives a shell in the home
// folder, with no error), so `~`
// and `~/…` are resolved here to the machine's home, the same home the folder
// list reads (folder-browse.ts browseFolder: the reader's `home()`, SFTP's
// realpath of "."), as T3 Code expands a typed path before it uses one
// (packages/provider-core/src/server/pathExpansion.ts:5-12 expandHomePath,
// called by apps/server/src/workspace/WorkspacePaths.ts:137
// normalizeWorkspaceRoot). An absolute path is sent as it is; anything else
// (a relative path, another account's `~name`) is refused in plain words and
// nothing is sent. Every sender of a typed or remembered folder uses this one
// helper: New workspace (new-workspace.ts), New agent's tab, split and shell
// (new-agent.ts), the terminal drawer's shell (drawer-shell.ts).
//
// The check of where a new pane landed lives here too: the folder sent and the
// one Herdr's answer says its new pane is in, trailing slashes ignored.

import path from "node:path";

/** The machine a folder is resolved on: its name (for the notes) and its home, read only when a `~` path needs it. */
export interface FolderMachine {
  readonly name: string;
  /** The login (home) folder; absent where the machine cannot say (a `~` path is then refused). */
  home?(): Promise<string>;
}

/** A folder refused before anything was sent (its message is the note to show). */
export class FolderRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderRefused";
  }
}

const reasonOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() === "" ? "it did not say why" : text.trim().slice(0, 160);
};

/** Trailing slashes off (the root stays "/"). */
function trimmed(folder: string): string {
  let out = folder;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export const folderTexts = {
  homeUnreadable: (machine: string, reason: string) => `Could not read ${machine}'s home folder: ${reason}`,
  otherAccount: (folder: string) => `“${folder}” is another account's home folder. Type the whole path, starting with /.`,
  relative: (folder: string) => `“${folder}” is not a whole path. Type one starting with / or ~/.`,
} as const;

/**
 * The cwd to send for `folder` on `machine`: null for none (null or blank), the path itself when absolute, the
 * machine's home joined with the rest for `~` and `~/…`. Throws FolderRefused for any other folder, or when the home
 * cannot be read.
 */
export async function resolveFolderCwd(folder: string | null, machine: FolderMachine): Promise<string | null> {
  if (folder === null) return null;
  const typed = folder.trim();
  if (typed === "") return null;
  if (typed.startsWith("/")) return typed;
  if (typed !== "~" && !typed.startsWith("~/")) {
    throw new FolderRefused(typed.startsWith("~") ? folderTexts.otherAccount(typed) : folderTexts.relative(typed));
  }
  let home: string;
  try {
    if (machine.home === undefined) throw new Error("this machine cannot say from here");
    home = await machine.home();
  } catch (error) {
    throw new FolderRefused(folderTexts.homeUnreadable(machine.name, reasonOf(error)));
  }
  if (typeof home !== "string" || !home.startsWith("/")) {
    throw new FolderRefused(folderTexts.homeUnreadable(machine.name, "it did not give a whole path"));
  }
  return trimmed(typed === "~" ? path.posix.normalize(home) : path.posix.join(home, typed.slice(2)));
}

/** The same folder, trailing slashes and `.` steps ignored. */
export function sameFolder(a: string, b: string): boolean {
  return trimmed(path.posix.normalize(a)) === trimmed(path.posix.normalize(b));
}

/**
 * Where Herdr's answer says the new pane's shell is, when that is not the folder sent (null: it is, or
 * either is not known). Never retried, nothing closed: the caller only says so.
 */
export function placedElsewhere(sent: string | null, reported: string | undefined): string | null {
  if (sent === null || reported === undefined || reported.trim() === "") return null;
  return sameFolder(sent, reported) ? null : trimmed(reported);
}
