// The Mac Chat's cold open of a long, image-heavy Claude session over a slow
// link (226 ms round trip, about 1.5 MB/s: a laptop far from the machine), on
// vitest's fake clock. Built by hand, never read from a real transcript. The
// session's shapes are HerdrKit's ChatColdOpenSupport.swift, ported.
//
// The link sits under the app's own readers: the real SshTranscriptReader over
// a fake ssh2 client (the locate's exec; SFTP's stat, open, reads and close)
// and the real RelayClient over a fake relay pipe that answers as
// adari-relay.pl does (contract v1.1 reads and watches, v1.2's `omit` and
// `tail`: docs/relay.md). Each request's reply crosses the link: half a round
// trip out, its bytes on one downstream line at 1.5 MB/s in the order they
// were sent, half a round trip back. A request sent while none is out starts a
// trip; one sent while others are out (pipelined) rides theirs.

import { EventEmitter } from "node:events";

import { vi } from "vitest";

import { ChatService, type ChatHosts } from "../../src/main/chat/service";
import { SshTranscriptReader } from "../../src/main/chat/ssh-reader";
import type { HerdrHostBackend } from "../../src/main/herdr/backend";
import { MemoryPinStore, PinningHostKeyPolicy } from "../../src/main/herdr/host-key-pinning";
import { RelayClient } from "../../src/main/herdr/relay";
import { AgentSettingsReader, tapReader } from "../../src/shared/agent-settings";
import { ChatFeed, standardColdLoad, type ChatFeedUpdate } from "../../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../../src/shared/chat/locator";
import type { ChatImageBlob, ChatTimeline } from "../../src/shared/chat/model";
import { ChatWarmGate, WarmingReader } from "../../src/shared/chat/shelf";
import type { ChatUpdateEvent } from "../../src/shared/ipc-contract";
import { newestItems } from "../../src/main/launch-cache";
import { claudePath, claudeSession, whole } from "./chat-lines";

// MARK: the session (ChatColdOpenSupport.swift's ColdOpenSession)

export const coldSessionID = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
export const coldPath = claudePath;
export const coldFolder = "/Users/fixture/proj";

/** A screenshot pasted into a prompt (base64 characters). */
export const pastedShotBytes = 700_000;
/** A screenshot read as a file: the image twice (the result and `toolUseResult.file.base64`). */
export const imageReadBytes = 1_100_000;
/** An MCP screenshot: the image once. */
export const mcpShotBytes = 700_000;
/** A large text file read (every third image turn), written twice. */
export const bigReadBytes = 200_000;

const stamp = (second: number): string => new Date((1_793_000_000 + second) * 1_000).toISOString();

/** Plain words, `bytes` long (no quote, no backslash). */
export function words(bytes: number, seed = 0): string {
  const unit = `the build ran and the screen shows step ${seed} of the plan as expected `;
  return unit.repeat(Math.floor(bytes / unit.length) + 1).slice(0, bytes);
}

