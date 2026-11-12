// Where GitHub Copilot CLI (Herdr's kind `copilot`) keeps a session, and the one
// remote command that finds it. Pure functions; locator.ts registers them, one line each.
//
// Sources (read-only clones, cited in the round report):
// - github/copilot-sdk d1e6021: a session's state folder is `~/.copilot/session-state/<sessionId>/`
//   (nodejs/README.md:1595, docs/features/session-persistence.md:463); its event log is `events.jsonl`
//   in it (go/internal/e2e/session_fs_e2e_test.go:72, docs/features/session-persistence.md:186-197);
//   the log's `session.start` names the working folder as `data.context.cwd`
//   (nodejs/src/generated/session-events.ts:2077-2205, StartData and WorkingDirectoryContext).
// - Herdr ee5bfb5: the `herdr:copilot` report is the session id from Copilot's SessionStart hook
//   (src/integration/assets/copilot/herdr-agent-state.sh:63-76), resumed as `copilot --resume=<id>`
//   (src/agent_resume.rs:215).

import type { TranscriptLookup } from "../locator";

/** The event log's file name in a session's state folder. */
export const copilotLogName = "events.jsonl";

/** Copilot CLI's session ids are UUIDs (`copilot --resume=<id>`); anything else never reaches a command. */
export function isCopilotSessionID(value: string): boolean {
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value);
}

/** POSIX single-quote escaping (locator.ts shellQuote's rule; not imported, so the two modules never cycle). */
const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

const home = '"$HOME"';
const stateFolder = home + "/" + quote(".copilot") + "/" + quote("session-state");

/** A trailing slash is not the folder's. */
const trimmed = (folder: string): string => {
  let value = folder;
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
};

/** The `"cwd"` member the log's first lines give the folder, both ways it may be spaced (JSON-escaped). */
export function copilotCwdMembers(folder: string): string[] {
  const escaped = trimmed(folder).split("\\").join("\\\\").split('"').join('\\"');
  return [`"cwd":"${escaped}"`, `"cwd": "${escaped}"`];
}

/** The newest sessions a folder lookup looks at, newest first (the pane's own is almost always the newest). */
export const copilotFolderCandidates = 64;
/** How much of a log's start is searched for its folder: `session.start` is its first line, a few hundred bytes. */
export const copilotHeadBytes = 64 * 1_024;
/** And how many of those lines (a rotated log starts with its journal link before `session.start`). */
export const copilotHeadLines = 4;

/** The event log a session id names. */
export function copilotGlobs(id: string): string[] {
  return [stateFolder + "/" + quote(id) + "/" + quote(copilotLogName)];
}

/**
 * The newest event log whose first lines name `folder` as `"cwd"` (grep reads, never writes), skipping
 * the sessions peers name: the newest `copilotFolderCandidates` logs by modification time, each read for
 * at most `copilotHeadBytes`. One `/bin/sh` command; always exits 0.
 */
export function copilotFolderCommand(folder: string, exclude: readonly string[]): string {
  const glob = stateFolder + "/*/" + quote(copilotLogName);
  const patterns = copilotCwdMembers(folder)
    .map((pattern) => "-e " + quote(pattern))
    .join(" ");
  const skip = exclude.length === 0 ? "" : ' case "$f" in ' + exclude.map((id) => "*/" + quote(id) + "/" + quote(copilotLogName)).join("|") + ") continue;; esac;";
  const script =
    "set --; for f in " +
    glob +
    '; do [ -f "$f" ] && set -- "$@" "$f"; done; ' +
    '[ "$#" -gt 0 ] || exit 0; ' +
    `/bin/ls -t -- "$@" | /usr/bin/head -n ${copilotFolderCandidates} | while IFS= read -r f; do` +
    skip +
    ` /usr/bin/head -c ${copilotHeadBytes} -- "$f" | /usr/bin/head -n ${copilotHeadLines} | /usr/bin/grep -qsF ` +
    patterns +
    " && { printf '%s\\n' \"$f\"; break; }; done; exit 0";
  return "/bin/sh -c " + quote(script);
}

/** The session a log path is filed under (`…/.copilot/session-state/<id>/events.jsonl`), or null for another path. */
export function copilotSessionOfPath(path: string): string | null {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length < 4 || parts.at(-1) !== copilotLogName || parts.at(-3) !== "session-state" || parts.at(-4) !== ".copilot") return null;
  const id = parts.at(-2)!;
  return isCopilotSessionID(id) ? id : null;
}

/** The path a locate command printed, when it is the log asked for (an already checked usable path). */
export function copilotLocated(line: string, lookup: TranscriptLookup): string | null {
  const session = copilotSessionOfPath(line);
  if (session === null) return null;
  switch (lookup.kind) {
    case "id":
      return session === lookup.id ? line : null;
    case "folder":
      return (lookup.exclude ?? []).includes(session) ? null : line;
    case "path":
      return null;
  }
}

/** The session id a lookup names: its id, or the folder its log path is filed in; null for a folder lookup. */
export function copilotSessionIDOf(lookup: TranscriptLookup): string | null {
  if (lookup.kind === "id") return isCopilotSessionID(lookup.id) ? lookup.id : null;
  return lookup.kind === "path" ? copilotSessionOfPath(lookup.path) : null;
}

/** Whether `path` is the log of a session a folder lookup skips (a peer's). */
export function copilotLookupExcludes(lookup: TranscriptLookup, path: string): boolean {
  if (lookup.kind !== "folder" || lookup.exclude === undefined) return false;
  const session = copilotSessionOfPath(path);
  return session !== null && lookup.exclude.includes(session);
}

/** The session `copilot --resume=<id>`, `--resume <id>` or `-r <id>` names (a UUID); null for none or a bare `--resume`. */
export function copilotResumeID(argv: readonly string[]): string | null {
  let id: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if ((word === "--resume" || word === "-r") && index + 1 < argv.length) id = argv[index + 1]!;
    else if (word.startsWith("--resume=")) id = word.slice("--resume=".length);
  }
  return id !== null && isCopilotSessionID(id) ? id : null;
}

/** The note a pane of this kind shows when another Copilot pane naming no session is in its folder (ChatView's text). */
export function copilotAmbiguousReason(kind: string | null | undefined): "ambiguousCopilotSession" | null {
  const name = kind?.toLowerCase();
  return name === "copilot" || name === "github-copilot" ? "ambiguousCopilotSession" : null;
}
