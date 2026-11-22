// No quiet line at the bottom of the chat for a confirmed Compact (the record's own "Conversation
// compacted" row is the word, where it happened), and the Model and Effort lines tied to the turn itself (its start
// and first item, the transcript's ids), not to the serial turn id that starts over at each fresh load of the chat;
// shown by one Chat view once, and gone once their turn is no longer the last. The Compact chip's waiting and
// failed states stay (compact-*.test.ts).

import { describe, expect, it } from "vitest";

import { AgentPicks, turnAnchor, type PickContext } from "../src/renderer/components/agent-picks";
import type { PaneSettings } from "../src/shared/agent-settings";
import { makeTurn, type ChatTurn } from "../src/shared/chat/model";
import type { SendBinding } from "../src/shared/send-binding";

const binding: SendBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: "s1" };
const key = "fixture-host/w7:p1";
const context = (status: PickContext["status"]): PickContext => ({ hostId: "fixture-host", paneId: "w7:p1", agent: "claude", status, binding });
const settings = (fields: Partial<PaneSettings> = {}): PaneSettings => ({
  model: "claude-opus-5-5",
  modelLabel: "Opus 5.5",
  effort: null,
  used: 300_000,
  compactedAt: null,
  scope: { terminalID: "t1", session: "s1" },
  ...fields,
});

/** A turn as a load of the chat builds it: its serial id, its start, and its first item (the transcript's own id). */
const turn = (serial: number, startedAt: number, firstItem: string): ChatTurn =>
  makeTurn(`turn-${serial}`, { startedAt, items: [{ type: "user", value: { id: firstItem, text: "go on", attachments: [], time: startedAt } } as never] });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function picksNow() {
  const sent: string[] = [];
  const picks = new AgentPicks({
    send: async (_h, _p, text) => void sent.push(text),
    // A model pick goes to main as itself (main makes its line).
    modelPick: async (_h, _p, pick) => void sent.push(`/model ${pick.model}`),
    copy: () => undefined,
    now: () => 0,
  });
  return { picks, sent };
}

describe("a confirmed Compact", () => {
  it("has no line of its own: the record's row is the word, so right after a compaction the chat shows one row, not two", async () => {
    const { picks, sent } = picksNow();
    const before = [turn(1, 100, "u-1")];
    picks.receive(key, settings(), turnAnchor(before));
    picks.pick(context("idle"), { kind: "compact", value: "compact", label: "Compact" });
    await flush();
    expect(sent).toEqual(["/compact"]);
    expect(picks.compacting(key, binding)).toBe("running");
    const after = [turn(1, 100, "u-1"), turn(2, 200, "compacted-row")];
    picks.receive(key, settings({ compactedAt: 9_000 }), turnAnchor(after));
    // The ring stops; no bottom line beside the transcript's own "Conversation compacted" row.
    expect(picks.compacting(key, binding)).toBeNull();
    expect(picks.confirmations(key, turnAnchor(after))).toEqual([]);
  });

  it("a fresh load whose last turn has the same number: no line", async () => {
    const { picks } = picksNow();
    picks.receive(key, settings(), turnAnchor([turn(1, 100, "u-1")]));
    picks.pick(context("idle"), { kind: "compact", value: "compact", label: "Compact" });
    await flush();
    picks.receive(key, settings({ compactedAt: 9_000 }), turnAnchor([turn(1, 100, "u-1"), turn(2, 200, "compacted-row")]));
    // Hours later the pane's chat loads anew: its turns are numbered from 1 again, and its last is turn-2 too.
    const fresh = [turn(1, 50_000, "u-40"), turn(2, 50_100, "u-41")];
    picks.receive(key, settings({ compactedAt: 9_000 }), turnAnchor(fresh));
    expect(picks.confirmations(key, turnAnchor(fresh))).toEqual([]);
    expect(picks.confirmations(key, "turn-2")).toEqual([]);
  });
});

describe("the Model and Effort lines", () => {
  async function confirmedModel() {
    const { picks, sent } = picksNow();
    const shown = [turn(1, 100, "u-1"), turn(2, 200, "u-2")];
    picks.receive(key, settings({ model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5" }), turnAnchor(shown));
    picks.pick(context("idle"), {
      kind: "model",
      value: "opus",
      label: "Opus",
      command: "/model opus",
      modelPick: { agent: "claude", model: "opus", effort: null },
      expect: { ids: ["claude-opus-5-5"], labels: ["Opus"] },
    });
    await flush();
    expect(sent).toEqual(["/model opus"]);
    picks.receive(key, settings(), turnAnchor(shown));
    return { picks, shown };
  }

  it("are tied to the turn itself, not its serial id: a fresh load whose last turn is turn-2 again shows none", async () => {
    const { picks, shown } = await confirmedModel();
    expect(picks.confirmations(key, turnAnchor(shown))).toEqual(["Model: Opus 5.5"]);
    const fresh = [turn(1, 50_000, "u-40"), turn(2, 50_100, "u-41")];
    expect(fresh.at(-1)!.id).toBe(shown.at(-1)!.id);
    expect(picks.confirmations(key, turnAnchor(fresh))).toEqual([]);
  });

  it("are shown once: a later Chat view of the pane drops what an earlier one showed", async () => {
    const { picks, shown } = await confirmedModel();
    const first = {};
    picks.viewing(key, first);
    expect(picks.confirmations(key, turnAnchor(shown))).toEqual(["Model: Opus 5.5"]);
    picks.markShown(key, turnAnchor(shown), first);
    // The same view re-rendering keeps it.
    picks.viewing(key, first);
    expect(picks.confirmations(key, turnAnchor(shown))).toEqual(["Model: Opus 5.5"]);
    // The pane's chat opened again (another view, the same turn last): gone.
    picks.viewing(key, {});
    expect(picks.confirmations(key, turnAnchor(shown))).toEqual([]);
  });

  it("go once their turn is no longer the last, and do not come back with it", async () => {
    const { picks, shown } = await confirmedModel();
    const next = [...shown, turn(3, 300, "u-3")];
    picks.receive(key, settings(), turnAnchor(next));
    expect(picks.confirmations(key, turnAnchor(next))).toEqual([]);
    expect(picks.confirmations(key, turnAnchor(shown))).toEqual([]);
  });

  it("an Effort line the same way: once, then gone", async () => {
    const { picks, sent } = picksNow();
    const shown = [turn(1, 100, "u-1")];
    picks.receive(key, settings(), turnAnchor(shown));
    picks.pick(context("done"), { kind: "effort", value: "high", label: "High" });
    await flush();
    expect(sent).toEqual(["/effort high"]);
    picks.receive(key, settings({ effort: "high" }), turnAnchor(shown));
    expect(picks.confirmations(key, turnAnchor(shown))).toEqual(["Effort: High"]);
    const view = {};
    picks.markShown(key, turnAnchor(shown), view);
    picks.viewing(key, {});
    expect(picks.confirmations(key, turnAnchor(shown))).toEqual([]);
  });

  it("the anchor: the last turn's start and its first item's id; null for no turn", () => {
    expect(turnAnchor([])).toBeNull();
    expect(turnAnchor([turn(5, 123, "abc")])).toBe(JSON.stringify([123, "abc"]));
  });
});
