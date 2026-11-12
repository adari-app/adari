// Captures 134-140: the app's own updates as the user sees them. Settings › Updates in this capture
// run, which is the demo (134: off, no check ever runs); then a fake updater in the
// window's place (demo/demo-updater.ts: no network, no electron-updater)
// finds Adari 0.1.1: the sidebar footer's pill reads Download (135); a click
// on it, and the progress ring while it downloads (136); the download done,
// one toast and the pill's Restart (137, cropped 138); Settings › Updates with
// the download ready (139); Restart clicked, and the capture's question
// answering Restart: Restarting… (140; the fake never quits). The shipped
// updater is put back after. Development builds only (dev-modes.ts).

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";
import { demoUpdateController, type DemoUpdater } from "./demo/demo-updater";
import type { UpdateController } from "./updates";

export interface UpdateCaptureHooks {
  /** The version running (the fake finds 0.1.1 over it). */
  readonly version: string;
  /** Puts this controller in the window's place; null: the app's own again. */
  use(controller: UpdateController | null): void;
}

/** What the update captures show: the pill, the toast, Settings › Updates' lines. */
const updateMeasure = `(() => {
  const text = (node) => (node === null || node === undefined ? null : node.innerText.trim());
  const pill = document.querySelector(".upd-pill");
  const page = document.querySelector(".settings-page");
  return {
    pill: pill === null ? null : {
      state: pill.getAttribute("data-update-pill"),
      label: text(pill.querySelector(".upd-l")),
      title: pill.getAttribute("title"),
      disabled: pill.disabled === true,
      ring: pill.querySelector(".upd-ring-v")?.getAttribute("stroke-dashoffset") ?? null,
    },
    toast: [...document.querySelectorAll(".app-toast")].map((node) => text(node)),
    settings: page === null ? null : {
      section: page.getAttribute("data-section"),
      status: text(page.querySelector("[data-update-status]")),
      last: text(page.querySelector("[data-update-last]")),
      foot: text(page.querySelector("[data-update-foot]")),
      buttons: [...page.querySelectorAll("[data-update-actions] button")].map((node) => ({ label: text(node), disabled: node.disabled === true })),
      automatic: page.querySelector("[data-update-automatic]")?.getAttribute("aria-checked") ?? null,
    },
    footer: text(document.querySelector(".sb-foot")),
  };
})()`;

export function updateCaptureSteps(ids: { macMini: string }, hooks: UpdateCaptureHooks): CaptureStep[] {
  let demo: { controller: UpdateController; updater: DemoUpdater } | null = null;
  const pane: CommandBody[] = [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId: "w6:p1" },
    { type: "set-tab", tab: "chat" },
  ];
  const footer = { selector: ".sb-foot", pad: 12 } as const;
  return [
    {
      name: "134-settings-updates-off",
      what: "Settings › Updates in a capture run (the demo, a development build): \"Updates come with the signed download.\" and why, Check for Updates… greyed, no switch, no pill (electron-updater never loaded)",
      before: async () => hooks.use(null),
      commands: [...pane, { type: "settings", open: true, section: "updates" }],
      settleMs: 1_500,
      measure: updateMeasure,
    },
    {
      name: "135-update-pill-available",
      what: "A fake updater (no network) in the app's place finds Adari 0.1.1: the sidebar footer's pill reads Download, at the footer's right end in the agent count's place; nothing downloads until it is clicked",
      before: async () => {
        demo = demoUpdateController(hooks.version);
        hooks.use(demo.controller);
        await demo.controller.check("automatic");
      },
      commands: pane,
      settleMs: 1_500,
      measure: updateMeasure,
    },
    {
      name: "136-update-pill-downloading",
      what: "The pill clicked: the download starts and the pill becomes a progress ring at 42% (the fake holds there)",
      commands: [{ type: "click", selector: ".upd-pill" }],
      settleMs: 1_200,
      crop: footer,
      measure: updateMeasure,
    },
    {
      name: "137-update-downloaded-toast",
      what: "The download done: one toast, \"Update downloaded. Restart Adari from the update button to install it.\", and the pill reads Restart",
      before: async () => {
        demo?.updater.finish();
        await new Promise((done) => setTimeout(done, 100));
      },
      commands: [{ type: "set-mode", mode: "projects" }],
      settleMs: 1_000,
      measure: updateMeasure,
    },
    {
      name: "138-update-pill-restart",
      what: "The pill's Restart, close up (its tooltip names the version; a click asks first)",
      commands: [{ type: "set-mode", mode: "projects" }],
      settleMs: 600,
      crop: footer,
      measure: updateMeasure,
    },
    {
      name: "139-settings-updates-downloaded",
      what: "Settings › Updates with the update downloaded: the version, \"Adari 0.1.1 is downloaded. Restart Adari to install it.\", Restart… and Check for Updates…, the last check, and Check for updates automatically (on)",
      commands: [{ type: "settings", open: true, section: "updates" }],
      settleMs: 1_200,
      measure: updateMeasure,
    },
    {
      name: "140-update-pill-restarting",
      what: "Restart clicked; the real app asks \"Install update 0.1.1 and restart Adari?\" in a dialog, which the capture answers Restart: the pill reads Restarting… (the fake never quits); the app's own updater is put back after",
      commands: [{ type: "settings", open: false }, { type: "click", selector: ".upd-pill" }],
      settleMs: 1_000,
      crop: footer,
      measure: updateMeasure,
      afterCapture: async () => {
        demo?.controller.stop();
        demo = null;
        hooks.use(null);
      },
    },
  ];
}
