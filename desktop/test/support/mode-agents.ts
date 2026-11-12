// The four agents as their recorded screens show them (mode-fixtures.ts), answering a pick's keys and text the way they did:
// Claude Code's and Grok's Shift+Tab cycles, Cursor's two toggles (one
// three-way setting: Auto-review to Run Everything turns both off), Codex's
// /permissions list, digits and Full Access confirmation. Each keeps what was
// written to it, and a few ways to misbehave for the tests.

import { modeScreen } from "./mode-fixtures";

export interface FakeAgent {
  readonly writes: string[];
  screen(): string;
  type(text: string): void;
  keys(keys: readonly string[]): void;
}

/** The last line matching `pattern` replaced (the box is at the bottom). */
function replaceLast(screen: string, pattern: RegExp, line: string): string {
  const lines = screen.split("\n");
  const index = lines.findLastIndex((each) => pattern.test(each));
  if (index >= 0) lines[index] = line;
  return lines.join("\n");
}

abstract class CycleAgent implements FakeAgent {
  readonly writes: string[] = [];
  draft = "";
  /** Shift+Tab does nothing (a dialog took it). */
  stuck = false;
  /** Shift+Tab skips a mode. */
  skips = false;
  presses = 0;
  constructor(
    public mode: string,
    private readonly order: readonly string[],
  ) {}
  abstract frame(mode: string): string;
  abstract withDraft(screen: string, draft: string): string;
  screen(): string {
    const screen = this.frame(this.mode);
    return this.draft === "" ? screen : this.withDraft(screen, this.draft);
  }
  type(text: string): void {
    this.writes.push(`type ${text}`);
    this.draft += text;
  }
  keys(keys: readonly string[]): void {
    this.writes.push(keys.join(","));
    for (const key of keys) {
      if (key === "BTab") {
        this.presses += 1;
        if (this.stuck) continue;
        const at = this.order.indexOf(this.mode);
        this.mode = this.order[(at + (this.skips ? 2 : 1)) % this.order.length]!;
      } else if (key === "Backspace") this.draft = this.draft.slice(0, -1);
      else if (key === "Enter") this.draft = "";
    }
  }
}

export class FakeClaude extends CycleAgent {
  static readonly order = ["auto", "manual", "acceptEdits", "plan"];
  static readonly frames: Record<string, string> = { auto: "claude-00-start", manual: "claude-01-shift-tab", acceptEdits: "claude-02-shift-tab", plan: "claude-03-shift-tab" };
  constructor(mode: string) {
    super(mode, FakeClaude.order);
  }
  frame(mode: string): string {
    return modeScreen(FakeClaude.frames[mode]!);
  }
  withDraft(screen: string, draft: string): string {
    return replaceLast(screen, /^\u{276F}[\u{A0} ]/u, `\u{276F}\u{A0}${draft}`);
  }
}

export class FakeGrok extends CycleAgent {
  static readonly order = ["default", "plan", "autoReview", "alwaysApprove"];
  static readonly frames: Record<string, string> = { default: "grok-default", plan: "grok-plan", autoReview: "grok-auto-review", alwaysApprove: "grok-always-approve" };
  constructor(mode: string) {
    super(mode, FakeGrok.order);
  }
  frame(mode: string): string {
    return modeScreen(FakeGrok.frames[mode]!);
  }
  withDraft(screen: string, draft: string): string {
    return screen.replace(`\u{276F}${" ".repeat(draft.length + 1)}`, `\u{276F} ${draft}`);
  }
}

