// Captures 260-261 (development builds only, through dev-modes.ts), on the demo's Mac mini, never a real
// connection: the first message in a new Pi chat. The Atelier pane (integrations-captures.ts's) stands in for a
// new Pi pane: Herdr names its session by the file's path, and Pi has not written the file yet (it writes it
// with the first message, pi-locator.ts), so Chat finds no transcript (260). A message sent from Chat, Pi working
// on it, then Pi's file written holding the message and its answer: one message, no bubble beside it and no
// grey "Not sent" copy (261). Each step puts the pane back after its picture.

import type { CaptureStep } from "./capture";
import type { CommandBody } from "./app-commands";
import type { DemoBackend } from "./demo/demo-backend";
import { integrationsPaneId } from "./integrations-captures";
import { piFolderName } from "../shared/chat/agents/pi-locator";

/** The words sent and Pi's answer (invented). */
export const firstSendAsk = "hi, read the notes file first";
export const firstSendAnswer = "Read it. The notes say to run the tests before any change.";

/** The demo Pi session's id (a UUID v7 shape, invented). */
const sessionID = "019a8f00-0000-7000-8000-00000000f260";

/** Pi's file for the session in `cwd` under the demo home (session-manager.ts's naming, pi-locator.ts). */
export function firstSendPath(home: string, cwd: string): string {
  return `${home}/.pi/agent/sessions/${piFolderName(cwd)}/2026-11-14T20-00-00-000Z_${sessionID}.jsonl`;
}

/**
 * Pi's file once its first exchange is written (version 3 entries, as Pi writes them): the header, the model and
 * the thinking level from the pane's start, your message at `askMs`, its answer at `answerMs`.
 */
export function firstSendFile(cwd: string, startMs: number, askMs: number, answerMs: number): string {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const usage = { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const lines = [
    { type: "session", version: 3, id: sessionID, timestamp: iso(startMs), cwd },
    { type: "model_change", id: "f2600001", parentId: null, timestamp: iso(startMs), provider: "lmstudio", modelId: "local-model" },
    { type: "thinking_level_change", id: "f2600002", parentId: "f2600001", timestamp: iso(startMs), thinkingLevel: "off" },
    { type: "message", id: "f2600003", parentId: "f2600002", timestamp: iso(askMs), message: { role: "user", content: firstSendAsk, timestamp: askMs } },
    {
      type: "message",
      id: "f2600004",
      parentId: "f2600003",
      timestamp: iso(answerMs),
      message: {
        role: "assistant",
        content: [{ type: "text", text: firstSendAnswer }],
        api: "openai-completions",
        provider: "lmstudio",
        model: "local-model",
        usage,
        stopReason: "stop",
        timestamp: answerMs,
      },
    },
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

const measure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const ask = ${JSON.stringify(firstSendAsk)};
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    empty: text(document.querySelector(".chat-empty")) || null,
    notes: [...document.querySelectorAll(".chat .chat-note, .chat .chat-early-line")].map((node) => text(node)),
    bubbles: [...document.querySelectorAll(".chat .msg-u")].map((node) => ({ pending: node.getAttribute("data-pending"), text: text(node.querySelector(".bubble")), label: text(node.querySelector(".pst")) })),
    askShown: [...document.querySelectorAll(".chat .msg-u .bubble")].filter((node) => text(node) === ask).length,
    notSent: document.querySelectorAll(".chat .not-sent").length,
    answerShown: document.body.innerText.includes(${JSON.stringify(firstSendAnswer)}),
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

/** After the send: Pi working this long after the step began, then its file written and Pi idle. */
const workingAfterMs = 2_000;
const writtenAfterMs = 6_000;

export function firstSendCaptureSteps(
  ids: { macMini: string },
  backendOf: (hostId: string) => DemoBackend | null,
  refresh: (hostId: string) => Promise<void>,
): CaptureStep[] {
  const restore: (() => void)[] = [];
  const back = async (): Promise<void> => {
    for (const undo of restore.splice(0).reverse()) undo();
    await refresh(ids.macMini);
  };
  /** The Atelier pane a new idle Pi agent whose file is not written yet; with `answer`, Pi works on the send and writes it. */
  const pi = (answer: boolean) => async (): Promise<void> => {
    for (const undo of restore.splice(0).reverse()) undo();
    const backend = backendOf(ids.macMini);
    if (backend === null) return;
    const cwd = (await backend.snapshot()).panes.find((pane) => pane.paneID === integrationsPaneId)?.cwd ?? "/Users/demo/atelier";
    const path = firstSendPath(await backend.homeFolder(), cwd);
    const startMs = Date.now();
    backend.transcripts().forget(path);
    restore.push(backend.setPaneSession(integrationsPaneId, { agent: "pi", session: { source: "herdr:pi", agent: "pi", kind: "path", value: path } }));
    const status = backend.setPaneStatus(integrationsPaneId, "idle");
    restore.push(() => {
      backend.transcripts().forget(path);
      if (status !== null) backend.setPaneStatus(integrationsPaneId, status);
    });
    if (answer) {
      const timers = [
        setTimeout(() => {
          backend.setPaneStatus(integrationsPaneId, "working");
          void refresh(ids.macMini);
        }, workingAfterMs),
        setTimeout(() => {
          const now = Date.now();
          backend.transcripts().setFile(path, firstSendFile(cwd, startMs, now - 1_500, now));
          backend.setPaneStatus(integrationsPaneId, "idle");
          void refresh(ids.macMini);
        }, writtenAfterMs),
      ];
      restore.push(() => timers.forEach((timer) => clearTimeout(timer)));
    }
    await refresh(ids.macMini);
  };
  const chat: CommandBody[] = [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId: integrationsPaneId },
    { type: "set-tab", tab: "chat" },
  ];
  return [
    {
      name: "260-firstsend-pi-before-first-message",
      what: "A new Pi pane (the Atelier pane as an idle Pi agent whose session Herdr names by its file's path, Pi's file not written yet): Chat before the first message",
      commands: chat,
      settleMs: 2_500,
      measure,
      before: pi(false),
      afterCapture: back,
    },
    {
      name: "261-firstsend-pi-one-message",
      what: "The same new Pi pane: a message sent from Chat, Pi working, then Pi's file written holding the message and its answer: one message, no bubble beside it, no Not sent copy",
      commands: chat,
      page: [typeDraft(firstSendAsk), `(() => { document.querySelector(".cmp-bar .send.on")?.click(); return true; })()`],
      settleMs: 40_000,
      measure,
      before: pi(true),
      afterCapture: back,
    },
  ];
}
