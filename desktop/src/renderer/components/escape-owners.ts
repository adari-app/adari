// Who owns Esc now. Esc in a working agent's Chat
// stops it, but never while something on top owns the key: the picture viewer,
// a menu or picker (the Model and Effort chips, a context menu, Send to…, the
// context ring's card), a dialog, the away or search screen, the box over the
// terminal. Each of those holds Esc while it is open; there Esc only closes it.
// A release waits for the next task, so the Esc that closed the
// thing (its own listener may run before or after Stop's) is still its own.

import { useEffect } from "react";

export class EscapeOwners {
  private readonly held = new Map<object, number>();
  private holds = 0;

  /** Holds Esc until the returned release is called (once). */
  hold(): () => void {
    const token = {};
    this.holds += 1;
    this.held.set(token, this.holds);
    return () => {
      setTimeout(() => this.held.delete(token), 0);
    };
  }

  /** Something on top owns Esc now. */
  any(): boolean {
    return this.held.size > 0;
  }

  /** The number of the latest hold (each hold has the next one). */
  latest(): number {
    return this.holds;
  }

  /** Something took Esc after hold number `mark` (a dialog or menu opened over Settings). */
  heldAfter(mark: number): boolean {
    for (const number of this.held.values()) if (number > mark) return true;
    return false;
  }

  /** Tests: nothing holds Esc. */
  reset(): void {
    this.held.clear();
  }
}

export const escapeOwners = new EscapeOwners();

/** Holds Esc while `open`. */
export function useEscapeOwner(open = true): void {
  useEffect(() => (open ? escapeOwners.hold() : undefined), [open]);
}

/**
 * A text field that owns every key while it
 * is open (the sidebar's inline rename). The window's shortcuts (⌘N, ⇧⌘N, ⌘F,
 * ⌘J, the tile keys) and the native menu's commands do nothing then, so what
 * you type stays in the field. Released as Esc's owners are, a task later.
 */
export const keyOwners = new EscapeOwners();

/** Holds every key while `open`. */
export function useKeyOwner(open = true): void {
  useEffect(() => (open ? keyOwners.hold() : undefined), [open]);
}
