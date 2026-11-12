// A Hermes session read as the JSONL file the other readers follow (agents/store-lines.ts).
//
// Hermes's `state.db` (agents/hermes-locate.ts) holds `sessions(id, cwd, transcript_revision, …)` and
// `messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id, role, content, tool_call_id, tool_calls,
// tool_name, timestamp, finish_reason, reasoning, reasoning_content, active, compacted, display_kind, …)`
// (hermes-agent hermes_state_common.py:467-535, :537-567). A session's conversation is its `active` rows in id
// order (`idx_messages_session_active`, :814): a compaction marks the rows it summarised `active = 0,
// compacted = 1` and inserts the summary as new rows (hermes_state_messages.py:74, :916-929), a rewind or undo
// `active = 0, compacted = 0` (:729, :772). Rows are written whole; an in-place rewrite of a row (prompt
// expansion, a redaction, a display rewrite) bumps the session's `transcript_revision` by trigger
// (hermes_state_common.py:793-811).
//
// The view is one line per active, not compacted row, in id order:
// `{"hm":1,"id":<id>,"cwd":<the session's cwd>,"d":<the row as json_object(…)>}`. Its revision is the
// session's transcript_revision with the highest message id: rows past the newest seen are listed as they
// come; a new transcript_revision, or rows gone (a compaction, a rewind), lists the session again, and a line
// already laid out that changed moves the view to a new revision (the feed starts over). `cwd` is the feed's
// folder check: a session filed under another folder is never shown. A database without the tables or columns
// this reads is one line the parser marks unknown (the feed's unrecognised-format note).

import type { CursorQuery, CursorStamp, NotFound } from "../cursor-store";
import { parseHermesViewPath, isHermesSessionID, type HermesViewPath } from "./hermes-locate";
import { runStoreQuery, StoreGoneError, storeFolder, storeHexText, storeInteger, StoreLinesView, type StoreLine, type StoreLinesSource } from "./store-lines";

/** Columns the reader needs; a database without one is not one Chat reads. */
export const hermesRequiredColumns: Readonly<Record<"sessions" | "messages", readonly string[]>> = {
  sessions: ["id", "cwd", "transcript_revision"],
  messages: ["id", "session_id", "role", "content", "tool_call_id", "tool_calls", "tool_name", "timestamp", "active"],
};

/** Columns read when there (older and newer schemas differ). */
const optionalColumns = ["finish_reason", "reasoning", "reasoning_content", "display_kind", "compacted", "_compressed_summary"] as const;

export const hermesColumnsSQL = "select 's '||name from pragma_table_info('sessions'); select 'm '||name from pragma_table_info('messages');";

const checkedSession = (session: string): string => {
  if (!isHermesSessionID(session)) throw new Error("not a Hermes session id");
  return session;
};
const checkedInteger = (value: number): string => {
  if (!Number.isSafeInteger(value)) throw new Error("not an integer");
  return String(value);
};

/** A column as JSON may hold it (a blob as null). */
const scalar = (column: string): string => `(case when typeof(${column}) in ('text','integer','real') then ${column} else null end)`;

/** The row as one JSON object (sqlite's json_object), from the columns this database has. */
export function hermesRowJSON(columns: ReadonlySet<string>): string {
  const has = (name: string): boolean => columns.has(name);
  const reasoning = has("reasoning") && has("reasoning_content") ? `coalesce(${scalar("reasoning")},${scalar("reasoning_content")})` : has("reasoning") ? scalar("reasoning") : has("reasoning_content") ? scalar("reasoning_content") : "null";
  return (
    "json_object('id',id,'role'," +
    scalar("role") +
    ",'content'," +
    scalar("content") +
    ",'tool_calls'," +
    scalar("tool_calls") +
    ",'tool_call_id'," +
    scalar("tool_call_id") +
    ",'tool_name'," +
    scalar("tool_name") +
    ",'ts'," +
    scalar("timestamp") +
    ",'finish'," +
    (has("finish_reason") ? scalar("finish_reason") : "null") +
    ",'reasoning'," +
    reasoning +
    ",'kind'," +
    (has("display_kind") ? scalar("display_kind") : "null") +
    ",'summary'," +
    (has("_compressed_summary") ? "ifnull(_compressed_summary,0)" : "0") +
    ")"
  );
}

/** The rows shown: active and not compacted. */
const live = (columns: ReadonlySet<string>): string => "active=1" + (columns.has("compacted") ? " and ifnull(compacted,0)=0" : "");

