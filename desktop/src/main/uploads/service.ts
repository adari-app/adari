// The app's uploads, for every machine in the sidebar: an attachment the
// composer or the terminal sends goes to its machine over that machine's SFTP
// connection (backend.uploads, src/main/herdr/backend.ts), and the 30-day
// sweep runs once a day per machine account after it connects (sweep.ts,
// the Swift app's UploadSweep.runIfDue after connecting). What this run
// uploaded is kept by the sweep (the Swift app's namesUpload).
//
// The composer uploads a chip as it is attached, so × on it
// stops an upload under way (`cancel`: no request after it, and what it made
// goes) and takes back one already on the machine (`discard`, under one
// deadline). A path the user let go is no longer kept from the sweep: one that
// could not be removed is left to the 30-day sweep, the cleanup an unsent
// upload has always had.
//
// Settings counts each machine's uploads (`count`) and its
// Delete now (`deleteNow`) removes every one of them, through the same file
// access as the sweep (HostUploads.withFiles) and the same walk (sweep.ts with
// every age), so only the uploader's own files in its own folders go, never
// through a symlink, each checked again right before its removal. Kept, as the
// iPhone app keeps what something on the device still names: every file while
// an upload to that machine is under way (its path is not known until it
// ends), what a draft or a kept draft names (its chips, its text: a send under
// way keeps its text in the draft until it went), and an upload finished in
// the last few seconds whose chip the page has not saved as a draft yet.
//
// The count lists the upload folders 32 at a time (sweep.ts inventoryUploads) and
// answers within 2 s: the whole count, or what it counted so far marked
// partial while it goes on (the page's next ask joins it); Delete now stops a
// count running on the machine.
//
// A count that gave a
// partial answer keeps its whole result until the next ask takes it (or a
// Delete now, an upload, a fresh ask or 30 s drops it), so a count that ends
// between two asks is not counted again. A fresh ask (the page's first after
// an upload) never joins a walk that was running before it. A failed walk
// answers its asks at once but stays the machine's count until its listings
// under way have settled; an ask meanwhile starts a new walk after them.

import fs from "node:fs";
import path from "node:path";

import type { DraftsState } from "../../shared/drafts";
import type { HostView } from "../../shared/ipc-contract";
import type { HerdrHostBackend, HostUploads } from "../herdr/backend";
import type { UploadsDeleteResult, UploadsInventory } from "../../shared/settings";
import { inventoryUploads, runSweepIfDue, sweepUploads, type UploadSweepLog, type UploadSweepResult } from "./sweep";
import type { RemoteAttachment } from "./upload";

/**
 * How long Settings waits for a count before it shows what is counted so far (`partial`); the count
 * goes on, and the page's next ask joins it.
 */
export const countAnswerMs = 2_000;

/** One count running on a machine: its walk, what it counted so far, and its stop (a Delete now stops it). */
interface RunningCount {
  /** The walk: settles once every listing of it has settled. */
  readonly work: Promise<UploadsInventory>;
  /** What an ask gets: the walk's result, or its first failure as soon as it happens. */
  readonly answer: Promise<UploadsInventory>;
  readonly counted: { files: number; bytes: number };
  readonly stop: AbortController;
  /** An ask was answered with what was counted so far: the whole result is kept for the next ask. */
  answeredPartly: boolean;
  /** It failed: an ask after it gets a new walk, started once this one's listings have settled. */
  failed: boolean;
}

/** A whole count a partial answer promised, kept for the next ask (one ask takes it). */
interface KeptCount {
  readonly inventory: UploadsInventory;
  readonly backend: HerdrHostBackend | null;
  readonly at: number;
}

/** How long a kept count waits for its ask (the page asks again at once; never a lasting cache). */
export const keptCountMs = 30_000;

export const uploadsUnavailableText = "Uploads are not available for this machine.";

export interface UploadHosts {
  backend(hostId: string): HerdrHostBackend | null;
}

