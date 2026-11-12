// A Cursor agent chat on the Mac Chat reads, `~/.cursor/chats/<md5 of the
// cwd>/<chat id>/` with meta.json (`{schemaVersion, createdAtMs, hasConversation, title,
// updatedAtMs, cwd}`), prompt_history.json and store.db (SQLite in WAL mode: tables
// `blobs(id, data)` and `meta(key, value)`), and its store read as the JSONL file the other
// readers follow. A port of HerdrKit's CursorStore.swift and CursorStoreView.swift.
//
// The root blob (`meta` row "0"'s `latestRootBlobId`) lists the conversation's message blobs in
// order (protobuf field 1, raw 32-byte ids); each is one line of the view: the blob's JSON with any
// raw line break as a space (the same length), then "\n". A ref the store does not hold, a blob that
// is not JSON, one longer than a line may be, or one whose hex comes back bad is a short placeholder
// line the parser skips and counts (`{"cursorRef":"missing"}`); refs missing at the end wait until
// they land. So the feed's cold window, follower, catch-up and earlier reader run as they do over a
// file, and fetch only the blobs their byte ranges cover.
//
// Every read is one read-only `/usr/bin/sqlite3` exec, `mode=ro` first and `mode=ro&immutable=1`
// when that fails or would create Cursor's -shm. The root id is read inside sqlite, so the meta row's
// encryption key never leaves the Mac. Only `[0-9a-f]{64}` ids go into a query; only a 32-hex folder
// hash and a UUID chat folder ever form a path. The reader never creates a file in a Cursor folder
// (no new -shm, -wal or journal) and never changes store.db, store.db-wal or meta.json; SQLite's read
// marks in an existing -shm may change, as every WAL reader's do (coordination,
// not a database write; an immutable open would miss a live WAL's data).

import { maxLineBytes } from "./follower";

const uuidPattern = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const hasControl = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** 32 lower-case hex characters (an md5). */
export const isCursorFolderHash = (value: string): boolean => /^[0-9a-f]{32}$/.test(value);

/** A blob id: 64 lower-case hex characters. */
export const isCursorBlobID = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

/** A store path: absolute, at most 4,096 bytes, no control characters, ending `/.cursor/chats/<32 hex>/<uuid>/store.db`. */
export function isCursorStorePath(path: string): boolean {
  if (!path.startsWith("/") || new TextEncoder().encode(path).length > 4_096 || hasControl(path)) return false;
  const parts = path.split("/");
  const n = parts.length;
  if (n < 6 || parts[n - 1] !== "store.db" || parts[n - 4] !== "chats" || parts[n - 5] !== ".cursor") return false;
  if (parts.slice(0, -1).some((part) => part === ".." || part === ".")) return false;
  return isCursorFolderHash(parts[n - 3]!) && uuidPattern.test(parts[n - 2]!);
}

/** The chat id a store path is filed under; null for another path. */
export function cursorChatIDOfStore(path: string): string | null {
  if (!isCursorStorePath(path)) return null;
  const parts = path.split("/");
  return parts[parts.length - 2]!;
}

/** The meta.json beside a chat's store.db; null for another path. */
export function cursorMetaPath(store: string): string | null {
  return isCursorStorePath(store) ? store.slice(0, -"store.db".length) + "meta.json" : null;
}

/** A meta.json is a few hundred bytes; one this long or longer is not read. */
export const maxCursorMetaBytes = 64 * 1_024;

/** The meta's top-level `cwd` (read as JSON), trailing slash ignored; null when it is not JSON, too long, or names no usable folder. */
export function cursorMetaFolder(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length >= maxCursorMetaBytes) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const cwd = (meta as Record<string, unknown>).cwd;
  if (typeof cwd !== "string" || !cwd.startsWith("/") || new TextEncoder().encode(cwd).length > 4_096 || hasControl(cwd)) return null;
  let folder = cwd;
  while (folder.length > 1 && folder.endsWith("/")) folder = folder.slice(0, -1);
  return folder;
}

// MARK: - md5 (the folder Cursor files a working folder's chats in)

const md5Shifts = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const md5Table = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);