/** The session's folder (hex), transcript revision, live rows' count, id sum and newest id, and its newest id of all; no row when it is gone. */
export function hermesDetectorSQL(session: string, columns: ReadonlySet<string>): string {
  const id = checkedSession(session);
  const folder = "(case when typeof(s.cwd)='text' and length(cast(s.cwd as blob))<=4096 then hex(s.cwd) else '' end)";
  return (
    `select 'd'||${folder}||' '||ifnull(s.transcript_revision,0)||' '||` +
    `(select count(*)||' '||ifnull(sum(id),0)||' '||ifnull(max(id),0) from messages where session_id='${id}' and ${live(columns)})||' '||` +
    `(select ifnull(max(id),0) from messages where session_id='${id}') from sessions s where s.id='${id}';`
  );
}

/** The live rows past `since` (an id; -1 for all), one line each: `<id> <bytes of the row's JSON>`. */
export function hermesRowsSQL(session: string, columns: ReadonlySet<string>, since: number): string {
  const id = checkedSession(session);
  return (
    `select id||' '||length(cast(${hermesRowJSON(columns)} as blob)) from messages` +
    ` where session_id='${id}' and ${live(columns)} and id>${checkedInteger(since)} order by id;`
  );
}

/** The rows' JSON by id, one line each: `<id> <hex>`, the JSON only when it is still as long as laid out (`-` else). */
export function hermesDataSQL(session: string, columns: ReadonlySet<string>, rows: readonly { readonly id: number; readonly bytes: number }[]): string | null {
  if (rows.length === 0) return null;
  const id = checkedSession(session);
  const json = hermesRowJSON(columns);
  const lengths = rows.map((row) => ` when ${checkedInteger(row.id)} then ${checkedInteger(row.bytes)}`).join("");
  const ids = rows.map((row) => checkedInteger(row.id)).join(",");
  return `select id||' '||(case when length(cast(${json} as blob))=(case id${lengths} else -1 end) then hex(${json}) else '-' end) from messages where session_id='${id}' and id in (${ids});`;
}

interface HermesRow {
  readonly id: number;
  readonly bytes: number;
}

export interface HermesState {
  /** The columns, once checked; the reason a database is not one Chat reads, when it is not. */
  columns: Set<string> | null;
  unknown: string | null;
  detected: string | null;
  folder: string | null;
  transcript: number;
  rows: Map<number, HermesRow>;
  since: number;
}

/** A placeholder or note line the parser reads (no data). */
export const hermesPlaceholder = (why: string): string => `{"hm":1,"k":"bad","bad":"${why}"}`;
const unknownLine = (why: string): string => `{"hm":1,"k":"unknown","why":${JSON.stringify(why)}}`;

export class HermesStoreSource implements StoreLinesSource<HermesViewPath, HermesState> {
  /** At most this many rows in one session (a longer one is refused, as OpenCode's). */
  static readonly maxRows = 100_000;

  constructor(private readonly query: CursorQuery) {}

  parse(path: string): HermesViewPath | null {
    return parseHermesViewPath(path);
  }

  stamped(view: HermesViewPath): readonly string[] {
    return [view.database, view.database + "-wal"];
  }

  fresh(): HermesState {
    return { columns: null, unknown: null, detected: null, folder: null, transcript: -1, rows: new Map(), since: -1 };
  }

  private run(view: HermesViewPath, sql: string, maxOutput: number): Promise<string[]> {
    return runStoreQuery(this.query, view.database, sql, maxOutput);
  }

