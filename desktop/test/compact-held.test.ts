// The context ring's Compact for a Claude pane whose session keeps
// background tasks running (Monitors, background shells, background subagents). Herdr says `done` when a
// turn ends while they run, and a monitor's event starts another turn. A Compact held "after this turn"
// goes at the next `done` or `idle`, also when a new turn started by the time its turn in the pane's queue
// comes (Claude Code queues a `/compact` typed while it works), never into a dialog; the ring spins until
// the transcript shows the compaction. All panes and Herdr input are fakes.

import { describe, expect, it } from "vitest";

import { AgentPicks, compactLimitMs, compactWaitMs, type PickContext, type PickRequest } from "../src/renderer/components/agent-picks";
import { claudeQueues, sendBound, type SendSite } from "../src/main/herdr/send";
import { isSendBinding, notAtPromptText, type SendBinding } from "../src/shared/send-binding";
import type { AgentInfo, TopologyPaneInfo } from "../src/main/herdr/wire";
import { mainPickBinding, namedPick, pickLine } from "./support/model-pick-line";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

const key = "mac-a/p1";
const claudeBinding: SendBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: "session-1", run: { connection: 2, arrival: 1 } };
const ctx = (status: PickContext["status"], agent: PickContext["agent"] = "claude"): PickContext => ({
  hostId: "mac-a",
  paneId: "p1",
  agent,
  status,
  binding: agent === "claude" ? claudeBinding : { ...claudeBinding, kind: agent },
});
const compact: PickRequest = { kind: "compact", value: "compact", label: "Compact" };
const settings = (compactedAt: number | null) => ({
  model: "claude-fable-5-2",
  modelLabel: "Fable 5.2",
  effort: null,
  used: compactedAt === null ? 310_000 : null,
  compactedAt,
  scope: { terminalID: "t1", session: "session-1" },
});

type Status = "idle" | "done" | "working" | "blocked";

/** A fake Herdr pane with Claude Code in it: its box, the lines a Return submitted (run, or queued while it works), the texts typed. */
function pane(kind = "claude") {
  const state = {
    status: "working" as Status,
    inputPending: false,
    buffer: "",
    submitted: [] as { text: string; while: Status }[],
    writes: [] as string[],
    /** A monitor's event lands as the send checks the pane: a new turn begins. */
    onFresh: null as (() => void) | null,
  };
  const paneInfo = (): TopologyPaneInfo => ({ paneID: "p1", terminalID: "t1", agent: kind, agentStatus: state.status }) as unknown as TopologyPaneInfo;
  const agentInfo = (): AgentInfo =>
    ({ paneID: "p1", agent: kind, agentStatus: state.status, inputPending: state.inputPending, agentSession: { value: "session-1" } }) as unknown as AgentInfo;
  const site = {
    fresh: async () => {
      const event = state.onFresh;
      state.onFresh = null;
      event?.();
      return true;
    },
    pane: paneInfo,
    agent: agentInfo,
    run: () => ({ connection: 2, arrival: 1 }),
    writer: {
      prompt: async () => undefined,
      sendInput: async () => undefined,
      sendText: async (_pane: string, text: string) => {
        state.writes.push(text);
        state.buffer += text;
      },
      agentKeys: async () => {
        state.submitted.push({ text: state.buffer, while: state.status });
        state.buffer = "";
      },
    },
  } as SendSite;
  return { state, site };
}

function picksOn(site: SendSite, clock: { now: number }) {
  const sends: { text: string; binding: SendBinding }[] = [];
  const tasks: Promise<void>[] = [];
  const picks = new AgentPicks({
    send: (_h, p, text, binding) => {
      sends.push({ text, binding });
      const task = sendBound(site, p, text, binding);
      tasks.push(task.catch(() => undefined));
      return task;
    },
    // A model pick goes to main, which types its own line through the same bound Send.
    modelPick: (_h, p, chosen, binding) => {
      const text = pickLine(chosen);
      const sent = mainPickBinding(binding);
      sends.push({ text, binding: sent });
      const task = sendBound(site, p, text, sent);
      tasks.push(task.catch(() => undefined));
      return task;
    },
    copy: () => undefined,
    now: () => clock.now,
  });
  return { picks, sends, settle: async () => {
    await Promise.all(tasks);
    await flush();
  } };
}