/** The md5 of `bytes`, 32 lower-case hex characters. */
export function md5Hex(bytes: Uint8Array): string {
  const length = bytes.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const bits = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + md5Table[i]! + view.getUint32(chunk + g * 4, true)) >>> 0;
      a = d;
      d = c;
      c = b;
      const shift = md5Shifts[i]!;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  let hex = "";
  for (const word of [a0, b0, c0, d0]) {
    for (let byte = 0; byte < 4; byte += 1) hex += ((word >>> (byte * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

/** The folder Cursor files a working folder's chats in: the md5 of the path (trailing slash not the folder's). */
export function cursorFolderHash(folder: string): string {
  let trimmed = folder;
  while (trimmed.length > 1 && trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return md5Hex(new TextEncoder().encode(trimmed));
}

// MARK: - the queries

const sqlite = "/usr/bin/sqlite3";

const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

/** What a placeholder line says. */
export type CursorPlaceholder = "missing" | "notJSON" | "oversized" | "badHex";

export const placeholderLine = (placeholder: CursorPlaceholder): Uint8Array => new TextEncoder().encode(`{"cursorRef":"${placeholder}"}`);

/** The root id, read inside sqlite: only it is printed. */
export const cursorRootIDSQL = "select json_extract(cast(unhex(value) as text), '$.latestRootBlobId') from meta where key='0';";

export const cursorRootSQL = (id: string): string | null => (isCursorBlobID(id) ? `select hex(data) from blobs where id='${id}';` : null);

/** Each blob's id, its length in bytes and its first byte (hex). */
export function cursorLengthsSQL(ids: readonly string[]): string | null {
  if (ids.length === 0 || !ids.every(isCursorBlobID)) return null;
  return (
    "select id||' '||length(cast(data as blob))||' '||hex(substr(cast(data as blob),1,1)) from blobs where id in (" +
    ids.map((id) => `'${id}'`).join(",") +
    ");"
  );
}

export function cursorBlobsSQL(ids: readonly string[]): string | null {
  if (ids.length === 0 || !ids.every(isCursorBlobID)) return null;
  return "select id||' '||hex(data) from blobs where id in (" + ids.map((id) => `'${id}'`).join(",") + ");";
}

/** `file:` URI of the store, every byte but unreserved ones and "/" as %XX. */
export function cursorStoreURI(path: string, immutable: boolean): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(path)) {
    const plain =
      (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte === 45 || byte === 46 || byte === 95 || byte === 126 || byte === 47;
    encoded += plain ? String.fromCharCode(byte) : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return "file:" + encoded + (immutable ? "?mode=ro&immutable=1" : "?mode=ro");
}

/**
 * One `/bin/sh` command running `sql` read-only on the store: `mode=ro` unless a -wal is there
 * without its -shm (sqlite would create the -shm in Cursor's folder), else or on failure
 * `mode=ro&immutable=1`; `#ok` last when one ran. `-init /dev/null` keeps a ~/.sqliterc out. Null
 * for a path that is not a store.
 */
export function cursorQueryCommand(store: string, sql: string): string | null {
  if (!isCursorStorePath(store)) return null;
  const run = (immutable: boolean): string => sqlite + " -init /dev/null -readonly -batch " + quote(cursorStoreURI(store, immutable)) + " " + quote(sql) + " 2>/dev/null";
  const script =
    "d=" +
    quote(store) +
    '; r=1; if [ ! -f "$d-wal" ] || [ -f "$d-shm" ]; then ' +
    run(false) +
    " && r=0; fi; " +
    'if [ "$r" != 0 ]; then ' +
    run(true) +
    " && r=0; fi; [ \"$r\" = 0 ] && echo '#ok'; exit 0";
  return "/bin/sh -c " + quote(script);
}

/** The lines a query printed, or null when it did not run (no `#ok`). */
export function cursorRows(output: string): string[] | null {
  const lines = output.split(/[\n\r]+/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
  if (lines[lines.length - 1] !== "#ok") return null;
  lines.pop();
  return lines.filter((line) => line.length > 0);
}

/** Bytes of a hex string; null when it is not hex. */
export function cursorHexBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

// MARK: - the root

/** What the root blob holds: its message refs in order (field 1), and the context use (field 5: used, window) when both are sane. */
export interface CursorRoot {
  readonly refs: string[];
  used: number | null;
  window: number | null;
}

type WireValue = { readonly type: "varint"; readonly value: bigint } | { readonly type: "bytes"; readonly value: Uint8Array } | { readonly type: "fixed" };

/** Walks one protobuf message's fields; false when it does not parse. */
function walk(bytes: Uint8Array, visit: (field: number, value: WireValue) => void): boolean {
  let index = 0;
  const varint = (): bigint | null => {
    let value = 0n;
    let shift = 0n;
    while (index < bytes.length && shift < 64n) {
      const byte = bytes[index]!;
      index += 1;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
      shift += 7n;
    }
    return null;
  };
  while (index < bytes.length) {
    const key = varint();
    if (key === null || key >> 3n === 0n || key >> 3n >= 1n << 29n) return false;
    const field = Number(key >> 3n);
    switch (Number(key & 7n)) {
      case 0: {
        const value = varint();
        if (value === null) return false;
        visit(field, { type: "varint", value });
        break;
      }
      case 1:
        if (index + 8 > bytes.length) return false;
        index += 8;
        visit(field, { type: "fixed" });
        break;
      case 2: {
        const length = varint();
        if (length === null || length > BigInt(bytes.length - index)) return false;
        const end = index + Number(length);
        visit(field, { type: "bytes", value: bytes.subarray(index, end) });
        index = end;
        break;
      }
      case 5:
        if (index + 4 > bytes.length) return false;
        index += 4;
        visit(field, { type: "fixed" });
        break;
      default:
        return false;
    }
  }
  return true;
}

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The root's refs and context; null when it is not a protobuf message. */
export function cursorRoot(bytes: Uint8Array): CursorRoot | null {
  const root: CursorRoot = { refs: [], used: null, window: null };
  const walked = walk(bytes, (field, value) => {
    if (field === 1 && value.type === "bytes" && value.value.length === 32) root.refs.push(hexOf(value.value));
    else if (field === 5 && value.type === "bytes") {
      let used: bigint | null = null;
      let window: bigint | null = null;
      walk(value.value, (inner, innerValue) => {
        if (innerValue.type !== "varint") return;
        if (inner === 1) used = innerValue.value;
        if (inner === 2) window = innerValue.value;
      });
      if (used !== null && window !== null && window >= 1_000n && window <= 100_000_000n && used <= window) {
        root.used = Number(used);
        root.window = Number(window);
      }
    }
  });
  return walked ? root : null;
}

// MARK: - the view

export class CursorStoreError extends Error {
  constructor(
    readonly kind: "queryFailed" | "badRoot",
    readonly path: string,
  ) {
    super(kind === "queryFailed" ? `the Cursor store could not be read: ${path}` : `the Cursor store's root is not readable: ${path}`);
  }
}

/** Runs a read-only command on the Mac, its stdout up to `maxOutputBytes`. */
export type CursorQuery = (command: string, maxOutputBytes: number) => Promise<string>;
/** A file's size and modification time as one string; null when it is not there. */
export type CursorStamp = (path: string) => Promise<string | null>;

export interface CursorContext {
  readonly used: number;
  readonly window: number;
}

export interface CursorStoreStats {
  queries: number;
  rootReads: number;
  blobsFetched: number;
  blobBytesFetched: number;
  readonly placeholders: Map<string, number>;
}

/** A reader whose file can change other than by growing (a Cursor store): the feed starts over when the revision moves, and reads the ring here. */
export interface TranscriptStoreReading {
  storeRevision(path: string): Promise<number>;
  storeContext(path: string): Promise<CursorContext | null>;
}

export function isTranscriptStoreReading(value: unknown): value is TranscriptStoreReading {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<TranscriptStoreReading>).storeRevision === "function" &&
    typeof (value as Partial<TranscriptStoreReading>).storeContext === "function"
  );
}

interface Entry {
  readonly id: string;
  readonly start: number;
  readonly length: number;
  readonly placeholder: CursorPlaceholder | null;
}

const lineEnd = (entry: Entry): number => entry.start + entry.length + 1;

interface Meta {
  readonly length: number;
  readonly firstByte: number | null;
}

interface State {
  fingerprint: string | null;
  checkedAt: number;
  rootID: string | null;
  metas: Map<string, Meta>;
  entries: Entry[];
  size: number;
  revision: number;
  context: CursorContext | null;
  used: number;
  /** The root's refs as last read. */
  refs: string[];
  /** How often each ref not in yet was asked for under this root. */
  attempts: Map<string, number>;
  /** Refs the root lists (anywhere) whose blobs are not in yet, with attempts left. */
  waiting: boolean;
}

/** The view's not-found error: the caller's (the feed's TranscriptNotFoundError), so a store gone reads as a transcript gone. */
export type NotFound = (path: string) => Error;

/**
 * Cursor stores on one Mac as JSONL views. `size` asks for the root id when the store or its WAL
 * changed (their size and time, `stamp`) or `rootPollMs` passed, and reads the root again when its id
 * moved (refs that wait for their blobs are asked for again);
 * `read` fetches only the blobs its range covers that it does not hold, in batches of at most
 * `batchBytes` and `batchIDs`.
 */
export class CursorStoreView implements TranscriptStoreReading {
  /**
   * A store's root id is asked for again this often while followed, even when
   * its size and time say nothing changed (SFTP's whole-second times hide a root written within the
   * same second): a little under the feed's poll, so every poll may ask. Only a moved root id reads
   * more; blobs held are never fetched again.
   */
  static readonly rootPollMs = 900; // 0.9 of feed.ts's defaultPollIntervalMs (1,000; not imported: feed.ts imports this file)
  /**
   * A ref the root lists whose blob is not in is asked for at most this many
   * times while the root stays (a root that moves asks again); one that never lands then costs nothing.
   */
  static readonly maxRefAttempts = 60;
  static readonly batchBytes = 1 * 1_024 * 1_024;
  static readonly batchIDs = 256;
  static readonly maxBlobBytes = maxLineBytes;
  static readonly maxRootOutput = 8 * 1_024 * 1_024;
  static readonly cacheBytes = 16 * 1_024 * 1_024;
  static readonly keptStores = 8;

  private readonly states = new Map<string, State>();
  private useSerial = 0;
  private readonly refreshing = new Map<string, Promise<number>>();
  private readonly cache = new Map<string, Uint8Array>();
  private cacheTotal = 0;
  readonly stats: CursorStoreStats = { queries: 0, rootReads: 0, blobsFetched: 0, blobBytesFetched: 0, placeholders: new Map() };

  constructor(
    private readonly query: CursorQuery,
    private readonly stamp: CursorStamp,
    private readonly notFound: NotFound,
    private readonly now: () => number = () => Date.now(),
  ) {}

  storeRevision(path: string): Promise<number> {
    return Promise.resolve(this.states.get(path)?.revision ?? 0);
  }

  storeContext(path: string): Promise<CursorContext | null> {
    return Promise.resolve(this.states.get(path)?.context ?? null);
  }

  /** The view's size: the root read again when the store changed. */
  size(path: string): Promise<number> {
    const running = this.refreshing.get(path);
    if (running !== undefined) return running;
    const task = this.refresh(path).finally(() => this.refreshing.delete(path));
    this.refreshing.set(path, task);
    return task;
  }

  private async run(path: string, sql: string, maxOutput: number): Promise<string[]> {
    const command = cursorQueryCommand(path, sql);
    if (command === null) throw this.notFound(path);
    this.stats.queries += 1;
    const rows = cursorRows(await this.query(command, maxOutput));
    if (rows === null) throw new CursorStoreError("queryFailed", path);
    return rows;
  }

  private async refresh(path: string): Promise<number> {
    if (!isCursorStorePath(path)) throw this.notFound(path);
    const db = await this.stamp(path);
    if (db === null) throw this.notFound(path);
    const wal = await this.stamp(path + "-wal").catch(() => null);
    const fingerprint = db + "|" + (wal ?? "-");
    const state: State = this.states.get(path) ?? {
      fingerprint: null,
      checkedAt: -Infinity,
      rootID: null,
      metas: new Map(),
      entries: [],
      size: 0,
      revision: 0,
      context: null,
      used: 0,
      refs: [],
      attempts: new Map(),
      waiting: false,
    };
    const time = this.now();
    if (state.fingerprint === fingerprint && time - state.checkedAt < CursorStoreView.rootPollMs) return state.size;

    const rootRows = await this.run(path, cursorRootIDSQL, 4_096);
    const first = rootRows[0]?.trim() ?? "";
    const rootID = isCursorBlobID(first) ? first : null;
    const rootMoved = state.fingerprint === null || rootID !== state.rootID;
    if (!rootMoved && !state.waiting) {
      state.fingerprint = fingerprint;
      state.checkedAt = time;
      this.keep(path, state);
      return state.size;
    }
    if (rootMoved) {
      let root: CursorRoot = { refs: [], used: null, window: null };
      const rootSQL = rootID === null ? null : cursorRootSQL(rootID);
      if (rootSQL !== null) {
        this.stats.rootReads += 1;
        const rows = await this.run(path, rootSQL, CursorStoreView.maxRootOutput);
        const bytes = rows[0] === undefined ? null : cursorHexBytes(rows[0]);
        const parsed = bytes === null ? null : cursorRoot(bytes);
        if (parsed === null) throw new CursorStoreError("badRoot", path);
        root = parsed;
      }
      state.refs = root.refs;
      state.context = root.used !== null && root.window !== null ? { used: root.used, window: root.window } : null;
      state.attempts = new Map();
    }
    const refs = state.refs;
    const attemptsLeft = (ref: string): boolean => (state.attempts.get(ref) ?? 0) < CursorStoreView.maxRefAttempts;
    // The length and first byte of each ref not known yet. One not in (at the
    // end or in the middle) is asked again while the root stays, up to `maxRefAttempts` times.
    const unknown = [...new Set(refs.filter((ref) => !state.metas.has(ref) && attemptsLeft(ref)))];
    for (let batch = 0; batch < unknown.length; batch += CursorStoreView.batchIDs) {
      const ids = unknown.slice(batch, batch + CursorStoreView.batchIDs);
      const sql = cursorLengthsSQL(ids);
      if (sql === null) continue;
      for (const row of await this.run(path, sql, ids.length * 96 + 1_024)) {
        const parts = row.split(" ");
        const length = Number(parts[1]);
        if (parts.length < 2 || !isCursorBlobID(parts[0]!) || !/^\d+$/.test(parts[1]!)) continue;
        const firstByte = parts.length > 2 ? (cursorHexBytes(parts[2]!)?.[0] ?? null) : null;
        state.metas.set(parts[0]!, { length, firstByte });
      }
    }
    for (const ref of unknown) if (!state.metas.has(ref)) state.attempts.set(ref, (state.attempts.get(ref) ?? 0) + 1);
    const entries: Entry[] = [];
    let offset = 0;
    for (const ref of refs) {
      const meta = state.metas.get(ref);
      let placeholder: CursorPlaceholder | null = null;
      let length = 0;
      if (meta === undefined) placeholder = "missing";
      else if (meta.firstByte !== 0x7b) placeholder = "notJSON";
      else if (meta.length > CursorStoreView.maxBlobBytes) placeholder = "oversized";
      else length = meta.length;
      if (placeholder !== null) length = placeholderLine(placeholder).length;
      const entry: Entry = { id: ref, start: offset, length, placeholder };
      entries.push(entry);
      offset = lineEnd(entry);
    }
    // Refs at the end the store does not hold yet are not in the view until they land.
    while (entries.length > 0 && entries[entries.length - 1]!.placeholder === "missing") entries.pop();
    state.waiting = refs.some((ref) => !state.metas.has(ref) && attemptsLeft(ref));
    // A ref that landed in the middle moves the offsets after it: a new revision (the feed starts over).
    const old = state.entries;
    const extends_ =
      old.length <= entries.length &&
      old.every((entry, index) => {
        const next = entries[index]!;
        return entry.id === next.id && entry.start === next.start && entry.length === next.length && entry.placeholder === next.placeholder;
      });
    if (old.length > 0 && !extends_) state.revision += 1;
    state.entries = entries;
    state.size = entries.length === 0 ? 0 : lineEnd(entries[entries.length - 1]!);
    state.rootID = rootID;
    state.fingerprint = fingerprint;
    state.checkedAt = time;
    // Metas of blobs no longer listed go (a store's root can be rewritten).
    if (state.metas.size > refs.length * 2 + 256) {
      const listed = new Set(refs);
      for (const key of state.metas.keys()) if (!listed.has(key)) state.metas.delete(key);
    }
    this.keep(path, state);
    return state.size;
  }

  private keep(path: string, state: State): void {
    this.useSerial += 1;
    state.used = this.useSerial;
    this.states.set(path, state);
    if (this.states.size > CursorStoreView.keptStores) {
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
    if (state === undefined) throw this.notFound(path);
    const end = Math.min(state.size, offset + Math.max(0, maxBytes));
    if (offset >= end) return new Uint8Array(0);
    const entries = state.entries;
    // The first line that ends after `offset`.
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (lineEnd(entries[mid]!) <= offset) low = mid + 1;
      else high = mid;
    }
    const covered: Entry[] = [];
    for (let index = low; index < entries.length && entries[index]!.start < end; index += 1) covered.push(entries[index]!);
    const fetched = new Map<string, Uint8Array>();
    const wanted: Entry[] = [];
    const wantedIDs = new Set<string>();
    for (const entry of covered) {
      if (entry.placeholder !== null) continue;
      const held = this.cache.get(entry.id);
      if (held !== undefined && held.length === entry.length) fetched.set(entry.id, held);
      else if (!wantedIDs.has(entry.id)) {
        wantedIDs.add(entry.id);
        wanted.push(entry);
      }
    }
    let start = 0;
    while (start < wanted.length) {
      const ids: string[] = [];
      let bytes = 0;
      let cursor = start;
      while (cursor < wanted.length && ids.length < CursorStoreView.batchIDs && (ids.length === 0 || bytes + wanted[cursor]!.length <= CursorStoreView.batchBytes)) {
        ids.push(wanted[cursor]!.id);
        bytes += wanted[cursor]!.length;
        cursor += 1;
      }
      start = cursor;
      const sql = cursorBlobsSQL(ids);
      if (sql === null) continue;
      for (const row of await this.run(path, sql, bytes * 2 + ids.length * 80 + 1_024)) {
        const space = row.indexOf(" ");
        if (space < 0) continue;
        const id = row.slice(0, space);
        if (!wantedIDs.has(id) || fetched.has(id)) continue;
        const blob = cursorHexBytes(row.slice(space + 1));
        if (blob === null) continue;
        this.stats.blobsFetched += 1;
        this.stats.blobBytesFetched += blob.length;
        const line = blob.map((byte) => (byte === 0x0a || byte === 0x0d ? 0x20 : byte));
        fetched.set(id, line);
        this.remember(id, line);
      }
    }
    const out = new Uint8Array(end - offset);
    let written = 0;
    const count = (placeholder: CursorPlaceholder): void => {
      this.stats.placeholders.set(placeholder, (this.stats.placeholders.get(placeholder) ?? 0) + 1);
    };
    for (const entry of covered) {
      const line = new Uint8Array(entry.length + 1).fill(0x20);
      if (entry.placeholder !== null) {
        line.set(placeholderLine(entry.placeholder));
        count(entry.placeholder);
      } else {
        const held = fetched.get(entry.id);
        if (held !== undefined && held.length === entry.length) line.set(held);
        else {
          // Not returned, bad hex, or another length than its row said: a placeholder as long.
          const placeholder = placeholderLine("badHex");
          count("badHex");
          if (entry.length >= placeholder.length) line.set(placeholder);
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

  private remember(id: string, bytes: Uint8Array): void {
    if (bytes.length > CursorStoreView.cacheBytes / 4) return;
    if (this.cache.has(id)) this.cacheTotal -= this.cache.get(id)!.length;
    this.cache.delete(id);
    this.cache.set(id, bytes);
    this.cacheTotal += bytes.length;
    for (const [oldest, held] of this.cache) {
      if (this.cacheTotal <= CursorStoreView.cacheBytes) break;
      this.cache.delete(oldest);
      this.cacheTotal -= held.length;
    }
  }
}
