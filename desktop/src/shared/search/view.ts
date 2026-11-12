// "Search conversations" as the page sees it (CompanionSearchModel in the Swift
// app): each machine's line, the results grouped by pane across machines (the
// pane with the newest match first), what ↑ and ↓ move through and what a
// result opens. The main process builds the state (src/main/search/service.ts);
// these functions are shared so both sides and the tests read it the same way.

import { SearchQuery, matchID, searchBounds, type SearchMatch, type SearchPaneResults } from "./search";
import type { SearchUpdate } from "./runner";

/** One pane a search looks in, as the sidebar names it. */
export interface SearchPaneInfo {
  readonly id: string;
  readonly name: string;
  /** The agent (`claude`, `codex`, `grok`); null for a shell. */
  readonly kind: string | null;
  readonly folder: string | null;
}

export type SearchMacPhase = "waiting" | "searching" | "done" | "offline" | "timedOut" | "failed";

export interface SearchMacStatus {
  readonly id: string;
  readonly name: string;
  readonly phase: SearchMacPhase;
  /** "more results not shown". */
  readonly truncated: boolean;
  /** Panes past the 30 searched. */
  readonly skippedPanes: number;
  /** Agent panes with no transcript to read (Grok, or none reported). */
  readonly unsearchedPanes: number;
}

/** A match as it crosses to the page (no parser state). */
export type SearchMatchView = Omit<SearchMatch, "input" | "joined">;

export interface SearchGroup {
  /** `<machine id>|<pane id>`. */
  readonly id: string;
  readonly macID: string;
  readonly macName: string;
  readonly pane: SearchPaneInfo;
  /** Every match read, newest first. */
  readonly matches: readonly SearchMatchView[];
  /** Matching lines found and not read yet. */
  readonly unread: number;
  /** "N more" was asked for: every match shows. */
  readonly expanded: boolean;
  /** Its "N more" is being read. */
  readonly expanding: boolean;
}

export interface SearchViewState {
  /** The query whose results are on show (null: none yet, or too short). */
  readonly searched: string | null;
  readonly statuses: readonly SearchMacStatus[];
  readonly groups: readonly SearchGroup[];
}

export const emptySearchState: SearchViewState = { searched: null, statuses: [], groups: [] };

/** The matches on show: 5, or every one once "N more" was asked for. */
export const groupShown = (group: SearchGroup): readonly SearchMatchView[] => (group.expanded ? group.matches : group.matches.slice(0, searchBounds.shownPerPane));
/** "N more in this pane": matches read beyond those on show. */
export const groupMore = (group: SearchGroup): number => (group.expanded ? 0 : group.matches.length - groupShown(group).length);
/** Lines found and not read yet: "more lines to check", never counted as matches. */
export const groupUnchecked = (group: SearchGroup): boolean => group.unread > 0;
export const groupNewest = (group: SearchGroup): number | null => group.matches[0]?.time ?? null;

const toView = (match: SearchMatch): SearchMatchView => ({
  paneID: match.paneID,
  lineOffset: match.lineOffset,
  messageID: match.messageID,
  author: match.author,
  time: match.time,
  snippet: match.snippet,
});

/** One machine as the groups are built from it. */
export interface SearchMacResults {
  readonly id: string;
  readonly name: string;
  readonly panes: readonly SearchPaneInfo[];
  readonly update: SearchUpdate | null;
}

