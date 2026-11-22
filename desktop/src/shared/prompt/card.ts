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
// Claude Code's question dialog: "Claude asks", the question, and one option
// per real choice with its description under it, in Claude's order. Typing an
// own answer (Claude's `Type something.`) and `Chat about this` stay in the
// Terminal: the card says so in one plain line next to Answer in Terminal.
//
// Codex's own question in Plan mode: "Codex asks", "Question 1 of 2" when it
// asks more than one, the question, one option per asked choice with its
// description (its "(Recommended)" as Codex wrote it), and a line saying where
// the answer goes (the next question, or all the answers sent). Codex's "None
// of the above" is no option here: the way out is Answer in Terminal, where the
// notes are typed, said in one line beside it. Its "Implement this plan?" list:
// "Codex asks", the question, its three choices with their descriptions, and a
// line saying both Yes choices start the work now.
//
// The desktop's keys differ from the Swift Mac's in one rule:
// they are the card's only while no text field has focus (the Swift app asked
// for an empty box); with a field focused every key is the field's.

import { knownAgentName } from "../agent-names";
import { agyAskKind, agyEditHint, type CodexQuestionProgress, type PromptMatch, type PromptOption } from "./matcher";

export type CardLineKind = "context" | "added" | "removed";

/** One row of the change the card shows (from the prompt's own frame). */
export interface CardLine {
  readonly number: string | null;
  readonly kind: CardLineKind;
  readonly text: string;
}

export type CardKind = "edit" | "run" | "create" | "asks" | "tool" | "update" | "trust";

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
  /**
   * The card's first selection (filled vermilion): the option Return picks in the pane; 0 without one. On agy's
   * command card never a grant that lasts (then its first option that is not).
   */
  readonly returnIndex: number;
  /** "No, tell Claude what to do differently": text typed in the box and Send answer with it. */
  readonly tellOption: PromptOption | null;
  /** Where the person's own words answer, beside Answer in Terminal (Claude's question dialog); null elsewhere. */
  readonly ownAnswer: string | null;
  /** "Question 1 of 2" over the question, when Codex asks more than one; null elsewhere. */
  readonly progress: string | null;
  /** What the answer does, under the options (Codex's own question and its plan question); null elsewhere. */
  readonly flow: string | null;
}

/** The line beside Answer in Terminal under Codex's own question: its "None of the above" is answered there, with notes. */
export const codexOtherLine = "None of the above: add your notes in the Terminal.";
/** The line under the "Implement this plan?" choices. */
export const codexPlanLine = "Either Yes starts the work now. No keeps Codex in Plan mode.";

/** "Question 1 of 2", when Codex asks more than one; null for one alone. */
export function codexProgressLine(progress: CodexQuestionProgress | undefined): string | null {
  return progress === undefined || progress.total <= 1 ? null : `Question ${progress.index} of ${progress.total}`;
}

/**
 * Where the answer to Codex's own question goes: on to the next question, or (the last) every answer sent. On the
 * last with more than one unanswered, another question has none yet: Codex then asks "Submit with unanswered
 * questions?" (request_user_input/mod.rs go_next_or_submit), which is answered in the Terminal. With one
 * unanswered the header cannot tell whether it is this question or an earlier one (this one answered before, the
 * person gone back), so the line says both: the tap answers this question, then Codex sends them all or asks first.
 */
export function codexFlowLine(progress: CodexQuestionProgress | undefined): string | null {
  if (progress === undefined) return null;
  if (progress.total === 1) return "Your answer goes to Codex at once.";
  if (progress.index < progress.total) return `Your answer moves Codex on to question ${progress.index + 1}.`;
  if (progress.unanswered > 1) return "Another question has no answer yet: Codex will ask in the Terminal before it sends.";
  return `This answers question ${progress.index}. Codex then sends all ${progress.total} answers, or asks in the Terminal first if another question still has no answer.`;
}

