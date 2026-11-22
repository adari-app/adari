// Antigravity CLI's models (shared/model-catalog.ts parseAgyModels, shared/model-choices.ts agyFamilies and its start
// flags): `agy models` as the samples hold it (models-1.5.14.txt: its "Fetching available models..." line and 23
// rows, Gemini 4 Neon first) and its unknown-model output (no row: no list); rows of exactly `<id><TAB><label>`, any
// other skipped; one model per name with its bracket's levels in the fixed order, a row with no level a model of its
// own; New agent's start line typed and through Herdr's own start, checked against the machine's list; nothing picked
// is plain `agy`; the last pick remembered; the demo machine's list the sample's bytes. The same cases as
// Tests/HerdrKitTests/AgyModelsTests.swift.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { demoAgyModels } from "../src/main/demo/demo-model-lists";
import { newAgent, newAgentTexts, type NewAgentClock, type NewAgentHerdr } from "../src/main/herdr/new-agent";
import { ModelCatalogs } from "../src/main/model-catalogs";
import { agyUnknownModelLine } from "../src/shared/agy-input";
import { StepTimer, type StartStepName } from "../src/shared/speed-record";
import type { StartFlag } from "../src/shared/model-choices";
import type { AgentInfo, TabCreation } from "../src/main/herdr/wire";
import { antigravityNoList, builtInCatalog, listCommand, parseCatalog, type CatalogModel } from "../src/shared/model-catalog";
import {
  agyFamilies,
  agyFamilyRows,
  agyLabelParts,
  agyRowId,
  agyRowOf,
  agyRowSaid,
  coreStartWords,
  effortChoices,
  flagWords,
  listedModels,
  startChipLabel,
  startFlags,
  startTakesEffort,
  startTakesModel,
  typedFlags,
} from "../src/shared/model-choices";
import { lastStartChoice, rememberStartChoice } from "../src/shared/model-prefs";
import { absentStartCommands, parseStartCommands } from "../src/shared/start-commands";

const { newAgentFlags } = await import("../src/main/ipc");

const fixture = (name: string): string => readFileSync(path.join(__dirname, "..", "fixtures", "agy", name), "utf8");
const sample = fixture("models-1.5.14.txt");

