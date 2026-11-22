// The Mac's New agent dialog while it starts: a step before the pane is named in
// its note once it ran about a second (never before, gone when it ends); the pane once made closes the dialog and
// opens it (onShown), the answer comes after (onStarted with shown); a failure after the pane says the same words
// through onFailed; a dialog closed before the pane opens nothing. Rendered with the fake hooks, fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import type { NewAgentPlace, NewAgentProgress } from "../src/shared/new-agent";
import { absentStartCommands } from "../src/shared/start-commands";
import { HookHost, elements } from "./support/fake-hooks";

const { NewAgentDialog } = await import("../src/renderer/components/NewAgentDialog");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { startCommandsStore } = await import("../src/renderer/components/resume");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");

type Element = { type: unknown; props: Record<string, unknown> };
const text = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && node !== null && "props" in node) return text((node as Element).props["children"]);
  return "";
};

const place: NewAgentPlace = { hostId: "mini", hostName: "Mac mini", workspaceId: "w1", workspace: "app", folder: "/Users/demo/app", suggestions: [] };
const result = { paneId: "w1:pn1", tabId: "w1:tn1", name: "claude", kind: "claude", start: { type: "herdr" as const }, summary: "Updated Herdr's Claude Code integration on Mac mini." };

function dialog() {
  vi.stubGlobal("window", { herdrDesktop: { startCommands: () => Promise.resolve(absentStartCommands) } });
  const listeners: ((progress: NewAgentProgress) => void)[] = [];
  const said: string[] = [];
  let answer!: { resolve: (value: unknown) => void; reject: (error: Error) => void };
  let startId = "";
  const host = new HookHost(NewAgentDialog as (props: object) => unknown, {
    places: [place],
    wanted: { hostId: "mini", workspaceId: "w1" },
    storage: null,
    folders: null,
    start: (_place: unknown, _folder: unknown, _kind: unknown, _where: unknown, _models: unknown, id: string) => {
      startId = id;
      return new Promise((resolve, reject) => (answer = { resolve, reject }));
    },
    progress: (listener: (progress: NewAgentProgress) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    onShown: (_place: unknown, pane: { paneId: string }) => said.push(`shown ${pane.paneId}`),
    onStarted: (_place: unknown, started: { summary: string | null }, shown: boolean) => said.push(`started ${shown} ${started.summary}`),
    onFailed: (_place: unknown, message: string, paneId: string) => said.push(`failed ${message}${paneId === "w1:pn1" ? "" : ` (${paneId})`}`),
    onClosed: (_place: unknown, paneId: string) => said.push(`pane closed ${paneId}`),
    onClose: () => said.push("closed"),
  });
  host.render();
  const root = () => elements(host.tree).find((e) => e.props["role"] === "dialog")!;
  return {
    host,
    said,
    listeners,
    go: () => (root().props["onKeyDown"] as (event: unknown) => void)({ key: "Enter", shiftKey: false, target: { tagName: "DIV" }, nativeEvent: { isComposing: false }, preventDefault: () => undefined }),
    escape: () => (root().props["onKeyDown"] as (event: unknown) => void)({ key: "Escape", shiftKey: false, target: { tagName: "DIV" }, nativeEvent: { isComposing: false }, preventDefault: () => undefined }),
    tell: (progress: Record<string, unknown>) => {
      // A copy: a listener may stop itself while it runs.
      for (const listener of listeners.slice()) listener({ startId, ...progress } as NewAgentProgress);
      host.render();
    },
    answer: () => answer,
    note: () => text(elements(host.tree).find((e) => e.props["role"] === "status")),
    startId: () => startId,
  };
}

const madePane = (paneId: string) => ({ paneID: paneId, terminalID: `term-${paneId}`, workspaceID: "w1", tabID: "w1:y", focused: false, agentStatus: "unknown", revision: 1 });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  escapeOwners.reset();
  startCommandsStore.clear();
  handoffStore.reset();
  vi.unstubAllGlobals();
});

