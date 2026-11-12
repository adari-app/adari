// The model chips and picks (src/renderer/components/agent-picks.ts, the picker's request in
// AgentChips.tsx modelPickRequest): the chips before the first reply (New agent's choice at once, else what a
// screen reader says, else "Default" with its title, never a bare "Model"; the transcript takes over), and a model
// picked in the picker going the existing way (typed at the prompt, held "next turn" while the pane works,
// confirmed by the transcript): Claude Code's `/model <value>`, Codex's `/model <slug> --reasoning=<level>`.
// Cursor's `/model` takes no id, so a Cursor pick types the model's family (`/model <family>`).

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneSettings } from "../src/shared/agent-settings";
import type { SendBinding } from "../src/shared/send-binding";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { AgentPicks, defaultModelChip } = await import("../src/renderer/components/agent-picks");
const { modelPickRequest } = await import("../src/renderer/components/AgentChips");
const { parseCatalog } = await import("../src/shared/model-catalog");
const { demoModelLists } = await import("../src/main/demo/demo-model-lists");
const { modelPickCommand } = await import("../src/shared/model-choices");

type Picks = InstanceType<typeof AgentPicks>;
type Context = Parameters<Picks["pick"]>[0];

interface Sent {
  readonly paneId: string;
  readonly text: string;
  resolve(): void;
}

let sends: Sent[];
let clock: number;
let picks: Picks;

