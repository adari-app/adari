// A Mastra Code thread read as the JSONL file the other readers follow (agents/store-lines.ts).
//
// Mastra Code's `mastra.db` (agents/mastra-locate.ts) holds `mastra_messages(id, thread_id, content, role,
// type, createdAt, resourceId)`, one row per message, `content` the message as JSON text, `{format: 2, parts:
// […], …}` (packages/core/src/agent/message-list/state/types.ts:120-130; stores/libsql/src/storage/domains/
// memory/index.ts:907-923 writes `JSON.stringify(content)` and `createdAt` as ISO text). A thread's messages are
// in `createdAt, id` order (memory/index.ts:474, :489). A message is upserted in place (`ON CONFLICT(id) DO
// UPDATE SET content=…`, :907-915; no updated-at column): the agent's reply grows its parts as its steps are
// saved. The thread's folder is its `metadata.projectPath` (JSONB, `jsonb(?)`, memory/index.ts:1246, :1602,
// :1763) when Mastra Code tagged it (mastracode/tui/src/tui/thread-startup.ts:103).
//
// The view is one line per part, in message then part order:
// `{"ms":1,"k":"part","id":<message rowid>,"i":<part index>,"role","t":<createdAt ms>,"cwd","d":<the part>}`
// (a `file` part as `{type, mimeType}` only, its data left out); after a user message's parts
// `{"ms":1,"k":"user","id","t","cwd"}` (the user's message shown whole there), after an assistant message's
// `{"ms":1,"k":"end",…}` once it is settled (a later message, or its last part a text and none open). A part
// still being written (a tool invocation not yet `result`, `output-error` or `output-denied`) of the thread's
// last message holds back it and what follows, so what is shown only grows; a part that changed after it was
// laid out moves the view to a new revision (the feed starts over). Parts are listed again only for the
// messages whose content changed length. `cwd` is the feed's folder check (null when the thread names none or
// this sqlite3 cannot read JSONB, before 3.45: the pane is bound by Herdr's id only). A message whose content
// is not format 2 with parts, or a database without the tables or columns this reads, is a line the parser
// marks unknown (the feed's unrecognised-format note).

import type { CursorQuery, CursorStamp, NotFound } from "../cursor-store";
import { parseMastraViewPath, isMastraThreadID, type MastraViewPath } from "./mastra-locate";
import { runStoreQuery, StoreGoneError, storeFolder, storeHexText, storeInteger, StoreLinesView, type StoreLine, type StoreLinesSource } from "./store-lines";

export const mastraRequiredColumns: Readonly<Record<"mastra_threads" | "mastra_messages", readonly string[]>> = {
  mastra_threads: ["id", "metadata"],
  mastra_messages: ["id", "thread_id", "content", "role", "createdAt"],
};

export const mastraColumnsSQL = "select 't '||name from pragma_table_info('mastra_threads'); select 'm '||name from pragma_table_info('mastra_messages');";

const checkedThread = (thread: string): string => {
  if (!isMastraThreadID(thread)) throw new Error("not a Mastra Code thread id");
  return thread;
};
const checkedInteger = (value: number): string => {
  if (!Number.isSafeInteger(value)) throw new Error("not an integer");
  return String(value);
};

/** JSONB needs sqlite3 3.45; an older one reads no folder (the thread is bound by Herdr's id only). */
const readsJSONB = "(substr(sqlite_version(),1,2)='3.' and cast(substr(sqlite_version(),3) as real)>=45)";
const projectPath =
  "(case when typeof(metadata)='text' and json_valid(metadata) and json_type(metadata,'$.projectPath')='text' then hex(json_extract(metadata,'$.projectPath'))" +
  ` when typeof(metadata)='blob' and ${readsJSONB} and json_type(metadata,'$.projectPath')='text' then hex(json_extract(metadata,'$.projectPath')) else '' end)`;

/** The thread's folder (hex), then its messages' count, rowid sum, content bytes and newest rowid; no row when the thread is gone. */
export function mastraDetectorSQL(thread: string): string {
  const id = checkedThread(thread);
  return (
    `select 'd'||${projectPath}||' '||(select count(*)||' '||ifnull(sum(rowid),0)||' '||ifnull(sum(length(cast(content as blob))),0)||' '||ifnull(max(rowid),0)` +
    ` from mastra_messages where thread_id='${id}') from mastra_threads where id='${id}';`
  );
}

