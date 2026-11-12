// The boundaries of Compact while Claude works.
// - Main lets the working-state permission through for a typed Claude `/compact` only (with or without one
//   line of instructions), whatever the page's flag says.
// - A `/compact` the user typed and Chat holds for the end of the turn stays theirs: saved with the pane's
//   draft, never replaced by a second one, and back in the box when it does not go (with newer text there,
//   under Kept drafts, test/compact-kept.test.ts).
// - Claude's Compact that does not land stops spinning: its compaction-failed line, or the end of the periods
//   that can be its own, or an hour from the send; five minutes at the prompt; Codex's five minutes
//   from the send. A long single turn still spins until the compaction lands, and says Compacted once.
// Every pane, Herdr input, transcript line and saved draft here is invented.

import { afterEach, describe, expect, it, vi } from "vitest";

import { sendBound, type SendSite } from "../src/main/herdr/send";
import { decodeSessionTopology, type AgentInfo, type TopologyPaneInfo } from "../src/main/herdr/wire";
import { isCompactCommand, isSendBinding, notAtPromptText, type SendBinding } from "../src/shared/send-binding";
import { AgentSettingsReader } from "../src/shared/agent-settings";
import type { DraftInput } from "../src/shared/drafts";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const {
  AgentPicks,
  agentPicks,
  compactAlreadyText,
  compactFailedText,
  compactGraceMs,
  compactLimitMs,
  compactQueuedText,
  compactWaitMs,
} = await import("../src/renderer/components/agent-picks");
type PickContext = import("../src/renderer/components/agent-picks").PickContext;
const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
const { draftPersistence } = await import("../src/renderer/components/draft-persistence");
const { commandRows } = await import("../src/renderer/chat/command-rows");
const { HookHost, find, elements } = await import("./support/fake-hooks");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
};

const key = "mac-a/p1";
const binding: SendBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: "session-1", run: { connection: 2, arrival: 1 } };
const flagged: SendBinding = { ...binding, atPromptOnly: true, queuesWhileWorking: true };
const compact = { kind: "compact" as const, value: "compact", label: "Compact" };
const ctx = (status: PickContext["status"], agent: PickContext["agent"] = "claude"): PickContext => ({
  hostId: "mac-a",
  paneId: "p1",
  agent,
  status,
  binding: agent === "claude" ? binding : { ...binding, kind: agent },
});
const settings = (compactedAt: number | null, extra: object = {}) => ({
  model: "claude-opus-5-5",
  modelLabel: "Opus 5.5",
  effort: "high",
  compactedAt,
  ...extra,
  scope: { terminalID: "t1", session: "session-1" },
});

type Status = "idle" | "done" | "working" | "blocked";

/** A fake Herdr pane with an agent in it: what was typed, each Return and what it submitted. */
function pane(kind = "claude") {
  const state = { kind, status: "working" as Status, menu: false, freshFails: false, returnLost: false, buffer: "" };
  const log: string[][] = [];
  const site = {
    fresh: async () => !state.freshFails,
    pane: () => ({ paneID: "p1", terminalID: "t1", agent: state.kind, agentStatus: state.status }) as unknown as TopologyPaneInfo,
    agent: () =>
      ({ paneID: "p1", agent: state.kind, agentStatus: state.status, inputPending: state.menu, agentSession: { value: "session-1" } }) as unknown as AgentInfo,
    run: () => ({ connection: 2, arrival: 1 }),
    writer: {
      prompt: async (_p: string, text: string) => void log.push(["prompt", text]),
      sendInput: async (_p: string, text: string) => void log.push(["input", text]),
      sendText: async (_p: string, text: string) => {
        log.push(["text", text]);
        state.buffer += text;
      },
      agentKeys: async () => {
        // An answer that never came: the Return's outcome is not known.
        if (state.returnLost) throw new Error("the connection closed");
        log.push(["return", state.buffer]);
        state.buffer = "";
      },
    },
  } as unknown as SendSite;
  return { state, site, log };
}

