// The Effort menu and its command go by the
// effective model: the model pick not yet confirmed when there is one (held for the next turn, on its way, or sent
// and not yet confirmed), else the transcript's. For Codex a pending model and a pending effort are one latest choice
// (one `/model <slug> --reasoning=<level>` naming both), so an effort picked after a model never names the earlier
// model, idle or held; a level the new model lacks falls back to its default. Claude Code's Effort lists the pending
// model's levels. With the real AgentPicks (the page's), AgentChips' menu functions and the demo machine's lists.

import { beforeEach, describe, expect, it, vi } from "vitest";

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

function listOf(agent: "claude" | "codex") {
  const parsed = parseCatalog(agent, demoModelLists[agent]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.models;
}
const viewOf = (agent: "claude" | "codex") => ({ agent, models: listOf(agent), readAt: 1, error: null, loading: false, none: null });

/** Every line main typed into the pane (a model pick's as main makes it: model-pick-main.test.ts runs main's own). */
let writes: string[];

beforeEach(() => {
  writes = [];
  agentPicks.clear();
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    herdrDesktop: {
      sendToPane: async (_hostId: string, _paneId: string, text: string) => void writes.push(text),
      modelPick: async (_hostId: string, _paneId: string, pick: ModelPick) => {
        const built = modelPickCommand(pick, listOf(pick.agent as "claude" | "codex"));
        if (!built.ok) throw new Error(`Not sent: ${built.reason}`);
        writes.push(built.command);
      },
      copyText: () => undefined,
    },
  });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const key = "mini/pane";
const bindingOf = (kind: string): SendBinding => ({ terminalID: "term", isAgent: true, kind, session: "session", run: { connection: 1, arrival: 1 } });
const codex = bindingOf("codex");
const claude = bindingOf("claude");
type Status = "idle" | "working";
const codexAt = (status: Status) => ({ hostId: "mini", paneId: "pane", agent: "codex" as const, status, binding: codex });
const claudeAt = (status: Status) => ({ hostId: "mini", paneId: "pane", agent: "claude" as const, status, binding: claude });
const scope = { terminalID: "term", session: "session" };

/** The Model chip's pick of `id`, as the picker makes it (the level kept is the effective one). */
const pickModel = (context: ReturnType<typeof codexAt> | ReturnType<typeof claudeAt>, id: string): void => {
  const agent = context.agent;
  const request = modelPickRequest(agent, listOf(agent), id, agentPicks.effective(key, context.binding).effort);
  if (request === null) throw new Error(`no pick for ${id}`);
  agentPicks.pick(context, request);
};

/** The Effort chip's menu item of `level` picked. */
const pickEffort = (context: ReturnType<typeof codexAt> | ReturnType<typeof claudeAt>, level: string): void => {
  const item = chipMenu("effort", context, key, viewOf(context.agent)).find((one) => one.pick?.value === level);
  if (item === undefined || item.pick === null || item.disabledReason !== undefined) throw new Error(`no ${level} in the menu`);
  agentPicks.pick(context, item.pick);
};

const menu = (context: ReturnType<typeof codexAt> | ReturnType<typeof claudeAt>) =>
  chipMenu("effort", context, key, viewOf(context.agent)).map((item) => `${item.ticked ? "[x] " : ""}${item.label}${item.tag === undefined ? "" : ` (${item.tag})`}`);

/** The turn ends: the next snapshot shows the pane back at its prompt. */
const turnEnds = async (context: ReturnType<typeof codexAt> | ReturnType<typeof claudeAt>): Promise<void> => {
  agentPicks.sync(key, { ...context, status: "idle" });
  await flush();
};

describe("Codex: Model then Effort is one latest choice", () => {
  it.each<Status>(["idle", "working"])("while %s: gpt-6.1-sol at High, pick gpt-6-luna, then High: the old model never comes back", async (status) => {
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "gpt-6.1-sol", effort: "high", scope }, "t1");
    pickModel(codexAt(status), "gpt-6-luna");
    await flush();
    expect(agentPicks.chip(key, "model", codex)).toMatchObject({ label: "gpt-6-luna", next: status === "working" });
    // The menu is the pending model's: Low to Max (no Ultra), Medium its default, High (kept) ticked.
    expect(effortMenuChoices(codexAt(status), key, viewOf("codex"))).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "medium" });
    expect(menu(codexAt(status))).toEqual(["Low", "Medium (default)", "[x] High", "Extra high", "Max"]);
    pickEffort(codexAt(status), "high");
    await flush();
    if (status === "working") {
      expect(writes).toEqual([]);
      await turnEnds(codexAt(status));
    }
    // Held: one line naming both. Idle: the model's line went, then Effort's names the same new model (never
    // `/model gpt-6.1-sol --reasoning=high` second); a line still on its way is not typed twice (below).
    expect(writes).toEqual(status === "working" ? ["/model gpt-6-luna --reasoning=high"] : ["/model gpt-6-luna --reasoning=high", "/model gpt-6-luna --reasoning=high"]);
    expect(writes.some((line) => line.includes("gpt-6.1-sol"))).toBe(false);
  });

  it.each<Status>(["idle", "working"])("another level after the pending model (%s): its line names the new model, never the earlier", async (status) => {
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "gpt-6.1-sol", effort: "high", scope }, "t1");
    pickModel(codexAt(status), "gpt-6-luna");
    await flush();
    pickEffort(codexAt(status), "max");
    await flush();
    expect(agentPicks.chip(key, "model", codex)).toMatchObject({ label: "gpt-6-luna", next: status === "working" });
    expect(agentPicks.chip(key, "effort", codex)).toMatchObject({ label: "Max", next: status === "working" });
    if (status === "working") {
      expect(writes).toEqual([]);
      await turnEnds(codexAt(status));
      // Held: the two picks are one command, the newest.
      expect(writes).toEqual(["/model gpt-6-luna --reasoning=max"]);
    } else {
      expect(writes).toEqual(["/model gpt-6-luna --reasoning=high", "/model gpt-6-luna --reasoning=max"]);
    }
    // The transcript's turn confirms the latest: the chips and the menu follow it.
    agentPicks.receive(key, { model: "gpt-6-luna", modelLabel: "gpt-6-luna", effort: "max", scope }, "t2");
    expect(menu(codexAt("idle"))).toEqual(["Low", "Medium (default)", "High", "Extra high", "[x] Max"]);
  });

  it("the default fallback: at Ultra on gpt-6.1-sol, gpt-6-luna (no Ultra) goes at its own default, Medium, and the menu ticks it", async () => {
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "gpt-6.1-sol", effort: "ultra", scope }, "t1");
    expect(menu(codexAt("idle"))).toEqual(["Low (default)", "Medium", "High", "Extra high", "Max", "[x] Ultra"]);
    pickModel(codexAt("idle"), "gpt-6-luna");
    await flush();
    expect(writes).toEqual(["/model gpt-6-luna --reasoning=medium"]);
    expect(agentPicks.effective(key, codex)).toEqual({ model: "gpt-6-luna", effort: "medium" });
    expect(menu(codexAt("idle"))).toEqual(["Low", "[x] Medium (default)", "High", "Extra high", "Max"]);
    expect(agentPicks.chip(key, "effort", codex).label).toBe("Medium");
  });

  it("the same line still on its way from the Model chip: Effort's pick of the level it keeps goes once", async () => {
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "gpt-6.1-sol", effort: "high", scope }, "t1");
    pickModel(codexAt("idle"), "gpt-6-luna");
    pickEffort(codexAt("idle"), "high");
    await flush();
    expect(writes).toEqual(["/model gpt-6-luna --reasoning=high"]);
  });

  it("Effort then Model while it works: one command, the held level when the new model takes it, else its default", async () => {
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "gpt-6.1-sol", effort: "low", scope }, "t1");
    pickEffort(codexAt("working"), "ultra");
    pickModel(codexAt("working"), "gpt-6-luna");
    expect(agentPicks.effective(key, codex)).toEqual({ model: "gpt-6-luna", effort: "medium" });
    await turnEnds(codexAt("working"));
    expect(writes).toEqual(["/model gpt-6-luna --reasoning=medium"]);

    writes = [];
    agentPicks.clear();
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "gpt-6.1-sol", effort: "low", scope }, "t1");
    pickEffort(codexAt("working"), "max");
    pickModel(codexAt("working"), "gpt-6-luna");
    await turnEnds(codexAt("working"));
    expect(writes).toEqual(["/model gpt-6-luna --reasoning=max"]);
  });

  it("before any model is known, Effort sends nothing and says where to pick one", () => {
    expect(chipMenu("effort", codexAt("idle"), key, viewOf("codex")).every((item) => item.disabledReason === "Codex's model is not known yet")).toBe(true);
    agentPicks.pick(codexAt("idle"), { kind: "effort", value: "high", label: "High" });
    expect(writes).toEqual([]);
    expect(agentPicks.note(key)).toBe("Not set: Codex's model is not known yet. Pick one on the Model chip.");
  });
});

