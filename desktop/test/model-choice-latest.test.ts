// Codex has one latest model and effort
// choice per pane run, through held, on its way and sent. Accepting or confirming a later choice retires every earlier
// one for good. The 10 s wait bounds only the wait shown on the chip; the model a later Effort command names is the
// latest choice sent in this run while no turn_context newer than its send was read, else the transcript's. A newer
// turn_context is the truth again, whatever it says; another run drops the choice. The chips show what the next
// Effort command names. With the real AgentPicks (the page's), AgentChips' menu functions and the demo machine's lists.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelPick } from "../src/shared/model-choices";
import type { SendBinding } from "../src/shared/send-binding";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { agentPicks } = await import("../src/renderer/components/agent-picks");
const { chipMenu, effortMenuChoices, modelPickRequest } = await import("../src/renderer/components/AgentChips");
const { parseCatalog } = await import("../src/shared/model-catalog");
const { demoModelLists } = await import("../src/main/demo/demo-model-lists");
const { modelPickCommand } = await import("../src/shared/model-choices");

const codexList = (() => {
  const parsed = parseCatalog("codex", demoModelLists.codex);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.models;
})();
const view = { agent: "codex" as const, models: codexList, readAt: 1, error: null, loading: false, none: null };

/** Every line main typed into the pane (main's own handler runs in model-pick-main.test.ts). */
let writes: string[];
/** Models main refuses now (as when its list no longer names them). */
let refused: Set<string>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(100_000);
  writes = [];
  refused = new Set();
  agentPicks.clear();
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    herdrDesktop: {
      sendToPane: async (_hostId: string, _paneId: string, text: string) => void writes.push(text),
      modelPick: async (_hostId: string, _paneId: string, pick: ModelPick) => {
        if (refused.has(pick.model)) throw new Error("Not sent: that model is not in the agent's list on this machine.");
        const built = modelPickCommand(pick, codexList);
        if (!built.ok) throw new Error(`Not sent: ${built.reason}`);
        writes.push(built.command);
      },
      copyText: () => undefined,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const key = "mini/pane";
const bindingOf = (arrival = 1, session = "session"): SendBinding => ({ terminalID: "term", isAgent: true, kind: "codex", session, run: { connection: 1, arrival } });
const binding = bindingOf();
type Status = "idle" | "working";
const at = (status: Status, b: SendBinding = binding) => ({ hostId: "mini", paneId: "pane", agent: "codex" as const, status, binding: b });

/** A chat update with Codex's newest turn_context at byte `turnAt` (its offset is PaneSettings.modeAt). */
const turnContext = (model: string, effort: string, turnAt: number, turn: string, session = "session"): void =>
  agentPicks.receive(key, { model, modelLabel: model, effort, mode: null, modeAt: turnAt, scope: { terminalID: "term", session } }, turn);

/** The Model chip's pick of `id`, as the picker makes it (the level kept is the effective one). */
const pickModel = (status: Status, id: string): void => {
  const request = modelPickRequest("codex", codexList, id, agentPicks.effective(key, binding).effort);
  if (request === null) throw new Error(`no pick for ${id}`);
  agentPicks.pick(at(status), request);
};

/** The Effort chip's menu item of `level` picked. */
const pickEffort = (status: Status, level: string): void => {
  const item = chipMenu("effort", at(status), key, view).find((one) => one.pick?.value === level);
  if (item === undefined || item.pick === null || item.disabledReason !== undefined) throw new Error(`no ${level} in the menu`);
  agentPicks.pick(at(status), item.pick);
};

const chips = (b: SendBinding = binding) => [agentPicks.chip(key, "model", b).label, agentPicks.chip(key, "effort", b).label];

/** Time passes; the next snapshot looks at the pane again (the chip's wait expires). */
const later = (ms: number, status: Status = "idle"): void => {
  vi.setSystemTime(Date.now() + ms);
  agentPicks.sync(key, at(status));
};

describe("Codex's one latest choice outlives the chip's 10 s wait", () => {
  it("Model gpt-6-luna, then Effort 11 seconds later and again 10 minutes later: both name gpt-6-luna", async () => {
    turnContext("gpt-6.1-sol", "high", 500, "t1");
    pickModel("idle", "gpt-6-luna");
    await flush();
    expect(writes).toEqual(["/model gpt-6-luna --reasoning=high"]);
    expect(agentPicks.nextExpiry(key)).toBe(110_000);
    // No turn_context comes (Codex writes one only when a turn starts): the wait shown ends, the choice stays.
    later(11_000);
    expect(agentPicks.nextExpiry(key)).toBeNull();
    expect(chips()).toEqual(["gpt-6-luna", "High"]);
    expect(agentPicks.effective(key, binding)).toEqual({ model: "gpt-6-luna", effort: "high" });
    expect(effortMenuChoices(at("idle"), key, view).levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    pickEffort("idle", "high");
    await flush();
    later(10 * 60_000);
    expect(chips()).toEqual(["gpt-6-luna", "High"]);
    pickEffort("idle", "max");
    await flush();
    expect(writes).toEqual(["/model gpt-6-luna --reasoning=high", "/model gpt-6-luna --reasoning=high", "/model gpt-6-luna --reasoning=max"]);
    expect(writes.some((line) => line.includes("gpt-6.1-sol"))).toBe(false);
    expect(chips()).toEqual(["gpt-6-luna", "Max"]);
  });

  it("a held choice too: it goes after a long turn and later picks still name it", async () => {
    turnContext("gpt-6.1-sol", "high", 500, "t1");
    pickModel("working", "gpt-6-luna");
    later(5 * 60_000, "working");
    expect(chips()).toEqual(["gpt-6-luna", "High"]);
    later(1_000, "idle");
    await flush();
    later(11_000);
    pickEffort("idle", "low");
    await flush();
    expect(writes).toEqual(["/model gpt-6-luna --reasoning=high", "/model gpt-6-luna --reasoning=low"]);
  });
});

describe("a confirmed choice retires every earlier one for good", () => {
  it("Effort Low, then Model gpt-6-luna; a fresh turn_context reports gpt-6-luna / Low: the chips and High name gpt-6-luna", async () => {
    turnContext("gpt-6.1-sol", "high", 500, "t1");
    pickEffort("idle", "low");
    await flush();
    pickModel("idle", "gpt-6-luna");
    await flush();
    expect(writes).toEqual(["/model gpt-6.1-sol --reasoning=low", "/model gpt-6-luna --reasoning=low"]);
    expect(chips()).toEqual(["gpt-6-luna", "Low"]);
    turnContext("gpt-6-luna", "low", 900, "t2");
    expect(agentPicks.confirmations(key, "t2")).toEqual(["Model: gpt-6-luna"]);
    expect(chips()).toEqual(["gpt-6-luna", "Low"]);
    expect(agentPicks.effective(key, binding)).toEqual({ model: "gpt-6-luna", effort: "low" });
    pickEffort("idle", "high");
    await flush();
    expect(writes[2]).toBe("/model gpt-6-luna --reasoning=high");
    // And after the waits: still the new model.
    later(11_000);
    expect(chips()).toEqual(["gpt-6-luna", "High"]);
  });
});

describe("three picks in a row (Model, Effort, Model): the last one wins", () => {
  it.each<Status>(["idle", "working"])("while %s", async (status) => {
    turnContext("gpt-6.1-sol", "high", 500, "t1");
    pickModel(status, "gpt-6-luna");
    await flush();
    pickEffort(status, "max");
    await flush();
    pickModel(status, "gpt-6-astra");
    await flush();
    expect(agentPicks.chip(key, "model", binding)).toEqual({ label: "gpt-6-astra", next: status === "working" });
    expect(agentPicks.chip(key, "effort", binding)).toEqual({ label: "Max", next: status === "working" });
    if (status === "working") {
      expect(writes).toEqual([]);
      later(1_000, "idle");
      await flush();
      // Held: one line, the newest choice.
      expect(writes).toEqual(["/model gpt-6-astra --reasoning=max"]);
    } else {
      expect(writes).toEqual(["/model gpt-6-luna --reasoning=high", "/model gpt-6-luna --reasoning=max", "/model gpt-6-astra --reasoning=max"]);
    }
    later(11_000);
    expect(chips()).toEqual(["gpt-6-astra", "Max"]);
    pickEffort("idle", "ultra");
    await flush();
    expect(writes.at(-1)).toBe("/model gpt-6-astra --reasoning=ultra");
  });
});

describe("a turn_context read after the send is the truth again", () => {
  it("a fresh one naming a third model wins; the same transcript read again does not", async () => {
    turnContext("gpt-6.1-sol", "high", 500, "t1");
    pickModel("idle", "gpt-6-luna");
    await flush();
    later(11_000);
    // The same transcript again (no newer turn_context): the choice stands.
    turnContext("gpt-6.1-sol", "high", 500, "t1");
    expect(chips()).toEqual(["gpt-6-luna", "High"]);
    // A newer turn_context names a third model (another app, the user's own /model): it is what Codex runs now.
    turnContext("gpt-6-astra", "low", 900, "t2");
    expect(chips()).toEqual(["gpt-6-astra", "Low"]);
    expect(effortMenuChoices(at("idle"), key, view)).toEqual({ levels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultLevel: "low" });
    pickEffort("idle", "high");
    await flush();
    expect(writes).toEqual(["/model gpt-6-luna --reasoning=high", "/model gpt-6-astra --reasoning=high"]);
  });

  it("even one that names the old model again (the switch did not take): the transcript's model is shown and named", async () => {
    turnContext("gpt-6.1-sol", "high", 500, "t1");
    pickModel("idle", "gpt-6-luna");
    await flush();
    turnContext("gpt-6.1-sol", "high", 900, "t2");
    expect(chips()).toEqual(["gpt-6.1-sol", "High"]);
    expect(agentPicks.confirmations(key, "t2")).toEqual([]);
  });
});

describe("another run drops the remembered choice", () => {
  it("a restart (another arrival) or another session: the choice goes with the run", async () => {
    turnContext("gpt-6.1-sol", "high", 500, "t1");
    pickModel("idle", "gpt-6-luna");
    await flush();
    later(11_000);
    expect(chips()).toEqual(["gpt-6-luna", "High"]);
    const restarted = bindingOf(2);
    agentPicks.sync(key, at("idle", restarted));
    expect(chips(restarted)).toEqual(["gpt-6.1-sol", "High"]);
    // Gone for good: the old run's binding does not bring it back.
    expect(chips()).toEqual(["gpt-6.1-sol", "High"]);

    agentPicks.clear();
    turnContext("gpt-6.1-sol", "high", 500, "t1");
    pickModel("idle", "gpt-6-luna");
    await flush();
    later(11_000);
    turnContext("gpt-6.1-sol", "high", 40, "s2-t1", "session-2");
    expect(chips(bindingOf(1, "session-2"))).toEqual(["gpt-6.1-sol", "High"]);
    expect(chips()).toEqual(["Default", "Default"]);
  });
});

describe("a later choice main refuses", () => {
  it("leaves the line typed before it as Codex's model (it went, no turn_context since), never the older transcript's", async () => {
    turnContext("gpt-6.1-sol", "high", 500, "t1");
    pickModel("idle", "gpt-6-luna");
    await flush();
    refused.add("gpt-6-astra");
    pickModel("idle", "gpt-6-astra");
    await flush();
    expect(agentPicks.note(key)).toBe("Not set: that model is not in the agent's list on this machine.");
    expect(chips()).toEqual(["gpt-6-luna", "High"]);
    pickEffort("idle", "max");
    await flush();
    expect(writes).toEqual(["/model gpt-6-luna --reasoning=high", "/model gpt-6-luna --reasoning=max"]);
  });
});