/** The machine's snapshot with the one pane in it. */
function hostAt(status: string, kind = "claude") {
  return {
    id: "mac-a",
    name: "fake",
    state: "connected",
    topology: decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [],
      tabs: [],
      layouts: [],
      panes: [{ pane_id: "p1", terminal_id: "t1", workspace_id: "w1", tab_id: "tab1", focused: false, agent: kind, agent_status: status, revision: 1 }],
      agents: [{ pane_id: "p1", agent: kind, agent_status: status, agent_session: { source: `herdr:${kind}`, agent: kind, kind: "id", value: "session-1" } }],
    }),
    run: { connection: 2, arrivals: { p1: 1 } },
  };
}

const mounted: { unmount(): void }[] = [];
afterEach(() => {
  for (const ui of mounted.splice(0)) ui.unmount();
  draftPersistence.detach();
  composerDrafts.clear();
  agentPicks.clear();
  commandRows.clear();
  vi.unstubAllGlobals();
});

/** Chat's real box for the pane, its sends going through main's real checks to the fake pane. */
function composerOn(status: Status = "working") {
  composerDrafts.clear();
  agentPicks.clear();
  commandRows.clear();
  const machine = pane();
  machine.state.status = status;
  const calls: string[] = [];
  vi.stubGlobal("window", {
    innerHeight: 900,
    herdrDesktop: {
      sendToPane: async (_h: string, p: string, text: string, b: SendBinding) => {
        calls.push(text);
        await sendBound(machine.site, p, text, b);
      },
      copyText: () => undefined,
      stopAgent: async () => null,
    },
  });
  const ui = new HookHost(Composer as (props: object) => unknown, {
    host: hostAt(status),
    row: { paneID: "p1", kind: "claude", isAgent: true, status, workspaceLabel: "fake" },
    stops: true,
  });
  mounted.push(ui);
  ui.render();
  const typeIn = (text: string): void => (find(ui.tree, "textarea")!.props["onChange"] as (event: unknown) => void)({ target: { value: text } });
  const send = async (text: string): Promise<void> => {
    typeIn(text);
    (find(ui.tree, "textarea")!.props["onKeyDown"] as (event: unknown) => void)({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => undefined,
    });
    await flush();
  };
  /** The turn ends: Herdr says done, the page looks again. */
  const turnEnds = async (): Promise<void> => {
    machine.state.status = "done";
    agentPicks.syncHosts([hostAt("done") as never]);
    await flush();
  };
  const note = (): string | null => {
    const line = elements(ui.tree).find((e) => e.props["className"] === "cmp-note-t");
    return line === undefined ? null : String(line.props["children"]);
  };
  return { machine, calls, ui, typeIn, send, turnEnds, note, box: () => composerDrafts.get(key) };
}

describe("main: the working-state permission is for Compact only", () => {
  it.each(["/model opus", "/effort high", "/permissions", "/compactor anything", "/plugin:skill arg"])(
    "%s with the flag while Claude works is refused as without it; nothing is typed",
    async (command) => {
      const { site, log } = pane();
      expect(isSendBinding(flagged)).toBe(true);
      await expect(sendBound(site, "p1", command, flagged)).rejects.toThrow(notAtPromptText);
      await expect(sendBound(site, "p1", command, { ...binding, atPromptOnly: true })).rejects.toThrow(notAtPromptText);
      expect(log).toEqual([]);
    },
  );

  it("/compact, and /compact with one line of instructions, still go while Claude works (Claude queues them)", async () => {
    const { site, log } = pane();
    await sendBound(site, "p1", "/compact", flagged);
    await sendBound(site, "p1", "/compact keep the plan", flagged);
    expect(log).toEqual([
      ["text", "/compact"],
      ["return", "/compact"],
      ["text", "/compact keep the plan"],
      ["return", "/compact keep the plan"],
    ]);
  });

  it("only /compact and /compact with one line of instructions are Compact's line (the box holds no other)", () => {
    for (const line of ["/compact", "/compact keep the plan", "/compact  keep it all"]) expect(isCompactCommand(line)).toBe(true);
    for (const line of ["/compactor anything", "/compactness", "/compact\nkeep the plan", "/compact\tkeep", "/model opus", " /compact", "compact"]) {
      expect(isCompactCommand(line)).toBe(false);
    }
  });
});

