// Captures 240-241 (development builds only, through dev-modes.ts), on the demo's machines, never a real
// connection, notification, menu bar item or Dock badge (a capture run's notifier only records:
// needs-notifier.ts RecordedNotifyPort). 240: Settings › Notifications, its three switches on, Send a test
// notification and the line that macOS decides. 241: the window put away (hidden, as closing it does on the Mac),
// a Mac mini Claude Code pane starts needing you while it is away, and the main process's notifier gets the new list
// (main.ts writes what it saw to 241-window-away-proof.json: the window not visible, the report count before and
// after, the row in it, the notification recorded); then the window comes back (shown without focus) and its
// sidebar's Needs you lists that pane. The pane's status is put back after 241.

import type { CaptureStep } from "./capture";

/** The Mac mini's Claude Code pane at rest (twotier-captures.ts's), made to need you in 241. */
export const notifyAwayPane = "w9:p1";

const settingsMeasure = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const section = document.querySelector('[data-set-sec="notifications"]');
  return {
    section: document.querySelector(".settings-page")?.getAttribute("data-section") ?? null,
    title: text(section?.querySelector("h2")),
    lead: text(section?.querySelector(".set-lead")),
    switches: [...document.querySelectorAll("[data-notify-switch]")].map((node) => ({ key: node.getAttribute("data-notify-switch"), label: node.getAttribute("aria-label"), on: node.getAttribute("aria-checked") })),
    rows: [...(section?.querySelectorAll(".set-row") ?? [])].map((row) => text(row.querySelector(".set-k")) + " | " + text(row.querySelector(".set-rd"))),
    test: text(section?.querySelector("[data-notify-test] button")),
    foot: text(section?.querySelector(".set-foot")),
    emDash: document.body.innerText.includes("\\u2014"),
  };
})()`;

const needsMeasure = `(() => ({
  visible: document.visibilityState,
  needsYou: [...document.querySelectorAll(".sb .row.ny")].map((row) => ({ name: row.querySelector(".nm")?.textContent ?? "", key: row.getAttribute("data-row") })),
}))()`;

export interface NotifyCaptureHooks {
  /** 241's before: the window hidden, the pane made to need you, the notifier's report waited for and written down, the window back. */
  away(): Promise<void>;
  /** After 241: the pane's status put back. */
  restore(): Promise<void>;
}

export function notifyCaptureSteps(ids: { macMini: string; buildBox: string }, hooks: NotifyCaptureHooks): CaptureStep[] {
  return [
    {
      name: "240-notify-settings",
      what: "Settings › Notifications: Notify when an agent needs you, Play a sound, Show Adari in the menu bar (all on), Send a test notification, and the line that macOS decides in System Settings › Notifications › Adari",
      commands: [{ type: "settings", open: true, section: "notifications" }],
      settleMs: 1_200,
      measure: settingsMeasure,
    },
    {
      name: "241-notify-window-away",
      what: "The window was put away (hidden) while the Mac mini's Claude Code pane started needing you; the main process got the new Needs you list then (241-window-away-proof.json); back on screen, the sidebar's Needs you lists it",
      before: () => hooks.away(),
      commands: [
        { type: "settings", open: false },
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "clear-selection" },
      ],
      settleMs: 1_500,
      measure: needsMeasure,
      afterCapture: () => hooks.restore(),
    },
  ];
}
