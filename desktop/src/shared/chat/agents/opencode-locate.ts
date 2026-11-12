// Where OpenCode and Kilo keep a pane's session, and how Chat finds it.
//
// OpenCode (V1, 1.18.x; V2, 2.x) and Kilo's CLI keep every session of the user in one SQLite
// database in their xdg data folder, `~/.local/share/<app>/<app>.db`:
// - OpenCode V1: `Global.Path.data` is `<xdgData>/opencode` (opencode v1.18.29
//   packages/core/src/global.ts:10-11), the file `opencode.db` (packages/core/src/database/database.ts:53);
// - OpenCode V2: the same folder and file (opencode 2.2.5 packages/cli/src/database-path.ts:4-12);
// - Kilo: Kilo's CLI is an OpenCode V1 fork (kilocode `.opencode-version` v1.18.26, its CLI in
//   packages/opencode) with the same tables (packages/core/src/session/sql.ts), the app named `kilo`
//   (packages/core/src/global.ts) and the file `kilo.db` (packages/opencode/src/storage/db.ts:33-41).
// So the two agents share one reader (agents/opencode-store.ts, agents/opencode-parser.ts).
//
// A session id is `ses_` and 26 letters and digits (packages/schema/src/session-id.ts:5-14,
// identifier.ts:1-30). Herdr reports it as `herdr:opencode` / `herdr:kilo` with kind `id` (Herdr
// src/agent_resume.rs:249-261; its plugins src/integration/assets/opencode/herdr-tui-session.js,
// kilo/herdr-agent-state.js report the pane's root session). A pane runs `opencode --session <id>`
// or `-s <id>` (v1.18.29 packages/opencode/src/cli/cmd/tui.ts:91-95); `--fork` makes a new session.
//
// Chat names an OpenCode session by a view path, `<database>/<session id>`: no file can be there
// (the database is a file), and the transcript reader reads such a path as the session's JSONL view
// (OpenCodeStoreView), never over SFTP.
//
// This file imports nothing but types from locator.ts (locator.ts registers these functions).

import type { AgentSessionLike, ChatSession, GrokPeerPane, TranscriptLookup, TranscriptSessionRef } from "../locator";

/** The two agents this reader serves (Herdr's kinds). */
export type OpenCodeFormat = "opencode" | "kilo";

export const openCodeFormats: readonly OpenCodeFormat[] = ["opencode", "kilo"];

export const isOpenCodeFormat = (value: string | null | undefined): value is OpenCodeFormat => value === "opencode" || value === "kilo";

/** Each agent's folder under the xdg data folder and its database's name. */
export const openCodeDatabases: Readonly<Record<OpenCodeFormat, { readonly folder: string; readonly file: string }>> = {
  opencode: { folder: "opencode", file: "opencode.db" },
  kilo: { folder: "kilo", file: "kilo.db" },
};

/** `ses_` then letters and digits (OpenCode makes 26); nothing else ever reaches a command or a query. */
export function isOpenCodeSessionID(value: string): boolean {
  return /^ses_[0-9A-Za-z]{8,60}$/.test(value);
}

const maxPathBytes = 4_096;

const hasControl = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const usableAbsolute = (value: string): boolean =>
  value.startsWith("/") &&
  new TextEncoder().encode(value).length <= maxPathBytes &&
  !hasControl(value) &&
  !value.split("/").some((part) => part === "." || part === "..");

/** The agent whose database `path` is: absolute, ending `/.local/share/<app>/<app>.db`; null for any other path. */
export function openCodeDatabaseFormat(path: string): OpenCodeFormat | null {
  if (!usableAbsolute(path)) return null;
  const parts = path.split("/");
  const n = parts.length;
  if (n < 5 || parts[n - 3] !== "share" || parts[n - 4] !== ".local") return null;
  for (const format of openCodeFormats) {
    const names = openCodeDatabases[format];
    if (parts[n - 1] === names.file && parts[n - 2] === names.folder) return format;
  }
  return null;
}

/** A view path's parts. */
export interface OpenCodeViewPath {
  readonly format: OpenCodeFormat;
  readonly database: string;
  readonly session: string;
}

/** `<database>/<session id>`, or null for anything else. */
export function parseOpenCodeViewPath(path: string): OpenCodeViewPath | null {
  if (!usableAbsolute(path)) return null;
  const slash = path.lastIndexOf("/");
  const session = path.slice(slash + 1);
  const database = path.slice(0, slash);
  if (!isOpenCodeSessionID(session)) return null;
  const format = openCodeDatabaseFormat(database);
  return format === null ? null : { format, database, session };
}

export const isOpenCodeViewPath = (path: string): boolean => parseOpenCodeViewPath(path) !== null;

/** The view path of `session` in `database`. */
export const openCodeViewPath = (database: string, session: string): string => database + "/" + session;

/** The session id a view path names; null for another path. */
export const openCodeSessionOfPath = (path: string): string | null => parseOpenCodeViewPath(path)?.session ?? null;

