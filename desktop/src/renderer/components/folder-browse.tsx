// The folder field's list in New workspace and New agent, on
// the dialog's machine (T3 Code's Add project browse, apps/web/src/components/
// CommandPalette.tsx: the folders under what is typed as you type, ↑ ↓ to
// move, Tab into the highlighted folder, Return or a click to pick it, Esc to
// close the list). It opens when you type a "/" or "~" path in the field (a
// prefilled folder or a chip leaves it closed, so Return still creates or
// starts), asks the machine for one folder at a time a moment after the last
// key (browseDebounceMs), keeps only the answer for the folder typed now
// (T3's browse navigation coordinator), and closes when the field loses
// focus. Choose… is This Mac's folder window (T3's pickFolder), for This Mac
// only. The dialogs call `folderList` and `chooseButton` inline, so the field
// and its list stay in the dialog's own tree.

import { useEffect, useRef, useState } from "react";

import {
  browseDebounceMs,
  browseQuery,
  enteredFolder,
  folderBrowseTexts,
  listingLine,
  pickedFolder,
  visibleFolders,
  type BrowseQuery,
  type FolderListing,
} from "../../shared/folder-browse";
import { FolderIcon } from "../icons";

/** What the list asks of the main process (the bridge's browseFolder and pickFolder). */
export interface FolderCalls {
  browse(hostId: string, directory: string): Promise<FolderListing>;
  /** This Mac's folder window; absent where there is none. */
  pick?(hostId: string, typed: string): Promise<string | null>;
}

export interface FolderBrowseOptions {
  /** Null: no list (an older bridge, a test without one). */
  readonly calls: FolderCalls | null;
  readonly hostId: string | null;
  /** The machine's name, for the list's lines. */
  readonly machine: string;
  /** This Mac: Choose… opens the macOS folder window. */
  readonly local: boolean;
  /** The machine is not answering (said, never asked). */
  readonly offline: boolean;
  readonly folder: string;
  setFolder(value: string): void;
  readonly disabled: boolean;
}

type Answer = FolderListing | { readonly type: "failed"; readonly reason: string };

export interface FolderBrowse {
  readonly open: boolean;
  readonly query: BrowseQuery | null;
  /** The folders shown (filtered, at most maxShownFolders). */
  readonly shown: readonly string[];
  readonly highlight: number;
  /** The plain line instead of folders (loading, none, missing, unreadable, offline), or null. */
  readonly line: string | null;
  readonly more: number;
  readonly truncated: boolean;
  /** Choose… is offered (This Mac, with a folder window). */
  readonly canChoose: boolean;
  /** Why Choose… did not open, or null. */
  readonly chooseNote: string | null;
  /** The field changed as you typed. */
  typed(value: string): void;
  /** A key in the dialog while the list is open: true when the list took it (the dialog does nothing more). */
  key(event: { readonly key: string; readonly shiftKey?: boolean; preventDefault(): void }): boolean;
  pick(name: string): void;
  hover(index: number): void;
  close(): void;
  choose(): void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function useFolderBrowse(options: FolderBrowseOptions): FolderBrowse {
  const { calls, hostId, machine, local, offline, folder, setFolder, disabled } = options;
  const [opened, setOpened] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [answer, setAnswer] = useState<{ readonly key: string; readonly answer: Answer } | null>(null);
  const [chooseNote, setChooseNote] = useState<string | null>(null);
  // Only the newest request's answer is kept (T3's createBrowseNavigationCoordinator).
  const generation = useRef(0);

  const query = browseQuery(folder);
  const open = opened && !disabled && calls !== null && hostId !== null && query !== null;
  const key = hostId === null || query === null ? null : `${hostId}\n${query.directory}`;

  // Another machine: the list closes.
  useEffect(() => {
    setOpened(false);
  }, [hostId]);

  useEffect(() => {
    if (!open || offline || key === null || calls === null || hostId === null || query === null) return;
    if (answer !== null && answer.key === key) return;
    const directory = query.directory;
    const timer = setTimeout(() => {
      generation.current += 1;
      const mine = generation.current;
      calls.browse(hostId, directory).then(
        (listing) => {
          if (mine === generation.current) setAnswer({ key, answer: listing });
        },
        (error: unknown) => {
          if (mine === generation.current) setAnswer({ key, answer: { type: "failed", reason: message(error) } });
        },
      );
    }, browseDebounceMs);
    return () => clearTimeout(timer);
  }, [open, offline, key]);

  const current: Answer | null = offline ? { type: "offline" } : answer !== null && answer.key === key ? answer.answer : null;
  const listed = current?.type === "listed" ? current : null;
  const visible = listed === null || query === null ? { shown: [], more: 0 } : visibleFolders(listed.names, query.filter);
  const shown = visible.shown;
  const at = Math.max(0, Math.min(highlight, shown.length - 1));
  const line =
    query === null
      ? null
      : current === null
        ? folderBrowseTexts.loading
        : current.type === "failed"
          ? folderBrowseTexts.failed(machine, current.reason)
          : listingLine(current, query, machine, shown.length);

  const typed = (value: string): void => {
    setFolder(value);
    setHighlight(0);
    setChooseNote(null);
    setOpened(browseQuery(value) !== null);
  };

  const pick = (name: string): void => {
    if (query === null) return;
    setFolder(pickedFolder(query.directory, name));
    setOpened(false);
  };

  const key_ = (event: { readonly key: string; readonly shiftKey?: boolean; preventDefault(): void }): boolean => {
    if (!open || query === null) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpened(false);
      return true;
    }
    if (shown.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(Math.max(0, Math.min(shown.length - 1, at + (event.key === "ArrowDown" ? 1 : -1))));
      return true;
    }
    if (event.key === "Tab" && event.shiftKey !== true) {
      event.preventDefault();
      setFolder(enteredFolder(query.directory, shown[at]!));
      setHighlight(0);
      return true;
    }
    if (event.key === "Enter" && event.shiftKey !== true) {
      event.preventDefault();
      pick(shown[at]!);
      return true;
    }
    return false;
  };

