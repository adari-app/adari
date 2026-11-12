// The showcase's terminals: byte streams made here, not
// recorded. A scene draws a screen for a time and a size; a SceneTerminal
// redraws it at the terminal's own size as time passes (only the rows that
// changed), so Claude Code's look, Codex's look and a shell read right in a
// tile of any width. Invented content only.

import type { TerminalHandle, TerminalSink } from "../herdr/backend";
import type { DemoClock } from "../demo/demo-backend";

/** A screen as a function of time (ms since the scene began) and size. */
export interface Scene {
  /** How often the screen may change. */
  readonly tickMs: number;
  frame(ms: number, cols: number, rows: number): string[];
  /** Where the cursor shows (0-based row, column), or null for none (a full-screen program). */
  cursor?(ms: number, cols: number, rows: number): readonly [number, number] | null;
}

// MARK: styles

const esc = "\u001b[";
const style = (code: string) => (text: string) => `${esc}${code}m${text}${esc}0m`;
export const ink = {
  bold: style("1"),
  dim: style("38;2;133;133;133"),
  faint: style("38;2;98;98;98"),
  orange: style("38;2;215;119;87"),
  green: style("38;2;78;186;101"),
  red: style("38;2;255;107;128"),
  blue: style("38;2;177;185;249"),
  purple: style("38;2;175;135;255"),
  cyan: style("38;2;86;182;194"),
  white: style("38;2;235;235;235"),
  addLine: style("38;2;235;235;235;48;2;34;92;43"),
  delLine: style("38;2;235;235;235;48;2;122;41;54"),
};

/** A style's escape sequence (CSI … letter). */
const sequence = new RegExp(`(${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z])`);

/** The visible width of a styled line (one cell a character; the scenes use no wide characters). */
export function visibleLength(line: string): number {
  return Array.from(line.split(sequence).filter((part) => !part.startsWith(esc)).join("")).length;
}

/** The line cut to `cols` cells, its styles kept. */
export function fit(line: string, cols: number): string {
  let out = "";
  let width = 0;
  for (const part of line.split(sequence)) {
    if (part.startsWith(esc)) {
      out += part;
      continue;
    }
    for (const char of Array.from(part)) {
      if (width >= cols) return out + `${esc}0m`;
      out += char;
      width += 1;
    }
  }
  return out;
}

/** Plain text wrapped at word boundaries to `width`. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

const spinnerGlyphs = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

const elapsedLabel = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** A program drawn inline, as Claude Code and Codex draw: from the top while it fits, its last `rows` lines once it does not. */
function topFirst(content: readonly string[], rows: number): string[] {
  return content.length > rows ? content.slice(content.length - Math.max(0, rows)) : [...content];
}

const blankRows = (count: number): string[] => Array.from({ length: Math.max(0, count) }, () => "");

// MARK: Claude Code

export type ClaudeItem =
  | { readonly at: number; readonly kind: "user"; readonly text: string }
  | { readonly at: number; readonly kind: "say"; readonly text: string }
  /** A tool call; its output lines come one every `every` ms; more than `keep` fold to "… +N lines". */
  | { readonly at: number; readonly kind: "tool"; readonly name: string; readonly arg: string; readonly lines: readonly string[]; readonly every?: number; readonly keep?: number; readonly failed?: boolean }
  | { readonly at: number; readonly kind: "read"; readonly file: string; readonly count: number }
  | { readonly at: number; readonly kind: "edit"; readonly file: string; readonly diff: readonly (readonly [number, " " | "+" | "-", string])[] }
  /** The spinner's word from here on. */
  | { readonly at: number; readonly kind: "verb"; readonly verb: string };

export interface ClaudeScript {
  readonly folder: string;
  readonly items: readonly ClaudeItem[];
  /** Working: the spinner line shows. */
  readonly working: boolean;
  /** Restart after this long (ms); none holds the last screen. */
  readonly loopMs?: number;
  /** The tokens counter's start (thousands). */
  readonly tokens?: number;
}

