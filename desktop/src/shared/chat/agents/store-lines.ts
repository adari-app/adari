// A session kept in a store (a SQLite database, or one JSON document rewritten in place) read as
// the JSONL file the other readers follow, the way agents/opencode-store.ts reads OpenCode's: a source (Hermes,
// agents/hermes-store.ts; Mastra Code, agents/mastra-store.ts; Cline, agents/cline-store.ts) lays the session
// out as lines, each an envelope it writes around one row's data, then "\n"; this view keeps their offsets,
// fetches only the rows a read's byte range covers (in batches, cached), and moves to a new revision when a
// line already laid out changes or moves (the feed starts over, TranscriptStoreReading, as a Cursor store's).
//
// What a source shows only grows while a session is written: a row still being written is left out until it
// settles. A row longer than a line may be, or one that is not a JSON object, is a short placeholder line the
// parsers skip and count; one rewritten since it was laid out reads as a "changed" placeholder as long, and the
// next refresh lays the view out again.
//
// SQLite sources run every query as one read-only `/usr/bin/sqlite3` exec (sqliteQueryCommand: `mode=ro`, or
// `mode=ro&immutable=1` when a -wal is there without its -shm or that fails, as cursor-store.ts: nothing is made
// in the agent's folder). Only checked ids and integers go into a query.

import { cursorRows, cursorStoreURI, type CursorContext, type CursorQuery, type CursorStamp, type NotFound, type TranscriptStoreReading } from "../cursor-store";
import { maxLineBytes } from "../follower";

const sqlite = "/usr/bin/sqlite3";

const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

/**
 * One `/bin/sh` command running `sql` read-only on `database` (a path its source checked): `mode=ro` unless a
 * -wal is there without its -shm (sqlite would make the -shm in the agent's folder), else or on failure
 * `mode=ro&immutable=1`; `#ok` last when one ran (cursorRows reads it).
 */
