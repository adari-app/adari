// What a pane's screen says of its context. A
// pane's Terminal, while it shows, reads its visible screen about once a
// second after new output (TerminalView onScreen) and reports it here; when
// it shows Claude Code's "Context low (N% remaining)", that percent wins over
// the ring's own count (context-meter.ts contextView).
//
// A reading belongs to the run it was seen on. It is kept with the
// pane's terminal, session and run (the binding the Terminal showed) and the
// transcript's baseline then (where its newest compaction and its newest count
// were); it counts only while all of those are still the same: a new session
// or run, a compaction since, or a fresher count in the transcript each set it
// aside. A reading with no baseline (no transcript read for that run yet) is
// not kept. A later reading without the warning clears it.

import { screenContextRemaining } from "../../shared/context-meter";
import type { SendBinding } from "../../shared/send-binding";

/** Where the transcript stood: its newest compaction and its newest count (byte offsets), null for none. */
export interface ScreenBaseline {
  readonly compactedAt: number | null;
  readonly usedAt: number | null;
}

interface Seen {
  readonly remaining: number;
  readonly binding: SendBinding;
  readonly baseline: ScreenBaseline;
}

const sameRun = (a: SendBinding, b: SendBinding): boolean =>
  a.terminalID === b.terminalID &&
  a.session === b.session &&
  a.kind === b.kind &&
  a.run?.connection === b.run?.connection &&
  a.run?.arrival === b.run?.arrival;

export class ContextScreens {
  private readonly seen = new Map<string, Seen>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  version = (): number => this.revision;

  private changed(): void {
    this.revision += 1;
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** The pane's visible screen as text, the run it showed, and the transcript's baseline then (null: none read). */
  report(key: string, text: string, binding: SendBinding, baseline: ScreenBaseline | null): void {
    const remaining = baseline === null ? null : screenContextRemaining(text);
    const before = this.seen.get(key);
    if (remaining === null || baseline === null) {
      if (before !== undefined) {
        this.seen.delete(key);
        this.changed();
      }
      return;
    }
    if (
      before !== undefined &&
      before.remaining === remaining &&
      sameRun(before.binding, binding) &&
      before.baseline.compactedAt === baseline.compactedAt &&
      before.baseline.usedAt === baseline.usedAt
    ) {
      return;
    }
    this.seen.set(key, { remaining, binding, baseline });
    this.changed();
  }

  /** The percent remaining the pane's screen showed for this run, unless the transcript moved on since. */
  remaining(key: string, binding: SendBinding, now: ScreenBaseline): number | null {
    const seen = this.seen.get(key);
    if (seen === undefined || !sameRun(seen.binding, binding)) return null;
    if (seen.baseline.compactedAt !== now.compactedAt) return null;
    if ((now.usedAt ?? -1) > (seen.baseline.usedAt ?? -1)) return null;
    return seen.remaining;
  }

  clear(): void {
    this.seen.clear();
    this.changed();
  }
}

export const contextScreens = new ContextScreens();