function claudeItemLines(item: ClaudeItem, ms: number, cols: number): string[] {
  const width = Math.max(10, cols - 4);
  switch (item.kind) {
    case "user":
      return ["", ...wrap(item.text, width).map((line, i) => (i === 0 ? `${ink.dim("❯")} ${ink.white(line)}` : `  ${ink.white(line)}`))];
    case "say":
      return ["", ...wrap(item.text, width).map((line, i) => (i === 0 ? `${ink.white("⏺")} ${line}` : `  ${line}`))];
    case "verb":
      return [];
    case "read":
      return ["", `${ink.green("⏺")} ${ink.bold("Read")}(${item.file})`, `  ${ink.dim("⎿")}  Read ${ink.bold(String(item.count))} lines`];
    case "edit": {
      const added = item.diff.filter(([, sign]) => sign === "+").length;
      const removed = item.diff.filter(([, sign]) => sign === "-").length;
      const out = [
        "",
        `${ink.green("⏺")} ${ink.bold("Update")}(${item.file})`,
        `  ${ink.dim("⎿")}  Updated ${ink.bold(item.file)} with ${ink.bold(String(added))} addition${added === 1 ? "" : "s"} and ${ink.bold(String(removed))} removal${removed === 1 ? "" : "s"}`,
      ];
      const shown = Math.min(item.diff.length, Math.floor((ms - item.at) / 90) + 1);
      for (const [number, sign, text] of item.diff.slice(0, shown)) {
        const body = `${String(number).padStart(5)} ${sign}${text}`;
        const padded = body + " ".repeat(Math.max(0, cols - 6 - body.length));
        out.push(`     ${sign === "+" ? ink.addLine(padded) : sign === "-" ? ink.delLine(padded) : ink.white(body)}`);
      }
      return out;
    }
    case "tool": {
      const every = item.every ?? 140;
      const revealed = Math.min(item.lines.length, Math.max(0, Math.floor((ms - item.at - 500) / every) + 1));
      const running = revealed < item.lines.length;
      const bullet = running ? (Math.floor(ms / 500) % 2 === 0 ? ink.white("⏺") : ink.faint("⏺")) : item.failed ? ink.red("⏺") : ink.green("⏺");
      const head = `${bullet} ${ink.bold(item.name)}(${item.arg})`;
      const keep = item.keep ?? 8;
      let body = item.lines.slice(0, revealed);
      let more = 0;
      if (body.length > keep) {
        more = body.length - (keep - 1);
        body = body.slice(body.length - (keep - 1));
      }
      const out = ["", head];
      if (revealed === 0) out.push(`  ${ink.dim("⎿")}  ${ink.dim("Running…")}`);
      if (more > 0) out.push(`  ${ink.dim("⎿")}  ${ink.dim(`… +${more} lines (ctrl+o to expand)`)}`);
      body.forEach((line, index) => out.push(`  ${index === 0 && more === 0 ? ink.dim("⎿") : " "}  ${line}`));
      return out;
    }
  }
}

/** Claude Code's screen: its header, the conversation so far, the spinner, the input box. */
export function claudeScene(script: ClaudeScript): Scene {
  return {
    tickMs: 120,
    frame(at, cols, rows) {
      const ms = script.loopMs === undefined ? at : at % script.loopMs;
      const shown = script.items.filter((item) => item.at <= ms);
      const content: string[] = [
        ` ${ink.orange("✻")} ${ink.bold("Claude Code")} ${ink.dim("v2.1.316")}`,
        `   ${ink.dim("Opus 5.5 · " + script.folder)}`,
      ];
      for (const item of shown) content.push(...claudeItemLines(item, ms, cols));
      const rule = ink.faint("─".repeat(cols));
      const bottom = ["", rule, `${ink.dim("❯")} `, rule, `  ${ink.purple("⏵⏵ accept edits on")} ${ink.dim("(shift+tab to cycle)")}`];
      if (script.working) {
        const verb = [...shown].reverse().find((item) => item.kind === "verb");
        const glyph = spinnerGlyphs[Math.floor(at / 120) % spinnerGlyphs.length]!;
        const tokens = ((script.tokens ?? 1.2) + ms / 9_000).toFixed(1);
        bottom.unshift("", `${ink.orange(glyph)} ${ink.orange(`${verb?.kind === "verb" ? verb.verb : "Working"}…`)} ${ink.dim(`(${elapsedLabel(ms + 31_000)} · ↓ ${tokens}k tokens · esc to interrupt)`)}`);
      }
      return [...topFirst(content, rows - bottom.length), ...bottom, ...blankRows(rows - content.length - bottom.length)].slice(0, rows);
    },
  };
}

// MARK: Claude Code asking

export interface PermissionScript {
  readonly before: ClaudeScript;
  readonly title: string;
  readonly description: string;
  readonly command: string;
  readonly always: string;
}

