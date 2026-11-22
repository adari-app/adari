// Captures 294-299 (development builds only, through dev-modes.ts): Antigravity CLI's models, level and mode
// 294: New agent on the demo's build-box with Antigravity CLI chosen, its Model field open: the
// machine's `agy models` (the demo answers with the samples' models-1.5.14.txt) one row per model, Gemini 4 Neon
// first. 295: Gemini 4 Neon picked and its Effort row set to Extra high. 296: Start: the new pane starts with
// `--model gemini-4-neon-xhigh` (the demo's Antigravity pane, demo-agy-pane.ts). 297: that pane in Chat: its Model,
// Effort and Permissions chips from its last row. 298: its Model chip's list open (the CLI's models grouped, the one
// it runs ticked). 299: its Effort chip's menu (Gemini 4 Neon's levels). New agent opens the pane it made, in Chat, so
// 297 names no pane id.

import type { CaptureStep } from "./capture";

/** The build-box workspace the pane starts in (research). */
const workspaceId = "w3";

const wait = "const wait = (ms) => new Promise((done) => setTimeout(done, ms));";

const pickerMeasure = `(() => ({
  field: document.querySelector(".na-model")?.getAttribute("aria-label") ?? null,
  rows: [...document.querySelectorAll(".model-picker .mp-row")].map((row) => (row.textContent ?? "").replace(/\\s+/g, " ").trim()),
  effort: (() => { const select = document.querySelector("select.na-effort"); return select === null ? null : { value: select.value, options: [...select.options].map((option) => option.textContent) }; })(),
  note: document.querySelector(".na-mnote")?.textContent ?? null,
}))()`;

const chipsMeasure = `(() => ({
  chips: [...document.querySelectorAll(".cmp-bar .chip")].map((chip) => ({ class: chip.className, text: (chip.textContent ?? "").replace(/\\s+/g, " ").trim(), label: chip.querySelector("[aria-label]")?.getAttribute("aria-label") ?? null })),
  picker: [...document.querySelectorAll(".model-picker .mp-row")].map((row) => (row.textContent ?? "").replace(/\\s+/g, " ").trim()),
  menu: [...document.querySelectorAll(".chip-menu [role^=menuitem]")].map((item) => ({ text: (item.textContent ?? "").replace(/\\s+/g, " ").trim(), checked: item.getAttribute("aria-checked") })),
}))()`;

/** New agent's Antigravity CLI row clicked, then its Model field. */
const openAgyPicker = `(async () => {
  ${wait}
  document.querySelector('.na-kinds [data-kind="agy"]')?.click();
  await wait(600);
  const field = document.querySelector(".na-model");
  if (field === null) return false;
  field.click();
  await wait(1500);
  return true;
})()`;

/** Gemini 4 Neon's row clicked in the open picker, then the Effort row set to Extra high as the user's pick would. */
const chooseNeonXhigh = `(async () => {
  ${wait}
  const row = [...document.querySelectorAll(".model-picker .mp-row")].find((node) => node.querySelector(".id")?.textContent === "gemini-4-neon-high" || node.getAttribute("title") === "gemini-4-neon-high");
  if (row === undefined) return false;
  row.click();
  await wait(400);
  const select = document.querySelector("select.na-effort");
  if (select === null) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "xhigh");
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(400);
  return true;
})()`;

const startAndWait = `(async () => {
  ${wait}
  document.querySelector(".dlg.na .btn.pri")?.click();
  await wait(3500);
  return true;
})()`;

const clickChip = (kind: "model" | "effort"): string => `(async () => {
  ${wait}
  document.querySelector(".chip.pick.open .pick-b")?.click();
  await wait(300);
  const button = document.querySelector(".chip.pick.${kind} .pick-b");
  if (button === null) return false;
  button.click();
  await wait(600);
  return true;
})()`;

export function agyModelsCaptureSteps(ids: { macMini: string; buildBox: string }): CaptureStep[] {
  return [
    {
      name: "294-agy-new-agent-models",
      what: "New agent on build-box's research with Antigravity CLI chosen, its Model field open: the machine's `agy models` one row per model (Gemini 4 Neon first, then Argon, Hydrogen, the two Orchestrators, Gemini 3.8 Flash, the two Claude models, GPT-OSS 120B); nothing picked",
      commands: [
        { type: "settings", open: false },
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: true },
        { type: "set-host-folded", hostId: ids.buildBox, folded: false },
        { type: "select-pane", hostId: ids.buildBox, paneId: `${workspaceId}:p1` },
        { type: "open-new-agent", hostId: ids.buildBox, workspaceId },
      ],
      page: [openAgyPicker],
      settleMs: 800,
      measure: pickerMeasure,
    },
    {
      name: "295-agy-new-agent-neon-xhigh",
      what: "Gemini 4 Neon picked: the Model field says it and the Effort row lists its levels (Low, Medium, High (model default), Extra high), Extra high chosen; Start will add --model gemini-4-neon-xhigh",
      commands: [],
      page: [chooseNeonXhigh],
      settleMs: 600,
      measure: pickerMeasure,
    },
    {
      name: "296-agy-started",
      what: "Start: the new Antigravity CLI pane in build-box's research, started by Herdr with --model gemini-4-neon-xhigh",
      commands: [],
      page: [startAndWait],
      settleMs: 500,
    },
    {
      name: "297-agy-chat-chips",
      what: "The new pane in Chat: its box's Model (Gemini 4 Neon), Effort (Extra high) and Permissions (Auto) chips, read from its screen's last row (auto \u{00B7} Gemini 4 Neon \u{00B7} xhigh)",
      // New agent opened the new pane, in Chat.
      commands: [{ type: "set-tab", tab: "chat" }],
      settleMs: 3_000,
      measure: chipsMeasure,
    },
    {
      name: "298-agy-model-list",
      what: "The pane's Model chip clicked: the machine's models grouped, Gemini 4 Neon ticked; nothing picked",
      commands: [],
      page: [clickChip("model")],
      settleMs: 800,
      measure: chipsMeasure,
    },
    {
      name: "299-agy-effort-menu",
      what: "The pane's Effort chip clicked: Gemini 4 Neon's levels (Low, Medium, High, Extra high ticked); nothing picked",
      commands: [],
      page: [clickChip("effort")],
      settleMs: 800,
      measure: chipsMeasure,
    },
  ];
}
