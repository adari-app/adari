// A tab's split panes: up to four tiles laid out as Herdr
// has them (src/shared/pane-layout.ts), each a full pane view: a slim header
// (its number for ⌘1–⌘4, the agent's glyph and name, the Chat/Terminal
// switch, zoom, the split menu, close), then Chat with its own compact message
// box or the pane's live terminal (or, on an agent's tile, its
// Changes; one tile of the tab at a time, as a window has one Changes read). The focused tile has the ring and takes the
// keys; clicking a tile focuses it (here only: pane.focus is not sent). A
// divider dragged moves the tiles at once and asks Herdr, on release, to set
// that split's ratio (layout.set_split_ratio); Herdr's answer redraws it.
//
// An agent tile's switch names its middle
// view by the agent ("Claude Code", "Codex"…, its own screen); a shell tile
// has no switch. The terminal drawer belongs to the focused tile only: under
// the tiles, the focused agent pane's own drawer (each pane keeps its own
// shells, height and open state, as the one pane view does); an agent tile's
// header button opens or hides its drawer, focusing the tile.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { agentSessionKey } from "../../shared/changes/content";
import { shownTab } from "../../shared/changes/tabs";
import type { HostView, MainTab } from "../../shared/ipc-contract";
import { arrangementOf, type Divider, type Frame, type PaneLayout } from "../../shared/pane-layout";
import { paneBindingOf, splitPathOf, splitShapeOf, type PaneBinding, type SplitPath, type SplitShape } from "../../shared/pane-binding";
import type { SidebarRow } from "../../shared/sidebar-model";
import { ChangesView } from "../changes/ChangesView";
import { ChatView } from "../chat/ChatView";
import { Composer, ResumeChip, TerminalTab, fillResume } from "../components/MainPane";
import { agentOwnName, agentScreenTitle, ChatEarlyBadge } from "../components/agent-kind";
import { TerminalDrawer, type DrawerView } from "../terminal/TerminalDrawer";
import { composerDrafts, draftKey } from "../components/composer-drafts";
import { useResumeOffer } from "../components/resume";
import { Glyph } from "../components/Sidebar";
import { ChangesIcon, ChatIcon, CloseIcon, SplitIcon, TerminalDrawerIcon, TerminalIcon, ZoomIcon } from "../icons";

/** One tile: its pane, where it sits, the pane's row (null while the sidebar has none yet) and its view. */
export interface TileEntry {
  readonly paneId: string;
  /** Herdr's order (0 for ⌘1). */
  readonly index: number;
  readonly frame: Frame;
  readonly row: SidebarRow | null;
  readonly view: MainTab;
  /** Its pane's terminal drawer is open (its header button shows it pressed). */
  readonly drawerOpen?: boolean;
  /** A shell of its drawer needs you (a dot on its drawer button; the sidebar leaves drawer shells out). */
  readonly drawerNeedsYou?: boolean;
}

/**
 * A divider drag and what it was started on: the
 * machine, the tab's layout as shown then, and the divider. Its moves and its
 * release are about that view, whatever is selected by then.
 */
export interface DividerDrag {
  readonly hostId: string;
  readonly layout: PaneLayout;
  readonly divider: Divider;
  /** The divider's first pane as shown when it began, and the split's place in Herdr's tree; null when not to be had. */
  readonly binding: PaneBinding | null;
  readonly path: SplitPath | null;
  /** The whole split as shown when it began: its direction and both sides' panes in order; null when not to be had. */
  readonly shape: SplitShape | null;
}

export interface SplitViewProps {
  readonly host: HostView;
  /** The tab's layout the tiles come from (a drag captures it). */
  readonly layout: PaneLayout;
  /** The tab, as the header names it ("workers 1 · app"). */
  readonly title: string;
  readonly tiles: readonly TileEntry[];
  readonly dividers: readonly Divider[];
  readonly focusedPaneId: string;
  /** A change gives the focused tile the keys (⌘1–⌘4, ⌃⌘ arrows, a click off its field). */
  readonly focusSignal: number;
  readonly mac: boolean;
  readonly fontSize: number;
  /** The message box over the focused tile's terminal (⇧⌘T). */
  readonly boxShown: boolean;
  onBoxShown(shown: boolean): void;
  /** Focus the tile; `keys`: give it the keyboard too. */
  onFocus(paneId: string, keys: boolean): void;
  onView(paneId: string, view: MainTab): void;
  /** Herdr zooms the pane over its tab. */
  onZoom(paneId: string): void;
  /** Close the pane (the App asks first for a working agent). */
  onClose(paneId: string): void;
  /** The tile's split menu, at the button. */
  onSplitMenu(paneId: string, x: number, y: number): void;
  /** A divider being dragged: where its line is now (a fraction of its split). */
  onResizing(drag: DividerDrag, at: number): void;
  /** A divider let go: the drag as it began, and where it was let go. */
  onResize(drag: DividerDrag, at: number): void;
  /** The drag ended without a release (unmounted, another tab or machine, pointercancel, the window hidden). */
  onResizeCancel(drag: DividerDrag): void;
  /** The focused tile's terminal drawer (null: a shell tile, or none). */
  readonly drawer?: DrawerView | null;
  /** An agent tile's drawer button: focus the tile, open or hide its drawer. */
  onToggleDrawer?(paneId: string): void;
}

