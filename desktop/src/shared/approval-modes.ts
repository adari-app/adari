// Each agent's approval mode, read the way the agent shows
// it, for the Permissions chip in the message box's row (T3 Code's
// ComposerContextPermissions: an icon and the mode's word, a menu of the
// agent's own modes with each one's description, the current one checked).
//
// The words are the agent's own; where it shows none for its default, T3's
// "Supervised". T3's icons: a lock for asking modes, a pen for accept edits,
// sparkles for auto modes, a crossed shield for no-prompt modes; a plan icon
// for plan. As each agent draws it (test/support/mode-fixtures.ts):
//
// - Claude Code 2.1.318: the footer's mode row, `⏵⏵ auto mode on (shift+tab to
//   cycle)`, `⏸ manual mode on`, `⏵⏵ accept edits on …`, `⏸ plan mode on …`;
//   Shift+Tab cycles auto → manual → accept edits → plan → auto. `⏵⏵ bypass
//   permissions on` only when it was started so: shown, never offered.
// - Codex 0.166.0: its footer shows no mode. The rollout's newest
//   `turn_context` does (`approval_policy`, `approvals_reviewer`,
//   `sandbox_policy`; Codex's own presets, status_surfaces.rs and
//   tests_permissions.rs); `/permissions` lists them with `(current)`.
// - Grok Build 1.0.70: the box's bottom border, after the model and effort
//   (`Grok 4.6 (high) · always-approve`); its default shows no word; Shift+Tab
//   cycles default → plan → auto-review → always-approve.
// - Cursor Agent 2026.11.05: the model row's right side (`Auto-review`,
//   `Run Everything`, none); `/auto-review` and `/run-everything` toggle one
//   three-way setting (agent-settings.ts reads the footer).
//
// The same rules as Sources/HerdrKit/ApprovalModes.swift.

import { claudeBoxRules } from "./claude-box";

/** The agents with a Permissions chip. */
export type ModeAgent = "claude" | "codex" | "grok" | "cursor";

/** T3 Code's icons (lucide: Lock, PenLine, Sparkles, ShieldOff) and a plan icon. */
export type ModeIcon = "lock" | "pen" | "sparkles" | "shieldOff" | "plan";

export interface ApprovalMode {
  /** The mode's id for the agent ("manual", "approve", "alwaysApprove"). */
  readonly id: string;
  /** The chip's word: the agent's own, or T3's "Supervised" for a default with none. */
  readonly label: string;
  /** The menu's line under it. */
  readonly description: string;
  readonly icon: ModeIcon;
  /** In the chip's menu: Claude's bypass is shown when it is on, never offered (Shift+Tab does not reach it). */
  readonly offered: boolean;
}

const mode = (id: string, label: string, description: string, icon: ModeIcon, offered = true): ApprovalMode => ({ id, label, description, icon, offered });

/** Each agent's modes, in the agent's own order. */
export const approvalModes: Readonly<Record<ModeAgent, readonly ApprovalMode[]>> = {
  claude: [
    mode("manual", "Manual", "Ask before edits and commands.", "lock"),
    mode("acceptEdits", "Accept edits", "Edit files without asking; ask before other actions.", "pen"),
    mode("plan", "Plan", "Read and plan only: no edits or commands until you approve.", "plan"),
    mode("auto", "Auto", "Claude approves routine actions; risky ones still ask.", "sparkles"),
    mode("bypass", "Bypass permissions", "Started with bypass permissions: nothing asks. Shift+Tab does not reach it.", "shieldOff", false),
  ],
  codex: [
    mode("ask", "Ask for approval", "Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace", "lock"),
    mode("approve", "Approve for me", "Only ask for actions detected as potentially unsafe", "sparkles"),
    mode("full", "Full Access", "Use with caution: Codex can edit files outside this workspace and access the internet without approval", "shieldOff"),
    mode("readOnly", "Read Only", "Read workspace files, with approval required for edits or internet access", "lock"),
  ],
  grok: [
    mode("default", "Supervised", "Ask before commands Grok does not know are safe.", "lock"),
    mode("plan", "Plan", "Plan first: no changes until you approve the plan.", "plan"),
    mode("autoReview", "Auto-review", "Grok reviews each action and approves routine ones; others still ask.", "sparkles"),
    mode("alwaysApprove", "Always-approve", "Allow commands and edits without prompts.", "shieldOff"),
  ],
  cursor: [
    mode("default", "Supervised", "Ask before commands Cursor is not allowed to run.", "lock"),
    mode("autoReview", "Auto-review", "Cursor reviews each command and runs the safe ones; others still ask.", "sparkles"),
    mode("runEverything", "Run Everything", "Run every command without asking.", "shieldOff"),
  ],
};

