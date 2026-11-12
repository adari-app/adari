// A Cursor pane's model menu, for the demo and the tests: it answers
// `pane.read` with the screens cursor-agent 2026.11.05 drew (the box and its
// footer, the command list under a typed `/model`, the model selector, Grok
// 4.7's Edit Parameters) and takes `pane.send_text` and `pane.send_keys` as
// Cursor did: `/model` opens the list, Enter the selector, Tab Edit
// Parameters (the arrow on its first row), ↑/↓ move the arrow one row, Enter
// chooses the row (Fast turns on or off), Esc goes back a screen; Esc in the
// list leaves `/model` in the box, Backspace takes a character back.
// test/cursor-pick.test.ts checks it draws the recorded screens byte for byte.
// Enter on `/auto-review` or `/run-everything` in its box toggles its one
// three-way approval setting (from Auto-review, `/run-everything` turns both
// off), the footer's word at the model row's right (none for the default).
// Sources/HerdrKit/CursorMenuFake.swift is the app's.

import { cursorEffortLabel, cursorEfforts, cursorWindows, type CursorEffort } from "../../shared/agent-settings";

export type CursorMenuStage = "box" | "commands" | "models" | "parameters";

export interface CursorMenuState {
  stage: CursorMenuStage;
  draft: string;
  window: string;
  effort: CursorEffort;
  fast: boolean;
  /** The share used (`· 6.8%`), or null before it is counted. */
  percent: number | null;
  /** Edit Parameters' arrow: its row (0: 256K … 6: Fast). */
  arrow: number;
  /** Its approval mode. */
  approval: "default" | "autoReview" | "runEverything";
}

const arrow = "\u{2192}";
const width = 118;

/** The list `/model` opens (as recorded). */
const commandRows = [
  `   ${arrow} /model [filter]           Select model (Tab to edit)`,
  "     /model-usage              Use CodexBar CLI local cost usage to summarize per-model usage for Codex or Claude,\u{2026}",
  "     /modeling-revenue-metri\u{2026}  Build reusable revenue models \u{2014} MRR, ARR, gross revenue,\u{2026}",
  "     /modeling-activation-me\u{2026}  Build reusable activation models \u{2014} an activation-rate metric and a\u{2026}",
  "     /modeling-conversion-me\u{2026}  Build reusable conversion models \u{2014} funnel/step conversion rates, drop-off, and\u{2026}",
  "     /modeling-dimension-tab\u{2026}  Build reusable dimension / lookup tables for a star schema \u{2014} country/region,\u{2026}",
  "     /modeling-product-usage\u{2026}  Build reusable product-usage and engagement models \u{2014} retention, stickiness, and\u{2026}",
  "     /modeling-warehouse-fou\u{2026}  Shared foundations for building reusable data models in PostHog, on either of two\u{2026}",
  "     /principle-model-the-do\u{2026}  Apply when writing stateful logic, or when code branches a lot or repeats a shape\u{2026}",
  "     \u{2193} more below",
];

/** The selector's other rows (as recorded). */
const otherModels = [
  "    Grok 4.6                 High Fast",
  "    Composer 2.5             Fast",
  "    Claude Opus 5.5          300K Medium",
  "    Claude Opus 5            300K High",
  "    Claude Opus 4.8          300K High",
  "    Gemini 4 Argon           Medium",
  "    Muse Wonder              300K High",
  "    GPT-5.6 Sol              272K Medium",
];

const titled = (title: string): string => title + " ".repeat(width - title.length - "Max mode: OFF".length) + "Max mode: OFF";

/** One Cursor pane on Grok 4.7: its lines above the box, its folder, its placeholder, and its menu's state. */
export class DemoCursorMenu {
  readonly state: CursorMenuState;

  constructor(
    /** The lines above the box (the header, the chat so far), each as drawn. */
    private readonly head: readonly string[],
    private readonly folder: string,
    initial: Partial<CursorMenuState> = {},
    /** The box's placeholder ("Add a follow-up" after a turn). */
    private readonly placeholder = "Plan, search, build anything",
    readonly model = "Grok 4.7",
  ) {
    this.state = { stage: "box", draft: "", window: "256K", effort: "medium", fast: false, percent: null, arrow: 0, approval: "default", ...initial };
  }

  /** The footer under the box: `Grok 4.7 256K Medium Fast · 6.8%`. */
  footer(): string {
    const { window, effort, fast, percent, approval } = this.state;
    const row = `  ${this.model} ${window} ${cursorEffortLabel(effort)}${fast ? " Fast" : ""}${percent === null ? "" : ` \u{B7} ${percent}%`}`;
    return approval === "autoReview" ? `${row}    Auto-review` : approval === "runEverything" ? `${row}    Run Everything` : row;
  }

