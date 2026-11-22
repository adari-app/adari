// Captures 300-302: the Needs card for Codex 0.171.0's own question in Plan mode
// (question 1 of 2 with long descriptions, then the last question) and for "Implement this plan?" after it, on the
// demo's Codex pane (Mac mini, lumen-onboarding-perf, wA:pM). `show` blocks the pane on a screen (or, given a status,
// reports that status instead: 302's plan list shows on a pane Herdr says is done, as Codex 0.171.0 draws it after it
// marks its turn done); null puts back the screens and status it had. Each step closes Settings and zooms the pane
// first, so each stands alone under --capture-only=300,301,302.

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";
import { demoCodexQuestionFirst, demoCodexQuestionLast, demoCodexQuestionPlan } from "./demo/demo-codex-question";

/** The card as these captures measure it: where it stands, the question, each option whole, where the answer goes. */
const codexQuestionMeasure = `(() => {
  const card = document.querySelector(".ncard");
  const text = (selector) => card?.querySelector(selector)?.textContent ?? null;
  return {
    card: card?.getAttribute("data-needs-card") ?? null,
    header: text(".nc-t"),
    progress: text(".nc-progress"),
    question: text(".nc-q"),
    options: card === null ? [] : [...card.querySelectorAll(".nc-opt")].map((b) => {
      const words = (b.querySelector(".k")?.textContent ?? "") + " " + (b.querySelector(".l")?.textContent ?? "") + " / " + (b.querySelector(".d")?.textContent ?? "");
      return b.classList.contains("on") ? "[" + words + "]" : words;
    }),
    flow: text(".nc-flow"),
    hint: text(".nc-hint"),
    terminalButton: card !== null && card.querySelector(".nc-term") !== null,
    pills: [...document.querySelectorAll(".sb .row.ny")].map((row) => (row.querySelector(".nm")?.textContent ?? "") + ": " + (row.querySelector(".pill")?.textContent ?? "")),
  };
})()`;

export function codexQuestionCaptureSteps(
  ids: { macMini: string },
  show: (hostId: string, paneId: string, screens: readonly string[] | null, status?: "done") => Promise<void>,
): CaptureStep[] {
  const pane = "wA:pM";
  const open: CommandBody[] = [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId: pane },
    // The pane shares workers 1 with two others: zoomed, the whole card shows.
    { type: "zoom-pane", hostId: ids.macMini, paneId: pane, zoomed: true },
    { type: "set-tab", tab: "chat" },
  ];
  return [
    {
      name: "300-codex-question-first",
      what: "The Codex pane blocked on Codex 0.171.0's own question in Plan mode, question 1 of 2 with long descriptions: Codex asks, Question 1 of 2, the question, its three options (Codex's (Recommended) kept) each with its whole description, Return's mark on 1, the line saying the answer moves Codex on to question 2, and None of the above as the Terminal's (Answer in Terminal); Awaiting Input in the sidebar",
      before: () => show(ids.macMini, pane, [demoCodexQuestionFirst]),
      commands: open,
      settleMs: 4_000,
      measure: codexQuestionMeasure,
    },
    {
      name: "301-codex-question-last",
      what: "The same pane on the last question (2 of 2, one unanswered, as Codex shows it after a digit on question 1): Question 2 of 2, its two options with descriptions, and the line saying the tap answers question 2, then Codex sends all 2 answers or asks in the Terminal first if another still has none",
      before: () => show(ids.macMini, pane, [demoCodexQuestionLast]),
      commands: open,
      settleMs: 4_000,
      measure: codexQuestionMeasure,
    },
    {
      name: "302-codex-question-plan",
      what: "After both answers, Codex's Implement this plan? on the pane Herdr reports done (Codex ends its turn before it draws the list): its three choices in Codex's words with their descriptions, the first marked, and the line saying either Yes starts the work now and No keeps Codex in Plan mode; no Question N of M, no Terminal line; Awaiting Input in the sidebar",
      before: () => show(ids.macMini, pane, [demoCodexQuestionPlan], "done"),
      commands: open,
      settleMs: 4_000,
      measure: codexQuestionMeasure,
      afterCapture: () => show(ids.macMini, pane, null),
    },
  ];
}
