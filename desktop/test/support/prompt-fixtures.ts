// The Swift app's prompt screens as the desktop's tests read them, straight
// out of the Swift sources so the two never drift (as swift-fixtures.ts does
// for the protocol 22 replies):
//
// - `F`: CompanionPromptFixtures (Tests/HerdrCompanionTests/
//   CompanionPromptModelTests.swift), the hand-written older frames;
// - `Launch`: the design's prompts from App/CompanionLaunchFixture.swift,
//   copied byte for byte into test/fixtures/launch-prompts.json
//   (test/launch-prompts-sync.test.ts compares the two when the Swift file
//   is in the tree);
// - `L`: CompanionLiveFixtures, each file in
//   Tests/HerdrCompanionTests/Fixtures/Live read byte for byte (pane.read,
//   source recent, plain text, 40 lines, taken live on 2026-10-19).
//
// Plain (not raw) Swift string literals: the closing delimiter's indentation
// comes off every line and the escapes Swift reads are read (\\, \", \n, \t,
// \r, \0, \u{…}); an interpolation is refused.

import { readFileSync } from "node:fs";
import path from "node:path";

import { desktopRoot, repoRoot } from "./swift-fixtures";

/** The value of the plain Swift string literal (`"…"` or `"""…"""`) right after `anchor`. */
export function extractSwiftString(swift: string, anchor: string): string {
  const at = swift.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  const open = swift.indexOf('"', at + anchor.length);
  if (open < 0) throw new Error(`no string after: ${anchor}`);
  let body: string;
  if (swift.startsWith('"""', open)) {
    const bodyStart = swift.indexOf("\n", open) + 1;
    const close = swift.indexOf('"""', bodyStart);
    if (close < 0) throw new Error(`unterminated literal after: ${anchor}`);
    const lineStart = swift.lastIndexOf("\n", close) + 1;
    const indent = swift.slice(lineStart, close);
    if (!/^[ \t]*$/.test(indent)) throw new Error(`closing delimiter not on its own line after: ${anchor}`);
    const raw = lineStart === bodyStart ? "" : swift.slice(bodyStart, lineStart - 1);
    body = raw
      .split("\n")
      .map((line) => {
        if (line.startsWith(indent)) return line.slice(indent.length);
        if (line.trim() === "") return "";
        throw new Error(`a line is indented less than the closing delimiter after: ${anchor}`);
      })
      .join("\n");
  } else {
    let end = open + 1;
    while (end < swift.length && swift[end] !== '"') end += swift[end] === "\\" ? 2 : 1;
    body = swift.slice(open + 1, end);
  }
  return unescape(body, anchor);
}

function unescape(body: string, anchor: string): string {
  let out = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character !== "\\") {
      out += character;
      continue;
    }
    const next = body[index + 1];
    index += 1;
    switch (next) {
      case "\\":
      case '"':
      case "'":
        out += next;
        break;
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "0":
        out += "\0";
        break;
      case "u": {
        const close = body.indexOf("}", index);
        out += String.fromCodePoint(parseInt(body.slice(index + 2, close), 16));
        index = close;
        break;
      }
      case "\n":
        // A line ending in a backslash goes on in the next line.
        break;
      default:
        throw new Error(`escape \\${next ?? ""} not read (interpolation?) after: ${anchor}`);
    }
  }
  return out;
}

const promptTests = readFileSync(path.join(repoRoot, "Tests/HerdrCompanionTests/CompanionPromptModelTests.swift"), "utf8");

function fixture(name: string): string {
  return extractSwiftString(promptTests, `static let ${name} = `);
}

/** The Swift file the launch prompts were copied from, relative to the repo root. */
export const launchSwiftSource = "App/CompanionLaunchFixture.swift";

/** The copy of the nine launch prompts, by their Swift names. */
export const launchPromptsFile = path.join(desktopRoot, "test/fixtures/launch-prompts.json");

