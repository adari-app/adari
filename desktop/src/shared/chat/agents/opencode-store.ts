// An OpenCode or Kilo session read as the JSONL file the other readers follow.
//
// Both keep the user's sessions in one SQLite database (agents/opencode-locate.ts), in one of two schemas:
// - V1 (OpenCode 1.x; Kilo, its fork): `session(id, directory, …)`, `message(id, session_id,
//   time_created, time_updated, data)` with `data` a message minus its ids (`role` user or assistant),
//   `part(id, message_id, session_id, time_created, time_updated, data)` with `data` a part minus its
//   ids (opencode v1.18.29 packages/core/src/session/sql.ts:22-99, packages/schema/src/v1/session.ts);
//   messages in `(time_created, id)` order, a message's parts in id order
//   (packages/opencode/src/session/message-v2.ts:98-110, 425-440);
// - V2 (OpenCode 2.x): `session_v2(id, directory, …)` and `session_message(id, session_id, type, seq,
//   time_created, time_updated, data)`, one row per message in `seq` order, an assistant step's parts
//   inline in its `data.content` (opencode 2.2.5 packages/core/src/session/sql.ts:28-105,
//   packages/schema/src/session-message.ts; projector.ts:476-479: part rows only with the experimental
//   `part_rows`).
//
// The view is one line per row, each the row's `data` in a small envelope this file writes, then "\n":
// - V1: each part, `{"oc":"v1","k":"part","id","mid","role","t","cwd","d":<data>}`; after a user
//   message's parts a line with no data, `{"oc":"v1","k":"user","id","t","cwd"}` (the user's message is shown
//   whole there: `data` itself changes after the user's turn, summary.ts:125, and is never read); after an
//   assistant message's parts its row, `{"oc":"v1","k":"msg","id","role","t","cwd","d":<data>}`
//   (its error, its finish);
// - V2: each message, `{"oc":"v2","k":"msg","id","type","seq","t","cwd","d":<data>}`.
// `cwd` is the session's folder (the feed's folder check), `t` the row's time_created (ms).
//
// A row still being written is held back until it settles, so lines already read keep their bytes: a
// V1 part of the session's last message that is a text or reasoning without `time.end` or a tool
// `pending` or `running` (processor.ts:500-545: a text is written empty at its start and whole at its
// end), the last message's assistant row without `time.completed` or `error`; a V2 assistant row
// without them unless a later assistant row supersedes it (projector.ts:446-448), a `shell` or
// `compaction` row `running`. Anything that moves lines already laid out (a row held back that settles
// before later ones, a row rewritten, a revert's deletions, a prune) is a new revision: the feed starts
// over (TranscriptStoreReading, as a Cursor store's).
//
// Every read is one read-only `/usr/bin/sqlite3` exec as cursor-store.ts's (`mode=ro`, or
// `mode=ro&immutable=1` when a -wal is there without its -shm or that fails; nothing made in the agent's
// folder). Only a checked session id and integers go into a query. A refresh asks a few aggregates
// (count, newest time_updated, sum of rowids) and lists only the rows changed since (their length, first
// byte and whether they are still being written), the whole list again when rows went; `read` fetches
// only the rows its byte range covers, in batches. A row longer than a line may be, or one that is not
// JSON, is a short placeholder line the parser skips and counts.

import { cursorHexBytes, cursorRows, cursorStoreURI, type CursorContext, type CursorQuery, type CursorStamp, type NotFound, type TranscriptStoreReading } from "../cursor-store";
import { maxLineBytes } from "../follower";
import { openCodeDatabaseFormat, parseOpenCodeViewPath } from "./opencode-locate";

const sqlite = "/usr/bin/sqlite3";

const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

/**
 * One `/bin/sh` command running `sql` read-only on an OpenCode or Kilo database: `mode=ro` unless a -wal
 * is there without its -shm (sqlite would make the -shm in the agent's folder), else or on failure
 * `mode=ro&immutable=1`; `#ok` last when one ran (cursorRows reads it). Null for another path.
 */
