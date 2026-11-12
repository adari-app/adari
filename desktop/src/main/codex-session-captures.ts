// Captures 155-157 (development builds
// only, through dev-modes.ts), on the demo's Mac mini, never a real
// connection: Settings › Chat's Codex row, its stock line `codex` and the note
// that Adari adds --no-daemon (155); the Atelier Codex pane's Chat while Herdr names
// it a session whose own header is another folder's (the pane's folder moved
// for the step, the session kept: demo-backend.ts setPaneSession), not shown
// (156); the same pane with no session named, the Codex sentence added (157).
// Each step puts the pane back after its picture.

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";

/** The demo's Atelier Codex pane (its rollout's header names /Users/demo/code/atelier). */
export const codexSessionPaneId = "w5:pH";
/** The folder the pane is given in 156: not its session's. */
export const codexSessionOtherCwd = "/Users/demo/code/lumen-app";

/** What a step changes on the pane: its folder, or the session Herdr names (null: none). */
export type CodexSessionChange = { readonly cwd: string } | { readonly session: null };

const chatMeasure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    empty: text(document.querySelector(".chat-empty")) || null,
    showTerminal: [...document.querySelectorAll(".chat-empty button")].map((node) => text(node)),
    rows: document.querySelectorAll(".chat .msg, .chat .turn").length,
    emDash: document.body.innerText.includes("\\u2014"),
  };
})()`;

function settingsMeasure(macMini: string): string {
  return `(() => {
    const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const row = document.querySelector('[data-start="${macMini}"] [data-start-kind="codex"]');
    return {
      window: { width: window.innerWidth, height: window.innerHeight },
      title: text(row?.querySelector(".set-k")),
      note: text(row?.querySelector(".set-rd")) || null,
      placeholder: row?.querySelector("input")?.getAttribute("placeholder") ?? null,
      others: [...document.querySelectorAll('[data-start="${macMini}"] [data-start-kind]')].map((node) => ({ kind: node.getAttribute("data-start-kind"), note: text(node.querySelector(".set-rd")) || null })),
      emDash: document.querySelector(".settings-page")?.innerText.includes("\\u2014") ?? null,
    };
  })()`;
}

export function codexSessionCaptureSteps(ids: { macMini: string }, change: (hostId: string, paneId: string, what: CodexSessionChange | null) => Promise<void>): CaptureStep[] {
  const chat: CommandBody[] = [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId: codexSessionPaneId },
    { type: "set-tab", tab: "chat" },
  ];
  const paneStep = (name: string, what: string, set: CodexSessionChange): CaptureStep => ({
    name,
    what,
    commands: chat,
    settleMs: 2_500,
    measure: chatMeasure,
    before: () => change(ids.macMini, codexSessionPaneId, set),
    afterCapture: () => change(ids.macMini, codexSessionPaneId, null),
  });
  return [
    {
      name: "155-codex-settings-note",
      what: "Settings › Chat › Start commands, Mac mini's Codex row: its stock line still codex (grey, in the field), and its note: Adari adds --no-daemon so Chat can find the session",
      commands: [{ type: "settings", open: true, section: "chat" }],
      settleMs: 1_500,
      measure: settingsMeasure(ids.macMini),
    },
    paneStep(
      "156-codex-other-folder",
      `The Atelier Codex pane's Chat while Herdr names it a Codex session whose own header (session_meta) says /Users/demo/code/atelier, the pane being in ${codexSessionOtherCwd}: not shown, the line names the folder and says to restart Codex from Adari, with Show the terminal`,
      { cwd: codexSessionOtherCwd },
    ),
    paneStep(
      "157-codex-no-session",
      "The Atelier Codex pane's Chat with no session named: the no-session line and, for Codex only, why (Codex 0.167's shared background server, --no-daemon) and what to do, with Show the terminal",
      { session: null },
    ),
  ];
}