/** A base64 payload of `length` characters (the alphabet only, as a PNG's). */
export function payload(length: number): string {
  const unit = "iVBORw0KGgoAAAANSUhEUgAAB4AAAAQ4CAIAAABnsVYUAAAgAElEQVR4nOzdd3hTVf/A8U/S";
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

const head = (uuid: string, t: number): string =>
  `"isSidechain":false,"sessionId":"${coldSessionID}","timestamp":"${stamp(t)}","uuid":"${uuid}","cwd":"${coldFolder}"`;

export const coldLines = {
  user: (uuid: string, text: string, t: number): string => `{${head(uuid, t)},"type":"user","message":{"role":"user","content":"${text}"}}`,
  userWithShot: (uuid: string, text: string, data: string, t: number): string =>
    `{${head(uuid, t)},"type":"user","message":{"role":"user","content":[{"type":"text","text":"${text}"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${data}"}}]}}`,
  agent: (uuid: string, text: string, t: number): string =>
    `{${head(uuid, t)},"type":"assistant","message":{"model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"${text}"}]}}`,
  toolUse: (uuid: string, id: string, name: string, input: string, t: number): string =>
    `{${head(uuid, t)},"type":"assistant","message":{"model":"claude-opus-5-5","role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"${id}","name":"${name}","input":${input}}]}}`,
  bashResult: (uuid: string, id: string, output: string, t: number): string =>
    `{${head(uuid, t)},"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${id}","content":"${output}"}]},"toolUseResult":{"stdout":"${output}","stderr":"","interrupted":false}}`,
  textReadResult: (uuid: string, id: string, content: string, t: number): string =>
    `{${head(uuid, t)},"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${id}","content":"${content}"}]},"toolUseResult":{"type":"text","file":{"filePath":"/Users/fixture/proj/Sources/Big.swift","content":"${content}"}}}`,
  imageReadResult: (uuid: string, id: string, bytes: number, t: number): string => {
    const half = payload(Math.floor(bytes / 2));
    return `{${head(uuid, t)},"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${id}","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${half}"}}]}]},"toolUseResult":{"type":"image","file":{"base64":"${half}","type":"image/png","originalSize":${bytes}}}}`;
  },
  mcpShotResult: (uuid: string, id: string, bytes: number, t: number): string =>
    `{${head(uuid, t)},"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${id}","content":[{"type":"text","text":"Screenshot taken"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${payload(bytes)}"}}]}]}}`,
  /** Claude Code's compaction: the boundary and the summary (a notice). */
  compaction: (index: number, t: number): string[] => [
    `{${head(`cb${index}`, t)},"type":"system","subtype":"compact_boundary","content":"Conversation compacted","compactMetadata":{"trigger":"auto","preTokens":180000}}`,
    `{${head(`cs${index}`, t)},"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. ${words(18_000, index)}"}}`,
  ],
};

/** A small turn: the user's message, a reply, a Bash call with its output, a closing reply (four items, about 6 KB). */
export function textTurn(index: number): string[] {
  const t = index * 60;
  return [
    coldLines.user(`tu${index}`, `small question ${index}`, t),
    coldLines.agent(`ta${index}`, "Looking at it. " + words(1_200, index), t + 1),
    coldLines.toolUse(`tb${index}`, `toolu_t${index}`, "Bash", '{"command":"git status","description":"Status"}', t + 2),
    coldLines.bashResult(`tr${index}`, `toolu_t${index}`, words(1_200, index), t + 3),
    coldLines.agent(`tc${index}`, `Done with ${index}. ` + words(400, index), t + 4),
  ];
}

function imageRound(turn: number, round: number, t: number): string[] {
  const index = round === 0 ? `${turn}` : `${turn}x${round}`;
  const big = (turn + round) % 3 === 0;
  const lines = [
    coldLines.agent(`ia${index}`, `Running the tests for step ${index}. ` + words(500, turn), t + 5),
    coldLines.toolUse(`ib${index}`, `toolu_${index}_b1`, "Bash", '{"command":"xcodebuild test -scheme App","description":"Run the tests"}', t + 6),
    coldLines.bashResult(`ibr${index}`, `toolu_${index}_b1`, words(3_000, turn), t + 40),
    coldLines.toolUse(`ir${index}`, `toolu_${index}_r1`, "Read", `{"file_path":"/Users/fixture/proj/shots/screen-${index}.png"}`, t + 41),
    coldLines.imageReadResult(`irr${index}`, `toolu_${index}_r1`, imageReadBytes, t + 42),
    coldLines.agent(`ib2${index}`, "The screen shows the list. " + words(800, turn), t + 50),
    coldLines.toolUse(`ic${index}`, `toolu_${index}_b2`, "Bash", '{"command":"swift build","description":"Build"}', t + 51),
    coldLines.bashResult(`icr${index}`, `toolu_${index}_b2`, words(6_000, turn), t + 90),
  ];
  if (big) {
    lines.push(coldLines.toolUse(`id${index}`, `toolu_${index}_r2`, "Read", `{"file_path":"/Users/fixture/proj/Sources/Big${index}.swift"}`, t + 91));
    lines.push(coldLines.textReadResult(`idr${index}`, `toolu_${index}_r2`, words(bigReadBytes, turn), t + 92));
  }
  lines.push(coldLines.toolUse(`is${index}`, `toolu_${index}_s1`, "mcp__xcode__screenshot", '{"device":"booted"}', t + 100));
  lines.push(coldLines.mcpShotResult(`isr${index}`, `toolu_${index}_s1`, mcpShotBytes, t + 101));
  return lines;
}

/** An image-heavy turn (eight items, nine every third turn); `rounds` above 1: a long agentic turn. */
export function imageTurn(turn: number, rounds = 1): string[] {
  const t0 = 1_000_000 + turn * 600 * rounds;
  const lines: string[] = [];
  if (turn % 2 === 0) lines.push(coldLines.userWithShot(`iu${turn}`, `please check this screen ${turn}`, payload(pastedShotBytes), t0));
  else lines.push(coldLines.user(`iu${turn}`, `please check the next screen ${turn}`, t0));
  for (let round = 0; round < rounds; round += 1) lines.push(...imageRound(turn, round, t0 + round * 600));
  lines.push(coldLines.agent(`ie${turn}`, `Step ${turn} is done: ` + words(1_500, turn), t0 + rounds * 600 - 10));
  return lines;
}

/** `textTurns` small turns, then `imageTurns` image-heavy ones; a compaction every `compactEvery` image turns (and every 150 text turns), one three turns before the end. */
export function coldSession(options: { textTurns?: number; imageTurns?: number; compactEvery?: number; rounds?: number } = {}): string {
  const { textTurns = 400, imageTurns = 16, compactEvery = 5, rounds = 1 } = options;
  const lines: string[] = [];
  let compactions = 0;
  for (let index = 0; index < textTurns; index += 1) {
    if (index > 0 && index % 150 === 0) {
      compactions += 1;
      lines.push(...coldLines.compaction(compactions, index * 60 - 1));
    }
    lines.push(...textTurn(index));
  }
  for (let index = 0; index < imageTurns; index += 1) {
    if (index === imageTurns - 3 || (index > 0 && index % compactEvery === 0)) {
      compactions += 1;
      lines.push(...coldLines.compaction(compactions, 1_000_000 + index * 600 * rounds - 1));
    }
    lines.push(...imageTurn(index, rounds));
  }
  return lines.join("\n") + "\n";
}

/** The display items of `timeline`. */
export const itemCount = (timeline: ChatTimeline): number => timeline.turns.reduce((count, turn) => count + turn.items.length, 0);

/** A full screen (the measure used here): four turns or 20 items, or the whole file. */
export const screenItems = 20;
export const screenTurns = 4;
export const isFull = (timeline: ChatTimeline): boolean => itemCount(timeline) >= screenItems || timeline.turns.length >= screenTurns || timeline.earlier === "none";

const BASE64 = new Uint8Array(256);
for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") BASE64[char.charCodeAt(0)] = 1;

/** Bytes in runs of 1,024 or more base64 characters (image and blob payloads), and how many runs. */
export function blobRuns(bytes: Uint8Array): { bytes: number; runs: number } {
  let total = 0;
  let runs = 0;
  let run = 0;
  for (const byte of bytes) {
    if (BASE64[byte] === 1) {
      run += 1;
      continue;
    }
    if (run >= 1_024) {
      total += run;
      runs += 1;
    }
    run = 0;
  }
  if (run >= 1_024) {
    total += run;
    runs += 1;
  }
  return { bytes: total, runs };
}

// MARK: the relay's omit, as relay.t's reference scan (scripts/relay-tests/RelayTest.pm ref_omit)

const BACK = 64;
const BACKSLASH = 0x5c;

function hex(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

/**
 * Whether a run at file offset `start` would begin inside a JSON escape (ref_omit's rule): the up to 64 file
 * bytes before it end in an odd number of backslashes, maybe then `u` and up to three hex digits; or they are
 * such backslashes all the way back and do not reach the file's start (their number is not known).
 */
function inEscape(file: Uint8Array, start: number): boolean {
  const from = Math.max(0, start - BACK);
  let end = start;
  let digits = start;
  while (start - digits < 3 && digits - 1 >= from && hex(file[digits - 1]!)) digits -= 1;
  if (digits - 1 >= from && file[digits - 1] === 0x75) end = digits - 1;
  let slashes = 0;
  while (end - 1 - slashes >= from && file[end - 1 - slashes] === BACKSLASH) slashes += 1;
  if (slashes === 0) return false;
  return slashes % 2 === 1 || (end - slashes === from && start > BACK);
}

/** `slice` (file bytes from `at`) with every run of `k` or more base64 bytes left out, but one that would begin inside a JSON escape. */
export function relayOmit(file: Uint8Array, at: number, slice: Uint8Array, k: number): { kept: Uint8Array; omitted: [number, number][] } {
  const omitted: [number, number][] = [];
  const parts: Uint8Array[] = [];
  let from = 0;
  let index = 0;
  while (index < slice.length) {
    if (BASE64[slice[index]!] !== 1) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < slice.length && BASE64[slice[index]!] === 1) index += 1;
    if (index - start < k || inEscape(file, at + start)) continue;
    parts.push(slice.subarray(from, start));
    omitted.push([at + start, index - start]);
    from = index;
  }
  parts.push(slice.subarray(from));
  return { kept: new Uint8Array(Buffer.concat(parts)), omitted };
}

// MARK: the link

export type LinkMode = "relay" | "sftp";
/** How the fake relay takes v1.2's fields: as adari-relay.pl does, as a v1.1 relay (unknown fields ignored), or refusing `omit`. */
export type RelayKind = "v1.2" | "v1.1" | "refusesOmit";

/** One read of a file on the link: where, the file bytes it covered, the bytes it sent and when its answer came. */
export interface LinkRead {
  readonly kind: "relay" | "sftp";
  readonly path: string;
  readonly offset: number;
  readonly covered: number;
  readonly kept: number;
  readonly omit: boolean;
  /** The runs the relay left out of it (file ranges; empty: none). */
  readonly omitted: readonly (readonly [number, number])[];
  readonly wire: number;
  readonly sentAt: number;
  doneAt: number;
}

const MAX_READ = 4 * 1_024 * 1_024;
const CHUNK = 256 * 1_024;
const noSuchFile = (): Error => Object.assign(new Error("No such file"), { code: 2 });

interface LinkWatch {
  readonly id: string;
  readonly path: string;
  pos: number;
  size: number;
  ino: number;
  readonly omit: number | null;
  busy: boolean;
}

export class ColdLink {
  static readonly roundTripMs = 226;
  static readonly bytesPerMs = 1_500;

  file: Uint8Array;
  ino = 777_001;
  relayKind: RelayKind = "v1.2";
  /** Plain reads (no `omit`, no `tail`) of more than nothing answer `io` (a fetch that fails). */
  plainReadsFail = false;
  trips = 0;
  requests = 0;
  wireBytes = 0;
  readonly reads: LinkRead[] = [];
  /** Every frame the client sent the relay. */
  readonly frames: Record<string, unknown>[] = [];
  client: RelayClient | null = null;
  private outstanding = 0;
  private downFreeAt = 0;
  private readonly watches = new Map<string, LinkWatch>();

  constructor(
    readonly path: string,
    text: string | Uint8Array,
  ) {
    this.file = typeof text === "string" ? new TextEncoder().encode(text) : text;
  }

  /** Appends to the file; a watch pushes the growth. */
  append(text: string | Uint8Array): void {
    const more = typeof text === "string" ? new TextEncoder().encode(text) : text;
    const next = new Uint8Array(this.file.length + more.length);
    next.set(this.file, 0);
    next.set(more, this.file.length);
    this.file = next;
    for (const watch of this.watches.values()) this.pushGrowth(watch);
  }

  /** The time a reply of `wire` bytes, asked now, arrives, its downstream bytes queued behind those before. */
  private arrival(wire: number): number {
    const now = Date.now();
    const start = Math.max(now + ColdLink.roundTripMs / 2, this.downFreeAt);
    this.downFreeAt = start + wire / ColdLink.bytesPerMs;
    return this.downFreeAt + ColdLink.roundTripMs / 2;
  }

  /** A request whose reply is `wire` bytes: `then` when it arrives. */
  private request(wire: number, then: () => void): number {
    if (this.outstanding === 0) this.trips += 1;
    this.outstanding += 1;
    this.requests += 1;
    this.wireBytes += wire;
    const at = this.arrival(wire);
    setTimeout(
      () => {
        this.outstanding -= 1;
        then();
      },
      Math.max(0, Math.ceil(at - Date.now())),
    );
    return at;
  }

  /** Bytes the relay pushes (a watch's grew): the downstream line, no trip. */
  private push(wire: number, then: () => void): void {
    this.wireBytes += wire;
    const at = this.arrival(wire);
    setTimeout(then, Math.max(0, Math.ceil(at - Date.now())));
  }

  // MARK: the relay

  /** The relay on the command connection: up (its hello in). */
  relay(): RelayClient {
    const client = new RelayClient({ write: (line) => this.relayLine(line), close: () => undefined }, "/fake/herdr.sock");
    client.data(Buffer.from('{"relay":"hello","v":1}\n'));
    this.client = client;
    return client;
  }

  private reply(frame: Record<string, unknown>): void {
    const line = JSON.stringify(frame) + "\n";
    this.request(Buffer.byteLength(line), () => this.client?.data(Buffer.from(line)));
  }

  private relayLine(line: string): void {
    const frame = JSON.parse(line) as Record<string, unknown>;
    this.frames.push(frame);
    const id = frame["id"];
    switch (frame["relay"]) {
      case "read":
        this.relayRead(frame);
        return;
      case "watch":
        this.relayWatch(frame);
        return;
      case "unwatch":
        this.watches.delete(String(id));
        return;
      case "ping":
        this.reply({ relay: "pong", id });
        return;
      case "cancel":
        return;
      default:
        this.reply({ relay: "error", id, code: "bad_frame", detail: "unknown relay frame" });
    }
  }

  /** v1.2 fields as this relay takes them: null when absent, or a bad frame's detail. */
  private v12(frame: Record<string, unknown>): { omit: number | null; tail: number | null } | string {
    if (this.relayKind === "v1.1") return { omit: null, tail: null };
    const digits = (value: unknown): number | null =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : null;
    const rawOmit = frame["omit"];
    const rawTail = frame["tail"];
    if (rawOmit !== undefined && rawOmit !== null && this.relayKind === "refusesOmit") return "omit is a whole number of at least 256";
    const omit = rawOmit === undefined || rawOmit === null ? null : digits(rawOmit);
    if (omit !== null && omit < 256) return "omit is a whole number of at least 256";
    if (rawOmit !== undefined && rawOmit !== null && omit === null) return "omit is a whole number of at least 256";
    const tail = rawTail === undefined || rawTail === null ? null : digits(rawTail);
    if (rawTail !== undefined && rawTail !== null && tail === null) return "tail is a whole number";
    if (tail !== null && frame["offset"] !== undefined && frame["offset"] !== null) return "tail and offset do not go together";
    return { omit, tail };
  }

  private relayRead(frame: Record<string, unknown>): void {
    const id = frame["id"];
    const path = String(frame["path"]);
    const fields = this.v12(frame);
    if (typeof fields === "string") {
      this.reply({ relay: "error", id, code: "bad_frame", detail: fields });
      return;
    }
    if (path !== this.path) {
      this.reply({ relay: "gone", id });
      return;
    }
    const size = this.file.length;
    const offset = fields.tail !== null ? Math.max(0, size - fields.tail) : Number(frame["offset"] ?? 0);
    const max = Math.min(MAX_READ, Number(frame["max"] ?? fields.tail ?? MAX_READ));
    if (this.plainReadsFail && fields.omit === null && fields.tail === null && max > 0) {
      this.reply({ relay: "error", id, code: "io", detail: "read: Input/output error" });
      return;
    }
    const slice = offset < size && max > 0 ? this.file.subarray(offset, Math.min(size, offset + max)) : new Uint8Array(0);
    const answer: Record<string, unknown> = { relay: "read", id, size, ino: this.ino, offset };
    let kept = slice;
    let omitted: [number, number][] = [];
    if (fields.omit !== null) {
      const left = relayOmit(this.file, offset, slice, fields.omit);
      kept = left.kept;
      omitted = left.omitted;
      answer["omitted"] = left.omitted;
    }
    answer["data"] = Buffer.from(kept).toString("base64");
    const line = JSON.stringify(answer) + "\n";
    const read: LinkRead = { kind: "relay", path, offset, covered: slice.length, kept: kept.length, omit: fields.omit !== null, omitted, wire: Buffer.byteLength(line), sentAt: Date.now(), doneAt: 0 };
    this.reads.push(read);
    read.doneAt = this.request(read.wire, () => this.client?.data(Buffer.from(line)));
  }

  private relayWatch(frame: Record<string, unknown>): void {
    const id = String(frame["id"]);
    const fields = this.v12(frame);
    if (typeof fields === "string") {
      this.reply({ relay: "error", id, code: "bad_frame", detail: fields });
      return;
    }
    if (String(frame["path"]) !== this.path) {
      this.reply({ relay: "gone", id });
      return;
    }
    const watch: LinkWatch = { id, path: this.path, pos: Number(frame["offset"] ?? 0), size: this.file.length, ino: this.ino, omit: fields.omit, busy: false };
    this.watches.set(id, watch);
    this.pushGrowth(watch);
  }

  /** The watch's growth from its position, in frames of at most 256 KB of the file, one after another. */
  private pushGrowth(watch: LinkWatch): void {
    if (watch.busy || this.watches.get(watch.id) !== watch) return;
    if (this.file.length <= watch.pos) return;
    const slice = this.file.subarray(watch.pos, Math.min(this.file.length, watch.pos + CHUNK));
    const answer: Record<string, unknown> = { relay: "grew", id: watch.id, offset: watch.pos, size: this.file.length };
    let kept = slice;
    if (watch.omit !== null) {
      const left = relayOmit(this.file, watch.pos, slice, watch.omit);
      kept = left.kept;
      answer["omitted"] = left.omitted;
    }
    answer["data"] = Buffer.from(kept).toString("base64");
    watch.pos += slice.length;
    watch.size = this.file.length;
    watch.busy = true;
    const line = JSON.stringify(answer) + "\n";
    this.push(Buffer.byteLength(line), () => {
      watch.busy = false;
      if (this.watches.get(watch.id) === watch) this.client?.data(Buffer.from(line));
      this.pushGrowth(watch);
    });
  }

  // MARK: SSH and SFTP (the locate's exec; the reads with the relay off)

  /** An ssh2 client on the transcript connection (already connected: no handshake on the clock). */
  sshClient(): unknown {
    const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
    client["exec"] = (_command: string, done: (error: Error | undefined, channel: unknown) => void): void => {
      const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: () => undefined });
      // An exec on an open connection: about two round trips (the channel, then the command's output).
      this.request(200, () => {
        done(undefined, channel);
        this.request(this.path.length + 200, () => {
          channel.emit("data", Buffer.from(this.path + "\n"));
          channel.emit("close");
        });
      });
    };
    client["sftp"] = (done: (error: Error | undefined, sftp: unknown) => void): void => done(undefined, this.sftp());
    client["end"] = (): void => {
      client.emit("end");
    };
    return client;
  }

  private sftp(): unknown {
    return {
      stat: (path: string, done: (error: unknown, stats: unknown) => void): void => {
        this.request(120, () => {
          if (path !== this.path) done(noSuchFile(), undefined);
          else done(undefined, { size: this.file.length, mtime: 1, isFile: () => true });
        });
      },
      open: (path: string, _flags: string, done: (error: unknown, handle: Buffer) => void): void => {
        this.request(80, () => (path === this.path ? done(undefined, Buffer.from(path)) : done(noSuchFile(), Buffer.alloc(0))));
      },
      read: (_handle: Buffer, buffer: Uint8Array, at: number, length: number, position: number, done: (error: unknown, bytesRead: number) => void): void => {
        const part = this.file.subarray(Math.min(position, this.file.length), Math.min(this.file.length, position + length));
        const read: LinkRead = { kind: "sftp", path: this.path, offset: position, covered: part.length, kept: part.length, omit: false, omitted: [], wire: part.length + 40, sentAt: Date.now(), doneAt: 0 };
        this.reads.push(read);
        read.doneAt = this.request(read.wire, () => {
          buffer.set(part, at);
          done(undefined, part.length);
        });
      },
      close: (_handle: Buffer, done: () => void): void => {
        this.request(40, done);
      },
      readdir: (_folder: string, done: (error: unknown, entries: unknown[]) => void): void => {
        this.request(80, () => done(noSuchFile(), []));
      },
      realpath: (_path: string, done: (error: unknown, real?: string) => void): void => {
        this.request(80, () => done(noSuchFile()));
      },
    };
  }

  /** The app's transcript reader over this link: relay reads while `mode` is relay, SFTP otherwise. */
  reader(mode: LinkMode): SshTranscriptReader {
    const relay = mode === "relay" ? this.relay() : null;
    const config = { host: "mini.invalid", port: 22, username: "fixture", privateKeyPath: "", herdrSession: "default" };
    return new SshTranscriptReader(config, new PinningHostKeyPolicy(new MemoryPinStore()), {
      timeoutMs: 120_000,
      connect: async () => this.sshClient() as never,
      ...(relay === null ? {} : { relay: async () => relay }),
    });
  }

  /** The reads of `path` (the transcript by default) so far. */
  readsOf(path: string = this.path): LinkRead[] {
    return this.reads.filter((read) => read.path === path);
  }
}

