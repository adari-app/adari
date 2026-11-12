// Captures 210-214 (development builds only, through dev-modes.ts), on the demo's
// Mac mini, never a real connection; each model list is the demo machine's answer to the agent's own list command
// (demo-model-lists.ts). Nothing is picked in them: a row's pick is the tests' (livepick-main.test.ts).
// 210: the Model menu on the running Grok pane (Grok's ids, the line "Grok also makes this its default for new
// sessions."). 211: the Model menu on the Cursor pane: Cursor's families, "claude opus" typed, so Claude Opus 5 (its
// name inside Claude Opus 5.5's, its row opening Cursor's own list) shows beside Claude Opus 5.5. 212: New agent's
// Model field for OpenCode, its picker open with "beam" typed: display names, the id as small text. 213: Beam Free
// chosen and Start pressed: the new OpenCode pane. 214: that pane's Model menu: OpenCode's display names. The pane
// 213 made is closed after.

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";

/** What a step changes in the demo: the panes New agent made marked, then closed again. */
export type LivepickDemo = (step: "mark-panes" | "close-made") => Promise<void>;

/** The demo's Grok Build pane (tidepool-narration · grok). */
const grokPane = "wD:pK";
/** The demo's Cursor pane (harbor · cursor). */
const cursorPane = "wC:p1";
/** The workspace New agent opens for (herdr-companion). */
const newAgentWorkspace = "w7";

const wait = "const wait = (ms) => new Promise((done) => setTimeout(done, ms));";

/** The Model chip's menu opened as the user's click would (an open chip's menu closed first). */
const openModelChip = `(async () => {
  ${wait}
  document.querySelector(".chip.pick.open .pick-b")?.click();
  await wait(300);
  const button = document.querySelector(".chip.pick.model .pick-b");
  if (button === null) return false;
  button.click();
  await wait(500);
  return true;
})()`;

/** Text typed into the open picker's search box (New agent's when it is open) as the user's keys would. */
const typeSearch = (text: string): string => `(async () => {
  ${wait}
  const input = document.querySelector(".dlg.na .model-picker .mp-search input") ?? document.querySelector(".model-picker .mp-search input");
  if (input === null) return false;
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(300);
  return true;
})()`;

/**
 * 211's picker closed with Esc in its search box (in a real window New agent taking the focus closes it; the
 * capture's window never has the system's focus), then New agent's OpenCode row clicked and its Model field (its
 * picker opens).
 */
const newAgentOpenCodePicker = `(async () => {
  ${wait}
  document.querySelector(".chip .model-picker input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(200);
  document.querySelector('.na-kinds [data-kind="opencode"]')?.click();
  await wait(300);
  const field = document.querySelector(".na-model");
  if (field === null) return false;
  field.click();
  await wait(900);
  return true;
})()`;

/** In New agent's open picker, the row of model `id` clicked; then Start. */
const chooseAndStart = (id: string): string => `(async () => {
  ${wait}
  const row = [...document.querySelectorAll(".dlg.na .model-picker .mp-row")].find((node) => node.querySelector(".id")?.textContent === ${JSON.stringify(id)} || node.getAttribute("title") === ${JSON.stringify(id)});
  if (row === undefined) return false;
  row.click();
  await wait(400);
  document.querySelector(".dlg.na .btn.pri")?.click();
  return true;
})()`;

/** What each picture shows, measured: the chips, the picker's line and rows (each row's title too). */
const measure = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const picker = document.querySelector(".dlg.na .model-picker") ?? document.querySelector(".model-picker");
  return {
    chips: [...document.querySelectorAll(".chip.pick .pick-b")].map((node) => node.getAttribute("aria-label")),
    pickers: document.querySelectorAll(".model-picker").length,
    inWindow: picker === null ? null : picker.getBoundingClientRect().top >= 0 && picker.getBoundingClientRect().bottom <= window.innerHeight,
    picker: picker === null ? null : {
      search: picker.querySelector(".mp-search input")?.value ?? null,
      line: text(picker.querySelector(".mp-line")) || null,
      rows: [...picker.querySelectorAll(".mp-h, .mp-row")].map((node) => node.classList.contains("mp-h") ? "# " + text(node) : (node.getAttribute("aria-selected") === "true" ? "[x] " : "") + text(node.querySelector(".l")) + (node.querySelector(".id") ? " (" + text(node.querySelector(".id")) + ")" : "") + (node.classList.contains("off") ? " [off]" : "") + " | " + node.getAttribute("title")),
      action: text(picker.querySelector(".mp-act")) || null,
    },
    newAgent: document.querySelector(".dlg.na") === null ? null : {
      kind: document.querySelector(".na-kinds .na-kind.on")?.getAttribute("data-kind") ?? null,
      model: document.querySelector(".na-model")?.getAttribute("aria-label") ?? null,
    },
    emDash: document.body.innerText.includes("\\u2014"),
  };
})()`;

export function livepickCaptureSteps(ids: { macMini: string }, demo: LivepickDemo): CaptureStep[] {
  const pane = (paneId: string): CommandBody[] => [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId },
    { type: "set-tab", tab: "chat" },
  ];
  return [
    {
      name: "210-livepick-grok-menu",
      what: "The Model menu on the running Grok Build pane: Grok's ids from grok models, each row a pick (none greyed), the line \u{201C}Grok also makes this its default for new sessions.\u{201D}, Choose in the Terminal\u{2026} under it; nothing picked",
      commands: pane(grokPane),
      page: [openModelChip],
      settleMs: 1_500,
      measure,
    },
    {
      name: "211-livepick-cursor-families",
      what: "The Model menu on the Cursor pane with claude opus typed: Cursor's families (one row each, as its own list names them, no ids), Claude Opus 5 beside Claude Opus 5.5 with its title saying it opens Cursor's own list in the Terminal (typed, it would pick Claude Opus 5.5), Choose in the Terminal\u{2026} under it; nothing picked",
      commands: pane(cursorPane),
      page: [openModelChip, typeSearch("claude opus")],
      settleMs: 1_500,
      measure,
    },
    {
      name: "212-livepick-opencode-new-agent",
      what: "New agent's Model field for OpenCode on the Mac mini, its picker open with beam typed: OpenCode's display names read with --verbose (Beam Free, …) with each id as the small text",
      before: () => demo("mark-panes"),
      commands: [
        { type: "settings", open: false },
        { type: "open-new-agent", hostId: ids.macMini, workspaceId: newAgentWorkspace },
      ],
      page: [newAgentOpenCodePicker, typeSearch("beam")],
      settleMs: 1_500,
      measure,
    },
    {
      name: "213-livepick-opencode-pane",
      what: "Beam Free chosen and Start pressed: the new OpenCode pane in Chat (started with its model as a start flag)",
      commands: [],
      page: [chooseAndStart("opencode/beam-free")],
      settleMs: 4_000,
      measure,
    },
    {
      name: "214-livepick-opencode-menu",
      what: "The Model menu on that running OpenCode pane: OpenCode's display names under each provider, each row a live pick (none greyed, no read-only line), Beam Free ticked (New agent's start flag), Show the Terminal under it; nothing picked; the pane is closed after",
      commands: [{ type: "set-tab", tab: "chat" }],
      page: [openModelChip],
      settleMs: 1_500,
      measure,
      afterCapture: () => demo("close-made"),
    },
  ];
}