/** An upload finished this recently stays through Delete now (the page saves a draft 500 ms after a change). */
export const recentUploadMs = 10_000;

/** Whether a draft or a kept draft names `path` (one of its chips, or in its text). */
export function draftsNameUpload(state: DraftsState, path: string): boolean {
  const names = (item: { readonly text: string; readonly chips: readonly { readonly path: string }[] }): boolean =>
    item.chips.some((chip) => chip.path === path) || item.text.includes(path);
  return state.drafts.some(names) || state.kept.some(names);
}

export class UploadService {
  /** Paths uploaded in this run: the sweep never removes them. */
  private readonly named = new Set<string>();
  /** When each path of this run finished uploading (Delete now keeps the last few seconds'). */
  private readonly finished = new Map<string, number>();
  /** Uploads under way, by machine account (HostUploads.machineKey: Delete now keeps every file of one with an upload). */
  private readonly active = new Map<string, number>();
  /** A Delete now running, by machine (a second press gets the same one). */
  private readonly deleting = new Map<string, Promise<UploadsDeleteResult>>();
  /** Each machine's state as last seen, so a sweep starts when it connects. */
  private readonly states = new Map<string, HostView["state"]>();
  /** Sweeps running, by host. */
  private readonly running = new Map<string, Promise<UploadSweepResult | null>>();
  /** Uploads under way that the page can stop, by its id for them. */
  private readonly stoppable = new Map<string, AbortController>();
  /** Counts running, by machine (an ask while one runs joins it). */
  private readonly counts = new Map<string, RunningCount>();
  /** Whole counts a partial answer promised, by machine, until an ask takes them. */
  private readonly kept = new Map<string, KeptCount>();

  constructor(
    private readonly hosts: UploadHosts,
    private readonly log: UploadSweepLog,
    private readonly now: () => number = Date.now,
    private readonly report: (hostId: string, result: UploadSweepResult) => void = () => undefined,
  ) {}

  async upload(hostId: string, data: Uint8Array, extension: string, uploadId?: string): Promise<RemoteAttachment> {
    const uploads = this.hosts.backend(hostId)?.uploads?.() ?? null;
    if (uploads === null) throw new Error(uploadsUnavailableText);
    const account = uploads.machineKey;
    this.active.set(account, (this.active.get(account) ?? 0) + 1);
    try {
      if (uploadId === undefined || this.stoppable.has(uploadId)) {
        const remote = await uploads.upload(data, extension);
        this.note(remote.path);
        this.kept.delete(hostId);
        return remote;
      }
      const stop = new AbortController();
      this.stoppable.set(uploadId, stop);
      try {
        const remote = await uploads.upload(data, extension, stop.signal);
        this.note(remote.path);
        this.kept.delete(hostId);
        return remote;
      } finally {
        if (this.stoppable.get(uploadId) === stop) this.stoppable.delete(uploadId);
      }
    } finally {
      const left = (this.active.get(account) ?? 1) - 1;
      if (left > 0) this.active.set(account, left);
      else this.active.delete(account);
    }
  }

  private note(path: string): void {
    this.named.add(path);
    const now = this.now();
    for (const [old, at] of this.finished) if (now - at >= recentUploadMs) this.finished.delete(old);
    this.finished.set(path, now);
  }

  /** Uploads under way now to the machine account `hostId` reaches (0: none, or no uploads there). */
  uploading(hostId: string): number {
    const account = this.hosts.backend(hostId)?.uploads?.()?.machineKey;
    return account === undefined ? 0 : (this.active.get(account) ?? 0);
  }

