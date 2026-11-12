// A pane switch shows its Chat at once. The chats
// of the panes you opened last are kept, their feeds paused (a `ChatShelf`,
// bounded by count and by bytes); panes the sidebar shows working or just
// finished are warmed in the background, at most two at once and never more
// than one warming read in flight per machine (`ChatWarmGate`,
// `WarmingReader`, `warmPlan`). A port of HerdrKit's ChatShelf.swift.

import { isTranscriptStoreReading, type CursorContext, type TranscriptStoreReading } from "./cursor-store";
import {
  isTranscriptIdentityReading,
  isTranscriptWatching,
  type FeedSession,
  type TranscriptFileReader,
  type TranscriptIdentityRead,
  type TranscriptReadOptions,
  type TranscriptWatch,
  type TranscriptWatchSink,
} from "./feed";
import { isFolderListing, type TranscriptFolderListing } from "./subagent-steps";
import type { ChatItem, ChatTimeline } from "./model";

/** The one on show and the last seven before it: eight panes. */
export const defaultShelfCapacity = 7;
/**
 * 24 MB of timelines (`approximateBytes`): about a dozen long chats' worth (a 200-item timeline is a few
 * hundred KB, one full of diffs and outputs a few MB), small beside the app's memory.
 */
export const defaultShelfByteBudget = 24 * 1_024 * 1_024;

/** Entries by key, the least recently put first out: at most `capacity` of them and `byteBudget` bytes. */
export class ChatShelf<T> {
  readonly capacity: number;
  readonly byteBudget: number;
  private order: string[] = [];
  private readonly entries = new Map<string, { entry: T; bytes: number }>();

  constructor(capacity: number = defaultShelfCapacity, byteBudget: number = defaultShelfByteBudget) {
    this.capacity = Math.max(0, capacity);
    this.byteBudget = Math.max(0, byteBudget);
  }

  get count(): number {
    return this.order.length;
  }

  get bytes(): number {
    let total = 0;
    for (const held of this.entries.values()) total += held.bytes;
    return total;
  }

  /** The keys, the least recently put first. */
  get keys(): readonly string[] {
    return this.order;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  peek(key: string): T | undefined {
    return this.entries.get(key)?.entry;
  }

  /**
   * Keeps `entry` as the newest; returns what had to go for it, the least recently put first (a replaced
   * entry of the same key too, and the entry itself when it alone is over the budget).
   */
  put(key: string, entry: T, bytes: number): T[] {
    const gone: T[] = [];
    const old = this.take(key);
    if (old !== undefined) gone.push(old);
    this.order.push(key);
    this.entries.set(key, { entry, bytes: Math.max(0, bytes) });
    return [...gone, ...this.trim()];
  }

  /** Takes the entry out (undefined: not kept). */
  take(key: string): T | undefined {
    const held = this.entries.get(key);
    if (held === undefined) return undefined;
    this.entries.delete(key);
    this.order = this.order.filter((other) => other !== key);
    return held.entry;
  }

  /** A kept entry's size now; returns what had to go. */
  resize(key: string, bytes: number): T[] {
    const held = this.entries.get(key);
    if (held === undefined) return [];
    this.entries.set(key, { entry: held.entry, bytes: Math.max(0, bytes) });
    return this.trim();
  }

  /** Takes out every entry `matching` says; returns them. */
  removeAll(matching: (key: string, entry: T) => boolean): T[] {
    const keys = this.order.filter((key) => {
      const held = this.entries.get(key);
      return held !== undefined && matching(key, held.entry);
    });
    const gone: T[] = [];
    for (const key of keys) {
      const entry = this.take(key);
      if (entry !== undefined) gone.push(entry);
    }
    return gone;
  }

  private trim(): T[] {
    const gone: T[] = [];
    while (this.order.length > 0 && (this.order.length > this.capacity || this.bytes > this.byteBudget)) {
      const entry = this.take(this.order[0]!);
      if (entry !== undefined) gone.push(entry);
    }
    return gone;
  }
}

/** What the timeline holds, in characters of its text (messages, replies, tool rows, diffs, outputs). */
export function approximateBytes(timeline: ChatTimeline): number {
  let total = timeline.title?.length ?? 0;
  for (const turn of timeline.turns) {
    total += 64;
    for (const item of turn.items) total += itemBytes(item);
  }
  return total;
}

function itemBytes(item: ChatItem): number {
  switch (item.type) {
    case "user":
      return 64 + item.value.text.length + item.value.attachments.reduce((sum, attachment) => sum + 64 + (attachment.path?.length ?? 0), 0);
    case "agentText":
    case "progress":
      return 64 + item.value.markdown.length;
    case "notice":
      return 64;
    case "toolCall": {
      const call = item.value;
      let total = 128 + call.toolName.length + call.target.length + (call.resultSummary?.length ?? 0);
      const detail = call.detail;
      switch (detail.type) {
        case "none":
          break;
        case "diff":
          total += detail.diff.files.reduce((sum, file) => sum + file.length, 0);
          total += detail.diff.lines.reduce((sum, line) => sum + 16 + line.text.length, 0);
          break;
        case "bash":
          total += detail.bash.command.length + detail.bash.outputTail.reduce((sum, line) => sum + 16 + line.length, 0);
          break;
        case "search":
          total += detail.search.pattern.length + detail.search.files.reduce((sum, file) => sum + 16 + file.length, 0);
          break;
        case "plan":
          total += detail.steps.reduce((sum, step) => sum + 16 + step.text.length, 0);
          break;
        case "text":
          total += detail.text.length;
          break;
      }
      return total;
    }
    // A turn's subagents row and another session's message, charged by their text.
    case "agents":
      return (
        64 +
        item.value.agents.reduce(
          (sum, agent) =>
            sum + 128 + agent.description.length + (agent.type?.length ?? 0) + (agent.name?.length ?? 0) + (agent.prompt?.length ?? 0) + (agent.report?.length ?? 0),
          0,
        )
      );
    case "agentMessage":
      return 64 + (item.value.from?.length ?? 0) + item.value.text.length;
  }
}

/** One warming read in flight per machine: warming feeds' reads (and sizes and lookups) on one machine wait their turn. */
export class ChatWarmGate {
  private readonly busy = new Set<string>();
  private readonly waiting = new Map<string, { readonly owner: object | null; readonly enter: (gated: boolean) => void }[]>();

