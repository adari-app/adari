// Captures 158-162 (development builds
// only, through dev-modes.ts), on the demo's Mac mini, never a real
// connection: the demo's Herdr answers integration.list and
// integration.install (demo-backend.ts). The Atelier Codex pane's Chat with no
// session named and Herdr's Codex integration not installed (158); after the
// Install click, the restart line (159); out of date, with Update (160);
// Settings › Machines with the Mac mini's integration line (161); a send to the
// no-session Codex pane, its bubble "Sent to the terminal" (162). Each step
// puts the pane and the integrations back after its picture.

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";

/** The demo's Atelier Codex pane (codex-session-captures.ts). */
export const integrationsPaneId = "w5:pH";

/** What a step sets before its picture: the pane's session gone, and integration states on the demo's Herdr (null: all put back). */
export interface IntegrationsChange {
  readonly noSession: boolean;
  readonly states: Readonly<Record<string, string>>;
}

const chatMeasure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    empty: text(document.querySelector(".chat-empty")) || null,
    integration: text(document.querySelector(".chat-int-line")) || null,
    note: [...document.querySelectorAll(".chat-int-note")].map((node) => text(node)),
    messages: [...document.querySelectorAll(".chat-int .int-msgs > div")].map((node) => text(node)),
    buttons: [...document.querySelectorAll(".chat-empty button")].map((node) => ({ text: text(node), disabled: node.disabled, title: node.getAttribute("title") })),
    bubbles: [...document.querySelectorAll(".chat .msg-u")].map((node) => ({ state: node.getAttribute("data-pending"), text: text(node.querySelector(".bubble")), label: text(node.querySelector(".pst")), tappable: node.getAttribute("role") === "button" })),
    emDash: document.body.innerText.includes("\\u2014"),
  };
})()`;

function settingsMeasure(macMini: string): string {
  return `(() => {
    const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const machine = document.querySelector('[data-machine="${macMini}"]');
    return {
      window: { width: window.innerWidth, height: window.innerHeight },
      line: text(machine?.querySelector(".set-int-line")) || null,
      items: [...(machine?.querySelectorAll("[data-integration]") ?? [])].map((node) => ({ target: node.getAttribute("data-integration"), state: node.getAttribute("data-integration-state"), text: text(node), button: text(node.querySelector("button")) || null })),
      others: [...document.querySelectorAll("[data-machine]")].map((node) => ({ machine: node.getAttribute("data-machine"), line: text(node.querySelector(".set-int-line")) || null })),
      emDash: document.querySelector(".settings-page")?.innerText.includes("\\u2014") ?? null,
    };
  })()`;
}

/** A draft typed into the Chat box as the user's keys would (capture.ts's typeDraft). */
function typeDraft(text: string): string {
  return `(() => {
    const t = document.querySelector(".cmp textarea");
    t.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, ${JSON.stringify(text)});
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
}

export function integrationsCaptureSteps(ids: { macMini: string }, change: (hostId: string, paneId: string, what: IntegrationsChange | null) => Promise<void>): CaptureStep[] {
  const chat: CommandBody[] = [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId: integrationsPaneId },
    { type: "set-tab", tab: "chat" },
  ];
  const put = (what: IntegrationsChange) => () => change(ids.macMini, integrationsPaneId, what);
  const back = () => change(ids.macMini, integrationsPaneId, null);
  return [
    {
      name: "158-int-codex-not-installed",
      what: "The Atelier Codex pane's Chat on the Mac mini with no session named, Herdr's Codex integration not installed there: the line names the cause and the machine, with Install and Show the terminal",
      commands: chat,
      settleMs: 2_500,
      measure: chatMeasure,
      before: put({ noSession: true, states: { codex: "not_installed" } }),
    },
    {
      name: "159-int-codex-installed",
      what: "Install clicked (one integration.install { target: codex } to the demo's Herdr, answered in Herdr 0.9.5's real shape, its lines under details.messages): Installed. To use it, quit Codex in its terminal when it is done, then start it again with New agent., Herdr's two lines as text, and Show the terminal (no greyed Restart: Herdr names no session id to resume)",
      commands: [],
      page: [`(() => { document.querySelector('[data-integration-install="codex"]')?.click(); return true; })()`],
      settleMs: 2_500,
      measure: chatMeasure,
      afterCapture: back,
    },
    {
      name: "160-int-codex-outdated",
      what: "The same pane with Herdr's Codex integration out of date: the line says Herdr can update it, with Update",
      commands: chat,
      settleMs: 2_500,
      measure: chatMeasure,
      before: put({ noSession: true, states: { codex: "outdated" } }),
      afterCapture: back,
    },
    {
      name: "161-int-settings-machines",
      what: "Settings › Machines: under the Mac mini, one line of Herdr's agent integrations (Claude Code installed, Codex out of date · Update, Cursor Agent not installed · Install, Grok Build installed); the other demo machine's line all installed",
      commands: [{ type: "settings", open: true, section: "machines" }],
      settleMs: 2_000,
      measure: settingsMeasure(ids.macMini),
      before: put({ noSession: false, states: { codex: "outdated", cursor: "not_installed" } }),
      afterCapture: back,
    },
    {
      name: "162-int-no-session-send",
      what: "A message sent from Chat to the Atelier Codex pane with no session named (integration current, so today's no-session line): Herdr took it, and its bubble, classified as the send went, reads Sent to the terminal. Chat cannot show the reply without a session. with no tap to put it back (never Not sent)",
      commands: chat,
      after: { afterMs: 1_500, commands: [] },
      page: [typeDraft("Run the release checklist once more, please."), `(() => { document.querySelector(".cmp-bar .send.on")?.click(); return true; })()`],
      settleMs: 7_000,
      measure: chatMeasure,
      before: put({ noSession: true, states: {} }),
      afterCapture: back,
    },
  ];
}
