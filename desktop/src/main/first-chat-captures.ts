// Captures 169-172 (development builds
// only, through dev-modes.ts), on the demo's Mac mini, never a real
// connection: the first Chat after Install, as on a clean home folder.
// The Atelier Codex pane with no session named and Herdr's Codex
// integration not installed; Install clicked: the steps for that old pane
// (169). New agent's Codex in a new tab after it (the demo's Herdr names no
// session for it yet): its Chat says it shows Codex's replies after the first
// message (170). New agent's Codex starting on Codex's "Hooks need review"
// while Herdr says idle: the sidebar, the header and Chat say Codex needs you
// (171). A message sent from Chat with no session, then the session named
// (the demo writes the message into the pane's transcript as Codex would): one
// message, no "Sent to the terminal" bubble beside it (172). Each step puts the
// demo back after its picture (170 and 171 also close the pane they made).

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";
import type { DemoStartQuirks } from "./demo/demo-backend";
import { integrationsPaneId } from "./integrations-captures";

/** What a step sets before its picture (null: all put back). */
export interface FirstChatChange {
  readonly noSession: boolean;
  readonly states: Readonly<Record<string, string>>;
  /** The demo Herdr's start quirks for New agent (`noSession`: its Codex has no session yet; `startScreen`: what it shows). */
  readonly quirks?: Omit<DemoStartQuirks, "home">;
  /** The Atelier pane's session named again this long after the step began (Codex's hook reporting it after the first turn). */
  readonly adoptAfterMs?: number;
}

/** Codex 0.167.0's screen, word for word (start-screen.ts). */
export const demoHookReviewScreen = [
  "  Hooks need review",
  "  1 hook is new or changed.",
  "  Hooks can run outside the sandbox after you trust them.",
  "",
  "",
  "› 1. Review hooks",
  "  2. Trust all and continue",
  "  3. Continue without trusting (hooks won't run)",
  "",
  "  enter confirm · esc skip",
].join("\n");

/** The Atelier pane's workspace on the demo's Mac mini. */
const atelierWorkspace = "w5";

const measure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const row = [...document.querySelectorAll("[data-row]")].find((node) => node.classList.contains("sel"));
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    header: { text: text(document.querySelector(".stt")), needsYou: document.querySelector(".stt")?.classList.contains("ny") ?? null },
    selectedRow: row === undefined ? null : { key: row.getAttribute("data-row"), title: row.getAttribute("title"), className: row.className, glyph: row.querySelector(".st > *")?.getAttribute("class") ?? null },
    integration: text(document.querySelector(".chat-int-line")) || null,
    start: text(document.querySelector(".chat-start")) || null,
    card: text(document.querySelector('[data-needs-card]')) || null,
    empty: text(document.querySelector(".chat-empty")) || null,
    buttons: [...document.querySelectorAll(".chat-empty button")].map((node) => text(node)),
    bubbles: [...document.querySelectorAll(".chat .msg-u")].map((node) => ({ state: node.getAttribute("data-pending"), text: text(node.querySelector(".bubble")), label: text(node.querySelector(".pst")) })),
    sentTexts: [...document.querySelectorAll(".chat .msg-u .bubble")].map((node) => text(node)),
    emDash: document.body.innerText.includes("\\u2014"),
  };
})()`;

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

export function firstChatCaptureSteps(ids: { macMini: string }, change: (hostId: string, paneId: string, what: FirstChatChange | null) => Promise<void>): CaptureStep[] {
  const chat: CommandBody[] = [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId: integrationsPaneId },
    { type: "set-tab", tab: "chat" },
  ];
  const put = (what: FirstChatChange) => () => change(ids.macMini, integrationsPaneId, what);
  const back = () => change(ids.macMini, integrationsPaneId, null);
  return [
    {
      name: "169-int-old-pane-steps",
      what: "The Atelier Codex pane (started before the install) with Herdr's Codex integration not installed; Install clicked: Installed. To use it, quit Codex in its terminal when it is done, then start it again with New agent., with Herdr's lines (this pane keeps the steps)",
      commands: chat,
      page: [`(async () => { document.querySelector('[data-integration-install="codex"]')?.click(); await new Promise((done) => setTimeout(done, 1500)); return true; })()`],
      settleMs: 2_000,
      measure,
      before: put({ noSession: true, states: { codex: "not_installed" }, quirks: { noSession: ["codex"] } }),
    },
    {
      name: "170-int-new-pane-first-message",
      what: "After that install, New agent's Codex in a new tab of Atelier (made on the same connection; Herdr names no session for it yet): its Chat says Chat shows Codex's replies after your first message., with Show the terminal, no steps",
      commands: [{ type: "start-new-agent", hostId: ids.macMini, workspaceId: atelierWorkspace, kind: "codex", folder: null }],
      after: { afterMs: 1_200, commands: [{ type: "set-tab", tab: "chat" }] },
      settleMs: 2_500,
      measure,
      afterCapture: back,
    },
    {
      name: "171-int-hook-review-needs-you",
      what: "New agent's Codex in a new tab of Atelier starts on Codex's Hooks need review while Herdr says idle: the sidebar row and the header say Needs you, and Chat says Codex is asking whether to trust Herdr's hook. Choose Trust all and continue in its terminal., with Show the terminal (nothing answers it, no key is sent)",
      commands: [{ type: "start-new-agent", hostId: ids.macMini, workspaceId: atelierWorkspace, kind: "codex", folder: null }],
      after: { afterMs: 1_200, commands: [{ type: "set-tab", tab: "chat" }] },
      settleMs: 4_500,
      measure,
      before: put({ noSession: false, states: {}, quirks: { noSession: ["codex"], startScreen: { codex: demoHookReviewScreen } } }),
      afterCapture: back,
    },
    {
      name: "172-int-first-message-one-bubble",
      what: "A message sent from Chat to the Atelier Codex pane with no session named (Sent to the terminal), then Codex's session named, its first transcript holding the message: one message, no Sent to the terminal bubble beside it",
      commands: chat,
      page: [typeDraft("Reply with exactly: hello from chat"), `(() => { document.querySelector(".cmp-bar .send.on")?.click(); return true; })()`],
      settleMs: 8_000,
      measure,
      before: put({ noSession: true, states: {}, adoptAfterMs: 4_500 }),
      afterCapture: back,
    },
  ];
}
