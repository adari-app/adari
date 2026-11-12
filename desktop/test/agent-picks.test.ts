// A pick on the Model or Effort chip
// (src/renderer/components/agent-picks.ts). It goes once, as its own command
// line through the bound send (never into the user's box), only while the pane is at
// its prompt: while it works or shows a dialog it is held (one per kind, the
// newest wins, "next turn") and goes once the pane is back; a changed or
// closed pane drops it. After it goes the chip shows the pick until the
// transcript confirms it, or after 10 s what the transcript says. Codex's
// /model takes an argument (0.166.0): its Effort chip sends
// `/model <model> --reasoning=<level>`, its Model chip opens Codex's own picker
// in the Terminal.

import { beforeEach, describe, expect, it } from "vitest";

import { AgentPicks, type PickContext, type PickRequest } from "../src/renderer/components/agent-picks";
import type { PaneSettings } from "../src/shared/agent-settings";
import type { ModelPick } from "../src/shared/model-choices";
import { paneChangedTexts, type SendBinding } from "../src/shared/send-binding";

interface Sent {
  readonly hostId: string;
  readonly paneId: string;
  readonly text: string;
  readonly binding: SendBinding;
  resolve(): void;
  reject(error: Error): void;
}

let sends: Sent[];
let copied: string[];
let clock: number;
let picks: AgentPicks;

beforeEach(() => {
  sends = [];
  copied = [];
  clock = 1_000_000;
  picks = new AgentPicks({
    send: (hostId, paneId, text, binding) => new Promise<void>((resolve, reject) => sends.push({ hostId, paneId, text, binding, resolve, reject })),
    // A model pick goes to main as itself; main's line for it, as model-choices.ts modelPickCommand makes it.
    modelPick: (hostId, paneId, pick, binding) => new Promise<void>((resolve, reject) => sends.push({ hostId, paneId, text: lineOf(pick), binding, resolve, reject })),
    copy: (text) => copied.push(text),
    now: () => clock,
  });
});

/** The line main makes of a listed pick (model-pick-main.test.ts runs main's own handler). */
const lineOf = (pick: ModelPick): string => (pick.effort === null ? `/model ${pick.model}` : `/model ${pick.model} --reasoning=${pick.effort}`);