/** Claude Code waiting on a permission dialog: the conversation, then the question in place of the box. */
export function permissionScene(script: PermissionScript): Scene {
  return {
    tickMs: 500,
    frame(ms, cols, rows) {
      const content: string[] = [` ${ink.orange("✻")} ${ink.bold("Claude Code")} ${ink.dim("v2.1.316")}`, `   ${ink.dim("Opus 5.5 · " + script.before.folder)}`];
      for (const item of script.before.items) content.push(...claudeItemLines(item, 10 * 60_000, cols));
      const dashed = ink.faint("╌".repeat(cols));
      const dialog = [
        "",
        ink.blue("─".repeat(cols)),
        ` ${ink.bold(ink.blue(script.title))}`,
        ` ${script.description}`,
        dashed,
        ` ${ink.white(script.command)}`,
        dashed,
        ` Do you want to proceed?`,
        ` ${ink.blue("❯ 1. Yes")}`,
        `   2. ${script.always}`,
        `   3. No, and tell Claude what to do differently ${ink.dim("(esc)")}`,
        "",
        ` ${ink.dim("Esc to cancel · Tab to amend")}`,
      ];
      void ms;
      return [...topFirst(content, rows - dialog.length), ...dialog].slice(0, rows);
    },
  };
}

// MARK: Codex

export type CodexItem =
  | { readonly at: number; readonly kind: "user"; readonly text: string }
  | { readonly at: number; readonly kind: "say"; readonly text: string }
  | { readonly at: number; readonly kind: "explored"; readonly lines: readonly string[] }
  | { readonly at: number; readonly kind: "ran"; readonly command: string; readonly lines: readonly string[]; readonly every?: number; readonly keep?: number }
  | { readonly at: number; readonly kind: "edited"; readonly file: string; readonly diff: readonly (readonly [number, " " | "+" | "-", string])[] };

export interface CodexScript {
  readonly folder: string;
  readonly items: readonly CodexItem[];
  readonly working: boolean;
  readonly loopMs?: number;
}

function codexItemLines(item: CodexItem, ms: number, cols: number): string[] {
  const width = Math.max(10, cols - 4);
  switch (item.kind) {
    case "user":
      return ["", ...wrap(item.text, width).map((line, i) => (i === 0 ? `${ink.bold("›")} ${line}` : `  ${line}`))];
    case "say":
      return ["", ...wrap(item.text, width).map((line, i) => (i === 0 ? `${ink.dim("•")} ${line}` : `  ${line}`))];
    case "explored":
      return ["", `${ink.dim("•")} ${ink.bold("Explored")}`, ...item.lines.map((line, i) => `  ${i === 0 ? ink.dim("└") : " "} ${line}`)];
    case "edited": {
      const added = item.diff.filter(([, sign]) => sign === "+").length;
      const removed = item.diff.filter(([, sign]) => sign === "-").length;
      return [
        "",
        `${ink.dim("•")} ${ink.bold("Edited")} ${item.file} (${ink.green(`+${added}`)} ${ink.red(`-${removed}`)})`,
        ...item.diff.map(([number, sign, text]) => {
          const body = `${String(number).padStart(5)} ${sign}${text}`;
          return `  ${sign === "+" ? ink.green(body) : sign === "-" ? ink.red(body) : ink.dim(body)}`;
        }),
      ];
    }
    case "ran": {
      const every = item.every ?? 160;
      const revealed = Math.min(item.lines.length, Math.max(0, Math.floor((ms - item.at - 400) / every) + 1));
      const running = revealed < item.lines.length;
      const keep = item.keep ?? 6;
      let body = item.lines.slice(0, revealed);
      const out = ["", `${running ? ink.cyan("•") : ink.dim("•")} ${ink.bold(running ? "Running" : "Ran")} ${ink.cyan(item.command)}`];
      if (body.length > keep) {
        const more = body.length - keep;
        body = body.slice(more);
        out.push(`  ${ink.dim("└")} ${ink.dim(`… +${more} lines`)}`);
        body.forEach((line) => out.push(`    ${ink.dim(line)}`));
      } else {
        body.forEach((line, i) => out.push(`  ${i === 0 ? ink.dim("└") : " "} ${ink.dim(line)}`));
      }
      return out;
    }
  }
}