  async lines(view: HermesViewPath, state: HermesState, force: boolean): Promise<readonly StoreLine[] | null> {
    if (state.columns === null) {
      const columns = { s: new Set<string>(), m: new Set<string>() };
      for (const line of await this.run(view, hermesColumnsSQL, 64 * 1_024)) {
        const [table, name] = [line.slice(0, 1), line.slice(2)];
        if (table === "s") columns.s.add(name);
        else if (table === "m") columns.m.add(name);
      }
      const missing = [
        ...hermesRequiredColumns.sessions.filter((name) => !columns.s.has(name)).map((name) => `sessions.${name}`),
        ...hermesRequiredColumns.messages.filter((name) => !columns.m.has(name)).map((name) => `messages.${name}`),
      ];
      state.columns = new Set(columns.m.size === 0 ? [] : [...columns.m].filter((name) => (hermesRequiredColumns.messages as readonly string[]).includes(name) || (optionalColumns as readonly string[]).includes(name)));
      state.unknown = missing.length === 0 ? null : `no ${missing.join(", ")}`;
    }
    if (state.unknown !== null) {
      if (state.detected === "unknown") return null;
      state.detected = "unknown";
      return [{ key: "unknown", identity: "unknown", head: unknownLine(state.unknown), dataBytes: -1, firstByte: null }];
    }
    const columns = state.columns;
    const answer = (await this.run(view, hermesDetectorSQL(view.session, columns), 16 * 1_024))[0]?.trim();
    if (answer === undefined) throw new StoreGoneError();
    const parts = answer.split(" ");
    if (parts.length !== 6 || !parts[0]!.startsWith("d")) throw new StoreGoneError();
    const [transcript, count, sum, newest] = parts.slice(1, 5).map(storeInteger);
    if (transcript === null || count === null || sum === null || newest === null || transcript === undefined || count === undefined || sum === undefined || newest === undefined) {
      throw new StoreGoneError();
    }
    if (!force && state.detected === answer) return null;
    if (count > HermesStoreSource.maxRows) throw new Error("the Hermes session is too long to read");
    const list = async (since: number): Promise<HermesRow[]> => {
      const lines = await this.run(view, hermesRowsSQL(view.session, columns, since), (count + 1) * 48 + 4_096);
      const rows: HermesRow[] = [];
      for (const line of lines) {
        const [id, bytes] = line.split(" ").map(storeInteger);
        if (id !== null && id !== undefined && bytes !== null && bytes !== undefined) rows.push({ id, bytes });
      }
      return rows;
    };
    // A new transcript revision rewrote rows in place: all listed again (their lengths may have changed).
    const rewritten = force || transcript !== state.transcript;
    const rows = rewritten ? new Map<number, HermesRow>() : new Map(state.rows);
    for (const row of await list(rewritten ? -1 : state.since)) rows.set(row.id, row);
    let total = 0;
    for (const row of rows.values()) total += row.id;
    if (rows.size !== count || total !== sum) {
      // Rows went (a compaction, a rewind): the whole list again.
      rows.clear();
      for (const row of await list(-1)) rows.set(row.id, row);
    }
    state.rows = rows;
    state.since = Math.max(-1, ...rows.keys());
    state.transcript = transcript;
    state.detected = answer;
    state.folder = storeFolder(parts[0]!.length === 1 ? null : storeHexText(parts[0]!.slice(1)));
    const cwd = state.folder === null ? "null" : JSON.stringify(state.folder);
    return [...rows.values()]
      .sort((a, b) => a.id - b.id)
      .map((row) => ({ key: `m:${row.id}`, identity: `m:${row.id}@${transcript}:${row.bytes}`, head: `{"hm":1,"id":${row.id},"cwd":${cwd},"d":`, dataBytes: row.bytes, firstByte: 0x7b }));
  }

  async data(view: HermesViewPath, state: HermesState, lines: readonly StoreLine[]): Promise<Map<string, Uint8Array>> {
    const columns = state.columns;
    const rows = lines.map((line) => ({ id: Number(line.key.slice(2)), bytes: line.dataBytes })).filter((row) => Number.isSafeInteger(row.id));
    const sql = columns === null ? null : hermesDataSQL(view.session, columns, rows);
    const out = new Map<string, Uint8Array>();
    if (sql === null) return out;
    const asked = rows.reduce((sum, row) => sum + row.bytes, 0);
    for (const line of await this.run(view, sql, asked * 2 + rows.length * 32 + 1_024)) {
      const space = line.indexOf(" ");
      const id = storeInteger(line.slice(0, space));
      const hex = line.slice(space + 1);
      if (id === null || hex === "-" || hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) continue;
      const bytes = new Uint8Array(hex.length / 2);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      out.set(`m:${id}`, bytes);
    }
    return out;
  }

  placeholder(why: "notJSON" | "oversized" | "changed"): string {
    return hermesPlaceholder(why);
  }
}

/** Hermes sessions as JSONL views: the store-lines view over HermesStoreSource. */
export class HermesStoreView extends StoreLinesView<HermesViewPath, HermesState> {
  constructor(query: CursorQuery, stamp: CursorStamp, notFound: NotFound, now?: () => number) {
    super(new HermesStoreSource(query), stamp, notFound, now);
  }
}
