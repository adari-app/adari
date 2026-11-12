// The needs-you card's words and keys (App/CompanionChatModel.swift:
// CompanionChatDisplay.agentName, CompanionChatCardContent, CompanionChatAnswer,
// CompanionChatCardKeys), from the prompt matcher's reading of the pane's own
// screen, never the transcript: the header by kind, the file or command, up to
// six diff rows and "N more", the question in the agent's words, the options
// in the menu's order, the one Return picks, and the "No, tell…" option the
// box answers with.
//
// Claude's command of more than one row shows as a block, its first six rows
// and "N more" (as diff rows), with the description Claude draws over it.
//
// Codex's tool-call question (its MCP elicitation form):
// "Codex wants to use a tool", Codex's header as the question, its parameter
// rows, and each option's label with its description, in Codex's order (Always
// allow too, in its words).
//
// The desktop's keys differ from the Swift Mac's in one rule:
// they are the card's only while no text field has focus (the Swift app asked
// for an empty box); with a field focused every key is the field's.

import { knownAgentName } from "../agent-names";
import type { PromptMatch, PromptOption } from "./matcher";

export type CardLineKind = "context" | "added" | "removed";

/** One row of the change the card shows (from the prompt's own frame). */
export interface CardLine {
  readonly number: string | null;
  readonly kind: CardLineKind;
  readonly text: string;
}

export type CardKind = "edit" | "run" | "create" | "asks" | "tool" | "update";

export interface CardContent {
  readonly kind: CardKind;
  /** "Claude wants to edit", "Codex wants to run", "Claude asks". */
  readonly header: string;
  /** The file or the command, in mono. */
  readonly target: string | null;
  /** Grok's command, shown whole under the title (its frame's `│` rows); null for every other card. */
  readonly command: string | null;
  /** The tool call's parameter rows under Codex's question, as drawn; empty for every other card. */
  readonly parameters: readonly string[];
  /** The description Claude draws over a command of more than one row; null elsewhere. */
  readonly description: string | null;
  /** Such a command's first six rows, in mono under the header; empty elsewhere. */
  readonly commandRows: readonly string[];
  /** Its rows past the six shown ("N more"). */
  readonly commandMore: number;
  readonly lines: readonly CardLine[];
  /** The diff rows past the six shown ("N more"). */
  readonly moreLines: number;
  readonly question: string;
  readonly options: readonly PromptOption[];
  /** The option Return picks in the pane (filled vermilion); 0 without one. */
  readonly returnIndex: number;
  /** "No, tell Claude what to do differently": text typed in the box and Send answer with it. */
  readonly tellOption: PromptOption | null;
}

export const keptLines = 6;

/** The pane's agent as the card and the box name it (the shared table's name). */
export function agentName(kind: string | null | undefined): string {
  const lower = kind?.toLowerCase();
  const known = knownAgentName(lower);
  if (known !== null) return known;
  if (lower !== undefined && lower !== "" && lower !== "agent") return lower.charAt(0).toUpperCase() + lower.slice(1);
  return "The agent";
}

export function cardContent(match: PromptMatch, agentKind: string | null | undefined): CardContent {
  const agent = agentName(agentKind);
  const body = match.fingerprint.body;
  const parsed = body.map(diffLine).filter((line): line is CardLine => line !== null);
  let kind: CardKind;
  let header: string;
  let target: string | null;
  let command: string | null = null;
  let parameters: readonly string[] = [];
  let description: string | null = null;
  let commandRows: readonly string[] = [];
  const context = match.context;
  if (match.kind === "codexUpdate") {
    // Codex's update question: its first line as the question, its choices in its words.
    kind = "update";
    header = `${agent} has an update`;
    target = null;
  } else if (match.kind === "codexForm") {
    // Codex's header as the question, its parameter rows under it.
    kind = "tool";
    header = `${agent} wants to use a tool`;
    target = null;
    parameters = context?.type === "parameters" ? context.rows : [];
  } else if (match.kind === "grok") {
    // "Grok wants to run", the frame's title as the question, the command whole under it.
    kind = "run";
    header = `${agent} wants to run`;
    target = null;
    command = context?.type === "command" ? context.text : null;
  } else if (context?.type === "diff") {
    kind = "edit";
    header = `${agent} wants to edit`;
    target = editTarget(body, match.question);
  } else if (context?.type === "command") {
    kind = "run";
    header = `${agent} wants to run`;
    target = context.text;
    // Claude's command of more than one row, as a block with its description.
    if (match.run !== undefined && match.run.rows.length > 1) {
      target = null;
      description = match.run.description;
      commandRows = match.run.rows;
    }
  } else if (context?.type === "file") {
    kind = "create";
    header = `${agent} wants to create`;
    target = context.name;
  } else if (parsed.length === 0) {
    kind = "asks";
    header = `${agent} asks`;
    target = null;
  } else {
    kind = "edit";
    header = `${agent} wants to edit`;
    target = editTarget(body, match.question);
  }
  const shown = kind === "edit" ? parsed : [];
  const returnIndex = match.options.findIndex((option) => option.isReturnDefault);
  return {
    kind,
    header,
    target,
    command,
    parameters,
    description,
    commandRows: commandRows.slice(0, keptLines),
    commandMore: Math.max(0, commandRows.length - keptLines),
    lines: shown.slice(0, keptLines),
    moreLines: Math.max(0, shown.length - keptLines),
    question: match.question,
    options: match.options,
    returnIndex: returnIndex < 0 ? 0 : returnIndex,
    tellOption: match.options.find((option) => option.opensComposer) ?? null,
  };
}

