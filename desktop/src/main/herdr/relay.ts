// The relay client (speed contract v1, T3 Code's shape over SSH): one held
// exec on a saved machine's command connection runs the relay script
// (relay-script.ts) on the Mac, and every Herdr request, the event stream,
// Chat's transcript reads and the transcript watch ride that one channel as
// newline-delimited JSON frames, matched by id. A request is one write and one
// reply (1 trip; an exec per request is about 2).
//
// Client rules (the contract's): no hello within 5 s, or the exec fails, and
// the connection uses today's exec-per-request path unchanged (the relay is
// tried again on the next connect); requests are written without waiting for
// earlier replies, each with its own deadline, a deadline passing fails that
// request only; a ping every 5 s while a window is on screen, no frame for 15
// s drops the channel; on focus or wake a ping with a 2 s deadline, no pong
// drops it. The channel belongs to its SSH client's epoch: when it goes, the
// client goes with it, so a pane action bound to that epoch is refused as on
// any reconnect.

import { relayFrameBytes, relayGrowthBytes } from "../../shared/chat/blobs";
import { maxCommandBytes, maxResponseLineBytes, resolvedSocketSetup, shellQuote } from "./commands";
import {
  ClosedBeforeResponseError,
  RemoteSocketFailedError,
  RequestTimedOutError,
  RequestTooLargeError,
  ResponseTooLargeError,
  TransportError,
} from "./errors";
import { socketMissingDetail } from "./transport";

/** No hello within this: the connection keeps today's exec path. */
export const relayHelloMs = 5_000;
/** A ping this often while a window is on screen… */
export const relayPingEveryMs = 5_000;
/** …and no frame of any kind for this long drops the channel. */
export const relaySilenceMs = 15_000;
/** On focus or wake: a ping with this deadline; no pong drops the channel. */
export const relayWakePingMs = 2_000;
/** The longest line the client writes (the relay drops longer ones as too_large). */
export const maxRelayRequestBytes = 1_048_576;
/** The longest frame read: a Herdr reply up to 16 MiB (contract) and its envelope. */
export const maxRelayFrameBytes = 16 * 1_048_576 + 65_536;
/** One `read` frame asks for at most this; a longer read is several frames, written at once. */
export const relayReadChunkBytes = 512 * 1_024;

/**
 * Raises the soft open-file limit before the relay starts (a non-interactive ssh exec on
 * the Mac gets 256, hard unlimited: 256 held requests plus stdio would leave some without a Herdr connection).
 * A refusal is ignored and the relay runs under the limit it has.
 */
export const relayFileLimit = "ulimit -n 1024 2>/dev/null; ";

/** The one exec that starts the relay: the socket setup the requests use, the file limit raised, then Perl with the script (contract "Launch"). */
export function relayLaunchCommand(session: string, script: string): string {
  const command =
    resolvedSocketSetup(session) +
    relayFileLimit +
    "exec /usr/bin/perl -e \"$(printf '%s' " +
    shellQuote(Buffer.from(script, "utf8").toString("base64")) +
    ' | /usr/bin/base64 -D)" -- "$SOCKET"';
  const bytes = Buffer.byteLength(command, "utf8");
  if (bytes > maxCommandBytes) throw new RequestTooLargeError(bytes, maxCommandBytes);
  return command;
}

/**
 * The relay on a host with herdr-core and no Herdr socket: the same script and launch with no
 * socket (the argument empty), so Chat's reads and watches run on it; a Herdr request there answers
 * socket_missing, as the exec path would.
 */
export function relayReadsLaunchCommand(_session: string, script: string): string {
  const command =
    relayFileLimit +
    "exec /usr/bin/perl -e \"$(printf '%s' " +
    shellQuote(Buffer.from(script, "utf8").toString("base64")) +
    ' | /usr/bin/base64 -D)" -- ""';
  const bytes = Buffer.byteLength(command, "utf8");
  if (bytes > maxCommandBytes) throw new RequestTooLargeError(bytes, maxCommandBytes);
  return command;
}

/** The channel's writing side (an ssh2 exec channel, or a test's fake). */
export interface RelayPipe {
  write(text: string): void;
  close(): void;
}

/** What one `read` frame gave: the file's size and inode now, and the bytes from `offset`. */
export interface RelayRead {
  readonly size: number;
  readonly ino: number;
  readonly offset: number;
  /** The bytes sent: with `omit`, the kept bytes only (the runs left out are in `omitted`). */
  readonly data: Uint8Array;
  /** Contract v1.2: the runs left out ([file offset, length], ascending); absent when the reply has none (no `omit`, or a v1.1 relay). */
  readonly omitted?: readonly (readonly [number, number])[];
}

