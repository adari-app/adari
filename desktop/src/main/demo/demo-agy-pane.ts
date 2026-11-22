// An Antigravity CLI pane New agent starts on the demo (development builds only), drawn in the shapes
// the samples' idle screens hold (agy 1.5.14: rule, the `>` box, rule, then the last row with "? for shortcuts" at
// its left and "[mode · ]Model · level" at its right end), invented text. It takes `pane.send_text` into its box and
// its keys as the samples' model-switch-1.5.14.md says: Enter on `/model <id>` with an id of the machine's list sets
// the model ("Model set to <label>" above the box, the last row's right end changes); Shift+Tab (BTab) cycles the
// mode auto, plan, none shown (it asks), accept-edits; Backspace takes a character back; a draft is added to by
// anything typed after it.

import { agyLabelParts } from "../../shared/model-choices";
import { parseCatalog, type CatalogModel } from "../../shared/model-catalog";
import { demoAgyModels } from "./demo-model-lists";

const width = 119;
const rule = "\u{2500}".repeat(width);

/** Shift+Tab's order (the samples' README) and the last row's word for each (none for the mode that asks). */
export const demoAgyModeOrder = ["auto", "plan", "default", "acceptEdits"] as const;
const modeWords: Readonly<Record<string, string>> = { auto: "auto", plan: "plan", acceptEdits: "accept-edits" };

function demoList(): readonly CatalogModel[] {
  const parsed = parseCatalog("agy", demoAgyModels);
  return parsed.ok ? parsed.models : [];
}

export class DemoAgyPane {
  mode: string = "auto";
  model = "Gemini 4 Hydrogen";
  level: string | null = "low";
  draft = "";
  private readonly said: string[] = [];

  constructor(
    readonly paneID: string,
    start: string | null = null,
  ) {
    // Started with `--model <id>`: that row's model and level.
    const row = start === null ? undefined : demoList().find((model) => model.id === start);
    if (row !== undefined) this.set(row.label);
  }

  /** What `pane.read` shows now. */
  screen(): string {
    const right = [modeWords[this.mode], this.model, this.level].filter((part): part is string => part !== undefined && part !== null).join(" \u{B7} ");
    const left = this.draft === "" ? "? for shortcuts" : "";
    const [head, ...more] = this.draft.split("\n");
    return [
      "demo % agy",
      "",
      "      \u{2584}\u{2580}\u{2580}\u{2584}        Antigravity CLI 1.5.14",
      "     \u{2580}\u{2580}\u{2580}\u{2580}\u{2580}\u{2580}       a demo account",
      `    \u{2580}\u{2580}\u{2580}\u{2580}\u{2580}\u{2580}\u{2580}\u{2580}      ${this.model}${this.level === null ? "" : ` (${this.level})`}`,
      "   \u{2584}\u{2580}\u{2580}    \u{2580}\u{2580}\u{2584}     ~/code/research",
      "  \u{2584}\u{2580}\u{2580}      \u{2580}\u{2580}\u{2584}",
      "",
      ...this.said,
      rule,
      this.draft === "" ? ">" : `> ${head}`,
      ...more.map((line) => `  ${line}`),
      rule,
      left + " ".repeat(Math.max(2, width - left.length - right.length)) + right,
    ].join("\n");
  }

  type(text: string): void {
    this.draft += text;
  }

  keys(keys: readonly string[]): void {
    for (const key of keys) {
      if (key === "BTab" && this.draft === "") {
        const at = demoAgyModeOrder.indexOf(this.mode as (typeof demoAgyModeOrder)[number]);
        this.mode = demoAgyModeOrder[(at + 1) % demoAgyModeOrder.length]!;
      } else if (key === "Backspace") {
        this.draft = this.draft.slice(0, -1);
      } else if (key === "Enter") {
        this.enter();
      }
    }
  }

  private enter(): void {
    const typed = /^\/model (\S+)$/u.exec(this.draft);
    this.draft = "";
    if (typed === null) return;
    const row = demoList().find((model) => model.id === typed[1]);
    if (row === undefined) return;
    this.said.push("> /model", `  \u{23BF}  Model set to ${row.label}`, "");
    this.set(row.label);
  }

  /** The last row's model and level for a row's label (a bracket that is no level drawn as its word, lower case). */
  private set(label: string): void {
    const parts = agyLabelParts(label);
    if (parts.level !== null) {
      this.model = parts.name;
      this.level = parts.level;
      return;
    }
    const named = /^(.*\S)\s*\(([A-Za-z]+)\)$/u.exec(label);
    this.model = named === null ? label : named[1]!;
    this.level = named === null ? null : named[2]!.toLowerCase();
  }
}
