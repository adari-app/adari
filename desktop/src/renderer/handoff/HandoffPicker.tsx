// The Send to… picker (App/CompanionHandoffPicker.swift) as the desktop's
// popover: what is sent, a filter field (focused; name, kind, folder,
// workspace), every pane of every machine by machine and workspace with the
// recent targets on top and agents first, the sidebar's glyphs and states; the
// pane the text comes from left out, a machine not answering shown and not
// pickable. ↑ ↓ move, Return opens the highlighted pane with the text in its
// box, ⌘Return sends it now, Escape or ⌘. closes; a click opens a row. Over
// 64 KB it says so and offers Copy. Follows the machines while open.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  HandoffPicker as PickerState,
  firstLine,
  isPickable,
  payloadSummary,
  statusWord,
  targetId,
  targetLabel,
  tooLongText,
  type HandoffAction,
  type HandoffRecent,
  type HandoffTarget,
} from "../../shared/handoff";
import { Glyph } from "../components/Sidebar";
import { SendIcon } from "../icons";
import type { HandoffStore, PickerRequest } from "./handoff-state";
import { useEscapeOwner } from "../components/escape-owners";

export interface HandoffPickerProps {
  readonly request: PickerRequest;
  readonly store: HandoffStore;
  readonly recents: readonly HandoffRecent[];
  readonly mac: boolean;
  /** A pick, once: the picker closes and the pick is carried out. */
  onPick(target: HandoffTarget, action: HandoffAction): void;
  onCopy(text: string): void;
  onClose(): void;
}

function Row({
  target,
  highlighted,
  onHover,
  onClick,
}: {
  target: HandoffTarget;
  highlighted: boolean;
  onHover(): void;
  onClick(): void;
}) {
  const pickable = isPickable(target);
  return (
    <button
      className={`hp-row${highlighted ? " hl" : ""}${pickable ? "" : " off"}`}
      data-target={targetId(target)}
      role="option"
      aria-selected={highlighted}
      aria-disabled={!pickable}
      aria-label={targetLabel(target)}
      onMouseMove={onHover}
      onClick={onClick}
    >
      <Glyph glyph={target.glyph} />
      <span className="nm">{target.name}</span>
      {target.kind === target.name ? null : <span className="kd">{target.kind}</span>}
      <span className="sp" />
      <span className="st">{target.macState ?? statusWord(target.glyph)}</span>
    </button>
  );
}

export function HandoffPickerView({ request, store, recents, mac, onPick, onCopy, onClose }: HandoffPickerProps) {
  useEscapeOwner();
  const current = useMemo<HandoffRecent>(
    () => ({ hostId: request.payload.source.hostId, paneId: request.payload.source.paneId }),
    [request],
  );
  const picker = useMemo(
    () => new PickerState(request.payload, () => store.macs(), recents, current, onPick, onCopy),
    // One picker per request; its pick and copy go through the props of the time it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [request.id],
  );
  const [, setVersion] = useState(0);
  const redraw = (): void => setVersion((n) => n + 1);
  // The machines change while open: the rows follow (a machine going offline greys its rows, a closed pane goes).
  const hosts = useSyncExternalStore(store.subscribe, () => store.hosts());
  useEffect(() => {
    picker.refresh();
    redraw();
  }, [picker, hosts]);

  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: request.x, top: request.y });
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || typeof window.innerWidth !== "number") return;
    const { width, height } = element.getBoundingClientRect();
    setPlace({
      left: Math.max(8, Math.min(request.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(request.y, window.innerHeight - height - 8)),
    });
  }, [request]);

  // A click elsewhere, the window losing focus: closed, nothing picked.
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // The highlighted row in view as ↑ ↓ move it.
  useEffect(() => {
    if (picker.highlighted === null || typeof document.querySelector !== "function") return;
    const row = document.querySelector(`.hp [data-target="${CSS.escape(picker.highlighted)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  });

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const mod = mac ? event.metaKey : event.ctrlKey;
    if (event.key === "Escape" || (mod && event.key === ".")) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      picker.move(event.key === "ArrowDown" ? 1 : -1);
      redraw();
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      picker.perform(mod ? "sendNow" : "draft");
      redraw();
    }
  };

  const payload = request.payload;
  const preview = firstLine(payload.text);
  const sendKey = mac ? "⌘↩" : "Ctrl+↩";
  const rows = picker.rows;
  const group = (target: HandoffTarget) => (
    <Row
      key={targetId(target)}
      target={target}
      highlighted={picker.highlighted === targetId(target)}
      onHover={() => {
        picker.hover(target);
        redraw();
      }}
      onClick={() => {
        picker.click(target);
        redraw();
      }}
    />
  );

  return (
    <div
      className="hp"
      ref={box}
      style={{ left: place.left, top: place.top }}
      role="dialog"
      aria-label="Send to…"
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="hp-h">
        <div className="hp-t">
          <SendIcon size={13} />
          Send to…
        </div>
        <div className="hp-what">{payloadSummary(payload)}</div>
        {preview === "" ? null : <div className="hp-pv">{preview}</div>}
        {picker.fits ? (
          <input
            className="hp-f"
            autoFocus
            placeholder="Filter by name, kind or folder"
            value={picker.query}
            aria-label="Filter"
            onChange={(event) => {
              picker.setQuery(event.target.value);
              redraw();
            }}
          />
        ) : null}
      </div>
      {picker.fits ? (
        <>
          <div className="hp-list" role="listbox" aria-label="Panes">
            {rows.length === 0 ? <div className="hp-empty">No pane to send to.</div> : null}
            {picker.list.recent.length > 0 ? (
              <>
                <div className="hp-g">Recent</div>
                {picker.list.recent.map(group)}
              </>
            ) : null}
            {picker.list.groups.map((section) => (
              <div key={`${section.hostId}|${section.workspaceId}`}>
                <div className="hp-g">
                  {section.macName} · {section.workspace}
                  {section.macState === null ? null : <span className="hp-off"> · {section.macState}</span>}
                </div>
                {section.targets.map(group)}
              </div>
            ))}
          </div>
          <div className="hp-foot">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>↩</kbd> open with draft
            </span>
            <span>
              <kbd>{sendKey}</kbd> send now
            </span>
            <span>
              <kbd>esc</kbd> close
            </span>
          </div>
        </>
      ) : (
        <div className="hp-long">
          <div>{tooLongText(picker.bytes)}</div>
          <button
            className="btn sm"
            autoFocus
            onClick={() => {
              picker.copy();
              redraw();
            }}
          >
            {picker.copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The hand-off toast: "Sent to codex in aurora-web", with Open. */
export function HandoffToastView({
  text,
  onOpen,
  onClose,
}: {
  text: string;
  onOpen: (() => void) | null;
  onClose(): void;
}) {
  return (
    <div className="hp-toast" role="status">
      <SendIcon size={13} />
      <span className="tx">{text}</span>
      {onOpen === null ? null : (
        <button className="op" onClick={onOpen}>
          Open
        </button>
      )}
      <button className="x" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