/** The line beside Answer in Terminal under Claude's question dialog. */
export const ownAnswerLine = "To type your own answer, use the Terminal.";
/** The lines beside Answer in Terminal under Antigravity CLI's permission questions (its amend and full diff keys stay there). */
export const agyCommandLine = "To amend the command, use the Terminal.";
export const agyFileLine = "To see the full diff, use the Terminal.";

/** A row of agy's diff as its question draws it, "  1  +  hello"; another row of its body is a plain row. */
export function agyDiffLine(row: string): CardLine {
  const found = /^\s*(\p{Nd}+) {2}([+-]| ) {2}(.*)$/u.exec(row);
  if (found === null) return { number: null, kind: "context", text: row.trim() };
  const kind: CardLineKind = found[2] === "+" ? "added" : found[2] === "-" ? "removed" : "context";
  return { number: found[1]!, kind, text: found[3]! };
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
  // Antigravity CLI's questions: its own words, its diff rows by its own drawing.
  let agyLines: readonly CardLine[] | null = null;
  let ownAnswer: string | null = match.kind === "claudeAsk" ? ownAnswerLine : null;
  let progress: string | null = null;
  let flow: string | null = null;
  const agyAsk = agyAskKind(match);
  if (match.kind === "agyTrust") {
    // The folder, and "No, exit" said to quit agy (its detail).
    kind = "trust";
    header = `${agent} asks to trust this folder`;
    target = context?.type === "file" ? context.name : null;
  } else if (agyAsk === "command") {
    kind = "run";
    header = `${agent} wants to run`;
    target = context?.type === "command" ? context.text : null;
    if (match.run !== undefined && match.run.rows.length > 1) {
      target = null;
      commandRows = match.run.rows;
    }
    ownAnswer = agyCommandLine;
  } else if (agyAsk !== null) {
    // The body: the title, the path with its counts, the diff rows (agy's hint over the edit question left out).
    kind = agyAsk === "create" ? "create" : "edit";
    header = `${agent} wants to ${kind}`;
    // The fingerprint keeps the body's blank rows; the card shows its rows with words.
    const words = body.filter((row) => row.trim() !== "");
    const subject = /^(\S.*?) {2}\+\d+(?: -\d+)?$/u.exec((words[1] ?? "").trim());
    target = subject?.[1] ?? null;
    agyLines = words.slice(2).filter((row) => row.trim() !== agyEditHint).map(agyDiffLine);
    ownAnswer = agyFileLine;
  } else if (match.kind === "claudeAsk") {
    // Claude's question dialog: the question in its words, its choices with their descriptions.
    kind = "asks";
    header = `${agent} asks`;
    target = null;
  } else if (match.kind === "codexQuestion") {
    // Codex's own question: where it stands, where the answer goes, and None of the above in the Terminal.
    kind = "asks";
    header = `${agent} asks`;
    target = null;
    progress = codexProgressLine(match.codexProgress);
    flow = codexFlowLine(match.codexProgress);
    ownAnswer = codexOtherLine;
  } else if (match.kind === "codexPlan") {
    // "Implement this plan?": its choices in Codex's words, and that both Yes choices start the work.
    kind = "asks";
    header = `${agent} asks`;
    target = null;
    flow = codexPlanLine;
  } else if (match.kind === "codexUpdate") {
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
  const shown = agyLines ?? (kind === "edit" ? parsed : []);
  let returnIndex = match.options.findIndex((option) => option.isReturnDefault);
  // agy's command card: a grant that lasts ("always allow", options 2 and 3) is never the card's first selection,
  // wherever the terminal's marker sits; it is picked only by a click, its digit or moving to it in the card.
  if (agyAsk === "command" && match.options[returnIndex]?.isSessionWide === true) returnIndex = match.options.findIndex((option) => !option.isSessionWide);
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
    ownAnswer,
    progress,
    flow,
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
