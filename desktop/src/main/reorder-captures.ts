// Captures 250-253 (development builds only, through dev-modes.ts), on the demo's
// build-box (clients, herdr, research, calls), never a real connection. 250: the
// Projects tab before, in Herdr's order. 251: the real mouse pressed on clients'
// header and dragged, held, past herdr and research: clients dims and the line
// shows above calls. 252: let go: herdr, research, clients, calls, saved for
// build-box on this Mac (adari.sidebar.fold's workspaceOrder); nothing is sent to
// the demo's Herdr. 253: herdr's header menu (now first): Move up greyed with
// "Already at the top", Move down ready.

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";

/** The section ids, labels and drag classes of a machine's workspaces, top to bottom, and its saved order. */
function orderMeasure(hostId: string): string {
  return `(() => {
    const host = document.querySelector('[data-host="${hostId}"]');
    const sections = [...(host?.querySelectorAll("[data-ws-section]") ?? [])].map((section) => ({
      id: section.getAttribute("data-ws-section"),
      label: section.querySelector(".ws-h .n")?.textContent ?? null,
      classes: section.className,
    }));
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem("adari.sidebar.fold") ?? "null")?.workspaceOrder?.["${hostId}"] ?? null;
    } catch {}
    return { sections, saved: saved === null ? null : saved.map((entry) => entry.id), cursor: document.body.style.cursor || null };
  })()`;
}

/** The middle of a workspace header (its name's button). */
function headerPoint(hostId: string, workspaceId: string): string {
  return `(() => {
    const r = document.querySelector('[data-host="${hostId}"] [data-ws-section="${workspaceId}"] .ws-h')?.getBoundingClientRect();
    return r === undefined ? null : { x: Math.round(r.left + r.width * 0.4), y: Math.round(r.top + r.height / 2) };
  })()`;
}

/** Just inside the top of a workspace's section (above its middle: the drop lands before it). */
function sectionTop(hostId: string, workspaceId: string): string {
  return `(() => {
    const r = document.querySelector('[data-host="${hostId}"] [data-ws-section="${workspaceId}"]')?.getBoundingClientRect();
    return r === undefined ? null : { x: Math.round(r.left + r.width * 0.4), y: Math.round(r.top + 4) };
  })()`;
}

const menuMeasure = `[...document.querySelectorAll(".ctx .ctx-i")].map((item) => ({ label: item.querySelector(".l")?.firstChild?.textContent ?? null, greyed: item.classList.contains("off"), why: item.querySelector(".why")?.textContent ?? null }))`;

export function reorderCaptureSteps(ids: { macMini: string; buildBox: string }): CaptureStep[] {
  const box = ids.buildBox;
  const setUp: CommandBody[] = [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: true },
    { type: "set-host-folded", hostId: box, folded: false },
  ];
  return [
    {
      name: "250-reorder-before",
      what: "The Projects tab, the Mac mini folded and build-box open: its workspaces in Herdr's order (clients, herdr, research, calls)",
      commands: setUp,
      // build-box's header at the list's top, so the drag's points are away from the list's edges (no scrolling).
      page: [`document.querySelector('[data-host="${box}"]')?.scrollIntoView({ block: "start" })`],
      settleMs: 1_000,
      measure: orderMeasure(box),
    },
    {
      name: "251-reorder-mid-drag",
      what: "clients' header pressed and dragged (the real mouse, held) past herdr and research: clients dims and the line shows where it lands, above calls; nothing has moved yet",
      commands: [],
      hold: { from: headerPoint(box, "w1"), to: sectionTop(box, "w4") },
      settleMs: 500,
      measure: orderMeasure(box),
    },
    {
      name: "252-reorder-after-drop",
      what: "Let go: build-box lists herdr, research, clients, calls; the order is saved for build-box on this Mac (nothing sent to Herdr) and clients is not folded by the release",
      release: true,
      commands: [],
      settleMs: 800,
      measure: orderMeasure(box),
    },
    {
      name: "253-reorder-header-menu",
      what: "herdr's header menu (herdr is first now): New agent here, Rename workspace…, Move up greyed with Already at the top, Move down",
      commands: [{ type: "open-workspace-menu", hostId: box, workspaceId: "w2" }],
      settleMs: 800,
      measure: menuMeasure,
    },
  ];
}
