// Captures 220-222 (development builds only, through dev-modes.ts), on the demo's
// Mac mini, never a real connection.
// 220: the Cursor pane's Model menu reopened after a pick main did not send: its not-sent line over the rows (the
// demo's Cursor draws no list under a typed `/model`, so the read-back before Return refuses and the line says the
// command is still in Cursor's box). 221: the Grok Build pane's chips
// 16 s after a pick of Grok 4.7 Build Fast confirmed by its screen ("Switched to Grok 4.7 Fast", the border "Grok 4.7
// Fast"): the Model chip still the pick, past the 10 s wait (the demo's Grok pane waits on a question: it is set
// at its prompt for these two, and put back after). 222: that pane's Model menu: the pick's row ticked.

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";

/** The demo's Grok Build pane (tidepool-narration · grok). */
const grokPane = "wD:pK";
/** The demo's Cursor pane (harbor · cursor). */
const cursorPane = "wC:p1";

const wait = "const wait = (ms) => new Promise((done) => setTimeout(done, ms));";

/** The Model chip's menu opened as the user's click would (an open chip's menu closed first). */
const openModelChip = `(async () => {
  ${wait}
  document.querySelector(".chip .model-picker input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(300);
  const button = document.querySelector(".chip.pick.model .pick-b");
  if (button === null) return false;
  button.click();
  await wait(700);
  return true;
})()`;

/** In the open chip picker, the row labelled `label` clicked as the user's click would (the picker closes, the pick goes). */
const clickRow = (label: string): string => `(async () => {
  ${wait}
  const row = [...document.querySelectorAll(".chip .model-picker .mp-row")].find((node) => node.querySelector(".l")?.textContent === ${JSON.stringify(label)});
  if (row === undefined) return false;
  row.click();
  await wait(400);
  return true;
})()`;

/** A pause on the page (the pick's reads in main, the chip's 10 s wait). */
const pause = (ms: number): string => `(async () => {
  ${wait}
  await wait(${ms});
  return true;
})()`;

/** What each picture shows, measured: the chips, the picker's not-sent line, its line, its ticked row. */
const measure = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const picker = document.querySelector(".chip .model-picker");
  return {
    chips: [...document.querySelectorAll(".chip.pick .pick-b")].map((node) => node.getAttribute("aria-label")),
    composerNote: text(document.querySelector(".cmp-note, .composer-note, .note-line")) || null,
    picker: picker === null ? null : {
      notSent: text(picker.querySelector(".mp-line.notsent")) || null,
      lines: [...picker.querySelectorAll(".mp-line")].map((node) => text(node)),
      ticked: [...picker.querySelectorAll(".mp-row")].filter((node) => node.getAttribute("aria-selected") === "true").map((node) => text(node.querySelector(".l"))),
    },
    emDash: document.body.innerText.includes("\\u2014"),
  };
})()`;

/** What a step changes in the demo: the Grok pane at its prompt (its question set aside), then put back. */
export type LivefixDemo = (step: "grok-idle" | "put-back") => Promise<void>;

export function livefixCaptureSteps(ids: { macMini: string }, demo: LivefixDemo): CaptureStep[] {
  const pane = (paneId: string): CommandBody[] => [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId },
    { type: "set-tab", tab: "chat" },
  ];
  return [
    {
      name: "220-livefix-not-sent-line",
      what: "The Cursor pane's Model menu reopened after a Composer 2.5 pick main did not send (no Return): its line over the rows says why and that /model Composer 2.5 is still in Cursor's box in its terminal",
      commands: pane(cursorPane),
      page: [openModelChip, clickRow("Composer 2.5"), pause(3_000), openModelChip],
      settleMs: 1_000,
      measure,
    },
    {
      name: "221-livefix-grok-chip",
      what: "The Grok Build pane's chips 16 s after a pick of Grok 4.7 Build Fast its screen confirmed (Switched to Grok 4.7 Fast, the border Grok 4.7 Fast): the Model chip is still the pick, past the 10 s wait",
      before: () => demo("grok-idle"),
      commands: pane(grokPane),
      page: [pause(1_500), openModelChip, clickRow("Grok 4.7 Build Fast"), pause(16_000)],
      settleMs: 500,
      measure,
    },
    {
      name: "222-livefix-grok-menu",
      what: "That pane's Model menu: Grok 4.7 Build Fast ticked (the kept pick), not Agent's default",
      commands: [],
      page: [openModelChip],
      settleMs: 800,
      measure,
      afterCapture: () => demo("put-back"),
    },
  ];
}
