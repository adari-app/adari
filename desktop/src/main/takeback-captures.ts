// Captures 175-176 (development builds only, through dev-modes.ts): the Mac
// mini's marigold pane (Claude) in Chat while its turn runs (Herdr: working), its screen drawn as Claude Code
// 2.1.322 draws a queue (demo-claude-queue.ts). 175: a message typed and sent from the box waits in Claude's queue:
// its bubble says Queued with Take back. 176: Esc pressed in the box: the message is back in the box, its bubble
// gone, the note says "Taken back. Claude keeps working.", Claude's queue and input row empty, the turn still
// running. The pane's status and screen are put back after 176.

import type { CaptureStep } from "./capture";

/** What the demo does for each step: the pane working with its Claude queue shown, or as it was. */
export type TakeBackDemo = (step: "queue" | "restore") => Promise<void>;

/** The pane the captures show (compact-captures.ts's marigold pane). */
export const takeBackCapturePane = "wB:p1";

/** The message the user sends while Claude works, then wants back. */
export const takeBackCaptureText = "Also rename the export to toCsv";

/** The message typed in the box as the user's keys would, then Return. */
const typeAndSend = `(async () => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const box = document.querySelector(".cmp textarea");
  if (box === null) return false;
  box.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(takeBackCaptureText)});
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(150);
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return true;
})()`;

/** Esc in the box, as the user's key would. */
const pressEsc = `(() => {
  const box = document.querySelector(".cmp textarea");
  if (box === null) return false;
  box.focus();
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  return true;
})()`;

/** What 175-176 show, measured: the box, its note, the user's bubbles and their labels, Take back, the Stop square. */
const takeBackMeasure = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  return {
    box: document.querySelector(".cmp textarea")?.value ?? null,
    note: text(document.querySelector(".cmp-note-t")) || null,
    pending: [...document.querySelectorAll(".msg-u.pending")].map((node) => text(node)),
    takeBack: [...document.querySelectorAll(".pst-take")].map(text),
    stop: document.querySelector(".send.stop") !== null,
  };
})()`;

export function takeBackCaptureSteps(ids: { macMini: string }, demo: TakeBackDemo): CaptureStep[] {
  return [
    {
      name: "175-takeback-queued",
      what: "The marigold pane (Mac mini, Claude) in Chat while its turn runs (Herdr: working); a message typed in the box and sent waits in Claude Code's queue (its screen shows the queued line, ctrl+enter to send now, and Press up to edit queued messages): the user's bubble says Queued with Take back",
      before: () => demo("queue"),
      commands: [
        { type: "settings", open: false },
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: takeBackCapturePane },
        { type: "set-tab", tab: "chat" },
      ],
      page: [typeAndSend],
      settleMs: 3_000,
      measure: takeBackMeasure,
    },
    {
      name: "176-takeback-taken",
      what: "Esc pressed in the box: Up then Ctrl+U went to Claude's box (never Escape, never Return), the message is back in the box, its bubble gone, the note says Taken back. Claude keeps working., and the turn still runs",
      commands: [],
      page: [pressEsc],
      settleMs: 3_000,
      measure: takeBackMeasure,
      afterCapture: () => demo("restore"),
    },
  ];
}