/** Contract v1.2: a `read`'s optional fields: `omit` K, and `tail` T in place of the offset. */
export interface RelayReadFields {
  readonly omit?: number;
  readonly tail?: number;
}

/** A frame's `omitted`: pairs of whole numbers; null when it is something else. */
function omittedOf(value: unknown): [number, number][] | null {
  if (!Array.isArray(value)) return null;
  const out: [number, number][] = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const offset = count(pair[0]);
    const length = count(pair[1]);
    if (offset === null || length === null) return null;
    out.push([offset, length]);
  }
  return out;
}

/**
 * How many bytes `value` decodes to when it is strict base64 (RFC 4648's
 * alphabet with `=` padding, a length a multiple of 4, nothing else: no line breaks, spaces or URL-safe letters);
 * null for anything else, a missing field included. Nothing is decoded or allocated here.
 */
function base64Length(value: unknown): number | null {
  if (typeof value !== "string" || value.length % 4 !== 0) return null;
  const end = value.length;
  const padding = end === 0 || value.charCodeAt(end - 1) !== 0x3d ? 0 : value.charCodeAt(end - 2) === 0x3d ? 2 : 1;
  for (let index = 0; index < end - padding; index += 1) {
    const code = value.charCodeAt(index);
    const letter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;
    if (!letter) return null;
  }
  return (end / 4) * 3 - padding;
}

/** `value` (strict base64, base64Length) decoded; null when the decoder does not give exactly `length` bytes. */
function decodeBase64(value: string, length: number): Buffer | null {
  const data = Buffer.from(value, "base64");
  return data.length === length ? data : null;
}

/**
 * The file bytes a reply covers (`kept` bytes sent plus the runs left out),
 * checked before anything is decoded or allocated; null when it does not fit: a run that is empty, not ascending
 * from `offset`, or past the kept bytes, a covered length over `limit` (the request's maximum or the protocol
 * cap), or an end past the safe whole numbers. Each length is checked before it is added (the covered sum never
 * passes `limit`, a run's end never passes 2^53 - 1), so no sum can lose precision.
 */
function replyCoverage(offset: number, kept: number, omitted: readonly (readonly [number, number])[], limit: number): number | null {
  if (kept > limit) return null;
  let covered = kept;
  let at = offset;
  let keptLeft = kept;
  for (const [start, length] of omitted) {
    if (start < at || length <= 0) return null;
    const before = start - at;
    if (before > keptLeft) return null;
    keptLeft -= before;
    if (length > limit - covered) return null;
    if (length > Number.MAX_SAFE_INTEGER - start) return null;
    covered += length;
    at = start + length;
  }
  return offset > Number.MAX_SAFE_INTEGER - covered ? null : covered;
}

/**
 * A reply's `omitted` field: undefined only when the frame has no such field (an older relay); any
 * value present goes through omittedOf, so null or anything else not ranges is null (a reply it cannot describe).
 */
function omittedField(parsed: Record<string, unknown>): [number, number][] | null | undefined {
  return Object.prototype.hasOwnProperty.call(parsed, "omitted") ? omittedOf(parsed["omitted"]) : undefined;
}

/** A `stream`'s follower: each line Herdr sends on it, and its end. */
export interface RelayStreamSink {
  line(text: string): void;
  ended(reason: string): void;
}

/** A `watch`'s follower (contract frame 5). */
export interface RelayWatchSink {
  /** `omitted`, with `omit` (contract v1.2): the runs left out of `data` (the kept bytes). */
  grew(offset: number, size: number, data: Uint8Array, omitted?: readonly (readonly [number, number])[]): void;
  reset(size: number, ino: number): void;
  gone(): void;
  /** The watch ended without reset or gone: the channel went, or the relay refused it. */
  ended(reason: string): void;
  /** The relay refused the watch with this code (said just before `ended`). */
  refused?(code: string): void;
}

export interface RelayHandle {
  close(): void;
}

/**
 * What a `read`'s reply may be, kept with the request: where it starts (the
 * offset asked; a `tail` read's start is worked out from the reply's size), the most file bytes it covers (the
 * `max` asked, at most the 4 MiB cap) and whether runs may be left out (`omit` asked).
 */
interface ReadAsked {
  readonly offset: number;
  readonly tail: number | null;
  readonly limit: number;
  readonly omit: boolean;
}

/** A watch's follower and where its next `grew` starts (the offset asked, then each grew's end, a reset's size). */
interface Watching {
  readonly sink: RelayWatchSink;
  readonly omit: boolean;
  at: number;
}