/** The agent of a Herdr session source (`herdr:opencode`, `herdr:kilo`); null for any other. */
export function openCodeFormatOfSource(source: string): OpenCodeFormat | null {
  if (source === "herdr:opencode") return "opencode";
  if (source === "herdr:kilo") return "kilo";
  return null;
}

const trimmedFolder = (folder: string): string => {
  let trimmed = folder;
  while (trimmed.length > 1 && trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return trimmed;
};

/** At most this many peers' sessions are skipped by a folder lookup; more is refused. */
export const maxOpenCodeExcluded = 64;

/**
 * makeSessionRef for OpenCode and Kilo: an id is an OpenCode session id; a path is a view path of
 * this agent's database; a folder is absolute with no control characters, its exclusions session ids.
 */
export function openCodeSessionRef(format: OpenCodeFormat, lookup: TranscriptLookup): TranscriptSessionRef | null {
  switch (lookup.kind) {
    case "id":
      if (!isOpenCodeSessionID(lookup.id)) return null;
      break;
    case "path":
      if (parseOpenCodeViewPath(lookup.path)?.format !== format) return null;
      break;
    case "folder":
      if (!lookup.folder.startsWith("/") || new TextEncoder().encode(lookup.folder).length > maxPathBytes || hasControl(lookup.folder)) return null;
      if (lookup.exclude !== undefined && (lookup.exclude.length > maxOpenCodeExcluded || !lookup.exclude.every(isOpenCodeSessionID))) return null;
      break;
  }
  return { format, lookup };
}

/** From Herdr's `agent_session` (`herdr:opencode` / `herdr:kilo`, kind `id`); null for another source or a bad id. */
export function openCodeRefFromAgentSession(session: AgentSessionLike): TranscriptSessionRef | null {
  const format = openCodeFormatOfSource(session.source);
  if (format === null || session.kind !== "id") return null;
  return openCodeSessionRef(format, { kind: "id", id: session.value });
}

/**
 * The session an `opencode` / `kilo` argv names: `--session <id>`, `-s <id>`, `--session=<id>`; none with
 * `--fork` (that run writes a new session) or for an id that is not one.
 */
export function openCodeSessionFromArgv(argv: readonly string[], kind: OpenCodeFormat): AgentSessionLike | null {
  let id: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (word === "--fork" || word.startsWith("--fork=")) return null;
    if ((word === "--session" || word === "-s") && index + 1 < argv.length) id = argv[index + 1]!;
    else if (word.startsWith("--session=")) id = word.slice("--session=".length);
  }
  if (id === null || !isOpenCodeSessionID(id)) return null;
  return { source: `herdr:${kind}`, agent: kind, kind: "id", value: id };
}

// MARK: - finding the session (one /bin/sh command, read only)

const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

/** A SQL string literal (single quotes doubled); only checked values reach it. */
const sqlText = (value: string): string => "'" + value.split("'").join("''") + "'";

/** The database a `$HOME` command names, every literal part quoted. */
const databaseWord = (format: OpenCodeFormat): string => {
  const names = openCodeDatabases[format];
  return '"$HOME"/' + quote(".local") + "/" + quote("share") + "/" + quote(names.folder) + "/" + quote(names.file);
};

/**
 * The folder rule's query: the newest root session (no parent) filed under exactly `folder`, none a peer
 * names, in V2's table (`session_v2`, opencode 2.2.5 packages/core/src/session/sql.ts:28-84) or V1's
 * (`session`, v1.18.29 packages/core/src/session/sql.ts:22-64; Kilo's the same).
 */
export function openCodeFolderSQL(folder: string, exclude: readonly string[], table: "session_v2" | "session"): string {
  const skip = exclude.length === 0 ? "" : " and id not in (" + exclude.map(sqlText).join(",") + ")";
  const prefix = table === "session_v2" ? "v2 " : "v1 ";
  return `select '${prefix}'||id from ${table} where directory=${sqlText(trimmedFolder(folder))} and parent_id is null${skip} order by time_updated desc, id desc limit 1;`;
}

/** The read-only sqlite3 runner the folder command defines (`q <sql>`): `mode=ro`, else `mode=ro&immutable=1`. */
const queryFunction =
  'q() { r=1; if [ ! -f "$d-wal" ] || [ -f "$d-shm" ]; then /usr/bin/sqlite3 -init /dev/null -readonly -batch "file:$d?mode=ro" "$1" 2>/dev/null && r=0; fi; ' +
  'if [ "$r" != 0 ]; then /usr/bin/sqlite3 -init /dev/null -readonly -batch "file:$d?mode=ro&immutable=1" "$1" 2>/dev/null; fi; }; ';

/**
 * One `/bin/sh` command that prints the session's view path, or nothing; always exits 0.
 * - id: the agent's database when it is a regular file, then `/<id>` (the view finds the session in it);
 * - folder: sqlite3 read only (`mode=ro`, or `mode=ro&immutable=1` when a -wal is there without its
 *   -shm or the first open fails: never a file made in the agent's folder, as cursor-store.ts) asks
 *   V2's table, then V1's, for the folder's newest root session, and prints its view path. A `$HOME`
 *   holding `?`, `#` or `%` (it would not read as a URI) finds none.
 * Null for a path lookup or anything not valid.
 */