describe("the user's typed Compact words are never lost", () => {
  it("a second /compact while one is held stays in the box with a note; the first goes, once", async () => {
    const c = composerOn();
    await c.send("/compact keep the database migration plan");
    expect(c.box().text).toBe("");
    expect(c.note()).toBe(compactQueuedText);
    await c.send("/compact preserve the UI plan");
    expect(c.calls).toEqual([]);
    expect(c.box().text).toBe("/compact preserve the UI plan");
    expect(c.note()).toBe(compactAlreadyText);
    await c.turnEnds();
    expect(c.machine.log).toEqual([
      ["text", "/compact keep the database migration plan"],
      ["return", "/compact keep the database migration plan"],
    ]);
    // The second is still the user's, in the box.
    expect(c.box().text).toBe("/compact preserve the UI plan");
  });

  it("refused when the turn ends, with the box empty: the user's line is back in the box, with the refusal", async () => {
    const c = composerOn();
    await c.send("/compact keep the deployment rollback plan");
    expect(c.box().text).toBe("");
    c.machine.state.freshFails = true;
    await c.turnEnds();
    expect(c.machine.log).toEqual([]);
    expect(c.box().text).toBe("/compact keep the deployment rollback plan");
    expect(c.box().held).toBeNull();
    expect(c.note()).toMatch(/could not check/);
  });

  // With main's Kept drafts, the line is a Kept draft (test/compact-kept.test.ts). Here no main process keeps
  // drafts: it is back in the box, before the user's newer text,
  // never only in the note.
  it("refused when the turn ends, with newer text in the box and no Kept drafts to take it: the line is back in the box before the user's newer text, the note says so until dismissed", async () => {
    const c = composerOn();
    await c.send("/compact keep the deployment rollback plan");
    c.typeIn("and then look at the layout");
    c.machine.state.freshFails = true;
    await c.turnEnds();
    expect(c.box().text).toBe("/compact keep the deployment rollback plan\nand then look at the layout");
    expect(c.box().held).toBeNull();
    expect(c.note()).toMatch(/could not check/);
    expect(c.note()).toMatch(/ Your line is back in the box\.$/);
    expect(agentPicks.noteKept(key)).toBe(true);
    // A later snapshot does not clear it: it stays until the user dismisses it.
    agentPicks.syncHosts([hostAt("working") as never]);
    expect(c.note()).toMatch(/ Your line is back in the box\.$/);
    agentPicks.dismissNote(key);
    expect(agentPicks.note(key)).toBeNull();
    expect(c.machine.log).toEqual([]);
  });

  it("dropped because the pane's run changed: back in the box", async () => {
    const c = composerOn();
    await c.send("/compact keep the open questions");
    agentPicks.syncHosts([{ ...hostAt("done"), run: { connection: 2, arrivals: { p1: 2 } } } as never]);
    await flush();
    expect(c.machine.log).toEqual([]);
    expect(c.box().text).toBe("/compact keep the open questions");
    expect(agentPicks.note(key)).toBe("Not set: the pane changed before its turn ended.");
  });

  it("a Return whose outcome is not known keeps the unconfirmed-Return wording; the line is back for the user to check, never sent again by itself", async () => {
    const c = composerOn();
    await c.send("/compact keep the plan");
    c.machine.state.returnLost = true;
    await c.turnEnds();
    expect(c.note()).toMatch(/^Not set: Typed into .+, but the Mac did not confirm its Return\. Check the agent before sending again\.$/);
    expect(c.box().text).toBe("/compact keep the plan");
    agentPicks.syncHosts([hostAt("done") as never]);
    await flush();
    expect(c.calls).toEqual(["/compact keep the plan"]);
  });

  it("the held line is in the saved draft, so a reload brings it back as text in the box, never sent again", async () => {
    const c = composerOn();
    const saves: (DraftInput | null)[] = [];
    draftPersistence.attach({ saveDraft: (_h: string, _p: string, input: DraftInput | null) => void saves.push(input), keptDraft: async () => undefined } as never);
    await c.send("/compact keep the release checklist");
    expect(c.box().text).toBe("");
    const saved = saves.at(-1);
    expect(saved?.text).toBe("/compact keep the release checklist");
    // A normal message the user sends meanwhile does not take it out of the saved draft.
    await c.send("check the build too");
    expect(c.machine.log).toEqual([["prompt", "check the build too"]]);
    expect(saves.at(-1)?.text).toBe("/compact keep the release checklist");
    // The window reloads before the turn ends: the page starts afresh and gets its drafts back.
    c.ui.unmount();
    mounted.splice(0);
    composerDrafts.clear();
    agentPicks.clear();
    draftPersistence.restore({ drafts: [{ hostId: "mac-a", paneId: "p1", ...saved!, savedAt: 1 }], kept: [] });
    expect(composerDrafts.get(key).text).toBe("/compact keep the release checklist");
    await c.turnEnds();
    expect(c.machine.log).toEqual([["prompt", "check the build too"]]);
  });

  it("once it went, the saved draft lets it go", async () => {
    const c = composerOn();
    const saves: (DraftInput | null)[] = [];
    draftPersistence.attach({ saveDraft: (_h: string, _p: string, input: DraftInput | null) => void saves.push(input), keptDraft: async () => undefined } as never);
    await c.send("/compact keep the release checklist");
    await c.turnEnds();
    expect(c.machine.log.filter((entry) => entry[0] === "return")).toEqual([["return", "/compact keep the release checklist"]]);
    expect(saves.at(-1)).toBeNull();
    expect(c.box().held ?? null).toBeNull();
    expect(c.box().text).toBe("");
  });
});