const roleOf = "(case when role in ('user','assistant','system','signal','tool') then role else '-' end)";
const createdMs = "ifnull(cast(round((julianday(createdAt)-2440587.5)*86400000) as integer),0)";
const formatOf =
  "(case when not json_valid(content) then 'x' when json_type(content,'$.parts')<>'array' then 'n'" +
  " when json_type(content,'$.format')='integer' then json_extract(content,'$.format') else '-' end)";

/** The thread's messages in order, one line each: `m <rowid> <content bytes> <role> <created ms> <format: 2, x not JSON, n no parts, - none>`. */
export function mastraMessagesSQL(thread: string): string {
  const id = checkedThread(thread);
  return `select 'm '||rowid||' '||length(cast(content as blob))||' '||${roleOf}||' '||${createdMs}||' '||${formatOf} from mastra_messages where thread_id='${id}' order by createdAt, id;`;
}

const parts = "json_each(case when json_valid(m.content) then m.content else '{}' end,'$.parts')";
const partType = "(case when j.type='object' then json_extract(j.value,'$.type') else null end)";
/** A part as a line holds it: a file's data left out. */
const slim =
  "(case when j.type='object' and json_extract(j.value,'$.type')='file' then json_object('type','file','mimeType',coalesce(json_extract(j.value,'$.mimeType'),json_extract(j.value,'$.mediaType')))" +
  " else j.value end)";
const kindOf = `(case when typeof(${partType})='text' and length(${partType}) between 1 and 40 and ${partType} not glob '*[^a-z0-9-]*' then ${partType} else '-' end)`;
const openOf =
  `(case when ${partType}='tool-invocation' then ifnull(json_extract(j.value,'$.toolInvocation.state'),'') not in ('result','output-error','output-denied') else 0 end)`;

/** The parts of the messages `rowids`, one line each: `p <rowid> <index> <bytes> <object 0/1> <type or -> <open 0/1>`. */
export function mastraPartsSQL(thread: string, rowids: readonly number[]): string | null {
  if (rowids.length === 0) return null;
  const id = checkedThread(thread);
  return (
    `select 'p '||m.rowid||' '||j.key||' '||ifnull(length(cast(${slim} as blob)),0)||' '||(j.type='object')||' '||${kindOf}||' '||${openOf}` +
    ` from mastra_messages m, ${parts} j where m.thread_id='${id}' and m.rowid in (${rowids.map(checkedInteger).join(",")}) order by m.rowid, j.key;`
  );
}

/** The parts asked for, one line each: `<rowid> <index> <hex>`, the part only when it is still as long as laid out (`-` else). */
export function mastraDataSQL(thread: string, rows: readonly { readonly rowid: number; readonly index: number; readonly bytes: number }[]): string | null {
  if (rows.length === 0) return null;
  const id = checkedThread(thread);
  const keys = rows.map((row) => `'${checkedInteger(row.rowid)}:${checkedInteger(row.index)}'`);
  const lengths = rows.map((row, at) => ` when ${keys[at]} then ${checkedInteger(row.bytes)}`).join("");
  const rowids = [...new Set(rows.map((row) => checkedInteger(row.rowid)))].join(",");
  return (
    `select m.rowid||' '||j.key||' '||(case when length(cast(${slim} as blob))=(case m.rowid||':'||j.key${lengths} else -1 end) then hex(${slim}) else '-' end)` +
    ` from mastra_messages m, ${parts} j where m.thread_id='${id}' and m.rowid in (${rowids}) and (m.rowid||':'||j.key) in (${keys.join(",")});`
  );
}

interface MastraMessage {
  readonly rowid: number;
  readonly bytes: number;
  readonly role: string;
  readonly created: number;
  readonly format: string;
}

interface MastraPart {
  readonly index: number;
  readonly bytes: number;
  readonly object: boolean;
  readonly kind: string;
  readonly open: boolean;
}

export interface MastraState {
  checked: boolean;
  unknown: string | null;
  detected: string | null;
  /** Each message's parts, with the content length they were listed at. */
  parts: Map<number, { readonly bytes: number; readonly parts: readonly MastraPart[] }>;
}

export const mastraPlaceholder = (why: string): string => `{"ms":1,"k":"bad","bad":"${why}"}`;

export class MastraStoreSource implements StoreLinesSource<MastraViewPath, MastraState> {
  static readonly maxRows = 100_000;
  /** Messages whose parts one query lists. */
  static readonly partsBatch = 200;

