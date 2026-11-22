// Captures 303-304 (development builds only, through dev-modes.ts): Antigravity CLI's built-in list.
// They run right after 294-299, on the Antigravity pane 296 started on the demo's build-box: build-box's `agy models`
// answers as 1.5.14 does over SSH (exit 1, "Please sign in to view available models.": demo-remote.ts), so its list is
// the built-in one under the sign-in line. 303: the pane's Model chip clicked: the built-in models grouped, the line over
// them. 304: New agent on build-box with Antigravity CLI chosen and nothing remembered for the machine: Model and
// Effort shown, Gemini 4 Neon and High preselected, the line under them. Build-box's list put back after.

import type { CaptureStep } from "./capture";

/** The build-box workspace New agent opens in (research), as 294's. */
const workspaceId = "w3";

const wait = "const wait = (ms) => new Promise((done) => setTimeout(done, ms));";

const chipsMeasure = `(() => ({
  chips: [...document.querySelectorAll(".cmp-bar .chip")].map((chip) => ({ class: chip.className, text: (chip.textContent ?? "").replace(/\\s+/g, " ").trim() })),
  line: [...document.querySelectorAll(".model-picker .mp-line, .model-picker .mp-note, .model-picker [role=status]")].map((node) => (node.textContent ?? "").replace(/\\s+/g, " ").trim()),
  picker: [...document.querySelectorAll(".model-picker .mp-row")].map((row) => (row.textContent ?? "").replace(/\\s+/g, " ").trim()),
  pickerText: (document.querySelector(".model-picker")?.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 400),
}))()`;

const dialogMeasure = `(() => ({
  field: document.querySelector(".na-model")?.getAttribute("aria-label") ?? null,
  model: document.querySelector(".na-model")?.getAttribute("data-model") ?? null,
  effort: (() => { const select = document.querySelector("select.na-effort"); return select === null ? null : { value: select.value, options: [...select.options].map((option) => option.textContent) }; })(),
  line: [...document.querySelectorAll(".na-models .fb-note")].map((node) => node.textContent),
  bare: document.querySelector(".na-mnote")?.textContent ?? null,
}))()`;

/** The pane's Model chip clicked (an open chip menu closed first). */
const clickModelChip = `(async () => {
  ${wait}
  document.querySelector(".chip.pick.open .pick-b")?.click();
  await wait(300);
  const button = document.querySelector(".chip.pick.model .pick-b");
  if (button === null) return false;
  button.click();
  await wait(1200);
  return true;
})()`;

/** 303's measure, then its menu closed (the measure runs after the picture), so New agent opens over a plain Chat. */
const chipsMeasureThenClose = `(() => {
  const measured = ${chipsMeasure};
  document.querySelector(".chip.pick.open .pick-b")?.click();
  return measured;
})()`;

/** Nothing remembered for build-box's Antigravity CLI (294-296 kept Gemini 4 Neon, Extra high), then its row chosen. */
const forgetAndChooseAgy = (buildBox: string): string => `(async () => {
  ${wait}
  const key = "adari.newAgent.models";
  const map = JSON.parse(localStorage.getItem(key) ?? "{}");
  delete map[${JSON.stringify(`${buildBox}|agy`)}];
  localStorage.setItem(key, JSON.stringify(map));
  document.querySelector('.na-kinds [data-kind="shell"]')?.click();
  await wait(300);
  document.querySelector('.na-kinds [data-kind="agy"]')?.click();
  await wait(1500);
  return document.querySelector(".na-model") !== null;
})()`;

/**
 * The two steps; `setup("built-in")` makes build-box's `agy models` answer as over SSH and reads it again (before
 * 303), `setup("restore")` puts it back (after 304).
 */
export function agyListCaptureSteps(ids: { macMini: string; buildBox: string }, setup: (step: "built-in" | "restore") => Promise<void>): CaptureStep[] {
  return [
    {
      name: "303-agy-builtin-model-menu",
      what: "The Antigravity CLI pane's Model chip clicked while build-box's `agy models` cannot be read over SSH: the built-in models grouped (Gemini 4 Neon first), the one running ticked, under the line Antigravity CLI cannot list its models over SSH (its sign-in is in the Mac's keychain). Showing the models Adari knows.; nothing picked",
      before: () => setup("built-in"),
      commands: [],
      page: [clickModelChip],
      settleMs: 800,
      measure: chipsMeasureThenClose,
    },
    {
      name: "304-agy-builtin-new-agent",
      what: "New agent on build-box's research with Antigravity CLI chosen and nothing remembered for the machine, its list the built-in one: Model Gemini 4 Neon and Effort High preselected (Start would add --model gemini-4-neon-high), the sign-in line under them",
      commands: [{ type: "open-new-agent", hostId: ids.buildBox, workspaceId }],
      page: [forgetAndChooseAgy(ids.buildBox)],
      settleMs: 800,
      measure: dialogMeasure,
      afterCapture: () => setup("restore"),
    },
  ];
}