/** A pick while Claude Code shows bypass permissions (it was started so; Shift+Tab does not leave it). */
export const bypassStartNote = "Not set: Claude Code was started with bypass permissions, which Shift+Tab does not leave, so nothing was pressed.";

/** The chip's word while the mode is not known (T3's chip title). */
export const unknownModeLabel = "Permissions";

export function isModeAgent(kind: string | null | undefined): kind is ModeAgent {
  return kind === "claude" || kind === "codex" || kind === "grok" || kind === "cursor";
}

/** The agent's mode `id`, or null. */
export function approvalMode(agent: ModeAgent, id: string | null | undefined): ApprovalMode | null {
  if (id === null || id === undefined) return null;
  return approvalModes[agent].find((candidate) => candidate.id === id) ?? null;
}

/** The modes the chip's menu offers, in the agent's order. */
export function menuModes(agent: ModeAgent): readonly ApprovalMode[] {
  return approvalModes[agent].filter((candidate) => candidate.offered);
}

/** A pick the menu offers. */
export function isOfferedMode(agent: ModeAgent, id: unknown): id is string {
  return typeof id === "string" && menuModes(agent).some((candidate) => candidate.id === id);
}

// MARK: - Claude Code's footer

const claudeModeWords: Readonly<Record<string, string>> = {
  "manual mode": "manual",
  "accept edits": "acceptEdits",
  "plan mode": "plan",
  "auto mode": "auto",
  "bypass permissions": "bypass",
};

/**
 * One footer row's mode (`⏸ manual mode on`, `⏵⏵ accept edits on (shift+tab to cycle)`,
 * `⏵⏵ auto mode on · 1 shell` while a background shell runs, cut or not), or null.
 */
export function claudeModeOfRow(row: string): string | null {
  const text = row.trim();
  const match = /^(?:\u{23F8}|\u{23F5}\u{23F5}) ([a-z]+(?: [a-z]+)?) on(?:$| \(| {2,}|\u{2026}| \u{00B7}(?:$| |\u{2026})| \u{2026})/u.exec(text);
  return match === null ? null : (claudeModeWords[match[1]!] ?? null);
}

/** Claude Code's prompt mark and what follows it (a space, or a no-break space as 2.1.318 draws it). */
const claudePrompt = /^\u{276F}(?:[ \u{00A0}](.*))?$/u;

/** Claude Code's dimmed suggestion in an empty box (`Try "how does … work?"`). */
const claudeSuggestion = /^Try "[^"]*"$/;

/** The bottom of a Claude Code screen: its box (empty: nothing, or its suggestion) and the footer's mode (null: none that reads). */
export interface ClaudeModeScreen {
  readonly draft: string;
  readonly empty: boolean;
  readonly mode: string | null;
}

/** Claude Code's box between its last two rules and the mode row under it; null when no box is at the bottom (or its last rule carries a label). */
export function readClaudeModeScreen(screen: string): ClaudeModeScreen | null {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/u, ""));
  // Its rules (claude-box.ts): the bottom one dashes only, the top one may carry the session's name (2.1.319).
  const rules = claudeBoxRules(lines.map((line) => line.trim()));
  if (rules === null) return null;
  const { top, bottom } = rules;
  if (bottom < 2 || bottom - top < 2) return null;
  const box = lines.slice(top + 1, bottom);
  const first = claudePrompt.exec(box[0]!);
  if (first === null) return null;
  const rest = box.slice(1).filter((line) => line.trim() !== "");
  const head = (first[1] ?? "").trim();
  const draft = [head, ...rest.map((line) => line.trim())].filter((part) => part !== "").join("\n");
  const empty = rest.length === 0 && (head === "" || claudeSuggestion.test(head));
  // The footer's rows under the box: the mode row is its last (an update or tip row may stand after it).
  const rows = lines.slice(bottom + 1).filter((line) => line.trim() !== "");
  let found: string | null = null;
  for (const row of rows) {
    const seen = claudeModeOfRow(row);
    if (seen !== null) found = seen;
  }
  return { draft: empty ? "" : draft, empty, mode: found };
}