type Waiter =
  /** `asked`: the caller's own id (null: none), given back in the reply line in place of the wire id. */
  | { readonly kind: "request"; readonly asked: string | null; resolve(reply: string): void; reject(error: Error): void; timer: NodeJS.Timeout | null }
  | { readonly kind: "read"; readonly asked: ReadAsked; resolve(read: RelayRead | null): void; reject(error: Error): void; timer: NodeJS.Timeout | null }
  | { readonly kind: "ping"; resolve(pong: boolean): void; timer: NodeJS.Timeout | null };

/**
 * A `read` reply the client cannot describe (no size or offset, or `omitted` that is not ranges): a
 * TransportError. `noOffset` when the only thing missing is the offset (none given, or null; the size and any
 * `omitted` fine): the one the reader tells apart, to read a `tail` the older way. Also a reply its request does
 * not allow (readReply), refused before its data is decoded.
 */
export class RelayReplyError extends TransportError {
  constructor(
    message: string,
    readonly noOffset = false,
  ) {
    super(message);
  }
}

/** The relay's own refusal of a frame (contract error codes other than the socket's). */
export class RelayRefusedError extends TransportError {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`the relay refused the request (${code}${detail === "" ? "" : `: ${detail}`})`);
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
/**
 * A counter the relay sends (a size, an offset, an inode, a run's offset or length): a safe whole number only, as
 * Swift's `RelayClient.count`; null for a fraction, a negative, one past 2^53 - 1, or anything not a number.
 */
const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** A line's leading `"id"` (its head before the string, and the string's body). */
const leadingId = /^(\s*\{\s*"id"\s*:\s*)"((?:[^"\\]|\\.)*)"/;

/** The end (exclusive) of the JSON string token opening at `at` (a `"`), or -1. */
function stringEnd(line: string, at: number): number {
  for (let index = at + 1; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\") index += 1;
    else if (char === '"') return index + 1;
  }
  return -1;
}

/** The end (exclusive) of the JSON value starting at `at` (a string, an object or array, or a bare literal), or -1. */
function valueEnd(line: string, at: number): number {
  if (line[at] === '"') return stringEnd(line, at);
  if (line[at] === "{" || line[at] === "[") {
    let depth = 0;
    for (let index = at; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        index = stringEnd(line, index) - 1;
        if (index < 0) return -1;
      } else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }
  const bare = /^[^\s,}\]]+/.exec(line.slice(at));
  return bare === null ? -1 : at + bare[0].length;
}

/**
 * Where the top-level `"id"` string's token stands in `line` ([start, end), quotes included),
 * whatever its position among the keys (the last, as JSON.parse keeps); null when there is none or the line
 * is not one JSON object.
 */
function topLevelId(line: string): { start: number; end: number; value: string } | null {
  const space = /\s*/y;
  const skip = (at: number): number => {
    space.lastIndex = at;
    space.exec(line);
    return space.lastIndex;
  };
  let at = skip(0);
  if (line[at] !== "{") return null;
  at = skip(at + 1);
  if (line[at] === "}") return null;
  let found: { start: number; end: number; value: string } | null = null;
  for (;;) {
    if (line[at] !== '"') return null;
    const keyEnd = stringEnd(line, at);
    if (keyEnd < 0) return null;
    let key: unknown;
    try {
      key = JSON.parse(line.slice(at, keyEnd));
    } catch {
      return null;
    }
    at = skip(keyEnd);
    if (line[at] !== ":") return null;
    at = skip(at + 1);
    const end = valueEnd(line, at);
    if (end < 0) return null;
    if (key === "id") {
      found = null;
      if (line[at] === '"') {
        try {
          found = { start: at, end, value: JSON.parse(line.slice(at, end)) as string };
        } catch {
          return null;
        }
      }
    }
    at = skip(end);
    if (line[at] === "}") return found;
    if (line[at] !== ",") return null;
    at = skip(at + 1);
  }
}

/**
 * `line` with its top-level `"id"` `from` replaced by `to`, wherever that key stands, the rest of the line byte
 * for byte (Herdr's wide integers keep every digit); null when its id is not `from`. The scanner runs only for a
 * line that parsed as one JSON object (`parsed`); any other line is matched by a leading id only (the scanner is
 * not a validator).
 */
function spliceId(line: string, from: string, to: string, parsed: boolean): string | null {
  const id = parsed ? topLevelId(line) : null;
  if (id !== null) return id.value === from ? line.slice(0, id.start) + JSON.stringify(to) + line.slice(id.end) : null;
  const lead = leadingId.exec(line);
  if (lead === null) return null;
  try {
    return JSON.parse(`"${lead[2]}"`) === from ? lead[1] + JSON.stringify(to) + line.slice(lead[0].length) : null;
  } catch {
    return null;
  }
}