const launchPrompts = JSON.parse(readFileSync(launchPromptsFile, "utf8")) as Record<string, unknown>;

function launchFixture(name: string): string {
  const value = launchPrompts[name];
  if (typeof value !== "string") throw new Error(`launch prompt not in ${launchPromptsFile}: ${name}`);
  return value;
}

/** `rows` in a box drawn as Claude Code draws it: an edge, one cell of padding, each row padded to `width`. */
export function box(rows: readonly string[], width: number): string {
  const edge = "─".repeat(width + 2);
  const body = rows.map((row) => `│ ${row.padEnd(Math.max(width, row.length), " ")} │`);
  return [`╭${edge}╮`, ...body, `╰${edge}╯`].join("\n");
}

export function lines(count: number, make: (index: number) => string): string {
  return Array.from({ length: count }, (_, index) => make(index)).join("\n");
}

/** The last `count` lines of `text`, as a full `pane.read` returns them. */
export function lastLines(text: string, count = 40): string {
  return text.split("\n").slice(-count).join("\n");
}

const claudeInput = fixture("claudeInput");
const claudeEdit = fixture("claudeEdit");

/** CompanionPromptFixtures. */
export const F = {
  claudeEdit,
  claudeBash: fixture("claudeBash"),
  codexCommand: fixture("codexCommand"),
  grokMenu: fixture("grokMenu"),
  codexYesNo: fixture("codexYesNo"),
  defaultYes: fixture("defaultYes"),
  bracketAlone: fixture("bracketAlone"),
  working: fixture("working"),
  staleList: fixture("staleList"),
  claudeInput,
  claudeInputRuled: fixture("claudeInputRuled"),
  codexInput: fixture("codexInput"),
  grokInput: fixture("grokInput"),
  claudeInputTyped: claudeInput.replace(
    "│ >                                                                │",
    "│ > Use TestClock                                                  │",
  ),
  claudeInputPartial: fixture("claudeInputPartial"),
  unsupportedApproval: fixture("unsupportedApproval"),
  claudeEditCursorOnTwo: (): string => claudeEdit.replace("│ ❯ 1. Yes ", "│   1. Yes ").replace("│   2. Yes, allow", "│ ❯ 2. Yes, allow"),
} as const;

/** The design's prompts (CompanionLaunchFixture). */
export const Launch = {
  pairingPrompt: launchFixture("pairingPrompt"),
  pairingChangedPrompt: launchFixture("pairingChangedPrompt"),
  pairingFeedbackField: launchFixture("pairingFeedbackField"),
  reviewerFeedbackField: launchFixture("reviewerFeedbackField"),
  paywallPrompt: launchFixture("paywallPrompt"),
  paywallCommandPrompt: launchFixture("paywallCommandPrompt"),
  stringsPrompt: launchFixture("stringsPrompt"),
  relayPrompt: launchFixture("relayPrompt"),
  reviewerPrompt: launchFixture("reviewerPrompt"),
} as const;

const liveFolder = path.join(repoRoot, "Tests/HerdrCompanionTests/Fixtures/Live");

function live(name: string): string {
  return readFileSync(path.join(liveFolder, `${name}.txt`), "utf8");
}