// MARK: what a run measured

/** The file ranges a read sent (its cover, less the runs left out). */
export function sentRanges(read: LinkRead): (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  let at = read.offset;
  for (const [offset, length] of read.omitted) {
    if (offset > at) out.push([at, offset]);
    at = offset + length;
  }
  if (read.offset + read.covered > at) out.push([at, read.offset + read.covered]);
  return out;
}

/** File bytes sent more than once by `reads` (ranges read again; a run left out and fetched later is sent once). */
export function rereadBytes(reads: readonly LinkRead[]): number {
  const ranges = reads
    .filter((read) => read.covered > 0)
    .flatMap((read) => sentRanges(read))
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let end = 0;
  for (const [low, high] of ranges) {
    if (high <= end) continue;
    covered += high - Math.max(low, end);
    end = high;
  }
  return ranges.reduce((total, [low, high]) => total + (high - low), 0) - covered;
}

/** One update a page saw, with the link's totals then. */
export interface ColdStep {
  readonly at: number;
  readonly status: string;
  readonly items: number;
  readonly turns: number;
  readonly earlier: string;
  readonly full: boolean;
  readonly catchingUp: boolean;
  readonly trips: number;
  readonly reads: number;
  readonly wire: number;
}

export class ColdRun {
  constructor(
    readonly label: string,
    readonly mode: LinkMode,
    readonly link: ColdLink,
    readonly steps: ColdStep[],
    /** When the first load (with its cold reads) was done (ms from the start), or null. */
    readonly loadedAt: number | null,
    /** The fake clock at the start (Date.now()). */
    readonly start: number,
  ) {}