export function openCodeQueryCommand(database: string, sql: string): string | null {
  if (openCodeDatabaseFormat(database) === null) return null;
  const run = (immutable: boolean): string => sqlite + " -init /dev/null -readonly -batch " + quote(cursorStoreURI(database, immutable)) + " " + quote(sql) + " 2>/dev/null";
  const script =
    "d=" +
    quote(database) +
    '; r=1; if [ ! -f "$d-wal" ] || [ -f "$d-shm" ]; then ' +
    run(false) +
    " && r=0; fi; " +
    'if [ "$r" != 0 ]; then ' +
    run(true) +
    " && r=0; fi; [ \"$r\" = 0 ] && echo '#ok'; exit 0";
  return "/bin/sh -c " + quote(script);
}

// MARK: - the queries (a checked session id and integers only)

export type OpenCodeSchema = "v1" | "v2";

const sessionPattern = /^ses_[0-9A-Za-z]{8,60}$/;
const checkedSession = (session: string): string => {
  if (!sessionPattern.test(session)) throw new Error("not an OpenCode session id");
  return session;
};
const checkedInteger = (value: number): string => {
  if (!Number.isSafeInteger(value)) throw new Error("not an integer");
  return String(value);
};

/** Which schema's tables the database has, and whether each holds the session. */
export function openCodeSchemaSQL(session: string, tables: ReadonlySet<string>): string | null {
  const id = checkedSession(session);
  const parts: string[] = [];
  if (tables.has("session_v2") && tables.has("session_message")) parts.push(`select 'v2 '||count(*) from session_v2 where id='${id}';`);
  if (tables.has("session") && tables.has("message") && tables.has("part")) parts.push(`select 'v1 '||count(*) from session where id='${id}';`);
  return parts.length === 0 ? null : parts.join(" ");
}

export const openCodeTablesSQL = "select name from sqlite_master where type='table' and name in ('session_v2','session_message','session','message','part');";

const aggregate = (table: string, id: string): string =>
  `(select count(*)||' '||ifnull(max(time_updated),0)||' '||ifnull(sum(rowid),0) from ${table} where session_id='${id}')`;

// A folder longer than a path may be reads as none (no folder check, as a session with none).
const folderHex = "(case when length(cast(s.directory as blob))<=4096 then hex(s.directory) else '' end)";

/** The session's folder (hex) and, per table, its rows' count, newest time_updated and rowid sum; no row when the session is gone. */
export function openCodeDetectorSQL(schema: OpenCodeSchema, session: string): string {
  const id = checkedSession(session);
  if (schema === "v2") return `select 'd'||${folderHex}||' '||${aggregate("session_message", id)} from session_v2 s where s.id='${id}';`;
  return `select 'd'||${folderHex}||' '||${aggregate("message", id)}||' '||${aggregate("part", id)} from session s where s.id='${id}';`;
}

const firstByte = "' x'||hex(substr(cast(data as blob),1,1))";
// Ids past 80 bytes are not OpenCode's (identifier.ts:1-30): cut, they fail the id check and are not shown.
const hexID = (column: string): string => `hex(substr(cast(${column} as blob),1,80))`;
const byteLength = "length(cast(data as blob))";

/**
 * The rows changed since `since` (time_updated, ms; -1 for all), one line each:
 * `<table> <rowid> <hex id> <hex parent or -> <order> <created> <updated> <bytes> x<first byte hex> <kind> <open>`.
 */
