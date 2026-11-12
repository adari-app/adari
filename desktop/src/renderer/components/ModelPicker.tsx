// The model picker, one component for
// the Model chip and New agent (T3 Code's ModelPickerContent as the model of
// its behaviour and look): a search box focused on open, "Agent's default"
// first, the starred models under Favourites, then the list under its group
// headers; typing ranks matches on the id and the label (model-search.ts).
// The current model is ticked. Arrows move, Enter picks, Esc closes; a click
// outside, or the focus going elsewhere (a dialog opening), closes. It opens on the
// side with room (below a field that is low in the window, it opens above). Only
// the rows in view are drawn (fixed row heights), so a list of 400 stays smooth.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { catalogAgentNames, type CatalogAgent, type CatalogModel, type CatalogView } from "../../shared/model-catalog";
import { firstHighlight, headerHeight, nextPickable, pickerRows, rowHeight, rowOffsets, visibleRange, type PickerRow } from "../../shared/model-search";
import { CheckIcon, SearchIcon, StarIcon } from "../icons";
import { useEscapeOwner } from "./escape-owners";

export interface ModelPickerProps {
  readonly agent: CatalogAgent;
  /** The machine's list as the page holds it (null: no answer yet). */
  readonly view: CatalogView | null;
  /** The rows' models (the list joined with what the pane runs). */
  readonly models: readonly CatalogModel[];
  /** The model ticked (null: none, or the agent's default when its row is ticked). */
  readonly current: string | null;
  /** "Agent's default": ticked or not, the model it is now beside it, greyed with why; null: no such row. */
  readonly defaultRow: { readonly ticked: boolean; readonly note: string | null; readonly disabledReason?: string } | null;
  readonly favourites: ReadonlySet<string>;
  onToggleFavourite(id: string): void;
  /** The models are shown but cannot be picked here: why. */
  readonly readOnly?: string | null;
  /**
   * One quiet line over a list whose rows pick (Grok's: it makes the pick its default for new sessions;
   * Claude Code's), drawn as pickerNotes' quiet line under This Mac's line.
   */
  readonly note?: string | null;
  /** Why the pane's last model pick was not sent or set (AgentPicks.modelNotSent), or null. */
  readonly notice?: string | null;
  /** Rows without the id at their right (Cursor's families on a running pane: Cursor's own names). */
  readonly hideIds?: boolean;
  /** One row at the bottom ("Choose in the Terminal…"). */
  readonly action?: { readonly label: string; run(): void } | null;
  /** A model (its id), or the agent's default (null). */
  onPick(id: string | null): void;
  onClose(): void;
  /** Above the chip (the box's row) or below the field (New agent). */
  readonly placement?: "above" | "below";
}

/** The list's height at most (px); a shorter list is as tall as its rows. */
export const pickerViewHeight = 320;

const disabledOf = (row: PickerRow, props: Pick<ModelPickerProps, "readOnly" | "defaultRow">): string | null => {
  if (row.kind === "header") return null;
  if (row.kind === "default") return props.defaultRow?.disabledReason ?? props.readOnly ?? null;
  return props.readOnly ?? null;
};

/** The line over the list: Antigravity's none, a failed read, a read under way, nothing that matches. */
export function pickerLine(agent: CatalogAgent, view: CatalogView | null, rows: readonly PickerRow[], query: string, readOnly: string | null, note: string | null = null): string | null {
  if (view?.none !== null && view?.none !== undefined) return view.none;
  if (view?.error !== null && view?.error !== undefined) return view.error;
  const hasModels = rows.some((row) => row.kind === "model");
  if ((view === null || view.loading) && !hasModels) return `Reading ${catalogAgentNames[agent]}'s models\u{2026}`;
  if (query.trim() !== "" && !hasModels) return `No model matches \u{201C}${query.trim()}\u{201D}.`;
  return readOnly ?? note;
}

/**
 * The quiet lines under that line: This Mac's list shown for another Mac, what a pick does.
 */
