// Chat's live row in the demo. The Mac mini's working Claude
// pane (w7:p1G) answers the user's message as Claude Code
// does: once the message reaches the pane (the demo's transcript has it), the
// pane's screen (`pane.read`) shows the reply being written, a few words a
// frame, above the working line and the input box, as Claude Code 2.1.316
// draws them (the fixtures of test/support/live-fixtures.ts); the reply lands
// in the transcript a while after it is whole. The live reads in main parse
// that screen (ChatLiveScreen) and the page merges it (ChatLiveMerge): the row
// grows, then the transcript's own row takes its place.

import { ClaudeLines, codexLiveLine } from "./demo-chat";
import { DemoCursorMenu } from "./demo-cursor-menu";

/** The pane that streams its reply. */
export const demoLivePane = "w7:p1G";
/** A frame of the reply every this many milliseconds… */
export const demoLiveFrameMs = 450;
/** …this many words each… */
export const demoLiveWordsPerFrame = 4;
/** …and the reply lands in the transcript this long after the user's message reached the pane. */
export const demoLiveLandsMs = 7_500;

/** The reply, as the transcript has it once it lands. */
export const demoLiveReply = [
  "The Return tests pass: **14 of 14**, the iPad layout's included.",
  "",
  "With the keyboard attached:",
  "",
  "- Return sends the message, Shift-Return adds a line",
  "- the box keeps its height while the keyboard's bar shows",
  "",
  "Next I'll run the whole Composer suite, then commit.",
].join("\n");

/** The reply as Claude Code draws it: its bullet on the first line, the rest indented, Markdown's marks gone. */
const drawnReply = [
  "\u{23FA} The Return tests pass: 14 of 14, the iPad layout's included.",
  "",
  "  With the keyboard attached:",
  "",
  "  - Return sends the message, Shift-Return adds a line",
  "  - the box keeps its height while the keyboard's bar shows",
  "",
  "  Next I'll run the whole Composer suite, then commit.",
];

const width = 100;
const rule = "\u{2500}".repeat(width);

