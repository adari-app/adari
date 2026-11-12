// Captures 121-125 (development builds only, through dev-modes.ts): a dozen kinds Herdr
// reports started on the demo's build-box in a workspace of their own, New agent's list, and the demo's
// Amp pane opening on its own screen, then its Chat tab's line. Nothing else in the
// demo creates on build-box, so its first workspace.create answers `wn1` (shell pane `wn1:p1`) whether
// the steps before run or not. Gemini CLI is a kind Chat reads (kinds.ts), so its pane opens on Chat;
// 124-125 show the Amp pane in every-agent instead, a kind Chat does not read (its own screen, then the line).

import type { CaptureStep } from "./capture";

/** Started in this order; Gemini CLI last, so its pane is the one New agent leaves selected. */
export const agentsCaptureKinds = ["pi", "opencode", "copilot", "amp", "agy", "cline", "droid", "kimi", "qwen", "hermes", "kiro", "gemini"] as const;
const workspaceId = "wn1";

/** Which glyph and name each sidebar row shows, and the open pane's view (measured with each picture). */
const sidebarMeasure = `(() => ({
  kinds: [...document.querySelectorAll(".row .kd")].map((kd) => ({ title: kd.getAttribute("title"), glyph: kd.querySelector("svg")?.getAttribute("class"), letters: kd.querySelector("text")?.textContent ?? null, color: kd.querySelector("svg")?.style.color || null })),
  tab: document.querySelector(".main .seg .on")?.textContent ?? null,
}))()`;

export function agentsCaptureSteps(ids: { macMini: string; buildBox: string }): CaptureStep[] {
  // One start per step, each given time to settle and each from every-agent's shell pane: each new pane opens on
  // its terminal, and going from one new agent terminal straight to the next keeps the page busy past a command's
  // 10 s answer now and then.
  const fromShell = { type: "select-pane" as const, hostId: ids.buildBox, paneId: `${workspaceId}:p1` };
  const starts: CaptureStep[] = agentsCaptureKinds.slice(0, -1).map((kind, index) => ({
    name: `121-start-${String(index + 1).padStart(2, "0")}-${kind}`,
    what: `Started on build-box's every-agent: ${kind} (a step toward 121-agents-sidebar)`,
    commands: [
      ...(index === 0
        ? [
            { type: "set-mode" as const, mode: "projects" as const },
            { type: "set-host-folded" as const, hostId: ids.macMini, folded: true },
            { type: "set-host-folded" as const, hostId: ids.buildBox, folded: false },
            { type: "create-workspace" as const, hostId: ids.buildBox, folder: "/home/demo/every-agent", name: "every-agent" },
          ]
        : [fromShell]),
      { type: "start-new-agent" as const, hostId: ids.buildBox, workspaceId, kind, folder: null },
    ],
    settleMs: 2_500,
  }));
  return [
    ...starts,
    {
      name: "121-agents-sidebar",
      what: "A dozen kinds Herdr reports, each started by New agent's start on build-box in every-agent: each row's glyph (the monograms in the row's ink; Claude Code, Codex, Gemini CLI, OpenCode and Cursor Agent drawn) named in its tooltip; the Gemini CLI pane, started last, open on Chat (a kind Chat reads)",
      commands: [fromShell, { type: "start-new-agent", hostId: ids.buildBox, workspaceId, kind: agentsCaptureKinds.at(-1)!, folder: null }],
      // every-agent's rows unfolded (its "Show 8 more", the last in the list), then the sidebar scrolled to its end.
      page: [
        `[...document.querySelectorAll(".sb-list .row.more")].at(-1)?.click()`,
        `new Promise((done) => setTimeout(() => { const list = document.querySelector(".sb-list"); if (list) list.scrollTop = list.scrollHeight; done(null); }, 400))`,
      ],
      settleMs: 2_500,
      measure: sidebarMeasure,
    },
    {
      name: "122-new-agent-list",
      what: "New agent on build-box's every-agent: Herdr's order first (Claude Code, Codex, Pi, OpenCode, Cursor Agent, GitHub Copilot, Amp, Gemini CLI, Grok Build), each with its glyph; the list scrolls",
      commands: [{ type: "open-new-agent", hostId: ids.buildBox, workspaceId }],
      settleMs: 900,
      measure: `[...document.querySelectorAll(".na-kind")].map((kind) => kind.querySelector(".t")?.textContent + " · " + kind.querySelector(".d")?.textContent)`,
    },
    {
      name: "123-new-agent-list-end",
      what: "The same list scrolled to its end: the rest by name (Antigravity CLI … Qwen Code), then a shell",
      commands: [],
      page: [`(() => { const list = document.querySelector(".na-kinds"); if (list) list.scrollTop = list.scrollHeight; })()`],
      settleMs: 600,
    },
    {
      name: "124-amp-own-screen",
      what: "New agent closed; every-agent's Amp row opened: the Amp pane on its own screen by default (Chat doesn't read it)",
      commands: [
        { type: "click", selector: ".dlg.na .df .btn:not(.pri)" },
        { type: "click", selector: '.row:has(.kd[title="Amp"])' },
      ],
      settleMs: 1_500,
      measure: sidebarMeasure,
    },
    {
      name: "125-amp-chat-line",
      what: "The Amp pane's Chat tab: its one plain line, and the message box with its Amp chip as on every agent",
      commands: [{ type: "set-tab", tab: "chat" }],
      settleMs: 900,
      measure: `({ line: document.querySelector(".chat-unread")?.textContent ?? null, tab: document.querySelector(".main .seg .on")?.textContent ?? null, box: document.querySelector(".chat-area textarea") !== null })`,
    },
  ];
}
