// "Update ready", a small mark on a pane whose Claude
// Code has a newer version installed (the main process reads its footer line:
// src/main/update-marks.ts). On the sidebar row it is an icon with the
// tooltip; in the header beside the agent's name a click shows the same words
// in a small card (it holds Esc while open, as the context ring's card does).
// Nothing is sent to the pane by the mark itself; the card's main
// button, "Restart on the new version", restarts the agent on your click only
// (greyed, with the reason, while it is not safe).
// A Codex pane's mark too ("Update available", its own words:
// src/shared/update-mark.ts agentUpdateWords); `kind` picks them.

import { useEffect, useRef, useState } from "react";

import { agentUpdateWords, updateWordsFor } from "../../shared/update-mark";
import { useEscapeOwner } from "./escape-owners";

/** Claude Code's mark; a pane of another kind has its own (updateWordsFor). */
export const updateMarkLabel = agentUpdateWords["claude"]!.label;
export const updateMarkWords = agentUpdateWords["claude"]!.words;

/** An arrow up out of a tray: an update waiting. */
function UpdateIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 16.2V8.2" />
      <path d="m8.6 11.4 3.4-3.4 3.4 3.4" />
    </svg>
  );
}

/** The card's Restart button: what a click does, or why it is greyed. */
export interface UpdateRestart {
  readonly label: string;
  /** Null: it may restart now. */
  readonly disabledReason: string | null;
  onRestart(): void;
}

/** The mark; `card`: the header's, a button whose click shows the words in a card (with `restart`, its main button); `kind`: the pane's agent. */
export function UpdateMark({ card = false, restart, kind }: { card?: boolean; restart?: UpdateRestart; kind?: string | null }) {
  const { label, words } = updateWordsFor(kind);
  const [open, setOpen] = useState(false);
  const held = card && open;
  useEscapeOwner(held);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!held || typeof window.addEventListener !== "function") return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (ref.current !== null && target !== null && !ref.current.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [held]);
  if (!card) {
    return (
      <span className="upd" role="img" aria-label={label} title={words}>
        <UpdateIcon size={13} />
      </span>
    );
  }
  return (
    <span className="upd-w" ref={ref}>
      <button
        className={open ? "upd on" : "upd"}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={words}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <UpdateIcon size={14} />
        <span className="upd-t">{label}</span>
      </button>
      {open ? (
        <span className="upd-card" role="dialog" aria-label={label}>
          <span className="upd-h">{label}</span>
          <span className="upd-b">{words}</span>
          {restart === undefined ? null : (
            <>
              <button
                className="upd-go"
                disabled={restart.disabledReason !== null}
                title={restart.disabledReason ?? restart.label}
                onClick={(event) => {
                  event.stopPropagation();
                  if (restart.disabledReason !== null) return;
                  setOpen(false);
                  restart.onRestart();
                }}
              >
                {restart.label}
              </button>
              {restart.disabledReason === null ? null : <span className="upd-why">{restart.disabledReason}</span>}
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}