/** The menu's place under a header button. */
function under(event: MouseEvent): { x: number; y: number } {
  const box = (event.currentTarget as { getBoundingClientRect?: () => { left: number; bottom: number } } | null)?.getBoundingClientRect?.();
  return box === undefined ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom + 4 };
}

const percent = (value: number): string => `${(value * 100).toFixed(4)}%`;

function place(frame: Frame): CSSProperties {
  return { left: percent(frame.left), top: percent(frame.top), width: percent(frame.width), height: percent(frame.height) };
}

/** Where a divider's line sits in the tiles' area. */
function dividerPlace(divider: Divider): CSSProperties {
  const { frame, at } = divider;
  return divider.direction === "right"
    ? { left: percent(frame.left + frame.width * at), top: percent(frame.top), height: percent(frame.height) }
    : { top: percent(frame.top + frame.height * at), left: percent(frame.left), width: percent(frame.width) };
}

/** A click that should hand the tile the keys: not in a field, the terminal, a button, or ending a text selection. */
function wantsKeys(event: MouseEvent): boolean {
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  if (target?.closest?.("textarea, input, button, .term-host") != null) return false;
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  return selection === null || selection.isCollapsed;
}

export interface TileProps {
  readonly host: HostView;
  readonly entry: TileEntry & { readonly row: SidebarRow };
  readonly focused: boolean;
  readonly focusSignal: number;
  readonly fontSize: number;
  readonly boxShown: boolean;
  onBoxShown(shown: boolean): void;
  onFocus(paneId: string, keys: boolean): void;
  onView(paneId: string, view: MainTab): void;
  onZoom(paneId: string): void;
  onClose(paneId: string): void;
  onSplitMenu(paneId: string, x: number, y: number): void;
  onToggleDrawer?(paneId: string): void;
}