  constructor(private readonly query: CursorQuery) {}

  parse(path: string): MastraViewPath | null {
    return parseMastraViewPath(path);
  }

  stamped(view: MastraViewPath): readonly string[] {
    return [view.database, view.database + "-wal"];
  }

  fresh(): MastraState {
    return { checked: false, unknown: null, detected: null, parts: new Map() };
  }

  private run(view: MastraViewPath, sql: string, maxOutput: number): Promise<string[]> {
    return runStoreQuery(this.query, view.database, sql, maxOutput);
  }

  async lines(view: MastraViewPath, state: MastraState, force: boolean): Promise<readonly StoreLine[] | null> {
    if (!state.checked) {
      const columns = { t: new Set<string>(), m: new Set<string>() };
      for (const line of await this.run(view, mastraColumnsSQL, 64 * 1_024)) {
        if (line.startsWith("t ")) columns.t.add(line.slice(2));
        else if (line.startsWith("m ")) columns.m.add(line.slice(2));
      }
      const missing = [
        ...mastraRequiredColumns.mastra_threads.filter((name) => !columns.t.has(name)).map((name) => `mastra_threads.${name}`),
        ...mastraRequiredColumns.mastra_messages.filter((name) => !columns.m.has(name)).map((name) => `mastra_messages.${name}`),
      ];
      state.checked = true;
      state.unknown = missing.length === 0 ? null : `no ${missing.join(", ")}`;
    }
    if (state.unknown !== null) {
      if (state.detected === "unknown") return null;
      state.detected = "unknown";
      return [{ key: "unknown", identity: "unknown", head: `{"ms":1,"k":"unknown","why":${JSON.stringify(state.unknown)}}`, dataBytes: -1, firstByte: null }];
    }
    const answer = (await this.run(view, mastraDetectorSQL(view.thread), 16 * 1_024))[0]?.trim();
    if (answer === undefined || !answer.startsWith("d")) throw new StoreGoneError();
    const fields = answer.split(" ");
    const [count, , bytes] = fields.slice(1).map(storeInteger);
    if (fields.length !== 5 || count === null || count === undefined || bytes === null || bytes === undefined) throw new StoreGoneError();
    if (!force && state.detected === answer) return null;
    if (count > MastraStoreSource.maxRows) throw new Error("the Mastra Code thread is too long to read");
    const messages: MastraMessage[] = [];
    for (const line of await this.run(view, mastraMessagesSQL(view.thread), (count + 1) * 64 + 4_096)) {
      const [tag, rowid, length, role, created, format] = line.split(" ");
      const numbers = [rowid, length, created].map(storeInteger);
      if (tag !== "m" || numbers.some((value) => value === null) || role === undefined || format === undefined) continue;
      messages.push({ rowid: numbers[0]!, bytes: numbers[1]!, role, created: numbers[2]!, format });
    }
    // Parts listed again only for the messages whose content changed length (or all, forced).
    const changed = messages.filter((message) => message.format === "2" && (force || state.parts.get(message.rowid)?.bytes !== message.bytes));
    const listed = new Map(state.parts);
    for (const message of messages) if (message.format !== "2") listed.delete(message.rowid);
    const present = new Set(messages.map((message) => message.rowid));
    for (const rowid of listed.keys()) if (!present.has(rowid)) listed.delete(rowid);
    for (let start = 0; start < changed.length; start += MastraStoreSource.partsBatch) {
      const batch = changed.slice(start, start + MastraStoreSource.partsBatch);
      const sql = mastraPartsSQL(view.thread, batch.map((message) => message.rowid));
      if (sql === null) continue;
      const content = batch.reduce((sum, message) => sum + message.bytes, 0);
      const found = new Map<number, MastraPart[]>(batch.map((message) => [message.rowid, []]));
      for (const line of await this.run(view, sql, Math.min(16 * 1_024 * 1_024, content * 5 + 4_096))) {
        const [tag, rowid, index, length, object, kind, open] = line.split(" ");
        const numbers = [rowid, index, length].map(storeInteger);
        if (tag !== "p" || numbers.some((value) => value === null) || kind === undefined || (open !== "0" && open !== "1")) continue;
        found.get(numbers[0]!)?.push({ index: numbers[1]!, bytes: numbers[2]!, object: object === "1", kind, open: open === "1" });
      }
      for (const message of batch) listed.set(message.rowid, { bytes: message.bytes, parts: found.get(message.rowid) ?? [] });
    }
    state.parts = listed;
    state.detected = answer;
    const folder = storeFolder(fields[0]!.length === 1 ? null : storeHexText(fields[0]!.slice(1)));
    return this.layOut(messages, listed, folder === null ? "null" : JSON.stringify(folder));
  }