// MARK: - Codex's turn_context and its /permissions list

const codexLabels: Readonly<Record<string, string>> = {
  "Ask for approval": "ask",
  "Approve for me": "approve",
  "Full Access": "full",
  "Read Only": "readOnly",
};

/** Codex's word for a mode in its list or history ("Approve for me"), as the mode's id; null for another. */
export function codexModeOfLabel(label: string): string | null {
  return codexLabels[label.trim()] ?? null;
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * A `turn_context` payload's mode by Codex's own presets (0.166.0): Ask for
 * approval (on-request, workspace-write, reviewer user), Approve for me
 * (on-request, workspace-write, reviewer auto_review), Full Access (never,
 * danger-full-access), Read Only (on-request, read-only). Anything else
 * (another policy, no sandbox type) is no preset: null, nothing guessed.
 */
export function codexModeOfTurn(payload: Record<string, unknown>): string | null {
  const approval = payload["approval_policy"];
  const reviewer = payload["approvals_reviewer"];
  const sandbox = recordOf(payload["sandbox_policy"])?.["type"];
  if (typeof approval !== "string" || typeof sandbox !== "string") return null;
  if (sandbox === "danger-full-access") return approval === "never" ? "full" : null;
  if (approval !== "on-request") return null;
  if (sandbox === "read-only") return "readOnly";
  if (sandbox !== "workspace-write") return null;
  if (reviewer === "auto_review") return "approve";
  if (reviewer === undefined || reviewer === null || reviewer === "user") return "ask";
  return null;
}

/** One row of Codex's `/permissions` list. */
export interface CodexPermissionRow {
  /** The digit that picks it. */
  readonly digit: number;
  readonly label: string;
  /** The mode it is (null: a row this app does not know). */
  readonly mode: string | null;
  readonly current: boolean;
  /** The list's arrow is on it. */
  readonly cursor: boolean;
}

/** What a Codex screen shows at its bottom. */
export type CodexScreen =
  /** The box (empty: its placeholder) and the newest history row above it (its text, or null). */
  | { readonly kind: "box"; readonly draft: string; readonly empty: boolean; readonly last: string | null }
  /** "Update Model Permissions": its rows. */
  | { readonly kind: "permissions"; readonly rows: readonly CodexPermissionRow[] }
  /** Codex's own Full Access confirmation, exactly as recorded. */
  | { readonly kind: "fullAccess" }
  | { readonly kind: "other" };

const codexMark = "\u{203A}"; // ›
/** Codex's placeholder in an empty box (0.166.0, every recorded frame). */
export const codexPlaceholders: readonly string[] = ["Ask Codex to do anything"];
const codexHint = "enter select \u{B7} esc back";
const codexRow = new RegExp(`^(${codexMark}| ) (\\d)\\. (.+)$`, "u");

const atMargin = (line: string): boolean => line !== "" && line[0] !== " ";

/** Codex's box line: "› " and the draft or the placeholder at the margin (a list's "› 2. …" row is none). */
function codexBoxText(line: string): string | null {
  if (!atMargin(line) || !line.startsWith(codexMark)) return null;
  const rest = line.slice(codexMark.length);
  if (rest !== "" && rest[0] !== " " && rest[0] !== "\u{00A0}") return null;
  if (/^[ \u{00A0}]\d+[.)] /u.test(rest)) return null;
  return rest.trim();
}

/** A slash popup's row ("/permissions  …"; unrecorded: see readCodexBox). */
const codexPopupRow = /^ +(?:\u{203A} )?(\/[a-z][a-z-]*)(?: {2,}\S.*)?$/u;

/**
 * Codex's box as one input region. From the bottom: the footer, the screen's last
 * lines (one to three rows indented under the margin, the first "model · folder", the last "… for
 * shortcuts", as every recorded frame draws it), one blank line above it, and above that the
 * region: the "› " row at the margin and every row under it (your draft's continuation rows are
 * indented). Any text anywhere in the region is your draft. With the box reading exactly
 * /permissions and nothing else, a slash popup whose first row is /permissions may stand where
 * the footer is (the pick's own read-back and cleanup; that frame was not recorded). Any other
 * shape: null, its extent is not certain.
 */
