// Instant open, as T3 Code does it: per saved machine, its last topology
// and the newest 60 items of the chats open on it, kept in a file of its own
// under the app's data folder. On launch they are on screen at once, marked as
// catching up, until the first snapshot or feed read lands (0 trips). Nothing
// from the cache is ever sent to or acted on: the registry keeps it apart from
// the live snapshot every action is checked on (hosts.ts `cached`).
//
// Writes are off the streaming path: a snapshot or a chat update only keeps a
// reference here; a timer writes what changed at most every 10 s, and once
// more when the app quits.
//
// What the file holds, in plain JSON, mode 0600, written
// whole and renamed into place: the machine's last sidebar topology, and for
// each kept chat its newest 60 display items only: the text of the user's and
// the agent's messages and progress lines, notices, and each tool row's title
// (the tool's name and a custom kind's name; a read or edit's file name). No
// tool arguments or commands, outputs or output tails, subagent payloads, diffs
// or attachment paths. The saved passwords and passphrases (read once per
// write) are taken out of exactly these kept chat fields: the
// message and progress text, the chat title, the tool name, a custom kind's
// name and the read or edit file name. The topology is kept as Herdr sent it,
// not redacted. Message text the user and the agents wrote can still hold
// anything, a credential pasted into a message included.
//
// Version 1 migration limit: a file written by an older build (unprojected, not
// redacted) is loaded as it is and stays on disk until that machine's next
// write replaces it; loading it does not scrub it.
//
// Byte budgets (the Swift launch cache's
// figures where it has them): each kept text at most 64 KiB, cut at a whole
// character; an item's, turn's or pane's id over 256 bytes is not kept (its
// item, turn or chat is left out, never cut); each chat at most 1 MiB encoded
// (the newest items that fit, each counted before it is kept); the topology at
// most 2 MiB encoded (a larger one is not kept); the whole file at most 6 MiB
// (the oldest chats, then the topology, left out while over). At launch a file
// over 6 MiB is neither read nor parsed: no cache.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ChatItem, ChatTimeline, ChatTurn } from "../shared/chat/model";
import type { SessionTopology } from "./herdr/wire";

/** At most one write per machine this often. */
export const cacheWriteEveryMs = 10_000;
/** A cached chat keeps its newest this many items. */
export const cachedChatItems = 60;
/** The chats kept per machine (the most recently shown). */
export const cachedChatsPerHost = 4;
/**
 * Each kept text (a message's, reply's or progress line's text, the title, a
 * tool's name, a custom kind's name, a read's or edit's file name) at most this many UTF-8 bytes, cut at a whole
 * character (Swift's `ChatFeedTail.maxTextBytes`).
 */
export const cachedTextBytes = 64 * 1_024;
/**
 * An item's, a turn's or a pane's id over this many UTF-8 bytes is not kept: its item, turn or chat is
 * left out (never cut: a cut id could stand for another). Transcript ids are UUIDs or about 30 letters.
 */
export const cachedIdBytes = 256;
/** One cached chat at most this, encoded (Swift's `ChatFeed.cacheTailBytes`): the newest items that fit. */
export const cachedChatBytes = 1_048_576;
/** The topology at most this, encoded; a larger one is not kept (the sidebar waits for the first snapshot). */
export const cachedTopologyBytes = 2 * 1_048_576;
/** One machine's whole file at most this, written or read (6 MiB: the topology's budget and each chat's). */
export const cachedHostBytes = cachedTopologyBytes + cachedChatsPerHost * cachedChatBytes;

/** One machine's file. */
export interface HostCache {
  readonly topology: SessionTopology | null;
  /** By pane id, the newest first written last. */
  readonly chats: Readonly<Record<string, ChatTimeline>>;
}

interface CacheFile {
  readonly v: 1;
  readonly topology: SessionTopology | null;
  readonly chats: Readonly<Record<string, ChatTimeline>>;
}

/** The file system the cache uses (a seam for the tests). */
export interface CacheFiles {
  /** The file's text; null when there is none, it does not read, or it holds more than `maxBytes` bytes. */
  read(file: string, maxBytes: number): string | null;
  write(file: string, text: string): void;
  remove(file: string): void;
}

