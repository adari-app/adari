// Captures 173-174 (development builds only, through dev-modes.ts): the Mac
// mini's marigold pane (Claude) in Chat, its Running strip holding a background command, a monitor and a
// background agent. 173: a monitor's turn runs (Herdr: working) and `/compact` typed in the box is held:
// the box empties, its note says Compact is queued, the ring's card says "Compact after this turn". 174: the
// turn ends (Herdr: done, the three still running), Compact goes, Claude Code's compaction lands in the
// transcript: the ring is at rest again, Chat shows the compaction and "Compacted" once, the strip still
// runs. The pane's status is put back after 174.

import type { CaptureStep } from "./capture";

/** What the demo does for each step: the pane working, done (and then compacted), or as it was. */
export type CompactDemo = (step: "working" | "done" | "restore") => Promise<void>;

/** The pane the captures show. */
export const compactCapturePane = "wB:p1";

/** `/compact` typed in the box as the user's keys would, then Return; then the ring's card pinned open. */
const typeCompactAndOpenCard = `(async () => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const box = document.querySelector(".cmp textarea");
  if (box === null) return false;
  box.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "/compact");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(150);
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(300);
  document.querySelector(".cmp-bar .ctx-ring")?.click();
  return true;
})()`;

/** The ring's card closed (a click on the ring unpins it). */
const closeCard = `(() => {
  if (document.querySelector(".ctx-card") !== null) document.querySelector(".cmp-bar .ctx-ring")?.click();
  return document.querySelector(".ctx-card") === null;
})()`;

/** What 173-174 show, measured: the box, its note, the ring and its card, the Running strip, Chat's compaction lines. */
const compactMeasure = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const ring = document.querySelector(".cmp-bar .ctx-ring");
  const card = document.querySelector(".ctx-card .btn");
  return {
    box: document.querySelector(".cmp textarea")?.value ?? null,
    note: text(document.querySelector(".cmp-note-t")) || null,
    ring: ring?.className ?? null,
    cardButton: card === null ? null : text(card),
    cardDisabled: card === null ? null : card.getAttribute("aria-disabled"),
    strip: [...document.querySelectorAll(".run-item")].map((item) => item.getAttribute("data-kind") + ": " + text(item)),
    working: text(document.querySelector(".working-t")) || null,
    pickLines: [...document.querySelectorAll(".pick-line")].map(text),
    compactedNotices: [...document.querySelectorAll(".chat-scroll *")].filter((node) => node.children.length === 0 && /^Conversation compacted$/.test(text(node))).length,
    commandRows: [...document.querySelectorAll(".cmd-row .cmd")].map(text),
  };
})()`;

export function compactCaptureSteps(ids: { macMini: string }, demo: CompactDemo): CaptureStep[] {
  return [
    {
      name: "173-compact-held",
      what: "The marigold pane (Mac mini, Claude) in Chat while a monitor's turn runs (Herdr: working), its Running strip with a background command, a monitor and a background agent; /compact typed in the box and Return pressed: the box is empty, its note says Compact is queued for when this turn ends, the ring's card says Compact after this turn (held), nothing typed into Claude",
      before: () => demo("working"),
      commands: [
        { type: "settings", open: false },
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: compactCapturePane },
        { type: "set-tab", tab: "chat" },
      ],
      page: [typeCompactAndOpenCard],
      settleMs: 3_000,
      measure: compactMeasure,
    },
    {
      name: "174-compact-done",
      what: "The monitor's turn ended (Herdr: done) with the three still running: the held Compact went, Claude Code's compaction landed in the transcript, so the ring is at rest, Chat shows the compaction and Compacted once, and the Running strip still runs",
      before: () => demo("done"),
      commands: [],
      page: [closeCard],
      settleMs: 5_000,
      measure: compactMeasure,
      afterCapture: () => demo("restore"),
    },
  ];
}
