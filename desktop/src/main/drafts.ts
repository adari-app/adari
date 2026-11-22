// The composer's drafts through a quit or a crash.
// The page sends every change of a pane's draft (src/shared/drafts.ts
// DraftInput); this keeps them in memory and in userData/drafts.json, written
// atomically (a temp file, fsync, a rename over the old one), 0600, at most
// 500 ms after the first change not yet written (a deadline later changes do
// not push back: a crash loses at most the last 500 ms of typing) and at quit
// (flush). Keyed by machine and pane.
//
// Kept drafts, the Swift app's Kept items rule at its smallest scope: when a
// machine answers (a live snapshot) without a draft's pane, the draft is not
// dropped; it moves, with its machine, agent and why, to Kept drafts, kept in
// the same file until Put in box or Discard. They are bounded as Kept items are
// (50, 256 KB); one with no room stays a draft, as it was, until there is room
// or its pane is back. A machine removed takes its drafts with it.
//
// Unproved messages: a picture message to Claude Code whose keys and Return went
// is kept here from its Return (written at once, before the page retires its
// draft) until the transcript settles it, Put back or Dismiss, so a page reload,
// a renderer crash or a quit brings its bubble back. At most 8 per pane (the
// oldest beyond goes to Kept drafts) and 64 in all; one older than a week is
// dropped at load. A machine that answers without its pane moves it to Kept
// drafts ("Adari could not confirm Claude Code got this. Its pane is gone."),
// its pictures as chips, where Put in box, Copy and Discard are.
//
// The unproved list counts against the same whole-file bound the reader keeps
// (2 MiB), and holds at most 640 KiB itself. Its room is taken before the
// Return (reserveUnproved): when a copy does not fit, the oldest copies move to
// Kept drafts while Kept has room; when that cannot make room either, the Send
// is refused before any key (unprovedNoRoomText). No draft is ever dropped to
// make room for it, and no file the reader refuses is ever written.
//
// A damaged file is moved aside (drafts.json.damaged-<time>) and the app starts
// with no drafts.

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

import {
  cutToBytes,
  draftSaveDelayMs,
  isKeptDraft,
  isSavedDraft,
  keptByteLimit,
  keptLimit,
  maxDraftChips,
  maxDraftsBytes,
  maxDraftTextBytes,
  maxLostNames,
  maxSavedDrafts,
  utf8Bytes,
  isUnprovedSend,
  unprovedKeptReason,
  unprovedLimit,
  unprovedMaxAgeMs,
  unprovedPerPane,
  type DraftInput,
  type DraftsState,
  type KeptDraft,
  type SavedChip,
  type SavedDraft,
  type UnprovedHistory,
  type UnprovedOutcome,
  type UnprovedSend,
  unprovedByteLimit,
} from "../shared/drafts";
import { imagePaths } from "../shared/claude-screen";

/** Where the drafts are written. */
export interface DraftFiles {
  /** The file's text, or null when there is none; at most `maxBytes` + 1 bytes of it are read. */
  read(maxBytes: number): string | null;
  /** Replaces the file as one step. */
  write(text: string): void;
  /** Moves a damaged file aside; where it went, or null. */
  moveAside(): string | null;
}

