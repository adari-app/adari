// One search on one machine (HerdrKit's ConversationSearchRun): the command,
// then the matching lines read and parsed, published as they change. `cancel`
// stops the command's channel and every read at once; nothing is published
// after. The machine's reads go over the chat's transcript connection, which
// the search does not own: an SFTP read already asked for finishes on its own
// and its answer is dropped (the Swift run closes its own file channel; a
// deviation of the desktop port).

import { withDeadline, type RemoteCommandRunner } from "../remote-command";
import { hitOutcome, type SearchFileReader, type SearchHitOutcome } from "./hits";
import { SearchCommand, SearchResults, searchBounds, type SearchHit, type SearchQuery, type SearchTarget } from "./search";

/** What a search needs from one machine: one command run, and reads of the files it names. Read only. */
export interface SearchRemote extends SearchFileReader {
  readonly run: RemoteCommandRunner["run"];
}

export type SearchPhase =
  /** The command runs ("Mac mini: searching…"). */
  | "searching"
  /** The command answered; the matching lines are being read. */
  | "reading"
  | "done"
  /** The command did not answer in time ("no answer in 10 s"). */
  | "timedOut"
  /** The command could not run (the connection failed). */
  | "failed";

/** Where one machine's search is, with what it found so far. */
export interface SearchUpdate {
  readonly phase: SearchPhase;
  readonly results: SearchResults;
  /** The output passed its cap: "more results not shown". */
  readonly truncated: boolean;
  /** Panes not searched (over the file cap). */
  readonly skippedPanes: number;
  /** Matching lines too long to read ("a very long message"). */
  readonly longLines: number;
  /** Matching lines whose read failed. */
  readonly unreadable: number;
  /** Panes whose "N more" is being read. */
  readonly expanding: ReadonlySet<string>;
}

/** The command and the first pass of reads are over (a pane's "N more" may still read on). */
export const isFinal = (update: SearchUpdate): boolean => update.phase === "done" || update.phase === "timedOut" || update.phase === "failed";

class SearchTimedOut extends Error {}

export class SearchRun {
  private readonly abort = new AbortController();
  private cancelled = false;
  private startedRun = false;
  private phase: SearchPhase = "searching";
  private readonly results: SearchResults;
  private truncated = false;
  private skippedPanes = 0;
  private longLines = 0;
  private unreadable = 0;
  private readonly expanding = new Set<string>();
  private readonly listeners = new Set<(update: SearchUpdate) => void>();
  private last: SearchUpdate | null = null;

  /** The command's targets, by the index its hits name. */
  private searched: readonly SearchTarget[] = [];
  /** The file each target's hits are in. */
  private paths = new Map<number, string>();
  /** Each target's hits not read yet, newest (latest in the file) first. */
  private readonly queues = new Map<number, SearchHit[]>();
  /** Lines each target has had read (or started). */
  private readonly started = new Map<number, number>();
  /** Lines each target has being read now. */
  private readonly inFlight = new Map<number, number>();
  /** Targets whose "N more" was asked for: read to the end. */
  private readonly expanded = new Set<number>();
  private pumping = false;

  constructor(
    private readonly query: SearchQuery,
    private readonly targets: readonly SearchTarget[],
    private readonly remote: SearchRemote,
    private readonly timeoutMs: number = searchBounds.timeoutMs,
  ) {
    this.results = new SearchResults(targets.map((target) => target.paneID));
  }

  /** Every update from now on (the newest one at once, when there is one). */
  onUpdate(listener: (update: SearchUpdate) => void): () => void {
    this.listeners.add(listener);
    if (this.last !== null) listener(this.last);
    return () => this.listeners.delete(listener);
  }

  get latest(): SearchUpdate | null {
    return this.last;
  }

  /** Starts the search (once). */
  start(): void {
    if (this.startedRun || this.cancelled) return;
    this.startedRun = true;
    void this.run();
  }