/** Codex's screen: its box, the conversation, Working, the composer. */
export function codexScene(script: CodexScript): Scene {
  return {
    tickMs: 250,
    frame(at, cols, rows) {
      const ms = script.loopMs === undefined ? at : at % script.loopMs;
      const inner = Math.max(20, Math.min(cols - 2, 60));
      const boxLine = (text: string): string => `${ink.faint("│")} ${text}${" ".repeat(Math.max(0, inner - 1 - visibleLength(text)))}${ink.faint("│")}`;
      const content: string[] = [
        ink.faint(`╭${"─".repeat(inner)}╮`),
        boxLine(`${ink.bold(">_ OpenAI Codex")} ${ink.dim("(v0.71.0)")}`),
        boxLine(""),
        boxLine(`${ink.dim("model:    ")} gpt-5-codex high`),
        boxLine(`${ink.dim("directory:")} ${script.folder}`),
        ink.faint(`╰${"─".repeat(inner)}╯`),
      ];
      for (const item of script.items.filter((candidate) => candidate.at <= ms)) content.push(...codexItemLines(item, ms, cols));
      const bottom = ["", `${ink.bold("›")} ${ink.faint("Ask Codex to do anything")}`, "", `  ${ink.dim("⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit")}`];
      if (script.working) {
        const bullet = Math.floor(at / 500) % 2 === 0 ? "•" : "◦";
        bottom.unshift("", `${ink.dim(bullet)} ${ink.bold("Working")} ${ink.dim(`(${elapsedLabel(ms + 64_000)} • esc to interrupt)`)}`);
      }
      return [...topFirst(content, rows - bottom.length), ...bottom, ...blankRows(rows - content.length - bottom.length)].slice(0, rows);
    },
  };
}

// MARK: a shell

/** A shell at its prompt after a few commands; the cursor after the prompt. */
export function shellScene(prompt: string, history: readonly (readonly [command: string, output: readonly string[]])[]): Scene {
  const lines = (): string[] => {
    const out: string[] = [];
    for (const [command, output] of history) {
      out.push(`${ink.green(prompt)} ${command}`);
      out.push(...output);
    }
    out.push(`${ink.green(prompt)} `);
    return out;
  };
  return {
    tickMs: 60_000,
    frame(_ms, _cols, rows) {
      const all = lines();
      return [...topFirst(all, rows), ...blankRows(rows - all.length)];
    },
    cursor(_ms, _cols, rows) {
      const all = lines();
      const row = Math.min(all.length, rows) - 1;
      return [row, visibleLength(all[all.length - 1]!)];
    },
  };
}

// MARK: the terminal

const encoder = new TextEncoder();

/** A terminal drawing a scene at its size; input goes to `onInput` (a dialog answered). */
export class SceneTerminal implements TerminalHandle {
  private cancel: (() => void) | null = null;
  private closed = false;
  private elapsed = 0;
  private drawn: string[] = [];
  private cleared = false;
  private placed = "";

  constructor(
    private scene: Scene,
    private cols: number,
    private rows: number,
    private readonly sink: TerminalSink,
    private readonly clock: DemoClock,
    private readonly onInput: (data: Uint8Array, terminal: SceneTerminal) => void = () => undefined,
  ) {}

  start(): void {
    this.cancel = this.clock.schedule(() => this.tick(), 0);
  }

  /** Shows another scene from its beginning (a dialog answered). */
  play(scene: Scene): void {
    this.scene = scene;
    this.elapsed = 0;
    this.drawn = [];
    this.cleared = false;
    this.placed = "";
    this.draw();
  }

  private tick(): void {
    if (this.closed) return;
    this.draw();
    const step = this.scene.tickMs;
    this.cancel = this.clock.schedule(() => {
      this.elapsed += step;
      this.tick();
    }, step);
  }

  private draw(): void {
    const lines = this.scene.frame(this.elapsed, this.cols, this.rows).map((line) => fit(line, this.cols));
    let out = "";
    if (!this.cleared) {
      out += `${esc}?7l${esc}0m${esc}2J${esc}3J${esc}H`;
      this.cleared = true;
    }
    for (let row = 0; row < this.rows; row += 1) {
      const line = lines[row] ?? "";
      if (this.drawn[row] === line) continue;
      out += `${esc}${row + 1};1H${esc}0m${line}${esc}0m${esc}K`;
    }
    const cursor = this.scene.cursor?.(this.elapsed, this.cols, this.rows) ?? null;
    const place = cursor === null ? `${esc}?25l` : `${esc}${cursor[0] + 1};${cursor[1] + 1}H${esc}?25h`;
    this.drawn = lines;
    if (out.length === 0 && place === this.placed) return;
    this.placed = place;
    this.sink.data(encoder.encode(out + place));
  }

  input(data: Uint8Array): void {
    if (!this.closed) this.onInput(data, this);
  }

  resize(cols: number, rows: number): void {
    if (this.closed || (cols === this.cols && rows === this.rows)) return;
    this.cols = cols;
    this.rows = rows;
    this.drawn = [];
    this.cleared = false;
    this.placed = "";
    this.draw();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel?.();
    this.cancel = null;
  }
}
