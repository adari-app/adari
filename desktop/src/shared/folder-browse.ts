// The folder field's list in New workspace and New agent, on
// the dialog's machine, T3 Code's Add project browse: the folder typed so far
// and the last segment as its filter (T3's getFilesystemBrowsePath,
// packages/client-runtime/src/state/filesystem.ts:57), folders whose name
// starts with the filter, hidden ones only when it starts with "."
// (filterFilesystemBrowseEntries, :73), a folder appended to what was typed
// (appendBrowsePathSegment, state/projects.ts:157), and a request whose answer
// is dropped once a newer one was asked (createBrowseNavigationCoordinator,
// :117). Pure, shared by both sides: main lists one folder at a time
// (src/main/folder-browse.ts), the dialogs filter, cap and move
// (src/renderer/components/folder-browse.tsx).

/** What main answers for one folder on a machine. */
export type FolderListing =
  /** The folders directly in it (names, sorted); `truncated`: the folder had more entries than were read. */
  | { readonly type: "listed"; readonly folder: string; readonly names: readonly string[]; readonly truncated: boolean }
  /** Nothing there. */
  | { readonly type: "missing"; readonly folder: string }
  /** A file, not a folder. */
  | { readonly type: "not-folder"; readonly folder: string }
  /** There, but the machine would not let it be read (permission denied, or another failure). */
  | { readonly type: "unreadable"; readonly folder: string; readonly reason: string }
  /** The machine is not answering. */
  | { readonly type: "offline" }
  /** The machine cannot list folders from here. */
  | { readonly type: "unavailable" };

/** The folder to list and the filter, from what is typed; null when the text is not a folder path to browse. */
export interface BrowseQuery {
  /** As typed, ending in "/": "~/", "~/code/", "/Users/demo/", "/". */
  readonly directory: string;
  /** The last segment typed (after the last "/"). */
  readonly filter: string;
}

/** Entries main reads from one folder at most (a folder with more says so). */
export const maxReadEntries = 5_000;
/** Links main follows in one folder to see whether they are folders (a few round trips, never recursive). */
export const maxLinksFollowed = 64;
/** Folders the list shows at most. */
export const maxShownFolders = 200;
/** How long the list waits after a key before it asks the machine (T3 debounces its browse query too). */
export const browseDebounceMs = 150;
/** The longest folder path asked about (New workspace's folder limit). */
export const maxBrowsePathBytes = 4_096;

const unsafe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The folder to list for `typed` and the filter (T3's getFilesystemBrowsePath): a path from the root ("/…") or from
 * the machine's home ("~", "~/…"). Anything else (empty, a relative path, another account's "~name") lists nothing.
 */
export function browseQuery(typed: string): BrowseQuery | null {
  const value = typed.trim();
  if (value === "~") return { directory: "~/", filter: "" };
  if (!value.startsWith("/") && !value.startsWith("~/")) return null;
  const cut = value.lastIndexOf("/") + 1;
  return { directory: value.slice(0, cut), filter: value.slice(cut) };
}

/** A directory main may be asked to list: one line, a "/" or "~/" path ending in "/", within the size limit. */
export function isBrowseDirectory(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("/") || value.startsWith("~/")) &&
    value.endsWith("/") &&
    !unsafe.test(value) &&
    new TextEncoder().encode(value).byteLength <= maxBrowsePathBytes
  );
}

/** Folder names in the order the list shows them: by name, ignoring case and accents, numbers by value (T3's localeCompare). */
export function sortFolderNames(names: Iterable<string>): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The folders the list shows for `filter` (T3's filterFilesystemBrowseEntries): names starting with it, any case;
 * hidden ones only when it starts with "."; at most `maxShownFolders`, with how many more matched.
 */
export function visibleFolders(names: readonly string[], filter: string): { readonly shown: readonly string[]; readonly more: number } {
  const lower = filter.toLowerCase();
  const hidden = filter.startsWith(".");
  const matching = names.filter((name) => name.toLowerCase().startsWith(lower) && (hidden || !name.startsWith(".")));
  return { shown: matching.slice(0, maxShownFolders), more: Math.max(0, matching.length - maxShownFolders) };
}

/** The field once a folder is picked (Enter, a click): the directory typed, then its name (T3's appendBrowsePathSegment, no "/"). */
export function pickedFolder(directory: string, name: string): string {
  return `${directory}${name}`;
}

/** The field after Tab: the folder, with "/", so the list shows what is inside it. */
export function enteredFolder(directory: string, name: string): string {
  return `${directory}${name}/`;
}

/** A folder as a line names it: "~/code" for "~/code/", "/" for "/". */
export function shownDirectory(directory: string): string {
  return directory.length > 1 && directory.endsWith("/") ? directory.slice(0, -1) : directory;
}

export const folderBrowseTexts = {
  loading: "Listing folders…",
  empty: (folder: string) => `No folders in ${folder}`,
  noMatch: (folder: string, filter: string) => `No folder in ${folder} starts with ${filter}`,
  missing: (folder: string, machine: string) => `There is no ${folder} on ${machine}`,
  notFolder: (folder: string, machine: string) => `${folder} is a file on ${machine}, not a folder`,
  unreadable: (folder: string, machine: string, reason: string) => `${machine} cannot read ${folder} (${reason})`,
  offline: (machine: string) => `${machine} is not answering, so its folders cannot be listed`,
  unavailable: (machine: string) => `${machine} cannot list folders from here`,
  failed: (machine: string, reason: string) => `${machine} did not list the folder: ${reason}`,
  more: (count: number) => `${count} more; type to narrow the list`,
  truncated: `The folder holds more than ${maxReadEntries.toLocaleString("en")} entries; only the first were read`,
  keys: "↑ ↓ move · Tab opens · ↩ picks · esc closes",
  choose: "Choose…",
  chooseTitle: "Choose a folder on this Mac",
} as const;

/** The plain line for a listing that shows no folders (null: it shows some). */
export function listingLine(listing: FolderListing, query: BrowseQuery, machine: string, shown: number): string | null {
  const folder = shownDirectory(query.directory);
  switch (listing.type) {
    case "listed":
      if (shown > 0) return null;
      return query.filter === "" ? folderBrowseTexts.empty(folder) : folderBrowseTexts.noMatch(folder, query.filter);
    case "missing":
      return folderBrowseTexts.missing(folder, machine);
    case "not-folder":
      return folderBrowseTexts.notFolder(folder, machine);
    case "unreadable":
      return folderBrowseTexts.unreadable(folder, machine, listing.reason);
    case "offline":
      return folderBrowseTexts.offline(machine);
    case "unavailable":
      return folderBrowseTexts.unavailable(machine);
  }
}
