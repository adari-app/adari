// "While you were away"'s words (CompanionAwayText and AwayMacLine.text in
// the Swift app): the card's lines, the machine lines and the labels a screen
// reader speaks. Plain functions, so the tests read them without a page.

import { compactDuration } from "../chat/model";
import { defaultAwayLimits } from "./readers";
import { digestSummaryText, waitingText, type AwayCard, type AwayDigest, type AwayMacLine } from "./digest";

export const awayTitle = "While you were away";

/** The line's label: "While you were away: 5 agents: 1 needs you, 2 finished, 3 commits". */
export const summaryLabel = (digest: AwayDigest): string => awayTitle + ": " + digestSummaryText(digest);

/** "aurora-web": the folder's last part. */
export function folderName(folder: string | null): string | null {
  if (folder === null || folder === "") return null;
  const parts = folder.split("/").filter((part) => part !== "");
  return parts.at(-1) ?? folder;
}

/** "Studio Mac · aurora-web". */
export const cardPlace = (card: AwayCard): string => [card.macName, folderName(card.folder)].filter((part) => part !== null).join(" · ");

/** A changed file inside the pane's folder by its path in it. */
export function relativePath(path: string, folder: string | null): string {
  if (folder === null || folder === "") return path;
  const base = folder.endsWith("/") ? folder : folder + "/";
  return path.startsWith(base) ? path.slice(base.length) : path;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "1 turn finished · 6 files changed · 2 commits · 1 error". */
export function cardStats(card: AwayCard): string | null {
  const parts: string[] = [];
  if (card.turnsFinished > 0) parts.push(count(card.turnsFinished, "turn", "turns") + " finished");
  if (card.fileCount > 0) parts.push(count(card.fileCount, "file", "files") + " changed");
  if (card.commitCount > 0) parts.push(count(card.commitCount, "commit", "commits"));
  if (card.errorCount > 0) parts.push(count(card.errorCount, "error", "errors"));
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A reply's line as one line: a list item's marker as a bullet, a heading's marks dropped. */
export function replyLine(line: string): string {
  for (const marker of ["- ", "* ", "+ "]) if (line.startsWith(marker)) return "• " + line.slice(marker.length);
  return line.replace(/^#+/, "").trim();
}

/** "1h 52m ago", "47m ago", "just now". */
export function ago(time: number | null, now: number): string | null {
  if (time === null) return null;
  const interval = now - time;
  if (interval < 60) return "just now";
  if (interval < 3600) return `${Math.floor(interval / 60)}m ago`;
  return compactDuration(interval) + " ago";
}

/** The card's time at its top: how long it waits, else when it last did something. */
export const cardTime = (card: AwayCard, now: number): string | null =>
  waitingText(card, now) ?? ago(card.lastFinishedAt ?? card.lastActivityAt, now);

export function transcriptNote(card: AwayCard): string | null {
  switch (card.transcript) {
    case "read":
      return card.more ? "More happened before this: only the last 2 MB were read." : null;
    case "noTranscript":
      return "No transcript to read for this agent: its status only.";
    case "unreadable":
      return "Its transcript could not be read.";
    case "notRead":
      return `Not read: more agents on this machine than the ${defaultAwayLimits.panesPerMac} read.`;
  }
}

/** "Error: …", or "Last of 3 errors: …". */
export function errorLine(card: AwayCard): string | null {
  if (card.lastError === null) return null;
  return (card.errorCount > 1 ? `Last of ${card.errorCount} errors: ` : "Error: ") + card.lastError.text;
}

/** The card's label for a screen reader: everything it shows, in one reading. */
export function cardLabel(card: AwayCard, now: number): string {
  const parts = [`${card.name}, ${card.kind}`, cardPlace(card)];
  const time = cardTime(card, now);
  if (time !== null) parts.push(time);
  const stats = cardStats(card);
  if (stats !== null) parts.push(stats);
  if (card.lastReply !== null) parts.push("Last reply: " + card.lastReply.lines.map(replyLine).join(" "));
  const error = errorLine(card);
  if (error !== null) parts.push(error);
  const note = transcriptNote(card);
  if (note !== null) parts.push(note);
  return parts.join(". ");
}

function clock(seconds: number, timeZone: string | undefined, withDay: boolean): string {
  const date = new Date(seconds * 1000);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
  if (!withDay) return time;
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(date);
  return `${day} ${time}`;
}

const dayKey = (seconds: number, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(seconds * 1000));

/** "03:10", or "2 Nov 03:10" on another day than `now`. */
export function sinceClock(seconds: number, now: number, timeZone?: string): string {
  return clock(seconds, timeZone, dayKey(seconds, timeZone) !== dayKey(now, timeZone));
}

/** "Mac mini: offline since 03:10", "Laptop: not connected since 00:05"; null while online. */
export function macLineText(line: AwayMacLine, now: number, timeZone?: string): string | null {
  switch (line.state.kind) {
    case "online":
      return null;
    case "offline":
      return line.name + ": offline" + (line.state.since === null ? "" : " since " + sinceClock(line.state.since, now, timeZone));
    case "notConnected":
      return line.name + ": not connected" + (line.state.since === null ? "" : " since " + sinceClock(line.state.since, now, timeZone));
  }
}