describe("the ring's Compact held during a turn, with background tasks running", () => {
  it("goes at done while the monitors and background shells keep running, then shows Compacted once", async () => {
    const { state, site } = pane();
    const clock = { now: 1_000 };
    const { picks, settle } = picksOn(site, clock);
    picks.receive(key, settings(null), "turn-1");
    // A monitor's turn runs: Compact is held (the card says "Compact after this turn").
    picks.pick(ctx("working"), compact);
    expect(picks.compacting(key, claudeBinding)).toBe("held");
    expect(state.writes).toEqual([]);
    // The turn ends; Herdr says done though two background shells and three monitors still run.
    state.status = "done";
    picks.sync(key, ctx("done"));
    await settle();
    expect(state.submitted).toEqual([{ text: "/compact", while: "done" }]);
    expect(picks.compacting(key, claudeBinding)).toBe("running");
    // The transcript shows the compaction: the ring stops, Chat says Compacted once.
    picks.receive(key, settings(9_000), "turn-2");
    expect(picks.compacting(key, claudeBinding)).toBeNull();
    expect(picks.confirmations(key, "turn-2")).toEqual(["Compacted"]);
    picks.receive(key, settings(9_000), "turn-2");
    expect(picks.confirmations(key, "turn-2")).toEqual(["Compacted"]);
  });

  it("a monitor's event that starts a new turn before its check no longer holds it again: typed for Claude to queue", async () => {
    const { state, site } = pane();
    const clock = { now: 1_000 };
    const { picks, sends, settle } = picksOn(site, clock);
    picks.pick(ctx("working"), compact);
    // The page sees done; by the time main checks the pane a monitor's event has started another turn.
    state.status = "done";
    state.onFresh = () => (state.status = "working");
    picks.sync(key, ctx("done"));
    await settle();
    expect(sends[0]!.binding).toMatchObject({ atPromptOnly: true, queuesWhileWorking: true });
    // Typed and its Return pressed while Claude works: Claude Code queues it and runs it when the turn ends.
    expect(state.submitted).toEqual([{ text: "/compact", while: "working" }]);
    expect(picks.compacting(key, claudeBinding)).toBe("running");
    expect(picks.note(key)).toBeNull();
  });

  it("keeps spinning while Claude works past five minutes (a long compaction, or queued behind a monitor's long turn), then shows Compacted", async () => {
    const { state, site } = pane();
    const clock = { now: 1_000 };
    const { picks, settle } = picksOn(site, clock);
    picks.receive(key, settings(null), "turn-1");
    picks.pick(ctx("working"), compact);
    state.status = "done";
    picks.sync(key, ctx("done"));
    await settle();
    expect(state.submitted).toEqual([{ text: "/compact", while: "done" }]);
    // Claude works on for six minutes: every snapshot and the expiry timer look again.
    for (let minute = 1; minute <= 6; minute += 1) {
      clock.now = 1_000 + minute * 60_000;
      picks.sync(key, ctx("working"));
      expect(picks.compacting(key, claudeBinding)).toBe("running");
    }
    // While it works, the wait ends at the latest an hour from the send.
    expect(picks.nextExpiry(key)).toBe(1_000 + compactLimitMs);
    picks.receive(key, settings(12_000), "turn-9");
    expect(picks.confirmations(key, "turn-9")).toEqual(["Compacted"]);
    expect(picks.compacting(key, claudeBinding)).toBeNull();
  });

  it("still stops spinning five minutes after the pane is back at its prompt with no compaction shown", async () => {
    const { state, site } = pane();
    const clock = { now: 1_000 };
    const { picks, settle } = picksOn(site, clock);
    picks.receive(key, settings(null), "turn-1");
    state.status = "done";
    picks.pick(ctx("done"), compact);
    await settle();
    expect(picks.compacting(key, claudeBinding)).toBe("running");
    clock.now += compactWaitMs;
    picks.sync(key, ctx("done"));
    expect(picks.compacting(key, claudeBinding)).toBeNull();
  });

  it("a compaction the transcript showed while Compact was still on its way confirms it once it went", async () => {
    const { state, site } = pane();
    state.status = "done";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const keys = site.writer.agentKeys;
    site.writer.agentKeys = async (p, k) => {
      await keys(p, k);
      // The machine's answer to the Return comes late; the transcript already shows the compaction.
      await gate;
    };
    const clock = { now: 1_000 };
    const { picks, settle } = picksOn(site, clock);
    picks.receive(key, settings(null), "turn-1");
    picks.pick(ctx("done"), compact);
    await flush();
    picks.receive(key, settings(9_000), "turn-2");
    release();
    await settle();
    expect(picks.confirmations(key, "turn-2")).toEqual(["Compacted"]);
    expect(picks.compacting(key, claudeBinding)).toBeNull();
  });
});