/** A model from the picker, as AgentChips.tsx modelPickRequest makes it: the structured pick main checks. */
function modelRequest(agent: ModelPick["agent"], model: string, label: string, ids: readonly string[] = [], effort: string | null = null): PickRequest {
  const modelPick: ModelPick = { agent, model, effort };
  return { kind: "model", value: model, label, command: lineOf(modelPick), modelPick, expect: { ids, labels: [label] } };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const binding: SendBinding = { terminalID: "term-1", isAgent: true, kind: "claude", session: "sess-1", run: { connection: 2, arrival: 1 } };
const key = "mac-mini/w7:p1";

function context(status: PickContext["status"], overrides: Partial<PickContext> = {}): PickContext {
  return { hostId: "mac-mini", paneId: "w7:p1", agent: "claude", status, binding, ...overrides };
}

function settings(model: string | null, modelLabel: string | null, effort: string | null, scope = { terminalID: "term-1", session: "sess-1" }): PaneSettings {
  return { model, modelLabel, effort, scope };
}

describe("a pick at the prompt", () => {
  it("goes once, as its own command line, bound to the pane as shown", async () => {
    picks.receive(key, settings("claude-sonnet-5-5", "Sonnet 5.5", null), "t1");
    picks.pick(context("idle"), modelRequest("claude", "opus", "Opus", ["claude-opus-5-5"]));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ hostId: "mac-mini", paneId: "w7:p1", text: "/model opus", binding });
    // The chip shows the pick while it goes and until the transcript confirms it.
    expect(picks.chip(key, "model", binding)).toEqual({ label: "Opus", next: false });
    sends[0]!.resolve();
    await flush();
    picks.sync(key, context("idle"));
    expect(sends).toHaveLength(1);
    expect(picks.chip(key, "model", binding)).toEqual({ label: "Opus", next: false });
    picks.receive(key, settings("claude-opus-5-5", "Opus 5.5", null), "t1");
    expect(picks.chip(key, "model", binding)).toEqual({ label: "Opus 5.5", next: false });
    // One quiet line in the turn, once confirmed.
    expect(picks.confirmations(key, "t1")).toEqual(["Model: Opus 5.5"]);
    expect(picks.confirmations(key, "t2")).toEqual([]);
  });

  it("an Effort pick types /effort <level>; Default until the transcript says", async () => {
    expect(picks.chip(key, "effort", binding)).toEqual({ label: "Default", next: false });
    picks.pick(context("done"), { kind: "effort", value: "high", label: "High" });
    expect(sends.map((sent) => sent.text)).toEqual(["/effort high"]);
    sends[0]!.resolve();
    await flush();
    picks.receive(key, settings(null, null, "high"), null);
    expect(picks.chip(key, "effort", binding)).toEqual({ label: "High", next: false });
    expect(picks.confirmations(key, null)).toEqual(["Effort: High"]);
  });

  it("after 10 s without a confirmation the chip shows what the transcript says", async () => {
    picks.receive(key, settings(null, null, "low"), null);
    picks.pick(context("idle"), { kind: "effort", value: "max", label: "Max" });
    sends[0]!.resolve();
    await flush();
    clock += 9_000;
    picks.sync(key, context("idle"));
    expect(picks.chip(key, "effort", binding).label).toBe("Max");
    clock += 1_000;
    picks.sync(key, context("idle"));
    expect(picks.chip(key, "effort", binding).label).toBe("Low");
    expect(picks.confirmations(key, null)).toEqual([]);
    expect(sends).toHaveLength(1);
  });

  it("a second click while the first is on its way does not send again", () => {
    picks.pick(context("idle"), modelRequest("claude", "opus", "Opus"));
    picks.pick(context("idle"), modelRequest("claude", "opus", "Opus"));
    expect(sends).toHaveLength(1);
  });
});

describe("a pick while the pane works or shows a dialog", () => {
  it("is held, one per kind, the newest winning, and goes once the pane is back at its prompt", async () => {
    picks.pick(context("working"), { kind: "effort", value: "high", label: "High" });
    picks.pick(context("working"), { kind: "effort", value: "max", label: "Max" });
    picks.pick(context("working"), modelRequest("claude", "fable", "Fable"));
    expect(sends).toHaveLength(0);
    expect(picks.chip(key, "effort", binding)).toEqual({ label: "Max", next: true });
    expect(picks.chip(key, "model", binding)).toEqual({ label: "Fable", next: true });
    picks.sync(key, context("working"));
    picks.sync(key, context("blocked"));
    expect(sends).toHaveLength(0);
    picks.sync(key, context("idle"));
    expect(sends.map((sent) => sent.text).sort()).toEqual(["/effort max", "/model fable"]);
    // A pick goes only while the agent is at its prompt at its turn.
    for (const sent of sends) expect(sent.binding).toEqual({ ...binding, atPromptOnly: true });
    picks.sync(key, context("idle"));
    expect(sends).toHaveLength(2);
  });

  it("a dialog holds it too", () => {
    picks.pick(context("blocked"), modelRequest("claude", "haiku", "Haiku"));
    expect(sends).toHaveLength(0);
    expect(picks.chip(key, "model", binding).next).toBe(true);
  });

  it("is dropped when the pane changes (another terminal, agent, session or run) or closes", () => {
    for (const changed of [
      { ...binding, terminalID: "term-2" },
      { ...binding, kind: "codex" },
      { ...binding, session: "sess-2" },
      { ...binding, run: { connection: 3, arrival: 1 } },
    ]) {
      picks.pick(context("working"), { kind: "effort", value: "high", label: "High" });
      picks.sync(key, context("idle", { binding: changed }));
      expect(picks.chip(key, "effort", changed).next).toBe(false);
    }
    picks.pick(context("working"), { kind: "effort", value: "high", label: "High" });
    picks.sync(key, null);
    picks.sync(key, context("idle"));
    expect(sends).toHaveLength(0);
    expect(picks.note(key)).toBe("Not set: the pane changed before its turn ended.");
  });

  it("a session Herdr names only now is the same pane", () => {
    const unnamed = { ...binding, session: null };
    picks.pick(context("working", { binding: unnamed }), { kind: "effort", value: "low", label: "Low" });
    picks.sync(key, context("idle"));
    expect(sends.map((sent) => sent.binding)).toEqual([{ ...unnamed, atPromptOnly: true }]);
  });
});

