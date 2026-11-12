// The search screen's words (CompanionSearchText in the Swift app), for its
// text and a screen reader: the title and prompt, when a message was written,
// who wrote it, a group's and a row's labels, "N more in this pane", each
// machine's line, and a snippet cut into its marked and plain parts.

import { knownAgentName } from "../agent-names";
import { graphemes, searchBounds, type SearchAuthor, type SearchSnippet } from "./search";
import type { SearchGroup, SearchMacStatus, SearchMatchView } from "./view";

export const searchTitle = "Search conversations";
export const searchPrompt = "Search every conversation on your machines";
export const searchShortcut = "⇧⌘F";

export interface ClockOptions {
  readonly locale?: string;
  readonly timeZone?: string;
}

const dayKey = (seconds: number, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(seconds * 1000));

/** "3:42 PM" today, "yesterday at 3:42 PM", "Tuesday at 3:42 PM" within the week, the date beyond ("Oct 12", "Oct 12, 2025" another year). */
export function searchTime(seconds: number, now: number, options: ClockOptions = {}): string {
  const { locale, timeZone } = options;
  const date = new Date(seconds * 1000);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(date);
  const day = dayKey(seconds, timeZone);
  if (day === dayKey(now, timeZone)) return time;
  // Calendar days back, counted on the day keys (noon UTC of each, so a DST change never shifts one).
  const noon = (key: string): number => Date.parse(key + "T12:00:00Z");
  const daysBack = Math.round((noon(dayKey(now, timeZone)) - noon(day)) / 86_400_000);
  if (daysBack === 1) return `yesterday at ${time}`;
  if (daysBack >= 2 && daysBack <= 6) return `${new Intl.DateTimeFormat(locale, { weekday: "long", timeZone }).format(date)} at ${time}`;
  const sameYear = day.slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  return new Intl.DateTimeFormat(locale, sameYear ? { month: "short", day: "numeric", timeZone } : { month: "short", day: "numeric", year: "numeric", timeZone }).format(date);
}

/** The agent's name: the shared table's ("Claude Code", "Gemini CLI"), else its kind capitalised. */
export function agentName(kind: string | null): string {
  const lower = kind?.toLowerCase() ?? null;
  const known = knownAgentName(lower);
  if (known !== null) return known;
  if (lower === null || lower === "") return "Agent";
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Who wrote it: You, the agent (by its name), or a command. */
export function authorText(author: SearchAuthor | null, kind: string | null): string {
  switch (author) {
    case "you":
      return "You";
    case "agent":
      return agentName(kind);
    case "command":
      return "Command";
    case null:
      return "A very long message";
  }
}

/** The pane's folder, by its last name. */
export function folderText(folder: string | null): string | null {
  if (folder === null || folder === "") return null;
  const name = folder.split("/").filter((part) => part !== "").at(-1);
  return name ?? folder;
}

/** "3 matches in claude, aurora-web, Mac mini". */
export function groupLabel(group: SearchGroup): string {
  const count = group.matches.length;
  return `${count} ${count === 1 ? "match" : "matches"} in ${group.pane.kind ?? "terminal"}, ${group.pane.name}, ${group.macName}`;
}

/** "Mac mini · aurora-web". */
export const groupPlace = (group: SearchGroup): string => [group.macName, folderText(group.pane.folder)].filter((part) => part !== null).join(" · ");

/** A result for a screen reader: who, when, then the text. */
export function rowLabel(match: SearchMatchView, kind: string | null, now: number, options: ClockOptions = {}): string {
  if (match.snippet === null) return "A very long message, its text not shown";
  const when = match.time === null ? "" : ", " + searchTime(match.time, now, options);
  return `${authorText(match.author, kind)}${when}: ${match.snippet.text}`;
}

/** "N more in this pane", or with lines still to check. */
export function moreText(count: number, unchecked = false): string {
  if (count > 0 && !unchecked) return `${count} more in this pane`;
  if (count > 0) return `${count} more in this pane, more lines to check`;
  return "More lines to check in this pane";
}

/** A machine's line over the results; null when there is nothing to say. */
export function statusText(status: SearchMacStatus): string | null {
  switch (status.phase) {
    case "waiting":
      return null;
    case "searching":
      return `${status.name}: searching…`;
    case "offline":
      return `${status.name}: offline`;
    case "timedOut":
      return `${status.name}: no answer in ${Math.round(searchBounds.timeoutMs / 1000)} s`;
    case "failed":
      return `${status.name}: the search did not run`;
    case "done": {
      const notes: string[] = [];
      if (status.truncated) notes.push("more results not shown");
      if (status.skippedPanes > 0) notes.push(`${status.skippedPanes} ${status.skippedPanes === 1 ? "pane" : "panes"} not searched (over ${searchBounds.maximumFiles})`);
      if (status.unsearchedPanes > 0) notes.push(`${status.unsearchedPanes} ${status.unsearchedPanes === 1 ? "pane has" : "panes have"} no transcript to search`);
      return notes.length === 0 ? null : `${status.name}: ` + notes.join("; ");
    }
  }
}

/** Whether the machine's line offers Try again. */
export const offersRetry = (status: SearchMacStatus): boolean => status.phase === "timedOut" || status.phase === "failed";

/** The snippet as runs of plain and marked text, cut at characters, never inside one. */
export function snippetParts(snippet: SearchSnippet): { text: string; marked: boolean }[] {
  const characters = graphemes(snippet.text);
  const marks = characters.map(() => false);
  for (const range of snippet.highlights) for (let index = range.start; index < range.end && index < marks.length; index += 1) marks[index] = true;
  const parts: { text: string; marked: boolean }[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = start + 1;
    while (end < characters.length && marks[end] === marks[start]) end += 1;
    parts.push({ text: characters.slice(start, end).join(""), marked: marks[start]! });
    start = end;
  }
  return parts;
}