/** One pane in a tile: header, then Chat over its compact box, or the terminal. */
export function Tile({ host, entry, focused, focusSignal, fontSize, boxShown, onBoxShown, onFocus, onView, onZoom, onClose, onSplitMenu, onToggleDrawer }: TileProps) {
  const { paneId, row, index } = entry;
  // Changes is an agent tile's third view; a plain shell shows its terminal.
  const view = shownTab(entry.view, row.isAgent);
  const offer = useResumeOffer(host, row);
  const keys = focused ? focusSignal : 0;
  const box = focused && boxShown && view === "terminal";
  return (
    <section
      className={focused ? "tile focused" : "tile"}
      style={place(entry.frame)}
      data-tile={paneId}
      onMouseDownCapture={() => {
        if (!focused) onFocus(paneId, false);
      }}
      onClick={(event) => {
        if (wantsKeys(event)) onFocus(paneId, true);
      }}
    >
      <div className="tile-in">
        <div className="tile-h" title={row.cwd ?? row.name}>
          <span className="tn">{index + 1}</span>
          <Glyph glyph={row.glyph} />
          <span className="nm">{row.name}</span>
          <span className="kd">{row.kind}</span>
          {/* A split tile's header has no Chat word; the Early badge sits beside its agent's kind. */}
          {row.isAgent ? <ChatEarlyBadge kind={row.kind} /> : null}
          <span className="sp" />
          {/* Chat · <the agent's own name> · Changes as icons; a shell tile has no switch. */}
          {row.isAgent ? (
            <div className="seg xs">
              <button className={view === "chat" ? "on" : ""} aria-label="Chat" aria-pressed={view === "chat"} title="Chat" onClick={() => onView(paneId, "chat")}>
                <ChatIcon size={13} />
              </button>
              <button
                className={view === "terminal" ? "on" : ""}
                aria-label={agentOwnName(row.kind)}
                aria-pressed={view === "terminal"}
                title={agentScreenTitle(row.kind)}
                onClick={() => onView(paneId, "terminal")}
              >
                <TerminalIcon size={13} />
              </button>
              <button
                className={view === "changes" ? "on" : ""}
                aria-label="Changes"
                aria-pressed={view === "changes"}
                title="Changes"
                onClick={() => onView(paneId, "changes")}
              >
                <ChangesIcon size={13} />
              </button>
            </div>
          ) : null}
          {row.isAgent && onToggleDrawer !== undefined ? (
            <button
              className={entry.drawerOpen === true ? "ib xs on tdr-btn" : "ib xs tdr-btn"}
              title={`${entry.drawerOpen === true ? "Hide the terminal" : "Terminal: a shell in this agent's folder"}${entry.drawerNeedsYou === true ? " · a shell needs you" : ""}`}
              aria-label={`Terminal drawer for ${row.name}`}
              aria-pressed={entry.drawerOpen === true}
              data-drawer-toggle=""
              onClick={() => onToggleDrawer(paneId)}
            >
              <TerminalDrawerIcon size={14} />
              {entry.drawerNeedsYou === true ? <span className="tdr-ny" aria-hidden="true" /> : null}
            </button>
          ) : null}
          <button className="ib xs" title="Zoom (Herdr shows this pane over its tab)" aria-label={`Zoom ${row.name}`} onClick={() => onZoom(paneId)}>
            <ZoomIcon size={14} />
          </button>
          <button
            className="ib xs"
            title="Split"
            aria-label={`Split ${row.name}`}
            onClick={(event) => {
              const at = under(event);
              onSplitMenu(paneId, at.x, at.y);
            }}
          >
            <SplitIcon size={14} />
          </button>
          <button className="ib xs" title="Close this pane" aria-label={`Close ${row.name}`} onClick={() => onClose(paneId)}>
            <CloseIcon size={14} />
          </button>
        </div>
        {view === "changes" ? (
          <ChangesView
            bridge={window.herdrDesktop}
            hostId={host.id}
            paneId={paneId}
            kind={row.kind}
            folder={row.cwd ?? null}
            working={row.status === "working"}
            online={host.state !== "offline"}
            session={agentSessionKey(host.topology, paneId)}
          />
        ) : view === "terminal" ? (
          <div className="term-area">
            <TerminalTab key={`${host.id}/${paneId}`} host={host} row={row} fontSize={fontSize} focusSignal={keys} autoFocus={focused} />
            {box ? <Composer host={host} row={row} overlay compact takesKeys focusSignal={keys} onDismiss={() => onBoxShown(false)} /> : null}
            {!box && offer !== null ? (
              <ResumeChip
                offer={offer}
                boxEmpty={composerDrafts.get(draftKey(host.id, paneId)).text === ""}
                floating
                onFill={() => {
                  fillResume(host.id, paneId, offer);
                  onFocus(paneId, false);
                  onBoxShown(true);
                }}
              />
            ) : null}
          </div>
        ) : (
          <>
            <ChatView key={`${host.id}/${paneId}`} host={host} row={row} tile keysActive={focused} onShowTerminal={() => onView(paneId, "terminal")} />
            <Composer host={host} row={row} compact stops takesKeys={focused} focusSignal={keys} onShowTerminal={() => onView(paneId, "terminal")} />
          </>
        )}
      </div>
    </section>
  );
}

/** A pane Herdr's layout has that the sidebar does not list yet (a split just made). */
function WaitingTile({ entry, focused, onFocus }: { entry: TileEntry; focused: boolean; onFocus(paneId: string, keys: boolean): void }) {
  return (
    <section className={focused ? "tile focused" : "tile"} style={place(entry.frame)} data-tile={entry.paneId} onMouseDownCapture={() => onFocus(entry.paneId, false)}>
      <div className="tile-in">
        <div className="tile-h">
          <span className="tn">{entry.index + 1}</span>
          <span className="nm">{entry.paneId}</span>
        </div>
        <div className="tile-wait">Waiting for Herdr to list this pane…</div>
      </div>
    </section>
  );
}

/** A side keeps at least this much of its split (and two cells). */
const minSide = 0.08;

