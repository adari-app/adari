// Where Mastra Code keeps a pane's thread, and how Chat finds it.
//
// Mastra Code keeps every thread in one LibSQL database: `$MASTRA_DB_PATH`, else `<app data>/mastra.db`
// (mastra mastracode/sdk/src/utils/project.ts:214-222), the app data folder being `$MASTRA_APP_DATA_DIR`, else
// `~/Library/Application Support/mastracode` on a Mac and `${XDG_DATA_HOME:-~/.local/share}/mastracode` on
// Linux (project.ts:180-211). LibSQL writes the SQLite file format (its tables made as SQLite's,
// stores/libsql/src/storage/db/index.ts:713-727), so `/usr/bin/sqlite3` reads it read only, WAL included.
// Tables `mastra_threads(id, resourceId, title, metadata, createdAt, updatedAt)` and `mastra_messages(id,
// thread_id, content, role, type, createdAt, resourceId)` (packages/core/src/storage/constants.ts:7-8,
// :933-949).
//
// A thread id is a UUID unless the caller names one (packages/core/src/memory/memory.ts:600-606, :691-692).
// Herdr reports the pane's thread as `herdr:mastracode`, kind `id` (Herdr src/agent_resume.rs:227-233, :338);
// a pane runs `mastracode --thread <id>` (mastracode/sdk/src/headless/cli.ts:46, :119-136; `--clone-thread`
// branches a copy, a new thread).
//
// Chat names a thread by a view path, `<mastra.db>#<thread id>`: no file is there, and the transcript reader
// reads such a path as the thread's JSONL view (agents/mastra-store.ts), never over SFTP. A Mastra Code pane
// binds by Herdr's id (or the argv's) only, never by folder: a thread's folder is only its metadata's
// `projectPath` when Mastra Code tagged it (mastracode/tui/src/tui/thread-startup.ts:103,
// commands/thread-tag-dir.ts:30), and that is checked against the pane's folders before anything shows.
//
// This file imports nothing but types from locator.ts (locator.ts registers these functions).

import type { AgentSessionLike, TranscriptLookup, TranscriptSessionRef } from "../locator";

export type MastraFormat = "mastracode";

export const isMastraFormat = (value: string | null | undefined): value is MastraFormat => value === "mastracode";

/** Letters, digits, `_`, `-` and `.` (a UUID, or a name of those); nothing else reaches a command or a query. */
export function isMastraThreadID(value: string): boolean {
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

/** A Mastra Code database path: absolute, `…/mastracode/mastra.db`, no `#`, no control characters, no `.` or `..`. */
export function isMastraDatabase(path: string): boolean {
  if (!path.startsWith("/") || new TextEncoder().encode(path).length > maxPathBytes || hasControl(path) || path.includes("#")) return false;
  const parts = path.split("/");
  const n = parts.length;
  return n >= 3 && parts[n - 1] === "mastra.db" && parts[n - 2] === "mastracode" && !parts.some((part) => part === "." || part === "..");
}

/** A view path's parts. */
export interface MastraViewPath {
  readonly database: string;
  readonly thread: string;
}

/** `<mastra.db>#<thread id>`, or null for anything else. */
export function parseMastraViewPath(path: string): MastraViewPath | null {
  const mark = path.lastIndexOf("#");
  if (mark <= 0) return null;
  const database = path.slice(0, mark);
  const thread = path.slice(mark + 1);
  return isMastraDatabase(database) && isMastraThreadID(thread) ? { database, thread } : null;
}

export const isMastraViewPath = (path: string): boolean => parseMastraViewPath(path) !== null;

/** The view path of `thread` in `database`. */
export const mastraViewPath = (database: string, thread: string): string => database + "#" + thread;

/** makeSessionRef for Mastra Code: an id, or a view path; never a folder. */
export function mastraSessionRef(lookup: TranscriptLookup): TranscriptSessionRef | null {
  if (lookup.kind === "id") return isMastraThreadID(lookup.id) ? { format: "mastracode", lookup } : null;
  if (lookup.kind === "path") return isMastraViewPath(lookup.path) ? { format: "mastracode", lookup } : null;
  return null;
}

/** From Herdr's `agent_session` (`herdr:mastracode`, kind `id`); null for another source or a bad id. */
export function mastraRefFromAgentSession(session: AgentSessionLike): TranscriptSessionRef | null {
  if (session.source !== "herdr:mastracode" || session.kind !== "id") return null;
  return mastraSessionRef({ kind: "id", id: session.value });
}

/** The thread a `mastracode` argv names: `--thread <id>`, `--thread=<id>`; none with `--clone-thread` (a new thread) or for a bad id. */
export function mastraSessionFromArgv(argv: readonly string[]): AgentSessionLike | null {
  let id: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (word === "--clone-thread" || word.startsWith("--clone-thread=")) return null;
    if (word === "--thread" && index + 1 < argv.length) id = argv[index + 1]!;
    else if (word.startsWith("--thread=")) id = word.slice("--thread=".length);
  }
  if (id === null || !isMastraThreadID(id)) return null;
  return { source: "herdr:mastracode", agent: "mastracode", kind: "id", value: id };
}

// MARK: - finding the thread (one /bin/sh command, read only)

const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

/**
 * One `/bin/sh` command that prints the thread's view path, or nothing; always exits 0: the Mac's database
 * (`~/Library/Application Support/mastracode/mastra.db`), then Linux's (`~/.local/share/mastracode/mastra.db`),
 * the one that is a regular file and holds the thread (two distinct databases holding it
 * print nothing, never the Mac's first) (sqlite3 read only: `mode=ro`, or `mode=ro&immutable=1`
 * when a -wal is there without its -shm or the first open fails). A path holding `?`, `#` or `%` is skipped.
 * Null for anything but a checked id lookup.
 */
export function mastraLocateCommand(ref: TranscriptSessionRef): string | null {
  if (!isMastraFormat(ref.format)) return null;
  const checked = mastraSessionRef(ref.lookup);
  if (checked === null || checked.lookup.kind !== "id") return null;
  const id = checked.lookup.id;
  const sql = `select 'mastra '||count(*) from mastra_threads where id='${id}';`;
  const ask = (immutable: boolean): string =>
    '/usr/bin/sqlite3 -init /dev/null -readonly -batch "file:$d?mode=ro' + (immutable ? "&immutable=1" : "") + '" ' + quote(sql) + " 2>/dev/null";
  const script =
    'm=; for d in "$HOME"/' +
    quote("Library") +
    "/" +
    quote("Application Support") +
    "/" +
    quote("mastracode") +
    "/" +
    quote("mastra.db") +
    ' "$HOME"/' +
    quote(".local") +
    "/" +
    quote("share") +
    "/" +
    quote("mastracode") +
    "/" +
    quote("mastra.db") +
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
    quote("mastra 1") +
    ' ] && { [ -n "$m" ] && [ ! "$d" -ef "$m" ] && exit 0; m=$d; }; done; [ -n "$m" ] && printf ' +
    quote("%s#%s\\n") +
    ' "$m" ' +
    quote(id) +
    "; exit 0";
  return "/bin/sh -c " + quote(script);
}

/** The view path the command printed, when it is the thread asked for. */
export function parseMastraLocateOutput(output: string, ref: TranscriptSessionRef): string | null {
  const lookup = ref.lookup;
  if (lookup.kind !== "id" || !isMastraFormat(ref.format)) return null;
  const line = output
    .split(/[\n\r]/)
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ""))
    .find((part) => part.length > 0);
  if (line === undefined) return null;
  const view = parseMastraViewPath(line);
  return view !== null && view.thread === lookup.id ? line : null;
}
