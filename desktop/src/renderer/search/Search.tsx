// "Search conversations" in the window:
// ⇧⌘F, or the sidebar's "Search all conversations for …", fills the main area
// with a field and the results grouped by pane (the pane with the newest match
// first, 5 shown, "N more in this pane"), each machine's line with Try again
// where its search did not finish, and ↑ ↓ Return Escape on the field. A
// result opens its pane in Chat at the message (search/reveal.ts). The main
// process searches (src/main/search/service.ts); the page sends every edit of
// the query (the main process cancels the old search at once and starts the
// new one once typing pauses for 300 ms) and shows the state that comes back.

import { useEffect, useRef, useState } from "react";

import type { HerdrDesktopBridge } from "../../shared/ipc-contract";
import { matchID } from "../../shared/search/search";
import {
  authorText,
  folderText,
  groupLabel,
  moreText,
  offersRetry,
  rowLabel,
  searchPrompt,
  searchShortcut,
  searchTime,
  searchTitle,
  snippetParts,
  statusText,
} from "../../shared/search/text";
import {
  emptySearchState,
  groupMore,
  groupShown,
  groupUnchecked,
  isSearching,
  isTooShort,
  keptSelection,
  moveSelection,
  openRequest,
  selectedRequest,
  showsNoResults,
  type SearchOpenRequest,
  type SearchSelection,
  type SearchViewState,
} from "../../shared/search/view";
import { AgentIcon, CloseIcon, SearchIcon, TerminalIcon } from "../icons";

/** A very long message's row (its text is not read). */
export const longMessageText = "A very long message (its text is not shown)";

export type SearchBridge = Pick<HerdrDesktopBridge, "searchConversations" | "searchExpand" | "searchRetry" | "searchClose" | "onSearchUpdate">;

/** The main process's search state for this window, kept current. */
export function useSearchState(bridge: Pick<HerdrDesktopBridge, "onSearchUpdate">): SearchViewState {
  const [state, setState] = useState<SearchViewState>(emptySearchState);
  useEffect(() => {
    if (typeof bridge.onSearchUpdate !== "function") return;
    return bridge.onSearchUpdate((next) => setState(next));
  }, [bridge]);
  return state;
}

/** "Search all conversations for “x”" under the sidebar's pane filter, or the shortcut when it is too short. */
export function searchAllText(filter: string): string {
  const text = filter.trim();
  return isTooShort(text) ? `${searchTitle} ${searchShortcut}` : `Search all conversations for “${text}”`;
}

export interface SearchScreenProps {
  readonly bridge: SearchBridge;
  readonly state: SearchViewState;
  readonly query: string;
  /** Seconds since 1970. */
  readonly now: number;
  onQuery(query: string): void;
  onOpen(request: SearchOpenRequest): void;
  onClose(): void;
}

export function SearchScreen({ bridge, state, query, now, onQuery, onOpen, onClose }: SearchScreenProps) {
  const [selection, setSelection] = useState<SearchSelection | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const kept = keptSelection(state.groups, selection);
  const selectedKey = kept === null ? null : kept.groupID + "#" + kept.matchID;

  // Every edit goes to the main process as it happens: the old search stops now.
  useEffect(() => {
    bridge.searchConversations(query);
  }, [bridge, query]);

  // Leaving the screen stops every command and read.
  useEffect(() => () => bridge.searchClose(), [bridge]);

  // The selected result stays in view.
  useEffect(() => {
    if (selectedKey === null) return;
    list.current?.querySelector(`[data-match="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const onKeyDown = (event: { key: string; preventDefault(): void }): void => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        setSelection(moveSelection(state.groups, kept, event.key === "ArrowDown" ? 1 : -1));
        return;
      case "Enter": {
        event.preventDefault();
        const request = selectedRequest(state.groups, kept);
        if (request !== null) onOpen(request);
        return;
      }
      case "Escape":
        event.preventDefault();
        onClose();
        return;
    }
  };

  const searching = isSearching(query, state);
  const tooShort = isTooShort(query);
  const lines = state.statuses.flatMap((status) => {
    const text = statusText(status);
    return text === null ? [] : [{ status, text }];
  });

  return (
    <main className="main search-screen">
      <div className="mh">
        <div className="who">
          <span className="nm">{searchTitle}</span>
        </div>
        <span className="sp" />
        {searching && !tooShort ? <span className="away-reading">Searching…</span> : null}
        <button className="ib" title="Close (Esc)" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="search-field">
        <SearchIcon size={15} />
        <input
          autoFocus
          aria-label={searchTitle}
          placeholder={searchPrompt}
          value={query}
          spellCheck={false}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {query === "" ? null : (
          <button className="ib" title="Clear" onClick={() => onQuery("")}>
            <CloseIcon size={12} />
          </button>
        )}
      </div>
      <div className="away-scroll" ref={list}>
        <div className="search-col">
          {tooShort
            ? null
            : lines.map(({ status, text }) => (
                <div className="search-mac" key={status.id}>
                  <span>{text}</span>
                  {offersRetry(status) ? (
                    <button className="btn sm" onClick={() => bridge.searchRetry(status.id)}>
                      Try again
                    </button>
                  ) : null}
                </div>
              ))}
          {tooShort ? (
            <div className="away-empty">
              <div>{searchPrompt}</div>
              <div className="search-key">{searchShortcut}</div>
            </div>
          ) : showsNoResults(query, state) ? (
            <div className="away-empty">{`No matches for “${state.searched ?? query.trim()}”`}</div>
          ) : null}
          {tooShort
            ? null
            : state.groups.map((group) => {
                const more = groupMore(group);
                const unchecked = groupUnchecked(group);
                const place = folderText(group.pane.folder);
                return (
                  <section className="search-group" key={group.id} data-group={group.id} aria-label={groupLabel(group)}>
                    <div className="search-group-h">
                      <span className="ic">{group.pane.kind === null ? <TerminalIcon size={13} /> : <AgentIcon size={13} />}</span>
                      <span className="nm">{group.pane.name}</span>
                      {group.pane.kind === null ? null : <span className="kd">{group.pane.kind}</span>}
                      <span className="pl">{place === null ? group.macName : `${group.macName} · ${place}`}</span>
                    </div>
                    {groupShown(group).map((match) => {
                      const key = group.id + "#" + matchID(match);
                      return (
                        <button
                          className={key === selectedKey ? "search-row sel" : "search-row"}
                          key={key}
                          data-match={key}
                          aria-label={rowLabel(match, group.pane.kind, now)}
                          onClick={() => onOpen(openRequest(group, match))}
                        >
                          <span className="search-row-h">
                            <span className="au">{authorText(match.author, group.pane.kind)}</span>
                            {match.time === null ? null : <span className="tm">{searchTime(match.time, now)}</span>}
                          </span>
                          {match.snippet === null ? (
                            <span className="search-snippet long">{longMessageText}</span>
                          ) : (
                            <span className="search-snippet">
                              {snippetParts(match.snippet).map((part, index) => (part.marked ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
                            </span>
                          )}
                        </button>
                      );
                    })}
                    {more > 0 || unchecked ? (
                      <button className="search-more" disabled={group.expanding} onClick={() => bridge.searchExpand(group.macID, group.pane.id)}>
                        {group.expanding ? "Reading…" : moreText(more, unchecked)}
                      </button>
                    ) : null}
                  </section>
                );
              })}
        </div>
      </div>
    </main>
  );
}
