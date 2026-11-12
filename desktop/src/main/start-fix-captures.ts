// Captures 149-154 (development builds only,
// through dev-modes.ts), on the demo's Mac mini with the demo Herdr's start
// quirks set for each step and put back after (demo-backend.ts
// DemoStartQuirks; never a real connection): New agent after a shell that was
// busy for its first starts, then started (149); one that never reached its
// prompt (150); an agent waiting at its own sign-in screen (151); a program
// the machine does not have (152); New workspace made from `~/Code/hello-app`,
// its shell there (153); and from a folder the machine does not have, the
// line saying where Herdr put it (154). The dialogs are driven as the user's clicks
// would (the kind, then Start), so their own lines show.

import type { CaptureStep } from "./capture";
import type { DemoStartQuirks } from "./demo/demo-backend";

/** Esc on every open dialog until none is left, and the step before's line (the toast) dismissed as the user's click would. */
const closeDialogs = `(async () => {
  document.querySelector(".app-toast")?.click();
  for (let i = 0; i < 6 && document.querySelector(".dlg") !== null; i += 1) {
    document.querySelector(".dlg").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((done) => setTimeout(done, 120));
  }
  return document.querySelector(".dlg") === null;
})()`;

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

/** What the picture shows: the dialog's line, the toast, the main area's title and lines, the ready screen's. */
const startMeasure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const dialog = document.querySelector(".dlg");
  const rect = dialog?.getBoundingClientRect();
  return {
    dialog: rect === undefined ? null : { title: dialog.getAttribute("aria-label"), width: Math.round(rect.width), height: Math.round(rect.height), note: text(dialog.querySelector(".df .note")) },
    toast: text(document.querySelector(".app-toast")) || null,
    main: text(document.querySelector(".main .mh")).slice(0, 200) || null,
    ready: document.querySelector(".nw-made") === null ? null : { title: text(document.querySelector(".nw-made h1")), line: text(document.querySelector(".nw-made .sub")) },
    rawCode: /\\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+:/.test(document.body.innerText),
  };
})()`;

export function startFixCaptureSteps(
  ids: { macMini: string },
  page: (script: string) => Promise<unknown>,
  quirks: (hostId: string, quirks: Omit<DemoStartQuirks, "home"> | null, fallBackHome?: boolean) => Promise<void>,
): CaptureStep[] {
  const step = (name: string, what: string, set: Omit<DemoStartQuirks, "home">, fallBackHome: boolean, extra: Pick<CaptureStep, "commands"> & Partial<CaptureStep>): CaptureStep => ({
    name,
    what,
    settleMs: 3_000,
    measure: startMeasure,
    ...extra,
    before: async () => {
      await page(closeDialogs);
      await quirks(ids.macMini, set, fallBackHome);
    },
    afterCapture: async () => {
      await page(closeDialogs);
      await quirks(ids.macMini, null);
    },
  });
  const newAgent = { type: "open-new-agent", hostId: ids.macMini, workspaceId: "w7" } as const;
  return [
    step("149-start-busy-then-started", "New agent (Codex, New tab) on a shell still in its startup files: Herdr answered agent_pane_busy to its first 6 starts, the same start went again every 250 ms, and Codex started; its tab is the one shown", { busy: { codex: 6 } }, false, {
      commands: [newAgent],
      page: [startKind("codex")],
    }),
    step("150-start-busy-gave-up", "New agent (Codex) on a shell that never reached its prompt: after 15 s the dialog says so in words and the new tab is closed", { busy: { codex: Number.POSITIVE_INFINITY } }, false, {
      commands: [newAgent],
      page: [startKind("codex")],
      settleMs: 17_000,
    }),
    step("151-start-waiting", "New agent (Codex) answered agent_not_ready: Codex runs in its tab at its own sign-in screen; the tab stays, is shown, and the line says to answer it there", { notReady: ["codex"] }, false, {
      commands: [newAgent],
      page: [startKind("codex")],
    }),
    step("152-start-not-installed", "New agent (Claude Code, agents.json `claude` typed) where the machine has no claude: its shell's `zsh: command not found: claude` named, the tab left open", { missing: ["claude"] }, false, {
      commands: [newAgent],
      page: [startKind("claude")],
    }),
    step("153-workspace-from-tilde", "New workspace made from ~/Code/hello-app on the Mac mini: sent as /Users/demo/Code/hello-app, so its shell is there and the main area says so", {}, true, {
      commands: [{ type: "create-workspace", hostId: ids.macMini, folder: "~/Code/hello-app", name: null }],
      settleMs: 1_200,
    }),
    step("154-workspace-elsewhere", "New workspace made from ~/Code/gone-app, a folder the Mac mini does not have: Herdr put its shell in the home, and the main area says where instead of claiming the folder", {}, true, {
      commands: [{ type: "create-workspace", hostId: ids.macMini, folder: "~/Code/gone-app", name: null }],
      settleMs: 1_200,
    }),
  ];
}
