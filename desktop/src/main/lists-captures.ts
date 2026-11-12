// Captures 201-204 (development builds only, through dev-modes.ts), on the demo's
// machines, never a real connection, no agent's CLI run.
//
// - 201: the sidebar with Claude Code, Codex, Cursor Agent, Grok Build, OpenCode and Qwen Code (an early kind), each
//   started by New agent's start in build-box's research: Cursor Agent's, Grok Build's and OpenCode's drawings beside
//   Claude Code's and Codex's, Qwen Code's monogram untinted.
// - 202: Cursor's Model menu on the Mac mini's Cursor pane, its own list failing as over SSH with the login keychain
//   locked (the demo's Mac mini answers so for this capture only), shown from the list read on "This Mac" with the
//   quiet line. The demo has no This Mac: build-box stands in for it while 202 runs (its list is the same fixture).
// - 203: build-box's Codex pane blocked on Codex's update question at start: the card with its three choices.
// - 204: Claude Code's Model menu on a Mac mini Claude pane with its quiet line.
// Everything 202 and 203 change is put back after each.

import type { CaptureStep } from "./capture";

/** What a step changes in the demo: 202's keychain and stand-in This Mac, 203's update question, or put back. */
export type ListsDemo = (step: "keychain" | "codex-update" | "restore") => Promise<void>;

/** build-box's research workspace, where 201's panes start. */
const workspaceId = "w3";
/** The Mac mini's Cursor pane. */
const cursorPane = "wC:p1";
/** build-box's Codex pane (trendline). */
export const listsCodexPane = "w2:p1";
/** A Mac mini Claude pane at rest (the pickers captures' Atelier pane is Codex's; this one is Claude Code's). */
const claudePane = "w9:p1";

/** The kinds 201 starts, in the sidebar's order. */
export const listsCaptureKinds = ["claude", "codex", "cursor", "grok", "opencode", "qwen"] as const;

/** Codex 0.167.0's update question at start, under its header cell. */
export const listsCodexUpdateScreen = [
  "╭──────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.167.0)   │",
  "╰──────────────────────────────╯",
  "",
  "  ✨ Update available! 0.167.0 -> 0.168.0",
  "",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "",
  "› 1. Update now (runs `npm install -g @openai/codex`)",
  "  2. Skip",
  "  3. Skip until next version",
  "",
  "  enter continue · esc skip",
  "",
].join("\n");

const wait = "const wait = (ms) => new Promise((done) => setTimeout(done, ms));";

/** The Model chip's button clicked as the user's click would. */
const openModelChip = `(async () => {
  ${wait}
  document.querySelector(".chip.pick.open .pick-b")?.click();
  await wait(300);
  const button = document.querySelector(".chip.pick.model .pick-b");
  if (button === null) return false;
  button.click();
  await wait(1200);
  return true;
})()`;

/** Each sidebar row's kind glyph: its name (title), its drawing, its letters, any colour of its own. */
const sidebarMeasure = `(() => ({
  kinds: [...document.querySelectorAll(".sb .row .kd")].map((kd) => ({ title: kd.getAttribute("title"), glyph: kd.querySelector("svg")?.getAttribute("class"), letters: kd.querySelector("text")?.textContent ?? null, color: kd.querySelector("svg")?.getAttribute("style") ?? null })),
}))()`;

/** The open picker's lines and its first rows. */
const pickerMeasure = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const picker = document.querySelector(".model-picker");
  return {
    chips: [...document.querySelectorAll(".chip.pick .pick-b")].map((node) => node.getAttribute("aria-label")),
    picker: picker === null ? null : {
      lines: [...picker.querySelectorAll(".mp-line")].map((node) => ({ className: node.className, text: text(node) })),
      rows: [...picker.querySelectorAll(".mp-row")].slice(0, 8).map((node) => text(node.querySelector(".l"))),
      action: text(picker.querySelector(".mp-act")) || null,
    },
  };
})()`;

/** The card: its header, question and buttons. */
const cardMeasure = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const card = document.querySelector(".ncard");
  return card === null ? null : {
    kind: card.getAttribute("data-needs-card"),
    header: text(card.querySelector(".nc-t")),
    question: text(card.querySelector(".nc-q")),
    buttons: [...card.querySelectorAll(".nc-opt")].map((node) => ({ key: node.getAttribute("data-key"), label: text(node.querySelector(".l")), detail: text(node.querySelector(".d")) || null, on: node.classList.contains("on") })),
    hint: text(card.querySelector(".nc-hint")),
  };
})()`;

