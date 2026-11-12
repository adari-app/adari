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
  type DraftInput,
  type DraftsState,
  type KeptDraft,
  type SavedDraft,
} from "../shared/drafts";

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
const sizeOf = (value: unknown): number => utf8Bytes(JSON.stringify(value));

export class DraftStore {
  private readonly drafts = new Map<string, SavedDraft>();
  private kept: KeptDraft[] = [];
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
    const before = this.drafts.size;
    this.bound(null);
    skipped += before - this.drafts.size;
    if (skipped > 0) {
      this.log(`drafts.json: ${skipped} entries were skipped or cut (damaged or past its bounds)`);
      this.changed();
    }
  }

  /** The file's entries that check, and how many did not; null when it is not a drafts file at all. */
  private static parse(text: string): { drafts: SavedDraft[]; kept: KeptDraft[]; skipped: number } | null {
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
    return { drafts, kept, skipped: v["drafts"].length - drafts.length + v["kept"].length - kept.length };
  }

  state(): DraftsState {
    return { drafts: Array.from(this.drafts.values()), kept: [...this.kept] };
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
    if (moved.length > 0) {
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
    if (changed) this.changed();
  }

  /** A change not written yet: written by the deadline set by the first such change. */
  private changed(): void {
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