/** The groups of every machine, the pane with the newest match first (an unknown time after known ones), then the machines' and the panes' order. */
export function buildGroups(macs: readonly SearchMacResults[], expanded: ReadonlySet<string>): SearchGroup[] {
  const next: { group: SearchGroup; macOrder: number; order: number }[] = [];
  macs.forEach((mac, macOrder) => {
    if (mac.update === null) return;
    const update = mac.update;
    update.results.panes.forEach((results: SearchPaneResults, order) => {
      const pane = mac.panes.find((candidate) => candidate.id === results.paneID) ?? { id: results.paneID, name: results.paneID, kind: null, folder: null };
      const id = mac.id + "|" + results.paneID;
      next.push({
        group: {
          id,
          macID: mac.id,
          macName: mac.name,
          pane,
          matches: results.matches.map(toView),
          unread: results.unread,
          expanded: expanded.has(id),
          expanding: update.expanding.has(results.paneID),
        },
        macOrder,
        order,
      });
    });
  });
  next.sort((first, second) => {
    const one = groupNewest(first.group);
    const two = groupNewest(second.group);
    if (one !== null && two !== null && one !== two) return two - one;
    if (one !== null && two === null) return -1;
    if (one === null && two !== null) return 1;
    return first.macOrder !== second.macOrder ? first.macOrder - second.macOrder : first.order - second.order;
  });
  return next.map((entry) => entry.group);
}

// MARK: - the field and the keyboard

/** Fewer than 2 characters typed: nothing searched. */
export const isTooShort = (query: string): boolean => SearchQuery.make(query) === null;

/** Typed and waiting for the pause, or a machine still searching. */
export function isSearching(query: string, state: SearchViewState): boolean {
  const typed = SearchQuery.make(query);
  return (typed !== null && state.searched !== typed.text) || state.statuses.some((status) => status.phase === "searching");
}

/** The search is over and nothing matched. */
export const showsNoResults = (query: string, state: SearchViewState): boolean => state.searched !== null && !isSearching(query, state) && state.groups.length === 0;

export interface SearchSelection {
  readonly groupID: string;
  readonly matchID: string;
}

/** The results on show, in order: what ↑ and ↓ move through. */
export function visibleResults(groups: readonly SearchGroup[]): SearchSelection[] {
  return groups.flatMap((group) => groupShown(group).map((match) => ({ groupID: group.id, matchID: matchID(match) })));
}

const sameSelection = (a: SearchSelection, b: SearchSelection): boolean => a.groupID === b.groupID && a.matchID === b.matchID;

/** ↑ (-1) and ↓ (+1): the result above or below, from the first or the last when none is selected. */
export function moveSelection(groups: readonly SearchGroup[], selection: SearchSelection | null, step: number): SearchSelection | null {
  const all = visibleResults(groups);
  if (all.length === 0) return null;
  const index = selection === null ? -1 : all.findIndex((candidate) => sameSelection(candidate, selection));
  if (index < 0) return step >= 0 ? all[0]! : all[all.length - 1]!;
  return all[Math.min(Math.max(index + step, 0), all.length - 1)]!;
}

/** A selection still on show, else null. */
export function keptSelection(groups: readonly SearchGroup[], selection: SearchSelection | null): SearchSelection | null {
  if (selection === null) return null;
  return visibleResults(groups).some((candidate) => sameSelection(candidate, selection)) ? selection : null;
}

/** What a result opens: the pane's Chat with the message on screen. */
export interface SearchOpenRequest {
  readonly macID: string;
  readonly paneID: string;
  /** The chat row's id; null for a very long message, which opens the pane's Chat only. */
  readonly messageID: string | null;
  readonly lineOffset: number;
}

export const openRequest = (group: SearchGroup, match: SearchMatchView): SearchOpenRequest => ({
  macID: group.macID,
  paneID: group.pane.id,
  messageID: match.messageID,
  lineOffset: match.lineOffset,
});

/** What Return opens: the selected result, else the first. */
export function selectedRequest(groups: readonly SearchGroup[], selection: SearchSelection | null): SearchOpenRequest | null {
  const target = selection ?? visibleResults(groups)[0] ?? null;
  if (target === null) return null;
  const group = groups.find((candidate) => candidate.id === target.groupID);
  const match = group?.matches.find((candidate) => matchID(candidate) === target.matchID);
  return group === undefined || match === undefined ? null : openRequest(group, match);
}