  get firstLive(): ColdStep | undefined {
    return this.steps.find((step) => step.status === "live" && !step.catchingUp);
  }

  get fullScreen(): ColdStep | undefined {
    return this.steps.find((step) => step.status === "live" && !step.catchingUp && step.full);
  }

  /** The first update after the first load was done. */
  get loaded(): ColdStep | undefined {
    const at = this.loadedAt;
    if (at === null) return undefined;
    return [...this.steps].reverse().find((step) => step.at <= at && step.status === "live");
  }

  /** The first update the page shows live (not the cache), and every count on show before it. */
  get handOver(): ColdStep | undefined {
    return this.steps.find((step) => step.status === "live" && !step.catchingUp);
  }

  /** The reads of the transcript that had answered by `at`. */
  readsBy(at: number): LinkRead[] {
    return this.link.readsOf().filter((read) => read.doneAt - this.start <= at);
  }

  static mb(bytes: number): string {
    return `${(bytes / 1_000_000).toFixed(2)} MB`;
  }

  /** One step's line: time, trips, bytes, bytes read twice, wire, blob share, items. */
  line(title: string, step: ColdStep | undefined): string {
    if (step === undefined) return `${title}: never`;
    const reads = this.readsBy(step.at);
    const covered = reads.reduce((total, read) => total + read.covered, 0);
    let blob = 0;
    for (const read of reads) blob += blobRuns(this.link.file.subarray(read.offset, read.offset + read.covered)).bytes;
    const share = covered === 0 ? "0%" : `${Math.round((blob * 100) / covered)}%`;
    return (
      `${title}: ${(step.at / 1_000).toFixed(2)} s, ${step.trips} trips, ${ColdRun.mb(covered)} read (${ColdRun.mb(rereadBytes(reads))} twice), ` +
      `${ColdRun.mb(step.wire)} on the wire, blob share ${share}; ${step.items} items, ${step.turns} turns, earlier ${step.earlier}`
    );
  }