describe("what stays as it was", () => {
  it("a dialog or a pending menu at its check still holds it, nothing typed", async () => {
    for (const dialog of ["blocked", "menu"] as const) {
      const { state, site } = pane();
      const clock = { now: 1_000 };
      const { picks, settle } = picksOn(site, clock);
      picks.pick(ctx("working"), compact);
      state.status = "done";
      state.onFresh = () => {
        if (dialog === "blocked") state.status = "blocked";
        else state.inputPending = true;
      };
      picks.sync(key, ctx("done"));
      await settle();
      expect(state.writes).toEqual([]);
      expect(picks.compacting(key, claudeBinding)).toBe("held");
    }
  });

  it("Claude's held Model and Codex's held Compact still go only at the prompt", async () => {
    const claude = pane();
    const clockA = { now: 1_000 };
    const a = picksOn(claude.site, clockA);
    a.picks.pick(ctx("working"), namedPick("model", { agent: "claude", model: "opus", effort: null }, "Opus"));
    claude.state.status = "done";
    claude.state.onFresh = () => (claude.state.status = "working");
    a.picks.sync(key, ctx("done"));
    await a.settle();
    expect(a.sends[0]!.binding.queuesWhileWorking).toBeUndefined();
    expect(claude.state.writes).toEqual([]);
    expect(a.picks.chip(key, "model", claudeBinding)).toEqual({ label: "Opus", next: true });

    const codex = pane("codex");
    const clockB = { now: 1_000 };
    const b = picksOn(codex.site, clockB);
    b.picks.pick(ctx("working", "codex"), compact);
    codex.state.status = "done";
    codex.state.onFresh = () => (codex.state.status = "working");
    b.picks.sync(key, ctx("done", "codex"));
    await b.settle();
    expect(b.sends[0]!.binding.queuesWhileWorking).toBeUndefined();
    expect(codex.state.writes).toEqual([]);
    expect(b.picks.compacting(key, { ...claudeBinding, kind: "codex" })).toBe("held");
  });

  it("main refuses a queued Compact for anything but Claude, and into a dialog, before typing", async () => {
    const binding: SendBinding = { ...claudeBinding, atPromptOnly: true, queuesWhileWorking: true };
    expect(isSendBinding(binding)).toBe(true);
    expect(isSendBinding({ ...binding, queuesWhileWorking: "yes" })).toBe(false);
    const codex = pane("codex");
    await expect(sendBound(codex.site, "p1", "/compact", { ...binding, kind: "codex" })).rejects.toThrow(notAtPromptText);
    const blocked = pane();
    blocked.state.status = "blocked";
    await expect(sendBound(blocked.site, "p1", "/compact", binding)).rejects.toThrow(notAtPromptText);
    expect([...codex.state.writes, ...blocked.state.writes]).toEqual([]);
    const p = (status: string) => ({ paneID: "p1", terminalID: "t1", agent: "claude", agentStatus: status }) as unknown as TopologyPaneInfo;
    expect(claudeQueues(p("working"), null)).toBe(true);
    expect(claudeQueues(p("unknown"), null)).toBe(false);
    expect(claudeQueues(p("working"), { paneID: "p1", agent: "claude", agentStatus: "working", inputPending: true } as AgentInfo)).toBe(false);
  });
});
