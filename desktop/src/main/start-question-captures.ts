// Captures 177-180 (development builds only, through dev-modes.ts), on the
// demo's Mac mini, never a real connection: New agent's Grok Build (177), Cursor Agent (178) and Gemini CLI (179,
// 180) in a new tab of Atelier, each starting on its own question before its prompt while the demo's Herdr says idle and
// names no session (as a real Herdr reports these panes: idle, not blocked). The sidebar row, the header and
// Chat say the agent needs you, with one plain line. 177 also types a message
// and presses Send: nothing is written, the text stays in the box with the note. Nothing answers a question; no key
// is sent. Each step closes the pane it made and puts the demo's start quirks back; 178-180 first discard 177's
// draft, which Chat keeps when its pane closes.
//
// The screens are the recorded frames in test/support/start-question-frames.ts, the
// question part only, with a demo folder in the paths.

import type { CaptureStep } from "./capture";

/** What a step's New agent starts, and the screen it shows (null: the panes it made closed, the quirks put back). */
export type StartQuestionDemo = (hostId: string, what: { readonly kind: string; readonly screen: string } | null) => Promise<void>;

/** The Atelier workspace on the demo's Mac mini (first-chat-captures.ts's). */
const atelierWorkspace = "w5";

/** A box like the agents draw at 119 columns: `indent` spaces, the border, each row padded inside. */
function box(rows: readonly string[], indent: number, inner: number): string[] {
  const pad = " ".repeat(indent);
  return [`${pad}╭${"─".repeat(inner)}╮`, ...rows.map((row) => `${pad}│${row.padEnd(inner)}│`), `${pad}╰${"─".repeat(inner)}╯`];
}

/** Grok Build 1.0.77's folder trust (trust-frame-grok-raw.txt, from its title down; the logo above left out). */
export const demoGrokTrustScreen = [
  "",
  "  ~/Projects/atelier",
  "",
  "",
  "                                     Do you trust the contents of this directory?",
  "                                              /Users/demo/Projects/atelier",
  "",
  "                               Grok Build may run or modify contents in this directory,",
  "                                                posing security risks.",
  "",
  "                                             Yes, proceed                 y",
  "                                             No, quit                     n",
  ...Array<string>(14).fill(""),
  "                                                                                          Grok Build  1.0.77 [stable]",
].join("\n");

/** Cursor Agent 2026.11.05's workspace trust (trust-frame-cursor-raw.txt). */
export const demoCursorTrustScreen = [
  "demo@Demo-Mac-mini atelier % cursor-agent",
  "",
  ...box(
    [
      "",
      "  ⚠ Workspace Trust Required",
      "",
      "  Cursor Agent can execute code and access files in this directory.",
      "",
      "  Do you trust the contents of this directory?",
      "",
      "    /Users/demo/Projects/atelier",
      "",
      "",
      "  ▶ [a] Trust this workspace",
      "    [q] Quit",
      "",
      "  Use arrow keys to navigate, Enter to select, or press the key shown",
      "",
    ],
    2,
    113,
  ),
].join("\n");

/** Gemini CLI 0.65.0's folder trust (trust-frame-gemini-raw.txt, the box). */
export const demoGeminiTrustScreen = [
  " Gemini CLI v0.65.0",
  "",
  "",
  ...box(
    [
      "",
      " Do you trust the files in this folder?",
      "",
      " Trusting a folder allows Gemini CLI to load its local configurations, including custom commands, hooks, MCP",
      " servers, agent skills, and settings. These configurations could execute code on your behalf or change the",
      " behavior of the CLI.",
      "",
      "",
      " ● 1. Trust folder (atelier)",
      "   2. Trust parent folder (Projects)",
      "   3. Don't trust",
      "",
    ],
    1,
    115,
  ),
].join("\n");

/** Gemini CLI 0.65.0's sign-in picker, signed out (signin-frame-gemini-raw.txt, the box). */
export const demoGeminiSignInScreen = [
  " Gemini CLI v0.65.0",
  "",
  "",
  ...box(
    [
      "",
      " ? Get started",
      "",
      "   How would you like to authenticate for this project?",
      "",
      "   ● 1. Sign in with Google",
      "     2. Use Gemini API Key",
      "     3. Vertex AI",
      "",
      "   No authentication method selected.",
      "",
      "   (Use Enter to select)",
      "",
      "   Terms of Services and Privacy Notice for Gemini CLI",
      "",
      "   https://geminicli.com/docs/resources/tos-privacy/",
      "",
    ],
    0,
    117,
  ),
].join("\n");

