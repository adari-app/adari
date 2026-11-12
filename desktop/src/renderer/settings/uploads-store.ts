// Each machine's uploads as Settings shows them (in Uploaded images
// only): counted when the page shows them (the main process walks
// Adari's own upload folders on the machine), Deleting… while a Delete now
// runs, and the last Delete now's outcome. Only the machine's id crosses; the
// main process decides what is counted and removed (src/main/uploads/service.ts).
//
// A count is never kept as true for good. The
// page asks again each time a section with counts shows and when a machine
// connects again (SettingsPage.tsx useUploadCounts), and an upload to a
// machine, or a chip's × taking one back, makes its count stale
// (`invalidate`, from composer-drafts.ts and remote-port.ts).
//
// Each machine runs one
// request at a time, a count or a Delete now, in a queue of its own. A count
// asked for while one runs (a reconnect, a section shown, an upload settled)
// is queued and runs once after it, whether it succeeded or failed; a failure
// is not retried on its own. A confirmed Delete now waits behind a count (it
// shows Deleting… at once, and is never dropped); a count queued before it is
// answered by the Delete now's own count of what is left. Each request has a
// number, and only the machine's current one settles what the page shows.
//
// An upload settling while a count
// of this page's runs on the machine (or after a partial answer, while its
// walk goes on there) may not be in that walk: its whole answer is not shown,
// and one fresh count follows it (`uploadsCount(id, true)`: a walk started
// after the ask). An upload settling while nothing of the page's runs there
// makes the next count a fresh one.

import type { HerdrDesktopBridge } from "../../shared/ipc-contract";
import type { UploadsDeleteResult, UploadsState } from "../../shared/settings";

type Bridge = Pick<HerdrDesktopBridge, "uploadsCount" | "deleteUploadsNow">;

