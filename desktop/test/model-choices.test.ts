// Model choices (src/shared/model-choices.ts,
// src/shared/model-prefs.ts, New agent in src/main/herdr/new-agent.ts and
// src/main/ipc.ts, herdr-core's agent.start in core-actions.ts): effort
// belongs to the model and falls back to its default; New agent's flags per
// agent with and without a choice, for a typed start command and for Herdr's
// agent.start, Codex keeping --no-daemon, nothing outside the list or the
// pattern passed, every typed value quoted; the live `/model` line per agent
// and what confirms it; the stars and the last choice remembered.

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { demoModelLists } from "../src/main/demo/demo-model-lists";
import { newAgent, type NewAgentClock, type NewAgentHerdr } from "../src/main/herdr/new-agent";
import type { AgentInfo, TabCreation } from "../src/main/herdr/wire";
import { parseCatalog, type CatalogAgent, type CatalogModel } from "../src/shared/model-catalog";
import {
  coreStartWords,
  currentModelId,
  cursorBaseLabel,
  cursorCurrentId,
  cursorEffortChoices,
  defaultNote,
  effortChoices,
  fallbackEffort,
  flagWords,
  isPlainWord,
  isModelPick,
  liveModelCommand,
  liveModelConfirmed,
  liveModelPick,
  modelPickCommand,
  startChipLabel,
  startFlags,
  typedFlags,
  withRunningModel,
  type StartFlag,
} from "../src/shared/model-choices";
import { favouriteModels, lastStartChoice, rememberStartChoice, toggleFavourite } from "../src/shared/model-prefs";
import { absentStartCommands, parseStartCommands } from "../src/shared/start-commands";

const { isNewAgentRequest, newAgentFlags } = await import("../src/main/ipc");