export function listsCaptureSteps(ids: { macMini: string; buildBox: string }, demo: ListsDemo): CaptureStep[] {
  const fromShell = { type: "select-pane" as const, hostId: ids.buildBox, paneId: `${workspaceId}:p1` };
  // One start per step, each from research's first pane (as agents-captures does), each given time to settle.
  const starts: CaptureStep[] = listsCaptureKinds.map((kind, index) => ({
    name: `201-start-${String(index + 1).padStart(2, "0")}-${kind}`,
    what: `Started on build-box's research: ${kind} (a step toward 201-lists-sidebar)`,
    commands: [
      ...(index === 0
        ? [
            { type: "settings" as const, open: false },
            { type: "set-mode" as const, mode: "projects" as const },
            { type: "set-host-folded" as const, hostId: ids.macMini, folded: true },
            { type: "set-host-folded" as const, hostId: ids.buildBox, folded: false },
          ]
        : []),
      fromShell,
      { type: "start-new-agent" as const, hostId: ids.buildBox, workspaceId, kind, folder: null },
    ],
    settleMs: 2_500,
  }));
  return [
    ...starts,
    {
      name: "201-lists-sidebar",
      what: "build-box's research with Claude Code, Codex, Cursor Agent (a pointer), Grok Build (a mallet), OpenCode (open code brackets) and Qwen Code (an early kind: its monogram, no tint), each glyph in the row's ink and titled with its agent's name; the sidebar only",
      commands: [fromShell],
      // Research's rows unfolded, then its new rows (down to Qwen Code's) scrolled into view.
      page: [
        `[...document.querySelectorAll(".sb-list .row.more")].forEach((more) => more.click())`,
        `new Promise((done) => setTimeout(() => { [...document.querySelectorAll(".sb .row .kd")].filter((kd) => kd.getAttribute("title") === "Qwen Code").at(-1)?.scrollIntoView({ block: "center" }); done(null); }, 400))`,
      ],
      settleMs: 1_200,
      measure: sidebarMeasure,
      crop: { selector: ".sb", pad: 0 },
    },
    {
      name: "202-lists-cursor-this-mac",
      what: "Cursor's Model menu on the Mac mini's Cursor pane: its own list failed as over SSH (the login keychain locked), so the list read on This Mac shows (build-box stands in for This Mac in the demo), under Cursor's read-only line and the quiet line \"List read on This Mac; Mac mini's own list needs its login keychain.\"; nothing picked",
      before: () => demo("keychain"),
      commands: [
        { type: "set-host-folded", hostId: ids.buildBox, folded: true },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: cursorPane },
        { type: "set-tab", tab: "chat" },
      ],
      page: [openModelChip],
      settleMs: 1_500,
      measure: pickerMeasure,
      afterCapture: () => demo("restore"),
    },
    {
      name: "203-lists-codex-update-card",
      what: "build-box's Codex pane blocked on Codex's update question at start, in Chat: \"Codex has an update\", its first line, and its three choices as buttons in Codex's words (Update now (runs `npm install -g @openai/codex`) marked: Return; Skip: Esc; Skip until next version: answered in the Terminal); nothing pressed",
      before: () => demo("codex-update"),
      commands: [
        { type: "set-host-folded", hostId: ids.macMini, folded: true },
        { type: "set-host-folded", hostId: ids.buildBox, folded: false },
        { type: "select-pane", hostId: ids.buildBox, paneId: listsCodexPane },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 4_000,
      measure: cardMeasure,
      afterCapture: () => demo("restore"),
    },
    {
      name: "204-lists-claude-model-note",
      what: "Claude Code's Model menu on a Mac mini Claude pane: its list and the one quiet line \"Claude Code also makes this the default for new sessions on this Mac.\"; nothing picked",
      commands: [
        { type: "set-host-folded", hostId: ids.buildBox, folded: true },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: claudePane },
        { type: "set-tab", tab: "chat" },
      ],
      page: [openModelChip],
      settleMs: 1_500,
      measure: pickerMeasure,
    },
  ];
}