describe("Claude Code: the Effort menu is the pending model's", () => {
  it("Opus 5.5 at Extra high; Opus 4.6 picked while it works: its levels (no Extra high), the effort after it goes after the model", async () => {
    agentPicks.receive(key, { model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: "xhigh", scope }, "t1");
    expect(menu(claudeAt("working"))).toEqual(["Low", "Medium", "High", "[x] Extra high", "Max"]);
    pickModel(claudeAt("working"), "claude-opus-4-6");
    expect(agentPicks.effective(key, claude).model).toBe("claude-opus-4-6");
    expect(effortMenuChoices(claudeAt("working"), key, viewOf("claude")).levels).toEqual(["low", "medium", "high", "max"]);
    // Extra high is not one of its levels: nothing ticked until the user picks one (Claude Code applies its own).
    expect(menu(claudeAt("working"))).toEqual(["Low", "Medium", "High", "Max"]);
    pickEffort(claudeAt("working"), "max");
    expect(writes).toEqual([]);
    await turnEnds(claudeAt("working"));
    expect(writes).toEqual(["/model claude-opus-4-6", "/effort max"]);
  });

  it("a pending model that takes no level: the menu says so and offers none", () => {
    agentPicks.receive(key, { model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: "high", scope }, "t1");
    pickModel(claudeAt("working"), "claude-haiku-4-5-20251001");
    const items = chipMenu("effort", claudeAt("working"), key, viewOf("claude"));
    expect(items).toEqual([{ label: "This model takes no effort level", ticked: false, pick: null, disabledReason: "Its effort is fixed" }]);
  });
});