function readCodexBox(lines: readonly string[]): { box: number; draft: string; empty: boolean } | null {
  const blank = (index: number): boolean => lines[index]!.trim() === "";
  let end = lines.length - 1;
  while (end >= 0 && blank(end)) end -= 1;
  if (end < 0) return null;
  let top = end;
  while (top > 0 && !blank(top - 1) && !atMargin(lines[top - 1]!)) top -= 1;
  const zone = lines.slice(top, end + 1);
  const footer = zone.length <= 3 && zone.every((line) => !atMargin(line)) && zone[0]!.includes(" \u{B7} ") && zone.at(-1)!.includes("for shortcuts");
  const popup = !footer && zone.length <= 8 && zone.every((line) => codexPopupRow.test(line)) && codexPopupRow.exec(zone[0]!)![1] === codexPermissionsCommand;
  if (!footer && !popup) return null;
  // One blank line above the footer (the popup may sit right under the box).
  let below = top;
  if (top > 0 && blank(top - 1)) below = top - 1;
  else if (!popup) return null;
  let box = below - 1;
  while (box >= 0 && !atMargin(lines[box]!)) box -= 1;
  if (box < 0) return null;
  const text = codexBoxText(lines[box]!);
  if (text === null) return null;
  // Every row between the box and the blank above the footer: your draft's continuation rows (indented two).
  const rest = lines.slice(box + 1, below).map((line) => (line.startsWith("  ") ? line.slice(2) : line.trim()));
  const restEmpty = rest.every((line) => line.trim() === "");
  if (popup && (text !== codexPermissionsCommand || box + 1 !== below)) return null;
  const empty = codexPlaceholders.includes(text) && restEmpty;
  return { box, draft: empty ? "" : [text, ...rest].join("\n"), empty };
}

/** Codex 0.166.0's /permissions rows, in order, each label and description as recorded (codex-01). */
const codexListRows: readonly { readonly label: string; readonly words: string }[] = [
  { label: "Ask for approval", words: "Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace" },
  { label: "Approve for me", words: "Only ask for actions detected as potentially unsafe" },
  { label: "Full Access", words: "Use with caution: Codex can edit files outside this workspace and access the internet without approval" },
  { label: "Read Only", words: "Read workspace files, with approval required for edits or internet access" },
];

/** Codex's Full Access confirmation as recorded (codex-04), its words with every run of whitespace one space. */
const codexConfirmWords = [
  "Enable full access?",
  "When Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval.",
  "Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or unexpected behavior.",
  "\u{203A} 1. Yes, continue anyway Apply full access for this session",
  "2. Cancel Go back without enabling full access",
  codexHint,
].join(" ");

const foldSpaces = (text: string): string => text.split(/\s+/u).filter((part) => part !== "").join(" ");

/**
 * The list's rows, only as recorded: the four rows in order (digit, label, its
 * description, wrapped at any width under its column), the `(current)` mark on exactly one, the
 * arrow on exactly one, blank lines only before the first row and after the last. Else null.
 */
function readCodexListRows(lines: readonly string[]): CodexPermissionRow[] | null {
  const rows: { digit: number; label: string; current: boolean; cursor: boolean; words: string }[] = [];
  let ended = false;
  for (const line of lines) {
    if (line.trim() === "") {
      if (rows.length > 0) ended = true;
      continue;
    }
    if (ended) return null;
    const match = codexRow.exec(line);
    if (match !== null) {
      const [head, ...rest] = match[3]!.split(/ {2,}/u);
      if (rest.length === 0) return null;
      const { label, current } = codexRowLabel(head!);
      rows.push({ digit: Number(match[2]), label, current, cursor: match[1] === codexMark, words: rest.join(" ") });
      continue;
    }
    // A description's wrapped rest: under its column, deeper than the row's digit.
    if (rows.length === 0 || !line.startsWith("    ")) return null;
    rows.at(-1)!.words += ` ${line.trim()}`;
  }
  if (rows.length !== codexListRows.length) return null;
  const recorded = rows.every(
    (row, index) => row.digit === index + 1 && row.label === codexListRows[index]!.label && foldSpaces(row.words) === codexListRows[index]!.words,
  );
  if (!recorded || rows.filter((row) => row.current).length !== 1 || rows.filter((row) => row.cursor).length !== 1) return null;
  return rows.map(({ digit, label, current, cursor }) => ({ digit, label, mode: codexModeOfLabel(label), current, cursor }));
}

