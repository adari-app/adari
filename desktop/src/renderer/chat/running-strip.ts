// What the Running strip shows. Pure, so the strip
// and its tests share it.
// One item per running shell, monitor and subagent, in the order they began;
// its title on one line; the time it has run; and the panel a click opens: the
// command's or the prompt's first lines, a monitor's newest event, a
// subagent's newest step.

import { compactDuration, endingRunningTurn, endingSession, runningTurn, type ChatRunningKind, type ChatRunningWork, type ChatTimeline } from "../../shared/chat/model";
import type { AgentStatus } from "../../shared/sidebar-model";

/** The panel's lines of a command or prompt; past them "⋯ N more lines". */
export const panelLineCount = 6;

export interface StripItem {
  readonly id: string;
  readonly kind: ChatRunningKind;
  readonly kindLabel: string;
  readonly title: string;
  /** "1m 2s"; "" when its start is not known. */
  readonly elapsed: string;
  /** A subagent's newest tool step. */
  readonly step: string | null;
}

export interface PanelView {
  readonly label: string;
  readonly title: string;
  /** "Command", or "Prompt" for a subagent. */
  readonly heading: string;
  readonly lines: readonly string[];
  readonly more: number;
  /** A monitor's newest event. */
  readonly event: string | null;
  /** A subagent's newest step. */
  readonly step: string | null;
}

/**
 * The timeline as Chat shows it for Herdr's status (ChatView's rule): a pane
 * whose agent is gone ran its session out (nothing runs); one idle or done has
 * no running turn (its foreground subagents stopped with it; background work
 * runs on).
 */
export function shownTimeline(raw: ChatTimeline, status: AgentStatus): ChatTimeline {
  if (status === "absent") return endingSession(raw);
  if ((status === "idle" || status === "done") && runningTurn(raw) !== null) return endingRunningTurn(raw);
  return raw;
}

/** A description on one line: its first non-empty line. */
export function stripTitle(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

export function kindLabel(work: ChatRunningWork): string {
  switch (work.kind) {
    case "shell":
      return "Background command";
    case "monitor":
      return "Monitor";
    case "agent":
      return work.background ? "Background agent" : "Agent";
  }
}

/** How long it has run at `now` (seconds). */
export function elapsedText(startedAt: number | null, now: number): string {
  return startedAt === null ? "" : compactDuration(Math.max(0, now - startedAt));
}

export function stripItems(work: readonly ChatRunningWork[], now: number): StripItem[] {
  return work.map((item) => ({
    id: item.id,
    kind: item.kind,
    kindLabel: kindLabel(item),
    title: stripTitle(item.title) || kindLabel(item),
    elapsed: elapsedText(item.startedAt, now),
    step: item.step,
  }));
}

export function panelView(work: ChatRunningWork): PanelView {
  const lines = work.detail
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return {
    label: kindLabel(work),
    title: stripTitle(work.title) || kindLabel(work),
    heading: work.kind === "agent" ? "Prompt" : "Command",
    lines: lines.slice(0, panelLineCount),
    more: Math.max(0, lines.length - panelLineCount),
    event: work.lastEvent,
    step: work.step,
  };
}
