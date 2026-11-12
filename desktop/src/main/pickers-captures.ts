// Captures 181-187 (development builds only, through dev-modes.ts), on the demo's
// Mac mini, never a real connection: each model list is the demo machine's answer to the agent's own list command
// (demo-model-lists.ts, cut from real list output). 181: the Model chip's picker on the Atelier Codex pane
// (its transcript naming gpt-6.1-sol). 182: the picker on the Cursor pane with a search typed. 183: New agent's
// picker for OpenCode, its providers as groups. 184-185: the Effort menu for two Codex models with different levels
// (gpt-6.1-sol: low to ultra, low its default; gpt-6-luna: low to max, medium its default). 186: New agent with a
// Codex model and effort chosen. 187: the new pane's chips before its first reply. The pane 186-187 made is closed
// after (the Atelier pane's transcript keeps the model it was given; these captures run last).

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";

/** What a step changes in the demo: the Atelier Codex pane's model named, the panes New agent made closed again. */
export type PickersDemo = (step: { readonly codexModel: { readonly model: string; readonly effort: string } } | "mark-panes" | "close-made") => Promise<void>;

/** The demo's Atelier Codex pane on the Mac mini. */
export const pickersCodexPane = "w5:pH";
/** The demo's Cursor pane (its footer: Grok 4.7 256K Medium Fast). */
const cursorPane = "wC:p1";
/** The workspace New agent opens for (herdr-companion). */
const newAgentWorkspace = "w7";

const wait = "const wait = (ms) => new Promise((done) => setTimeout(done, ms));";

/** A chip's button clicked (Model or Effort) as the user's click would (once more first when its menu is open: it closes). */
const clickChip = (kind: "model" | "effort"): string => `(async () => {
  ${wait}
  const button = document.querySelector(".chip.pick.${kind} .pick-b");
  if (button === null) return false;
  if (button.parentElement?.classList.contains("open")) {
    button.click();
    await wait(300);
  }
  button.click();
  await wait(400);
  return true;
})()`;

/** Text typed into the open picker's search box as the user's keys would. */
const typeSearch = (text: string): string => `(async () => {
  ${wait}
  const input = document.querySelector(".model-picker .mp-search input");
  if (input === null) return false;
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(300);
  return true;
})()`;

/**
 * 182's picker closed with Esc in its search box (in a real window the dialog taking the focus closes it; the
 * capture's window never has the system's focus, so no focus event comes).
 */
const closeChipPicker = `(async () => {
  ${wait}
  document.querySelector(".chip .model-picker input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(200);
  return true;
})()`;

/** New agent's agent row clicked, then its Model field (the picker opens below it, or above when there is no room). */
const newAgentPicker = (kind: string): string => `(async () => {
  ${wait}
  document.querySelector('.na-kinds [data-kind="${kind}"]')?.click();
  await wait(300);
  const field = document.querySelector(".na-model");
  if (field === null) return false;
  field.click();
  await wait(900);
  return true;
})()`;

/** 185's Effort menu closed (its chip clicked again, as the user's click would) before New agent opens over it. */
const closeOpenChip = `(async () => {
  ${wait}
  document.querySelector(".chip.pick.open .pick-b")?.click();
  await wait(300);
  return true;
})()`;

/** The open picker's list scrolled to `top` (as the user's wheel would), so the end of one group and the next header show. */
const scrollPicker = (top: number): string => `(async () => {
  ${wait}
  const list = document.querySelector(".model-picker .mp-list");
  if (list === null) return false;
  list.scrollTop = ${top};
  list.dispatchEvent(new Event("scroll"));
  await wait(300);
  return true;
})()`;

/** In New agent's open picker, the row of model `id` clicked; then the Effort list set to `effort` as the user's pick would. */
const chooseInNewAgent = (id: string, effort: string): string => `(async () => {
  ${wait}
  const row = [...document.querySelectorAll(".model-picker .mp-row")].find((node) => node.querySelector(".id")?.textContent === ${JSON.stringify(id)} || node.getAttribute("title") === ${JSON.stringify(id)});
  if (row === undefined) return false;
  row.click();
  await wait(300);
  const select = document.querySelector("select.na-effort");
  if (select === null) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, ${JSON.stringify(effort)});
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(300);
  return true;
})()`;

/** New agent's Cancel clicked (183's dialog closed). */
const closeNewAgent = `(async () => {
  ${wait}
  document.querySelector(".dlg.na .df .btn:not(.pri)")?.click();
  await wait(300);
  return true;
})()`;

/** New agent's Start clicked. */
const startNewAgent = `(async () => {
  document.querySelector(".dlg.na .btn.pri")?.click();
  return true;
})()`;