export function SplitView(props: SplitViewProps) {
  const { host, layout, title, tiles, dividers, focusedPaneId, focusSignal, fontSize, boxShown, onBoxShown, onFocus, onView } = props;
  const area = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  // The one drag in progress, and how to end it without a release.
  const dragging = useRef<{ readonly cancel: () => void } | null>(null);
  // Dragging a divider: the tiles follow the pointer; the split's new ratio goes to Herdr once, on release.
  // The drag belongs to the machine and tab it began on: it ends, sending nothing, when this view
  // goes, shows another tab or machine, the pointer is cancelled, or the window is hidden or loses focus.
  const startDrag = (event: ReactPointerEvent, divider: Divider): void => {
    const box = area.current?.getBoundingClientRect();
    if (box === undefined || event.button !== 0) return;
    event.preventDefault();
    dragging.current?.cancel();
    const drag: DividerDrag = {
      hostId: host.id,
      layout,
      divider,
      binding: paneBindingOf(host, layout, divider.firstPaneId),
      path: splitPathOf(layout, divider.splitId),
      shape: splitShapeOf(layout, divider.splitId),
    };
    const across = divider.direction === "right";
    const origin = across ? box.left + divider.frame.left * box.width : box.top + divider.frame.top * box.height;
    const length = across ? divider.frame.width * box.width : divider.frame.height * box.height;
    const least = Math.max(minSide, 2 / Math.max(1, divider.extent));
    const at = (pointer: { clientX: number; clientY: number }): number =>
      Math.min(1 - least, Math.max(least, ((across ? pointer.clientX : pointer.clientY) - origin) / Math.max(1, length)));
    const finish = (): boolean => {
      if (dragging.current !== owner) return false;
      dragging.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("visibilitychange", hidden);
      document.body.classList.remove("resizing", `resizing-${divider.direction}`);
      return true;
    };
    const move = (pointer: PointerEvent): void => {
      if (dragging.current === owner) latest.current.onResizing(drag, at(pointer));
    };
    const up = (pointer: PointerEvent): void => {
      if (finish()) latest.current.onResize(drag, at(pointer));
    };
    const cancel = (): void => {
      if (finish()) latest.current.onResizeCancel(drag);
    };
    // visibilitychange is fired at the document and bubbles to the window.
    const hidden = (): void => {
      if (document.visibilityState === "hidden") cancel();
    };
    const owner = { cancel };
    dragging.current = owner;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("visibilitychange", hidden);
    document.body.classList.add("resizing", `resizing-${divider.direction}`);
  };
  // Another machine or tab in this view, the tab arranged otherwise (a pane on another side of a
  // split, the panes' order kept or not; ratios aside), or the view gone: a drag in progress ends with nothing sent.
  const arrangement = useMemo(() => arrangementOf(layout), [layout]);
  useEffect(() => () => dragging.current?.cancel(), [host.id, layout.tabId, arrangement]);
  // Hiding the box gives the focused tile's terminal the keyboard back (as MainPane does).
  const [boxSignal, setBoxSignal] = useState(0);
  const wasShown = useRef(boxShown);
  useEffect(() => {
    if (wasShown.current && !boxShown) setBoxSignal((n) => n + 1);
    wasShown.current = boxShown;
  }, [boxShown]);
  const signal = focusSignal + boxSignal;
  // The focused tile's drawer, named by its tile ("1 · claude").
  const focusedEntry = tiles.find((entry) => entry.paneId === focusedPaneId);
  const drawer = focusedEntry?.row?.isAgent === true ? (props.drawer ?? null) : null;
  const focusedOwner = focusedEntry?.row == null ? undefined : `${String(focusedEntry.index + 1)} · ${focusedEntry.row.name}`;
  return (
    <main className="main split">
      <div className="mh split-h">
        <span className="who">
          <span className="nm">{title}</span>
          <span className="wsn">{tiles.length} panes</span>
        </span>
        <span className="sp" />
      </div>
      <div className="tiles" ref={area}>
        {tiles.map((entry) =>
          entry.row === null ? (
            <WaitingTile key={entry.paneId} entry={entry} focused={entry.paneId === focusedPaneId} onFocus={onFocus} />
          ) : (
            <Tile
              key={entry.paneId}
              host={host}
              entry={{ ...entry, row: entry.row }}
              focused={entry.paneId === focusedPaneId}
              focusSignal={signal}
              fontSize={fontSize}
              boxShown={boxShown}
              onBoxShown={onBoxShown}
              onFocus={onFocus}
              onView={onView}
              onZoom={props.onZoom}
              onClose={props.onClose}
              onSplitMenu={props.onSplitMenu}
              {...(props.onToggleDrawer === undefined ? {} : { onToggleDrawer: props.onToggleDrawer })}
            />
          ),
        )}
        {dividers.map((divider) => (
          <div
            key={divider.splitId}
            className={`divider ${divider.direction}`}
            style={dividerPlace(divider)}
            role="separator"
            aria-orientation={divider.direction === "right" ? "vertical" : "horizontal"}
            onPointerDown={(event) => startDrag(event, divider)}
          />
        ))}
      </div>
      {drawer === null || !drawer.state.open ? null : (
        <TerminalDrawer host={host} drawer={drawer} fontSize={fontSize} mac={props.mac} owner={focusedOwner} />
      )}
    </main>
  );
}
