// Captures 230-233 (development builds only, through dev-modes.ts), on the demo's Mac
// mini, never a real connection (Chat is supported for Claude Code and Codex; Grok Build, Cursor
// Agent and OpenCode are Early). 230: the Grok Build pane open on Chat: its Chat tab says Early (title: Chat for Grok
// Build is early. …). 231: New agent's list on the Mac mini: Early beside Grok Build, Cursor Agent and OpenCode (and the
// other early kinds), nothing beside Claude Code or Codex. 232: a Claude Code pane open on Chat: no badge, no line. 233:
// Settings › Chat's start commands: Early beside Grok Build and Cursor Agent, nothing beside Claude Code or Codex.
// Nothing is changed in the demo.

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";

/** The demo's Grok Build pane (tidepool-narration · grok). */
const grokPane = "wD:pK";
/** A Mac mini Claude pane at rest (lists-captures.ts's). */
const claudePane = "w9:p1";
/** The workspace New agent opens for (herdr-companion). */
const newAgentWorkspace = "w7";

const badgeMeasure = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  return {
    chatTab: text(document.querySelector(".main .agent-seg button")),
    badges: [...document.querySelectorAll(".early-b")].map((badge) => ({ kind: badge.getAttribute("data-chat-early"), title: badge.getAttribute("title"), shown: badge.getBoundingClientRect().width > 0 })),
    earlyLine: text(document.querySelector(".chat-early-line")) || null,
    emDash: document.body.innerText.includes("\\u2014"),
  };
})()`;

const listMeasure = `[...document.querySelectorAll(".na-kind")].map((kind) => (kind.querySelector(".t")?.textContent ?? "") + (kind.querySelector(".early-b") === null ? "" : " [badge: " + kind.querySelector(".early-b").getAttribute("title") + "]"))`;

const startRowsMeasure = `[...document.querySelectorAll("[data-start-kind]")].map((row) => ({ kind: row.getAttribute("data-start-kind"), badge: row.querySelector(".early-b")?.getAttribute("title") ?? null }))`;

export function twotierCaptureSteps(ids: { macMini: string; buildBox: string }): CaptureStep[] {
  const pane = (paneId: string): CommandBody[] => [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.buildBox, folded: true },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId },
    { type: "set-tab", tab: "chat" },
  ];
  return [
    {
      name: "230-twotier-grok-pane-chat",
      what: "The Mac mini's Grok Build pane open on Chat: its Chat tab says Early (title: Chat for Grok Build is early. It can miss things; the Terminal is always exact.); its Chat and chips as on any pane",
      commands: pane(grokPane),
      settleMs: 2_000,
      measure: badgeMeasure,
    },
    {
      name: "231-twotier-new-agent-list",
      what: "New agent on the Mac mini: Early beside Grok Build, Cursor Agent and OpenCode (and Pi, GitHub Copilot, Antigravity CLI), nothing beside Claude Code, Codex or Amp",
      commands: [{ type: "open-new-agent", hostId: ids.macMini, workspaceId: newAgentWorkspace }],
      settleMs: 1_200,
      measure: listMeasure,
    },
    {
      name: "232-twotier-claude-pane-chat",
      what: "A Mac mini Claude Code pane open on Chat (supported): its Chat tab says Chat only, no badge, no line",
      commands: [{ type: "click", selector: ".dlg.na .df .btn:not(.pri)" }, ...pane(claudePane)],
      settleMs: 2_000,
      measure: badgeMeasure,
    },
    {
      name: "233-twotier-settings-start-commands",
      what: "Settings › Chat's start commands: Early beside Grok Build and Cursor Agent, nothing beside Claude Code or Codex",
      commands: [{ type: "settings", open: true, section: "chat" }],
      settleMs: 1_200,
      measure: startRowsMeasure,
    },
  ];
}