export function sqliteQueryCommand(database: string, sql: string): string {
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

/** A query that did not run (no `#ok`): the store could not be read. */
export class StoreQueryError extends Error {
  constructor(readonly database: string) {
    super(`the store could not be read: ${database}`);
  }
}

/** The session (or its store) is not there any more: the view is looked up again from the start. */
export class StoreGoneError extends Error {
  constructor() {
    super("the session is not in its store");
  }
}

/** Runs `sql` read-only on `database`: the lines it printed; StoreQueryError when it did not run. */
export async function runStoreQuery(query: CursorQuery, database: string, sql: string, maxOutput: number): Promise<string[]> {
  const rows = cursorRows(await query(sqliteQueryCommand(database, sql), maxOutput));
  if (rows === null) throw new StoreQueryError(database);
  return rows;
}

/** A safe integer from a query's digits; null for anything else. */
export const storeInteger = (value: string | undefined): number | null => {
  if (value === undefined || !/^-?\d{1,16}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/** Text of a hex string when it is UTF-8; null otherwise. */
export function storeHexText(hex: string): string | null {
  if (hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A store's folder as a line's envelope carries it: absolute, no control characters, trailing slashes off; null else. */
export function storeFolder(value: string | null): string | null {
  if (value === null) return null;
  let folder = value;
  while (folder.length > 1 && folder.endsWith("/")) folder = folder.slice(0, -1);
  if (!folder.startsWith("/") || new TextEncoder().encode(folder).length > 4_096) return null;
  for (const character of folder) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return folder;
}

// MARK: - lines

/** One line of a view, as its source laid it out. */
export interface StoreLine {
  /** Unique in the view (the row it shows). */
  readonly key: string;
  /** What it shows: when a line already laid out changes identity, the view moves to a new revision. */
  readonly identity: string;
  /** The envelope before the data (the data and "}" follow), or the whole line when `dataBytes` is -1. */
  readonly head: string;
  /** The data's length in bytes; -1 for a line with none. */
  readonly dataBytes: number;
  /** The data's first byte (0x7b for a JSON object); null when unknown. */
  readonly firstByte: number | null;
}

/** A store a view reads: its path rule, what says it changed, its lines and their data. */
export interface StoreLinesSource<P, S> {
  /** The view path's parts; null for another path. */
  parse(path: string): P | null;
  /** The files whose size and time say the store changed; the first must be there. */
  stamped(view: P): readonly string[];
  /** A new session's own state (what the source keeps between refreshes). */
  fresh(): S;
  /**
   * The view's lines now, in order, what is still being written left out; null when nothing changed (never when
   * `force`: a line read back changed since it was laid out). StoreGoneError when the session went.
   */
  lines(view: P, state: S, force: boolean): Promise<readonly StoreLine[] | null>;
  /** The data of `lines` by key, each only when it is still as long as laid out. */
  data(view: P, state: S, lines: readonly StoreLine[]): Promise<Map<string, Uint8Array>>;
  /** A placeholder line (no data) the source's parser skips and counts. */
  placeholder(why: "notJSON" | "oversized" | "changed"): string;
}

interface Entry {
  readonly key: string;
  readonly identity: string;
  readonly start: number;
  /** Bytes before its "\n". */
  readonly length: number;
  readonly head: Uint8Array;
  /** The data's bytes; -1 for a line with none. */
  readonly dataBytes: number;
  /** The placeholder's reason when it is one. */
  readonly placeholder: string | null;
}

const lineEnd = (entry: Entry): number => entry.start + entry.length + 1;

interface State<S> {
  fingerprint: string | null;
  checkedAt: number;
  /** A line read back was not as laid out: the source lists again. */
  stale: boolean;
  source: S;
  entries: Entry[];
  size: number;
  revision: number;
  used: number;
}

export interface StoreLinesStats {
  refreshes: number;
  rowsFetched: number;
  bytesFetched: number;
  readonly placeholders: Map<string, number>;
}

const encoder = new TextEncoder();

/**
 * A store's sessions as JSONL views (the module comment). `size` asks the source again when the store's files
 * changed (their size and time, `stamp`) or `pollMs` passed; `read` fetches only the lines its range covers that
 * it does not hold, in batches of at most `batchBytes` and `batchRows`.
 */
export class StoreLinesView<P, S> implements TranscriptStoreReading {
  /** Asked again this often while followed, even when the stamps say nothing changed (whole-second times). */
  static readonly pollMs = 900;
  static readonly batchBytes = 1 * 1_024 * 1_024;
  static readonly batchRows = 256;
  static readonly cacheBytes = 16 * 1_024 * 1_024;
  static readonly keptStores = 8;

  private readonly states = new Map<string, State<S>>();
  private useSerial = 0;
  private readonly refreshing = new Map<string, Promise<number>>();
  private readonly cache = new Map<string, Uint8Array>();
  private cacheTotal = 0;
  readonly stats: StoreLinesStats = { refreshes: 0, rowsFetched: 0, bytesFetched: 0, placeholders: new Map() };

  constructor(
    private readonly source: StoreLinesSource<P, S>,
    private readonly stamp: CursorStamp,
    private readonly notFound: NotFound,
    private readonly now: () => number = () => Date.now(),
  ) {}

  storeRevision(path: string): Promise<number> {
    return Promise.resolve(this.states.get(path)?.revision ?? 0);
  }

  /** No context ring: these stores give no window size. */
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

  private async refresh(path: string): Promise<number> {
    const view = this.source.parse(path);
    if (view === null) throw this.notFound(path);
    const stamps: string[] = [];
    for (const [index, file] of this.source.stamped(view).entries()) {
      const stamp = index === 0 ? await this.stamp(file) : await this.stamp(file).catch(() => null);
      if (index === 0 && stamp === null) {
        this.states.delete(path);
        throw this.notFound(path);
      }
      stamps.push(stamp ?? "-");
    }
    const fingerprint = stamps.join("|");
    const state: State<S> = this.states.get(path) ?? { fingerprint: null, checkedAt: -Infinity, stale: false, source: this.source.fresh(), entries: [], size: 0, revision: 0, used: 0 };
    const time = this.now();
    if (state.fingerprint === fingerprint && time - state.checkedAt < StoreLinesView.pollMs) return state.size;
    this.stats.refreshes += 1;
    let lines: readonly StoreLine[] | null;
    const force = state.stale;
    try {
      lines = await this.source.lines(view, state.source, force);
    } catch (error) {
      if (error instanceof StoreGoneError) {
        this.states.delete(path);
        throw this.notFound(path);
      }
      throw error;
    }
    if (force) state.stale = false;
    state.fingerprint = fingerprint;
    state.checkedAt = time;
    if (lines !== null) this.layOut(state, lines);
    this.keep(path, state);
    return state.size;
  }

  /** The view's offsets from the source's lines; a line already laid out that moved or changed is a new revision. */
  private layOut(state: State<S>, lines: readonly StoreLine[]): void {
    const entries: Entry[] = [];
    let offset = 0;
    for (const line of lines) {
      let head = encoder.encode(line.head);
      let dataBytes = line.dataBytes;
      let identity = line.identity;
      let placeholder: string | null = null;
      if (dataBytes >= 0) {
        const why = line.firstByte !== 0x7b ? "notJSON" : head.length + dataBytes + 2 > maxLineBytes ? "oversized" : null;
        if (why !== null) {
          head = encoder.encode(this.source.placeholder(why));
          dataBytes = -1;
          identity = `${line.key}#${why}`;
          placeholder = why;
        }
      }
      const length = dataBytes < 0 ? head.length : head.length + dataBytes + 1;
      const entry: Entry = { key: line.key, identity, start: offset, length, head, dataBytes, placeholder };
      entries.push(entry);
      offset = lineEnd(entry);
    }
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

  private keep(path: string, state: State<S>): void {
    this.useSerial += 1;
    state.used = this.useSerial;
    this.states.set(path, state);
    if (this.states.size > StoreLinesView.keptStores) {
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
    const view = this.source.parse(path);
    if (state === undefined || view === null) throw this.notFound(path);
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
      if (entry.dataBytes < 0) continue;
      const held = this.cache.get(cacheKey(entry));
      if (held !== undefined && held.length === entry.dataBytes) fetched.set(entry.key, held);
      else wanted.push(entry);
    }
    let start = 0;
    while (start < wanted.length) {
      const batch: Entry[] = [];
      let bytes = 0;
      let cursor = start;
      while (cursor < wanted.length && batch.length < StoreLinesView.batchRows && (batch.length === 0 || bytes + wanted[cursor]!.dataBytes <= StoreLinesView.batchBytes)) {
        batch.push(wanted[cursor]!);
        bytes += wanted[cursor]!.dataBytes;
        cursor += 1;
      }
      start = cursor;
      const asked = batch.map((entry): StoreLine => ({ key: entry.key, identity: entry.identity, head: "", dataBytes: entry.dataBytes, firstByte: 0x7b }));
      const answer = await this.source.data(view, state.source, asked);
      for (const entry of batch) {
        const data = answer.get(entry.key);
        if (data === undefined || data.length !== entry.dataBytes) continue;
        this.stats.rowsFetched += 1;
        this.stats.bytesFetched += data.length;
        const line = data.map((byte) => (byte === 0x0a || byte === 0x0d ? 0x20 : byte));
        fetched.set(entry.key, line);
        this.remember(cacheKey(entry), line);
      }
    }
    const out = new Uint8Array(end - offset);
    let written = 0;
    for (const entry of covered) {
      const line = new Uint8Array(entry.length + 1).fill(0x20);
      line.set(entry.head);
      if (entry.dataBytes < 0) {
        if (entry.placeholder !== null) this.count(entry.placeholder);
      } else {
        const data = fetched.get(entry.key);
        if (data !== undefined && data.length === entry.dataBytes) {
          line.set(data, entry.head.length);
          line[entry.head.length + data.length] = 0x7d;
        } else {
          // Rewritten (or gone) since it was laid out: a placeholder as long; the next refresh lays it out again.
          this.count("changed");
          state.fingerprint = null;
          state.stale = true;
          const placeholder = encoder.encode(this.source.placeholder("changed"));
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
    if (bytes.length > StoreLinesView.cacheBytes / 4) return;
    if (this.cache.has(key)) this.cacheTotal -= this.cache.get(key)!.length;
    this.cache.delete(key);
    this.cache.set(key, bytes);
    this.cacheTotal += bytes.length;
    for (const [oldest, held] of this.cache) {
      if (this.cacheTotal <= StoreLinesView.cacheBytes) break;
      this.cache.delete(oldest);
      this.cacheTotal -= held.length;
    }
  }
}