  /** Edit Parameters' rows, in order. */
  private rows(): { readonly label: string; readonly radio: boolean; readonly chosen: boolean }[] {
    const { window, effort, fast } = this.state;
    return [
      ...cursorWindows.map((each) => ({ label: each, radio: true, chosen: each === window })),
      ...cursorEfforts.map((level) => ({ label: cursorEffortLabel(level), radio: true, chosen: level === effort })),
      { label: "Fast", radio: false, chosen: fast },
    ];
  }

  /** What `pane.read` shows now. */
  screen(): string {
    return [...this.head, ...this.bottom()].join("\n");
  }

  /** The box and what is under it (the footer, the list, the selector or Edit Parameters), a line each. */
  bottom(): string[] {
    const { stage, draft } = this.state;
    const box = `  ${arrow} ${stage === "box" || stage === "commands" ? draft || this.placeholder : this.placeholder}`;
    const lines = [box, "", ""];
    if (stage === "box") {
      lines.push(this.footer(), `  ${this.folder}`);
    } else if (stage === "commands") {
      lines.push(...commandRows);
    } else if (stage === "models") {
      const { window, effort, fast } = this.state;
      lines.push(titled(" Available models"), "", " Filter:", "", "    Auto");
      lines.push(` ${arrow}  ${this.model.padEnd(25)}${window} ${cursorEffortLabel(effort)}${fast ? " Fast" : ""} (Tab to modify)`);
      lines.push(...otherModels, "", " 1-10 of 46", "", " Type to filter \u{2022} Enter to select \u{2022} Tab to edit");
    } else {
      const rows = this.rows();
      const draw = (index: number): string => {
        const row = rows[index]!;
        const mark = row.radio ? (row.chosen ? "\u{25CF}" : "\u{25CB}") : row.chosen ? "\u{25C9}" : "\u{25EF}";
        return `${this.state.arrow === index ? `  ${arrow} ` : "    "}${mark} ${row.label}${row.radio && row.chosen ? " \u{2713}" : ""}`;
      };
      lines.push(titled(` ${this.model} \u{2014} Edit Parameters`), "", "  Context", draw(0), draw(1), "", "  Effort", draw(2), draw(3), draw(4), draw(5), "", draw(6), "");
      lines.push(" \u{2191}/\u{2193} to navigate \u{2022} Enter to select \u{2022} Esc to go back");
    }
    return lines;
  }

  /** `pane.send_text`: typed into the box (a `/model` opens the command list). */
  type(text: string): void {
    const state = this.state;
    if (state.stage !== "box" && state.stage !== "commands") return;
    state.draft += text;
    state.stage = state.draft.startsWith("/model") ? "commands" : "box";
  }

  /** `pane.send_keys`, one after another. */
  keys(keys: readonly string[]): void {
    for (const key of keys) this.key(key);
  }

  private key(key: string): void {
    const state = this.state;
    switch (state.stage) {
      case "box":
        if (key === "Backspace") state.draft = state.draft.slice(0, -1);
        else if (key === "Enter" && (state.draft === "/auto-review" || state.draft === "/run-everything")) {
          if (state.draft === "/auto-review") state.approval = state.approval === "autoReview" ? "default" : "autoReview";
          else state.approval = state.approval === "default" ? "runEverything" : "default";
          state.draft = "";
        }
        return;
      case "commands":
        if (key === "Enter") {
          state.stage = "models";
          state.draft = "";
        } else if (key === "Escape") {
          state.stage = "box";
        } else if (key === "Backspace") {
          state.draft = state.draft.slice(0, -1);
          if (!state.draft.startsWith("/model")) state.stage = "box";
        }
        return;
      case "models":
        if (key === "Tab") {
          state.stage = "parameters";
          state.arrow = 0;
        } else if (key === "Escape" || key === "Enter") {
          state.stage = "box";
        }
        return;
      case "parameters":
        if (key === "Down") state.arrow = Math.min(6, state.arrow + 1);
        else if (key === "Up") state.arrow = Math.max(0, state.arrow - 1);
        else if (key === "Escape") state.stage = "models";
        else if (key === "Enter") {
          if (state.arrow < 2) state.window = cursorWindows[state.arrow]!;
          else if (state.arrow < 6) state.effort = cursorEfforts[state.arrow - 2]!;
          else state.fast = !state.fast;
        }
        return;
    }
  }
}