  get summary(): string {
    let text = `cold open [${this.label}, relay ${this.mode === "relay" ? "on" : "off"}] file ${ColdRun.mb(this.link.file.length)}\n`;
    text += "  " + this.line("first live", this.firstLive) + "\n";
    text += "  " + this.line("first full screen", this.fullScreen) + "\n";
    text += "  " + this.line("read back done", this.loaded) + "\n";
    text += "  shown: " + this.steps.map((step) => `${(step.at / 1_000).toFixed(2)}s ${step.status}${step.catchingUp ? " (cache)" : ""} ${step.items}`).join(", ") + "\n";
    text += "  reads: " + this.link.readsOf().map((read) => `${read.kind} ${read.offset}+${read.covered}${read.omit ? ` (sent ${read.kept})` : ""}`).join(", ");
    return text;
  }
}

/** What one step after the open took on the link: time, trips, bytes sent, and the items it brought. */
export interface ColdAfter {
  readonly ms: number;
  readonly trips: number;
  readonly wire: number;
  readonly reads: number;
  readonly before: number;
  readonly after: number;
}

async function measured(link: ColdLink, run: () => Promise<unknown>, items: () => number, limitMs: number): Promise<ColdAfter> {
  const at = Date.now();
  const trips = link.trips;
  const wire = link.wireBytes;
  const reads = link.readsOf().length;
  const before = items();
  let done = false;
  void run().finally(() => {
    done = true;
  });
  // Work that needs no reply ends before the clock moves.
  for (let turn = 0; turn < 20 && !done; turn += 1) await Promise.resolve();
  await runClock(() => done, limitMs);
  return { ms: Date.now() - at, trips: link.trips - trips, wire: link.wireBytes - wire, reads: link.readsOf().length - reads, before, after: items() };
}

