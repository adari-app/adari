// A picture message to Claude Code from
// Chat, timed step by step and kept (speed-record.ts), measured only: these
// wrappers time the calls the Send already makes and hand back the call's own
// promise (its answer and its throw unchanged, no step added in front of it);
// the clock is read on the side, a timing call that throws is dropped and the
// record is kept on a later turn, so nothing is sent, waited for or decided here
// (timing only watches).
//
// The steps, in order:
// - attach: each picture's copy to the machine (the upload Chat made before
//   the Send, matched to the message by its path; the path is never kept), its
//   milliseconds and bytes;
// - read: each read in front of the write (Claude's box, the snapshot check,
//   the record's end), one step each;
// - write: Herdr's agent.prompt, from the last read before it to its answer;
// - marker: from the write to the Return, the reads that wait for Claude Code's
//   picture chips (claude-box.ts afterPrompt); to the check's end when no
//   Return went;
// - return: the one Return;
// - proof: from the write's answer to the check's outcome (Claude Code's
//   record, or the screen): marker and return are inside it.
// The record's `shownMs` is the write's answer (the Send's receipt, when the
// composer empties); its outcome the check's word, or `refused` when the Send
// ended before its write answered.

import type { ClaudeBoxSite } from "./herdr/claude-box";
import { promptReturnKey } from "./herdr/claude-box";
import type { QueueRecord } from "../shared/claude-queue-record";
import type { SendCheck } from "../shared/ipc-contract";
import { keepLater, quietly, speedKind, wholeMs, type PictureStepName, type SpeedRecord, type SpeedStep } from "../shared/speed-record";

/** One picture's copy to the machine. */
export interface AttachTime {
  readonly ms: number;
  readonly bytes: number;
}

/**
 * The uploads' times by machine and path until a Send names them (each taken once). At most `kept` (the oldest go);
 * memory only.
 */
export class AttachTimes {
  static readonly kept = 64;
  private readonly times = new Map<string, AttachTime>();

  private static key(hostId: string, path: string): string {
    return `${hostId}\n${path}`;
  }

  set(hostId: string, path: string, time: AttachTime): void {
    const key = AttachTimes.key(hostId, path);
    this.times.delete(key);
    this.times.set(key, { ms: wholeMs(time.ms), bytes: Math.max(0, Math.round(time.bytes)) });
    for (const oldest of this.times.keys()) {
      if (this.times.size <= AttachTimes.kept) break;
      this.times.delete(oldest);
    }
  }

  /** The times for `paths` (in the message's order) that are known, each forgotten as it is taken. */
  take(hostId: string, paths: readonly string[]): AttachTime[] {
    const found: AttachTime[] = [];
    for (const path of paths) {
      const key = AttachTimes.key(hostId, path);
      const time = this.times.get(key);
      if (time === undefined) continue;
      this.times.delete(key);
      found.push(time);
    }
    return found;
  }
}

/** One picture message's timer: the Send's calls wrapped (timed, never changed) and its record made once. */
export class PictureWatch {
  private readonly steps: SpeedStep<PictureStepName>[] = [];
  private readonly started: number;
  private lastReadEnd: number;
  private typedAt: number | null = null;
  private returnStart: number | null = null;
  private returnEnd: number | null = null;
  private done = false;

  constructor(
    private readonly now: () => number,
    private readonly kind: string,
    attaches: readonly AttachTime[],
    private readonly keep: (record: SpeedRecord) => void,
    private readonly at: number = Date.now(),
  ) {
    let started = 0;
    quietly(() => {
      started = now();
    });
    this.started = started;
    this.lastReadEnd = this.started;
    for (const attach of attaches) this.steps.push({ name: "attach", ms: attach.ms, bytes: attach.bytes });
  }

  /** Reads the clock, or null when it cannot be read. */
  private clock(): number | null {
    let at: number | null = null;
    quietly(() => {
      at = this.now();
    });
    return at;
  }

  /** `call` watched: `ended` runs on the side once it settles (dropped if it throws); the call's own promise comes back. */
  private static watched<T>(call: () => Promise<T>, ended: () => void): Promise<T> {
    let answer: Promise<T>;
    try {
      answer = call();
    } catch (error) {
      quietly(ended);
      throw error;
    }
    void Promise.resolve(answer).then(
      () => quietly(ended),
      () => quietly(ended),
    );
    return answer;
  }

  /** A read: timed as its own step while it is in front of the write; after it, part of the wait it is in. */
  read<T>(work: () => Promise<T>): Promise<T> {
    if (this.typedAt !== null) return work();
    const from = this.clock();
    return PictureWatch.watched(work, () => {
      if (this.typedAt !== null || from === null) return;
      const end = this.now();
      this.steps.push({ name: "read", ms: wholeMs(end - from) });
      this.lastReadEnd = Math.max(this.lastReadEnd, end);
    });
  }

  /** Claude's box with its reads and its Return timed (the same object's calls, answers and throws). */
  site(site: ClaudeBoxSite): ClaudeBoxSite {
    return {
      read: () => this.read(() => site.read()),
      keys: (keys) => {
        if (this.typedAt === null || this.returnStart !== null || keys.length !== 1 || keys[0] !== promptReturnKey) return site.keys(keys);
        this.returnStart = this.clock();
        return PictureWatch.watched(
          () => site.keys(keys),
          () => {
            this.returnEnd = this.now();
          },
        );
      },
      wait: (ms) => site.wait(ms),
      ...(site.now === undefined ? {} : { now: () => site.now!() }),
    };
  }

  /** Claude Code's record with its end read in front of the write timed. */
  record(record: QueueRecord | undefined): QueueRecord | undefined {
    if (record === undefined) return undefined;
    return { end: () => this.read(() => record.end()), since: (from) => record.since(from) };
  }

  /** The write answered (the Send's receipt). */
  typed(): void {
    quietly(() => {
      if (this.typedAt !== null) return;
      this.typedAt = this.now();
      this.steps.push({ name: "write", ms: wholeMs(this.typedAt - this.lastReadEnd) });
    });
  }

  /** The check's outcome: the record is made. */
  checked(outcome: SendCheck): void {
    this.finish(outcome);
  }

  /** The Send ended before its write answered (refused or failed), or with no check: the record is made. */
  ended(failed: boolean): void {
    if (this.typedAt === null) this.finish(failed ? "refused" : "unknown");
  }

  /** The record made once (its clock and its keeping only watch: a throw is dropped, the keeping comes later). */
  private finish(outcome: SendCheck | "refused"): void {
    quietly(() => this.close(outcome));
  }

  private close(outcome: SendCheck | "refused"): void {
    if (this.done) return;
    this.done = true;
    const end = this.now();
    const steps = [...this.steps];
    if (this.typedAt !== null) {
      steps.push({ name: "marker", ms: wholeMs((this.returnStart ?? end) - this.typedAt) });
      if (this.returnStart !== null) steps.push({ name: "return", ms: wholeMs((this.returnEnd ?? end) - this.returnStart) });
      steps.push({ name: "proof", ms: wholeMs(end - this.typedAt) });
    }
    keepLater(this.keep, {
      what: "picture",
      at: this.at,
      kind: speedKind(this.kind),
      steps,
      shownMs: this.typedAt === null ? null : wholeMs(this.typedAt - this.started),
      totalMs: wholeMs(end - this.started),
      outcome,
    });
  }
}