/**
 * The Full Access confirmation, only the whole recorded dialog: from its title to its
 * hint, its words exactly (whitespace and wrapping aside; the arrow on Yes, as recorded); under it only
 * blank lines and then the box. Its title's line, else null.
 */
function readCodexConfirm(lines: readonly string[]): number | null {
  const title = lines.findLastIndex((line) => line.trim() === "Enable full access?");
  if (title < 0) return null;
  const hint = lines.findIndex((line, index) => index > title && line.trim() === codexHint);
  if (hint < 0 || foldSpaces(lines.slice(title, hint + 1).join(" ")) !== codexConfirmWords) return null;
  const tail = lines.slice(hint + 1);
  if (tail.every((line) => line.trim() === "")) return title;
  const box = readCodexBox(lines);
  if (box === null || box.box <= hint || !lines.slice(hint + 1, box.box).every((line) => line.trim() === "")) return null;
  return title;
}

/** A list-shaped frame (its title, its hint the last line) whatever its rows: Esc closes it. */
export function codexListShowing(screen: string): boolean {
  const lines = screen.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1) === codexHint && lines.includes("Update Model Permissions");
}

/** A list row's label and whether it is current: "Approve for me (current)  Only ask …" → ("Approve for me", true). */
function codexRowLabel(text: string): { label: string; current: boolean } {
  const label = text.split(/ {2,}/u)[0]!.trim();
  return label.endsWith(" (current)") ? { label: label.slice(0, -" (current)".length).trim(), current: true } : { label, current: false };
}

/**
 * Reads the bottom of a Codex screen (0.166.0's shapes, the codex-modes
 * reference's codex/): the Full Access confirmation (above the box, as
 * recorded), the `/permissions` list (its hint the last line), or the box at
 * the margin with the history row above it. Anything else is "other".
 */
export function readCodexScreen(screen: string): CodexScreen {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/u, ""));
  const nonEmpty = lines.map((line, index) => ({ line, index })).filter((entry) => entry.line.trim() !== "");
  const lastLine = nonEmpty.at(-1);
  if (lastLine === undefined) return { kind: "other" };
  // The confirmation: the whole recorded dialog; those words elsewhere (your own history) read on.
  if (readCodexConfirm(lines) !== null) return { kind: "fullAccess" };
  // The list: its title, its rows, its hint as the screen's last line.
  if (lastLine.line.trim() === codexHint) {
    let head = -1;
    for (let index = lastLine.index - 1; index >= 0; index -= 1) {
      if (lines[index]!.trim() === "Update Model Permissions") {
        head = index;
        break;
      }
    }
    if (head < 0) return { kind: "other" };
    // Only the four recorded rows; anything else is refused before any digit.
    const rows = readCodexListRows(lines.slice(head + 1, lastLine.index));
    return rows === null ? { kind: "other" } : { kind: "permissions", rows };
  }
  // The box: its whole input region above its footer.
  const box = readCodexBox(lines);
  if (box === null) return { kind: "other" };
  // The newest history row: the first line at the margin above the box (its wrapped rest is indented).
  let last: string | null = null;
  for (let index = box.box - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!atMargin(line)) continue;
    last = line.trim();
    break;
  }
  return { kind: "box", draft: box.draft, empty: box.empty, last };
}

/** A history row naming a mode Codex set (`• Permission selection requested: Ask for approval`, `• Permissions updated to Full Access`), as its id; else null. */
export function codexHistoryMode(row: string | null): string | null {
  if (row === null) return null;
  const match = /^\u{2022} (?:Permission selection requested: |Permissions updated to )(.+?)\.?$/u.exec(row.trim());
  return match === null ? null : codexModeOfLabel(match[1]!);
}

/**
 * The modes Codex's history rows above its box name, oldest first (each `• Permission
 * selection requested: …` or `• Permissions updated to …`): a pick's baseline, so only a row new to the pick
 * acknowledges it.
 */
export function codexAcknowledgements(screen: string): string[] {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/u, ""));
  const box = lines.findLastIndex((line) => codexBoxText(line) !== null);
  if (box < 0) return [];
  return lines
    .slice(0, box)
    .filter(atMargin)
    .map((line) => codexHistoryMode(line))
    .filter((mode): mode is string => mode !== null);
}