/**
 * A regular file's text when it holds at most `maxBytes` bytes, else null.
 * Its size is taken from the opened file before anything is read, and no more than that size is read (a file
 * that grows meanwhile gives a cut text, which does not parse). Opened without waiting (not a FIFO's writer).
 */
function readBounded(file: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    const buffer = Buffer.alloc(stats.size);
    let filled = 0;
    while (filled < buffer.length) {
      const got = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (got <= 0) break;
      filled += got;
    }
    return buffer.toString("utf8", 0, filled);
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }
}

export function diskCacheFiles(folder: string): CacheFiles {
  return {
    read: (file, maxBytes) => readBounded(path.join(folder, file), maxBytes),
    write: (file, text) => {
      mkdirSync(folder, { recursive: true });
      const target = path.join(folder, file);
      const temp = `${target}.tmp`;
      writeFileSync(temp, text, { mode: 0o600 });
      renameSync(temp, target);
    },
    remove: (file) => rmSync(path.join(folder, file), { force: true }),
  };
}

/** Herdr's wide integers (bigint) as JSON and back. */
const replacer = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? { $big: value.toString() } : value);
const reviver = (_key: string, value: unknown): unknown => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const big = (value as Record<string, unknown>)["$big"];
    if (typeof big === "string" && Object.keys(value).length === 1 && /^-?\d+$/.test(big)) return BigInt(big);
  }
  return value;
};

/** The newest `items` items of `timeline`, as one bounded window (the first kept turn partial when cut). */
export function newestItems(timeline: ChatTimeline, items: number = cachedChatItems): ChatTimeline {
  const turns: ChatTurn[] = [];
  let left = items;
  for (let index = timeline.turns.length - 1; index >= 0 && left > 0; index -= 1) {
    const turn = timeline.turns[index]!;
    if (turn.items.length <= left) {
      turns.unshift(turn);
      left -= turn.items.length;
    } else {
      turns.unshift({ ...turn, items: turn.items.slice(turn.items.length - left), isPartial: true });
      left = 0;
    }
  }
  return { turns, title: timeline.title, earlier: "none", newerWaiting: false, running: [] };
}

/** The UTF-8 bytes of `value` as the file encodes it. */
const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, replacer), "utf8");

/** `text` at most `maxBytes` UTF-8 bytes, cut back to a whole character. */
export function cappedText(text: string, maxBytes: number = cachedTextBytes): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Never more than maxBytes code units are encoded: each is at least one byte, so they reach the cap.
  const head = Buffer.from(text.length > maxBytes ? text.slice(0, maxBytes) : text, "utf8");
  let end = Math.min(maxBytes, head.length);
  while (end > 0 && (head[end]! & 0xc0) === 0x80) end -= 1;
  return head.toString("utf8", 0, end);
}

/** An id the cache keeps (cachedIdBytes at most). */
const keepsId = (id: string): boolean => id.length <= cachedIdBytes && Buffer.byteLength(id, "utf8") <= cachedIdBytes;

/**
 * What instant display needs of one item, nothing more (null: not kept). Messages keep
 * their text (`keep`: redacted, then capped); a tool row keeps its title only; subagents and other sessions'
 * messages are left out. So is an item whose id is over cachedIdBytes.
 */
function displayItem(item: ChatItem, keep: (text: string) => string): ChatItem | null {
  if (!keepsId(item.value.id)) return null;
  switch (item.type) {
    case "user":
      return { type: "user", value: { id: item.value.id, text: keep(item.value.text), time: item.value.time, attachments: [] } };
    case "agentText":
    case "progress":
      return { type: item.type, value: { id: item.value.id, markdown: keep(item.value.markdown), time: item.value.time } };
    case "notice":
      return { type: "notice", value: { id: item.value.id, kind: item.value.kind, time: item.value.time } };
    case "toolCall": {
      const call = item.value;
      // An Agent (Task) call shows in its turn's subagents row: a subagent payload.
      if (call.subagent !== undefined) return null;
      const named = !call.isUserShell && (call.kind === "read" || call.kind === "edit");
      return {
        type: "toolCall",
        value: {
          id: call.id,
          // The tool's own names come from the transcript: redacted like every kept text.
          kind: typeof call.kind === "object" ? { other: keep(call.kind.other) } : call.kind,
          toolName: keep(call.toolName),
          target: named ? keep(call.target.slice(call.target.lastIndexOf("/") + 1)) : "",
          resultSummary: null,
          state: call.state,
          detail: { type: "none" },
          time: call.time,
          finishedAt: call.finishedAt,
          moreCalls: call.moreCalls,
          isUserShell: call.isUserShell,
          program: null,
        },
      };
    }
    case "agents":
    case "agentMessage":
      return null;
  }
}

