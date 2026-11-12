// The twin of HerdrKit's AgentUpdateLine and
// AgentUpdateWatch (Sources/HerdrKit/AgentUpdateMark.swift). Claude Code's
// native installer updates the binary in the background; a running session
// keeps its version until it restarts and says so on its own screen, right
// above its prompt box's top rule:
//
//     ⏺ The last reply.
//
//                                   ✔ Update installed · Restart to update
//     ──────────────────────────────────────  (the box's top rule)
//     ❯
//     ──────────────────────────────────────
//
// readUpdateLine reads that line only in its footer position (colour codes and
// padding off; wrapped or cut at a narrow width), never in the conversation.
// The conversation's last row may stand right above the line with no blank
// between; then each footer row must be right-aligned to the
// rule's right end, as Claude Code draws the line.
// UpdateWatch says which agent panes to read and when: once on sight, every 5
// minutes from the last answer, and when a pane turns idle or done (never
// within 30 s); one read a pane at a time; the covered CLIs only, never a shell, an
// exited agent or an offline machine. 20 agent panes: 4 reads a minute at rest.
// Once a pane on the machine is marked (one watch a machine),
// every other watched pane not marked is read every 60 s instead, for at most
// 30 minutes from the first mark (a session started after the install never
// shows the line); the marked panes stay at 5 minutes. With no pane marked any
// more, the next mark starts a new 30 minutes.
// Herdr's protocol 22 carries no CLI version per pane (fixtures/protocol22), so
// the screen is the only per-pane signal.
//
// Every agent CLI in the start-command table whose screen says it has an
// update is read the same budgeted way (UpdateWatch, the same short read).
// Covered, each from what the CLI itself prints:
//
// - Claude Code: "✔ Update installed · Restart to update" above its box
//   (readUpdateLine): installed; the running session keeps its version.
// - Codex: "✨ Update available! 0.167.0 -> 0.168.0" with "Run <command> to
//   update." (or "See https://github.com/openai/codex for installation
//   options."), then "See full release notes:", in the bordered history cell
//   Codex adds when it starts (codex-rs tui/src/history_cell), or the same
//   first line with "Release notes: …" and "Update now (runs `<command>`)" in
//   its startup prompt (codex-rs tui/src/update_prompt.rs); each string as the
//   published @openai/codex 0.167.0 binary carries it (readCodexUpdateNotice).
//   Available, not installed: you update it, then the session restarts.
//
// Not covered (nothing they print could be read from a public source): Grok
// Build and Cursor Agent. A kind with no readable notice is never read.

import { claudeBoxRules, isClaudeBottomRule } from "./claude-box";