export function pickerNotes(view: CatalogView | null, note: string | null): string[] {
  const notes: string[] = [];
  if (view?.borrowed !== null && view?.borrowed !== undefined) notes.push(view.borrowed);
  if (note !== null) notes.push(note);
  return notes;
}

export function ModelPicker(props: ModelPickerProps) {
  const { agent, view, models, current, defaultRow, favourites, readOnly = null, note = null, notice = null, hideIds = false, action = null, placement = "above" } = props;
  useEscapeOwner();
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const rows = useMemo(
    () => pickerRows({ models, query, favourites, current, defaultRow: defaultRow === null ? null : { label: "Agent's default", note: defaultRow.note, ticked: defaultRow.ticked } }),
    [models, query, favourites, current, defaultRow],
  );
  const { tops, height } = useMemo(() => rowOffsets(rows), [rows]);
  const [highlight, setHighlight] = useState(() => firstHighlight(rows, ""));
  // The side it opens on, and the list's height cut to the room there when even that side is short.
  const [side, setSide] = useState<"above" | "below">(placement);
  const [roomHeight, setRoomHeight] = useState<number | null>(null);
  const viewHeight = Math.min(height, pickerViewHeight, roomHeight ?? pickerViewHeight);
  const range = visibleRange(tops, height, scrollTop, viewHeight);
  const line = pickerLine(agent, view, rows, query, readOnly);
  const notes = pickerNotes(view, note);
  const onClose = props.onClose;

  // A new search starts at its best match; the list's top with it.
  useEffect(() => {
    setHighlight(firstHighlight(rows, query));
    // Only when the search changes, not on each new list (a refresh keeps your place).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Before it is drawn, on open and when the list grows (it may come after the open): the side with room for it
  // (the one asked for when it fits), measured at the list's full height.
  useLayoutEffect(() => {
    const node = ref.current;
    const anchor = node?.parentElement ?? null;
    if (node === null || anchor === null || typeof window.innerHeight !== "number") return;
    const at = anchor.getBoundingClientRect();
    const listNow = listRef.current?.getBoundingClientRect().height ?? 0;
    const tall = node.getBoundingClientRect().height - listNow + Math.min(height, pickerViewHeight);
    const roomBelow = window.innerHeight - at.bottom - 12;
    const roomAbove = at.top - 12;
    const fits = (where: "above" | "below"): boolean => tall <= (where === "below" ? roomBelow : roomAbove);
    const other = placement === "below" ? "above" : "below";
    const chosen = fits(placement) || (!fits(other) && (placement === "below" ? roomBelow >= roomAbove : roomAbove >= roomBelow)) ? placement : other;
    setSide(chosen);
    const room = chosen === "below" ? roomBelow : roomAbove;
    setRoomHeight(tall > room ? Math.max(4 * rowHeight, pickerViewHeight - (tall - room)) : null);
    // Only the list's height and the lines over it change its height.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, line === null, notes.length, notice === null]);

  // On open: the search focused, the ticked row in view.
  useEffect(() => {
    inputRef.current?.focus();
    const list = listRef.current;
    const at = firstHighlight(rows, "");
    if (list !== null && at >= 0) {
      const top = tops[at] ?? 0;
      const shown = Math.min(pickerViewHeight, roomHeight ?? pickerViewHeight);
      if (top + rowHeight > shown) {
        list.scrollTop = Math.max(0, top - shown / 2);
        setScrollTop(list.scrollTop);
      }
    }
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window.addEventListener !== "function") return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (ref.current !== null && target !== null && !ref.current.parentElement?.contains(target)) onClose();
    };
    const close = (): void => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const choose = (index: number): void => {
    const row = rows[index];
    if (row === undefined || row.kind === "header" || disabledOf(row, props) !== null) return;
    onClose();
    props.onPick(row.kind === "default" ? null : row.model.id);
  };

  /** The highlighted row moved by a key: kept in view. */
  const moveTo = (index: number): void => {
    setHighlight(index);
    const list = listRef.current;
    if (list === null || index < 0) return;
    const top = tops[index] ?? 0;
    const bottom = top + (rows[index]?.kind === "header" ? headerHeight : rowHeight);
    // The header above the first row stays in view with it.
    const want = index > 0 && rows[index - 1]?.kind === "header" ? (tops[index - 1] ?? top) : top;
    if (want < list.scrollTop) list.scrollTop = want;
    else if (bottom > list.scrollTop + viewHeight) list.scrollTop = bottom - viewHeight;
    setScrollTop(list.scrollTop);
  };

  const onKeyDown = (event: { key: string; preventDefault(): void; stopPropagation(): void }): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveTo(nextPickable(rows, highlight, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      choose(highlight);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const drawn = rows.slice(range.start, range.end);
  return (
    <div
      className={`ctx model-picker ${side}`}
      ref={ref}
      role="dialog"
      aria-label={`${catalogAgentNames[agent]}'s models`}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // The focus gone to something outside it and its field or chip (a dialog opening, Tab to the next field).
        const next = event.relatedTarget as Node | null;
        const around = ref.current?.parentElement ?? null;
        if (next !== null && around !== null && !around.contains(next)) onClose();
      }}
    >
      <div className="mp-search">
        <SearchIcon size={14} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Search models"
          aria-label="Search models"
          aria-controls="model-picker-list"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setScrollTop(0);
            if (listRef.current !== null) listRef.current.scrollTop = 0;
          }}
        />
      </div>
      {notice === null ? null : (
        <div className="mp-line notsent" role="status">
          {notice}
        </div>
      )}
      {line === null ? null : <div className={view?.error !== null && view?.error !== undefined ? "mp-line err" : "mp-line"}>{line}</div>}
      {notes.map((text) => (
        <div key={text} className="mp-line note">
          {text}
        </div>
      ))}
      {rows.length === 0 ? null : (
        <div
          className="mp-list"
          id="model-picker-list"
          role="listbox"
          ref={listRef}
          style={{ height: viewHeight }}
          onScroll={(event) => setScrollTop((event.target as HTMLDivElement).scrollTop)}
        >
          <div className="mp-all" style={{ height }}>
            {drawn.map((row, offset) => {
              const index = range.start + offset;
              const top = tops[index] ?? 0;
              if (row.kind === "header") {
                return (
                  <div key={`h-${row.label}-${index}`} className="mp-h" role="presentation" style={{ top }}>
                    {row.label}
                  </div>
                );
              }
              const why = disabledOf(row, props);
              const ticked = row.ticked;
              const label = row.kind === "default" ? row.label : row.model.label;
              const aside = row.kind === "default" ? row.note : row.model.label === row.model.id || hideIds ? null : row.model.id;
              const title = why ?? (row.kind === "model" ? (row.model.note ?? row.model.id) : (row.note ?? "The agent starts with its own default model"));
              return (
                <div
                  key={row.kind === "default" ? "default" : `m-${row.model.id}`}
                  className={`mp-row${index === highlight ? " hl" : ""}${why === null ? "" : " off"}${row.kind === "default" ? " dflt" : ""}`}
                  role="option"
                  aria-selected={ticked}
                  aria-disabled={why !== null}
                  title={title}
                  style={{ top }}
                  onMouseMove={() => {
                    if (highlight !== index) setHighlight(index);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <span className="tk">{ticked ? <CheckIcon size={13} /> : null}</span>
                  <span className="l">{label}</span>
                  {aside === null ? null : <span className="id">{aside}</span>}
                  {row.kind === "model" ? (
                    <button
                      type="button"
                      className={row.favourite ? "star on" : "star"}
                      aria-label={row.favourite ? `Remove ${row.model.label} from favourites` : `Add ${row.model.label} to favourites`}
                      aria-pressed={row.favourite}
                      title={row.favourite ? "Remove from favourites" : "Add to favourites"}
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onToggleFavourite(row.model.id);
                      }}
                    >
                      <StarIcon size={13} filled={row.favourite} />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {action === null ? null : (
        <button
          type="button"
          className="mp-act"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClose();
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
