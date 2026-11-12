// The keyboard goes back where it was after
// a rename. The window notes each text field that takes the focus (the
// terminal, the Composer, the box over the terminal; never a rename field),
// so a rename field opened from a menu knows the owner from before the menu
// or the field took the focus: the field focused then, else the last one. After
// Return or Esc the field gives the focus back to it, if it is still in the
// window; a click away leaves the focus where you clicked; a field replaced by
// another, or removed, gives nothing back (the new one keeps its own focus).

import { textFieldFocused, type FocusedElement } from "./agent-stop";

/** An element the focus can go back to (an HTMLElement fits). */
export interface FocusOwner extends FocusedElement {
  readonly isConnected?: boolean;
  focus(): void;
}

/** A rename field's own input: never an owner to go back to. */
const inRenameField = (element: FocusedElement): boolean => element.closest?.("[data-rename]") != null;

const isOwner = (element: unknown): element is FocusOwner =>
  typeof element === "object" &&
  element !== null &&
  typeof (element as FocusOwner).focus === "function" &&
  textFieldFocused(element as FocusedElement) &&
  !inRenameField(element as FocusedElement);

export class FocusReturn {
  private last: FocusOwner | null = null;

  /** The window's focusin: a text field that took the focus is the owner to go back to from now on. */
  noted(target: unknown): void {
    if (isOwner(target)) this.last = target;
  }

  /** The owner now, as a rename field opens: the text field focused, else the last one noted (null: none still there). */
  owner(active: unknown): FocusOwner | null {
    if (isOwner(active)) return active;
    return this.last !== null && this.last.isConnected !== false ? this.last : null;
  }

  /** After Return or Esc: the focus back on `owner` when it is still in the window. */
  restore(owner: FocusOwner | null): void {
    if (owner !== null && owner.isConnected !== false) owner.focus();
  }

  /** Tests: nothing noted. */
  reset(): void {
    this.last = null;
  }
}

export const focusReturn = new FocusReturn();