/** The agents whose update notice is known: Claude Code's line, Codex's notice. */
export const updateLineKinds: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * What each covered CLI's mark says (the sidebar's tooltip, the header's card, Settings › Updates):
 * what its screen said and what to do, in its own words. The restart is the card's "Restart on the new version"
 * (agent-restart.ts restartKinds: /exit, then the kind's resume command), or /exit and Resume by hand.
 */
export interface AgentUpdateWords {
  /** The mark's name ("Update ready", "Update available"). */
  readonly label: string;
  /** The CLI as it names itself. */
  readonly cli: string;
  /** What to do, in one or two sentences. */
  readonly words: string;
}

export const agentUpdateWords: Readonly<Record<string, AgentUpdateWords>> = {
  claude: { label: "Update ready", cli: "Claude Code", words: "Claude Code update installed. /exit when it\u2019s idle, then Resume." },
  codex: {
    label: "Update available",
    cli: "Codex",
    words: "Codex has a newer version. Update it on the machine with the command Codex shows, then /exit when it\u2019s idle and Resume.",
  },
};

/** The words for a pane of `kind` (Claude Code's for an unknown kind). */
export function updateWordsFor(kind: string | null | undefined): AgentUpdateWords {
  const key = (kind ?? "").toLowerCase();
  return Object.hasOwn(agentUpdateWords, key) ? agentUpdateWords[key]! : agentUpdateWords["claude"]!;
}

/** What the pane's screen says for `kind`: true (an update), false (none: Claude's box without the line), null (not known: keep). */
export function readAgentUpdate(kind: string, screen: string): boolean | null {
  switch (kind.toLowerCase()) {
    case "claude":
      return readUpdateLine(screen);
    case "codex":
      return readCodexUpdateNotice(screen);
    default:
      return null;
  }
}

/** Codex's first line: an optional sparkle, "Update available!", then the running and the new version. */
const codexNotice = /^(?:\u2728\uFE0F?\s*)?Update available!\s+v?\d+(?:\.\d+)+\S*\s+->\s+v?\d+(?:\.\d+)+\S*$/u;
/** What follows it in the history cell or the startup prompt (each string as Codex 0.167.0 carries it). */
const codexFollowers: readonly RegExp[] = [
  /^Run \S.* to update\.$/u,
  /^See https:\/\/github\.com\/openai\/codex for installation options\.$/u,
  /^See full release notes:$/u,
  /^Release notes: https:\/\/github\.com\/openai\/codex\/releases\/latest$/u,
  /^(?:\u203A\s*)?(?:1\.\s+)?Update now \(runs `/u,
];

/** A row with Codex's cell border (│ … │) and its indent taken off. */
function codexRow(line: string): string {
  let row = line.trim();
  if (row.startsWith("\u2502")) row = row.slice(1);
  if (row.endsWith("\u2502")) row = row.slice(0, -1);
  return row.trim();
}

/**
 * Codex's update notice on its screen: true when its first line ("Update available! A -> B", the
 * row itself, never a quoted one: Codex's replies start "• ", your messages "› ") has one of the notice's own lines
 * within the next five rows. Null otherwise: the notice scrolls away as the session goes on, and the session keeps
 * its version until it restarts (a new session is a new mark: UpdateWatch's identity).
 */
export function readCodexUpdateNotice(screen: string): boolean | null {
  const rows = stripTerminalCodes(screen).split("\n").map(codexRow);
  for (let index = 0; index < rows.length; index += 1) {
    if (!codexNotice.test(rows[index]!)) continue;
    const next = rows.slice(index + 1, index + 6);
    if (next.some((row) => codexFollowers.some((follower) => follower.test(row)))) return true;
  }
  return null;
}

/** A short read: the pane's last lines (`pane.read`, source recent). */
export const updateReadLines = 24;

export const updateWatchIntervalMs = 300_000;
export const updateWatchFloorMs = 30_000;
/** The rest between two reads of an unmarked pane once another pane on the machine is marked. */
export const updateWatchFastIntervalMs = 60_000;
/** How long from the machine's first mark the fast interval lasts. */
export const updateWatchFastWindowMs = 1_800_000;
/** A read out this long is taken as lost; the pane may be asked again. */
export const updateWatchLostMs = 600_000;

const promptMark = "❯";
const checkMarks = new Set(["✔", "✓"]);
/** A conversation row's first character: an agent bullet, your message or the prompt, a tool's output. */
const conversationMarks = new Set(["⏺", "●", "❯", ">", "⎿"]);
const words = "update installed";


/** The screen without terminal codes: CSI, OSC and the other string escapes, two-byte escapes, carriage returns. */
export function stripTerminalCodes(screen: string): string {
  if (!screen.includes("\u001B") && !screen.includes("\r")) return screen;
  let out = "";
  let i = 0;
  while (i < screen.length) {
    const c = screen[i]!;
    i += 1;
    if (c === "\r") continue;
    if (c !== "\u001B") {
      out += c;
      continue;
    }
    const kind = screen[i];
    i += 1;
    if (kind === "[") {
      // Parameters and intermediates, then one final byte (@ to ~).
      while (i < screen.length) {
        const code = screen.charCodeAt(i);
        i += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
    } else if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
      // A string up to BEL or ESC \.
      while (i < screen.length) {
        const next = screen[i]!;
        i += 1;
        if (next === "\u0007") break;
        if (next === "\u001B" && screen[i] === "\\") {
          i += 1;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * The live box's top rule: the screen's last two rules with the prompt (❯)
 * between them (the top one may carry the session's name, the bottom one never). Only the box at the screen's end
 * is the input's; a box quoted higher up, a dialog (or anything ruled) below it, is not.
 */
function boxTop(lines: readonly string[]): number | null {
  // The bottom rule dashes only, the top one may carry the session's name (claude-box.ts).
  const rules = claudeBoxRules(lines);
  if (rules === null) return null;
  const { top, bottom } = rules;
  if (!lines.slice(top + 1, bottom).some((line) => line.startsWith(promptMark))) return null;
  return isStatusRows(lines.slice(bottom + 1)) ? top : null;
}

/** The most status rows Claude Code draws under its box. */
const statusRows = 4;

/**
 * What follows the box's bottom rule is only the
 * footer's own status rows (the terminal's trailing blanks aside): at most
 * four, no blank between them. Each row has a shape
 * the supported footers draw (statusShape); anything else (a tool's plain
 * output, a file list, any other text) means the box is printed or quoted,
 * not the terminal's current footer.
 */
function isStatusRows(after: readonly string[]): boolean {
  const rows = [...after];
  while (rows.length > 0 && rows.at(-1) === "") rows.pop();
  if (rows.length > statusRows) return false;
  let previous: StatusShape | null = null;
  let previousIndent = 0;
  for (const row of rows) {
    const indent = /^ */.exec(row)![0].length;
    const shape = statusShape(row.slice(indent), previous, indent > previousIndent);
    if (shape === null) return false;
    previous = shape;
    previousIndent = indent;
  }
  return true;
}

type StatusShape = "model" | "mode" | "shortcuts" | "update" | "tip";

/**
 * The shape of one status row (its indent off), after the row above it
 * (deeper: indented more than it); null: none of them. The shapes, as
 * recorded (claude-2.1.303-* reads, the 2.1.316 reads in ChatLiveFixtures,
 * codex-0.163.0's "? for shortcuts"), each also cut at the edge ("…"): the
 * model / context line ("Haiku 5.5 | 4% ctx | …", "… | ctx:- | …"); the mode
 * line ("⏸ manual mode on", "⏵⏵ auto mode on (shift+tab to cycle)"); "? for
 * shortcuts"; the update line and the rest of it when it wraps; a tip
 * ("Tip: …") and its wrapped rest indented deeper. The twin of
 * AgentUpdateLine.statusShape.
 */
function statusShape(text: string, previous: StatusShape | null, deeper: boolean): StatusShape | null {
  const cut = text.endsWith("…");
  const body = cut ? text.slice(0, -1) : text;
  const cells = body.split(" | ");
  if (cells.length >= 2 && cells[0] !== "" && isContext(cells[1]!, cut && cells.length === 2)) return "model";
  for (const glyph of ["⏸ ", "⏵⏵ "]) {
    if (body.startsWith(glyph) && /^\p{Ll}/u.test(body.slice(glyph.length))) return "mode";
  }
  const shortcuts = "? for shortcuts";
  if (body.startsWith(shortcuts) || (cut && [...body].length >= 5 && shortcuts.startsWith(body))) return "shortcuts";
  if (matches(text)) return "update";
  if (previous === "update" && isUpdateRest(body)) return "update";
  if (body.startsWith("Tip: ")) return "tip";
  if (previous === "tip" && deeper) return "tip";
  return null;
}

/** The context cell: "34% ctx" or "ctx:-", or the start of one cut at the edge. */
function isContext(cell: string, cut: boolean): boolean {
  const digits = /^[0-9]*/.exec(cell)![0];
  if (digits.length > 3) return false;
  const whole = digits === "" ? "ctx:-" : `${digits}% ctx`;
  return cell === whole || (cut && cell !== "" && whole.startsWith(cell));
}

/** The update line's words from a word on ("Restart to update", "· Restart to update"). */
function isUpdateRest(body: string): boolean {
  const rest = body.split(" ").filter((part) => part !== "").join(" ").toLowerCase();
  const whole = "update installed · restart to update";
  return rest !== "" && whole.endsWith(rest) && whole.at(-rest.length - 1) === " ";
}

/** The words after the check mark; at a narrow width the line is cut ("✔ Update inst…"). */
function matches(footer: string): boolean {
  const text = [...footer.split(" ").filter((part) => part !== "").join(" ").toLowerCase()];
  for (let i = 0; i < text.length; i += 1) {
    if (!checkMarks.has(text[i]!)) continue;
    let j = i + 1;
    while (text[j] === " ") j += 1;
    const cut = text
      .slice(j, j + words.length)
      .filter((c) => c !== "…")
      .join("");
    if (cut.length >= 11 && words.startsWith(cut)) return true;
  }
  return false;
}

/**
 * True: the line stands above the box. False: the box with no line above it.
 * Null: no prompt box on screen (a dialog, a shell, an empty read): a mark stays.
 */
export function readUpdateLine(screen: string): boolean | null {
  const lines = stripTerminalCodes(screen)
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""));
  const top = boxTop(lines);
  if (top === null) return null;
  const width = boxWidth(lines, top);
  const footer: string[] = [];
  let aligned = true;
  for (let index = top - 1; index >= 0 && lines[index] !== ""; index -= 1) {
    const row = lines[index]!.replace(/^ +/, "");
    if (conversationMarks.has([...row][0] ?? "")) {
      // The conversation's last row right above the footer
      // (no blank between) ends it, when every footer row under it is drawn
      // right-aligned as Claude Code draws the line; otherwise those rows are
      // the conversation's too.
      if (footer.length > 0 && aligned) break;
      return false;
    }
    aligned &&= isRightAligned(lines[index]!, width);
    footer.unshift(row);
    if (footer.length > 3) return false;
  }
  return matches(footer.join(" "));
}

/** How far from the rule's right end a right-aligned footer row may end, in columns. */
const rightSlack = 2;

/**
 * The box's width in columns (the rule spans the pane): the
 * longer of its top rule (which may hold a title) and its bottom rule.
 */
function boxWidth(lines: readonly string[], top: number): number {
  const bottom = lines.findIndex((line, index) => index > top && isClaudeBottomRule(line));
  return Math.max([...lines[top]!].length, bottom < 0 ? 0 : [...lines[bottom]!].length);
}

/**
 * A footer row drawn as Claude Code draws its update line:
 * padded on the left, its right edge (trailing blanks off) within
 * `rightSlack` columns of the rule's right end.
 */
function isRightAligned(line: string, width: number): boolean {
  return line.startsWith(" ") && Math.abs(width - [...line].length) <= rightSlack;
}

/** One agent pane as the snapshot shows it. */
export interface UpdateWatchPane {
  readonly id: string;
  /** claude, codex … (null: a shell). */
  readonly kind: string | null;
  /** The pane's agent and session: a change is a new session, its mark goes. */
  readonly identity: string;
  /** Idle or done. */
  readonly settled: boolean;
  readonly exited: boolean;
}

interface Entry {
  /** The pane's CLI (its notice is read by its own reader). */
  kind: string;
  identity: string;
  /** This entry's lifetime (new each time the pane is seen anew or its identity changes). */
  token: number;
  lastReadMs: number | null;
  settled: boolean | null;
  askedMs: number | null;
  ready: boolean;
}

function watched(pane: UpdateWatchPane): boolean {
  return pane.kind !== null && updateLineKinds.has(pane.kind.toLowerCase()) && !pane.exited;
}

export class UpdateWatch {
  private readonly entries = new Map<string, Entry>();
  private lifetimes = 0;
  /** When the first of the panes marked now was marked; null: no pane is marked. */
  private firstMarkedMs: number | null = null;

  marked(): ReadonlySet<string> {
    return new Set([...this.entries].filter(([, entry]) => entry.ready).map(([id]) => id));
  }

  ready(pane: string): boolean {
    return this.entries.get(pane)?.ready ?? false;
  }

  /** The pane's entry lifetime now, taken when its read goes out and given back with the answer; null: no entry. */
  token(pane: string): number | null {
    return this.entries.get(pane)?.token ?? null;
  }

  /** The panes to read now, each marked as asked; panes gone, no longer watched or with a new identity lose their marks. */
  due(panes: readonly UpdateWatchPane[], nowMs: number, online: boolean): string[] {
    const kept = panes.filter(watched);
    const ids = new Set(kept.map((pane) => pane.id));
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
    const current = kept.map((pane) => {
      let entry = this.entries.get(pane.id);
      if (entry === undefined || entry.identity !== pane.identity) {
        this.lifetimes += 1;
        entry = { kind: (pane.kind ?? "").toLowerCase(), identity: pane.identity, token: this.lifetimes, lastReadMs: null, settled: null, askedMs: null, ready: false };
        this.entries.set(pane.id, entry);
      }
      return { pane, entry };
    });
    // The marks gone with their panes or sessions end the fast reads.
    this.noteFirstMark(nowMs);
    const fast = this.firstMarkedMs !== null && nowMs - this.firstMarkedMs < updateWatchFastWindowMs;
    const due: string[] = [];
    for (const { pane, entry } of current) {
      const turnedSettled = pane.settled && entry.settled === false;
      entry.settled = pane.settled;
      if (!online) continue;
      if (entry.askedMs !== null && nowMs - entry.askedMs < updateWatchLostMs) continue;
      const since = entry.lastReadMs === null ? null : nowMs - entry.lastReadMs;
      const interval = fast && !entry.ready ? updateWatchFastIntervalMs : updateWatchIntervalMs;
      if (since !== null && since < interval && !(turnedSettled && since >= updateWatchFloorMs)) continue;
      entry.askedMs = nowMs;
      entry.lastReadMs = nowMs;
      due.push(pane.id);
    }
    return due;
  }

  /**
   * A read of the pane's screen for the session `identity` (null: it failed).
   * Taken only for a pane the watch holds now (by the
   * latest due) with that same identity; a pane gone or never seen, or another
   * session's answer, is dropped; and only for the entry lifetime
   * `token` it was asked in (a pane removed and seen again is a new one).
   */
  observe(pane: string, identity: string, token: number, screen: string | null, nowMs: number): void {
    const entry = this.entries.get(pane);
    if (entry === undefined || entry.identity !== identity || entry.token !== token) return;
    entry.askedMs = null;
    entry.lastReadMs = nowMs;
    const ready = screen === null ? null : readAgentUpdate(entry.kind, screen);
    if (ready !== null) entry.ready = ready;
    this.noteFirstMark(nowMs);
  }

  /** The first mark's time kept while any pane is marked; the first mark after none is now. */
  private noteFirstMark(nowMs: number): void {
    const any = [...this.entries.values()].some((entry) => entry.ready);
    if (!any) this.firstMarkedMs = null;
    else this.firstMarkedMs ??= nowMs;
  }
}
