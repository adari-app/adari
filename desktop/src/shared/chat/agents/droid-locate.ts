// Where Factory's Droid CLI (Herdr's kind `droid`) keeps a session, and the one remote
// command that finds it. Pure functions; locator.ts registers them, one line each.
//
// Sources (read-only clones, cited in the round report):
// - Factory-AI/droid-sdk-python aa6fd94, src/droid_sdk/_high_level/discovery.py: sessions live under
//   `~/.factory/sessions` (:16-17), a working folder's in `-<the resolved folder, "/" as "-">` (:20-29),
//   one `<session id>.jsonl` each (:70-89; older ones directly in the sessions folder, :59-68 and :97),
//   whose first line is `{"type":"session_start", "cwd": …}` (:132-148), `<id>.settings.json` beside it (:150).
// - Herdr ee5bfb5: the `herdr:droid` report is the session id from Droid's SessionStart hook
//   (src/integration/assets/droid/herdr-agent-state.sh:50-65), resumed as `droid --resume <id>`
//   (src/agent_resume.rs:221); Factory-AI/factory 892925c docs/reference/hooks-reference.mdx:305 shows
//   a session's transcript named by its UUID.

import type { TranscriptLookup } from "../locator";

/** Droid's session ids are UUIDs (the hooks reference's `…/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl`). */
export function isDroidSessionID(value: string): boolean {
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value);
}

/** POSIX single-quote escaping (locator.ts shellQuote's rule; not imported, so the two modules never cycle). */
const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

const home = '"$HOME"';
const sessionsFolder = home + "/" + quote(".factory") + "/" + quote("sessions");

/** A trailing slash is not the folder's. */
const trimmed = (folder: string): string => {
  let value = folder;
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
};

/** The folder Droid files a working folder's sessions in: `-` and the path with every `/` as `-` (discovery.py:20-29). */
export function droidProjectName(folder: string): string {
  return "-" + trimmed(folder).replace(/^\/+/, "").split("/").join("-");
}

/** The `"cwd"` member a session's first line gives the folder, both ways it may be spaced (JSON-escaped). */
export function droidCwdMembers(folder: string): string[] {
  const escaped = trimmed(folder).split("\\").join("\\\\").split('"').join('\\"');
  return [`"cwd":"${escaped}"`, `"cwd": "${escaped}"`];
}

/** The newest sessions a folder lookup looks at, newest first. */
export const droidFolderCandidates = 64;
/** How much of a session's start is searched for its folder (its first line, the `session_start`). */
export const droidHeadBytes = 64 * 1_024;

/** The session file an id names: filed under any folder, or an older one in the sessions folder itself. */
export function droidGlobs(id: string): string[] {
  const file = quote(id + ".jsonl");
  return [sessionsFolder + "/*/" + file, sessionsFolder + "/" + file];
}

/**
 * The newest session filed under `folder` whose first line names it as `"cwd"` (grep reads, never writes),
 * skipping the sessions peers name: the newest `droidFolderCandidates` by modification time, each read for at
 * most `droidHeadBytes`. One `/bin/sh` command; always exits 0.
 */
export function droidFolderCommand(folder: string, exclude: readonly string[]): string {
  const glob = sessionsFolder + "/" + quote(droidProjectName(folder)) + "/*" + quote(".jsonl");
  const patterns = droidCwdMembers(folder)
    .map((pattern) => "-e " + quote(pattern))
    .join(" ");
  const skip = exclude.length === 0 ? "" : ' case "$f" in ' + exclude.map((id) => "*/" + quote(id + ".jsonl")).join("|") + ") continue;; esac;";
  const script =
    "set --; for f in " +
    glob +
    '; do [ -f "$f" ] && set -- "$@" "$f"; done; ' +
    '[ "$#" -gt 0 ] || exit 0; ' +
    `/bin/ls -t -- "$@" | /usr/bin/head -n ${droidFolderCandidates} | while IFS= read -r f; do` +
    skip +
    ` /usr/bin/head -c ${droidHeadBytes} -- "$f" | /usr/bin/head -n 1 | /usr/bin/grep -qsF ` +
    patterns +
    " && { printf '%s\\n' \"$f\"; break; }; done; exit 0";
  return "/bin/sh -c " + quote(script);
}

/** The session a path is (`…/.factory/sessions/[<folder name>/]<id>.jsonl`), or null for another path. */
export function droidSessionOfPath(path: string): string | null {
  const parts = path.split("/").filter((part) => part.length > 0);
  const name = parts.at(-1) ?? "";
  if (!name.endsWith(".jsonl")) return null;
  const filed = parts.at(-3) === "sessions" && parts.at(-4) === ".factory";
  const older = parts.at(-2) === "sessions" && parts.at(-3) === ".factory";
  if (!filed && !older) return null;
  const id = name.slice(0, -".jsonl".length);
  return isDroidSessionID(id) ? id : null;
}

/** The path a locate command printed, when it is the session asked for (an already checked usable path). */
export function droidLocated(line: string, lookup: TranscriptLookup): string | null {
  const session = droidSessionOfPath(line);
  if (session === null) return null;
  switch (lookup.kind) {
    case "id":
      return session === lookup.id ? line : null;
    case "folder": {
      const parts = line.split("/").filter((part) => part.length > 0);
      if (parts.at(-2) !== droidProjectName(lookup.folder) || parts.at(-3) !== "sessions") return null;
      return (lookup.exclude ?? []).includes(session) ? null : line;
    }
    case "path":
      return null;
  }
}

/** The session id a lookup names: its id, or the one its path is; null for a folder lookup. */
export function droidSessionIDOf(lookup: TranscriptLookup): string | null {
  if (lookup.kind === "id") return isDroidSessionID(lookup.id) ? lookup.id : null;
  return lookup.kind === "path" ? droidSessionOfPath(lookup.path) : null;
}

/** Whether `path` is a session a folder lookup skips (a peer's). */
export function droidLookupExcludes(lookup: TranscriptLookup, path: string): boolean {
  if (lookup.kind !== "folder" || lookup.exclude === undefined) return false;
  const session = droidSessionOfPath(path);
  return session !== null && lookup.exclude.includes(session);
}

/** The session `droid --resume <id>`, `--resume=<id>` or `-r <id>` names (a UUID); null for none. */
export function droidResumeID(argv: readonly string[]): string | null {
  let id: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if ((word === "--resume" || word === "-r") && index + 1 < argv.length) id = argv[index + 1]!;
    else if (word.startsWith("--resume=")) id = word.slice("--resume=".length);
  }
  return id !== null && isDroidSessionID(id) ? id : null;
}

/** The note a pane of this kind shows when another Droid pane naming no session is in its folder (ChatView's text). */
export function droidAmbiguousReason(kind: string | null | undefined): "ambiguousDroidSession" | null {
  return kind?.toLowerCase() === "droid" ? "ambiguousDroidSession" : null;
}