  private layOut(messages: readonly MastraMessage[], parts: MastraState["parts"], cwd: string): StoreLine[] {
    const lines: StoreLine[] = [];
    const last = messages.length - 1;
    layout: for (const [index, message] of messages.entries()) {
      const envelope = `"id":${message.rowid},"t":${message.created},"cwd":${cwd}`;
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (message.format === "x") {
        lines.push({ key: `m:${message.rowid}#bad`, identity: `m:${message.rowid}#bad@${message.bytes}`, head: mastraPlaceholder("notJSON"), dataBytes: -1, firstByte: null });
        continue;
      }
      if (message.format !== "2") {
        lines.push({ key: `m:${message.rowid}#version`, identity: `m:${message.rowid}#version`, head: `{"ms":1,"k":"version","v":${JSON.stringify(message.format)},${envelope}}`, dataBytes: -1, firstByte: null });
        continue;
      }
      const its = parts.get(message.rowid)?.parts ?? [];
      // The thread's last message is being written: from its first part still open, nothing is shown yet.
      const openAt = index === last ? its.findIndex((part) => part.open) : -1;
      const shown = openAt >= 0 ? its.slice(0, openAt) : its;
      for (const part of shown) {
        lines.push({
          key: `p:${message.rowid}:${part.index}`,
          identity: `p:${message.rowid}:${part.index}@${part.bytes}`,
          head: `{"ms":1,"k":"part","role":"${message.role}","i":${part.index},${envelope},"d":`,
          dataBytes: part.bytes,
          firstByte: part.object ? 0x7b : null,
        });
      }
      if (openAt >= 0) break layout;
      if (message.role === "user") {
        // A prompt is written whole (its parts with it); one with none yet waits when it is the last.
        if (its.length === 0 && index === last) break;
        lines.push({ key: `u:${message.rowid}`, identity: `u:${message.rowid}`, head: `{"ms":1,"k":"user",${envelope}}`, dataBytes: -1, firstByte: null });
      } else if (index < last || (its.length > 0 && its[its.length - 1]!.kind === "text")) {
        lines.push({ key: `e:${message.rowid}`, identity: `e:${message.rowid}`, head: `{"ms":1,"k":"end",${envelope}}`, dataBytes: -1, firstByte: null });
      }
    }
    return lines;
  }

  async data(view: MastraViewPath, _state: MastraState, lines: readonly StoreLine[]): Promise<Map<string, Uint8Array>> {
    const rows = lines
      .map((line) => {
        const [, rowid, index] = line.key.split(":");
        return { rowid: Number(rowid), index: Number(index), bytes: line.dataBytes };
      })
      .filter((row) => Number.isSafeInteger(row.rowid) && Number.isSafeInteger(row.index));
    const sql = mastraDataSQL(view.thread, rows);
    const out = new Map<string, Uint8Array>();
    if (sql === null) return out;
    const asked = rows.reduce((sum, row) => sum + row.bytes, 0);
    for (const line of await this.run(view, sql, asked * 2 + rows.length * 40 + 1_024)) {
      const [rowid, index, hex] = line.split(" ");
      if (storeInteger(rowid) === null || storeInteger(index) === null || hex === undefined || hex === "-" || hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) continue;
      const bytes = new Uint8Array(hex.length / 2);
      for (let at = 0; at < bytes.length; at += 1) bytes[at] = parseInt(hex.slice(at * 2, at * 2 + 2), 16);
      out.set(`p:${rowid}:${index}`, bytes);
    }
    return out;
  }

  placeholder(why: "notJSON" | "oversized" | "changed"): string {
    return mastraPlaceholder(why);
  }
}

/** Mastra Code threads as JSONL views: the store-lines view over MastraStoreSource. */
export class MastraStoreView extends StoreLinesView<MastraViewPath, MastraState> {
  constructor(query: CursorQuery, stamp: CursorStamp, notFound: NotFound, now?: () => number) {
    super(new MastraStoreSource(query), stamp, notFound, now);
  }
}
