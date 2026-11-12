// A port of the Swift app's CompanionPaneModeRule
// changesToggled and covered: ⌃⌘C opens an
// agent pane's Changes and goes back to the view it covered. The desktop's Chat
// tab is always there for an agent pane (it shows why when there is no
// transcript), so "Chat where it is on" is Chat. A plain shell has no Changes.

import type { MainTab } from "../ipc-contract";

/** ⌃⌘C: Changes, or from Changes back to what it covered (not known: Chat); none on a plain shell. */
export function changesToggled(tab: MainTab, isAgent: boolean, covered: MainTab | null): MainTab | null {
  if (!isAgent) return null;
  if (tab !== "changes") return "changes";
  return covered === "terminal" ? "terminal" : "chat";
}

/** What Changes covers once `picking` is picked over `over`: the view it opened over, kept while Changes stays; none once another is up. */
export function coveredAfter(picking: MainTab, over: MainTab, was: MainTab | null): MainTab | null {
  if (picking !== "changes") return null;
  return over === "changes" ? was : over;
}

/**
 * The tab a pane shows: Changes is an agent pane's only; a plain shell shows its terminal, always
 * (it has no switch, as in the Swift app).
 */
export function shownTab(tab: MainTab, isAgent: boolean): MainTab {
  return isAgent ? tab : "terminal";
}