/** drafts.json in a folder: atomic writes, 0600. */
export function fileDrafts(file: string): DraftFiles {
  return {
    read(maxBytes) {
      let handle: number;
      try {
        handle = openSync(file, "r");
      } catch {
        return null;
      }
      try {
        // One byte past the bound tells a file too large, without reading the rest of it.
        const buffer = Buffer.alloc(maxBytes + 1);
        let filled = 0;
        while (filled < buffer.length) {
          const n = readSync(handle, buffer, filled, buffer.length - filled, null);
          if (n === 0) break;
          filled += n;
        }
        return buffer.subarray(0, filled).toString("utf8");
      } catch {
        return null;
      } finally {
        closeSync(handle);
      }
    },
    write(text) {
      mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp-${process.pid}`;
      const handle = openSync(temp, "w", 0o600);
      try {
        writeSync(handle, text);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temp, file);
    },
    moveAside() {
      const aside = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        renameSync(file, aside);
        return aside;
      } catch {
        return null;
      }
    },
  };
}

/** Drafts kept in memory only (a demo run's are never kept). */
export class MemoryDraftFiles implements DraftFiles {
  text: string | null = null;
  read(maxBytes: number): string | null {
    return this.text === null ? null : this.text.slice(0, maxBytes + 1);
  }
  write(text: string): void {
    this.text = text;
  }
  moveAside(): string | null {
    this.text = null;
    return null;
  }
}

export interface DraftStoreOptions {
  readonly now?: () => number;
  readonly delayMs?: number;
  /** A line for the log (a damaged file, a draft dropped for the bounds, a write that failed). */
  readonly log?: (line: string) => void;
}

const goneReason = "Its pane is gone.";
/** A write that failed is tried again this long after. */
const failedWriteRetryMs = 5_000;

/**
 * A draft as it is kept, the same on save and on load, so every saved
 * draft passes the load's check: its text cut to the bound, 10 chips (the
 * rest named with the files not kept), at most 64 such names.
 */
function normalizedDraft(input: DraftInput & { readonly hostId: string; readonly paneId: string; readonly cut?: boolean }, agent: string | null, savedAt: number): SavedDraft {
  const text = cutToBytes(input.text, maxDraftTextBytes);
  const chips = input.chips.slice(0, maxDraftChips);
  const lost = [...input.lost, ...input.chips.slice(maxDraftChips).map((chip) => chip.name)].slice(0, maxLostNames);
  return {
    hostId: input.hostId,
    paneId: input.paneId,
    text,
    chips,
    lost,
    ...(text.length < input.text.length || input.cut === true ? { cut: true } : {}),
    savedAt,
    ...(agent === null ? {} : { agent: agent.slice(0, 255) }),
  };
}
const keyOf = (hostId: string, paneId: string): string => `${hostId}\n${paneId}`;

/**
 * An unproved message as a Kept draft's text and chips: its caption, and its pictures as chips when every image path
 * is at its end as Send put it there; otherwise the whole text, no chips.
 */
function keptParts(text: string): { readonly text: string; readonly chips: readonly SavedChip[] } {
  const paths = imagePaths(text);
  const tail = paths.join(" ");
  if (paths.length === 0 || !text.endsWith(tail)) return { text, chips: [] };
  const head = text.slice(0, text.length - tail.length);
  const chips = paths.map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) || path, image: true }));
  return { text: head.endsWith(" ") ? head.slice(0, -1) : head, chips: chips.slice(0, maxDraftChips) };
}
const sizeOf = (value: unknown): number => utf8Bytes(JSON.stringify(value));
/** What an unproved list adds to the file when it was empty (`,"unproved":[` and `]`), with room to spare. */
const unprovedKeyBytes = 16;
/** What a copy is before it is kept. */
export type UnprovedEntry = Omit<UnprovedSend, "id" | "outcome" | "sentAt" | "history">;
/**
 * The most a copy of `entry` can take in the file once kept: a uuid, the longest outcome, a time, and the
 * longest history the page may add (an anchor of 256 characters, each escaped), and its comma.
 */
function unprovedSize(entry: UnprovedEntry): number {
  const longest: UnprovedSend = {
    ...entry,
    id: "00000000-0000-0000-0000-000000000000",
    sentAt: 9_999_999_999_999,
    outcome: "stillInBox",
    history: { anchor: "\u0000".repeat(256) },
  };
  return sizeOf(longest) + 1;
}

export class DraftStore {
  private readonly drafts = new Map<string, SavedDraft>();
  private kept: KeptDraft[] = [];
  /** Messages past their Return nothing proved yet, oldest first. */
  private unproved: UnprovedSend[] = [];
  /** Room taken for copies whose Send is under way (reserveUnproved), by token: their most bytes. */
  private readonly reserved = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private readonly now: () => number;
  private readonly delayMs: number;
  private readonly log: (line: string) => void;
  /** Where a damaged file was moved at load, or null. */
  readonly damaged: string | null = null;

  constructor(
    private readonly files: DraftFiles,
    options: DraftStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.delayMs = options.delayMs ?? draftSaveDelayMs;
    this.log = options.log ?? (() => undefined);
    // The read is bounded before parsing; a file past the bound is moved aside unparsed.
    const text = files.read(maxDraftsBytes);
    if (text === null) return;
    const loaded = utf8Bytes(text) > maxDraftsBytes ? null : DraftStore.parse(text);
    if (loaded === null) {
      this.damaged = files.moveAside();
      this.log(`drafts.json did not read; moved aside to ${this.damaged ?? "(could not move it)"}`);
      return;
    }
    // Each entry on its own (a bad one is skipped, never the whole file), normalized as a save is,
    // then the count, Kept and whole-file bounds, the least recently saved going first.
    let skipped = loaded.skipped;
    const drafts = loaded.drafts.sort((a, b) => a.savedAt - b.savedAt);
    for (const draft of drafts) this.drafts.set(keyOf(draft.hostId, draft.paneId), normalizedDraft(draft, draft.agent ?? null, draft.savedAt));
    let used = 2;
    for (const loadedItem of loaded.kept) {
      // A Kept entry gets the same per-entry bounds as an active draft (its text cut, 10 chips).
      const bounded = normalizedDraft({ ...loadedItem, lost: [] }, null, loadedItem.at);
      const item: KeptDraft = { ...loadedItem, text: bounded.text, chips: bounded.chips };
      if (item.text !== loadedItem.text || item.chips.length !== loadedItem.chips.length) skipped += 1;
      const grows = sizeOf(item) + (this.kept.length === 0 ? 0 : 1);
      if (this.kept.length >= keptLimit || used + grows > keptByteLimit) {
        skipped += 1;
        continue;
      }
      this.kept.push(item);
      used += grows;
    }
    // Unproved messages: a week old at most, then the per-pane and overall counts (the oldest beyond go to Kept drafts).
    const fresh = loaded.unproved.filter((entry) => this.now() - entry.sentAt <= unprovedMaxAgeMs);
    if (fresh.length < loaded.unproved.length) this.log(`drafts.json: ${loaded.unproved.length - fresh.length} unproved messages older than a week were dropped`);
    skipped += loaded.unproved.length - fresh.length;
    for (const entry of fresh.sort((a, b) => a.sentAt - b.sentAt)) this.addUnproved(entry, null);
    const before = this.drafts.size;
    this.bound(null);
    skipped += before - this.drafts.size;
    if (skipped > 0) {
      this.log(`drafts.json: ${skipped} entries were skipped or cut (damaged or past its bounds)`);
      this.changed();
    }
  }

  /** The file's entries that check, and how many did not; null when it is not a drafts file at all. */
  private static parse(text: string): { drafts: SavedDraft[]; kept: KeptDraft[]; unproved: UnprovedSend[]; skipped: number } | null {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    if (v["version"] !== 1 || !Array.isArray(v["drafts"]) || !Array.isArray(v["kept"])) return null;
    const drafts = v["drafts"].filter(isSavedDraft) as SavedDraft[];
    const kept = v["kept"].filter(isKeptDraft) as KeptDraft[];
    // A file from before unproved messages has none.
    const listed = Array.isArray(v["unproved"]) ? (v["unproved"] as unknown[]) : [];
    const unproved = listed.filter(isUnprovedSend) as UnprovedSend[];
    return { drafts, kept, unproved, skipped: v["drafts"].length - drafts.length + v["kept"].length - kept.length + listed.length - unproved.length };
  }

  state(): DraftsState {
    return { drafts: Array.from(this.drafts.values()), kept: [...this.kept], ...(this.unproved.length === 0 ? {} : { unproved: [...this.unproved] }) };
  }

  /**
   * Before a picture message's first key: room for its copy, taken until it is kept (keepUnproved with the token) or
   * the Send ends without a Return (releaseReservation). The oldest copies move to Kept drafts while Kept has room
   * when that makes room. Null: no room, and the Send is refused before any key (unprovedNoRoomText).
   */
  reserveUnproved(entry: UnprovedEntry): string | null {
    const size = unprovedSize(entry);
    if (!this.roomFor(size)) {
      this.log(`no room to keep a copy of a message for ${entry.hostId} ${entry.paneId} (${size} bytes): the Send is refused before any key`);
      return null;
    }
    const token = randomUUID();
    this.reserved.set(token, size);
    return token;
  }

  /** The Send ended without its Return: its room goes back. */
  releaseReservation(token: string): void {
    this.reserved.delete(token);
  }

  /**
   * A message whose keys and Return went, kept until the transcript settles it: written to the file now, before the
   * page retires its draft. Its id; null when there is no room for it (the room its Send reserved was taken since by
   * the drafts, or none was reserved): then nothing is written, the file stays one the reader loads, and no draft is
   * dropped for it.
   */
  keepUnproved(entry: UnprovedEntry, reservation: string | null = null): string | null {
    const size = unprovedSize(entry);
    if (reservation !== null) this.reserved.delete(reservation);
    if (!this.roomFor(size)) {
      this.log(`a copy of a message for ${entry.hostId} ${entry.paneId} was not kept: drafts.json has no room for it`);
      return null;
    }
    const id = randomUUID();
    this.addUnproved({ ...entry, id, sentAt: this.now(), outcome: "checking" }, entry.hostId);
    this.dirty = true;
    this.write();
    return id;
  }

  /**
   * Where the session's transcript stood when unproved message `id` went (the page's baseline): set once, written
   * at once. False when it is not kept, already has one, or the file has no room for it (it then stays without one:
   * its restored bubble is never settled by the transcript).
   */
  unprovedHistory(id: string, history: UnprovedHistory): boolean {
    const entry = this.unproved.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.history !== undefined) return false;
    const next = { ...entry, history };
    const grows = sizeOf(next) - sizeOf(entry);
    if (this.fileBytes() + this.reservedBytes() + grows > maxDraftsBytes || sizeOf(this.unproved) + this.reservedBytes() + grows > unprovedByteLimit) return false;
    this.unproved = this.unproved.map((candidate) => (candidate.id === id ? next : candidate));
    this.revision += 1;
    this.dirty = true;
    this.write();
    return true;
  }

  private reservedBytes(): number {
    let total = 0;
    for (const size of this.reserved.values()) total += size;
    return total;
  }

  /**
   * Room for one more copy of `size` bytes beside the copies kept and the room reserved: within the list's own bound
   * and the whole file's, the drafts and Kept drafts as they are. When only the list's bound is short, the oldest
   * copies move to Kept drafts while Kept has room (moving never makes the file smaller, so the file's bound is never
   * met that way); they move only when that makes room. No draft is dropped.
   */
  private roomFor(size: number): boolean {
    const reserved = this.reservedBytes();
    const fileNow = (): number => this.fileBytes() + (this.unproved.length === 0 ? unprovedKeyBytes : 0);
    let file = fileNow();
    let list = sizeOf(this.unproved);
    const fits = (): boolean => list + reserved + size <= unprovedByteLimit && file + reserved + size <= maxDraftsBytes;
    if (fits()) return true;
    if (file + reserved + size > maxDraftsBytes) return false;
    // The moves, planned first: each the oldest copy as a Kept draft, while Kept has room.
    const moves: { readonly entry: UnprovedSend; readonly item: KeptDraft }[] = [];
    let keptCount = this.kept.length;
    let keptBytes = sizeOf(this.kept);
    for (const entry of [...this.unproved].sort((a, b) => a.sentAt - b.sentAt)) {
      if (fits()) break;
      const item = this.keptItem(entry, entry.hostId, unprovedKeptReason);
      const grows = sizeOf(item) + (keptCount === 0 ? 0 : 1);
      if (keptCount >= keptLimit || keptBytes + grows > keptByteLimit) break;
      const shrinks = sizeOf(entry) + 1;
      keptCount += 1;
      keptBytes += grows;
      list -= shrinks;
      file += grows - shrinks;
      moves.push({ entry, item });
    }
    if (moves.length === 0 || !fits()) return false;
    const before = { unproved: this.unproved, kept: this.kept };
    const moving = new Set(moves.map((move) => move.entry));
    this.unproved = this.unproved.filter((candidate) => !moving.has(candidate));
    this.kept = [...this.kept, ...moves.map((move) => move.item)];
    // The plan's sums, checked against the file as it would be written.
    if (sizeOf(this.unproved) + reserved + size > unprovedByteLimit || fileNow() + reserved + size > maxDraftsBytes) {
      this.unproved = before.unproved;
      this.kept = before.kept;
      return false;
    }
    this.log(`${moves.length} unproved messages moved to Kept drafts to make room for a new one`);
    this.changed();
    return true;
  }

  /** Main's check answered for unproved message `id`: false when it is not kept (any more) or already said so. */
  unprovedOutcome(id: string, outcome: Exclude<UnprovedOutcome, "checking">): boolean {
    const entry = this.unproved.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.outcome === outcome) return false;
    this.unproved = this.unproved.map((candidate) => (candidate.id === id ? { ...candidate, outcome } : candidate));
    this.changed();
    return true;
  }

  /** The transcript settled it, or the person put it back or dismissed it: it is kept no more. */
  releaseUnproved(id: string): boolean {
    const next = this.unproved.filter((candidate) => candidate.id !== id);
    if (next.length === this.unproved.length) return false;
    this.unproved = next;
    this.changed();
    return true;
  }

  /**
   * Adds `entry` (the newest of its pane), then holds the bounds: past unprovedPerPane for its pane, or
   * unprovedLimit in all, the oldest goes to Kept drafts (with no room there, or in the file, it is dropped and
   * logged). The bytes were made room for before (roomFor).
   */
  private addUnproved(entry: UnprovedSend, hostLabel: string | null): void {
    this.unproved = [...this.unproved, entry];
    const forPane = this.unproved.filter((candidate) => candidate.hostId === entry.hostId && candidate.paneId === entry.paneId);
    const extra = forPane.slice(0, Math.max(0, forPane.length - unprovedPerPane));
    const beyond = this.unproved.length - extra.length - unprovedLimit;
    if (beyond > 0) extra.push(...this.unproved.filter((candidate) => !extra.includes(candidate)).slice(0, beyond));
    for (const old of extra) {
      this.unproved = this.unproved.filter((candidate) => candidate !== old);
      if (!this.keepAsKept(old, hostLabel ?? old.hostId, unprovedKeptReason)) this.log(`an unproved message for ${old.hostId} ${old.paneId} was dropped: Kept drafts has no room for it`);
    }
  }

  /** An unproved message as a Kept draft (its caption and pictures as chips). */
  private keptItem(entry: UnprovedSend, hostLabel: string, reason: string): KeptDraft {
    const parts = keptParts(entry.text);
    return {
      id: randomUUID(),
      hostId: entry.hostId,
      hostLabel: hostLabel.slice(0, 255),
      paneId: entry.paneId,
      agentName: "claude",
      text: cutToBytes(parts.text, maxDraftTextBytes),
      chips: parts.chips,
      reason,
      at: this.now(),
    };
  }

  /**
   * An unproved message (already out of the list) under Kept drafts; false with no room there, or when the file
   * would pass its bound with it.
   */
  private keepAsKept(entry: UnprovedSend, hostLabel: string, reason: string): boolean {
    const item = this.keptItem(entry, hostLabel, reason);
    const grows = sizeOf(item) + (this.kept.length === 0 ? 0 : 1);
    if (this.kept.length >= keptLimit || sizeOf(this.kept) + grows > keptByteLimit) return false;
    this.kept.push(item);
    if (this.fileBytes() + this.reservedBytes() > maxDraftsBytes) {
      this.kept.pop();
      return false;
    }
    return true;
  }

  /** A pane's draft as the page has it now; null (or an empty one) clears it. `agent`: who it is for, when known. */
  put(hostId: string, paneId: string, input: DraftInput | null, agent: string | null): void {
    const key = keyOf(hostId, paneId);
    if (input === null || (input.text === "" && input.chips.length === 0 && input.lost.length === 0)) {
      if (this.drafts.delete(key)) this.changed();
      return;
    }
    const draft = normalizedDraft({ ...input, hostId, paneId }, agent, this.now());
    this.drafts.delete(key);
    this.drafts.set(key, draft);
    this.bound(key);
    this.changed();
  }

  /** The whole file as written (its envelope, Kept drafts and the newline). */
  private fileBytes(): number {
    return utf8Bytes(JSON.stringify({ version: 1, ...this.state() })) + 1;
  }

  /**
   * The count and the whole file's size, Kept drafts included: the
   * least recently saved drafts go first, never `keep`; Kept drafts are never
   * dropped (they are bounded on their own).
   */
  private bound(keep: string | null): void {
    let total = this.fileBytes();
    const order = Array.from(this.drafts.entries()).sort((a, b) => a[1].savedAt - b[1].savedAt);
    for (const [key, draft] of order) {
      if (this.drafts.size <= maxSavedDrafts && total <= maxDraftsBytes) break;
      if (key === keep) continue;
      this.drafts.delete(key);
      total -= sizeOf(draft) + 1;
      this.log(`a draft for ${draft.hostId} ${draft.paneId} was dropped: drafts.json keeps ${maxSavedDrafts} drafts, ${maxDraftsBytes} bytes`);
    }
  }

  /**
   * The machine answered with these panes: each of its drafts whose pane is
   * not among them moves to Kept drafts while there is room. The panes whose
   * drafts moved.
   */
  hostAnswered(hostId: string, hostLabel: string, livePanes: ReadonlySet<string>): { hostId: string; paneId: string }[] {
    const gone = Array.from(this.drafts.entries())
      .filter(([, draft]) => draft.hostId === hostId && !livePanes.has(draft.paneId))
      .sort((a, b) => a[1].savedAt - b[1].savedAt);
    const moved: { hostId: string; paneId: string }[] = [];
    let used = sizeOf(this.kept);
    for (const [key, draft] of gone) {
      const item: KeptDraft = {
        id: randomUUID(),
        hostId,
        hostLabel: hostLabel.slice(0, 255),
        paneId: draft.paneId,
        agentName: draft.agent ?? null,
        text: draft.text,
        chips: draft.chips,
        reason: goneReason,
        at: this.now(),
      };
      // The JSON array grows by the item and a comma.
      const grows = sizeOf(item) + (this.kept.length === 0 ? 0 : 1);
      if (this.kept.length >= keptLimit || used + grows > keptByteLimit) continue;
      this.kept.push(item);
      used += grows;
      this.drafts.delete(key);
      moved.push({ hostId, paneId: draft.paneId });
    }
    // Unproved messages of gone panes: under Kept drafts (no bubble can show them); with no room, kept as they are.
    let movedUnproved = false;
    for (const entry of this.unproved.filter((candidate) => candidate.hostId === hostId && !livePanes.has(candidate.paneId))) {
      const before = this.unproved;
      this.unproved = this.unproved.filter((candidate) => candidate !== entry);
      if (!this.keepAsKept(entry, hostLabel, `${unprovedKeptReason} ${goneReason}`)) {
        this.unproved = before;
        continue;
      }
      movedUnproved = true;
    }
    if (moved.length > 0 || movedUnproved) {
      this.bound(null);
      this.changed();
    }
    return moved;
  }

  /**
   * A line the page could not leave in the pane's box (a held typed
   * `/compact` that did not go while the box held newer text) becomes a Kept draft of its own, bounded as any Kept
   * draft (its text cut, 50 items, 256 KB). The item, or null with no room (the page then keeps the line in the box).
   */
  keep(hostId: string, hostLabel: string, paneId: string, agent: string | null, text: string, reason: string): KeptDraft | null {
    if (text === "") return null;
    const item: KeptDraft = {
      id: randomUUID(),
      hostId,
      hostLabel: hostLabel.slice(0, 255),
      paneId,
      agentName: agent === null ? null : agent.slice(0, 255),
      text: cutToBytes(text, maxDraftTextBytes),
      chips: [],
      reason: reason.slice(0, 400),
      at: this.now(),
    };
    const grows = sizeOf(item) + (this.kept.length === 0 ? 0 : 1);
    if (this.kept.length >= keptLimit || sizeOf(this.kept) + grows > keptByteLimit) return null;
    this.kept.push(item);
    this.bound(null);
    this.changed();
    return item;
  }

  /** Put in box: the item leaves Kept drafts (the page puts its text in the box). */
  takeKept(id: string): KeptDraft | null {
    const item = this.kept.find((candidate) => candidate.id === id) ?? null;
    if (item === null) return null;
    this.kept = this.kept.filter((candidate) => candidate.id !== id);
    this.changed();
    return item;
  }

  discardKept(id: string): boolean {
    return this.takeKept(id) !== null;
  }

  /** The machine was removed: its drafts and kept drafts go. */
  forgetHost(hostId: string): void {
    let changed = false;
    for (const [key, draft] of Array.from(this.drafts.entries())) {
      if (draft.hostId !== hostId) continue;
      this.drafts.delete(key);
      changed = true;
    }
    const kept = this.kept.filter((item) => item.hostId !== hostId);
    if (kept.length !== this.kept.length) {
      this.kept = kept;
      changed = true;
    }
    const unproved = this.unproved.filter((entry) => entry.hostId !== hostId);
    if (unproved.length !== this.unproved.length) {
      this.unproved = unproved;
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Counts every change (the page is told of one a machine's answer made: drafts-ipc.ts draftsAnswered). */
  revision = 0;

  /** A change not written yet: written by the deadline set by the first such change. */
  private changed(): void {
    this.revision += 1;
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, this.delayMs);
  }

  /** Writes now (at quit). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.write();
  }

  /**
   * Clean only once the atomic write succeeded; a failed one stays
   * dirty, is tried again by a later deadline (a few seconds on) and by the
   * next flush (quit).
   */
  private write(): void {
    if (!this.dirty) return;
    try {
      this.files.write(`${JSON.stringify({ version: 1, ...this.state() })}\n`);
      this.dirty = false;
    } catch (error) {
      this.log(`drafts.json was not written: ${error instanceof Error ? error.message : String(error)}`);
      if (this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.write();
        }, failedWriteRetryMs);
      }
    }
  }
}