function models(text = sample): readonly CatalogModel[] {
  const parsed = parseCatalog("agy", text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.models;
}

const rows: readonly (readonly [string, string])[] = [
  ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
  ["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"],
  ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
  ["gemini-4-neon-low", "Gemini 4 Neon (Low)"],
  ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
  ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
  ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
  ["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"],
  ["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
  ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)"],
  ["gemini-pro-orchestrator-g1-pro", "Orchestrator (Argon)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
  ["claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"],
  ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
  ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"],
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
];

describe("the list: `agy models`", () => {
  it("is the machine's `agy` with `models`, argv only, the other agents' bound", () => {
    expect(listCommand("agy", null)).toEqual({ program: "agy", args: ["models"], stdin: null, timeoutMs: 20_000 });
    expect(listCommand("agy", "agy")).toEqual({ program: "agy", args: ["models"], stdin: null, timeoutMs: 20_000 });
  });

  it("models-1.5.14.txt: its 23 rows, ids and labels exact, in the CLI's order (Gemini 4 Neon first)", () => {
    const list = models();
    expect(list.map((model) => [model.id, model.label])).toEqual(rows);
    expect(list[0]!.label).toBe("Gemini 4 Neon (High)");
    expect(list.every((model) => model.efforts.length === 0 && model.defaultEffort === null && !model.isDefault && model.group === null)).toBe(true);
  });

  it("the unknown-model output, an empty output, the first line alone: no row, no list", () => {
    expect(parseCatalog("agy", fixture("model-unknown-1.5.14.txt")).ok).toBe(false);
    expect(parseCatalog("agy", "").ok).toBe(false);
    expect(parseCatalog("agy", "Fetching available models...\n").ok).toBe(false);
  });

  it("only rows of exactly <id><TAB><label>: an extra tab, a missing label, no tab, a bad id are skipped", () => {
    const text = [
      "Fetching available models...",
      "gemini-4-neon-high\tGemini 4 Neon (High)\textra",
      "gemini-4-neon-low\t",
      "gemini-4-neon-medium",
      "gemini 4\tGemini 4",
      "-x\tFlag",
      "\tNo id",
      "gemini-4-argon-high\tGemini 4 Argon (High)",
      "",
    ].join("\n");
    expect(models(text).map((model) => model.id)).toEqual(["gemini-4-argon-high"]);
  });

  it("a carriage return at a row's end is not part of it; brackets inside a label stay", () => {
    const text = "gemini-4-neon-high\tGemini 4 Neon (High)\r\nmodel-x\tModel (Beta) X (Low)\r\nmodel-y\tModel [Y] (Preview)\r\n";
    expect(models(text).map((model) => [model.id, model.label])).toEqual([
      ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
      ["model-x", "Model (Beta) X (Low)"],
      ["model-y", "Model [Y] (Preview)"],
    ]);
  });

  it("with no list: the picker's line, as before", () => {
    expect(builtInCatalog("agy")).toEqual({ agent: "agy", models: [], readAt: null, error: null, loading: false, none: antigravityNoList });
    expect(antigravityNoList).toBe("Antigravity CLI's models are in its own picker.");
    expect(listedModels("agy", [])).toEqual([]);
    expect(effortChoices("agy", [], null).levels).toEqual([]);
  });

  it("the demo machine's list is the sample's bytes", () => {
    expect(demoAgyModels).toBe(sample);
  });
});

describe("the grouping: one model per name, its bracket's levels", () => {
  it("each of the 23 rows: 9 models, levels in the order low, medium, high, xhigh, max", () => {
    const families = agyFamilies(models());
    expect(families.map((family) => [family.name, family.id, family.levels.map((one) => one.level), family.firstLevel])).toEqual([
      ["Gemini 4 Neon", "gemini-4-neon-high", ["low", "medium", "high", "xhigh"], "high"],
      ["Gemini 4 Argon", "gemini-4-argon-medium", ["low", "medium", "high"], "medium"],
      ["Gemini 4 Hydrogen", "gemini-4-hydrogen-high", ["low", "medium", "high", "xhigh"], "high"],
      ["Orchestrator (Neon)", "gemini-pro-orchestrator-neon", [], null],
      ["Orchestrator (Argon)", "gemini-pro-orchestrator-g1-pro", [], null],
      ["Gemini 3.8 Flash", "gemini-3.8-flash-high", ["low", "medium", "high"], "high"],
      ["Claude Opus 5.5", "claude-opus-5-5-low", ["low", "medium", "high"], "low"],
      ["Claude Sonnet 5.5", "claude-sonnet-5-5-low", ["low", "medium", "high"], "low"],
      ["GPT-OSS 120B", "gpt-oss-120b-medium", ["medium"], "medium"],
    ]);
    // Every row belongs to exactly one model.
    const ids = families.flatMap((family) => (family.levels.length === 0 ? [family.id] : family.levels.map((one) => one.id)));
    expect([...ids].sort()).toEqual(rows.map(([id]) => id).sort());
    expect(families[0]!.levels.map((one) => one.id)).toEqual(["gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-high", "gemini-4-neon-xhigh"]);
  });

  it("a level only in a last bracket holding a level word; anything else is the model's whole name", () => {
    expect(agyLabelParts("Gemini 4 Neon (XHigh)")).toEqual({ name: "Gemini 4 Neon", level: "xhigh" });
    expect(agyLabelParts("Big (Max)")).toEqual({ name: "Big", level: "max" });
    expect(agyLabelParts("Orchestrator (Neon)")).toEqual({ name: "Orchestrator (Neon)", level: null });
    expect(agyLabelParts("Foo (High) Beta")).toEqual({ name: "Foo (High) Beta", level: null });
    expect(agyLabelParts("Plain")).toEqual({ name: "Plain", level: null });
  });

  it("the bracket's word is trimmed before it is tested: `Family ( hIgH )` groups with `Family (LOW)`", () => {
    expect(agyLabelParts("Family ( hIgH )")).toEqual({ name: "Family", level: "high" });
    expect(agyLabelParts("Family (\tlow )")).toEqual({ name: "Family", level: "low" });
    expect(agyLabelParts("Orchestrator ( Neon )")).toEqual({ name: "Orchestrator ( Neon )", level: null });
    const list = models("pad-high\tFamily ( hIgH )\npad-low\tFamily (LOW)\n");
    expect(agyFamilies(list).map((family) => [family.name, family.id, family.levels.map((one) => [one.level, one.id])])).toEqual([
      ["Family", "pad-high", [["low", "pad-low"], ["high", "pad-high"]]],
    ]);
  });

  it("two models whose labels differ only after the bracket are never merged; a row with no level is never merged", () => {
    const list = models("a-1\tModel (Low) A\na-2\tModel (Low) B\nb-1\tSolo\nb-2\tSolo\nc-low\tCee (Low)\nc-high\tCee (High)\n");
    expect(agyFamilies(list).map((family) => [family.name, family.id, family.levels.length])).toEqual([
      ["Model (Low) A", "a-1", 0],
      ["Model (Low) B", "a-2", 0],
      ["Solo", "b-1", 0],
      ["Solo", "b-2", 0],
      ["Cee", "c-low", 2],
    ]);
  });

  it("New agent's rows: one per model, its levels and the CLI's first level for it", () => {
    const rowsShown = agyFamilyRows(models());
    expect(rowsShown[0]).toEqual({ id: "gemini-4-neon-high", label: "Gemini 4 Neon", group: null, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high", isDefault: false });
    expect(rowsShown[3]).toMatchObject({ label: "Orchestrator (Neon)", efforts: [], defaultEffort: null });
    expect(listedModels("agy", models())).toEqual(rowsShown);
    expect(effortChoices("agy", models(), "gemini-4-neon-high")).toEqual({ levels: ["low", "medium", "high", "xhigh"], defaultLevel: "high" });
    expect(effortChoices("agy", models(), "gemini-pro-orchestrator-neon").levels).toEqual([]);
    expect(startChipLabel("agy", models(), "gemini-4-neon-high")).toBe("Gemini 4 Neon");
    expect(startTakesModel("agy")).toBe(true);
    expect(startTakesEffort("agy")).toBe(true);
  });

  it("a row id from a model and a level, and back; a running pane's last row to its row", () => {
    const list = models();
    expect(agyRowId(list, "gemini-4-neon-high", "xhigh")).toBe("gemini-4-neon-xhigh");
    expect(agyRowId(list, "gemini-4-neon-low", null)).toBe("gemini-4-neon-high");
    expect(agyRowId(list, "gemini-4-neon-high", "max")).toBeNull();
    expect(agyRowId(list, "nope", "low")).toBeNull();
    expect(agyRowOf(list, "gemini-4-neon-xhigh")).toEqual({ name: "Gemini 4 Neon", level: "xhigh" });
    expect(agyRowOf(list, "gemini-pro-orchestrator-neon")).toEqual({ name: "Orchestrator (Neon)", level: null });
    expect(agyRowSaid(list, "Gemini 4 Hydrogen", "low")).toBe("gemini-4-hydrogen-low");
    expect(agyRowSaid(list, "gemini 3.8 flash", "low")).toBe("gemini-3.8-flash-low");
    expect(agyRowSaid(list, "Orchestrator", "neon")).toBe("gemini-pro-orchestrator-neon");
    expect(agyRowSaid(list, "Orchestrator (Argon)", null)).toBe("gemini-pro-orchestrator-g1-pro");
    expect(agyRowSaid(list, "Orchestrator", null)).toBeNull();
    expect(agyRowSaid(list, "Gemini 4 Neon", null)).toBeNull();
    expect(agyRowSaid(list, "Gemini 9", "low")).toBeNull();
  });
});

describe("New agent's start line", () => {
  const list = models();
  const flags = (model: string | null, effort: string | null) => startFlags("agy", { model, effort }, list);

  it("nothing picked: no flag (plain `agy`)", () => {
    expect(flags(null, null)).toEqual({ ok: true, flags: [] });
  });

  it("a model and a level: --model <that level's row id>; never --effort", () => {
    const words = (model: string, effort: string | null) => {
      const result = flags(model, effort);
      if (!result.ok) throw new Error(result.reason);
      return flagWords(result.flags);
    };
    expect(words("gemini-4-neon-high", "xhigh")).toEqual(["--model", "gemini-4-neon-xhigh"]);
    expect(words("gemini-4-neon-high", "low")).toEqual(["--model", "gemini-4-neon-low"]);
    expect(words("gemini-4-neon-high", null)).toEqual(["--model", "gemini-4-neon-high"]);
    expect(words("gemini-pro-orchestrator-neon", null)).toEqual(["--model", "gemini-pro-orchestrator-neon"]);
    for (const model of agyFamilies(list)) {
      for (const level of [null, ...model.levels.map((one) => one.level)]) expect(words(model.id, level)).not.toContain("--effort");
    }
  });

  it("refused: an id not on the list, a level the model lacks, a level with no model, an id of another shape", () => {
    expect(flags("gemini-9", null)).toEqual({ ok: false, reason: "That model is not in the agent's list on this machine." });
    // A level's row id is not a picker row (the start names the model and its level).
    expect(flags("gemini-4-neon-low", null)).toEqual({ ok: false, reason: "That model is not in the agent's list on this machine." });
    expect(flags("gemini-4-argon-medium", "xhigh")).toEqual({ ok: false, reason: "That model does not take that effort." });
    expect(flags("gemini-pro-orchestrator-neon", "low")).toEqual({ ok: false, reason: "That model does not take that effort." });
    expect(flags(null, "high")).toEqual({ ok: false, reason: "That effort is not one this agent takes at start." });
    expect(flags("x;y", null)).toEqual({ ok: false, reason: "That model is not one this agent names." });
    expect(startFlags("agy", { model: "gemini-4-neon-high", effort: null }, [])).toEqual({ ok: false, reason: "That model is not in the agent's list on this machine." });
  });

  it("typed after the start command, single-quoted; Herdr's own start as a plain word; anything else refused", () => {
    expect(typedFlags([{ flag: "--model", value: "gemini-4-neon-xhigh" }])).toBe("--model 'gemini-4-neon-xhigh'");
    expect(coreStartWords("agy", [], ["--model", "gemini-4-neon-xhigh"])).toEqual(["--model 'gemini-4-neon-xhigh'"]);
    expect(coreStartWords("agy", [], [])).toEqual([]);
    expect(coreStartWords("agy", [], ["--effort", "high"])).toBeNull();
    expect(coreStartWords("agy", [], ["--model", "a b"])).toBeNull();
    expect(coreStartWords("agy", [], ["--mode", "auto"])).toBeNull();
  });
});

// MARK: - the start itself, with a fake Herdr

class FakeHerdr implements NewAgentHerdr {
  readonly calls: string[] = [];
  private typed = false;
  agentList(): Promise<AgentInfo[]> {
    this.calls.push("agent.list");
    return Promise.resolve(this.typed ? [{ paneID: "w1:pn1", name: "agy", agent: "agy" }] : []);
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
const request = { workspaceId: "w1", folder: null, kind: "agy" };

describe("New agent starts Antigravity CLI with the pick", () => {
  const list = models();
  const catalogs = (held: readonly CatalogModel[]) => ({ settled: async () => ({ agent: "agy" as const, models: held, readAt: 1, error: null, loading: false, none: held.length === 0 ? antigravityNoList : null }) });

  it("main checks the pick against the machine's list right before the start", async () => {
    expect(flagWords(await newAgentFlags(catalogs(list), "mini", { ...request, model: "gemini-4-neon-high", effort: "xhigh" }))).toEqual(["--model", "gemini-4-neon-xhigh"]);
    expect(await newAgentFlags(catalogs(list), "mini", request)).toEqual([]);
    await expect(newAgentFlags(catalogs(list), "mini", { ...request, model: "gemini-9" })).rejects.toThrow("That model is not in the agent's list on this machine. Nothing was made.");
    // The list failing (an old CLI): no pick goes; nothing picked starts plain `agy`.
    await expect(newAgentFlags(catalogs([]), "mini", { ...request, model: "gemini-4-neon-high" })).rejects.toThrow("Nothing was made.");
    expect(await newAgentFlags(catalogs([]), "mini", request)).toEqual([]);
  });

  it("a typed start command: `agy --model '<id>'`; nothing picked: `agy` alone", async () => {
    const herdr = new FakeHerdr();
    const flags = startFlags("agy", { model: "gemini-4-neon-high", effort: "xhigh" }, list);
    const result = await newAgent(herdr, parseStartCommands(encode('{"agy": "agy"}')), { workspaceId: "w1", folder: null, kind: "agy" }, clock, 90_000, 1_000, undefined, flags.ok ? flags.flags : []);
    expect(herdr.calls).toContain("typed agy --model 'gemini-4-neon-xhigh'");
    expect(result.start).toEqual({ type: "typed", command: "agy --model 'gemini-4-neon-xhigh'" });
    const plain = new FakeHerdr();
    await newAgent(plain, parseStartCommands(encode('{"agy": "agy"}')), { workspaceId: "w1", folder: null, kind: "agy" }, clock, 90_000, 1_000, undefined, []);
    expect(plain.calls).toContain("typed agy");
  });

  it("Herdr's own start: the id as a plain word", async () => {
    const herdr = new FakeHerdr();
    const flags = startFlags("agy", { model: "gemini-pro-orchestrator-neon", effort: null }, list);
    await newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: null, kind: "agy" }, clock, 90_000, 1_000, undefined, flags.ok ? flags.flags : []);
    expect(herdr.calls.at(-1)).toBe('agent.start agy ["--model","gemini-pro-orchestrator-neon"]');
    const plain = new FakeHerdr();
    await newAgent(plain, absentStartCommands, { workspaceId: "w1", folder: null, kind: "agy" }, clock);
    expect(plain.calls.at(-1)).toBe("agent.start agy null");
  });
});

describe("the last pick is remembered per machine", () => {
  const storage = () => {
    const map = new Map<string, string>();
    return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
  };

  it("Antigravity CLI's model and level as the other agents' picks are; a bad id is dropped", () => {
    const s = storage();
    // Nothing remembered is Gemini 4 Neon, High (agyPreselect), no longer the CLI's own default.
    expect(lastStartChoice(s, "mini", "agy")).toEqual({ model: "gemini-4-neon-high", effort: "high" });
    rememberStartChoice(s, "mini", "agy", { model: "gemini-4-neon-high", effort: "xhigh" });
    expect(lastStartChoice(s, "mini", "agy")).toEqual({ model: "gemini-4-neon-high", effort: "xhigh" });
    expect(lastStartChoice(s, "box", "agy")).toEqual({ model: "gemini-4-neon-high", effort: "high" });
    rememberStartChoice(s, "mini", "agy", { model: null, effort: null });
    expect(lastStartChoice(s, "mini", "agy")).toEqual({ model: null, effort: null });
    s.setItem("adari.newAgent.models", JSON.stringify({ "mini|agy": { model: "gemini 4; x", effort: "high" } }));
    expect(lastStartChoice(s, "mini", "agy")).toEqual({ model: null, effort: "high" });
  });
});

// Ruled: a start with an id the machine no longer lists. The CLI refuses it in the new pane
// (model-unknown-1.5.14.txt as the pane's text); the person is told so, no agent is counted as started, and the list
// read again behind the start no longer offers the id (the dialog's side: new-agent.test.ts).
describe("a start with an id the machine no longer lists", () => {
  const gone = "gemini-4-neon-xhigh";
  const refusal = fixture("model-unknown-1.5.14.txt").replaceAll("not-a-model", gone);
  const line = `error: invalid model selection (--model "${gone}" --effort ""): model ${gone} is not recognized`;

  class RefusingPane extends FakeHerdr {
    paneText(): Promise<string> {
      this.calls.push("pane.read");
      return Promise.resolve(`demo % agy --model '${gone}'\n${refusal}\ndemo % `);
    }
    override agentList(): Promise<AgentInfo[]> {
      this.calls.push("agent.list");
      return Promise.resolve([]);
    }
  }

  /** A machine whose `agy models` lists the id at first and not after it was removed. */
  function machine() {
    let output = sample;
    const runs: string[] = [];
    const catalogs = new ModelCatalogs({
      store: null,
      now: () => 100,
      changed: () => undefined,
      machine: () => ({ startCommand: async () => null, runner: { where: "fake", run: async () => (runs.push(output), { kind: "ran" as const, code: 0, output }) } }),
    });
    return { catalogs, runs, remove: () => (output = sample.split("\n").filter((row) => !row.startsWith(`${gone}\t`)).join("\n")) };
  }

  it("the refusal's line is read from the pane's text, only in its whole shape", () => {
    expect(agyUnknownModelLine(refusal)).toBe(line);
    expect(agyUnknownModelLine(`demo % agy --model '${gone}'`)).toBeNull();
    expect(agyUnknownModelLine("model x is not recognized")).toBeNull();
  });

  it.each([
    ["a typed start command", parseStartCommands(encode('{"agy": "agy"}'))],
    ["Herdr's own start", absentStartCommands],
  ] as const)("%s: the person is told the CLI refused it, no agent counted, the next opening no longer offers it", async (_name, commands) => {
    const m = machine();
    // The dialog opened: the list read, the id on it.
    expect((await m.catalogs.settled("mini", "agy")).models.some((model) => model.id === gone)).toBe(true);
    m.remove();
    // Start: checked against the held list (no wait for a new read), the list read again behind it.
    const flags = await newAgentFlags(m.catalogs, "mini", { ...request, model: "gemini-4-neon-high", effort: "xhigh" });
    expect(flagWords(flags)).toEqual(["--model", gone]);
    const herdr = new RefusingPane();
    // A clock that moves with each wait (the start's own deadlines end it if the refusal is not read).
    let now = 0;
    const moving: NewAgentClock = { now: () => now, sleep: (ms: number) => ((now += Math.max(ms, 1)), Promise.resolve()) };
    const result = await newAgent(herdr, commands, request, moving, 90_000, 1_000, { name: "Mac mini" }, flags);
    // No agent counted as started (the handler's agentStarted and the dialog's noteStart skip noAgent).
    expect(result.start.type).toBe("noAgent");
    expect(result.summary).toBe(newAgentTexts.modelUnknown("Antigravity CLI", "Mac mini", line, "tab"));
    expect(result.summary).toBe(
      `Antigravity CLI did not start on Mac mini: it does not know the model picked now. Its tab says “${line}”. Its list is read again; pick another model.`,
    );
    // The next opening: the list read again no longer offers the id; its start with that id is refused before anything is made.
    const view = await m.catalogs.afterReading("mini", "agy");
    expect(m.runs).toHaveLength(2);
    expect(view.models.some((model) => model.id === gone)).toBe(false);
    expect(agyFamilies(view.models)[0]!.levels.map((one) => one.level)).toEqual(["low", "medium", "high"]);
    await expect(newAgentFlags(m.catalogs, "mini", { ...request, model: "gemini-4-neon-high", effort: "xhigh" })).rejects.toThrow("Nothing was made.");
  });

  // Merge pass (main's New agent speed): a refused start ends its speed record as the not-installed start beside it
  // does: its look's time under "wait", the record closed as no agent, nothing typed into the pane after the start.
  it.each([
    ["a typed start command", parseStartCommands(encode('{"agy": "agy"}'))],
    ["Herdr's own start", absentStartCommands],
  ] as const)("%s refused for its model: the speed record closed as no agent with the wait recorded, as a not-installed start's", async (_name, commands) => {
    const run = async (herdr: FakeHerdr, flags: readonly StartFlag[]) => {
      let now = 0;
      const moving: NewAgentClock = { now: () => now, sleep: (ms: number) => ((now += Math.max(ms, 1)), Promise.resolve()) };
      const timer = new StepTimer<StartStepName>(() => now);
      const outcomes: string[] = [];
      const result = await newAgent(herdr, commands, request, moving, 90_000, 1_000, { name: "Mac mini" }, flags, {
        timer,
        ended: (outcome) => outcomes.push(outcome),
      });
      return { result, outcomes, steps: timer.list(), now };
    };
    const flags: StartFlag[] = [{ flag: "--model", value: gone }];
    const refusedPane = new RefusingPane();
    // The pane's text reads only after a moment, so the wait's time is more than nothing.
    const read = refusedPane.paneText.bind(refusedPane);
    let reads = 0;
    refusedPane.paneText = () => (reads++ === 0 ? Promise.resolve("demo % ") : read());
    const refused = await run(refusedPane, flags);
    const missingPane = new RefusingPane();
    missingPane.paneText = () => Promise.resolve("demo % agy\nzsh: command not found: agy\ndemo % ");
    const missing = await run(missingPane, []);

    expect(refused.result.summary).toBe(newAgentTexts.modelUnknown("Antigravity CLI", "Mac mini", line, "tab"));
    expect(refused.result.start.type).toBe("noAgent");
    // The record is closed once, as no agent, as the not-installed start's is.
    expect(refused.outcomes).toEqual(["noAgent"]);
    expect(missing.outcomes).toEqual(["noAgent"]);
    // Its wait recorded (once, the time from the start's answer to the refusal read), as the not-installed start's.
    const waits = (steps: readonly { name: string; ms: number }[]) => steps.filter((step) => step.name === "wait");
    expect(waits(refused.steps)).toHaveLength(1);
    expect(waits(missing.steps)).toHaveLength(1);
    expect(waits(refused.steps)[0]!.ms).toBeGreaterThan(0);
    expect(refused.steps.map((step) => step.name)).toEqual(missing.steps.map((step) => step.name));
    // Nothing typed into the pane after the start (one typed line at most: the start command itself).
    expect(refusedPane.calls.filter((call) => call.startsWith("typed ")).length).toBeLessThanOrEqual(1);
    if (commands === absentStartCommands) expect(refusedPane.calls.some((call) => call.startsWith("typed "))).toBe(false);
  });

  it("without a pick, the same words never show (plain `agy` is not refused for a model)", async () => {
    const herdr = new RefusingPane();
    herdr.agentList = () => Promise.resolve([{ paneID: "w1:pn1", name: "agy", agent: "agy" }]);
    const result = await newAgent(herdr, parseStartCommands(encode('{"agy": "agy"}')), request, clock, 90_000, 1_000, { name: "Mac mini" }, []);
    expect(result.start).toEqual({ type: "typed", command: "agy" });
  });
});