/** A Herdr reply's id from its line (the leading `"id"` without a full parse when it stands first). */
function replyId(line: string): string | null {
  const lead = /^\s*\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line);
  if (lead !== null) {
    try {
      return JSON.parse(`"${lead[1]}"`) as string;
    } catch {
      return null;
    }
  }
  try {
    return text(record(JSON.parse(line))?.["id"]);
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const undescribedRead = "the relay sent a read it could not describe";

/**
 * A `read` reply as the request it answers allows, or the RelayReplyError that fails the read. Everything is checked
 * before the data is decoded: the counters are safe whole numbers; `data` is strict base64; `omitted` only when `omit`
 * was asked; the covered file bytes (kept plus left out) at most the `max` asked and the 4 MiB cap, their end a safe
 * whole number; the start the offset asked (a `tail` read: `max(0, size - tail)`, or 0 from a relay that ignored
 * `tail`, which also sends no `omitted`); bytes only from a start inside the file. The file may grow between the
 * relay's stat and its read, so a read may run past its `size` (a `grew` cannot: its bytes come from that size).
 */
function readReply(parsed: Record<string, unknown>, asked: ReadAsked): RelayRead | RelayReplyError {
  const size = count(parsed["size"]);
  const offset = count(parsed["offset"]);
  // Contract v1.2: the runs left out, when the reply lists them. Only an absent field is an older relay's reply; one
  // present is a list (null too is not, and fails the read).
  const omitted = omittedField(parsed);
  if (size === null || offset === null || omitted === null) {
    const noOffset = size !== null && omitted !== null && (parsed["offset"] === undefined || parsed["offset"] === null);
    return new RelayReplyError(undescribedRead, noOffset);
  }
  const ino = count(parsed["ino"]);
  const kept = base64Length(parsed["data"]);
  if (ino === null || kept === null || (omitted !== undefined && !asked.omit)) return new RelayReplyError(undescribedRead);
  const covered = replyCoverage(offset, kept, omitted ?? [], asked.limit);
  if (covered === null) return new RelayReplyError(undescribedRead);
  const start = asked.tail === null ? asked.offset : omitted === undefined ? 0 : size > asked.tail ? size - asked.tail : 0;
  if (offset !== start || (covered > 0 && offset >= size)) return new RelayReplyError(undescribedRead);
  const data = decodeBase64(parsed["data"] as string, kept);
  if (data === null) return new RelayReplyError(undescribedRead);
  return { size, ino, offset, data, ...(omitted === undefined ? {} : { omitted }) };
}

/** A `grew` the watch can take (relay contract frame 5 and v1.2); null when it is something else. */
interface Growth {
  readonly offset: number;
  readonly size: number;
  readonly data: Uint8Array;
  readonly omitted: [number, number][] | undefined;
  /** The file bytes it covers (kept and left out): the watch's next `grew` starts after them. */
  readonly covered: number;
}

/**
 * A `grew` as its watch allows, checked before the data is decoded; null when
 * it does not fit: a counter that is not a safe whole number, `data` not strict base64, `omitted` not ranges or
 * sent to a watch without `omit`, a start other than where the watch stands, more than the 256 KB a frame covers,
 * or bytes past the file's size it gives.
 */
function grewReply(parsed: Record<string, unknown>, watch: Watching): Growth | null {
  const offset = count(parsed["offset"]);
  const size = count(parsed["size"]);
  const omitted = omittedField(parsed);
  const kept = base64Length(parsed["data"]);
  if (offset === null || size === null || omitted === null || kept === null || (omitted !== undefined && !watch.omit)) return null;
  if (offset !== watch.at) return null;
  const covered = replyCoverage(offset, kept, omitted ?? [], relayGrowthBytes);
  if (covered === null || covered > size - offset) return null;
  const data = decodeBase64(parsed["data"] as string, kept);
  return data === null ? null : { offset, size, data, omitted, covered };
}

/**
 * One relay channel. The owner feeds it the channel's stdout (`data`) and its
 * end (`finish`); `hello` settles true on the relay's hello within 5 s, false
 * otherwise (the owner then closes it and uses the exec path).
 */
/** Contract v1.1: the relay retired the request (300 s) or was at its cap of open requests. */
const retiredCodes: ReadonlySet<string> = new Set(["expired", "limit"]);

export class RelayClient {
  readonly hello: Promise<boolean>;
  /** When the last frame of any kind came (ms, Date.now). */
  lastFrameAt = Date.now();
  private helloSeen = false;
  private settleHello: (ok: boolean) => void = () => undefined;
  private helloTimer: NodeJS.Timeout | null;
  private readonly waiters = new Map<string, Waiter>();
  private readonly streams = new Map<string, RelayStreamSink>();
  private readonly watches = new Map<string, Watching>();
  private parts: Buffer[] = [];
  private partBytes = 0;
  private serial = 0;
  private over: string | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  /** Fires when 15 s from the last frame are up. */
  private silenceTimer: NodeJS.Timeout | null = null;
  private endListeners: ((reason: string) => void)[] = [];

  constructor(
    private readonly pipe: RelayPipe,
    /** The socket path for error texts (sessionSocketPath), as today's exec path names it. */
    private readonly socketPath: string,
    helloMs: number = relayHelloMs,
  ) {
    this.hello = new Promise<boolean>((resolve) => {
      this.settleHello = resolve;
    });
    this.helloTimer = setTimeout(() => this.settleHello(false), helloMs);
  }

  /** The channel is open and said hello. */
  get up(): boolean {
    return this.helloSeen && this.over === null;
  }

  /** Why it ended, or null while open. */
  get ended(): string | null {
    return this.over;
  }

  /** Called once when the channel ends (at once when it already has). */
  onEnd(listener: (reason: string) => void): void {
    if (this.over !== null) listener(this.over);
    else this.endListeners.push(listener);
  }

  private nextId(prefix: string): string {
    this.serial += 1;
    return `${prefix}${this.serial}`;
  }

  private write(frame: string): void {
    if (this.over !== null) throw new ClosedBeforeResponseError();
    this.pipe.write(frame.endsWith("\n") ? frame : frame + "\n");
  }

  // MARK: frames in

  /** Bytes from the channel's stdout, split anywhere. */
  data(chunk: Uint8Array): void {
    if (this.over !== null) return;
    let data = Buffer.from(chunk);
    for (let index = data.indexOf(0x0a); index >= 0; index = data.indexOf(0x0a)) {
      const line = this.partBytes === 0 ? data.subarray(0, index) : Buffer.concat([...this.parts, data.subarray(0, index)]);
      this.parts = [];
      this.partBytes = 0;
      data = data.subarray(index + 1);
      this.frame(line);
      if (this.over !== null) return;
    }
    if (data.length > 0) {
      this.parts.push(Buffer.from(data));
      this.partBytes += data.length;
      if (this.partBytes > maxRelayFrameBytes) this.finish(new ResponseTooLargeError(this.partBytes, maxRelayFrameBytes).message);
    }
  }

  private frame(bytes: Buffer): void {
    this.lastFrameAt = Date.now();
    if (bytes.length > maxRelayFrameBytes) {
      this.finish(new ResponseTooLargeError(bytes.length, maxRelayFrameBytes).message);
      return;
    }
    const line = bytes.toString("utf8");
    if (line.trim() === "") return;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = record(JSON.parse(line));
    } catch {
      parsed = null;
    }
    // A frame with a top-level "relay" key is the relay's; anything else is a Herdr reply (contract "Frames").
    const kind = text(parsed?.["relay"]);
    if (parsed === null || kind === null) {
      this.reply(line, bytes.length, parsed);
      return;
    }
    const id = text(parsed["id"]);
    switch (kind) {
      case "hello":
        if (!this.helloSeen && parsed["v"] === 1) {
          this.helloSeen = true;
          if (this.helloTimer !== null) clearTimeout(this.helloTimer);
          this.helloTimer = null;
          this.settleHello(true);
        }
        return;
      case "pong": {
        const waiter = id === null ? undefined : this.waiters.get(id);
        if (waiter?.kind === "ping") this.settle(id!, waiter, true);
        return;
      }
      case "event":
        if (id !== null) this.streams.get(id)?.line(text(parsed["data"]) ?? "");
        return;
      case "ended": {
        const sink = id === null ? undefined : this.streams.get(id);
        if (sink !== undefined) {
          this.streams.delete(id!);
          sink.ended("the event stream closed");
        }
        return;
      }
      case "read": {
        const waiter = id === null ? undefined : this.waiters.get(id);
        if (waiter?.kind !== "read") return;
        // Checked against the request before its data is decoded.
        this.settle(id!, waiter, readReply(parsed, waiter.asked));
        return;
      }
      case "grew": {
        const watch = id === null ? undefined : this.watches.get(id);
        if (watch === undefined) return;
        // A `grew` whose list is not ranges (null too) is a failed watch, not an older relay's frame: it ends (the
        // reader falls back to its reads), omit kept on. So does any other `grew` its watch does not allow
        // (grewReply), before its data is decoded.
        const growth = grewReply(parsed, watch);
        if (growth === null) {
          this.dropWatch(id!, watch, "the relay sent a grew it could not describe");
          return;
        }
        watch.at = growth.offset + growth.covered;
        if (growth.omitted === undefined) watch.sink.grew(growth.offset, growth.size, growth.data);
        else watch.sink.grew(growth.offset, growth.size, growth.data, growth.omitted);
        return;
      }
      case "reset": {
        const watch = id === null ? undefined : this.watches.get(id);
        if (watch === undefined) return;
        // A reset's size and inode are counters like any other; the watch carries on from that size.
        const size = count(parsed["size"]);
        const ino = count(parsed["ino"]);
        if (size === null || ino === null) {
          this.dropWatch(id!, watch, "the relay sent a reset it could not describe");
          return;
        }
        watch.at = size;
        watch.sink.reset(size, ino);
        return;
      }
      case "gone": {
        if (id === null) return;
        const waiter = this.waiters.get(id);
        if (waiter?.kind === "read") {
          this.settle(id, waiter, null);
          return;
        }
        const watch = this.watches.get(id);
        if (watch !== undefined) {
          this.watches.delete(id);
          watch.sink.gone();
        }
        return;
      }
      case "error":
        if (id !== null) this.refused(id, text(parsed["code"]) ?? "io", text(parsed["detail"]) ?? "");
        return;
      default:
        // Contract v1.1: a relay frame of a kind this client does not know is ignored (room for later ones).
        return;
    }
  }

  /** A Herdr reply: to its request, by id (today's bound on one reply line applies). */
  private reply(line: string, bytes: number, parsed: Record<string, unknown> | null): void {
    const id = parsed === null ? replyId(line) : text(parsed["id"]);
    const waiter = id === null ? undefined : this.waiters.get(id);
    if (waiter?.kind !== "request") return;
    if (bytes > maxResponseLineBytes) this.settle(id!, waiter, new ResponseTooLargeError(bytes, maxResponseLineBytes));
    // The caller's own id back in place of the wire id, wherever it stands in the line.
    else this.settle(id!, waiter, waiter.asked === null ? line : (spliceId(line, id!, waiter.asked, parsed !== null) ?? line));
  }

  /** The relay's error frame for `id`, in today's words where today has them. */
  private refused(id: string, code: string, detail: string): void {
    const waiting = this.waiters.get(id);
    // Contract v1.1: a request the relay retired (`expired`, after 300 s) or would not take (`limit`) failed as a
    // lost reply does today. A read keeps the relay's code, so the transcript reader asks SFTP instead.
    if (waiting?.kind === "request" && retiredCodes.has(code)) {
      this.settle(id, waiting, new ClosedBeforeResponseError());
      return;
    }
    const error =
      code === "socket_missing"
        ? new RemoteSocketFailedError(this.socketPath, socketMissingDetail)
        : code === "socket_failed"
          ? new RemoteSocketFailedError(this.socketPath, detail === "" ? "the relay could not open it" : detail)
          : new RelayRefusedError(code, detail);
    const waiter = this.waiters.get(id);
    if (waiter !== undefined) {
      this.settle(id, waiter, waiter.kind === "ping" ? false : error);
      return;
    }
    const stream = this.streams.get(id);
    if (stream !== undefined) {
      this.streams.delete(id);
      stream.ended(error.message);
      return;
    }
    const watch = this.watches.get(id);
    if (watch !== undefined) {
      this.watches.delete(id);
      if (error instanceof RelayRefusedError) watch.sink.refused?.(error.code);
      watch.sink.ended(error.message);
    }
  }

  /** A watch whose frame it could not take ends; the relay is told (`unwatch`). */
  private dropWatch(id: string, watch: Watching, reason: string): void {
    if (this.watches.get(id) !== watch) return;
    this.watches.delete(id);
    try {
      this.write(JSON.stringify({ relay: "unwatch", id }));
    } catch {
      // The channel is gone.
    }
    watch.sink.ended(reason);
  }

  /**
   * Contract v1.1: the client gave up on `id` (its deadline passed, or its caller's signal): it fails here, and the
   * relay is told with a `cancel` (it closes that Herdr connection and sends nothing back).
   */
  private giveUp(id: string, waiter: Waiter, error: Error): void {
    if (this.waiters.get(id) !== waiter) return;
    this.settle(id, waiter, error);
    if (this.over !== null) return;
    try {
      this.write(JSON.stringify({ relay: "cancel", id }));
    } catch {
      // The channel is gone; nothing waits on the relay's side either.
    }
  }

  private settle(id: string, waiter: Waiter, outcome: string | RelayRead | null | boolean | Error): void {
    if (this.waiters.get(id) !== waiter) return;
    this.waiters.delete(id);
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    if (waiter.kind === "ping") {
      waiter.resolve(outcome === true);
      return;
    }
    if (outcome instanceof Error) {
      waiter.reject(outcome);
      return;
    }
    if (waiter.kind === "request") waiter.resolve(outcome as string);
    else waiter.resolve(outcome as RelayRead | null);
  }

  // MARK: frames out

  /**
   * One Herdr request line and its reply line, each as it was but for the id. The deadline (and the caller's
   * signal) fail this request only. Every request goes under a wire id of its own for the
   * channel's life (the caller's id and a serial), and its reply comes back under the caller's id, so a late
   * reply to a request given up can never settle a later one. `statedMs`: the deadline its error names (the
   * caller's whole budget, of which `timeoutMs` is what is left).
   */
  request(requestLine: string, timeoutMs: number, signal?: AbortSignal, statedMs: number = timeoutMs): Promise<string> {
    signal?.throwIfAborted();
    if (this.over !== null) return Promise.reject(new ClosedBeforeResponseError());
    let line = requestLine.endsWith("\n") ? requestLine.slice(0, -1) : requestLine;
    let object: Record<string, unknown> | null;
    try {
      object = record(JSON.parse(line));
    } catch {
      object = null;
    }
    if (object === null) return Promise.reject(new TransportError("the request has no id"));
    const asked = text(object["id"]);
    const id = `${asked ?? "relay"}#${this.nextId("r")}`;
    line = (asked === null ? null : spliceId(line, asked, id, true)) ?? JSON.stringify({ ...object, id });
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes > maxRelayRequestBytes) return Promise.reject(new RequestTooLargeError(bytes, maxRelayRequestBytes));
    const key = id;
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = { kind: "request", asked, resolve, reject, timer: null };
      // The line was written before this fires: Herdr may still carry it out (result unknown).
      waiter.timer = setTimeout(() => this.giveUp(key, waiter, new RequestTimedOutError(Math.max(1, Math.floor(statedMs / 1000)), true)), timeoutMs);
      if (signal !== undefined) {
        signal.addEventListener("abort", () => this.giveUp(key, waiter, signal.reason instanceof Error ? signal.reason : new TransportError("the request was cancelled")), { once: true });
      }
      this.waiters.set(key, waiter);
      try {
        this.write(line);
      } catch (error) {
        this.settle(key, waiter, error instanceof Error ? error : new TransportError(describe(error)));
      }
    });
  }

  /** A ping; true when its pong came within `timeoutMs`. */
  ping(timeoutMs: number): Promise<boolean> {
    if (this.over !== null) return Promise.resolve(false);
    const id = this.nextId("p");
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { kind: "ping", resolve, timer: null };
      waiter.timer = setTimeout(() => this.settle(id, waiter, false), timeoutMs);
      this.waiters.set(id, waiter);
      try {
        this.write(JSON.stringify({ relay: "ping", id }));
      } catch {
        this.settle(id, waiter, false);
      }
    });
  }

  /**
   * Up to `max` bytes of `path` from `offset`, with its size, in one frame (1 trip); null when the file is not there.
   * Contract v1.2: `fields.omit` leaves base64 runs out (listed in `omitted`); `fields.tail` reads
   * the last T bytes in place of `offset` (the reply's `offset` says where).
   */
  read(path: string, offset: number, max: number, timeoutMs: number, fields: RelayReadFields = {}): Promise<RelayRead | null> {
    if (this.over !== null) return Promise.reject(new ClosedBeforeResponseError());
    const id = this.nextId("f");
    const frame =
      fields.tail !== undefined
        ? { relay: "read", id, path, tail: fields.tail, max, ...(fields.omit === undefined ? {} : { omit: fields.omit }) }
        : { relay: "read", id, path, offset, max, ...(fields.omit === undefined ? {} : { omit: fields.omit }) };
    // What the reply may be, as the relay reads this frame (`max` capped at
    // 4 MiB, defaulting to `tail`, then to the cap; a missing offset is 0).
    const tail = fields.tail === undefined ? null : count(fields.tail);
    const asked: ReadAsked = {
      offset: tail === null ? (count(offset) ?? 0) : 0,
      tail,
      limit: Math.min(count(max) ?? tail ?? relayFrameBytes, relayFrameBytes),
      omit: fields.omit !== undefined,
    };
    return new Promise<RelayRead | null>((resolve, reject) => {
      const waiter: Waiter = { kind: "read", asked, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => this.giveUp(id, waiter, new RequestTimedOutError(Math.max(1, Math.floor(timeoutMs / 1000)))), timeoutMs);
      this.waiters.set(id, waiter);
      try {
        this.write(JSON.stringify(frame));
      } catch (error) {
        this.settle(id, waiter, error instanceof Error ? error : new TransportError(describe(error)));
      }
    });
  }

  /** A Herdr subscription held open on the relay; each line it sends goes to `sink`. */
  stream(requestLine: string, sink: RelayStreamSink): RelayHandle {
    const id = this.nextId("s");
    let request: unknown;
    try {
      request = JSON.parse(requestLine);
    } catch {
      queueMicrotask(() => sink.ended("the subscription request is not JSON"));
      return { close: () => undefined };
    }
    if (this.over !== null) {
      const reason = this.over;
      queueMicrotask(() => sink.ended(reason));
      return { close: () => undefined };
    }
    this.streams.set(id, sink);
    try {
      this.write(JSON.stringify({ relay: "stream", id, request }));
    } catch (error) {
      this.streams.delete(id);
      queueMicrotask(() => sink.ended(describe(error)));
    }
    return {
      close: () => {
        if (!this.streams.delete(id) || this.over !== null) return;
        try {
          this.write(JSON.stringify({ relay: "close", id }));
        } catch {
          // The channel is gone; nothing to close.
        }
      },
    };
  }

  /**
   * Pushes `path`'s growth from `offset` to `sink` (grew, reset, gone) until closed.
   * Contract v1.2: `omit` leaves base64 runs out of each `grew` (listed in its `omitted`).
   */
  watch(path: string, offset: number, sink: RelayWatchSink, omit?: number): RelayHandle {
    const id = this.nextId("w");
    if (this.over !== null) {
      const reason = this.over;
      queueMicrotask(() => sink.ended(reason));
      return { close: () => undefined };
    }
    // The first `grew` starts where the watch was asked from.
    this.watches.set(id, { sink, omit: omit !== undefined, at: count(offset) ?? 0 });
    try {
      this.write(JSON.stringify({ relay: "watch", id, path, offset, ...(omit === undefined ? {} : { omit }) }));
    } catch (error) {
      this.watches.delete(id);
      queueMicrotask(() => sink.ended(describe(error)));
    }
    return {
      close: () => {
        if (!this.watches.delete(id) || this.over !== null) return;
        try {
          this.write(JSON.stringify({ relay: "unwatch", id }));
        } catch {
          // The channel is gone.
        }
      },
    };
  }

  // MARK: liveness

  /**
   * T3's liveness: every 5 s while `active()` (a window on screen) a ping, and
   * no frame of any kind for 15 s calls `dead`. Out of sight nothing is sent,
   * and the silence is not counted.
   */
  keepAlive(active: () => boolean, dead: (reason: string) => void): void {
    if (this.livenessTimer !== null) clearInterval(this.livenessTimer);
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    this.livenessTimer = setInterval(() => {
      if (this.over !== null) return;
      if (!active()) {
        this.lastFrameAt = Math.max(this.lastFrameAt, Date.now());
        return;
      }
      void this.ping(relaySilenceMs);
    }, relayPingEveryMs);
    // The silence is measured from the last frame, not on the ping's tick: the check runs when
    // 15 s from the last frame are up (a frame since moves it on), so the drop comes at 15 s, not up to 20.
    const check = (): void => {
      this.silenceTimer = null;
      if (this.over !== null) return;
      const now = Date.now();
      if (!active()) this.lastFrameAt = Math.max(this.lastFrameAt, now);
      else if (now - this.lastFrameAt >= relaySilenceMs) {
        dead("the relay went silent");
        return;
      }
      this.silenceTimer = setTimeout(check, Math.max(1, this.lastFrameAt + relaySilenceMs - now));
    };
    this.silenceTimer = setTimeout(check, Math.max(1, this.lastFrameAt + relaySilenceMs - Date.now()));
  }

  /** The focus or wake check: a ping with a 2 s deadline; false (no pong) means the channel is dead. */
  async wakeCheck(): Promise<boolean> {
    if (this.over !== null) return false;
    return this.ping(relayWakePingMs);
  }

  // MARK: the end

  /** The channel ended (or is dropped): everything waiting fails as a lost connection does today. */
  finish(reason: string): void {
    if (this.over !== null) return;
    this.over = reason;
    if (this.helloTimer !== null) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    if (this.livenessTimer !== null) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.settleHello(false);
    for (const [id, waiter] of this.waiters) this.settle(id, waiter, waiter.kind === "ping" ? false : new ClosedBeforeResponseError());
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const sink of streams) sink.ended("the connection closed");
    const watches = [...this.watches.values()];
    this.watches.clear();
    for (const watch of watches) watch.sink.ended("the connection closed");
    const listeners = this.endListeners;
    this.endListeners = [];
    for (const listener of listeners) listener(reason);
  }

  /** Ends the channel from this side. */
  close(reason = "closed"): void {
    this.finish(reason);
    try {
      this.pipe.close();
    } catch {
      // Already closed.
    }
  }
}