describe("a pick that did not go", () => {
  it("a changed pane refuses: nothing again, the command is copied and the note says so", async () => {
    picks.pick(context("idle"), modelRequest("claude", "opus", "Opus"));
    sends[0]!.reject(new Error(paneChangedTexts.otherProgram));
    await flush();
    expect(copied).toEqual(["/model opus"]);
    expect(picks.note(key)).toBe("Not set: another program is in this pane now. The command is copied.");
    picks.sync(key, context("idle"));
    expect(sends).toHaveLength(1);
    expect(picks.chip(key, "model", binding).label).toBe("Default"); // The agent's default, never a bare "Model"
  });

  it("any other refusal shows Herdr's words", async () => {
    picks.pick(context("idle"), { kind: "effort", value: "low", label: "Low" });
    sends[0]!.reject(new Error("Not sent: the agent is not ready for a message yet. The text is kept."));
    await flush();
    expect(copied).toEqual([]);
    expect(picks.note(key)).toBe("Not set: the agent is not ready for a message yet.");
  });
});

describe("Codex panes", () => {
  const codex: SendBinding = { ...binding, kind: "codex" };
  const codexContext = (status: PickContext["status"]): PickContext => context(status, { agent: "codex", binding: codex });

  it("Effort goes as the model pick it names: /model <model> --reasoning=<level>, made in main", () => {
    picks.receive(key, settings("gpt-5.5", "gpt-5.5", "medium"), null);
    const modelPick: ModelPick = { agent: "codex", model: "gpt-5.5", effort: "high" };
    picks.pick(codexContext("idle"), { kind: "effort", value: "high", label: "High", command: lineOf(modelPick), modelPick });
    expect(sends.map((sent) => sent.text)).toEqual(["/model gpt-5.5 --reasoning=high"]);
  });

  it("Effort without the model it names says why and sends nothing (no line is made in the page)", () => {
    picks.receive(key, settings("gpt-5.5", "gpt-5.5", "medium"), null);
    picks.pick(codexContext("idle"), { kind: "effort", value: "high", label: "High" });
    expect(sends).toHaveLength(0);
    expect(picks.note(key)).toBe("Not set: Codex's model is not known yet. Pick one on the Model chip.");
  });

  it("Model goes only by name from the picker: the old bare /model (Codex's own picker) and a family word are refused", () => {
    picks.pick(codexContext("idle"), { kind: "model", value: "picker", label: "Choose…" });
    picks.pick(context("idle"), { kind: "model", value: "opus", label: "Opus" });
    expect(sends).toHaveLength(0);
    expect(picks.note(key)).toBe("Not set: that is not one of the menu's choices.");
    expect(picks.chip(key, "model", codex).label).toBe("Default"); // The agent's default, never a bare "Model"
  });
});

describe("the transcript's values for the chips", () => {
  it("are shown only for the terminal and session they were read for", () => {
    picks.receive(key, settings("claude-opus-5-5", "Opus 5.5", "high"), null);
    expect(picks.chip(key, "model", binding).label).toBe("Opus 5.5");
    expect(picks.chip(key, "model", { ...binding, terminalID: "term-9" }).label).toBe("Default"); // The agent's default, never a bare "Model"
    expect(picks.chip(key, "effort", { ...binding, session: "sess-9" }).label).toBe("Default");
    picks.receive(key, null, null);
    expect(picks.chip(key, "model", binding).label).toBe("Opus 5.5");
  });
});