/** The message 177 sends (a letter y in it would answer Grok's question if it reached the terminal). */
export const startQuestionCaptureText = "Reply with exactly one word: pong";

/** What 177-180 show, measured: the header, the selected row, Chat's line, its buttons, the box and its note. */
const measure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const row = [...document.querySelectorAll("[data-row]")].find((node) => node.classList.contains("sel"));
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    header: { text: text(document.querySelector(".stt")), needsYou: document.querySelector(".stt")?.classList.contains("ny") ?? null },
    selectedRow: row === undefined ? null : { key: row.getAttribute("data-row"), title: row.getAttribute("title"), className: row.className, glyph: row.querySelector(".st > *")?.getAttribute("class") ?? null },
    start: text(document.querySelector(".chat-start")) || null,
    startScreen: document.querySelector(".chat-start")?.getAttribute("data-start-screen") ?? null,
    card: text(document.querySelector("[data-needs-card]")) || null,
    buttons: [...document.querySelectorAll(".chat-empty button, .chat button.btn")].map((node) => text(node)),
    box: document.querySelector(".cmp textarea")?.value ?? null,
    placeholder: document.querySelector(".cmp textarea")?.getAttribute("placeholder") ?? null,
    note: text(document.querySelector(".cmp-note-t")) || null,
    bubbles: [...document.querySelectorAll(".chat .msg-u")].map((node) => text(node)),
    emDash: document.body.innerText.includes("\\u2014"),
  };
})()`;

/** The message typed into the box as the user's keys would, then Return. */
const typeAndSend = `(async () => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const box = document.querySelector(".cmp textarea");
  if (box === null) return false;
  box.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(startQuestionCaptureText)});
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(150);
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return true;
})()`;

/** 177's draft, kept when its pane closed (KeptDrafts), discarded so 178-180 show only their own state. */
const discardKept = `(async () => {
  for (const row of [...document.querySelectorAll(".kept-row")]) {
    [...row.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "Discard")?.click();
  }
  await new Promise((done) => setTimeout(done, 200));
  return document.querySelectorAll(".kept-row").length === 0;
})()`;

export function startQuestionCaptureSteps(ids: { macMini: string }, demo: StartQuestionDemo): CaptureStep[] {
  const step = (name: string, kind: string, screen: string, what: string, page?: readonly string[]): CaptureStep => ({
    name,
    what,
    before: () => demo(ids.macMini, { kind, screen }),
    commands: [
      { type: "settings", open: false },
      { type: "set-mode", mode: "projects" },
      { type: "set-host-folded", hostId: ids.macMini, folded: false },
      { type: "start-new-agent", hostId: ids.macMini, workspaceId: atelierWorkspace, kind, folder: null },
    ],
    after: { afterMs: 1_200, commands: [{ type: "set-tab", tab: "chat" }] },
    page: page ?? [discardKept],
    settleMs: 4_500,
    measure,
    afterCapture: () => demo(ids.macMini, null),
  });
  return [
    step(
      "177-grok-trust-needs-you",
      "grok",
      demoGrokTrustScreen,
      "New agent's Grok Build in a new tab of Atelier starts on its folder trust question (Yes, proceed y / No, quit n) while Herdr says idle with no session: the sidebar row and the header say Needs you, Chat says Grok Build is asking whether to trust this folder. Answer it in its terminal.; Reply with exactly one word: pong typed and sent: nothing written, the text kept in the box with the note",
      [typeAndSend],
    ),
    step(
      "178-cursor-trust-needs-you",
      "cursor",
      demoCursorTrustScreen,
      "New agent's Cursor Agent starts on Workspace Trust Required ([a] Trust this workspace / [q] Quit) while Herdr says idle: Needs you, and Chat says Cursor Agent is asking whether to trust this workspace. Answer it in its terminal.",
    ),
    step(
      "179-gemini-trust-needs-you",
      "gemini",
      demoGeminiTrustScreen,
      "New agent's Gemini CLI starts on Do you trust the files in this folder? (three numbered choices) while Herdr says idle: Needs you, and Chat says Gemini CLI is asking whether to trust this folder. Answer it in its terminal.",
    ),
    step(
      "180-gemini-signin-needs-you",
      "gemini",
      demoGeminiSignInScreen,
      "Gemini CLI signed out, on its sign-in picker (Sign in with Google, Use Gemini API Key, Vertex AI) while Herdr says idle: Needs you, and Chat says Gemini CLI is asking you to sign in. Answer it in its terminal.",
    ),
  ];
}