  /** Stops everything: the command's channel and the reads. Nothing is published after. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.abort.abort();
    this.listeners.clear();
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  private publish(): void {
    if (this.cancelled) return;
    const update: SearchUpdate = {
      phase: this.phase,
      results: this.results.clone(),
      truncated: this.truncated,
      skippedPanes: this.skippedPanes,
      longLines: this.longLines,
      unreadable: this.unreadable,
      expanding: new Set(this.expanding),
    };
    this.last = update;
    for (const listener of Array.from(this.listeners)) listener(update);
  }

  private async run(): Promise<void> {
    const command = SearchCommand.make(this.query, this.targets);
    if (command === null) {
      this.phase = "done";
      this.publish();
      return;
    }
    this.skippedPanes = command.skipped.length;
    this.publish();
    let output;
    try {
      output = await withDeadline(
        this.timeoutMs,
        (signal) => this.remote.run(command.command, searchBounds.maximumOutputBytes, signal),
        () => new SearchTimedOut(),
        this.abort.signal,
      );
    } catch (error) {
      if (this.cancelled) return;
      this.phase = error instanceof SearchTimedOut ? "timedOut" : "failed";
      this.publish();
      return;
    }
    if (this.cancelled) return;
    const listing = command.parse(output.bytes, output.truncated);
    this.truncated = listing.truncated;
    this.searched = command.targets;
    this.paths = new Map(listing.files);
    for (const hit of [...listing.hits].reverse()) {
      const queue = this.queues.get(hit.target) ?? [];
      queue.push(hit);
      this.queues.set(hit.target, queue);
    }
    for (const index of [...this.queues.keys()].sort((a, b) => a - b)) {
      this.results.expect(this.queues.get(index)!.length, command.targets[index]!.paneID);
    }
    if (this.queues.size > 0) {
      this.phase = "reading";
      this.publish();
      await this.readLines();
      if (this.cancelled) return;
    }
    this.phase = "done";
    this.publish();
  }

  /** Reads the rest of `paneID`'s matching lines ("N more in this pane"). */
  expand(paneID: string): void {
    if (this.cancelled) return;
    const indices = this.searched.map((target, index) => ({ target, index })).filter(({ target, index }) => target.paneID === paneID && (this.queues.get(index)?.length ?? 0) > 0);
    if (indices.length === 0) return;
    for (const { index } of indices) this.expanded.add(index);
    this.expanding.add(paneID);
    this.publish();
    // The first pass's loop, still running, takes these on; else a new one.
    if (this.pumping || this.phase !== "done") return;
    void this.readLines();
  }

  /**
   * Reads lines, `concurrentReads` at once, round robin over the panes: each
   * pane's newest lines first, until it has `shownPerPane` matches or its lines
   * run out; an expanded pane to its end.
   */
  private async readLines(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const running = new Set<Promise<void>>();
      const fill = (): void => {
        while (!this.cancelled && running.size < searchBounds.concurrentReads) {
          const next = this.nextLine();
          if (next === null) return;
          const [index, hit] = next;
          const path = this.paths.get(index);
          if (path === undefined) {
            this.settle({ kind: "unreadable" }, index);
            continue;
          }
          this.inFlight.set(index, (this.inFlight.get(index) ?? 0) + 1);
          const tracked: Promise<void> = this.readOne(index, hit, path).then((outcome) => {
            running.delete(tracked);
            this.inFlight.set(index, (this.inFlight.get(index) ?? 1) - 1);
            if (this.cancelled) return;
            this.settle(outcome, index);
            this.publish();
          });
          running.add(tracked);
        }
      };
      fill();
      while (running.size > 0 && !this.cancelled) {
        await Promise.race(running);
        fill();
      }
    } finally {
      this.pumping = false;
    }
    if (this.cancelled) return;
    // Panes read to their end are no longer "reading on".
    let changed = false;
    for (const pane of Array.from(this.expanding)) {
      const left = this.searched.some((target, index) => target.paneID === pane && (this.queues.get(index)?.length ?? 0) > 0);
      if (!left) {
        this.expanding.delete(pane);
        changed = true;
      }
    }
    if (changed && this.phase === "done") this.publish();
  }

  private async readOne(index: number, hit: SearchHit, path: string): Promise<SearchHitOutcome> {
    const target = this.searched[index]!;
    try {
      return await withDeadline(
        this.timeoutMs,
        (signal) => hitOutcome(hit, path, target, this.query, this.remote, signal),
        () => new SearchTimedOut(),
        this.abort.signal,
      );
    } catch {
      // A read that failed, did not answer in time, or was cancelled (dropped then).
      return { kind: "unreadable" };
    }
  }

  /** The next line to read: of the panes that still want lines, the one with the fewest read (the first listed on a tie). */
  private nextLine(): [number, SearchHit] | null {
    let best: number | null = null;
    for (const index of [...this.queues.keys()].sort((a, b) => a - b)) {
      if ((this.queues.get(index)?.length ?? 0) === 0 || !this.wantsMore(index)) continue;
      if (best !== null && (this.started.get(index) ?? 0) >= (this.started.get(best) ?? 0)) continue;
      best = index;
    }
    if (best === null) return null;
    const hit = this.queues.get(best)!.shift()!;
    this.started.set(best, (this.started.get(best) ?? 0) + 1);
    return [best, hit];
  }

  private wantsMore(index: number): boolean {
    if (this.expanded.has(index)) return true;
    // A line being read counts as the match it most likely is; lines that are
    // no match never stop the pass.
    const found = this.results.matchesIn(this.searched[index]!.paneID).length + (this.inFlight.get(index) ?? 0);
    return found < searchBounds.shownPerPane;
  }

  private settle(outcome: SearchHitOutcome, index: number): void {
    const paneID = this.searched[index]!.paneID;
    switch (outcome.kind) {
      case "matches":
        this.results.read(outcome.matches, paneID);
        break;
      case "longLine":
        this.longLines += 1;
        this.results.read([outcome.match], paneID);
        break;
      case "unreadable":
        this.unreadable += 1;
        this.results.read([], paneID);
        break;
    }
  }
}