/** A main-process refusal as the page puts it (Electron's "Error invoking remote method …" taken off). */
function reason(failure: unknown): string {
  return String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

const unknown: UploadsState = { kind: "unknown" };

/** One machine's queue: what runs now, what waits, and the number of the request that may settle its state. */
interface Queue {
  bridge: Bridge | null;
  /** The request that may settle the state (a later one, or the machine forgotten, makes an answer void). */
  current: number;
  /** A count or Delete now is running (the loop in `run`). */
  busy: Promise<void> | null;
  /** A fresh count is due after what runs now. */
  countAgain: boolean;
  /** A confirmed Delete now waits for what runs now. */
  deleteWaiting: boolean;
  /** A Delete now is running. */
  deleting: boolean;
  /** A count request is on its way. */
  counting: boolean;
  /** The last count answer was partial: its walk goes on in main (or its whole result is kept there). */
  partialOutstanding: boolean;
  /** The machine's uploads changed while such a walk ran: its whole answer may predate the change. */
  walkMayPredate: boolean;
  /** The next count asks for a walk started after it. */
  freshNext: boolean;
}

export class UploadsStore {
  private readonly states = new Map<string, UploadsState>();
  private readonly outcomes = new Map<string, UploadsDeleteResult | string>();
  private readonly queues = new Map<string, Queue>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private requests = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  version = (): number => this.revision;

  private changed(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  state(hostId: string): UploadsState {
    return this.states.get(hostId) ?? unknown;
  }

  /** The last Delete now on the machine: what it did, or why it did not run. */
  outcome(hostId: string): UploadsDeleteResult | string | null {
    return this.outcomes.get(hostId) ?? null;
  }

  private queue(hostId: string): Queue {
    let queue = this.queues.get(hostId);
    if (queue === undefined) {
      queue = {
        bridge: null,
        current: 0,
        busy: null,
        countAgain: false,
        deleteWaiting: false,
        deleting: false,
        counting: false,
        partialOutstanding: false,
        walkMayPredate: false,
        freshNext: false,
      };
      this.queues.set(hostId, queue);
    }
    return queue;
  }

  /** Whether request `id` of `queue` may still settle the machine's state (not superseded, not forgotten). */
  private owns(hostId: string, queue: Queue, id: number): boolean {
    return this.queues.get(hostId) === queue && queue.current === id;
  }

  /**
   * Counts the machine's uploads: now, or once after the count or Delete now that runs there (a reconnect
   * or a section shown meanwhile is not lost). Settles when the machine's queue is empty again.
   */
  refresh(bridge: Bridge, hostId: string): Promise<void> {
    if (typeof bridge.uploadsCount !== "function") return Promise.resolve();
    const queue = this.queue(hostId);
    queue.bridge = bridge;
    queue.countAgain = true;
    return this.run(hostId, queue);
  }

  /**
   * The machine's uploads changed (an upload to it, or one taken back, settled): what was counted is
   * stale. Idle, it shows as unknown and a page showing it reads it again; while a count or Delete now runs, a
   * count follows it.
   */
  invalidate(hostId: string): void {
    const queue = this.queues.get(hostId);
    if (queue !== undefined) {
      // A walk of the page's may have begun before the change: its whole answer is passed over (countOnce).
      // Otherwise the next count is a fresh one.
      if (queue.counting || queue.partialOutstanding) queue.walkMayPredate = true;
      else queue.freshNext = true;
    }
    if (queue?.busy != null) {
      queue.countAgain = true;
      return;
    }
    if (this.state(hostId).kind === "unknown") return;
    this.states.set(hostId, unknown);
    this.changed();
  }

  /**
   * Delete now, after its confirmation: Deleting… at once; it runs when no count runs on the machine (never
   * alongside one, never dropped), then shows what is left (counted again if the Delete now did not say). A second
   * confirmation while one waits or runs is the same Delete now. Settles when the machine's queue is empty again.
   */
  deleteNow(bridge: Bridge, hostId: string): Promise<void> {
    if (typeof bridge.deleteUploadsNow !== "function") return Promise.resolve();
    const queue = this.queue(hostId);
    queue.bridge = bridge;
    if (queue.deleteWaiting || queue.deleting) return queue.busy ?? Promise.resolve();
    queue.deleteWaiting = true;
    // A count running now no longer settles the state: the Delete now's answer will.
    queue.current = ++this.requests;
    this.states.set(hostId, { kind: "deleting" });
    this.outcomes.delete(hostId);
    this.changed();
    return this.run(hostId, queue);
  }

  /** The machine's queue, one request at a time until nothing waits; the running loop if there is one. */
  private run(hostId: string, queue: Queue): Promise<void> {
    if (queue.busy !== null) return queue.busy;
    let finished = false;
    const loop = async (): Promise<void> => {
      try {
        while (this.queues.get(hostId) === queue && queue.bridge !== null) {
          if (queue.deleteWaiting) {
            queue.deleteWaiting = false;
            // A count asked for before the Delete now is answered by its count of what is left.
            queue.countAgain = false;
            await this.deleteOnce(hostId, queue, queue.bridge);
          } else if (queue.countAgain) {
            queue.countAgain = false;
            await this.countOnce(hostId, queue, queue.bridge);
          } else break;
        }
      } finally {
        finished = true;
        queue.busy = null;
      }
    };
    const busy = loop();
    // A loop that had nothing to do finished before this line: it is not running.
    if (!finished) queue.busy = busy;
    return busy;
  }

  private async countOnce(hostId: string, queue: Queue, bridge: Bridge): Promise<void> {
    const id = (queue.current = ++this.requests);
    const fresh = queue.freshNext;
    queue.freshNext = false;
    // What a count still running found so far stays on screen while the page asks again.
    const shown = this.states.get(hostId);
    if (shown?.kind !== "counted" || shown.inventory.partial !== true) {
      this.states.set(hostId, { kind: "counting" });
      this.changed();
    }
    let next: UploadsState;
    queue.counting = true;
    try {
      next = { kind: "counted", inventory: await (fresh ? bridge.uploadsCount(hostId, true) : bridge.uploadsCount(hostId)) };
    } catch (failure) {
      next = { kind: "failed", reason: reason(failure) };
    } finally {
      queue.counting = false;
    }
    // A partial answer leaves the walk going on in main; any other answer leaves none of the page's there. A
    // whole answer from a walk that may predate an upload is not shown: one fresh count follows it.
    const partial = next.kind === "counted" && next.inventory.partial === true;
    queue.partialOutstanding = partial;
    const predates = !partial && queue.walkMayPredate;
    if (!partial) queue.walkMayPredate = false;
    if (predates && this.owns(hostId, queue, id)) {
      queue.countAgain = true;
      queue.freshNext = true;
      return;
    }
    // Superseded (a Delete now, the machine forgotten), or a newer count is due next: this answer is not shown.
    if (!this.owns(hostId, queue, id) || queue.countAgain) return;
    this.states.set(hostId, next);
    this.changed();
    // The main process answered within 2 s with what it counted so far: ask again (it joins the
    // count running there) until the whole count comes back. Delete now stays usable on what is known meanwhile.
    if (next.kind === "counted" && next.inventory.partial === true) queue.countAgain = true;
  }

  private async deleteOnce(hostId: string, queue: Queue, bridge: Bridge): Promise<void> {
    const id = (queue.current = ++this.requests);
    // A Delete now stops a count running in main and drops a kept one: nothing of the page's is left there.
    queue.partialOutstanding = false;
    queue.walkMayPredate = false;
    queue.deleting = true;
    this.states.set(hostId, { kind: "deleting" });
    this.changed();
    try {
      const result = await bridge.deleteUploadsNow(hostId);
      if (!this.owns(hostId, queue, id)) return;
      this.outcomes.set(hostId, result);
      if (result.remaining !== null && result.stopped === null) {
        this.states.set(hostId, { kind: "counted", inventory: result.remaining });
        this.changed();
        return;
      }
    } catch (failure) {
      if (!this.owns(hostId, queue, id)) return;
      this.outcomes.set(hostId, `Not deleted: ${reason(failure)}`);
    } finally {
      queue.deleting = false;
    }
    // It did not say what is left (it stopped, or failed): counted next, in this same queue.
    queue.countAgain = true;
    this.states.set(hostId, unknown);
    this.changed();
  }

  /** A machine gone (removed): its rows go too, and an answer still on its way is void. */
  forget(hostId: string): void {
    const queued = this.queues.delete(hostId);
    if (!this.states.delete(hostId) && !this.outcomes.delete(hostId) && !queued) return;
    this.outcomes.delete(hostId);
    this.changed();
  }

  /** Tests: nothing known (answers still on their way are void). */
  reset(): void {
    this.states.clear();
    this.outcomes.clear();
    this.queues.clear();
    this.revision = 0;
  }
}

export const uploadsStore = new UploadsStore();