/** Cursor's command list rows as `/` shows them (cursor-06), each its command and its words. */
function cursorCommandRows(): { command: string; words: string }[] {
  return modeScreen("cursor-06-slash")
    .split("\n")
    .filter((line) => /^ {3}(?:\u{2192} | {2})\//u.test(line))
    .map((line) => {
      const body = line.slice(5);
      const command = body.split(" ")[0]!;
      return { command, words: body.slice(command.length).trimStart() };
    });
}

export class FakeCursor implements FakeAgent {
  readonly writes: string[] = [];
  draft = "";
  listOpen = false;
  /** The command that changed it last (Cursor's result line). */
  last: "/auto-review" | "/run-everything" | null = null;
  /** Enter does nothing. */
  deaf = false;
  /** Its list highlights another command than the one typed. */
  wrongHighlight = false;
  constructor(public mode: "default" | "autoReview" | "runEverything") {}

  private frame(): string {
    if (this.mode === "autoReview") return modeScreen("cursor-07-auto-review-on");
    if (this.mode === "runEverything") return modeScreen("cursor-10-run-everything-from-default");
    if (this.last === "/run-everything") return modeScreen("cursor-08-run-everything-on");
    return modeScreen(this.last === null ? "cursor-00-idle" : "cursor-12-restored-default");
  }

  screen(): string {
    const base = this.frame();
    if (this.draft === "") return base;
    if (!this.listOpen || !this.draft.startsWith("/")) return replaceLast(base, /^ {2}\u{2192} /u, `  \u{2192} ${this.draft}`);
    // The list `/` opens, filtered to the commands typed so far, the first highlighted.
    const slash = modeScreen("cursor-06-slash").split("\n");
    const box = slash.findLastIndex((line) => line.startsWith("  \u{2192} /"));
    const all = cursorCommandRows();
    const rows = all.filter((row) => row.command.startsWith(this.draft));
    if (this.wrongHighlight) rows.unshift(all[0]!);
    const listed = rows.map((row, index) => `${index === 0 ? "   \u{2192} " : "     "}${row.command.padEnd(26)}${row.words}`);
    return [...slash.slice(0, box), `  \u{2192} ${this.draft}`, "", "", ...listed].join("\n");
  }

  type(text: string): void {
    this.writes.push(`type ${text}`);
    this.draft += text;
    this.listOpen = this.draft.startsWith("/");
  }

  keys(keys: readonly string[]): void {
    this.writes.push(keys.join(","));
    for (const key of keys) {
      if (key === "Backspace") {
        this.draft = this.draft.slice(0, -1);
        this.listOpen = this.draft.startsWith("/");
      } else if (key === "Escape") this.listOpen = false;
      else if (key === "Enter" && !this.deaf) this.enter();
    }
  }

  private enter(): void {
    const command = this.draft;
    this.draft = "";
    this.listOpen = false;
    if (command === "/auto-review") {
      this.mode = this.mode === "autoReview" ? "default" : "autoReview";
      this.last = command;
    } else if (command === "/run-everything") {
      // From Auto-review it turns both off (recorded frame cursor-08).
      this.mode = this.mode === "runEverything" || this.mode === "autoReview" ? "default" : "runEverything";
      this.last = command;
    }
  }
}

const codexRows = [
  { label: "Ask for approval", mode: "ask", words: "Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace" },
  { label: "Approve for me", mode: "approve", words: "Only ask for actions detected as potentially unsafe" },
  { label: "Full Access", mode: "full", words: "Use with caution: Codex can edit files outside this workspace and access the internet without approval" },
  { label: "Read Only", mode: "readOnly", words: "Read workspace files, with approval required for edits or internet access" },
];

export class FakeCodex implements FakeAgent {
  readonly writes: string[] = [];
  draft = "";
  view: "box" | "list" | "confirm" = "box";
  history: string | null = null;
  /** Esc pressed while its box showed (it must never be). */
  escOnBox = 0;
  /** Its list with these rows only (a narrow one). */
  rows = codexRows;
  /** Its confirmation drawn otherwise than recorded. */
  oddConfirm = false;
  /** It asks to confirm Full Access whatever is picked. */
  confirmsAll = false;
  /** Enter on /permissions does not open the list. */
  deaf = false;
  /** An older history row drawn above the newest (Codex keeps them all). */
  earlier: string | null = null;
  /** Its digit closes the list and changes nothing (no new row). */
  dropsDigit = false;
  /** The user's draft's continuation rows under the box row (indented two, as Codex draws them). */
  continued: string[] = [];
  constructor(public mode: string) {}

  screen(): string {
    if (this.view === "confirm") {
      const frame = modeScreen("codex-04-full-access-confirm");
      return this.oddConfirm ? frame.replace("Yes, continue anyway", "Yes, enable full access") : frame;
    }
    if (this.view === "list") {
      const frame = modeScreen("codex-01-permissions").split("\n");
      const title = frame.findIndex((line) => line.trim() === "Update Model Permissions");
      const current = Math.max(0, this.rows.findIndex((row) => row.mode === this.mode));
      const rows = this.rows.map((row, index) => `${index === current ? "\u{203A}" : " "} ${index + 1}. ${`${row.label}${index === current ? " (current)" : ""}`.padEnd(30)} ${row.words}`);
      return [...frame.slice(0, title + 1), "", "", ...rows, "", "  enter select \u{B7} esc back"].join("\n");
    }
    const rows = [this.earlier, this.history].filter((row): row is string => row !== null);
    const base = modeScreen(rows.length === 0 ? "codex-00-start" : "codex-02-digit-1");
    const said = rows.length === 0 ? base : base.replace("\u{2022} Permission selection requested: Ask for approval", rows.map((row) => `\u{2022} ${row}`).join("\n\n"));
    const box = this.draft === "" && this.continued.length === 0 ? "\u{203A} Ask Codex to do anything" : `\u{203A} ${this.draft}`;
    return said.replace("\u{203A} Ask Codex to do anything", [box, ...this.continued.map((row) => (row === "" ? "" : `  ${row}`))].join("\n"));
  }

  type(text: string): void {
    this.writes.push(`type ${text}`);
    if (this.view === "box") this.draft += text;
  }

  keys(keys: readonly string[]): void {
    this.writes.push(keys.join(","));
    for (const key of keys) this.key(key);
  }

  private key(key: string): void {
    if (this.view === "box") {
      if (key === "Escape") this.escOnBox += 1;
      else if (key === "Backspace") this.draft = this.draft.slice(0, -1);
      else if (key === "Enter" && this.draft === "/permissions" && !this.deaf) {
        this.draft = "";
        this.view = "list";
      }
      return;
    }
    if (this.view === "list") {
      if (key === "Escape") this.view = "box";
      const row = /^[1-9]$/.test(key) ? this.rows[Number(key) - 1] : undefined;
      if (row === undefined) return;
      if (this.dropsDigit) {
        this.view = "box";
        return;
      }
      if (row.mode === "full" || this.confirmsAll) {
        this.view = "confirm";
        this.pending = row;
        return;
      }
      this.mode = row.mode;
      this.history = `Permission selection requested: ${row.label}`;
      this.view = "box";
      return;
    }
    if (key === "Escape" || key === "2") this.view = "list";
    if (key === "1" && this.pending !== null) {
      this.mode = this.pending.mode;
      this.history = `Permissions updated to ${this.pending.label}`;
      this.view = "box";
    }
  }

  private pending: (typeof codexRows)[number] | null = null;
}