/**
 * The acknowledgement new to a pick, from the acknowledgements before it and after it,
 * oldest first (codexAcknowledgements over Herdr's recent lines, whose oldest rows may scroll out).
 * The rows after are what survives of the rows before (a run at their end) and then the rows appended.
 * Taking the longest such overlap (the fewest rows appended), the newest row is new when it is not part
 * of it: its mode. Else null: nothing new, or new and old not told apart.
 */
export function codexNewAcknowledgement(before: readonly string[], after: readonly string[]): string | null {
  if (after.length === 0) return null;
  for (let overlap = Math.min(before.length, after.length); overlap > 0; overlap -= 1) {
    const surviving = before.slice(before.length - overlap);
    if (surviving.every((mode, index) => mode === after[index])) return overlap < after.length ? after.at(-1)! : null;
  }
  return after.at(-1)!;
}

// MARK: - Grok's border and Cursor's model row

const grokModeWords: Readonly<Record<string, string>> = { plan: "plan", "auto-review": "autoReview", "always-approve": "alwaysApprove" };

/** The word after the border's model and effort (`always-approve`), as the mode's id; undefined (none): the default. */
export function grokModeOfWord(word: string | undefined): string | null {
  if (word === undefined) return "default";
  return grokModeWords[word.trim()] ?? null;
}

/** Cursor's model row's right side (`Auto-review`, `Run Everything`; nothing: the default), as the mode's id. */
export function cursorModeOfWord(word: string | undefined): string | null {
  if (word === undefined) return "default";
  if (word === "Auto-review") return "autoReview";
  if (word === "Run Everything") return "runEverything";
  return null;
}

/**
 * The command a Cursor pick types next from `current` toward `target`: the
 * target's own toggle, or to go back to the default the current one's (they
 * are one three-way setting; reference frames 07-12). Null when it is so.
 */
export function cursorModeCommand(current: string, target: string): "/auto-review" | "/run-everything" | null {
  if (current === target) return null;
  const toggle = (id: string): "/auto-review" | "/run-everything" | null => (id === "autoReview" ? "/auto-review" : id === "runEverything" ? "/run-everything" : null);
  return target === "default" ? toggle(current) : toggle(target);
}

/**
 * Each agent's modes from the one that allows least to the one that allows most (Claude's
 * Plan reads and plans only; Manual asks before edits and commands; Accept edits edits without asking; Auto
 * approves routine actions; bypass asks nothing).
 */
const permissiveness: Readonly<Record<ModeAgent, readonly string[]>> = {
  claude: ["plan", "manual", "acceptEdits", "auto", "bypass"],
  grok: ["plan", "default", "autoReview", "alwaysApprove"],
  cursor: ["default", "autoReview", "runEverything"],
  codex: ["readOnly", "ask", "approve", "full"],
};

/** Claude Code's and Grok's Shift+Tab order (each press moves one on, round to the first). */
export const cycleOrders: Readonly<Record<"claude" | "grok", readonly string[]>> = {
  claude: ["auto", "manual", "acceptEdits", "plan"],
  grok: ["default", "plan", "autoReview", "alwaysApprove"],
};

/** `shown` allows more than both `start` and `target` (unknown ids: false). */
export function allowsMore(agent: ModeAgent, shown: string, start: string, target: string): boolean {
  const rank = (id: string): number => permissiveness[agent].indexOf(id);
  const [at, from, to] = [rank(shown), rank(start), rank(target)];
  return at >= 0 && from >= 0 && to >= 0 && at > Math.max(from, to);
}

/** The modes a Shift+Tab route from `start` to `target` passes that allow more than both. */
export function cyclePassing(agent: "claude" | "grok", start: string, target: string): string[] {
  const order = cycleOrders[agent];
  const from = order.indexOf(start);
  const to = order.indexOf(target);
  if (from < 0 || to < 0) return [];
  const between: string[] = [];
  for (let at = (from + 1) % order.length; at !== to; at = (at + 1) % order.length) between.push(order[at]!);
  return between.filter((mode) => allowsMore(agent, mode, start, target));
}

/** Claude Code's and Grok's Shift+Tab, in Herdr's key names (tmux's BTab). */
export const shiftTabKey = "BTab";
/** At most this many Shift+Tabs per pick (each agent's cycle is four long). */
export const cyclePressLimit = 4;
/** At most this many Cursor commands per pick (the cross-toggle case turns both off first). */
export const cursorCommandLimit = 2;
/** Codex's own command for its list. */
export const codexPermissionsCommand = "/permissions";