/** Load earlier once, as the user's click does after the first screen: what it took. */
export function coldLoadEarlier(link: ColdLink, feed: ChatFeed<TranscriptSessionRef>, limitMs = 60_000): Promise<ColdAfter> {
  return measured(link, () => feed.loadEarlier(), () => itemCount(feed.timeline), limitMs);
}

/** The inline pictures the timeline on show carries to fetch (relay v1.2: left out of its reads). */
export function shownBlobs(timeline: ChatTimeline): ChatImageBlob[] {
  return timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "user" ? item.value.attachments.flatMap((attachment) => (attachment.blob === undefined ? [] : [attachment.blob])) : [])));
}

/** Every inline picture on show fetched at once, as the thumbnails ask on show: what it took (`after`: pictures that came). */
export async function coldFetchShown(link: ColdLink, feed: ChatFeed<TranscriptSessionRef>, limitMs = 60_000): Promise<ColdAfter> {
  const blobs = shownBlobs(feed.timeline);
  let came = 0;
  const step = await measured(
    link,
    async () => {
      const got = await Promise.all(blobs.map((blob) => feed.fetchImage(blob)));
      came = got.filter((value) => value !== null).length;
    },
    () => blobs.length,
    limitMs,
  );
  return { ...step, after: came };
}

/** One after-step's line. */
export function afterLine(title: string, step: ColdAfter, unit = "items"): string {
  return `${title}: ${(step.ms / 1_000).toFixed(2)} s, ${step.trips} trips, ${step.reads} reads, ${ColdRun.mb(step.wire)} on the wire; ${step.before} -> ${step.after} ${unit}`;
}