describe("New agent's dialog while it starts", () => {
  it("a step's line shows once it ran about a second, and goes when it ends; the pane closes the dialog and the answer comes after", async () => {
    const d = dialog();
    d.go();
    d.host.render();
    expect(d.note()).toBe("Starting Claude Code…");
    expect(d.startId()).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    d.tell({ type: "step", words: "Updating Herdr's Claude Code integration on Mac mini…" });
    await vi.advanceTimersByTimeAsync(900);
    d.host.render();
    expect(d.note()).toBe("Starting Claude Code…");
    await vi.advanceTimersByTimeAsync(200);
    d.host.render();
    expect(d.note()).toBe("Updating Herdr's Claude Code integration on Mac mini…");
    d.tell({ type: "step", words: null });
    expect(d.note()).toBe("Starting Claude Code…");
    // Another start's progress is not this one's.
    for (const listener of d.listeners) listener({ startId: "someone-else-1", type: "pane", paneId: "w1:x", tabId: "w1:y", tab: null, pane: madePane("w1:x") });
    expect(d.said).toEqual([]);
    d.tell({ type: "pane", paneId: "w1:pn1", tabId: "w1:tn1" });
    expect(d.said).toEqual(["shown w1:pn1"]);
    d.answer().resolve(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(d.said).toEqual(["shown w1:pn1", "started true Updated Herdr's Claude Code integration on Mac mini."]);
    expect(d.listeners).toEqual([]);
  });

  it("a step shorter than a second is never named", async () => {
    const d = dialog();
    d.go();
    d.tell({ type: "step", words: "Checking the model list on Mac mini…" });
    await vi.advanceTimersByTimeAsync(400);
    d.tell({ type: "step", words: null });
    await vi.advanceTimersByTimeAsync(2_000);
    d.host.render();
    expect(d.note()).toBe("Starting Claude Code…");
  });

  it("a failure after the pane was shown goes to onFailed in the words the dialog says (Herdr's refusal, the pane closed)", async () => {
    const d = dialog();
    d.go();
    d.tell({ type: "pane", paneId: "w1:pn1", tabId: "w1:tn1" });
    d.answer().reject(new Error("Error invoking remote method 'herdr:new-agent': Error: Herdr did not start Claude Code: the pane is gone"));
    await vi.advanceTimersByTimeAsync(0);
    expect(d.said).toEqual(["shown w1:pn1", "failed Herdr did not start Claude Code: the pane is gone"]);
  });

  it("a failure before any pane stays in the dialog as before", async () => {
    const d = dialog();
    d.go();
    d.answer().reject(new Error("Error invoking remote method 'herdr:new-agent': Error: That model is not in Claude Code's list on Mac mini. Nothing was made."));
    await vi.advanceTimersByTimeAsync(0);
    d.host.render();
    expect(d.note()).toBe("Not started: That model is not in Claude Code's list on Mac mini. Nothing was made.");
    expect(d.said).toEqual([]);
  });

  it("closed before the pane: the pane opens nothing and the answer is not shown", async () => {
    const d = dialog();
    d.go();
    d.escape();
    d.tell({ type: "pane", paneId: "w1:pn1", tabId: "w1:tn1" });
    d.answer().resolve(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(d.said).toEqual(["closed"]);
  });

  it("with no progress from main the answer opens the pane as before", async () => {
    const d = dialog();
    d.go();
    d.answer().resolve({ ...result, summary: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.said).toEqual(["started false null"]);
  });

  // The line names the step that runs now.
  it("a line shown goes as soon as another step runs, and the next step is named only once it, too, ran a second", async () => {
    const d = dialog();
    d.go();
    d.tell({ type: "step", words: "Checking the model list on Mac mini…" });
    await vi.advanceTimersByTimeAsync(1_100);
    d.host.render();
    expect(d.note()).toBe("Checking the model list on Mac mini…");
    // The list answered; the start commands are still being read.
    d.tell({ type: "step", words: "Reading the start commands on Mac mini…" });
    expect(d.note()).toBe("Starting Claude Code…");
    await vi.advanceTimersByTimeAsync(600);
    d.host.render();
    expect(d.note()).toBe("Starting Claude Code…");
    await vi.advanceTimersByTimeAsync(500);
    d.host.render();
    expect(d.note()).toBe("Reading the start commands on Mac mini…");
    d.tell({ type: "step", words: "Making the new tab on Mac mini…" });
    await vi.advanceTimersByTimeAsync(1_100);
    d.host.render();
    expect(d.note()).toBe("Making the new tab on Mac mini…");
    d.tell({ type: "step", words: null });
    expect(d.note()).toBe("Starting Claude Code…");
  });

  // A failed start that closed the pane it showed says so before its answer; the window lets the pane go.
  it("a failure that closed the shown pane: onClosed first, then onFailed; a closed word for another pane or start is not this one's", async () => {
    const d = dialog();
    d.go();
    d.tell({ type: "closed", paneId: "w1:pn1" });
    expect(d.said).toEqual([]);
    d.tell({ type: "pane", paneId: "w1:pn1", tabId: "w1:tn1" });
    d.tell({ type: "closed", paneId: "w1:other" });
    for (const listener of d.listeners.slice()) listener({ startId: "someone-else-1", type: "closed", paneId: "w1:pn1" });
    d.tell({ type: "closed", paneId: "w1:pn1" });
    d.answer().reject(new Error("Error invoking remote method 'herdr:new-agent': Error: Herdr did not start Claude Code: the pane is gone"));
    await vi.advanceTimersByTimeAsync(0);
    expect(d.said).toEqual(["shown w1:pn1", "pane closed w1:pn1", "failed Herdr did not start Claude Code: the pane is gone"]);
  });
});
