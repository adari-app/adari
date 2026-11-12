// The demo's Grok pane (Mac mini, tidepool-narration, wD:pK) at its prompt:
// its screen drawn in the shapes Grok Build 1.0.70 drew (the top line's
// `used / window`, the box, its border's `Grok 4.7 (high) · always-approve`),
// invented text. It takes `pane.send_text` into its box and `pane.send_keys`
// as Grok did: Backspace takes a character back, Enter on
// `/model <id> <window> <effort>` switches it (`Switched to …` above the box,
// the border and the window say so, and its summary.json changes at once),
// Enter on `/model` opens its model list. Shift+Tab (BTab)
// cycles its approval mode, default → plan → auto-review → always-approve,
// the border's word after the model and effort (none for the default).
// Sources/HerdrKit/GrokPaneFake.swift is the app's.

import { grokEfforts, grokModelLabel, grokWindows } from "../../shared/agent-settings";

export interface DemoGrokState {
  model: string;
  effort: string;
  window: string;
  draft: string;
  listOpen: boolean;
  switched: string | null;
  /** Its approval mode (approval-modes.ts ids). */
  mode: string;
}

/** Shift+Tab's order and the border's words (the default shows none). */
export const demoGrokModeOrder = ["default", "plan", "autoReview", "alwaysApprove"] as const;
const grokModeWords: Readonly<Record<string, string>> = { plan: "plan", autoReview: "auto-review", alwaysApprove: "always-approve" };

const width = 100;

/**
 * The names Grok Build 1.0.77 draws for its models (grok-live-01: grok-4.7-build-fast is "Grok 4.7 Fast" in
 * its border and its "Switched to" line); null for an id it does not list.
 */
function demoGrokName(model: string): string | null {
  return model === "grok-4.7-build-fast" ? "Grok 4.7 Fast" : grokModelLabel(model);
}

export class DemoGrokPane {
  readonly state: DemoGrokState;

  constructor(
    readonly paneID: string,
    private readonly folder: string,
    private readonly lastLine: string,
    /** After each switch (the demo writes its summary.json again beside the session). */
    private readonly onSwitch: () => void = () => undefined,
    initial: Partial<DemoGrokState> = {},
  ) {
    this.state = { model: "grok-4.7", effort: "high", window: "256k", draft: "", listOpen: false, switched: null, mode: "alwaysApprove", ...initial };
  }

  /** summary.json as Grok keeps it (its folder, its model and effort). */
  summary(cwd: string): string {
    return JSON.stringify({ info: { cwd }, current_model_id: this.state.model, reasoning_effort: this.state.effort });
  }

  /** What `pane.read` shows now. */
  screen(): string {
    const { model, effort, window, draft, listOpen, switched, mode } = this.state;
    const used = "12.4K";
    const right = `${used} / ${window.toUpperCase()} \u{2502} [Dashboard]`;
    const top = `  ${this.folder}`.padEnd(width - right.length) + right;
    const shown = listOpen ? "/model <model> [window] [effort]" : draft;
    const inner = width - 4;
    const word = grokModeWords[mode];
    const label = ` ${demoGrokName(model) ?? model} (${effort})${word === undefined ? "" : ` \u{B7} ${word}`} \u{2500}\u{256F}`;
    return [
      top,
      "",
      `  ${this.lastLine}`,
      ...(switched === null ? [] : ["", `     ${switched}`]),
      ...(listOpen ? ["", "    \u{276F} Grok 4.7           SpaceXAI's latest frontier model", "      Grok 4.6 (current)", ""] : [""]),
      `  \u{256D}${"\u{2500}".repeat(inner)}\u{256E}`,
      `  \u{2502} \u{276F} ${shown}`.padEnd(width - 1) + "\u{2502}",
      `  \u{2570}${"\u{2500}".repeat(inner + 1 - label.length)}${label}`,
      "  Shift+Tab:mode  \u{2502}  Ctrl+.:shortcuts",
    ].join("\n");
  }

  type(text: string): void {
    if (!this.state.listOpen) this.state.draft += text;
  }

  keys(keys: readonly string[]): void {
    const state = this.state;
    for (const key of keys) {
      if (key === "Backspace") state.draft = state.draft.slice(0, -1);
      else if (key === "Escape") state.listOpen = false;
      else if (key === "BTab") {
        const at = demoGrokModeOrder.indexOf(state.mode as (typeof demoGrokModeOrder)[number]);
        state.mode = demoGrokModeOrder[(at + 1) % demoGrokModeOrder.length]!;
      } else if (key === "Enter") {
        const words = state.draft.split(" ");
        if (state.draft === "/model") state.listOpen = true;
        else if (
          words.length === 4 &&
          words[0] === "/model" &&
          grokModelLabel(words[1]!) !== null &&
          (grokWindows as readonly string[]).includes(words[2]!) &&
          (grokEfforts as readonly string[]).includes(words[3]!)
        ) {
          state.model = words[1]!;
          state.window = words[2]!;
          state.effort = words[3]!;
          state.switched = `Switched to ${grokModelLabel(state.model)} (${state.effort} effort)`;
          this.onSwitch();
        } else if (words.length === 2 && words[0] === "/model" && demoGrokName(words[1]!) !== null) {
          // Grok Build 1.0.77's `/model <id>` (the Model menu's live pick): the model, its level kept.
          state.model = words[1]!;
          state.switched = `Switched to ${demoGrokName(state.model)} (${state.effort} effort)`;
          this.onSwitch();
        }
        state.draft = "";
      }
    }
  }
}