/** Runs the fake clock until `done()` or `limitMs` of it have passed. */
export async function runClock(done: () => boolean, limitMs: number): Promise<void> {
  const end = Date.now() + limitMs;
  while (!done() && Date.now() < end) {
    if (vi.getTimerCount() === 0) await vi.advanceTimersByTimeAsync(1);
    else await vi.advanceTimersToNextTimerAsync();
  }
}

const stepOf = (link: ColdLink, start: number, update: { state: { status: string }; timeline: ChatTimeline; catchingUp?: boolean }): ColdStep => ({
  at: Date.now() - start,
  status: update.state.status,
  items: itemCount(update.timeline),
  turns: update.timeline.turns.length,
  earlier: update.timeline.earlier,
  full: isFull(update.timeline),
  catchingUp: update.catchingUp === true,
  trips: link.trips,
  reads: link.readsOf().length,
  wire: link.wireBytes,
});

/**
 * Opens the session cold as a window's Chat does (the service's handle: the warming gate's reader on show, the
 * chips' tap, `standardColdLoad`, the look-back), and runs the fake clock until the first load is done and
 * `settleMs` more; every update with the link's totals then.
 */
export async function coldFeedOpen(options: {
  readonly mode: LinkMode;
  readonly text: string;
  readonly label?: string;
  readonly relayKind?: RelayKind;
  readonly limitMs?: number;
  readonly start?: (feed: ChatFeed<TranscriptSessionRef>) => void;
  /** Sets the link up before the open (a switch of its own). */
  readonly link?: (link: ColdLink) => void;
}): Promise<{ run: ColdRun; feed: ChatFeed<TranscriptSessionRef> }> {
  const link = new ColdLink(coldPath, options.text);
  if (options.relayKind !== undefined) link.relayKind = options.relayKind;
  options.link?.(link);
  const base = link.reader(options.mode);
  const reader = new WarmingReader<TranscriptSessionRef>(base, "mini", new ChatWarmGate(), false);
  const settings = new AgentSettingsReader("claude");
  const tapped = tapReader(reader, settings, () => undefined);
  const feed = new ChatFeed<TranscriptSessionRef>(tapped, {
    cold: standardColdLoad,
    lookBack: { wants: () => settings.settings.modelLabel === null, line: (text, offset) => void settings.line(text, offset) },
    subagentReader: reader,
    stepsShown: () => true,
  });
  const steps: ColdStep[] = [];
  const start = Date.now();
  feed.subscribe((update: ChatFeedUpdate) => steps.push(stepOf(link, start, update)));
  let loadedAt: number | null = null;
  if (options.start === undefined) feed.start(claudeSession);
  else options.start(feed);
  void feed.loaded().then(() => {
    loadedAt = Date.now() - start;
  });
  await runClock(() => loadedAt !== null, options.limitMs ?? 120_000);
  return { run: new ColdRun(options.label ?? "cold open", options.mode, link, steps, loadedAt, start), feed };
}