  const canChoose = local && calls?.pick !== undefined && hostId !== null;
  const choose = (): void => {
    if (!canChoose || calls?.pick === undefined || hostId === null || disabled) return;
    setOpened(false);
    setChooseNote(null);
    calls.pick(hostId, folder).then(
      (picked) => {
        if (picked !== null) setFolder(picked);
      },
      (error: unknown) => setChooseNote(message(error)),
    );
  };

  return {
    open,
    query,
    shown,
    highlight: at,
    line: open ? line : null,
    more: visible.more,
    truncated: listed?.truncated ?? false,
    canChoose,
    chooseNote,
    typed,
    key: key_,
    pick,
    hover: (index) => setHighlight(index),
    close: () => setOpened(false),
    choose,
  };
}

/** The list under the field while it is open (null when closed): the folders, or its one plain line, and the keys. */
export function folderList(browse: FolderBrowse) {
  if (!browse.open) return null;
  return (
    <div className="fb" role="listbox" aria-label="Folders in the typed folder">
      {browse.shown.map((name, index) => (
        <button
          key={name}
          className={index === browse.highlight ? "fb-i on" : "fb-i"}
          role="option"
          aria-selected={index === browse.highlight}
          data-folder={name}
          tabIndex={-1}
          // The field keeps focus (its blur closes the list).
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => browse.hover(index)}
          onClick={() => browse.pick(name)}
        >
          <FolderIcon size={13} />
          <span className="nm">{name}</span>
        </button>
      ))}
      {browse.line === null ? null : <div className="fb-line">{browse.line}</div>}
      {browse.more > 0 ? <div className="fb-line">{folderBrowseTexts.more(browse.more)}</div> : null}
      {browse.truncated ? <div className="fb-line">{folderBrowseTexts.truncated}</div> : null}
      {browse.shown.length > 0 ? <div className="fb-keys">{folderBrowseTexts.keys}</div> : null}
    </div>
  );
}

/** Choose… beside the field, on This Mac only (null elsewhere). */
export function chooseButton(browse: FolderBrowse, disabled: boolean) {
  if (!browse.canChoose) return null;
  return (
    <button className="btn" aria-label={folderBrowseTexts.chooseTitle} title={folderBrowseTexts.chooseTitle} disabled={disabled} onClick={() => browse.choose()}>
      {folderBrowseTexts.choose}
    </button>
  );
}
