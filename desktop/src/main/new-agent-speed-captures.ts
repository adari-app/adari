// Captures 283-284 (New agent's timing, development builds only, through dev-modes.ts), on the demo's
// Mac mini, never a real connection. New agent starting Codex there (Herdr's own start: the integration step comes
// before the pane) while Herdr's Codex integration is out of date and the demo's Herdr holds its install for 6 s:
// the dialog names the step once it ran a second (283). New agent starting Codex while the demo's Herdr holds
// agent.start for 6 s: the dialog is gone and the
// window shows the new tab's pane, its own terminal, before Herdr reports the agent (284). Each step puts the
// integration and the holds back after its picture.

import type { CaptureStep } from "./capture";

/** What a step sets before its picture (null: all put back). */
export interface NewAgentSpeedChange {
  readonly states: Readonly<Record<string, string>>;
  readonly holdInstallMs: number;
  readonly holdStartMs: number;
}

/** In the open New agent dialog: the kind clicked, then Start. */
function startKind(kind: string): string {
  return `(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    for (let tries = 0; tries < 60 && document.querySelector(".dlg.na") === null; tries += 1) await wait(50);
    const choice = document.querySelector('.dlg.na .na-kind[data-kind=${JSON.stringify(kind)}]');
    if (choice === null) return false;
    choice.click();
    await wait(250);
    document.querySelector(".dlg.na .df .btn.pri")?.click();
    return true;
  })()`;
}

const measure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    dialog: document.querySelector(".dlg.na") === null ? null : text(document.querySelector(".dlg.na .df .note")),
    toast: text(document.querySelector(".app-toast")) || null,
    tiles: [...document.querySelectorAll("[data-tile]")].map((node) => ({ pane: node.getAttribute("data-tile"), focused: node.classList.contains("focused") })),
    emDash: document.body.innerText.includes("\\u2014"),
  };
})()`;

export function newAgentSpeedCaptureSteps(ids: { macMini: string }, change: (hostId: string, what: NewAgentSpeedChange | null) => Promise<void>): CaptureStep[] {
  const put = (what: NewAgentSpeedChange) => () => change(ids.macMini, what);
  const back = () => change(ids.macMini, null);
  return [
    {
      name: "283-na-speed-step-line",
      what: "New agent (Codex, New tab, Herdr's own start) on the Mac mini with Herdr's Codex integration out of date and its install held 6 s by the demo's Herdr: after a second the dialog's line says Updating Herdr's Codex integration on Mac mini…",
      commands: [
        { type: "settings", open: false },
        { type: "open-new-agent", hostId: ids.macMini, workspaceId: "w7" },
      ],
      page: [startKind("codex")],
      settleMs: 2_200,
      measure,
      before: put({ states: { codex: "outdated" }, holdInstallMs: 6_000, holdStartMs: 0 }),
      afterCapture: async () => {
        await new Promise((done) => setTimeout(done, 6_500));
        await back();
      },
    },
    {
      name: "284-na-speed-pane-at-once",
      what: "New agent (Codex, New tab, Herdr's own start) on the Mac mini with agent.start held 6 s by the demo's Herdr: the dialog is closed and the window shows the new tab's pane, its terminal, before Herdr reports the agent",
      commands: [
        { type: "settings", open: false },
        { type: "open-new-agent", hostId: ids.macMini, workspaceId: "w7" },
      ],
      page: [`(() => { document.querySelector(".app-toast")?.click(); return true; })()`, startKind("codex")],
      settleMs: 2_000,
      measure,
      before: put({ states: {}, holdInstallMs: 0, holdStartMs: 6_000 }),
      afterCapture: async () => {
        await new Promise((done) => setTimeout(done, 6_500));
        await back();
      },
    },
  ];
}
