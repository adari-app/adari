// An agent that needs you stands out in its own row, the
// way T3 Code's thread status pill does it (apps/web/src/components/
// Sidebar.logic.ts resolveThreadStatusPill, ThreadStatusIndicators.tsx).
//
// Which rows: Herdr's needs-you status (blocked), the one that drives the
// sidebar's attention mark and Away's Needs you; the pill goes the moment the
// status leaves it (a pane the card's reads cleared shows as working, so it
// goes then too). Which words: "Pending Approval" when the Needs card's
// matcher reads an approval (cardContent: an edit, a command to run, a file to
// create); "Awaiting Input" for a question (cardContent "asks") and whenever
// the kind is not known (no reading yet, or one not matched). Which colors:
// dark, Adari's (Halo) approval yellow and input violet; light, T3's Tailwind
// amber and indigo, kept for a later light mode (App/CompanionSidebar.swift's
// CompanionNeedsPill uses the same values).

import { cardContent } from "./prompt/card";
import { readingCut, readingMatch, type PromptMatch } from "./prompt/matcher";
import type { PanePrompt } from "./prompt/view";
import type { SidebarRow } from "./sidebar-model";

export type NeedsPillKind = "approval" | "input";

/** T3's words. */
export const needsPillLabel: Readonly<Record<NeedsPillKind, string>> = {
  approval: "Pending Approval",
  input: "Awaiting Input",
};

export interface NeedsPillTone {
  /** The pill's words (light: T3's text-amber-600; dark: Halo's approval). */
  readonly text: string;
  /** The pill's dot and the row's dot (light: T3's bg-amber-500; dark: Halo's approval). */
  readonly dot: string;
}

/**
 * Dark (the window): Halo's approval yellow and input violet, words and dot
 * alike. Light: Tailwind v4's amber and indigo (oklch) as T3 uses them, text
 * -600 and dot -500. tokens.css carries them as light-dark() pairs
 * (--approval, --approval-text, --input, --input-text).
 */
export const needsPillColors: Readonly<Record<NeedsPillKind, { readonly light: NeedsPillTone; readonly dark: NeedsPillTone }>> = {
  approval: {
    light: { text: "oklch(66.6% 0.179 58.318)", dot: "oklch(76.9% 0.188 70.08)" },
    dark: { text: "#f5cb45", dot: "#f5cb45" },
  },
  input: {
    light: { text: "oklch(51.1% 0.262 276.966)", dot: "oklch(58.5% 0.233 277.117)" },
    dark: { text: "#bba7ff", dot: "#bba7ff" },
  },
};

/** The Needs card's matcher's reading: an approval, or input (a question, or nothing known). */
export function needsPillKind(match: PromptMatch | null | undefined): NeedsPillKind {
  if (match === null || match === undefined) return "input";
  return cardContent(match, null).kind === "asks" ? "input" : "approval";
}

export interface NeedsPill {
  readonly kind: NeedsPillKind;
  readonly label: string;
}

/** The row's pill: only while Herdr says it needs you. */
export function needsPill(row: Pick<SidebarRow, "glyph">, kind: NeedsPillKind | undefined): NeedsPill | null {
  if (row.glyph !== "needsYou") return null;
  const resolved = kind ?? "input";
  return { kind: resolved, label: needsPillLabel[resolved] };
}

/**
 * Each blocked pane main reads, keyed as the sidebar's rows are (desktop-sidebar rowKey).
 * What looks like Claude's approval frame read without its header is an approval (the pill answers nothing).
 */
export function needsPillKinds(prompts: readonly PanePrompt[]): ReadonlyMap<string, NeedsPillKind> {
  return new Map(
    prompts.map((prompt) => [`${prompt.hostId}/${prompt.paneId}`, readingCut(prompt.reading) !== null ? "approval" : needsPillKind(readingMatch(prompt.reading))]),
  );
}