/** CompanionLiveFixtures: today's agents read live, byte for byte. */
export const L = {
  claude2_1_303Bash: live("claude-2.1.303-bash-dialog"),
  claude2_1_303Write: live("claude-2.1.303-write-dialog"),
  claude2_1_303Trust: live("claude-2.1.303-trust-dialog"),
  claude2_1_303AfterNo: live("claude-2.1.303-after-no"),
  claude2_1_303IdleField: live("claude-2.1.303-idle-field"),
  claude2_1_303Typed: live("claude-2.1.303-typed"),
  claude2_1_303ClearedANSI: live("claude-2.1.303-cleared.ansi"),
  claude2_1_303Working: live("claude-2.1.303-working"),
  claude2_1_303WorkingEarly: live("claude-2.1.303-working-early"),
  claude2_1_303NamedAfterNo: live("claude-2.1.303-named-after-no"),
  claude2_1_303NamedBash: live("claude-2.1.303-named-bash-dialog"),
  claude2_1_303NamedIdleField: live("claude-2.1.303-named-idle-field"),
  claude2_1_303Narrow39Bash: live("claude-2.1.303-narrow39-bash-dialog"),
  claude2_1_303Narrow39AfterNo: live("claude-2.1.303-narrow39-after-no"),
  claude2_1_303Narrow54IdleField: live("claude-2.1.303-narrow54-idle-field"),
  claude2_1_303Narrow54Cleared: live("claude-2.1.303-narrow54-cleared"),
  claude2_1_303Narrow54Bash: live("claude-2.1.303-narrow54-bash-dialog"),
  claude2_1_303Narrow54AfterNo: live("claude-2.1.303-narrow54-after-no"),
  claude2_1_303Narrow54ClearedAfterNo: live("claude-2.1.303-narrow54-cleared-after-no"),
  codex0_163_0Dialog: live("codex-0.163.0-dialog"),
  codex0_163_0AfterNo: live("codex-0.163.0-after-no"),
  codex0_163_0IdleField: live("codex-0.163.0-idle-field"),
  codex0_163_0Typed: live("codex-0.163.0-typed"),
  codex0_163_0Working: live("codex-0.163.0-working"),
  codex0_163_0Narrow51Dialog: live("codex-0.163.0-narrow51-dialog"),
  codex0_163_0Narrow51After3: live("codex-0.163.0-narrow51-after-3"),
  grok1_0_60IdleField: live("grok-1.0.60-idle-field"),
  grok1_0_60Typed: live("grok-1.0.60-typed"),
} as const;

const grokFolder = path.join(repoRoot, "Tests/HerdrCompanionTests/Fixtures/Grok");

function grok(name: string): string {
  return readFileSync(path.join(grokFolder, `grok-1.0.70-${name}.txt`), "utf8");
}

/**
 * CompanionGrokFixtures, Grok Build 1.0.70's approval frame as pane.read
 * returns it (40 lines), with filler commands: each file in
 * Tests/HerdrCompanionTests/Fixtures/Grok. The `live*` frames are recorded:
 * Grok asking for `python3 -c 'print(1)'` (3 marked), the screen 0.3 s after `4` alone (the frame gone),
 * then the turn cancelled.
 */
export const G = {
  approval: grok("approval"),
  altGlyphs: grok("approval-alt-glyphs"),
  marked1: grok("approval-marked-1"),
  marked4: grok("approval-marked-4"),
  three: grok("approval-3"),
  wrapped: grok("approval-wrapped"),
  wrappedPlain: grok("approval-wrapped-plain"),
  partial: grok("approval-partial"),
  after: grok("after"),
  second: grok("second"),
  noPrompt: grok("no-prompt"),
  liveApproval: grok("live-approval"),
  liveAfter4: grok("live-after-4"),
  liveCancelled: grok("live-cancelled"),
} as const;

const codexFolder = path.join(repoRoot, "Tests/HerdrCompanionTests/Fixtures/Codex");

function codex(name: string): string {
  return readFileSync(path.join(codexFolder, `codex-0.166.0-form-${name}.txt`), "utf8");
}

/**
 * CompanionCodexFormFixtures, Codex 0.166.0's MCP elicitation form
 * (codex-rs/tui/src/bottom_pane/mcp_server_elicitation.rs) as pane.read
 * returns it (40 rows), from its snapshots and the user's wrapped rows, the
 * history above invented: each file in Tests/HerdrCompanionTests/Fixtures/Codex.
 */