/**
 * `timeline`'s display items only (displayItem), turns left empty by it dropped. Every kept text redacted, then
 * capped at cachedTextBytes; a turn whose id is over cachedIdBytes is left out.
 */
export function displayTimeline(timeline: ChatTimeline, redact: (text: string) => string = (text) => text): ChatTimeline {
  const keep = (text: string): string => cappedText(redact(text));
  const turns: ChatTurn[] = [];
  for (const turn of timeline.turns) {
    if (!keepsId(turn.id)) continue;
    const items = turn.items.flatMap((item) => displayItem(item, keep) ?? []);
    if (items.length > 0) turns.push({ ...turn, items });
  }
  return { turns, title: timeline.title === null ? null : keep(timeline.title), earlier: "none", newerWaiting: false, running: [] };
}

/**
 * What one chat's cache keeps: its display items (displayTimeline), the
 * newest `cachedChatItems` at most, and of those the newest that fit in `budget` bytes encoded. Each turn's frame
 * and each item is counted, newest first, before it is kept (a separating comma counted with each); the first kept
 * turn is partial when cut. The result is encoded once more and checked whole: null when over (not kept).
 */
export function cachedChat(timeline: ChatTimeline, redact: (text: string) => string = (text) => text, budget: number = cachedChatBytes): ChatTimeline | null {
  const window = newestItems(displayTimeline(timeline, redact));
  let left = budget - encodedBytes({ ...window, turns: [] });
  const turns: ChatTurn[] = [];
  for (let index = window.turns.length - 1; index >= 0 && left > 0; index -= 1) {
    const turn = window.turns[index]!;
    let spent = encodedBytes({ ...turn, items: [] }) + 1;
    const items: ChatItem[] = [];
    for (let at = turn.items.length - 1; at >= 0; at -= 1) {
      const cost = encodedBytes(turn.items[at]) + 1;
      if (spent + cost > left) break;
      spent += cost;
      items.unshift(turn.items[at]!);
    }
    if (items.length === 0) break;
    left -= spent;
    if (items.length < turn.items.length) {
      turns.unshift({ ...turn, items, isPartial: true });
      break;
    }
    turns.unshift(turn);
  }
  const chat: ChatTimeline = { ...window, turns };
  return encodedBytes(chat) <= budget ? chat : null;
}

/**
 * One machine's file within cachedHostBytes: its topology only within
 * cachedTopologyBytes, then, while the whole is over, the oldest chats left out first and the topology last.
 */
function hostFileText(topology: SessionTopology | null, chats: readonly (readonly [string, ChatTimeline])[]): string {
  let kept = topology !== null && encodedBytes(topology) <= cachedTopologyBytes ? topology : null;
  let list = chats;
  for (;;) {
    const file: CacheFile = { v: 1, topology: kept, chats: Object.fromEntries(list) };
    const text = JSON.stringify(file, replacer);
    if (Buffer.byteLength(text, "utf8") <= cachedHostBytes || (list.length === 0 && kept === null)) return text;
    if (list.length > 0) list = list.slice(1);
    else kept = null;
  }
}

