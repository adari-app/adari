// Where Hermes keeps a pane's session, and how Chat finds it.
//
// Hermes keeps every session of a profile in one SQLite database, `<Hermes home>/state.db`
// (hermes-agent hermes_state.py:181 `DEFAULT_DB_PATH = get_hermes_home() / "state.db"`), the home being
// `$HERMES_HOME`, else `~/.hermes` plus `HERMES_DATA_DIR_SUFFIX` (hermes_constants.py:57-64, :194-201,
// :243-252); a named profile's home is `~/.hermes/profiles/<name>` (hermes_constants.py:99-107). Tables
// `sessions` and `messages` (hermes_state_common.py:467-535, :537-567).
//
// A session id is `YYYYMMDD_HHMMSS_<hex>` from the CLI (hermes_state_ids.py:16, :55-59), other surfaces mint
// `cron_…`, `bg_…`, `api_…`, `run_…` or a UUID (hermes_state_ids.py:20-40): letters, digits, `_`, `-`, `.`.
// Herdr reports the pane's session as `herdr:hermes`, kind `id` (Herdr src/agent_resume.rs:242-248, :340); a
// pane runs `hermes --resume <id>` or `-r <id>` (hermes_cli/_parser.py:179).
//
// Chat names a Hermes session by a view path, `<state.db>#<session id>`: no file is there, and the
// transcript reader reads such a path as the session's JSONL view (agents/hermes-store.ts), never over SFTP.
// Hermes panes bind by Herdr's id (or the argv's) only, never by folder: a profile's database holds every
// folder's sessions, and the session's own `cwd` is checked against the pane's before anything shows.
//
// This file imports nothing but types from locator.ts (locator.ts registers these functions).

import type { AgentSessionLike, TranscriptLookup, TranscriptSessionRef } from "../locator";

export type HermesFormat = "hermes";

export const isHermesFormat = (value: string | null | undefined): value is HermesFormat => value === "hermes";

/** Letters, digits, `_`, `-` and `.` (every shape hermes_state_ids.py mints); nothing else reaches a command or a query. */
export function isHermesSessionID(value: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(value);
}

const maxPathBytes = 4_096;

const hasControl = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** A Hermes database path: absolute, `…/.hermes…/…/state.db`, no `#`, no control characters, no `.` or `..`. */
export function isHermesDatabase(path: string): boolean {
  if (!path.startsWith("/") || new TextEncoder().encode(path).length > maxPathBytes || hasControl(path) || path.includes("#")) return false;
  const parts = path.split("/");
  if (parts[parts.length - 1] !== "state.db" || parts.some((part) => part === "." || part === "..")) return false;
  return parts.slice(0, -1).some((part) => part.startsWith(".hermes"));
}

/** A view path's parts. */
export interface HermesViewPath {
  readonly database: string;
  readonly session: string;
}

/** `<state.db>#<session id>`, or null for anything else. */
export function parseHermesViewPath(path: string): HermesViewPath | null {
  const mark = path.lastIndexOf("#");
  if (mark <= 0) return null;
  const database = path.slice(0, mark);
  const session = path.slice(mark + 1);
  return isHermesDatabase(database) && isHermesSessionID(session) ? { database, session } : null;
}

export const isHermesViewPath = (path: string): boolean => parseHermesViewPath(path) !== null;

/** The view path of `session` in `database`. */
export const hermesViewPath = (database: string, session: string): string => database + "#" + session;

/** makeSessionRef for Hermes: an id, or a view path; never a folder (a database holds every folder's sessions). */
export function hermesSessionRef(lookup: TranscriptLookup): TranscriptSessionRef | null {
  if (lookup.kind === "id") return isHermesSessionID(lookup.id) ? { format: "hermes", lookup } : null;
  if (lookup.kind === "path") return isHermesViewPath(lookup.path) ? { format: "hermes", lookup } : null;
  return null;
}

/** From Herdr's `agent_session` (`herdr:hermes`, kind `id`); null for another source or a bad id. */
export function hermesRefFromAgentSession(session: AgentSessionLike): TranscriptSessionRef | null {
  if (session.source !== "herdr:hermes" || session.kind !== "id") return null;
  return hermesSessionRef({ kind: "id", id: session.value });
}

/** The session a `hermes` argv names: `--resume <id>`, `-r <id>`, `--resume=<id>` (hermes_cli/_parser.py:179); none for a bad id. */
export function hermesSessionFromArgv(argv: readonly string[]): AgentSessionLike | null {
  let id: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if ((word === "--resume" || word === "-r") && index + 1 < argv.length) id = argv[index + 1]!;
    else if (word.startsWith("--resume=")) id = word.slice("--resume=".length);
  }
  if (id === null || !isHermesSessionID(id)) return null;
  return { source: "herdr:hermes", agent: "hermes", kind: "id", value: id };
}

// MARK: - finding the session (one /bin/sh command, read only)

const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

/**
 * One `/bin/sh` command that prints the session's view path, or nothing; always exits 0. The default home's
 * database, then each profile's (`~/.hermes/profiles/*`): the one that is a regular file and holds the session
 * (two distinct databases holding it print nothing, never the first) (sqlite3 read only: `mode=ro`, or `mode=ro&immutable=1` when a -wal is there without its -shm or the
 * first open fails, never a file made in Hermes's folder). A path holding `?`, `#` or `%` is skipped. Null for
 * anything but a checked id lookup.
 */
export function hermesLocateCommand(ref: TranscriptSessionRef): string | null {
  if (!isHermesFormat(ref.format)) return null;
  const checked = hermesSessionRef(ref.lookup);
  if (checked === null || checked.lookup.kind !== "id") return null;
  const id = checked.lookup.id;
  const sql = `select 'hermes '||count(*) from sessions where id='${id}';`;
  const ask = (immutable: boolean): string =>
    '/usr/bin/sqlite3 -init /dev/null -readonly -batch "file:$d?mode=ro' + (immutable ? "&immutable=1" : "") + '" ' + quote(sql) + " 2>/dev/null";
  const script =
    'm=; for d in "$HOME"/' +
    quote(".hermes") +
    "/" +
    quote("state.db") +
    ' "$HOME"/' +
    quote(".hermes") +
    "/" +
    quote("profiles") +
    "/*/" +
    quote("state.db") +
    '; do [ -f "$d" ] || continue; case "$d" in *[?#%]*) continue;; esac; s=; ' +
    'if [ ! -f "$d-wal" ] || [ -f "$d-shm" ]; then s=$(' +
    ask(false) +
    "); fi; " +
    '[ -n "$s" ] || s=$(' +
    ask(true) +
    "); " +
    // Every database is asked; the one holding the
    // session is printed after the loop, and a second distinct one holding it prints nothing (never the first).
    '[ "$s" = ' +
    quote("hermes 1") +
    ' ] && { [ -n "$m" ] && [ ! "$d" -ef "$m" ] && exit 0; m=$d; }; done; [ -n "$m" ] && printf ' +
    quote("%s#%s\\n") +
    ' "$m" ' +
    quote(id) +
    "; exit 0";
  return "/bin/sh -c " + quote(script);
}

/** The view path the command printed, when it is the session asked for. */
export function parseHermesLocateOutput(output: string, ref: TranscriptSessionRef): string | null {
  const lookup = ref.lookup;
  if (lookup.kind !== "id" || !isHermesFormat(ref.format)) return null;
  const line = output
    .split(/[\n\r]/)
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ""))
    .find((part) => part.length > 0);
  if (line === undefined) return null;
  const view = parseHermesViewPath(line);
  return view !== null && view.session === lookup.id ? line : null;
}