/** The drawn reply up to its `words`-th word (all of it past its end); its blank lines only between shown lines. */
function revealed(words: number): string[] {
  const shown: string[] = [];
  let left = words;
  for (const line of drawnReply) {
    if (left <= 0) break;
    if (line.trim() === "") {
      shown.push("");
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const parts = line.trimStart().split(" ");
    // The bullet is no word of the reply.
    const bullet = parts[0] === "\u{23FA}" ? 1 : 0;
    const take = Math.min(parts.length, bullet + left);
    left -= take - bullet;
    shown.push(" ".repeat(indent) + parts.slice(0, take).join(" "));
  }
  while (shown.at(-1) === "") shown.pop();
  return shown;
}

/** The reply's word count (its bullet not counted). */
export const demoLiveWords = drawnReply.join(" ").split(" ").filter((word) => word !== "" && word !== "\u{23FA}").length;

/**
 * Claude Code's footer row for each mode (as Claude Code draws it, without
 * the cycle hint, as this pane always drew its
 * auto row) and Shift+Tab's order: auto, manual, accept edits, plan.
 */
export const demoClaudeModeRows: Readonly<Record<string, string>> = {
  auto: "  \u{23F5}\u{23F5} auto mode on",
  manual: "  \u{23F8} manual mode on",
  acceptEdits: "  \u{23F5}\u{23F5} accept edits on",
  plan: "  \u{23F8} plan mode on",
};
export const demoClaudeModeOrder = ["auto", "manual", "acceptEdits", "plan"] as const;

/** The pane's screen: the last tool run, the user's message once it reached the pane, the reply's first `words` words, the working line and the box. */
export function demoLiveScreen(message: string | null, words: number, elapsedSeconds: number, mode = "auto"): string {
  const seconds = 31 * 60 + 52 + Math.floor(elapsedSeconds);
  const time = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return [
    "\u{23FA} Bash(swift test --force-resolved-versions --filter ComposerReturnTests)",
    "  \u{23BF}  Test Suite 'ComposerReturnTests' passed",
    "     Executed 14 tests, with 0 failures (0 unexpected) in 2.418 seconds",
    "",
    ...(message === null ? [] : [`\u{276F} ${message.split("\n")[0]!}`, ""]),
    ...(words > 0 ? [...revealed(words), ""] : []),
    `\u{273B} Pondering\u{2026} (${time} \u{B7} \u{2193} ${(12.4 + words / 50).toFixed(1)}k tokens)`,
    "",
    rule,
    "\u{276F}",
    rule,
    "  Opus 5.5 | 31% ctx | aurora-web-mac",
    demoClaudeModeRows[mode] ?? demoClaudeModeRows["auto"]!,
    "",
  ].join("\n");
}

/** The pane's reply: started by the user's message reaching the pane (once), drawn on its screen, then landed in its transcript. */
export class DemoLiveReply {
  private startedAt: number | null = null;
  private message: string | null = null;
  private landed = false;
  /** Its approval mode, the footer row's (Shift+Tab, tmux's BTab, cycles it). */
  mode: string = "auto";

  constructor(
    readonly paneID: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The user's message reached the pane: the reply starts (only the first one). */
  start(message: string): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.now();
    this.message = message;
  }

  /** What `pane.read` shows now. */
  screen(): string {
    if (this.startedAt === null) return demoLiveScreen(null, 0, 0, this.mode);
    const elapsed = this.now() - this.startedAt;
    const words = Math.min(demoLiveWords, Math.floor(elapsed / demoLiveFrameMs) * demoLiveWordsPerFrame);
    return demoLiveScreen(this.message, words, elapsed / 1_000, this.mode);
  }

  /** `pane.send_keys`: Shift+Tab moves its mode on (nothing else is drawn from keys). */
  keys(keys: readonly string[]): void {
    for (const key of keys) {
      if (key !== "BTab") continue;
      const at = demoClaudeModeOrder.indexOf(this.mode as (typeof demoClaudeModeOrder)[number]);
      this.mode = demoClaudeModeOrder[(at + 1) % demoClaudeModeOrder.length]!;
    }
  }

  /** The reply's transcript line once it is due (once); null before it is and after. */
  landing(sessionID: string, cwd: string): string[] | null {
    if (this.startedAt === null || this.landed) return null;
    const at = this.startedAt + demoLiveLandsMs;
    if (this.now() < at) return null;
    this.landed = true;
    return new ClaudeLines(sessionID, cwd, at, `live-reply-${sessionID.slice(0, 8)}`).text(demoLiveReply, 0).lines;
  }
}

// MARK: - Codex's reply streams too

/**
 * The Mac mini's Codex pane (Atelier). Idle until the user's message
 * reaches it (the demo's rollout has it); then Herdr says it works, its screen
 * shows Working, then the reply being written word by word above the "› " box
 * as Codex draws it (its link as "label (target)", wrapped with two spaces);
 * the reply lands in the rollout a while after it is whole, the screen shows
 * "Worked for", and the pane is done.
 */
export const demoCodexLivePane = "w5:pH";
/** Working alone for this long before the first words. */
export const demoCodexLiveThinkMs = 1_200;
/** Words drawn a frame (demoLiveFrameMs): slower than Claude's, so the whole reply takes about 8 s, past the app's 5 s refresh that shows the pane working. */
export const demoCodexLiveWordsPerFrame = 2;
/** The reply lands in the rollout this long after the user's message reached the pane. */
export const demoCodexLiveLandsMs = 11_000;

/** The reply, as the rollout has it once it lands. */
export const demoCodexLiveReply =
  "This week's notes mention both: [2026-10-29](notes/2026-10-29.md) prices **Qwen 3.5** per million tokens, and [2026-10-31](notes/2026-10-31.md) has the DeepSeek V4 eval with its numbers under Results. Neither note records a decision yet.";

/** The reply as Codex draws it, unwrapped: links as "label (target)", emphasis gone. */
const codexDrawn =
  "This week's notes mention both: 2026-10-29 (notes/2026-10-29.md) prices Qwen 3.5 per million tokens, and 2026-10-31 (notes/2026-10-31.md) has the DeepSeek V4 eval with its numbers under Results. Neither note records a decision yet.";

const codexWidth = 100;

/** The reply's word count. */
export const demoCodexLiveWords = codexDrawn.split(" ").length;

/** Its first `words` words, wrapped as Codex wraps them: "• " then two spaces, at the pane's width. */
function codexReplyLines(words: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of codexDrawn.split(" ").slice(0, words)) {
    if (line !== "" && line.length + 1 + word.length > codexWidth - 2) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines.map((text, index) => (index === 0 ? "\u{2022} " : "  ") + text);
}

/**
 * The Codex pane's screen: its last turn's tool row, the user's message once it
 * reached the pane, then Working (`words` 0 while it works), the reply's first
 * `words` words, or "Worked for" once it landed; the box and its status lines.
 */
export function demoCodexLiveScreen(message: string | null, words: number, elapsedSeconds: number, landed = false): string {
  const seconds = Math.floor(elapsedSeconds);
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
  let live: string[] = [];
  if (landed) live = ["  Worked for " + time, ""];
  else if (message !== null && words === 0) live = [`\u{2022} Working (${time} \u{2022} esc to interrupt)`, "  \u{2514} Tip: Press f3 to search this conversation.", ""];
  else if (words > 0) live = [...codexReplyLines(words), ""];
  return [
    "\u{2022} Ran rg -l -i \"qwen|deepseek\" notes",
    "  \u{2514} notes/2026-10-29.md",
    "    notes/2026-10-31.md",
    "",
    ...(message === null ? [] : [`\u{203A} ${message.split("\n")[0]!}`, ""]),
    ...live,
    "",
    "\u{203A} Ask Codex to do anything",
    "",
    "  gpt-5.5-codex high \u{B7} ~/code/atelier",
    "  ? for shortcuts",
    "",
  ].join("\n");
}

/**
 * Codex 0.166.0's `/permissions`: its four presets in its list's order, each with its words.
 */
export const demoCodexPermissions: readonly { readonly mode: string; readonly label: string; readonly words: string }[] = [
  { mode: "ask", label: "Ask for approval", words: "Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace" },
  { mode: "approve", label: "Approve for me", words: "Only ask for actions detected as potentially unsafe" },
  { mode: "full", label: "Full Access", words: "Use with caution: Codex can edit files outside this workspace and access the internet without approval" },
  { mode: "readOnly", label: "Read Only", words: "Read workspace files, with approval required for edits or internet access" },
];

/**
 * The words of a list row wrapped as Codex wraps them: the rest under the words' column (the widest
 * row's head and two spaces: 31, or 33 with "(current)" on Ask for approval).
 */
function codexListRow(head: string, column: number, words: string): string[] {
  const room = codexWidth - column;
  const lines: string[] = [];
  let line = "";
  for (const word of words.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > room) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") lines.push(line);
  return lines.map((text, index) => (index === 0 ? head.padEnd(column) : " ".repeat(column)) + text);
}

/** Codex's Full Access confirmation as it draws it over the box, at its indent. */
const codexConfirmation = [
  "Enable full access?",
  "When Codex runs with full access, it can edit any file on your",
  "computer and run commands with network, without your approval.",
  "Exercise caution when enabling full access. This significantly",
  "increases the risk of data loss, leaks, or unexpected behavior.",
  "",
  "",
].map((line) => (line === "" ? "" : `${" ".repeat(25)}${line}`));

/** The Codex pane's reply: started by the user's message reaching it (once), drawn on its screen, then landed in its rollout. */
export class DemoCodexLiveReply {
  private startedAt: number | null = null;
  private message: string | null = null;
  private landed = false;
  /**
   * What `/permissions` shows and has set: its box (with
   * what is typed into it), its list (the arrow on the current row) or the
   * Full Access confirmation; the mode (the rollout's turn_context says Ask
   * for approval) and the history row its last pick drew above the box.
   */
  readonly permissions: { view: "box" | "list" | "confirm"; draft: string; mode: string; history: string | null; pending: string | null } = {
    view: "box",
    draft: "",
    mode: "ask",
    history: null,
    pending: null,
  };

  constructor(
    readonly paneID: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The user's message reached the pane: the reply starts (only the first one). */
  start(message: string): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.now();
    this.message = message;
  }

  /** Herdr's status for the pane: working from the user's message until the reply lands, then done; null before (the snapshot's own). */
  status(): "working" | "done" | null {
    if (this.startedAt === null) return null;
    return this.now() < this.startedAt + demoCodexLiveLandsMs ? "working" : "done";
  }

  /** Since when that status holds (unix ms): the user's message, then the landing; null before. */
  statusSince(): number | null {
    if (this.startedAt === null) return null;
    return this.status() === "working" ? this.startedAt : this.startedAt + demoCodexLiveLandsMs;
  }

  /** What `pane.read` shows now. */
  screen(): string {
    return this.withPermissions(this.turnScreen());
  }

  private turnScreen(): string {
    if (this.startedAt === null) return demoCodexLiveScreen(null, 0, 0);
    const elapsed = this.now() - this.startedAt;
    if (elapsed >= demoCodexLiveLandsMs) return demoCodexLiveScreen(this.message, 0, elapsed / 1_000, true);
    const words = Math.min(demoCodexLiveWords, Math.max(0, Math.floor((elapsed - demoCodexLiveThinkMs) / demoLiveFrameMs) * demoCodexLiveWordsPerFrame));
    return demoCodexLiveScreen(this.message, words, elapsed / 1_000);
  }

  /** The turn's screen with `/permissions` drawn on it: the history row over the box, then its box, list or confirmation. */
  private withPermissions(screen: string): string {
    const { view, draft, mode, history } = this.permissions;
    const lines = screen.split("\n");
    const box = lines.findLastIndex((line) => line.startsWith("\u{203A} "));
    if (box < 0) return screen;
    const above = [...lines.slice(0, box), ...(history === null ? [] : [`\u{2022} ${history}`, ""])];
    const below = lines.slice(box + 1);
    const boxLine = `\u{203A} ${draft === "" ? "Ask Codex to do anything" : draft}`;
    if (view === "box") return [...above, boxLine, ...below].join("\n");
    if (view === "confirm") {
      const rows = [
        `${" ".repeat(23)}\u{203A} 1. Yes, continue anyway  Apply full access for this session`,
        `${" ".repeat(25)}2. Cancel                Go back without enabling full access`,
        "",
        `${" ".repeat(25)}enter select \u{B7} esc back`,
        "",
      ];
      return [...above, "", ...codexConfirmation, ...rows, boxLine, ...below].join("\n");
    }
    const current = Math.max(0, demoCodexPermissions.findIndex((each) => each.mode === mode));
    const heads = demoCodexPermissions.map(
      (each, index) => `${index === current ? "\u{203A}" : " "} ${index + 1}. ${each.label}${index === current ? " (current)" : ""}`,
    );
    const column = Math.max(...heads.map((head) => head.length)) + 2;
    const rows = demoCodexPermissions.flatMap((each, index) => codexListRow(heads[index]!, column, each.words));
    return [...above, "", "  Update Model Permissions", "", "", ...rows, "", "  enter select \u{B7} esc back"].join("\n");
  }

  /** `pane.send_text`: typed into its box (only while the box shows). */
  type(text: string): void {
    if (this.permissions.view === "box") this.permissions.draft += text;
  }

  /**
   * `pane.send_keys` as Codex took them: Enter on
   * `/permissions` opens its list; a row's digit picks it (Full Access asks
   * first: 1 confirms, 2 or Esc goes back to the list); Esc closes the list;
   * Backspace takes a character back. Esc on its box does nothing here.
   */
  keys(keys: readonly string[]): void {
    const state = this.permissions;
    for (const key of keys) {
      if (state.view === "box") {
        if (key === "Backspace") state.draft = state.draft.slice(0, -1);
        else if (key === "Enter") {
          if (state.draft === "/permissions") state.view = "list";
          state.draft = "";
        }
      } else if (state.view === "list") {
        if (key === "Escape") state.view = "box";
        const row = /^[1-9]$/.test(key) ? demoCodexPermissions[Number(key) - 1] : undefined;
        if (row === undefined) continue;
        if (row.mode === "full") {
          state.view = "confirm";
          state.pending = row.mode;
          continue;
        }
        state.mode = row.mode;
        state.history = `Permission selection requested: ${row.label}`;
        state.view = "box";
      } else {
        if (key === "Escape" || key === "2") state.view = "list";
        else if (key === "1" && state.pending !== null) {
          const row = demoCodexPermissions.find((each) => each.mode === state.pending)!;
          state.mode = row.mode;
          state.history = `Permissions updated to ${row.label}`;
          state.pending = null;
          state.view = "box";
        }
      }
    }
  }

  /** The reply's rollout lines once it is due (once); null before and after. */
  landing(sessionID: string, _cwd: string): string[] | null {
    if (this.startedAt === null || this.landed) return null;
    const at = this.startedAt + demoCodexLiveLandsMs;
    if (this.now() < at) return null;
    this.landed = true;
    const turn = `turn-live-${this.startedAt}`;
    return [
      codexLiveLine("response_item", { content: [{ text: demoCodexLiveReply, type: "output_text" }], id: `live-reply-${sessionID.slice(0, 8)}`, role: "assistant", type: "message" }, at),
      codexLiveLine("event_msg", { duration_ms: demoCodexLiveLandsMs, turn_id: turn, type: "task_complete" }, at),
    ];
  }
}


// MARK: - Cursor's reply streams too

/**
 * The Mac mini's Cursor pane (harbor, Grok 4.7). Idle until the user's
 * message reaches it (the demo's store has it); then Herdr says it works, its
 * screen shows Thinking, the lead-in with its tool row (Reading, then Read;
 * the store saves the lead-in and its Read as their own message), then the
 * reply written word by word above the braille spinner as Cursor draws it (the
 * heading a plain line, the code without its fence), "ctrl+c to stop" at the
 * box; the reply lands in the store a while after it is whole, the spinner
 * goes, and the pane is done.
 */
export const demoCursorLivePane = "wC:p1";
/** The folder under its footer. */
export const demoCursorLiveFolder = "/Users/demo/code/harbor";
/** Thinking alone for this long, then the lead-in and its tool running… */
export const demoCursorLiveThinkMs = 1_200;
/** …done (the lead-in and its Read land in the store) at this… */
export const demoCursorLiveReadMs = 2_100;
/** …and the reply's first words at this. */
export const demoCursorLiveReplyMs = 2_600;
/** Words drawn a frame (demoLiveFrameMs). */
export const demoCursorLiveWordsPerFrame = 3;
/** The reply lands in the store this long after the user's message reached the pane. */
export const demoCursorLiveLandsMs = 11_000;

/** The lead-in: Cursor's text before its tool, saved as its own message. */
export const demoCursorLiveLeadIn = "I'll read RateLimiterTests.swift and look for the window tests.";

/** The reply, as the store has it once it lands (Markdown: the heading's #, the fence). */
export const demoCursorLiveReply = [
  "Two tests in RateLimiterTests cover the window reset, and both pass on the fixed limiter after this morning's change to the check.",
  "",
  "## Window reset",
  "",
  "1. testResetsAfterWindow checks a full window frees up at its end.",
  "2. testCountsFromFirstRequest checks the window starts at the first request.",
  "",
  "```zsh",
  "swift test --filter RateLimiterTests",
  "```",
].join("\n");

/** The reply as Cursor draws it, a line each: Markdown's marks gone. */
const cursorDrawn = [
  "Two tests in RateLimiterTests cover the window reset, and both pass on the fixed limiter after this morning's change to the check.",
  "",
  "Window reset",
  "",
  "1. testResetsAfterWindow checks a full window frees up at its end.",
  "2. testCountsFromFirstRequest checks the window starts at the first request.",
  "",
  "swift test --filter RateLimiterTests",
];

const cursorWidth = 100;

/** The reply's word count. */
export const demoCursorLiveWords = cursorDrawn.join(" ").split(" ").filter((word) => word !== "").length;

/** The reply's first `words` words as Cursor draws them: two-space indent, wrapped a few columns inside the box. */
function cursorReplyLines(words: number): string[] {
  const lines: string[] = [];
  let left = words;
  for (const line of cursorDrawn) {
    if (left <= 0) break;
    if (line === "") {
      lines.push("");
      continue;
    }
    const take = line.split(" ").slice(0, left);
    left -= take.length;
    let row = "";
    for (const word of take) {
      if (row !== "" && 2 + row.length + 1 + word.length > cursorWidth - 7) {
        lines.push(`  ${row}`);
        row = word;
      } else {
        row = row === "" ? word : `${row} ${word}`;
      }
    }
    if (row !== "") lines.push(`  ${row}`);
  }
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Where the turn the user's message started stands on screen. */
export type DemoCursorStage = "idle" | "thinking" | "reading" | "read" | "reply" | "done";

/**
 * The Cursor pane's screen: the last turn's reply, the user's message once it reached
 * the pane, then the turn as `stage` has it (`words` of the reply), the
 * spinner and "ctrl+c to stop" while it works; the box and the footer.
 */
export function demoCursorLiveScreen(message: string | null, stage: DemoCursorStage, words = 0, elapsedSeconds = 0): string {
  const tokens = 40 + Math.floor(elapsedSeconds * 23);
  let turn: string[] = [];
  let spinner: string | null = null;
  const read = (verb: string): string[] => [`  ${demoCursorLiveLeadIn}`, "", `    ${verb} Tests/HarborTests/RateLimiterTests.swift`, ""];
  if (stage === "thinking") {
    spinner = ` \u{2818}\u{2823} Thinking  ${tokens} tokens`;
  } else if (stage === "reading") {
    turn = read("Reading");
    spinner = ` \u{2820}\u{281C} Reading  ${tokens} tokens`;
  } else if (stage === "read") {
    turn = read("Read");
    spinner = ` \u{2818}\u{2824} Thinking  ${tokens} tokens`;
  } else if (stage === "reply") {
    turn = [...read("Read"), ...cursorReplyLines(words), ""];
    spinner = ` \u{2818}\u{2823} Working  ${tokens} tokens`;
  } else if (stage === "done") {
    turn = [...read("Read"), ...cursorReplyLines(demoCursorLiveWords), "", "", ""];
  }
  const box = "  \u{2192} Add a follow-up";
  const stop = "ctrl+c to stop";
  return [
    "  Fixed: the limiter stops at the limit (>=), so a window takes exactly limit requests. The 6",
    "  RateLimiterTests pass.",
    "",
    "",
    ...(message === null ? [] : [`  ${message.split("\n")[0]!}`, "", ""]),
    ...turn,
    ...(spinner === null ? [] : [spinner, "    Tip: Type ? in the prompt bar to show in-app hints."]),
    "",
    "",
    spinner === null ? box : box + " ".repeat(cursorWidth - 2 - box.length - stop.length) + stop,
    "",
    "",
    "  Grok 4.7 256K Medium \u{B7} 4.2%",
    `  ${demoCursorLiveFolder}`,
  ].join("\n");
}

/** A Cursor store blob (the line view's shape). */
const cursorBlob = (value: unknown): string => JSON.stringify(value);

/** The Cursor pane's reply: started by the user's message reaching it (once), drawn on its screen, then landed in its store (the lead-in with its Read first, the reply last). */
export class DemoCursorLiveReply {
  private startedAt: number | null = null;
  private message: string | null = null;
  private landedRead = false;
  private landed = false;

  constructor(
    readonly paneID: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The user's message reached the pane: the reply starts (only the first one). */
  start(message: string): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.now();
    this.message = message;
  }

  /** Herdr's status for the pane: working from the user's message until the reply lands, then done; null before (the snapshot's own). */
  status(): "working" | "done" | null {
    if (this.startedAt === null) return null;
    return this.now() < this.startedAt + demoCursorLiveLandsMs ? "working" : "done";
  }

  /** Since when that status holds (unix ms): the user's message, then the landing; null before. */
  statusSince(): number | null {
    if (this.startedAt === null) return null;
    return this.status() === "working" ? this.startedAt : this.startedAt + demoCursorLiveLandsMs;
  }

  /**
   * Cursor's model menu under its box (demo-cursor-menu.ts):
   * the footer says what it holds; at the prompt `/model` and the keys open
   * its list, selector and Edit Parameters as the recorded screens.
   */
  readonly menu = new DemoCursorMenu([], demoCursorLiveFolder, { percent: 4.2 }, "Add a follow-up");

  /** What `pane.read` shows now: the turn as drawn, the menu's box and what is under it (while it works, its footer). */
  screen(): string {
    const lines = this.turnScreen().split("\n");
    const box = lines.findIndex((line) => line.startsWith("  \u{2192} Add a follow-up"));
    if (box < 0) return lines.join("\n");
    if (this.status() === "working") return [...lines.slice(0, box + 3), this.menu.footer(), ...lines.slice(box + 4)].join("\n");
    return [...lines.slice(0, box), ...this.menu.bottom()].join("\n");
  }

  private turnScreen(): string {
    if (this.startedAt === null) return demoCursorLiveScreen(null, "idle");
    const elapsed = this.now() - this.startedAt;
    const seconds = elapsed / 1_000;
    if (elapsed >= demoCursorLiveLandsMs) return demoCursorLiveScreen(this.message, "done", 0, seconds);
    if (elapsed < demoCursorLiveThinkMs) return demoCursorLiveScreen(this.message, "thinking", 0, seconds);
    if (elapsed < demoCursorLiveReadMs) return demoCursorLiveScreen(this.message, "reading", 0, seconds);
    if (elapsed < demoCursorLiveReplyMs) return demoCursorLiveScreen(this.message, "read", 0, seconds);
    const words = Math.min(demoCursorLiveWords, (Math.floor((elapsed - demoCursorLiveReplyMs) / demoLiveFrameMs) + 1) * demoCursorLiveWordsPerFrame);
    return demoCursorLiveScreen(this.message, "reply", words, seconds);
  }

  /** The store's new blobs once due: the lead-in with its Read and the Read's result, then the reply (each once); null when none is due. */
  landing(_sessionID: string, cwd: string): string[] | null {
    if (this.startedAt === null) return null;
    const elapsed = this.now() - this.startedAt;
    const lines: string[] = [];
    if (!this.landedRead && elapsed >= demoCursorLiveReadMs) {
      this.landedRead = true;
      const id = `demo-cursor-live-read-${this.startedAt}`;
      lines.push(
        cursorBlob({
          content: [{ text: demoCursorLiveLeadIn, type: "text" }, { args: { path: `${cwd}/Tests/HarborTests/RateLimiterTests.swift` }, toolCallId: id, toolName: "Read", type: "tool-call" }],
          role: "assistant",
        }),
        cursorBlob({
          content: [{ result: "final class RateLimiterTests: XCTestCase {\n    func testResetsAfterWindow() {}\n    func testCountsFromFirstRequest() {}\n}", toolCallId: id, toolName: "Read", type: "tool-result" }],
          providerOptions: { cursor: { highLevelToolCallResult: { isError: false, output: {} } } },
          role: "tool",
        }),
      );
    }
    if (!this.landed && elapsed >= demoCursorLiveLandsMs) {
      this.landed = true;
      lines.push(cursorBlob({ content: [{ text: demoCursorLiveReply, type: "text" }], role: "assistant" }));
    }
    return lines.length === 0 ? null : lines;
  }
}

/** A demo pane whose reply streams on its screen (Claude's, Codex's or Cursor's). */
export type DemoStreamingPane = DemoLiveReply | DemoCodexLiveReply | DemoCursorLiveReply;