  /**
   * Settings: the app's uploads on the machine, counted over the sweep's file access. Read only.
   * Answered within `answerWithinMs` (2 s): the whole count, or what is counted so far marked
   * `partial` while the count goes on (the page asks again and joins it). One count per machine at a time.
   * A whole count kept for this ask is the answer; `fresh` (the page's first ask after an upload)
   * drops a kept count and never joins a walk already running: it gets one started after it.
   */
  count(hostId: string, answerWithinMs: number = countAnswerMs, fresh = false): Promise<UploadsInventory> {
    const backend = this.hosts.backend(hostId);
    const kept = this.kept.get(hostId);
    this.kept.delete(hostId);
    if (kept !== undefined && !fresh && kept.backend === backend && this.now() - kept.at < keptCountMs) return Promise.resolve(kept.inventory);
    let running = this.counts.get(hostId);
    if (running === undefined || running.failed || fresh) {
      const uploads = backend?.uploads?.() ?? null;
      if (uploads === null) return Promise.reject(new Error(uploadsUnavailableText));
      // A walk still running (failed, or begun before what a fresh ask must see) settles before the new one starts.
      running = this.startCount(hostId, backend, uploads, running?.work ?? null);
    }
    const held = running;
    return new Promise<UploadsInventory>((resolve, reject) => {
      let answered = false;
      const timer = setTimeout(() => {
        if (answered) return;
        answered = true;
        held.answeredPartly = true;
        resolve({ files: held.counted.files, bytes: held.counted.bytes, partial: true });
      }, Math.max(0, answerWithinMs));
      held.answer.then(
        (inventory) => {
          clearTimeout(timer);
          if (answered) return;
          answered = true;
          // This ask takes the whole count: it is not kept for another.
          if (this.kept.get(hostId)?.inventory === inventory) this.kept.delete(hostId);
          resolve(inventory);
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (answered) return;
          answered = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** A new walk of the machine's uploads (after `after` settles, when given), the machine's count from now. */
  private startCount(hostId: string, backend: HerdrHostBackend | null, uploads: HostUploads, after: Promise<unknown> | null): RunningCount {
    const counted = { files: 0, bytes: 0 };
    const stop = new AbortController();
    let failNow: (error: unknown) => void = () => undefined;
    const failedEarly = new Promise<never>((_resolve, reject) => {
      failNow = reject;
    });
    const walk = (): Promise<UploadsInventory> =>
      uploads.withFiles((sftp) =>
        inventoryUploads(sftp, {
          signal: stop.signal,
          progress: (now) => {
            counted.files = now.files;
            counted.bytes = now.bytes;
          },
          failed: (error) => {
            started.failed = true;
            failNow(error);
          },
        }),
      );
    const work = after === null ? walk() : after.then(walk, walk);
    const answer = Promise.race([work, failedEarly]);
    // Each ask listens to `answer`, and the lines below to `work`: neither is left unheard.
    answer.catch(() => undefined);
    const started: RunningCount = { work, answer, counted, stop, answeredPartly: false, failed: false };
    this.counts.set(hostId, started);
    work.then(
      (inventory) => {
        if (this.counts.get(hostId) !== started) return;
        this.counts.delete(hostId);
        // A partial answer promised the rest: kept until the next ask takes it (every waiting ask got it already).
        if (started.answeredPartly) this.kept.set(hostId, { inventory, backend, at: this.now() });
      },
      () => {
        started.failed = true;
        if (this.counts.get(hostId) === started) this.counts.delete(hostId);
      },
    );
    return started;
  }

  /**
   * Settings' Delete now, after its confirmation: every upload on the machine except those kept
   * (`stillNamed`, an upload under way to it, one just finished), then the folders it emptied; then a count of
   * what is left. It waits for a daily sweep running on the machine; a second press while it runs gets this one.
   */
  deleteNow(hostId: string, stillNamed: (path: string) => boolean = () => false): Promise<UploadsDeleteResult> {
    const running = this.deleting.get(hostId);
    if (running !== undefined) return running;
    const uploads = this.hosts.backend(hostId)?.uploads?.() ?? null;
    if (uploads === null) return Promise.reject(new Error(uploadsUnavailableText));
    const account = uploads.machineKey;
    const keep = (path: string): boolean => {
      if ((this.active.get(account) ?? 0) > 0 || stillNamed(path)) return true;
      const at = this.finished.get(path);
      return at !== undefined && this.now() - at < recentUploadMs;
    };
    // A count running on the machine is stopped (what it would say is gone after this one), and a kept one dropped.
    const counting = this.counts.get(hostId);
    if (counting !== undefined) {
      counting.stop.abort();
      this.counts.delete(hostId);
    }
    this.kept.delete(hostId);
    const work = (async (): Promise<UploadsDeleteResult> => {
      await this.running.get(hostId);
      return uploads.withFiles(async (sftp) => {
        const result = await sweepUploads(sftp, this.now(), null, keep);
        let remaining: UploadsInventory | null = null;
        try {
          remaining = await inventoryUploads(sftp);
        } catch {
          remaining = null;
        }
        return { ...result, remaining };
      });
    })().finally(() => this.deleting.delete(hostId));
    this.deleting.set(hostId, work);
    return work;
  }

  /** × on a chip still uploading: its upload sends no further request, and what it made goes. */
  cancel(uploadId: string): void {
    this.stoppable.get(uploadId)?.abort();
  }

  /** × on a chip already on the machine: that upload goes, under the backend's one deadline. */
  async discard(hostId: string, path: string): Promise<void> {
    // Let go either way: removed, or left to the 30-day sweep.
    this.named.delete(path);
    this.finished.delete(path);
    this.kept.delete(hostId);
    const uploads = this.hosts.backend(hostId)?.uploads?.() ?? null;
    if (uploads?.discard === undefined) throw new Error(uploadsUnavailableText);
    await uploads.discard(path);
  }

  names(path: string): boolean {
    return this.named.has(path);
  }

  /** The sidebar's machines changed: each that has just connected gets its daily sweep, when due. */
  hostsChanged(hosts: readonly HostView[]): void {
    const listed = new Set(hosts.map((host) => host.id));
    for (const id of this.states.keys()) if (!listed.has(id)) this.states.delete(id);
    for (const host of hosts) {
      const before = this.states.get(host.id);
      this.states.set(host.id, host.state);
      if (host.state === "connected" && before !== "connected") void this.sweep(host.id);
    }
  }

  /** The daily sweep of one machine, when due; null when not due, not possible or already running. */
  sweep(hostId: string): Promise<UploadSweepResult | null> {
    const already = this.running.get(hostId);
    if (already !== undefined) return already;
    // A Delete now running removes more than the sweep would; the sweep waits for its next connect.
    if (this.deleting.has(hostId)) return Promise.resolve(null);
    const uploads = this.hosts.backend(hostId)?.uploads?.() ?? null;
    if (uploads === null) return Promise.resolve(null);
    const work = uploads
      .withFiles((sftp) => runSweepIfDue(uploads.machineKey, sftp, this.log, this.now(), (candidate) => this.named.has(candidate)))
      .then(
        (result) => {
          if (result !== null) this.report(hostId, result);
          return result;
        },
        () => null,
      )
      .finally(() => this.running.delete(hostId));
    this.running.set(hostId, work);
    return work;
  }
}

/** When each machine's sweep last started, kept in a small JSON file (upload-sweeps.json in the app's data folder). */
export class FileSweepLog implements UploadSweepLog {
  private entries: Record<string, number> | null = null;

  constructor(private readonly file: string) {}

  private load(): Record<string, number> {
    if (this.entries !== null) return this.entries;
    let entries: Record<string, number> = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) if (typeof value === "number" && Number.isFinite(value)) entries[key] = value;
      }
    } catch {
      entries = {};
    }
    this.entries = entries;
    return entries;
  }

  lastSweep(machine: string): number | null {
    return this.load()[machine] ?? null;
  }

  noteSweep(machine: string, atMs: number): void {
    const entries = { ...this.load(), [machine]: atMs };
    this.entries = entries;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch {
      // Not kept: the next start sweeps again, which is harmless.
    }
  }
}