beforeEach(() => {
  sends = [];
  clock = 1_000_000;
  picks = new AgentPicks({
    send: (_hostId, paneId, text) => new Promise<void>((resolve) => sends.push({ paneId, text, resolve })),
    // A model pick goes to main as itself; main checks it on the machine's list and makes the line
    // (model-pick-main.test.ts runs main's own handler), as here.
    modelPick: (_hostId, paneId, pick) => {
      const built = modelPickCommand(pick, listOf(pick.agent));
      if (!built.ok) return Promise.reject(new Error(`Not sent: ${built.reason}`));
      return new Promise<void>((resolve) => sends.push({ paneId, text: built.command, resolve }));
    },
    copy: () => undefined,
    now: () => clock,
  });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function listOf(agent: "claude" | "codex" | "cursor" | "grok") {
  const parsed = parseCatalog(agent, demoModelLists[agent]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.models;
}

const key = "mac-mini/w7:p1";
const bindingOf = (kind: string, terminalID = "term-1", arrival = 1): SendBinding => ({ terminalID, isAgent: true, kind, session: "sess-1", run: { connection: 2, arrival } });
const contextOf = (agent: Context["agent"], status: Context["status"], binding = bindingOf(agent)): Context => ({ hostId: "mac-mini", paneId: "w7:p1", agent, status, binding });
const settings = (model: string | null, modelLabel: string | null, effort: string | null = null): PaneSettings => ({ model, modelLabel, effort, scope: { terminalID: "term-1", session: "sess-1" } });

describe("the chips before the first reply", () => {
  it("New agent's choice at once, with why in its title; the transcript takes over", () => {
    const codex = bindingOf("codex");
    picks.noteStart("mac-mini", "w7:p1", { kind: "codex", model: "gpt-6-luna", modelLabel: "gpt-6-luna", effort: "max" });
    expect(picks.chip(key, "model", codex)).toEqual({ label: "gpt-6-luna", next: false, title: "Model: gpt-6-luna (chosen in New agent)" });
    expect(picks.chip(key, "effort", codex)).toEqual({ label: "Max", next: false });
    picks.receive(key, settings("gpt-6.1-sol", "gpt-6.1-sol", "low"), "t1");
    expect(picks.chip(key, "model", codex)).toEqual({ label: "gpt-6.1-sol", next: false });
    expect(picks.chip(key, "effort", codex)).toEqual({ label: "Low", next: false });
  });

  it("the agent's default when New agent chose none, or nothing chose: \"Default\", never a bare \"Model\"", () => {
    const claude = bindingOf("claude");
    expect(picks.chip(key, "model", claude)).toEqual({ label: "Default", next: false, title: "The agent's default model" });
    expect(defaultModelChip).toEqual({ label: "Default", title: "The agent's default model" });
    picks.noteStart("mac-mini", "w7:p1", { kind: "claude", model: null, modelLabel: null, effort: "high" });
    expect(picks.chip(key, "model", claude)).toEqual({ label: "Default", next: false, title: "The agent's default model" });
    expect(picks.chip(key, "effort", claude)).toEqual({ label: "High", next: false });
  });

  it("the choice is the pane's first agent only: another kind, terminal or run in it drops it for good", () => {
    picks.noteStart("mac-mini", "w7:p1", { kind: "claude", model: "opus", modelLabel: "Opus 5.5", effort: null });
    expect(picks.chip(key, "model", bindingOf("codex")).label).toBe("Default");
    expect(picks.chip(key, "model", bindingOf("claude")).label).toBe("Opus 5.5");
    // The same terminal, its run arriving again (another Claude Code in the pane).
    expect(picks.chip(key, "model", bindingOf("claude", "term-1", 2)).label).toBe("Default");
    expect(picks.chip(key, "model", bindingOf("claude")).label).toBe("Default");
    picks.noteStart("mac-mini", "w7:p1", { kind: "claude", model: "opus", modelLabel: "Opus 5.5", effort: null });
    expect(picks.chip(key, "model", bindingOf("claude")).label).toBe("Opus 5.5");
    expect(picks.chip(key, "model", bindingOf("claude", "term-2")).label).toBe("Default");
  });

  it("Cursor: New agent's choice until its footer, the screen reader, says the model", () => {
    const cursor = bindingOf("cursor");
    picks.noteStart("mac-mini", "w7:p1", { kind: "cursor", model: "grok-4.7-high", modelLabel: "Grok 4.7", effort: null });
    expect(picks.chip(key, "model", cursor).label).toBe("Grok 4.7");
    picks.receiveFooter(key, { scope: { terminalID: "term-1", session: null }, footer: { model: "Grok 4.6", window: "256K", effort: "high", fast: false, percent: null } });
    expect(picks.chip(key, "model", cursor)).toEqual({ label: "Grok 4.6", next: false });
    expect(picks.chip(key, "effort", cursor)).toEqual({ label: "High", next: false });
  });

  it("everything forgotten clears the choices too", () => {
    picks.noteStart("mac-mini", "w7:p1", { kind: "claude", model: "opus", modelLabel: "Opus 5.5", effort: null });
    picks.clear();
    expect(picks.chip(key, "model", bindingOf("claude")).label).toBe("Default");
  });
});

describe("a model from the picker goes the existing way", () => {
  it("Claude Code: /model <alias>, the chip shows it, the transcript's full name for the alias confirms it", async () => {
    const request = modelPickRequest("claude", listOf("claude"), "sonnet", null)!;
    expect(request).toMatchObject({ kind: "model", value: "sonnet", label: "Sonnet 5.5", command: "/model sonnet" });
    picks.receive(key, settings("claude-opus-5-5", "Opus 5.5"), "t1");
    picks.pick(contextOf("claude", "idle"), request);
    expect(sends.map((sent) => sent.text)).toEqual(["/model sonnet"]);
    expect(picks.chip(key, "model", bindingOf("claude")).label).toBe("Sonnet 5.5");
    sends[0]!.resolve();
    await flush();
    picks.receive(key, settings("claude-sonnet-5-5", "Sonnet 5.5"), "t1");
    expect(picks.confirmations(key, "t1")).toEqual(["Model: Sonnet 5.5"]);
  });

  it("Claude Code: Agent's default is /model default, labelled with the model it is now", () => {
    const request = modelPickRequest("claude", listOf("claude"), null, null)!;
    expect(request).toMatchObject({ value: "default", label: "Fable 5.2", command: "/model default", expect: { ids: ["claude-fable-5-2"], labels: ["Fable 5.2"] } });
    expect(modelPickRequest("claude", listOf("claude"), "claude-opus-4-6", null)).toMatchObject({ command: "/model claude-opus-4-6", label: "Opus 4.6" });
  });

  it("Codex: /model <slug> --reasoning=<level>, no more \"Choose in the Terminal\"; its level kept when the model takes it, else its default", async () => {
    const codex = listOf("codex");
    expect(modelPickRequest("codex", codex, "gpt-6-luna", "ultra")).toMatchObject({ command: "/model gpt-6-luna --reasoning=medium" });
    const request = modelPickRequest("codex", codex, "gpt-6-luna", "high")!;
    expect(request.command).toBe("/model gpt-6-luna --reasoning=high");
    // Agent's default cannot be typed (Codex's default is its config's).
    expect(modelPickRequest("codex", codex, null, "high")).toBeNull();
    expect(modelPickRequest("codex", codex, "gpt-reserve", "high")).toBeNull();
    picks.receive(key, settings("gpt-6.1-sol", "gpt-6.1-sol", "high"), "t1");
    picks.pick(contextOf("codex", "done"), request);
    expect(sends.map((sent) => sent.text)).toEqual(["/model gpt-6-luna --reasoning=high"]);
    sends[0]!.resolve();
    await flush();
    picks.receive(key, settings("gpt-6-luna", "gpt-6-luna", "high"), "t1");
    expect(picks.confirmations(key, "t1")).toEqual(["Model: gpt-6-luna"]);
    expect(picks.chip(key, "model", bindingOf("codex")).label).toBe("gpt-6-luna");
  });

  it("a Cursor row is a model pick of its family (main types /model <family>); no request for the default", () => {
    const request = modelPickRequest("cursor", listOf("cursor"), "grok-4.7-high-fast", null)!;
    expect(request).toMatchObject({ kind: "model", value: "grok-4.7-high-fast", label: "Grok 4.7", command: "/model Grok 4.7", modelPick: { agent: "cursor", model: "grok-4.7-high-fast", effort: null } });
    expect(modelPickRequest("cursor", listOf("cursor"), null, null)).toBeNull();
    const cursor = bindingOf("cursor");
    const footer = { model: "Grok 4.6", window: "256K", effort: "high" as const, fast: true, percent: null };
    picks.receiveFooter(key, { scope: { terminalID: "term-1", session: null }, footer });
    picks.pick(contextOf("cursor", "idle"), request);
    expect(sends.map((sent) => sent.text)).toEqual(["/model Grok 4.7"]);
    expect(picks.chip(key, "model", cursor)).toEqual({ label: "Grok 4.7", next: false });
    // A pick by hand with a command main would not make goes as the model pick main checks, never as its line.
    const forged = { kind: "model" as const, value: "grok-4.7-high-fast", label: "Grok 4.7", command: "/model grok-4.7-high-fast; x", modelPick: { agent: "cursor", model: "grok-4.7-high-fast", effort: null } as never };
    picks.pick(contextOf("cursor", "idle"), forged);
    expect(sends).toHaveLength(1);
  });

  it("while the pane works it is held for the next turn, the newest winning, and goes once it is back", () => {
    const codex = listOf("codex");
    picks.receive(key, settings("gpt-6.1-sol", "gpt-6.1-sol", "high"), "t1");
    picks.pick(contextOf("codex", "working"), modelPickRequest("codex", codex, "gpt-6-sol", "high")!);
    picks.pick(contextOf("codex", "working"), modelPickRequest("codex", codex, "gpt-6-luna", "high")!);
    expect(sends).toEqual([]);
    expect(picks.chip(key, "model", bindingOf("codex"))).toEqual({ label: "gpt-6-luna", next: true });
    picks.sync(key, contextOf("codex", "idle"));
    expect(sends.map((sent) => sent.text)).toEqual(["/model gpt-6-luna --reasoning=high"]);
  });

  it("OpenCode's model is never typed as a line: a request without its id goes nowhere (main drives its list)", () => {
    picks.pick(contextOf("opencode", "idle"), { kind: "model", value: "opencode/big-pickle", label: "Big Pickle" });
    expect(sends).toEqual([]);
    expect(picks.note(key)).toBe("Not set: that is not one of the menu's choices.");
  });
});