/** What each picture shows, measured: the chips, the picker's search, line and rows, the Effort menu, New agent's fields. */
const measure = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const picker = document.querySelector(".dlg.na .model-picker") ?? document.querySelector(".model-picker");
  const select = document.querySelector("select.na-effort");
  return {
    chips: [...document.querySelectorAll(".chip.pick .pick-b")].map((node) => node.getAttribute("aria-label")),
    pickers: document.querySelectorAll(".model-picker").length,
    side: picker === null ? null : (picker.classList.contains("above") ? "above" : "below"),
    inWindow: picker === null ? null : picker.getBoundingClientRect().top >= 0 && picker.getBoundingClientRect().bottom <= window.innerHeight,
    picker: picker === null ? null : {
      search: picker.querySelector(".mp-search input")?.value ?? null,
      focused: document.activeElement === picker.querySelector(".mp-search input"),
      line: text(picker.querySelector(".mp-line")) || null,
      rows: [...picker.querySelectorAll(".mp-h, .mp-row")].map((node) => node.classList.contains("mp-h") ? "# " + text(node) : (node.getAttribute("aria-selected") === "true" ? "[x] " : "") + text(node.querySelector(".l")) + (node.querySelector(".id") ? " (" + text(node.querySelector(".id")) + ")" : "") + (node.classList.contains("hl") ? " <" : "")),
      height: Math.round(picker.getBoundingClientRect().height),
    },
    effortMenu: [...document.querySelectorAll(".chip.pick.effort .chip-menu .ctx-i")].map((node) => text(node)),
    newAgent: document.querySelector(".dlg.na") === null ? null : {
      kind: document.querySelector(".na-kinds .na-kind.on")?.getAttribute("data-kind") ?? null,
      model: document.querySelector(".na-model")?.getAttribute("aria-label") ?? null,
      effort: select === null ? null : select.options[select.selectedIndex]?.textContent ?? null,
      efforts: select === null ? [] : [...select.options].map((option) => option.textContent),
    },
    emDash: document.body.innerText.includes("\\u2014"),
  };
})()`;

export function pickersCaptureSteps(ids: { macMini: string }, demo: PickersDemo): CaptureStep[] {
  const pane = (paneId: string): CommandBody[] => [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId },
    { type: "set-tab", tab: "chat" },
  ];
  return [
    {
      name: "181-pickers-codex-picker",
      what: "The Model chip's picker on the Atelier Codex pane (its transcript names gpt-6.1-sol): the search box focused, Agent's default first (greyed: Codex's default is its config's), Codex's own list from codex debug models with each display name and slug, gpt-6.1-sol ticked, a star per row",
      before: () => demo({ codexModel: { model: "gpt-6.1-sol", effort: "low" } }),
      commands: pane(pickersCodexPane),
      page: [clickChip("model")],
      settleMs: 2_000,
      measure,
    },
    {
      name: "182-pickers-cursor-search",
      what: "The Model chip's picker on the Cursor pane (its footer: Grok 4.7 256K Medium Fast) with grok fast typed: Cursor's ids from cursor-agent --list-models ranked on id and label, the first match highlighted",
      commands: pane(cursorPane),
      page: [clickChip("model"), typeSearch("grok fast")],
      settleMs: 1_500,
      measure,
    },
    {
      name: "183-pickers-opencode-groups",
      what: "New agent's Model field for OpenCode on the Mac mini, its picker open (above the field: no room below it in the window; 182's picker closed with Esc first): Agent's default first, then OpenCode's models under each provider's header (scrolled to where the opencode group ends and the next begins), the list windowed",
      before: () => demo("mark-panes"),
      commands: [{ type: "open-new-agent", hostId: ids.macMini, workspaceId: newAgentWorkspace }],
      page: [closeChipPicker, newAgentPicker("opencode"), scrollPicker(250)],
      settleMs: 1_500,
      measure,
    },
    {
      name: "184-pickers-codex-effort-sol",
      what: "The Effort menu on the Atelier Codex pane while it runs gpt-6.1-sol: its own levels Low to Ultra, Low marked as its default",
      commands: pane(pickersCodexPane),
      page: [closeNewAgent, clickChip("effort")],
      settleMs: 1_500,
      measure,
    },
    {
      name: "185-pickers-codex-effort-luna",
      what: "The Effort menu on the same pane once its transcript names gpt-6-luna: Low to Max (no Ultra), Medium marked as its default",
      before: () => demo({ codexModel: { model: "gpt-6-luna", effort: "medium" } }),
      commands: pane(pickersCodexPane),
      page: [clickChip("effort")],
      settleMs: 2_000,
      measure,
    },
    {
      name: "186-pickers-new-agent-chosen",
      what: "New agent for Codex in herdr-companion with gpt-6-luna chosen in the picker and Max in Effort (the levels gpt-6-luna takes, Medium its default)",
      commands: [{ type: "open-new-agent", hostId: ids.macMini, workspaceId: newAgentWorkspace }],
      page: [closeOpenChip, newAgentPicker("codex"), chooseInNewAgent("gpt-6-luna", "max")],
      settleMs: 1_500,
      measure,
    },
    {
      name: "187-pickers-new-pane-chips",
      what: "Start pressed: the new Codex pane (started with -m gpt-6-luna -c model_reasoning_effort=max) in Chat before its first reply: its chips say gpt-6-luna and Max at once, the Model chip's title saying New agent chose it",
      commands: [],
      page: [startNewAgent],
      after: { afterMs: 2_500, commands: [{ type: "set-tab", tab: "chat" }] },
      settleMs: 4_000,
      measure,
      afterCapture: () => demo("close-made"),
    },
  ];
}

/**
 * Capture 200: the Cursor pane's Model chip open on a running pane, the search narrowing to Grok 4.7. It lists
 * Cursor's families, each row a pick (the footer's family ticked), with "Choose in the Terminal…" under it. Nothing
 * is picked.
 */
export function cursorPickCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "200-cursor-model-read-only",
      what: "The Model chip's picker on the Cursor pane (its chips read off the footer: Grok 4.7, Medium) with grok 4.7 typed: Cursor's families (Grok 4.7 ticked, the footer's family), each row a pick, and Choose in the Terminal\u{2026} under it; nothing picked",
      commands: [
        { type: "settings", open: false },
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: cursorPane },
        { type: "set-tab", tab: "chat" },
      ],
      page: [closeOpenChip, clickChip("model"), typeSearch("grok 4.7")],
      settleMs: 1_500,
      measure,
    },
  ];
}