export class LaunchCache {
  private readonly loaded = new Map<string, HostCache>();
  private readonly topologies = new Map<string, SessionTopology>();
  private readonly chats = new Map<string, Map<string, ChatTimeline>>();
  private readonly dirty = new Set<string>();
  private readonly writtenAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly files: CacheFiles,
    private readonly now: () => number = Date.now,
    /** Takes the saved secrets out of each text kept (main: the error texts' redaction). */
    private readonly redact: (text: string) => string = (text) => text,
    /**
     * When given (to keep the cost of a write down), called once per flush that writes, and its redaction used for every
     * text of those writes instead of `redact` (main: the saved secrets read and decrypted once, not once per text).
     */
    private readonly redactor: (() => (text: string) => string) | null = null,
  ) {}

  private static fileOf(hostId: string): string {
    return `${createHash("sha256").update(hostId).digest("hex").slice(0, 32)}.json`;
  }

  /**
   * The machine's cache from its file (read once, at launch); null when there is none or it does not read.
   * A file over cachedHostBytes is neither read (the disk's read stats it
   * first) nor parsed: no cache.
   */
  load(hostId: string): HostCache | null {
    const known = this.loaded.get(hostId);
    if (known !== undefined) return known;
    const text = this.files.read(LaunchCache.fileOf(hostId), cachedHostBytes);
    if (text === null || Buffer.byteLength(text, "utf8") > cachedHostBytes) return null;
    try {
      const file = JSON.parse(text, reviver) as Partial<CacheFile>;
      if (file.v !== 1) return null;
      const cache: HostCache = { topology: file.topology ?? null, chats: file.chats ?? {} };
      this.loaded.set(hostId, cache);
      for (const [paneId, timeline] of Object.entries(cache.chats)) this.chatsOf(hostId).set(paneId, timeline);
      if (cache.topology !== null) this.topologies.set(hostId, cache.topology);
      return cache;
    } catch {
      return null;
    }
  }

  /** The cached chat of a pane (launch), or null. */
  chat(hostId: string, paneId: string): ChatTimeline | null {
    return this.loaded.get(hostId)?.chats[paneId] ?? null;
  }

  private chatsOf(hostId: string): Map<string, ChatTimeline> {
    let panes = this.chats.get(hostId);
    if (panes === undefined) {
      panes = new Map();
      this.chats.set(hostId, panes);
    }
    return panes;
  }

  /** A snapshot landed: kept by reference (written later). */
  noteTopology(hostId: string, topology: SessionTopology): void {
    this.topologies.set(hostId, topology);
    this.dirty.add(hostId);
  }

  /** A shown chat's timeline: kept by reference (trimmed and written later). */
  noteChat(hostId: string, paneId: string, timeline: ChatTimeline): void {
    if (timeline.turns.length === 0) return;
    const panes = this.chatsOf(hostId);
    panes.delete(paneId);
    panes.set(paneId, timeline);
    while (panes.size > cachedChatsPerHost) panes.delete(panes.keys().next().value!);
    this.dirty.add(hostId);
  }

  /** A machine removed: its file goes too. */
  forget(hostId: string): void {
    this.topologies.delete(hostId);
    this.chats.delete(hostId);
    this.loaded.delete(hostId);
    this.dirty.delete(hostId);
    try {
      this.files.remove(LaunchCache.fileOf(hostId));
    } catch {
      // Nothing to take away.
    }
  }

  /** Writes what changed, each machine at most every 10 s (`force`: now, at quit), each file within its byte budgets. */
  flush(force = false): void {
    const now = this.now();
    let redact: ((text: string) => string) | null = null;
    for (const hostId of this.dirty) {
      const last = this.writtenAt.get(hostId);
      if (!force && last !== undefined && now - last < cacheWriteEveryMs) continue;
      this.dirty.delete(hostId);
      this.writtenAt.set(hostId, now);
      redact ??= this.redactor?.() ?? this.redact;
      const chats: [string, ChatTimeline][] = [];
      for (const [paneId, timeline] of this.chats.get(hostId) ?? []) {
        if (!keepsId(paneId)) continue;
        const chat = cachedChat(timeline, redact);
        if (chat !== null) chats.push([paneId, chat]);
      }
      try {
        this.files.write(LaunchCache.fileOf(hostId), hostFileText(this.topologies.get(hostId) ?? null, chats));
      } catch {
        // A cache that cannot be written is only slower next launch.
      }
    }
  }

  /** The 10 s writer. */
  start(): void {
    this.stop();
    this.timer = setInterval(() => this.flush(), cacheWriteEveryMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