describe("a Compact that does not land stops spinning", () => {
  const picksAt = (clock: { now: number }) => new AgentPicks({ send: async () => undefined, copy: () => undefined, now: () => clock.now });

  it("Claude's compaction error ends the wait at once across two hours of short monitor turns; the ring is free", async () => {
    const clock = { now: 1_000 };
    const picks = picksAt(clock);
    picks.receive(key, settings(null), "turn-1");
    picks.pick(ctx("done"), compact);
    await flush();
    expect(picks.compacting(key, binding)).toBe("running");
    const reader = new AgentSettingsReader("claude");
    reader.line(JSON.stringify({ type: "system", subtype: "local_command", content: "Error: Compaction failed: API error", isSidechain: false, sessionId: "session-1" }), 400);
    expect(reader.settings.compactedAt).toBeNull();
    expect(reader.settings.compactFailedAt).toBe(400);
    let stopped: number | null = null;
    // Each monitor event: 2 s of work, then 58 s at the prompt, for two hours.
    for (let minute = 1; minute <= 120; minute += 1) {
      clock.now = 1_000 + minute * 60_000;
      picks.sync(key, ctx("working"));
      picks.receive(key, { ...reader.settings, scope: settings(null).scope }, `monitor-${minute}`);
      clock.now += 2_000;
      picks.sync(key, ctx("done"));
      if (stopped === null && picks.compacting(key, binding) === null) stopped = minute;
    }
    expect(stopped).toBe(1);
    expect(picks.note(key)).toBe(compactFailedText);
    expect(picks.noteKept(key)).toBe(true);
    // The ring's button is free: a new Compact goes.
    picks.pick(ctx("done"), compact);
    await flush();
    expect(picks.compacting(key, binding)).toBe("running");
  });

  it("with no word from Claude, the wait ends after the compaction's own run and the turn it may be queued behind, not every later turn", async () => {
    const clock = { now: 1_000 };
    const picks = picksAt(clock);
    picks.receive(key, settings(null), "turn-1");
    picks.pick(ctx("done"), compact);
    await flush();
    let stopped: number | null = null;
    for (let minute = 1; minute <= 120; minute += 1) {
      clock.now = 1_000 + minute * 60_000;
      picks.sync(key, ctx("working"));
      clock.now += 2_000;
      picks.sync(key, ctx("done"));
      // The expiry timer looks again when the page said it would.
      const expiry = picks.nextExpiry(key);
      if (expiry !== null && expiry <= 1_000 + (minute + 1) * 60_000) {
        clock.now = expiry;
        picks.sync(key, ctx("done"));
      }
      if (stopped === null && picks.compacting(key, binding) === null) stopped = minute;
    }
    expect(stopped).toBe(2);
    expect(picks.note(key)).toBe(compactFailedText);
    expect(compactGraceMs).toBeLessThan(60_000);
  });

  it("a Claude pane at done for five minutes still expires, saying nothing", async () => {
    const clock = { now: 1_000 };
    const picks = picksAt(clock);
    picks.receive(key, settings(null), "turn-1");
    picks.pick(ctx("done"), compact);
    await flush();
    clock.now += compactWaitMs - 1;
    picks.sync(key, ctx("done"));
    expect(picks.compacting(key, binding)).toBe("running");
    clock.now += 1;
    picks.sync(key, ctx("done"));
    expect(picks.compacting(key, binding)).toBeNull();
    expect(picks.note(key)).toBeNull();
  });

  it("Claude working without end stops an hour after the send, with the line", async () => {
    const clock = { now: 1_000 };
    const picks = picksAt(clock);
    picks.receive(key, settings(null), "turn-1");
    picks.pick(ctx("done"), compact);
    await flush();
    for (let minute = 1; minute < 60; minute += 1) {
      clock.now = 1_000 + minute * 60_000;
      picks.sync(key, ctx("working"));
      expect(picks.compacting(key, binding)).toBe("running");
    }
    expect(picks.nextExpiry(key)).toBe(1_000 + compactLimitMs);
    clock.now = 1_000 + compactLimitMs;
    picks.sync(key, ctx("working"));
    expect(picks.compacting(key, binding)).toBeNull();
    expect(picks.note(key)).toBe(compactFailedText);
  });

  it("Codex keeps its five minutes from the send, even while it works", async () => {
    const clock = { now: 1_000 };
    const picks = picksAt(clock);
    const codex = { ...binding, kind: "codex" };
    picks.pick(ctx("done", "codex"), compact);
    await flush();
    expect(picks.compacting(key, codex)).toBe("running");
    clock.now += compactWaitMs + 1;
    picks.sync(key, ctx("working", "codex"));
    expect(picks.compacting(key, codex)).toBeNull();
    expect(picks.note(key)).toBeNull();
  });

  it("a long single Claude turn keeps the spinner until the compaction lands, then says Compacted once", async () => {
    const clock = { now: 1_000 };
    const picks = picksAt(clock);
    picks.receive(key, settings(null), "turn-1");
    // Held during the turn, it goes as the turn ends; a monitor's turn and the compaction then run as one long stretch.
    picks.pick(ctx("working"), compact);
    clock.now = 2_000;
    picks.sync(key, ctx("done"));
    await flush();
    for (let minute = 1; minute <= 40; minute += 1) {
      clock.now = 2_000 + minute * 60_000;
      picks.sync(key, ctx("working"));
      expect(picks.compacting(key, binding)).toBe("running");
    }
    picks.receive(key, settings(52_000), "turn-2");
    expect(picks.confirmations(key, "turn-2")).toEqual(["Compacted"]);
    expect(picks.compacting(key, binding)).toBeNull();
    picks.receive(key, settings(52_000), "turn-2");
    clock.now += 60_000;
    picks.sync(key, ctx("done"));
    expect(picks.confirmations(key, "turn-2")).toEqual(["Compacted"]);
    expect(picks.note(key)).toBeNull();
  });
});