function listOf(agent: Exclude<CatalogAgent, "agy">): readonly CatalogModel[] {
  const parsed = parseCatalog(agent, demoModelLists[agent]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.models;
}

const claude = listOf("claude");
const codex = listOf("codex");
const cursor = listOf("cursor");
const grok = listOf("grok");
const opencode = listOf("opencode");

describe("effort belongs to the model", () => {
  it("Codex: each model's own levels and default; before it names one, the levels every model takes", () => {
    expect(effortChoices("codex", codex, "gpt-6.1-sol")).toEqual({ levels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultLevel: "low" });
    expect(effortChoices("codex", codex, "gpt-6-luna")).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "medium" });
    expect(effortChoices("codex", codex, null)).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: null });
    // A model the list does not name, or no list yet: the old four.
    expect(effortChoices("codex", codex, "gpt-old")).toEqual({ levels: ["low", "medium", "high", "xhigh"], defaultLevel: null });
    expect(effortChoices("codex", [], null).levels).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("Claude Code: the model's levels from its own list (an alias by what it names now); Haiku 4.5 none", () => {
    expect(effortChoices("claude", claude, "claude-opus-4-6").levels).toEqual(["low", "medium", "high", "max"]);
    expect(effortChoices("claude", claude, "claude-opus-5-5").levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortChoices("claude", claude, "claude-haiku-4-5-20251001").levels).toEqual([]);
    expect(effortChoices("claude", claude, null).levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortChoices("claude", [], "opus").levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("Grok's four; OpenCode and Antigravity CLI none", () => {
    expect(effortChoices("grok", grok, "grok-4.7").levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortChoices("opencode", opencode, null).levels).toEqual([]);
    expect(effortChoices("agy", [], null).levels).toEqual([]);
  });

  it("a level the new model does not take falls back to its default, never the nearest", () => {
    expect(fallbackEffort(effortChoices("codex", codex, "gpt-6-luna"), "ultra")).toBe("medium");
    expect(fallbackEffort(effortChoices("codex", codex, "gpt-6-luna"), "max")).toBe("max");
    expect(fallbackEffort(effortChoices("codex", codex, "gpt-6.1-sol"), null)).toBe("low");
    // No default the agent says: the agent's own (no flag).
    expect(fallbackEffort(effortChoices("claude", claude, "claude-opus-4-6"), "xhigh")).toBeNull();
  });

  it("Cursor: the footer's model joined with its list: the levels it has a variant of, its plain variant's level the default", () => {
    expect(cursorBaseLabel("Grok 4.7 Extra High Fast")).toBe("Grok 4.7");
    expect(cursorBaseLabel("Claude Fable 5 1M Extra High Thinking (NO ZDR)")).toBe("Claude Fable 5");
    expect(cursorEffortChoices(cursor, "Grok 4.7")).toEqual({ levels: ["low", "medium", "high", "xhigh"], defaultLevel: null });
    // "Grok 4.6" is cursor-grok-4.6-high: High is its default.
    expect(cursorEffortChoices(cursor, "Grok 4.6")).toEqual({ levels: ["low", "medium", "high", "xhigh"], defaultLevel: "high" });
    // A model the list has no variant of: Cursor's four.
    expect(cursorEffortChoices(cursor, "Muse 9").levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(cursorCurrentId(cursor, { model: "Grok 4.7", effort: "medium", fast: true })).toBe("grok-4.7-medium-fast");
    expect(cursorCurrentId(cursor, { model: "Grok 4.7", effort: "xhigh", fast: false })).toBe("grok-4.7-xhigh");
  });
});

describe("the current model and the list joined", () => {
  it("ticks Claude Code's alias for the transcript's full name, or the same id, or the same label", () => {
    expect(currentModelId("claude", claude, { id: "claude-opus-5-5", label: "Opus 5.5" })).toBe("opus");
    expect(currentModelId("claude", claude, { id: "claude-opus-4-7", label: "Opus 4.7" })).toBe("claude-opus-4-7");
    expect(currentModelId("claude", claude, { id: null, label: "Sonnet 5.5" })).toBe("sonnet");
    expect(currentModelId("codex", codex, { id: "gpt-6-sol", label: "gpt-6-sol" })).toBe("gpt-6-sol");
  });

  it("a model the list does not name is added first, \"In use now\", with the levels of the model it is a form of", () => {
    const joined = withRunningModel("claude", claude, { id: "claude-opus-5-5[1m]", label: "Opus 5.5" });
    expect(joined[0]).toMatchObject({ id: "claude-opus-5-5[1m]", label: "Opus 5.5", note: "In use now", efforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(withRunningModel("claude", claude, { id: "claude-opus-5-5", label: "Opus 5.5" })).toBe(claude);
    expect(withRunningModel("codex", codex, { id: "gpt-x", label: "gpt-x" })[0]).toMatchObject({ id: "gpt-x", efforts: [] });
  });

  it("New agent's choice on the Model chip as the agent will name it", () => {
    expect(startChipLabel("codex", codex, "gpt-6-luna")).toBe("gpt-6-luna");
    expect(startChipLabel("cursor", cursor, "grok-4.7-high-fast")).toBe("Grok 4.7");
    expect(startChipLabel("claude", claude, "sonnet")).toBe("Sonnet 5.5");
    expect(startChipLabel("opencode", opencode, "openrouter/~anthropic/claude-fable-latest")).not.toBe("");
  });

  it("the words beside Agent's default: the model it is now", () => {
    expect(defaultNote("claude", claude)).toBe("Fable 5.2");
    expect(defaultNote("grok", grok)).toBe("Grok 4.6");
    expect(defaultNote("cursor", cursor)).toBe("Auto");
    expect(defaultNote("codex", codex)).toBeNull();
  });
});

const words = (agent: CatalogAgent, models: readonly CatalogModel[], model: string | null, effort: string | null): string[] => {
  const result = startFlags(agent, { model, effort }, models);
  if (!result.ok) throw new Error(result.reason);
  return flagWords(result.flags);
};

const refusal = (agent: CatalogAgent, models: readonly CatalogModel[], model: string | null, effort: string | null): string => {
  const result = startFlags(agent, { model, effort }, models);
  if (result.ok) throw new Error("passed");
  return result.reason;
};

describe("New agent's start flags", () => {
  it("each agent's own flags; none for the agent's default", () => {
    expect(words("claude", claude, "opus", "high")).toEqual(["--model", "opus", "--effort", "high"]);
    expect(words("claude", claude, null, null)).toEqual([]);
    expect(words("claude", claude, "default", null)).toEqual([]);
    expect(words("codex", codex, "gpt-6.1-sol", "ultra")).toEqual(["-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=ultra"]);
    expect(words("codex", codex, null, "high")).toEqual(["-c", "model_reasoning_effort=high"]);
    expect(words("grok", grok, "grok-4.7", "xhigh")).toEqual(["-m", "grok-4.7", "--reasoning-effort", "xhigh"]);
    expect(words("cursor", cursor, "grok-4.7-medium-fast", null)).toEqual(["--model", "grok-4.7-medium-fast"]);
    expect(words("opencode", opencode, "openrouter/~anthropic/claude-fable-latest", null)).toEqual(["-m", "openrouter/~anthropic/claude-fable-latest"]);
  });

  it("nothing outside the machine's list or the agent's pattern is passed", () => {
    expect(refusal("codex", codex, "gpt-reserve", null)).toBe("That model is not in the agent's list on this machine.");
    expect(refusal("codex", codex, "gpt-6.1-sol; touch x", null)).toBe("That model is not one this agent names.");
    expect(refusal("codex", [], "gpt-6.1-sol", null)).toBe("That model is not in the agent's list on this machine.");
    expect(refusal("codex", codex, "gpt-6-luna", "ultra")).toBe("That model does not take that effort.");
    expect(refusal("claude", claude, "claude-haiku-4-5-20251001", "low")).toBe("That model does not take that effort.");
    expect(refusal("cursor", cursor, "auto", "high")).toBe("That effort is not one this agent takes at start.");
    expect(refusal("opencode", opencode, null, "high")).toBe("That effort is not one this agent takes at start.");
    expect(refusal("agy", [], "x", null)).toBe("That model is not one this agent names.");
    expect(refusal("grok", grok, null, "HIGH")).toBe("That effort is not one this agent takes at start.");
  });

  it("typed after a start command each value is single-quoted; a plain word for Herdr's start", () => {
    const flags: StartFlag[] = [
      { flag: "--model", value: "opus[1m]" },
      { flag: "--effort", value: "it's" },
    ];
    expect(typedFlags(flags)).toBe(`--model 'opus[1m]' --effort 'it'"'"'s'`);
    expect(isPlainWord("gpt-6.1-sol")).toBe(true);
    expect(isPlainWord("model_reasoning_effort=high")).toBe(true);
    expect(isPlainWord("openrouter/~anthropic/claude-fable-latest")).toBe(true);
    expect(isPlainWord("~/x")).toBe(false);
    expect(isPlainWord("a=~b")).toBe(false);
    expect(isPlainWord("opus[1m]")).toBe(false);
    expect(isPlainWord("a b")).toBe(false);
  });

  it("herdr-core's agent.start: --no-daemon, then the kind's own flags with values of their pattern, quoted; anything else refused", () => {
    expect(coreStartWords("codex", ["--no-daemon"], ["--no-daemon", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high"])).toEqual(["--no-daemon", "-m 'gpt-6.1-sol'", "-c 'model_reasoning_effort=high'"]);
    expect(coreStartWords("claude", [], ["--model", "opus", "--effort", "max"])).toEqual(["--model 'opus'", "--effort 'max'"]);
    expect(coreStartWords("claude", [], [])).toEqual([]);
    expect(coreStartWords("codex", ["--no-daemon"], ["--no-daemon"])).toEqual(["--no-daemon"]);
    expect(coreStartWords("claude", [], ["--dangerously-skip-permissions"])).toBeNull();
    expect(coreStartWords("claude", [], ["--model"])).toBeNull();
    expect(coreStartWords("claude", [], ["--model", "opus;x"])).toBeNull();
    expect(coreStartWords("codex", ["--no-daemon"], ["-c", "sandbox_mode=danger-full-access"])).toBeNull();
    expect(coreStartWords("gemini", [], ["-m", "x"])).toBeNull();
  });
});

// MARK: - New agent's start with the flags

class FakeHerdr implements NewAgentHerdr {
  readonly calls: string[] = [];
  private typed = false;
  constructor(private readonly kind: string) {}

  agentList(): Promise<AgentInfo[]> {
    this.calls.push("agent.list");
    return Promise.resolve(this.typed ? [{ paneID: "w1:pn1", name: this.kind, agent: this.kind }] : []);
  }
  createTerminalTab(workspaceID: string): Promise<TabCreation> {
    this.calls.push("tab.create");
    return Promise.resolve({ tab: { tabID: "w1:tn1", workspaceID, label: "" }, rootPane: { paneID: "w1:pn1", workspaceID, tabID: "w1:tn1" } } as unknown as TabCreation);
  }
  startAgent(name: string, kind: string, paneID: string, args?: readonly string[]): Promise<AgentInfo> {
    this.calls.push(`agent.start ${kind} ${JSON.stringify(args ?? null)}`);
    return Promise.resolve({ paneID, name, agent: kind });
  }
  closePane(): Promise<void> {
    return Promise.resolve();
  }
  sendInput(_pane: string, text: string): Promise<void> {
    this.calls.push(`typed ${text}`);
    this.typed = true;
    return Promise.resolve();
  }
}

const clock: NewAgentClock = { now: () => 0, sleep: () => Promise.resolve() };
const encode = (text: string) => new TextEncoder().encode(text);

describe("New agent starts the agent with the choice", () => {
  it("Herdr's own start: agent.start args, Codex keeping --no-daemon first", async () => {
    const herdr = new FakeHerdr("codex");
    const flags = startFlags("codex", { model: "gpt-6-luna", effort: "max" }, codex);
    await newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: null, kind: "codex" }, clock, 90_000, 1_000, undefined, flags.ok ? flags.flags : []);
    expect(herdr.calls.at(-1)).toBe('agent.start codex ["--no-daemon","-m","gpt-6-luna","-c","model_reasoning_effort=max"]');
    const plain = new FakeHerdr("claude");
    await newAgent(plain, absentStartCommands, { workspaceId: "w1", folder: null, kind: "claude" }, clock);
    expect(plain.calls.at(-1)).toBe("agent.start claude null");
  });

  it("a typed start command: the flags after it, each value quoted; Codex's --no-daemon kept", async () => {
    const herdr = new FakeHerdr("claude");
    const flags = startFlags("claude", { model: "sonnet", effort: "high" }, claude);
    const result = await newAgent(herdr, parseStartCommands(encode('{"claude": "cl", "codex": "cx"}')), { workspaceId: "w1", folder: null, kind: "claude" }, clock, 90_000, 1_000, undefined, flags.ok ? flags.flags : []);
    expect(herdr.calls).toContain("typed cl --model 'sonnet' --effort 'high'");
    expect(result.start).toEqual({ type: "typed", command: "cl --model 'sonnet' --effort 'high'" });
    const codexHerdr = new FakeHerdr("codex");
    const codexFlags = startFlags("codex", { model: "gpt-6-sol", effort: null }, codex);
    await newAgent(codexHerdr, parseStartCommands(encode('{"codex": "codex"}')), { workspaceId: "w1", folder: null, kind: "codex" }, clock, 90_000, 1_000, undefined, codexFlags.ok ? codexFlags.flags : []);
    expect(codexHerdr.calls).toContain("typed codex --no-daemon -m 'gpt-6-sol'");
  });

  it("a value Herdr's start cannot carry as a plain word is refused before anything is made", async () => {
    const herdr = new FakeHerdr("claude");
    await expect(newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: null, kind: "claude" }, clock, 90_000, 1_000, undefined, [{ flag: "--model", value: "opus[1m]" }])).rejects.toThrow(
      "That model's name cannot go to Herdr's start of Claude Code as it is.",
    );
    expect(herdr.calls).toEqual([]);
  });

  it("main checks the choice against the machine's list (read first when none is held) before anything is made", async () => {
    const asked: string[] = [];
    const catalogs = {
      settled: async (hostId: string, agent: CatalogAgent) => {
        asked.push(`${hostId} ${agent}`);
        return { agent, models: agent === "codex" ? codex : [], readAt: 1, error: null, loading: false, none: null };
      },
    };
    const request = { workspaceId: "w1", folder: null, kind: "codex" };
    expect(await newAgentFlags(catalogs, "mini", request)).toEqual([]);
    expect(asked).toEqual([]);
    expect(flagWords(await newAgentFlags(catalogs, "mini", { ...request, model: "gpt-6-sol", effort: "high" }))).toEqual(["-m", "gpt-6-sol", "-c", "model_reasoning_effort=high"]);
    expect(asked).toEqual(["mini codex"]);
    await expect(newAgentFlags(catalogs, "mini", { ...request, model: "gpt-reserve" })).rejects.toThrow("That model is not in the agent's list on this machine. Nothing was made.");
    await expect(newAgentFlags(catalogs, "mini", { ...request, kind: "gemini", model: "x" })).rejects.toThrow("This agent takes no model or effort from New agent.");
    await expect(newAgentFlags(undefined, "mini", { ...request, model: "gpt-6-sol" })).rejects.toThrow("This agent takes no model or effort from New agent.");
  });

  it("New agent starts Cursor with --model <id> for a listed id", async () => {
    const catalogs = { settled: async (_hostId: string, agent: CatalogAgent) => ({ agent, models: agent === "cursor" ? cursor : [], readAt: 1, error: null, loading: false, none: null }) };
    const request = { workspaceId: "w1", folder: null, kind: "cursor" };
    expect(flagWords(await newAgentFlags(catalogs, "mini", { ...request, model: "grok-4.7-medium-fast" }))).toEqual(["--model", "grok-4.7-medium-fast"]);
    await expect(newAgentFlags(catalogs, "mini", { ...request, model: "grok-4.7-ultra" })).rejects.toThrow("That model is not in the agent's list on this machine. Nothing was made.");
  });

  it("the request main accepts: a model and an effort of plain characters only", () => {
    const base = { workspaceId: "w1", folder: null, kind: "codex" };
    expect(isNewAgentRequest({ ...base, model: "gpt-6-sol", effort: "high" })).toBe(true);
    expect(isNewAgentRequest({ ...base, model: null, effort: null })).toBe(true);
    expect(isNewAgentRequest({ ...base, model: "opus[1m]" })).toBe(true);
    expect(isNewAgentRequest({ ...base, model: "a b" })).toBe(false);
    expect(isNewAgentRequest({ ...base, model: "$(x)" })).toBe(false);
    expect(isNewAgentRequest({ ...base, effort: "High" })).toBe(false);
    expect(isNewAgentRequest({ ...base, effort: 3 })).toBe(false);
  });
});

describe("live picks", () => {
  it("each agent's own line: Claude /model <value>, Codex /model <slug> --reasoning=<level kept or its default>; Grok /model <id>, Cursor /model <family>", () => {
    expect(liveModelCommand("claude", claude, "sonnet", null)).toBe("/model sonnet");
    expect(liveModelCommand("claude", claude, "default", null)).toBe("/model default");
    expect(liveModelCommand("claude", claude, "claude-opus-4-7", null)).toBe("/model claude-opus-4-7");
    expect(liveModelCommand("claude", claude, "nope", null)).toBeNull();
    expect(liveModelCommand("codex", codex, "gpt-6-luna", "ultra")).toBe("/model gpt-6-luna --reasoning=medium");
    expect(liveModelCommand("codex", codex, "gpt-6-luna", "max")).toBe("/model gpt-6-luna --reasoning=max");
    expect(liveModelCommand("codex", codex, "gpt-6.1-sol", null)).toBe("/model gpt-6.1-sol --reasoning=low");
    expect(liveModelCommand("codex", codex, "gpt-reserve", null)).toBeNull();
    // Cursor takes its family's name (never an id), Grok its id.
    expect(liveModelCommand("cursor", cursor, "grok-4.7-high", null)).toBe("/model Grok 4.7");
    expect(liveModelPick("cursor", cursor, "grok-4.7-high", null)).toEqual({ agent: "cursor", model: "grok-4.7-high", effort: null });
    expect(liveModelCommand("grok", grok, "grok-4.7", null)).toBe("/model grok-4.7");
    expect(liveModelCommand("grok", grok, "grok-9", null)).toBeNull();
    // OpenCode's is its own sequence in main (IPC.openCodePick), never a typed /model.
    expect(liveModelCommand("opencode", opencode, "opencode/big-pickle", null)).toBeNull();
  });

  it("the one place a pick's line is made, from the machine's list; the pick main takes is only these keys", () => {
    expect(modelPickCommand({ agent: "codex", model: "gpt-6-luna", effort: "max" }, codex)).toEqual({ ok: true, command: "/model gpt-6-luna --reasoning=max" });
    expect(modelPickCommand({ agent: "codex", model: "gpt-6-luna", effort: null }, codex)).toEqual({ ok: true, command: "/model gpt-6-luna --reasoning=medium" });
    expect(modelPickCommand({ agent: "codex", model: "gpt-6-luna", effort: "ultra" }, codex)).toEqual({ ok: false, reason: "that model does not take that effort." });
    // Hidden from the list: not offered, not typed.
    expect(modelPickCommand({ agent: "codex", model: "gpt-reserve", effort: "high" }, codex)).toEqual({ ok: false, reason: "that model is not in the agent's list on this machine." });
    expect(modelPickCommand({ agent: "codex", model: "gpt-6-luna", effort: "high" }, [])).toEqual({ ok: false, reason: "that model is not in the agent's list on this machine." });
    expect(modelPickCommand({ agent: "claude", model: "sonnet", effort: null }, claude)).toEqual({ ok: true, command: "/model sonnet" });
    expect(modelPickCommand({ agent: "claude", model: "sonnet", effort: "high" }, claude).ok).toBe(false);
    // Cursor's pick names an id; main types its family (cursor-families.test.ts has the rest).
    expect(modelPickCommand({ agent: "cursor", model: "grok-4.7-high", effort: null }, cursor)).toEqual({ ok: true, command: "/model Grok 4.7" });
    expect(isModelPick({ agent: "cursor", model: "grok-4.7-high", effort: null })).toBe(true);
    expect(modelPickCommand({ agent: "opencode", model: "opencode/big-pickle", effort: null } as never, opencode)).toEqual({ ok: false, reason: "this agent's model is chosen in its own list." });
    expect(isModelPick({ agent: "opencode", model: "opencode/big-pickle", effort: null })).toBe(false);
    // A Codex entry that names no levels takes the agent's; with no default of its own, a level must be named.
    const bare: CatalogModel = { ...codex.find((model) => model.id === "gpt-6-luna")!, id: "gpt-bare", efforts: [], defaultEffort: null };
    expect(effortChoices("codex", [bare], "gpt-bare")).toEqual({ levels: ["low", "medium", "high", "xhigh"], defaultLevel: null });
    expect(modelPickCommand({ agent: "codex", model: "gpt-bare", effort: "high" }, [bare])).toEqual({ ok: true, command: "/model gpt-bare --reasoning=high" });
    expect(modelPickCommand({ agent: "codex", model: "gpt-bare", effort: null }, [bare])).toEqual({ ok: false, reason: "that model needs an effort level." });
    expect(isModelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" })).toBe(true);
    expect(isModelPick({ agent: "codex", model: "gpt-6-luna", effort: "high", command: "/model x" })).toBe(false);
    expect(isModelPick({ agent: "grok", model: "grok-4.7", effort: null })).toBe(true);
    expect(isModelPick({ agent: "grok", model: "grok 4.7", effort: null })).toBe(false);
    expect(isModelPick({ agent: "codex", model: "gpt-6-luna\n/quit", effort: null })).toBe(false);
  });

  it("what confirms it: the transcript's id or label; Grok's files; Cursor's footer's family", () => {
    expect(liveModelConfirmed("claude", claude, "sonnet", { id: "claude-sonnet-5-5", label: "Sonnet 5.5" })).toBe(true);
    expect(liveModelConfirmed("claude", claude, "sonnet", { id: "claude-opus-5-5", label: "Sonnet 5.5" })).toBe(true);
    expect(liveModelConfirmed("claude", claude, "sonnet", { id: "claude-opus-5-5", label: "Opus 5.5" })).toBe(false);
    expect(liveModelConfirmed("claude", claude, "default", { id: null, label: "Fable 5.2" })).toBe(true);
    expect(liveModelConfirmed("codex", codex, "gpt-6-luna", { id: "gpt-6-luna", label: null })).toBe(true);
    expect(liveModelConfirmed("cursor", cursor, "grok-4.7-high-fast", { id: null, label: "Grok 4.7" })).toBe(true);
    expect(liveModelConfirmed("cursor", cursor, "grok-4.7-high-fast", { id: null, label: "Grok 4.6" })).toBe(false);
    expect(liveModelConfirmed("grok", grok, "grok-4.6", { id: "grok-4.6", label: "Grok 4.6" })).toBe(true);
    expect(liveModelConfirmed("grok", grok, "grok-4.6", { id: "grok-4.7", label: "Grok 4.7" })).toBe(false);
  });
});

describe("what the pickers remember", () => {
  const storage = () => {
    const map = new Map<string, string>();
    return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), map };
  };

  it("stars per machine and agent, each id of the agent's pattern", () => {
    const s = storage();
    expect([...toggleFavourite(s, "mini", "codex", "gpt-6-sol")]).toEqual(["gpt-6-sol"]);
    expect([...toggleFavourite(s, "mini", "codex", "gpt-6-luna")]).toEqual(["gpt-6-sol", "gpt-6-luna"]);
    expect([...favouriteModels(s, "box", "codex")]).toEqual([]);
    expect([...favouriteModels(s, "mini", "grok")]).toEqual([]);
    expect([...toggleFavourite(s, "mini", "codex", "gpt-6-sol")]).toEqual(["gpt-6-luna"]);
    expect([...toggleFavourite(s, "mini", "codex", "bad id")]).toEqual(["gpt-6-luna"]);
    s.setItem("adari.models.favourites", JSON.stringify({ "mini|codex": ["ok-1", "not ok", 3] }));
    expect([...favouriteModels(s, "mini", "codex")]).toEqual(["ok-1"]);
    s.setItem("adari.models.favourites", "{broken");
    expect([...favouriteModels(s, "mini", "codex")]).toEqual([]);
    expect([...favouriteModels(null, "mini", "codex")]).toEqual([]);
  });

  it("New agent's last Model and Effort per machine and agent; the agent's defaults at first", () => {
    const s = storage();
    expect(lastStartChoice(s, "mini", "codex")).toEqual({ model: null, effort: null });
    rememberStartChoice(s, "mini", "codex", { model: "gpt-6-sol", effort: "high" });
    expect(lastStartChoice(s, "mini", "codex")).toEqual({ model: "gpt-6-sol", effort: "high" });
    expect(lastStartChoice(s, "box", "codex")).toEqual({ model: null, effort: null });
    rememberStartChoice(s, "mini", "codex", { model: null, effort: null });
    expect(lastStartChoice(s, "mini", "codex")).toEqual({ model: null, effort: null });
    s.setItem("adari.newAgent.models", JSON.stringify({ "mini|claude": { model: "opus; x", effort: "HIGH" } }));
    expect(lastStartChoice(s, "mini", "claude")).toEqual({ model: null, effort: null });
  });
});
