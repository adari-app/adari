// Captures 190-196 (development builds only, through dev-modes.ts): Chat names
// the kinds it supports and marks the rest Early. 190: a Qwen Code pane (an early kind) started by New agent on the
// demo's build-box, open on Chat: the Chat tab's Early badge and the one plain line at the top of its empty Chat.
// 191: the Mac mini's Atelier Codex pane in Chat (supported): nothing new. 192-193: New agent's list, Antigravity CLI
// where Gemini CLI was, the Early badges beside the early kinds, then its end with "Gemini CLI (deprecated)". 194:
// Settings › Machines with Herdr reporting Pi's, GitHub Copilot's and Qwen Code's integrations on the Mac mini too
// (demo only): the badge beside the early kinds' names there. 195: Settings › Chat's start commands (four supported
// kinds: nothing new). The demo's integrations are put back after 194. 196: the Qwen Code pane split with a new
// Codex: the badge beside its kind in its tile's header.

import type { CaptureStep } from "./capture";

/** What 194 sets on the demo's Herdr (true: the early kinds' integrations reported there; false: put back). */
export type ChatSupportDemo = (early: boolean) => Promise<void>;

/** The early kinds' integrations 194 shows as found on the Mac mini (demo only). */
export const chatSupportCaptureTargets: Readonly<Record<string, string>> = { pi: "current", copilot: "not_installed", qwen: "current" };

/** The build-box workspace the Qwen Code pane starts in (research). */
const workspaceId = "w3";

const badgeMeasure = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  return {
    tab: text(document.querySelector(".main .seg .on")),
    chatTab: text(document.querySelector(".main .agent-seg button")),
    badges: [...document.querySelectorAll(".early-b")].map((badge) => ({ kind: badge.getAttribute("data-chat-early"), title: badge.getAttribute("title"), shown: badge.getBoundingClientRect().width > 0 })),
    earlyLine: text(document.querySelector(".chat-early-line")) || null,
    empty: text(document.querySelector(".chat-empty")) || null,
  };
})()`;

const listMeasure = `[...document.querySelectorAll(".na-kind")].map((kind) => (kind.querySelector(".t")?.textContent ?? "") + (kind.querySelector(".early-b") === null ? "" : " [badge: " + kind.querySelector(".early-b").getAttribute("title") + "]"))`;

const settingsMeasure = `(() => ({
  integrations: [...document.querySelectorAll(".set-int-i")].map((item) => ({ target: item.getAttribute("data-integration"), text: (item.textContent ?? "").replace(/\\s+/g, " ").trim(), badge: item.querySelector(".early-b")?.getAttribute("title") ?? null })),
  startRows: [...document.querySelectorAll("[data-start-kind]")].map((row) => ({ kind: row.getAttribute("data-start-kind"), badge: row.querySelector(".early-b") !== null })),
}))()`;

export function chatSupportCaptureSteps(ids: { macMini: string; buildBox: string }, demo: ChatSupportDemo): CaptureStep[] {
  return [
    {
      name: "190-early-pane-chat",
      what: "A Qwen Code pane (an early kind) started by New agent in build-box's research, open on Chat: its Chat tab says Early (title: Chat for Qwen Code is early. It can miss things; the Terminal is always exact.), and its empty Chat has the same words in one plain line at the top",
      commands: [
        { type: "settings", open: false },
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: true },
        { type: "set-host-folded", hostId: ids.buildBox, folded: false },
        { type: "select-pane", hostId: ids.buildBox, paneId: `${workspaceId}:p1` },
        { type: "start-new-agent", hostId: ids.buildBox, workspaceId, kind: "qwen", folder: null },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 2_500,
      measure: badgeMeasure,
    },
    {
      name: "191-supported-pane-chat",
      what: "The Mac mini's Atelier Codex pane in Chat (a supported kind): its Chat tab and Chat with no badge and no line",
      commands: [
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "w5:pH" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 1_500,
      measure: badgeMeasure,
    },
    {
      name: "192-new-agent-list",
      what: "New agent on build-box's research: Antigravity CLI in the first list where Gemini CLI was (Claude Code, Codex, Pi, OpenCode, Cursor Agent, GitHub Copilot, Amp, Antigravity CLI, Grok Build); Early beside Pi, GitHub Copilot and Antigravity CLI (early until its live test), nothing beside the supported kinds or Amp",
      commands: [{ type: "open-new-agent", hostId: ids.buildBox, workspaceId }],
      settleMs: 900,
      measure: listMeasure,
    },
    {
      name: "193-new-agent-list-end",
      what: "The same list scrolled down: the rest by name, Gemini CLI (deprecated) among them with Early, the other early kinds with Early, the unread kinds with nothing, then a shell",
      commands: [],
      page: [`(() => { const list = document.querySelector(".na-kinds"); const gemini = list?.querySelector('[data-kind="gemini"]'); if (list && gemini) list.scrollTop = gemini.offsetTop - list.offsetTop - 40; })()`],
      settleMs: 600,
    },
    {
      name: "194-settings-integrations",
      what: "Settings › Machines with the demo's Herdr also reporting Pi's, GitHub Copilot's and Qwen Code's integrations on the Mac mini: Early beside those three names, nothing beside Claude Code, Codex, Grok Build or Cursor Agent",
      before: () => demo(true),
      commands: [
        { type: "click", selector: ".dlg.na .df .btn:not(.pri)" },
        { type: "settings", open: true, section: "machines" },
      ],
      settleMs: 2_000,
      measure: settingsMeasure,
      afterCapture: () => demo(false),
    },
    {
      name: "195-settings-start-commands",
      what: "Settings › Chat's start commands: Claude Code, Codex, Grok Build and Cursor Agent, all supported, so no badge (each row asks the same question)",
      commands: [{ type: "settings", open: true, section: "chat" }],
      settleMs: 1_200,
      measure: settingsMeasure,
    },
    {
      name: "196-early-split-tile",
      what: "The Qwen Code pane split right with a new Codex by New agent's Where: in the split, the Qwen Code tile's header has Early beside its kind (the tile's Chat is an icon), the Codex tile's has nothing",
      commands: [
        { type: "settings", open: false },
        // The demo's build-box names its first created pane w3:pn1 when 190 is the first start there (--capture-only=19x);
        // shown first, as a split menu opens on a pane the window shows (its binding).
        { type: "select-pane", hostId: ids.buildBox, paneId: `${workspaceId}:pn1` },
        { type: "set-tab", tab: "chat" },
        { type: "open-new-agent", hostId: ids.buildBox, workspaceId, where: { paneId: `${workspaceId}:pn1`, direction: "right" } },
      ],
      page: [
        `(() => { document.querySelector('.na-kind[data-kind="codex"]')?.click(); return true; })()`,
        `new Promise((done) => setTimeout(() => { document.querySelector(".dlg.na .df .btn.pri")?.click(); done(true); }, 400))`,
      ],
      settleMs: 3_000,
      measure: `(() => [...document.querySelectorAll(".tile-h")].map((h) => ({ name: h.querySelector(".nm")?.textContent ?? null, kind: h.querySelector(".kd")?.textContent ?? null, badge: h.querySelector(".early-b")?.getAttribute("title") ?? null })))()`,
    },
  ];
}
