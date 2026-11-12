// Closing a tile whose agent is working: asked
// once, here; Return closes it, Escape or Cancel keeps it. A shell or an
// agent not working closes at once; a terminal drawer's shell with a command
// running asks here too, with its own line.

import { useEffect, useRef } from "react";
import { useEscapeOwner } from "../components/escape-owners";

export interface ConfirmCloseProps {
  /** The pane as the sidebar names it. */
  readonly name: string;
  /** Why it asks (default: its agent is working). */
  readonly body?: string;
  onConfirm(): void;
  onCancel(): void;
}

export const agentWorkingBody = "Its agent is working. Closing the pane in Herdr ends it.";
/** A drawer shell, asked about before every close (Herdr gives no idle state for a shell). */
export const commandRunningBody = "A command may be running in it. Closing the pane in Herdr ends it.";

export function ConfirmClose({ name, body = agentWorkingBody, onConfirm, onCancel }: ConfirmCloseProps) {
  useEscapeOwner();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => button.current?.focus(), []);
  return (
    <>
      <div className="scrim" onClick={onCancel} />
      <div
        className="dlg confirm"
        role="alertdialog"
        aria-label={`Close ${name}?`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <div className="dt">Close {name}?</div>
        <div className="confirm-body">{body}</div>
        <div className="df">
          <span className="note" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn pri" ref={button} onClick={onConfirm}>
            Close pane
          </button>
        </div>
      </div>
    </>
  );
}