export function openCodeRowsSQL(schema: OpenCodeSchema, session: string, since: number): string {
  const id = checkedSession(session);
  const after = checkedInteger(since);
  if (schema === "v2") {
    const kind = "(case when type glob '[a-z]*' and not type glob '*[^a-z-]*' and length(type)<=40 then type else '-' end)";
    const open =
      "(case when not json_valid(data) then 0" +
      " when type='assistant' then (json_extract(data,'$.time.completed') is null and json_extract(data,'$.error') is null)" +
      " when type in ('shell','compaction') then ifnull(json_extract(data,'$.status')='running',0) else 0 end)";
    return (
      `select 'm '||rowid||' '||${hexID("id")}||' -'||' '||ifnull(seq,0)||' '||ifnull(time_created,0)||' '||ifnull(time_updated,0)||' '||${byteLength}||${firstByte}||' '||${kind}||' '||${open}` +
      ` from session_message where session_id='${id}' and time_updated>=${after};`
    );
  }
  const role =
    "(case when not json_valid(data) then '-' when json_extract(data,'$.role')='user' then 'user'" +
    " when json_extract(data,'$.role')='assistant' then (case when json_extract(data,'$.summary') then 'summary' else 'assistant' end) else '-' end)";
  const messageOpen = "(case when json_valid(data) and json_extract(data,'$.role')='assistant' then (json_extract(data,'$.time.completed') is null and json_extract(data,'$.error') is null) else 0 end)";
  const partOpen =
    "(case when not json_valid(data) then 0" +
    " when json_extract(data,'$.type') in ('text','reasoning') then (json_type(data,'$.time') is not null and json_extract(data,'$.time.end') is null)" +
    " when json_extract(data,'$.type')='tool' then ifnull(json_extract(data,'$.state.status') in ('pending','running'),0) else 0 end)";
  return (
    `select 'm '||rowid||' '||${hexID("id")}||' -'||' '||ifnull(time_created,0)||' '||ifnull(time_created,0)||' '||ifnull(time_updated,0)||' '||${byteLength}||${firstByte}||' '||${role}||' '||${messageOpen}` +
    ` from message where session_id='${id}' and time_updated>=${after}; ` +
    `select 'p '||rowid||' '||${hexID("id")}||' '||${hexID("message_id")}||' 0 '||ifnull(time_created,0)||' '||ifnull(time_updated,0)||' '||${byteLength}||${firstByte}||' part '||${partOpen}` +
    ` from part where session_id='${id}' and time_updated>=${after};`
  );
}

/**
 * The `data` of rows by table and rowid, one line each: `<table> <rowid> <hex data>`, the data only when
 * it is still as long as laid out (`-` else: rewritten since), so the output stays within the bytes asked for.
 */
export function openCodeDataSQL(
  schema: OpenCodeSchema,
  session: string,
  rows: readonly { readonly table: "m" | "p"; readonly rowid: number; readonly dataLength: number }[],
): string | null {
  const id = checkedSession(session);
  const statement = (table: "m" | "p", name: string): string | null => {
    const these = rows.filter((row) => row.table === table);
    if (these.length === 0) return null;
    const lengths = these.map((row) => ` when ${checkedInteger(row.rowid)} then ${checkedInteger(row.dataLength)}`).join("");
    const ids = these.map((row) => checkedInteger(row.rowid)).join(",");
    return (
      `select '${table} '||rowid||' '||(case when length(cast(data as blob))=(case rowid${lengths} else -1 end) then hex(data) else '-' end)` +
      ` from ${name} where session_id='${id}' and rowid in (${ids});`
    );
  };
  const statements = [statement("m", schema === "v2" ? "session_message" : "message"), schema === "v1" ? statement("p", "part") : null].filter(
    (sql): sql is string => sql !== null,
  );
  return statements.length === 0 ? null : statements.join(" ");
}

// MARK: - rows

/** One row as a refresh listed it. */
export interface OpenCodeRow {
  readonly table: "m" | "p";
  readonly rowid: number;
  readonly id: string;
  /** A V1 part's message id; null for a message. */
  readonly parent: string | null;
  /** V2 seq; V1 message time_created; 0 for a part. */
  readonly order: number;
  readonly created: number;
  readonly updated: number;
  readonly bytes: number;
  readonly firstByte: number | null;
  /** V1 message: user, assistant, summary or -; V2: the message type or -; V1 part: part. */
  readonly kind: string;
  readonly open: boolean;
}

