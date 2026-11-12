// The terminal drawer, T3 Code's terminal
// drawer under its chat: along the bottom of the open agent pane (the focused
// tile's in a split), under the pane's own view. A thin top border its edge
// (dragged, it sets the height; a double-click goes back to the default), a
// header with the shells as tabs on the left and New shell, Close shell and
// Hide on the right, then the shown shell's terminal: the same TerminalView and
// attach a pane's Terminal has (Ghostty's engine: keys, mouse, resize,
// scrollback, copy and paste, links) at the drawer's size. Each shell is a
// real Herdr shell pane in the workspace's folder (App.tsx makes it through
// main/herdr/drawer-shell.ts); what the drawer holds is kept per machine and
// pane (shared/terminal-drawer.ts).
//
// Escape in a shell goes to the shell. Escape with the focus in the drawer but
// not in a shell (its header, an empty drawer) gives the keyboard back to
// where it was before the drawer opened (onEscape), and is never a Stop.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { HostView } from "../../shared/ipc-contract";
import type { SidebarRow } from "../../shared/sidebar-model";
import { drawerHeight, drawerShellsCapacity, type DrawerState } from "../../shared/terminal-drawer";
import { TerminalTab, shortPath } from "../components/MainPane";
import { ChevronDownIcon, CloseIcon, PlusIcon, TerminalIcon } from "../icons";

/** One shell as the drawer shows it: its pane, its row (null until the machine's snapshot lists it) and its tab's name. */
export interface DrawerShellView {
  readonly paneId: string;
  readonly row: SidebarRow | null;
  /** "Terminal", "Terminal 2", … by the drawer's order. */
  readonly label: string;
  /** It needs you (an agent started in it is blocked): a dot on its tab, as the sidebar does not list it. */
  readonly needsYou?: boolean;
}

/** An agent pane's drawer as App gives it to the pane (MainPane) or the split (SplitView). */
export interface DrawerView {
  readonly state: DrawerState;
  readonly shells: readonly DrawerShellView[];
  /** One of its shells needs you: a dot on the drawer button (the sidebar leaves drawer shells out). */
  readonly needsYou?: boolean;
  /** A shell is being made for it. */
  readonly opening: boolean;
  /** The one line under its header (the folder was not known, a shell not opened), or null. */
  readonly note: string | null;
  /** The folder its shells open in (the agent pane's), or null when it is not known. */
  readonly folder: string | null;
  /** Its shell takes the keyboard when it comes up (opened, a shell made or picked; not a drawer restored at launch). */
  readonly wantsKeys: boolean;
  /** A change gives the shown shell the keyboard again. */
  readonly focusSignal: number;
  onToggle(): void;
  onNewShell(): void;
  onCloseShell(paneId: string): void;
  onSelectShell(paneId: string): void;
  onHeight(height: number | null): void;
  /** Escape from the drawer, not in a shell: the keyboard back where it was. */
  onEscape(): void;
  onDismissNote(): void;
}

/** The height while your drag moves the edge: from where it began, by the pointer's travel up, within the column. */
export function draggedHeight(startHeight: number, startY: number, y: number, columnHeight: number): number {
  return drawerHeight(startHeight + (startY - y), columnHeight);
}

/** True when the key event started outside a shell's terminal (the header, an empty drawer). */
function outsideShell(event: KeyboardEvent): boolean {
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  return target?.closest?.(".term-host") == null;
}

export interface TerminalDrawerProps {
  readonly host: HostView;
  readonly drawer: DrawerView;
  readonly fontSize: number;
  readonly mac: boolean;
  /** In a split, the tile it belongs to ("1 · claude"); none in the one pane view. */
  readonly owner?: string;
}