/** "Tell Claude what to do instead (answers 3)". */
export function tellPlaceholder(agentKind: string | null | undefined, tell: PromptOption): string {
  return `Tell ${agentName(agentKind)} what to do instead (answers ${tell.key})`;
}

/** The box's words while the card shows a question it cannot answer in words. */
export function waitingPlaceholder(agentKind: string | null | undefined): string {
  return `${agentName(agentKind)} is waiting on the question above`;
}

/** The line under the options: the keys, and the box's option when there is one. */
export function keyHint(content: CardContent): string {
  let hint = "↑ ↓ to choose · Return picks";
  if (content.tellOption !== null) hint += ` · or type below to answer ${content.tellOption.key} in your words`;
  return hint;
}

/** "N more" under the diff rows. */
export function moreLinesLabel(count: number): string | null {
  return count <= 0 ? null : `${count} more ${count === 1 ? "line" : "lines"}`;
}

/**
 * A row of Claude's diff as its frame draws it: "41 +    code", "88 -  code",
 * "87     context". Rows without a line number are not diff rows.
 */
export function diffLine(row: string): CardLine | null {
  const trimmed = row.replace(/^ +/, "");
  const digits = /^\p{Nd}+/u.exec(trimmed)?.[0] ?? "";
  if (digits === "") return null;
  let rest = trimmed.slice(digits.length);
  if (!rest.startsWith(" ")) return rest === "" ? { number: digits, kind: "context", text: "" } : null;
  rest = rest.slice(1);
  let kind: CardLineKind = "context";
  if (rest.startsWith("+")) kind = "added";
  else if (rest.startsWith("-") || rest.startsWith("−")) kind = "removed";
  if (kind !== "context") rest = rest.slice(1);
  if (rest.startsWith(" ")) rest = rest.slice(1);
  return { number: digits, kind, text: rest };
}

/** The edit's file: the first body row that reads as a path, else the last path-like word of the question. */
export function editTarget(body: readonly string[], question: string): string | null {
  for (const row of body) {
    const text = row.trim();
    if (text !== "" && !text.includes(" ") && (text.includes("/") || text.includes(".")) && diffLine(text) === null) return text;
  }
  const words = question
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => word.replace(/^[?.,:;"'“”]+|[?.,:;"'“”]+$/gu, ""));
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index]!;
    if (word.includes("/") || (word.includes(".") && [...word].length > 3 && !word.endsWith("."))) return word;
  }
  return null;
}

/** What a Send from the box answers with: the tell option, unless an answer is already going or there is nothing to send. */
export function sendAnswers(tell: PromptOption | null, alreadyAnswering: boolean, canSend: boolean): PromptOption | null {
  return tell !== null && !alreadyAnswering && canSend ? tell : null;
}

export type CardKeyAction = { readonly type: "none" } | { readonly type: "select"; readonly index: number } | { readonly type: "pick"; readonly index: number };

export interface CardKey {
  /** KeyboardEvent.key. */
  readonly key: string;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
  /** A text field (the box, a search, a rename) has the focus: every key is its own. */
  readonly textFocused: boolean;
  readonly composing?: boolean;
}

const none: CardKeyAction = { type: "none" };

/** The card's keys while no text field has focus: ↑ ↓ move, Return picks, 1–9 pick directly. */
export function cardKeyAction(event: CardKey, options: readonly PromptOption[], selection: number): CardKeyAction {
  if (event.textFocused || event.composing === true || options.length === 0) return none;
  if (event.shift === true || event.ctrl === true || event.alt === true || event.meta === true) return none;
  const current = Math.min(Math.max(selection, 0), options.length - 1);
  switch (event.key) {
    case "ArrowUp":
      return { type: "select", index: Math.max(0, current - 1) };
    case "ArrowDown":
      return { type: "select", index: Math.min(options.length - 1, current + 1) };
    case "Enter":
      return { type: "pick", index: current };
    default:
      break;
  }
  if (!/^[1-9]$/.test(event.key)) return none;
  const index = options.findIndex((option) => option.key === event.key);
  if (index >= 0) return { type: "pick", index };
  // A [y/N] question's options carry letters: 1 and 2 pick them in order.
  const digit = Number(event.key);
  return digit <= options.length && !options.some((option) => /^\d+$/.test(option.key)) ? { type: "pick", index: digit - 1 } : none;
}