const hexText = (hex: string): string | null => {
  const bytes = cursorHexBytes(hex);
  if (bytes === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const integerOf = (value: string): number | null => {
  if (!/^-?\d{1,16}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/** One line of openCodeRowsSQL's output; null when it is not one. */
export function openCodeRow(line: string): OpenCodeRow | null {
  const parts = line.split(" ");
  if (parts.length !== 11) return null;
  const [table, rowid, id, parent, order, created, updated, bytes, first, kind, open] = parts as [string, string, string, string, string, string, string, string, string, string, string];
  if (table !== "m" && table !== "p") return null;
  const numbers = [rowid, order, created, updated, bytes].map(integerOf);
  if (numbers.some((value) => value === null)) return null;
  const idText = hexText(id);
  const parentText = parent === "-" ? null : hexText(parent);
  if (idText === null || (parent !== "-" && parentText === null) || !first.startsWith("x")) return null;
  const firstBytes = cursorHexBytes(first.slice(1));
  if (firstBytes === null || !/^[a-z-]{1,40}$/.test(kind) || (open !== "0" && open !== "1")) return null;
  return {
    table,
    rowid: numbers[0]!,
    id: idText,
    parent: parentText,
    order: numbers[1]!,
    created: numbers[2]!,
    updated: numbers[3]!,
    bytes: numbers[4]!,
    firstByte: firstBytes[0] ?? null,
    kind,
    open: open === "1",
  };
}

const messagePattern = /^msg_[0-9A-Za-z]{1,64}$/;
const partPattern = /^prt_[0-9A-Za-z]{1,64}$/;

/** What a detector answered: the session's folder and, per table, `count updated sum`. */
interface Detected {
  readonly folder: string | null;
  readonly tables: readonly { readonly count: number; readonly updated: number; readonly sum: number }[];
  readonly text: string;
}

function detected(line: string | undefined, schema: OpenCodeSchema): Detected | null {
  if (line === undefined) return null;
  const parts = line.trim().split(" ");
  const tables = schema === "v2" ? 1 : 2;
  if (parts.length !== 1 + tables * 3 || !parts[0]!.startsWith("d")) return null;
  const folderText = parts[0]!.length === 1 ? "" : hexText(parts[0]!.slice(1));
  if (folderText === null) return null;
  let folder: string | null = folderText;
  while (folder.length > 1 && folder.endsWith("/")) folder = folder.slice(0, -1);
  if (!folder.startsWith("/") || [...folder].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) folder = null;
  const counts: { count: number; updated: number; sum: number }[] = [];
  for (let index = 0; index < tables; index += 1) {
    const [count, updated, sum] = parts.slice(1 + index * 3, 4 + index * 3).map(integerOf);
    if (count === null || updated === null || sum === null || count === undefined || updated === undefined || sum === undefined) return null;
    counts.push({ count, updated, sum });
  }
  return { folder, tables: counts, text: line.trim() };
}

// MARK: - the view

export class OpenCodeStoreError extends Error {
  constructor(readonly path: string) {
    super(`the OpenCode session could not be read: ${path}`);
  }
}

interface Entry {
  readonly key: string;
  /** The row's key and time_updated (a line with no data: its key): what it shows. */
  readonly identity: string;
  readonly start: number;
  /** Bytes before its "\n". */
  readonly length: number;
  /** The envelope before the row's data, or the whole line when it has none. */
  readonly head: Uint8Array;
  /** The row's data bytes; -1 for a line with no data. */
  readonly dataLength: number;
  readonly table: "m" | "p";
  readonly rowid: number;
  readonly updated: number;
}

const lineEnd = (entry: Entry): number => entry.start + entry.length + 1;

interface State {
  schema: OpenCodeSchema | null;
  fingerprint: string | null;
  checkedAt: number;
  detected: string | null;
  folder: string | null;
  since: number;
  rows: Map<string, OpenCodeRow>;
  entries: Entry[];
  size: number;
  revision: number;
  used: number;
}

export interface OpenCodeStoreStats {
  queries: number;
  listings: number;
  rowsFetched: number;
  bytesFetched: number;
  readonly placeholders: Map<string, number>;
}

const encoder = new TextEncoder();

/** A placeholder line the parser skips and counts. */
export const openCodePlaceholder = (schema: OpenCodeSchema, why: string, id: string): string => `{"oc":"${schema}","k":"bad","bad":"${why}","id":${JSON.stringify(id)}}`;

const rowKey = (row: Pick<OpenCodeRow, "table" | "rowid">): string => `${row.table}:${row.rowid}`;

/**
 * OpenCode and Kilo sessions on one Mac as JSONL views (the module comment). `size` lists what changed
 * when the database or its WAL changed (their size and time, `stamp`) or `pollMs` passed; `read` fetches
 * only the rows its range covers that it does not hold, in batches of at most `batchBytes` and `batchRows`.
 */
export class OpenCodeStoreView implements TranscriptStoreReading {
  /** Asked again this often while followed, even when the stamps say nothing changed (whole-second times). */
  static readonly pollMs = 900;
  static readonly batchBytes = 1 * 1_024 * 1_024;
  static readonly batchRows = 256;
  static readonly maxRows = 100_000;
  static readonly cacheBytes = 16 * 1_024 * 1_024;
  static readonly keptStores = 8;

  private readonly states = new Map<string, State>();
  private useSerial = 0;
  private readonly refreshing = new Map<string, Promise<number>>();
  private readonly cache = new Map<string, Uint8Array>();
  private cacheTotal = 0;
  readonly stats: OpenCodeStoreStats = { queries: 0, listings: 0, rowsFetched: 0, bytesFetched: 0, placeholders: new Map() };

  constructor(
    private readonly query: CursorQuery,
    private readonly stamp: CursorStamp,
    private readonly notFound: NotFound,
    private readonly now: () => number = () => Date.now(),
  ) {}

  storeRevision(path: string): Promise<number> {
    return Promise.resolve(this.states.get(path)?.revision ?? 0);
  }

  /** No context ring: OpenCode's rows give no window size. */
  storeContext(): Promise<CursorContext | null> {
    return Promise.resolve(null);
  }

  size(path: string): Promise<number> {
    const running = this.refreshing.get(path);
    if (running !== undefined) return running;
    const task = this.refresh(path).finally(() => this.refreshing.delete(path));
    this.refreshing.set(path, task);
    return task;
  }

  private async run(path: string, database: string, sql: string, maxOutput: number): Promise<string[]> {
    const command = openCodeQueryCommand(database, sql);
    if (command === null) throw this.notFound(path);
    this.stats.queries += 1;
    const rows = cursorRows(await this.query(command, maxOutput));
    if (rows === null) throw new OpenCodeStoreError(path);
    return rows;
  }

  private async schemaOf(path: string, database: string, session: string): Promise<OpenCodeSchema> {
    const tables = new Set(await this.run(path, database, openCodeTablesSQL, 4_096));
    const sql = openCodeSchemaSQL(session, tables);
    if (sql === null) throw this.notFound(path);
    const answers = await this.run(path, database, sql, 4_096);
    // V2 first: a database V2 moved V1's sessions into keeps V1's tables (loose_psylocke migration).
    if (answers.some((line) => line.trim() === "v2 1")) return "v2";
    if (answers.some((line) => line.trim() === "v1 1")) return "v1";
    throw this.notFound(path);
  }

  private async refresh(path: string): Promise<number> {
    const view = parseOpenCodeViewPath(path);
    if (view === null) throw this.notFound(path);
    const db = await this.stamp(view.database);
    if (db === null) throw this.notFound(path);
    const wal = await this.stamp(view.database + "-wal").catch(() => null);
    const fingerprint = db + "|" + (wal ?? "-");
    const state: State = this.states.get(path) ?? {
      schema: null,
      fingerprint: null,
      checkedAt: -Infinity,
      detected: null,
      folder: null,
      since: -1,
      rows: new Map(),
      entries: [],
      size: 0,
      revision: 0,
      used: 0,
    };
    const time = this.now();
    if (state.fingerprint === fingerprint && time - state.checkedAt < OpenCodeStoreView.pollMs) return state.size;

    if (state.schema === null) state.schema = await this.schemaOf(path, view.database, view.session);
    const schema = state.schema;
    const answer = detected((await this.run(path, view.database, openCodeDetectorSQL(schema, view.session), 64 * 1_024))[0], schema);
    if (answer === null) {
      // Gone (or moved to the other schema's tables): looked up again from the start.
      this.states.delete(path);
      throw this.notFound(path);
    }
    const unchanged = state.detected === answer.text;
    state.fingerprint = fingerprint;
    state.checkedAt = time;
    if (unchanged) {
      this.keep(path, state);
      return state.size;
    }
    const total = answer.tables.reduce((sum, table) => sum + table.count, 0);
    if (total > OpenCodeStoreView.maxRows) throw new OpenCodeStoreError(path);
    const list = async (since: number): Promise<OpenCodeRow[]> => {
      this.stats.listings += 1;
      const lines = await this.run(path, view.database, openCodeRowsSQL(schema, view.session, since), total * 512 + 4_096);
      return lines.map(openCodeRow).filter((row): row is OpenCodeRow => row !== null);
    };
    const matches = (rows: ReadonlyMap<string, OpenCodeRow>): boolean =>
      answer.tables.every((table, index) => {
        const name = index === 0 ? "m" : "p";
        let count = 0;
        let sum = 0;
        for (const row of rows.values()) {
          if (row.table !== name) continue;
          count += 1;
          sum += row.rowid;
        }
        return count === table.count && sum === table.sum;
      });
    // The rows changed since the newest seen (the same millisecond again: a write in it may have come after).
    const rows = new Map(state.rows);
    for (const row of await list(state.since)) rows.set(rowKey(row), row);
    if (!matches(rows)) {
      // Rows went (a revert, a deletion): the whole list again.
      rows.clear();
      for (const row of await list(-1)) rows.set(rowKey(row), row);
    }
    state.rows = rows;
    state.since = Math.max(-1, ...answer.tables.map((table) => table.updated));
    state.detected = answer.text;
    state.folder = answer.folder;
    this.layOut(state, schema);
    this.keep(path, state);
    return state.size;
  }

  /** The view's lines from the rows: what is shown, in order, the rows still being written held back. */
  private layOut(state: State, schema: OpenCodeSchema): void {
    const cwd = state.folder === null ? "null" : JSON.stringify(state.folder);
    const lines: { row: OpenCodeRow; head: string; data: boolean }[] = [];
    const ordered = (a: OpenCodeRow, b: OpenCodeRow): number => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const messages = [...state.rows.values()].filter((row) => row.table === "m" && messagePattern.test(row.id)).sort(ordered);
    // The newest assistant message is the one being written; from its first row still open on, nothing
    // is shown yet (what follows it, a prompt typed meanwhile included), so what is shown only grows.
    // An older one still open (the agent stopped mid-step) is shown as it is.
    let newest = -1;
    messages.forEach((row, index) => {
      if (row.kind === "assistant" || row.kind === "summary") newest = index;
    });
    if (schema === "v2") {
      for (const [index, row] of messages.entries()) {
        if (row.open && index >= newest) break;
        lines.push({
          row,
          head: `{"oc":"v2","k":"msg","id":"${row.id}","type":"${row.kind}","seq":${row.order},"t":${row.created},"cwd":${cwd},"d":`,
          data: true,
        });
      }
    } else {
      const parts = new Map<string, OpenCodeRow[]>();
      for (const row of state.rows.values()) {
        if (row.table !== "p" || row.parent === null || !partPattern.test(row.id)) continue;
        const list = parts.get(row.parent) ?? [];
        list.push(row);
        parts.set(row.parent, list);
      }
      layout: for (const [index, message] of messages.entries()) {
        const role = message.kind;
        const its = (parts.get(message.id) ?? []).sort(ordered);
        // A prompt is written before its parts (prompt.ts createUserMessage): the last one waits for them.
        if (role === "user" && its.length === 0 && index === messages.length - 1) break;
        for (const part of its) {
          if (part.open && index >= newest) break layout;
          lines.push({
            row: part,
            head: `{"oc":"v1","k":"part","id":"${part.id}","mid":"${message.id}","role":"${role}","t":${part.created},"cwd":${cwd},"d":`,
            data: true,
          });
        }
        if (role === "user") {
          lines.push({ row: message, head: `{"oc":"v1","k":"user","id":"${message.id}","t":${message.created},"cwd":${cwd}}`, data: false });
        } else {
          if (message.open && index >= newest) break;
          lines.push({ row: message, head: `{"oc":"v1","k":"msg","id":"${message.id}","role":"${role}","t":${message.created},"cwd":${cwd},"d":`, data: true });
        }
      }
    }
    const entries: Entry[] = [];
    let offset = 0;
    for (const { row, head, data } of lines) {
      let bytes = encoder.encode(head);
      let dataLength = data ? row.bytes : -1;
      let identity = data ? `${rowKey(row)}@${row.updated}` : rowKey(row);
      if (data) {
        const why = row.firstByte !== 0x7b ? "notJSON" : bytes.length + row.bytes + 1 > maxLineBytes ? "oversized" : null;
        if (why !== null) {
          bytes = encoder.encode(openCodePlaceholder(schema, why, row.id));
          dataLength = -1;
          identity = `${rowKey(row)}#${why}`;
        }
      }
      const length = dataLength < 0 ? bytes.length : bytes.length + dataLength + 1;
      const entry: Entry = { key: rowKey(row), identity, start: offset, length, head: bytes, dataLength, table: row.table, rowid: row.rowid, updated: row.updated };
      entries.push(entry);
      offset = lineEnd(entry);
    }
    // Lines already laid out that moved or changed: a new revision (the feed starts over).
    const old = state.entries;
    const extends_ =
      old.length <= entries.length &&
      old.every((entry, index) => {
        const next = entries[index]!;
        return entry.identity === next.identity && entry.start === next.start && entry.length === next.length;
      });
    if (old.length > 0 && !extends_) state.revision += 1;
    state.entries = entries;
    state.size = entries.length === 0 ? 0 : lineEnd(entries[entries.length - 1]!);
  }

  private keep(path: string, state: State): void {
    this.useSerial += 1;
    state.used = this.useSerial;
    this.states.set(path, state);
    if (this.states.size > OpenCodeStoreView.keptStores) {
      let oldest: string | null = null;
      let least = Infinity;
      for (const [key, value] of this.states) {
        if (value.used < least) {
          least = value.used;
          oldest = key;
        }
      }
      if (oldest !== null) this.states.delete(oldest);
    }
  }

  async read(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    if (!this.states.has(path)) await this.size(path);
    const state = this.states.get(path);
    const view = parseOpenCodeViewPath(path);
    if (state === undefined || view === null || state.schema === null) throw this.notFound(path);
    const schema = state.schema;
    const end = Math.min(state.size, offset + Math.max(0, maxBytes));
    if (offset >= end) return new Uint8Array(0);
    const entries = state.entries;
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (lineEnd(entries[mid]!) <= offset) low = mid + 1;
      else high = mid;
    }
    const covered: Entry[] = [];
    for (let index = low; index < entries.length && entries[index]!.start < end; index += 1) covered.push(entries[index]!);
    const cacheKey = (entry: Entry): string => `${path}|${entry.identity}`;
    const fetched = new Map<string, Uint8Array>();
    const wanted: Entry[] = [];
    for (const entry of covered) {
      if (entry.dataLength < 0) continue;
      const held = this.cache.get(cacheKey(entry));
      if (held !== undefined && held.length === entry.dataLength) fetched.set(entry.key, held);
      else if (!fetched.has(entry.key) && !wanted.includes(entry)) wanted.push(entry);
    }
    let start = 0;
    while (start < wanted.length) {
      const batch: Entry[] = [];
      let bytes = 0;
      let cursor = start;
      while (cursor < wanted.length && batch.length < OpenCodeStoreView.batchRows && (batch.length === 0 || bytes + wanted[cursor]!.dataLength <= OpenCodeStoreView.batchBytes)) {
        batch.push(wanted[cursor]!);
        bytes += wanted[cursor]!.dataLength;
        cursor += 1;
      }
      start = cursor;
      const sql = openCodeDataSQL(schema, view.session, batch);
      if (sql === null) continue;
      const byKey = new Map(batch.map((entry) => [entry.key, entry]));
      for (const row of await this.run(path, view.database, sql, bytes * 2 + batch.length * 48 + 1_024)) {
        const [table, rowid, hex] = row.split(" ");
        if (table === undefined || rowid === undefined || hex === undefined) continue;
        const key = `${table}:${rowid}`;
        const entry = byKey.get(key);
        if (entry === undefined || fetched.has(key)) continue;
        const data = cursorHexBytes(hex);
        if (data === null) continue;
        this.stats.rowsFetched += 1;
        this.stats.bytesFetched += data.length;
        const line = data.map((byte) => (byte === 0x0a || byte === 0x0d ? 0x20 : byte));
        fetched.set(key, line);
        if (line.length === entry.dataLength) this.remember(cacheKey(entry), line);
      }
    }
    const out = new Uint8Array(end - offset);
    let written = 0;
    for (const entry of covered) {
      const line = new Uint8Array(entry.length + 1).fill(0x20);
      line.set(entry.head);
      if (entry.dataLength < 0) {
        if (entry.identity.includes("#")) this.count(entry.identity.slice(entry.identity.indexOf("#") + 1));
      } else {
        const data = fetched.get(entry.key);
        if (data !== undefined && data.length === entry.dataLength) {
          line.set(data, entry.head.length);
          line[entry.head.length + data.length] = 0x7d;
        } else {
          // Rewritten (or gone) since it was laid out: a placeholder as long; the next refresh lays it out again.
          this.count("changed");
          state.fingerprint = null;
          state.detected = null;
          const placeholder = encoder.encode(openCodePlaceholder(schema, "changed", ""));
          line.fill(0x20);
          if (placeholder.length <= entry.length) line.set(placeholder);
        }
      }
      line[entry.length] = 0x0a;
      const from = offset > entry.start ? offset - entry.start : 0;
      const to = Math.min(line.length, end - entry.start);
      if (from < to) {
        out.set(line.subarray(from, to), written);
        written += to - from;
      }
    }
    return out.subarray(0, written);
  }

  private count(why: string): void {
    this.stats.placeholders.set(why, (this.stats.placeholders.get(why) ?? 0) + 1);
  }

  private remember(key: string, bytes: Uint8Array): void {
    if (bytes.length > OpenCodeStoreView.cacheBytes / 4) return;
    if (this.cache.has(key)) this.cacheTotal -= this.cache.get(key)!.length;
    this.cache.delete(key);
    this.cache.set(key, bytes);
    this.cacheTotal += bytes.length;
    for (const [oldest, held] of this.cache) {
      if (this.cacheTotal <= OpenCodeStoreView.cacheBytes) break;
      this.cache.delete(oldest);
      this.cacheTotal -= held.length;
    }
  }
}