export function TerminalDrawer({ host, drawer, fontSize, mac, owner }: TerminalDrawerProps) {
  const { state, shells, opening, note, folder } = drawer;
  const shown = shells.find((shell) => shell.paneId === state.active) ?? shells[0] ?? null;
  const frame = useRef<HTMLElement>(null);
  // The height your drag shows until you let go (then it is kept by App), else the kept one.
  const [dragging, setDragging] = useState<number | null>(null);
  const [column, setColumn] = useState(0);
  useEffect(() => {
    const parent = frame.current?.parentElement;
    if (parent === null || parent === undefined || typeof ResizeObserver === "undefined") return;
    const measure = (): void => setColumn(parent.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const height = dragging ?? (column > 0 ? drawerHeight(state.height, column) : drawerHeight(state.height, Number.POSITIVE_INFINITY));
  const key = mac ? "⌘J" : "Ctrl+J";
  const where = folder === null ? "the machine's home folder" : shortPath(folder);
  const full = shells.length >= drawerShellsCapacity;

  const startResize = (event: ReactPointerEvent): void => {
    const element = frame.current;
    if (event.button !== 0 || element === null) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = element.getBoundingClientRect().height;
    const columnHeight = element.parentElement?.clientHeight ?? Number.POSITIVE_INFINITY;
    let last = startHeight;
    const move = (pointer: PointerEvent): void => {
      last = draggedHeight(startHeight, startY, pointer.clientY, columnHeight);
      setDragging(last);
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing", "resizing-down");
      setDragging(null);
    };
    const up = (pointer: PointerEvent): void => {
      last = draggedHeight(startHeight, startY, pointer.clientY, columnHeight);
      end();
      drawer.onHeight(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
    document.body.classList.add("resizing", "resizing-down");
  };

  return (
    <section
      ref={frame}
      className="tdr"
      style={{ height }}
      aria-label="Terminal"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !outsideShell(event)) return;
        event.preventDefault();
        drawer.onEscape();
      }}
    >
      <div
        className="tdr-edge"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Drawer height"
        title="Drag to resize · double-click for the default height"
        onPointerDown={startResize}
        onDoubleClick={() => drawer.onHeight(null)}
      />
      <div className="tdr-h">
        {owner === undefined ? null : <span className="tdr-own">{owner}</span>}
        <div className="tdr-tabs" role="tablist" aria-label="Shells">
          {shells.map((shell) => {
            const on = shell.paneId === shown?.paneId;
            const title = shell.row === null ? `${shell.label}: waiting for Herdr to list it` : `${shell.label}${shell.needsYou === true ? " · needs you" : ""}${shell.row.cwd === undefined ? "" : ` · ${shortPath(shell.row.cwd)}`}${shell.row.activity === undefined ? "" : ` · ${shell.row.activity}`}`;
            return (
              <button key={shell.paneId} role="tab" aria-selected={on} className={on ? "tdr-tab on" : "tdr-tab"} title={title} data-shell={shell.paneId} onClick={() => drawer.onSelectShell(shell.paneId)}>
                <TerminalIcon size={12} />
                <span className="tdr-tn">{shell.label}</span>
                {shell.needsYou === true ? <span className="tdr-ny" aria-hidden="true" /> : null}
              </button>
            );
          })}
          {opening ? <span className="tdr-opening">Opening…</span> : null}
        </div>
        <span className="sp" />
        <button
          className={opening || full ? "ib xs off" : "ib xs"}
          aria-label="New shell"
          aria-disabled={opening || full}
          title={full ? `A drawer holds ${String(drawerShellsCapacity)} shells` : `New shell in ${where}`}
          onClick={() => {
            if (!opening && !full) drawer.onNewShell();
          }}
        >
          <PlusIcon size={14} />
        </button>
        <button
          className={shown === null ? "ib xs off" : "ib xs"}
          aria-label="Close shell"
          aria-disabled={shown === null}
          title={shown === null ? "No shell to close" : `Close ${shown.label} (its Herdr pane)`}
          onClick={() => {
            if (shown !== null) drawer.onCloseShell(shown.paneId);
          }}
        >
          <CloseIcon size={13} />
        </button>
        <button className="ib xs" aria-label="Hide the terminal" title={`Hide the terminal (${key})`} onClick={drawer.onToggle}>
          <ChevronDownIcon size={14} />
        </button>
      </div>
      {note === null ? null : (
        <div className="tdr-note" role="status">
          <span className="tdr-note-t">{note}</span>
          <button className="cmp-note-x" aria-label="Dismiss" title="Dismiss" onClick={drawer.onDismissNote}>
            <CloseIcon size={10} />
          </button>
        </div>
      )}
      <div className="tdr-body">
        {shown !== null && shown.row !== null ? (
          <TerminalTab key={`${host.id}/${shown.paneId}`} host={host} row={shown.row} fontSize={fontSize} focusSignal={drawer.focusSignal} autoFocus={drawer.wantsKeys} />
        ) : (
          <div className="tdr-empty" tabIndex={-1}>
            {shown !== null || opening ? (
              `Opening a shell in ${where}…`
            ) : (
              <>
                <span>No shell open.</span>
                <button className="btn sm" onClick={drawer.onNewShell}>
                  New shell
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
