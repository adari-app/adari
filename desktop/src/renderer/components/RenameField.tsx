// The inline rename on a sidebar row or a workspace header: the name selected in a field
// drawn in the row's place, Return saves, Esc or a click away cancels. While
// it is open it owns Esc (escape-owners.ts: the Composer's Stop and the
// window's Esc look there first) and every key typed in it stays in it, so
// the terminal and the Composer get none; the window's shortcuts and the
// native menu's commands do nothing meanwhile (keyOwners).
// Return or Esc gives the focus back to the terminal or Composer it was on
// before (focus-return.ts); a click away does not.

import { useEffect, useRef, useState } from "react";

import { maxLabelLength } from "../../shared/pane-manage";
import { useEscapeOwner, useKeyOwner } from "./escape-owners";
import { focusReturn } from "./focus-return";

export interface RenameFieldProps {
  /** The name it opens with, selected. */
  readonly initial: string;
  /** What it renames, for the screen reader ("Rename shell"). */
  readonly label: string;
  /** The tip under it: what Return does in Herdr. */
  readonly hint?: string;
  /** "row" in a pane's row, "header" in a workspace's header. */
  readonly kind?: "row" | "header";
  onSave(text: string): void;
  onCancel(): void;
}

export function RenameField({ initial, label, hint, kind = "row", onSave, onCancel }: RenameFieldProps) {
  useEscapeOwner();
  // And every other key: the window's shortcuts and the native menu's commands wait until it closes.
  useKeyOwner();
  const [value, setValue] = useState(initial);
  // Where the keyboard was before the menu or this field took it (taken before the field focuses itself).
  const [back] = useState(() => focusReturn.owner(typeof document === "undefined" ? null : document.activeElement));
  const input = useRef<HTMLInputElement>(null);
  // Once saved or cancelled it does nothing more (the blur its own removal may bring included).
  const done = useRef(false);
  // From the keyboard (Return, Esc) the focus goes back; from a click away it stays where you clicked.
  const finish = (save: boolean, text: string, fromKeyboard: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(text);
    else onCancel();
    if (fromKeyboard) focusReturn.restore(back);
  };
  // Opened with the name selected, so typing replaces it.
  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    element.select();
  }, []);
  return (
    <div className={kind === "header" ? "rn rn-ws" : "rn"} data-rename={kind}>
      <input
        ref={input}
        className="rn-in"
        aria-label={label}
        value={value}
        maxLength={maxLabelLength}
        spellCheck={false}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Every key stays in the field: nothing under it (the sidebar, the terminal, the Composer) sees it.
          event.stopPropagation();
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            finish(true, value, true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(false, value, true);
          }
        }}
        onBlur={() => finish(false, value, false)}
      />
      <span className="rn-k" aria-hidden>
        ↩
      </span>
      {hint === undefined ? null : <span className="rn-tip">{hint}</span>}
    </div>
  );
}
