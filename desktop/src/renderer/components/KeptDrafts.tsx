// Kept drafts above the box. A draft whose pane was
// gone when its machine answered is never dropped: the box of any pane on that machine lists it, the
// oldest first, with Put in box (into this box, while it is empty), Copy and
// Discard. A plain function of what it is given (the Composer subscribes).

import { compactKeptReason, compactUnsureReason, type KeptDraft } from "../../shared/drafts";

export interface KeptDraftsRowProps {
  readonly items: readonly KeptDraft[];
  readonly boxEmpty: boolean;
  onPut(item: KeptDraft): void;
  onCopy(item: KeptDraft): void;
  onDiscard(item: KeptDraft): void;
}

/**
 * "A draft for claude (pane w7:p9) whose pane is gone". A typed Compact that did
 * not go: "A Compact for claude (pane w7:p9) that was not sent". One whose
 * Return may have reached the agent: "A Compact for claude (pane w7:p9) that may have gone: check the agent before
 * sending it again".
 */
export function keptLabel(item: KeptDraft): string {
  if (item.reason === compactKeptReason) return `A Compact for ${item.agentName ?? "an agent"} (pane ${item.paneId}) that was not sent`;
  if (item.reason === compactUnsureReason) {
    return `A Compact for ${item.agentName ?? "an agent"} (pane ${item.paneId}) that may have gone: check the agent before sending it again`;
  }
  return `A draft for ${item.agentName ?? "an agent"} (pane ${item.paneId}) whose pane is gone`;
}

const preview = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `“${line.slice(0, 60)}…”` : `“${line}”`;
};

export function KeptDraftsRow({ items, boxEmpty, onPut, onCopy, onDiscard }: KeptDraftsRowProps) {
  const item = items[0];
  if (item === undefined) return null;
  const more = items.length > 1 ? ` · ${items.length - 1} more` : "";
  return (
    <div className="kept-row" role="status">
      <span className="kt" title={item.text}>
        {keptLabel(item)}
        {more}
      </span>
      <span className="kp">{preview(item.text)}</span>
      <button
        className={boxEmpty ? "btn sm" : "btn sm off"}
        aria-disabled={!boxEmpty}
        title={boxEmpty ? "Puts its text in this box" : "Empty the box first"}
        onClick={() => {
          if (boxEmpty) onPut(item);
        }}
      >
        Put in box
      </button>
      <button className="btn sm" onClick={() => onCopy(item)}>
        Copy
      </button>
      <button className="btn sm" onClick={() => onDiscard(item)}>
        Discard
      </button>
    </div>
  );
}