  /** Runs `operation` when no other warming read is in flight on `host`; `owner`'s wait ends early on `release(owner)`. */
  async run<T>(host: string, operation: () => Promise<T>, owner: object | null = null): Promise<T> {
    const gated = await this.enter(host, owner);
    try {
      return await operation();
    } finally {
      if (gated) this.leave(host);
    }
  }

  /** `owner` is on show now: its reads still waiting go at once, past the gate. */
  release(owner: object): void {
    // A map's entry may be deleted or set again while it is visited.
    for (const [host, queue] of this.waiting) {
      const mine = queue.filter((waiter) => waiter.owner === owner);
      if (mine.length === 0) continue;
      const rest = queue.filter((waiter) => waiter.owner !== owner);
      if (rest.length === 0) this.waiting.delete(host);
      else this.waiting.set(host, rest);
      for (const waiter of mine) waiter.enter(false);
    }
  }

  private enter(host: string, owner: object | null): Promise<boolean> {
    if (!this.busy.has(host)) {
      this.busy.add(host);
      return Promise.resolve(true);
    }
    // Its turn is handed over by the one before (the machine stays busy).
    return new Promise((resolve) => {
      const queue = this.waiting.get(host) ?? [];
      queue.push({ owner, enter: resolve });
      this.waiting.set(host, queue);
    });
  }

  private leave(host: string): void {
    const queue = this.waiting.get(host);
    const next = queue?.shift();
    if (next === undefined) {
      this.busy.delete(host);
      return;
    }
    if (queue!.length === 0) this.waiting.delete(host);
    next.enter(true);
  }
}

/** A transcript reader whose reads go through the machine's gate while it warms; once on show (`warming = false`) straight through. */
export class WarmingReader<S extends FeedSession = FeedSession> implements TranscriptFileReader<S>, TranscriptStoreReading, TranscriptFolderListing {
  private warms: boolean;

  /**
   * The base reader's read with identity (size, inode and bytes in one relay
   * frame), through the gate as every read; present only when the base has one (an SFTP/exec reader stays
   * without it, so the feed asks the size, then reads).
   */
  declare readonly readWithIdentity?: (path: string, offset: number, maxBytes: number, options?: TranscriptReadOptions) => Promise<TranscriptIdentityRead | null>;

  constructor(
    readonly base: TranscriptFileReader<S>,
    readonly host: string,
    private readonly gate: ChatWarmGate,
    warming = true,
  ) {
    this.warms = warming;
    if (isTranscriptIdentityReading(base)) {
      this.readWithIdentity = (path, offset, maxBytes, options) => this.through(() => base.readWithIdentity(path, offset, maxBytes, options));
    }
  }

  get warming(): boolean {
    return this.warms;
  }

  /** On show (false): its reads go straight through, those waiting at the gate too. */
  set warming(warming: boolean) {
    this.warms = warming;
    if (!warming) this.gate.release(this);
  }

  private through<T>(operation: () => Promise<T>): Promise<T> {
    return this.warms ? this.gate.run(this.host, operation, this) : operation();
  }

  locate(session: S): Promise<string | null> {
    return this.through(() => this.base.locate(session));
  }

  size(path: string): Promise<number> {
    return this.through(() => this.base.size(path));
  }

  read(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    return this.through(() => this.base.read(path, offset, maxBytes));
  }

  /** A folder's names through the gate too (a base without a listing lists none). */
  list(folder: string): Promise<readonly string[]> {
    const base = this.base;
    if (!isFolderListing(base)) return Promise.reject(new Error("this machine's reader lists no folders"));
    return this.through(() => base.list(folder));
  }

  /** A Cursor store's revision and ring, from the base reader (no read of their own). */
  storeRevision(path: string): Promise<number> {
    return isTranscriptStoreReading(this.base) ? this.base.storeRevision(path) : Promise.resolve(0);
  }

  /** The base reader's watch once on show (a warming feed polls through the gate instead). */
  watch(path: string, offset: number, sink: TranscriptWatchSink): Promise<TranscriptWatch | null> {
    return this.warms || !isTranscriptWatching(this.base) ? Promise.resolve(null) : this.base.watch(path, offset, sink);
  }

  storeContext(path: string): Promise<CursorContext | null> {
    return isTranscriptStoreReading(this.base) ? this.base.storeContext(path) : Promise.resolve(null);
  }
}

/** At most this many warm at once. */
export const warmLimit = 2;

/**
 * Which panes to warm: those the sidebar shows working or just finished, in its order, not on show, not
 * kept already, not warming; at most `limit` warming at once.
 */
export function warmPlan(
  candidates: readonly string[],
  shown: ReadonlySet<string>,
  kept: ReadonlySet<string>,
  warming: ReadonlySet<string>,
  limit: number = warmLimit,
): string[] {
  const room = Math.max(0, limit - warming.size);
  const picked: string[] = [];
  if (room === 0) return picked;
  for (const key of candidates) {
    if (shown.has(key) || kept.has(key) || warming.has(key) || picked.includes(key)) continue;
    picked.push(key);
    if (picked.length === room) break;
  }
  return picked;
}