/** The launch cache a session left: the newest 60 display items of its last 24 MB read whole, as the app had them. */
export function cachedChat(text: string, lastBytes = 24 * 1_024 * 1_024): ChatTimeline {
  const bytes = new TextEncoder().encode(text);
  let start = Math.max(0, bytes.length - lastBytes);
  if (start > 0) start = bytes.indexOf(0x0a, start) + 1;
  return newestItems(whole(new TextDecoder().decode(bytes.subarray(start))));
}

export const coldHost = "mini";
export const coldPane = "w1:p1";

/** The pane as the machine's snapshot shows it (Herdr names its Claude session). */
export function coldHosts(reader: SshTranscriptReader, answered: () => boolean, folders: () => string = () => coldFolder): ChatHosts {
  const backend = { transcripts: () => reader } as unknown as HerdrHostBackend;
  return {
    backend: () => backend,
    pane: (_host: string, pane: string) => (answered() ? { paneID: pane, terminalID: `t-${pane}`, agent: "claude", cwd: folders() } : null),
    agent: (_host: string, pane: string) =>
      answered()
        ? {
            paneID: pane,
            agent: "claude",
            cwd: folders(),
            agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: coldSessionID },
            agentStatus: "idle",
          }
        : null,
  } as unknown as ChatHosts;
}

/**
 * Opens the pane's Chat in the main process's ChatService over the link, as the app does after a launch: with
 * `cache`, the machine has not answered yet, so its cached chat shows (catching up); then its snapshot comes and
 * the feed starts. Every update the page got, with the link's totals then; the clock runs until the first load
 * is done and `until` holds (or `limitMs`).
 */
export async function coldServiceOpen(options: {
  readonly mode: LinkMode;
  readonly text: string;
  readonly cache: ChatTimeline | null;
  readonly label?: string;
  readonly relayKind?: RelayKind;
  readonly limitMs?: number;
  readonly until?: (steps: readonly ColdStep[]) => boolean;
}): Promise<{ run: ColdRun; service: ChatService; link: ColdLink }> {
  const link = new ColdLink(coldPath, options.text);
  if (options.relayKind !== undefined) link.relayKind = options.relayKind;
  const reader = link.reader(options.mode);
  const cache = options.cache;
  let answered = cache === null;
  const service = new ChatService(coldHosts(reader, () => answered), "chat");
  if (cache !== null) service.useLaunchCache({ chat: () => cache, catchingUp: () => !answered, noteChat: () => undefined });
  const steps: ColdStep[] = [];
  const start = Date.now();
  const page = { id: 1, send: (_channel: string, payload: ChatUpdateEvent) => steps.push(stepOf(link, start, payload)), isDestroyed: () => false };
  service.open(page, coldHost, coldPane);
  if (!answered) {
    answered = true;
    service.refresh();
  }
  const windows = (service as unknown as { windows: Map<string, { feed: ChatFeed<TranscriptSessionRef> | null }> }).windows;
  const feed = [...windows.values()][0]?.feed ?? null;
  let loadedAt: number | null = null;
  void feed?.loaded().then(() => {
    loadedAt = Date.now() - start;
  });
  await runClock(() => loadedAt !== null && (options.until?.(steps) ?? true), options.limitMs ?? 120_000);
  return { run: new ColdRun(options.label ?? "cold open with the launch cache", options.mode, link, steps, loadedAt, start), service, link };
}