export function openCodeLocateCommand(ref: TranscriptSessionRef): string | null {
  if (!isOpenCodeFormat(ref.format)) return null;
  const checked = openCodeSessionRef(ref.format, ref.lookup);
  if (checked === null) return null;
  const lookup = checked.lookup;
  const database = databaseWord(ref.format);
  if (lookup.kind === "path") return null;
  if (lookup.kind === "id") {
    const script = "d=" + database + '; [ -f "$d" ] && printf ' + quote("%s/%s\\n") + ' "$d" ' + quote(lookup.id) + "; exit 0";
    return "/bin/sh -c " + quote(script);
  }
  const exclude = lookup.exclude ?? [];
  const ask = (table: "session_v2" | "session"): string => "q " + quote(openCodeFolderSQL(lookup.folder, exclude, table)) + " | /usr/bin/head -n 1";
  const script =
    "d=" +
    database +
    '; [ -f "$d" ] || exit 0; case "$d" in *[?#%]*) exit 0;; esac; ' +
    queryFunction +
    "s=$(" +
    ask("session_v2") +
    '); [ -n "$s" ] || s=$(' +
    ask("session") +
    '); [ -n "$s" ] && printf ' +
    quote("%s/%s\\n") +
    ' "$d" "${s#v? }"; exit 0';
  return "/bin/sh -c " + quote(script);
}

/** The view path the command printed, when it is this agent's and the session asked for (an id) or not excluded (a folder). */
export function parseOpenCodeLocateOutput(output: string, ref: TranscriptSessionRef): string | null {
  const lookup = ref.lookup;
  if (lookup.kind === "path" || !isOpenCodeFormat(ref.format)) return null;
  const line = output
    .split(/[\n\r]/)
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ""))
    .find((part) => part.length > 0);
  if (line === undefined) return null;
  const view = parseOpenCodeViewPath(line);
  if (view === null || view.format !== ref.format) return null;
  if (lookup.kind === "id") return view.session === lookup.id ? line : null;
  return (lookup.exclude ?? []).includes(view.session) ? null : line;
}

// MARK: - two panes in one folder (the Grok and Cursor rule)

/** The note a pane shows when another of its agent's panes naming no session is in its folder (ChatView's texts). */
export const openCodeAmbiguousNote = "Two OpenCode sessions are open in this folder, so Chat can't tell which is this pane's";
export const kiloAmbiguousNote = "Two Kilo sessions are open in this folder, so Chat can't tell which is this pane's";

/** ChatView's reason for the pane's agent kind; null for another kind. */
export function openCodeAmbiguousReason(agent: string | null | undefined): "ambiguousOpenCodeSession" | "ambiguousKiloSession" | null {
  const kind = agent?.toLowerCase();
  return kind === "opencode" ? "ambiguousOpenCodeSession" : kind === "kilo" ? "ambiguousKiloSession" : null;
}

const peerFolder = (peer: GrokPeerPane): string | undefined =>
  [peer.cwd, peer.foregroundCWD].map((value) => (value === undefined ? "" : trimmedFolder(value))).find((value) => value.startsWith("/") && !hasControl(value));

/**
 * What a pane of `session`'s agent that follows its folder follows, `peers` the machine's agent panes:
 * refused ("ambiguous") when another pane of the same agent naming no session is in the same folder,
 * or a peer of that agent names a session that cannot be told, or too many do; else the folder's newest
 * session that no peer names (their ids excluded from the lookup). A session named (an id or a path) is
 * returned as it is.
 */
export function openCodePeerSession(session: ChatSession, paneID: string, peers: readonly GrokPeerPane[]): ChatSession | "ambiguous" {
  const lookup = session.ref.lookup;
  const kind = session.ref.format;
  if (!isOpenCodeFormat(kind) || lookup.kind !== "folder") return session;
  const folder = trimmedFolder(lookup.folder);
  const exclude = new Set<string>(lookup.exclude ?? []);
  for (const peer of peers) {
    if (peer.paneID === paneID || peer.agent?.toLowerCase() !== kind) continue;
    const named = peer.agentSession === undefined ? null : openCodeRefFromAgentSession(peer.agentSession);
    if (named === null) {
      // A peer of the same agent naming nothing, in this folder: neither can be told from the other.
      if (peerFolder(peer) === folder) return "ambiguous";
      continue;
    }
    if (named.format !== kind || named.lookup.kind !== "id") return "ambiguous";
    exclude.add(named.lookup.id);
  }
  if (exclude.size === (lookup.exclude ?? []).length) return session;
  const ref = openCodeSessionRef(kind, { kind: "folder", folder: lookup.folder, exclude: [...exclude].sort() });
  return ref === null ? "ambiguous" : { ...session, ref };
}