export const C = {
  four: codex("4"),
  two: codex("2"),
  params: codex("params"),
  fourGap: codex("4-gap"),
  narrow: codex("narrow"),
  narrowParams: codex("narrow-params"),
  clipped: codex("clipped"),
  clippedOptions: codex("clipped-options"),
  twoFields: codex("two-fields"),
  messageOnly: codex("message-only"),
  boolean: codex("boolean"),
  text: codex("text"),
  after: codex("after"),
  second: codex("second"),
} as const;

const claudeAskFolder = path.join(repoRoot, "Tests/HerdrCompanionTests/Fixtures/ClaudeAsk");

function claudeAsk(name: string): string {
  return readFileSync(path.join(claudeAskFolder, `claude-2.1.325-ask-${name}.txt`), "utf8");
}

/**
 * CompanionClaudeAskFixtures, Claude Code 2.1.325's question dialog (the
 * AskUserQuestion tool) as pane.read returns it: `sample` is the one recorded
 * read (the dialog's 16 rows, 201 cells), every other file is built from its
 * rows (the history above and the variants invented): each file in
 * Tests/HerdrCompanionTests/Fixtures/ClaudeAsk, which the Swift tests read too.
 */
export const A = {
  sample: claudeAsk("sample"),
  full: claudeAsk("full"),
  marked2: claudeAsk("marked-2"),
  marked3: claudeAsk("marked-3"),
  markedType: claudeAsk("marked-type"),
  markedChat: claudeAsk("marked-chat"),
  noMark: claudeAsk("no-mark"),
  narrow: claudeAsk("narrow"),
  wrapped3: claudeAsk("wrapped-3"),
  questionWrapped: claudeAsk("question-wrapped"),
  footerAfter: claudeAsk("footer-after"),
  rowBetween: claudeAsk("row-between"),
  noRule: claudeAsk("no-rule"),
  noType: claudeAsk("no-type"),
  gap: claudeAsk("gap"),
  oneOption: claudeAsk("one-option"),
  nine: claudeAsk("nine"),
  ten: claudeAsk("ten"),
  twoChips: claudeAsk("two-chips"),
  checkbox: claudeAsk("checkbox"),
  checkboxBox: claudeAsk("checkbox-box"),
  cutRule: claudeAsk("cut-rule"),
  cutHeader: claudeAsk("cut-header"),
  tall: claudeAsk("tall"),
  nextOutput: claudeAsk("next-output"),
  after: claudeAsk("after"),
  // A review's screens (overflow-number, zwj-width, combining-width, wide-label-wrap: its
  // boundary-screens.json, verbatim) and row numbers, long labels built from the sample.
  overflowNumber: claudeAsk("overflow-number"),
  numberThreeDigit: claudeAsk("number-three-digit"),
  numberTwelve: claudeAsk("number-twelve"),
  numberZero: claudeAsk("number-zero"),
  zwjWidth: claudeAsk("zwj-width"),
  combiningWidth: claudeAsk("combining-width"),
  wideLabelWrap: claudeAsk("wide-label-wrap"),
  longLabels: claudeAsk("long-labels"),
  longUnbroken: claudeAsk("long-unbroken"),
} as const;

function overlay(name: string): string {
  return readFileSync(path.join(codexFolder, `codex-0.166.0-overlay-${name}.txt`), "utf8");
}

/**
 * CompanionCodexOverlayFixtures, every approval_overlay snapshot in Codex
 * 0.166.0's source (tui/src/bottom_pane/approval_overlay.rs tests) as the last rows of a 40-row
 * read, the history above invented.
 */
export const CO = {
  headerWrappedUrl: overlay("header-wrapped-url"),
  additionalPermissions: overlay("additional-permissions"),
  crossThread: overlay("cross-thread"),
  patchDestinationUnavailable: overlay("patch-destination-unavailable"),
  permissions: overlay("permissions"),
  networkExec: overlay("network-exec"),
} as const;

const codexQuestionFolder = path.join(repoRoot, "Tests/HerdrCompanionTests/Fixtures/CodexQuestion");

