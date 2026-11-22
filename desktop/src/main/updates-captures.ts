// Captures 290-292 (development builds only, through dev-modes.ts),
// on the demo's machines, never a real connection: Settings › Machines with
// Update all (3) above the Mac mini's integrations (three out of date, one
// missing) (290); Settings › Updates › Agent CLIs with an update command set on
// the Mac mini and Codex's own printed command offered on build-box, whose
// Codex pane shows its update notice (291); the Update click's confirmation
// with the exact command and the machine's name (292); then Agent CLIs' Other
// agents, every other kind the machine starts with no mark, Grok Build's update
// command set on the Mac mini with Update and the rest one line each with Add
// update command (293). Nothing is run: the confirmation is closed with Esc.
// Each step puts the machines back after its picture.

import type { CaptureStep } from "./capture";

/** What a step sets before its picture (null: all put back). */
export interface UpdatesChange {
  /** The Mac mini's integration states on the demo's Herdr. */
  readonly states?: Readonly<Record<string, string>>;
  /** The Mac mini's Codex update command (saved into the demo machine's own agents.json). */
  readonly command?: string;
  /** Other kinds' update commands on the Mac mini (only `otherCaptureKinds`; absent: none). */
  readonly others?: Readonly<Record<string, string>>;
}

/** The kinds a step may set under Other agents (each put back to none after). */
export const otherCaptureKinds: readonly string[] = ["grok"];

const settingsMeasure = (macMini: string): string => `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const machine = document.querySelector('[data-machine="${macMini}"]');
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    updateAll: text(machine?.querySelector("[data-integrations-update-all]")) || null,
    items: [...(machine?.querySelectorAll("[data-integration]") ?? [])].map((node) => text(node)),
    emDash: document.querySelector(".settings-page")?.innerText.includes("\\u2014") ?? null,
  };
})()`;

const clisMeasure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    self: text(document.querySelector("[data-update-self]")) || null,
    rows: [...document.querySelectorAll("[data-update-command]")].map((node) => ({
      row: node.getAttribute("data-update-command"),
      value: node.querySelector("input")?.value ?? null,
      update: node.querySelector("[data-agent-update-button]") !== null,
      suggestion: text(node.querySelector("[data-update-suggestion]")) || null,
    })),
    confirm: text(document.querySelector("[data-agent-update-confirm]")) || null,
    emDash: document.querySelector(".settings-page")?.innerText.includes("\\u2014") ?? null,
  };
})()`;

const othersMeasure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const group = document.querySelector("[data-update-others]");
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    head: text(group?.querySelector(".set-row-head")) || null,
    lines: [...(group?.querySelectorAll("[data-update-add]") ?? [])].map((node) => node.getAttribute("data-update-add")),
    rows: [...(group?.querySelectorAll("[data-update-command]") ?? [])].map((node) => ({
      row: node.getAttribute("data-update-command"),
      value: node.querySelector("input")?.value ?? null,
      update: node.querySelector("[data-agent-update-button]") !== null,
    })),
    foot: text(document.querySelector('[data-set-sec="agent-clis"] .set-foot')) || null,
    emDash: document.querySelector(".settings-page")?.innerText.includes("\\u2014") ?? null,
  };
})()`;

/** Scrolls Agent CLIs' Other agents into view. */
const showOthers = `(() => { document.querySelector("[data-update-others]")?.scrollIntoView({ block: "start" }); return true; })()`;

/** Scrolls the Agent CLIs section into view. */
const showClis = `(() => { document.querySelector('[data-set-sec="agent-clis"]')?.scrollIntoView({ block: "start" }); return true; })()`;

/** Esc on the confirmation, as the person's key would (nothing is run). */
const closeConfirm = `(async () => {
  for (let i = 0; i < 4 && document.querySelector("[data-agent-update-confirm]") !== null; i += 1) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((done) => setTimeout(done, 120));
  }
  return document.querySelector("[data-agent-update-confirm]") === null;
})()`;

export function updatesCaptureSteps(ids: { macMini: string }, change: (what: UpdatesChange | null) => Promise<void>, page: (script: string) => Promise<unknown>): CaptureStep[] {
  const back = () => change(null);
  return [
    {
      name: "290-upd-update-all",
      what: "Settings › Machines: above the Mac mini's integration line, Update all (3): Claude Code, Codex and Grok Build out of date, Cursor Agent not installed (it keeps its own Install and is not counted)",
      commands: [{ type: "settings", open: true, section: "machines" }],
      settleMs: 2_500,
      measure: settingsMeasure(ids.macMini),
      before: () => change({ states: { claude: "outdated", codex: "outdated", grok: "outdated", cursor: "not_installed" } }),
      afterCapture: back,
    },
    {
      name: "291-upd-agent-clis",
      what: "Settings › Updates › Agent CLIs: Claude Code's line that it installs its own updates (no command); Codex's update command per machine: codex-update set on the Mac mini with Update beside it, build-box empty with Codex's own printed command offered (Use this), never filled in by itself",
      commands: [{ type: "settings", open: true, section: "updates" }],
      page: [showClis],
      settleMs: 3_500,
      measure: clisMeasure,
      before: () => change({ command: "codex-update" }),
    },
    {
      name: "292-upd-confirm",
      what: "Update clicked on the Mac mini's Codex row: the one confirmation, Run `codex-update` on Mac mini?, the exact command and what Adari does (a shell tab named Update Codex, the command typed, nothing read or closed); Cancel and Run. Closed with Esc after the picture: nothing ran",
      commands: [],
      page: [`(() => { document.querySelector('[data-agent-update="${ids.macMini}/codex"] [data-agent-update-button]')?.click(); return true; })()`],
      settleMs: 1_200,
      measure: clisMeasure,
      afterCapture: async () => {
        await page(closeConfirm);
        await back();
      },
    },
    {
      name: "293-upd-other-agents",
      what: "Settings › Updates › Agent CLIs, Other agents: every other kind the machines start, with no mark; Grok Build's update command grok-update set on the Mac mini with Update beside it, build-box's Grok Build field empty; Pi and the rest one line each with Add update command; nothing says an update exists",
      // Closed and opened again: the page reads the machines' agents.json as Updates shows.
      commands: [
        { type: "settings", open: false },
        { type: "settings", open: true, section: "updates" },
      ],
      page: [showOthers],
      settleMs: 3_500,
      measure: othersMeasure,
      before: () => change({ others: { grok: "grok-update" } }),
      afterCapture: back,
    },
  ];
}
