// How long New agent and a picture message
// to Claude Code took, step by step, kept so a slow one can be told apart from
// a stuck one. One record per New agent (start) and per picture message to
// Claude Code from Chat (picture): its kind, each step's name and whole
// milliseconds (a picture's attach also its size in bytes), one word for the
// integration step and one for the outcome. Numbers and words from fixed lists
// only: never a folder, a command, a message, a path, a machine, a session or a
// pane. The phone's twin is HerdrKit's SpeedRecord.swift; both write a record
// as the same line.
//
// Kept in memory only, the last `speedLimit` of each, oldest first. Each record
// is logged once as its line (main: `new-agent: …` and `picture-send: …`,
// beside the `updates:` lines) and Report a Problem carries the newest that
// fit, as counts and those lines (shared/feedback.ts).

import { refusalAgent } from "./prompt/refusals";

/** How many records of each are kept (the oldest goes first). */
export const speedLimit = 20;

/** New agent's steps, in the order they can run. */
export type StartStepName = "flags" | "commands" | "integration" | "list" | "pane" | "start" | "wait" | "refresh";
export const startStepNames: readonly StartStepName[] = ["flags", "commands", "integration", "list", "pane", "start", "wait", "refresh"];

/**
 * What the integration step did: nothing (none), an install or an update sent, a wait on another New agent's install
 * or update (waited); `stalled` when the bound ran out first.
 */
export type IntegrationWord = "none" | "install" | "update" | "waited" | "stalled";

/**
 * How a New agent ended: the agent started (or Herdr took its start), started and waiting at its own screen or with no
 * answer to its start (unsure), no agent after a typed command (noAgent), a shell made, refused before any pane
 * (refused), a pane made and closed again after a failed start (closed), or a failure that left its pane (failed).
 */
export type StartOutcome = "started" | "unsure" | "noAgent" | "shell" | "refused" | "closed" | "failed";

/** A picture message's steps: each attach, each read before the write, the write, the wait for the chips, the Return, the proof. */
export type PictureStepName = "attach" | "read" | "write" | "marker" | "return" | "proof";
export const pictureStepNames: readonly PictureStepName[] = ["attach", "read", "write", "marker", "return", "proof"];

/** How a picture message's check ended (send.ts SendCheck), or `refused` / `failed` before its Return. */
export type PictureOutcome = "taken" | "stillInBox" | "unknown" | "refused" | "failed";

export interface SpeedStep<Name extends string = string> {
  readonly name: Name;
  readonly ms: number;
  /** A picture's attach: its size. */
  readonly bytes?: number;
  /** The integration step's word. */
  readonly word?: IntegrationWord;
}

/** One record. `what`: New agent's (start) or a picture message's (picture). */
export interface SpeedRecord {
  readonly what: "start" | "picture";
  /** When it began (ms since 1970). */
  readonly at: number;
  /** The kind as refusalAgent keeps it ("claude", "other", …), or "shell". */
  readonly kind: string;
  readonly steps: readonly SpeedStep[];
  /** From the request (the click, or the Send) to the answer the window waited for: New agent's pane shown, a picture message's Return. */
  readonly shownMs: number | null;
  /** From the request to the last step's end. */
  readonly totalMs: number;
  readonly outcome: StartOutcome | PictureOutcome;
}

/** Whole, non-negative milliseconds. */
export function wholeMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

/** The kind word a record keeps: "shell", a known agent kind, "unknown" or "other" (never a kind's own spelling from agents.json). */
export function speedKind(kind: string | null | undefined): string {
  return kind === "shell" ? "shell" : refusalAgent(kind === null || kind === undefined ? kind : kind.toLowerCase());
}

/** A record's time as the report writes it: UTC to the second. */
function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19)}Z`;
}

/** One step as the line writes it: `pane 50`, `integration update 8123`, `attach 1200 482113b`. */
function stepWords(step: SpeedStep): string {
  const parts: string[] = [step.name];
  if (step.word !== undefined) parts.push(step.word);
  parts.push(String(wholeMs(step.ms)));
  if (step.bytes !== undefined) parts.push(`${Math.max(0, Math.round(step.bytes))}b`);
  return parts.join(" ");
}

/** A record as one line (the log's and Report a Problem's); the phone writes it the same. */
export function speedLine(record: SpeedRecord): string {
  const steps = record.steps.map(stepWords).join(", ");
  const shown = record.shownMs === null ? "" : `, shown ${wholeMs(record.shownMs)}`;
  return `${stamp(record.at)} ${record.what} ${record.kind}: ${steps}${shown}, total ${wholeMs(record.totalMs)}; ${record.outcome}`;
}

/** The last `limit` records, oldest first. */
export class SpeedLog {
  private readonly records: SpeedRecord[] = [];

  constructor(private readonly limit = speedLimit) {}

  record(record: SpeedRecord): void {
    this.records.push(record);
    if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
  }

  list(): readonly SpeedRecord[] {
    return [...this.records];
  }
}

/** Report a Problem's sections for them. */
export const speedSections = { start: "New agent timings (ms)", picture: "Picture message timings (ms)" } as const;

/** The line over a section's records: how many are kept. */
export function speedSummary(records: readonly SpeedRecord[]): string {
  return `- Kept: ${records.length} (the last ${speedLimit}).`;
}

/**
 * Runs a timing or publication call so it only watches: whatever it throws is dropped here, so a record, a log line or
 * a progress line can never change the start or the send it times.
 */
export function quietly(watch: () => void): void {
  try {
    watch();
  } catch {
    // Timing only watches: its failure is never the path's.
  }
}

/**
 * Hands `record` to `keep` after the path that made it has gone on (a later turn of the event loop), its throw dropped:
 * a slow or failing log is never in front of the start's answer or the send's proof.
 */
export function keepLater<R>(keep: (record: R) => void, record: R): void {
  setTimeout(() => quietly(() => keep(record)), 0);
}

/**
 * The steps of one New agent as they ran, timed on a clock (`now`, milliseconds). `time` watches a step's own promise
 * and hands it back unchanged; `add` adds one already measured. Neither can throw into the path it times. The record
 * keeps only the names, numbers and words given.
 */
export class StepTimer<Name extends string = string> {
  private readonly steps: SpeedStep<Name>[] = [];
  readonly started: number;

  constructor(private readonly now: () => number) {
    let started = 0;
    quietly(() => {
      started = now();
    });
    this.started = started;
  }

  /** Runs `work` as the step `name`, whether it answers or throws: its own promise comes back, timed on the side. */
  time<T>(name: Name, work: () => Promise<T>, word?: (value: T | undefined) => IntegrationWord | undefined): Promise<T> {
    let from = 0;
    quietly(() => {
      from = this.now();
    });
    let answer: Promise<T>;
    try {
      answer = work();
    } catch (error) {
      answer = Promise.reject(error);
    }
    const ended = (value: T | undefined): void =>
      quietly(() => {
        const chosen = word?.(value);
        this.add(name, this.now() - from, chosen === undefined ? {} : { word: chosen });
      });
    void answer.then(ended, () => ended(undefined));
    return answer;
  }

  add(name: Name, ms: number, more: { readonly bytes?: number; readonly word?: IntegrationWord } = {}): void {
    quietly(() => {
      this.steps.push({ name, ms: wholeMs(ms), ...more });
    });
  }

  /** Milliseconds since the timer began (0 when the clock cannot be read). */
  since(): number {
    let ms = 0;
    quietly(() => {
      ms = wholeMs(this.now() - this.started);
    });
    return ms;
  }

  list(): readonly SpeedStep<Name>[] {
    return [...this.steps];
  }
}