function codexQuestionScreen(name: string): string {
  return readFileSync(path.join(codexQuestionFolder, `codex-0.171.0-question-${name}.txt`), "utf8");
}

/**
 * CompanionCodexQuestionFixtures, Codex 0.171.0's own question in Plan mode (its request_user_input tool) and its
 * "Implement this plan?" list: the eight recorded screens (120 columns, taken in a scratch tab; the start cell's
 * folder written as `~/work`), and screens built from their rows (`built-…`: the history around them and the variants
 * invented, Codex's words from its source where the samples show none). Each file in
 * Tests/HerdrCompanionTests/Fixtures/CodexQuestion, which the Swift tests read too.
 */
export const CQ = {
  q1of2: codexQuestionScreen("1of2"),
  q2of2: codexQuestionScreen("2of2"),
  notes: codexQuestionScreen("2of2-notes"),
  long1of2: codexQuestionScreen("long-1of2"),
  long1of2Answered: codexQuestionScreen("long-1of2-answered"),
  long2of2: codexQuestionScreen("long-2of2-after-digit"),
  afterAll: codexQuestionScreen("after-all-answered"),
  wrappedQuestion: codexQuestionScreen("built-wrapped-question"),
  nine: codexQuestionScreen("built-nine"),
  ten: codexQuestionScreen("built-ten"),
  one: codexQuestionScreen("built-one"),
  lookalike: codexQuestionScreen("built-lookalike"),
  confirm: codexQuestionScreen("built-confirm"),
  after: codexQuestionScreen("built-after"),
  planAfterImplement: codexQuestionScreen("built-plan-after-implement"),
  /** After 2 (clear context), a fresh thread: none of the old transcript. */
  planAfterFresh: codexQuestionScreen("built-plan-after-fresh"),
  planAfterStay: codexQuestionScreen("built-plan-after-stay"),
  planNarrow: codexQuestionScreen("built-plan-narrow"),
  /** Codex 0.166.0's /permissions list as recorded (mode-fixtures.ts codex-01): the same list frame and footer. */
  permissionsList: codexQuestionScreen("built-permissions-list"),
} as const;

/** The files' expected readings (Tests/HerdrCompanionTests/Fixtures/CodexQuestion/codex-0.171.0-question-expected.json), one table for both apps. */
export const codexQuestionExpected = JSON.parse(readFileSync(path.join(codexQuestionFolder, "codex-0.171.0-question-expected.json"), "utf8")) as Record<string, unknown>;

/** CompanionLiveEdit: edits to one row of a read, the rest byte for byte. */
export const E = {
  row(text: string, index: number, change: (row: string) => string): string {
    const rows = text.split("\n");
    rows[index] = change(rows[index]!);
    return rows.join("\n");
  },
  removing(text: string, start: number, end: number): string {
    const rows = text.split("\n");
    rows.splice(start, end - start);
    return rows.join("\n");
  },
  inserting(text: string, added: readonly string[], at: number): string {
    const rows = text.split("\n");
    rows.splice(at, 0, ...added);
    return rows.join("\n");
  },
};

/** CompanionLiveFixtures.rows: by line, the empty string after the last line break dropped. */
export function rowsOf(text: string): string[] {
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

/** A pane whose screen the test controls, recording every key it receives (CompanionScriptedPane). */
export class ScriptedPane {
  readonly screens: string[];
  readError: Error | null = null;
  sendError: unknown = null;
  reads = 0;
  readonly sent: string[][] = [];

  constructor(...screens: string[]) {
    this.screens = screens;
  }

  readonly io = {
    read: async (): Promise<string> => {
      this.reads += 1;
      if (this.readError !== null) throw this.readError;
      return this.screens.length > 1 ? this.screens.shift()! : this.screens[0]!;
    },
    sendKeys: async (keys: readonly string[]): Promise<void> => {
      if (this.sendError !== null) throw this.sendError;
      this.sent.push([...keys]);
    },
  };
}
