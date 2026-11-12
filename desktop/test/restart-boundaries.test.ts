// Restart's boundaries. Each block is one guard of the restart, checked at its
// edge.

import { describe, expect, it, vi } from "vitest";

import { restartAgent } from "../src/main/herdr/restart";
import { agentState, bindingFor, claudeID, fakeMachine, shellState } from "./support/restart-machine";

const otherID = "11111111-2222-4333-8444-555555555555";

describe("the binding is checked again before the Enter after /exit", () => {
  it("the connection changed while /exit's text was acknowledged: no Enter", async () => {
    const m = fakeMachine(agentState());
    const send = m.site.writer.sendText;
    m.site.writer.sendText = async (pane, text) => {
      await send(pane, text);
      m.identity.connection = 4;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: the connection to Mac mini changed");
    expect(m.writes.map((w) => w[0])).toEqual(["sendText"]);
  });

  it("the epoch moved on meanwhile: no Enter", async () => {
    const m = fakeMachine(agentState());
    const send = m.site.writer.sendText;
    m.site.writer.sendText = async (pane, text) => {
      await send(pane, text);
      m.identity.epoch = 8;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: the connection to Mac mini changed");
    expect(m.writes.map((w) => w[0])).toEqual(["sendText"]);
  });

  it("another terminal showed while the text was acknowledged: no Enter", async () => {
    const m = fakeMachine(agentState(), { leavesAfter: null });
    const send = m.site.writer.sendText;
    m.site.writer.sendText = async (pane, text) => {
      await send(pane, text);
      m.show(agentState({ terminal: "t-other" }));
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: another terminal is in this pane now");
    expect(m.writes.map((w) => w[0])).toEqual(["sendText"]);
  });

  it("another session, another kind, or the pane closed meanwhile: no Enter", async () => {
    const cases = [
      { next: agentState({ session: { source: "herdr:claude", agent: "claude", kind: "id", value: otherID } }), note: "Not restarted: another agent is in this pane now" },
      { next: agentState({ kind: "codex" }), note: "Not restarted: another agent is in this pane now" },
      { next: { pane: null, agent: null }, note: "Not restarted: the pane closed" },
    ];
    for (const { next, note } of cases) {
      const m = fakeMachine(agentState(), { leavesAfter: null });
      const send = m.site.writer.sendText;
      m.site.writer.sendText = async (pane, text) => {
        await send(pane, text);
        m.show(next);
      };
      expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe(note);
      expect(m.writes.map((w) => w[0])).toEqual(["sendText"]);
    }
  });

  it("nothing changed: the Enter follows (and the resume)", async () => {
    const m = fakeMachine(agentState());
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBeNull();
    expect(m.writes.at(-1)).toEqual(["sendInput", "w1:p1", `cl --resume ${claudeID}`, ["Enter"]]);
  });
});

describe("the resume names the session the tap was bound to", () => {
  it("the cached snapshot shows another session, the fresh one the tap's: the tap's session is resumed", async () => {
    const m = fakeMachine(agentState({ session: { source: "herdr:claude", agent: "claude", kind: "id", value: otherID } }));
    const fresh = m.site.fresh;
    let calls = 0;
    m.site.fresh = async () => {
      if (++calls === 1) m.show(agentState());
      return fresh();
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBeNull();
    expect(m.writes.at(-1)).toEqual(["sendInput", "w1:p1", `cl --resume ${claudeID}`, ["Enter"]]);
  });

  it("the fresh snapshot shows another session than the tap's: nothing is sent", async () => {
    const m = fakeMachine(agentState());
    const fresh = m.site.fresh;
    m.site.fresh = async () => {
      m.show(agentState({ session: { source: "herdr:claude", agent: "claude", kind: "id", value: otherID } }));
      return fresh();
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: another agent is in this pane now");
    expect(m.writes).toEqual([]);
  });

  it("the start commands are read before the fresh check; nothing is awaited between it and /exit", async () => {
    const m = fakeMachine(agentState());
    const order: string[] = [];
    const startCommands = m.site.startCommands;
    m.site.startCommands = async () => {
      order.push("startCommands");
      return startCommands();
    };
    const fresh = m.site.fresh;
    m.site.fresh = async () => {
      order.push("fresh");
      return fresh();
    };
    const send = m.site.writer.sendText;
    m.site.writer.sendText = async (pane, text) => {
      order.push(`sendText ${text}`);
      return send(pane, text);
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBeNull();
    expect(order.slice(0, 3)).toEqual(["startCommands", "fresh", "sendText /exit"]);
    expect(order.filter((step) => step === "startCommands")).toHaveLength(1);
  });
});

describe("Claude and Codex resume only a full UUID (the Swift app's same cases)", () => {
  const notUUIDs = [
    "--latest", "-r", "abcdefgh", "12345678 extra", "0b6f3c1e8a2d4f7b9c112e5d7a9b3f40",
    "-0b6f3c1e-8a2d-4f7b-9c11-2e5d7a9b3f40", " 0b6f3c1e-8a2d-4f7b-9c11-2e5d7a9b3f40",
    "0b6f3c1e-8a2d-4f7b-9c11-2e5d7a9b3f40 ", "0b6f3c1e-8a2d-4f7b-9c11-2e5d7a9b3f40\n",
    "0b6f3c1e-8a2d-4f7b-9c11-2e5d7a9b3f4", "0b6f3c1e-8a2d-4f7b-9c11-2e5d7a9b3f400", "zb6f3c1e-8a2d-4f7b-9c11-2e5d7a9b3f40",
    "0b6f3c1e-8a2d-4f7b-9c11 2e5d7a9b3f40", "0b6f3c1e-8a2d-4f7b-9c11-2e5d7a9b3f\u00070", "",
  ];

  it("refuses each for both kinds; a UUID goes", async () => {
    const { restartCommand, restartSessionKnown } = await import("../src/shared/agent-restart");
    const { absentStartCommands } = await import("../src/shared/start-commands");
    for (const kind of ["claude", "codex"]) {
      for (const value of notUUIDs) {
        const session = { source: `herdr:${kind}`, agent: kind, kind: "id", value };
        expect(restartCommand(kind, session, absentStartCommands), `${kind} ${JSON.stringify(value)}`).toBeNull();
        expect(restartSessionKnown(kind, session), `${kind} ${JSON.stringify(value)}`).toBe(false);
      }
      const good = { source: `herdr:${kind}`, agent: kind, kind: "id", value: claudeID };
      expect(restartCommand(kind, good, absentStartCommands)).not.toBeNull();
      expect(restartSessionKnown(kind, good)).toBe(true);
    }
  });
});

describe("Restart keeps the user's pending messages (the bubbles' own store)", () => {
  const key = "mac/w1:p1";
  const scope = { terminalID: "t-7", session: claudeID };
  type State = ReturnType<typeof agentState>;
  const hostOf = (state: State) => ({ id: "mac", topology: { panes: state.pane === null ? [] : [state.pane], agents: state.agent === null ? [] : [state.agent] } as never });

  async function stores() {
    const { PendingMessages, RestartHolds, pendingScopes } = await import("../src/shared/chat/pending");
    const pending = new PendingMessages();
    const holds = new RestartHolds();
    pending.add(key, "a sent message not yet in the transcript", 0, scope);
    // What App.tsx's receiveHosts does with each snapshot.
    const snapshot = (state: State, nowMs = 1_000) => {
      const hosts = [hostOf(state)];
      const { scopes, covers } = pendingScopes(hosts, holds.held(hosts, nowMs));
      pending.reconcile(scopes, covers);
    };
    return { pending, holds, snapshot };
  }

  it("through the shell snapshot and the same session's return: the bubble stays", async () => {
    const { pending, holds, snapshot } = await stores();
    holds.hold(key, scope, 0);
    snapshot(agentState());
    snapshot(shellState());
    expect(pending.forPane(key)).toHaveLength(1);
    holds.ended(key, true, 2_000);
    snapshot(shellState(), 3_000);
    expect(pending.forPane(key)).toHaveLength(1);
    snapshot(agentState(), 4_000);
    expect(pending.forPane(key)).toHaveLength(1);
    expect(pending.droppedFor(key)).toBe(0);
    // Back: the hold is over; a later exit is an exit again.
    snapshot(shellState(), 5_000);
    expect(pending.forPane(key)).toEqual([]);
  });

  it("without a restart the shell snapshot still clears them (normal cleanup)", async () => {
    const { pending, snapshot } = await stores();
    snapshot(shellState());
    expect(pending.forPane(key)).toEqual([]);
  });

  it("the pane closed meanwhile: they go", async () => {
    const { pending, holds, snapshot } = await stores();
    holds.hold(key, scope, 0);
    snapshot(shellState());
    snapshot({ pane: null, agent: null });
    expect(pending.forPane(key)).toEqual([]);
  });

  it("another terminal, or another session coming back: they go (the quiet line for the session)", async () => {
    const first = await stores();
    first.holds.hold(key, scope, 0);
    first.snapshot(shellState("t-9"));
    expect(first.pending.forPane(key)).toEqual([]);
    const second = await stores();
    second.holds.hold(key, scope, 0);
    second.snapshot(shellState());
    second.holds.ended(key, true, 2_000);
    second.snapshot(agentState({ session: { source: "herdr:claude", agent: "claude", kind: "id", value: otherID } }), 3_000);
    expect(second.pending.forPane(key)).toEqual([]);
    expect(second.pending.droppedFor(key)).toBe(1);
  });

  it("a restart that stopped before the resume lets go at once; a resumed one that never comes back after 60 s too", async () => {
    const failed = await stores();
    failed.holds.hold(key, scope, 0);
    failed.holds.ended(key, false, 1_000);
    failed.snapshot(shellState(), 1_500);
    expect(failed.pending.forPane(key)).toEqual([]);
    const late = await stores();
    late.holds.hold(key, scope, 0);
    late.holds.ended(key, true, 1_000);
    late.snapshot(shellState(), 30_000);
    expect(late.pending.forPane(key)).toHaveLength(1);
    late.snapshot(shellState(), 62_000);
    expect(late.pending.forPane(key)).toEqual([]);
  });

  it("the page's Restart holds the pane's bubbles while it runs and after it resumed", async () => {
    const { AgentRestarts, restartHeld } = await import("../src/renderer/components/restart");
    const { RestartHolds } = await import("../src/shared/chat/pending");
    const restarts = new AgentRestarts();
    const holds = new RestartHolds();
    const host = { id: "mac", topology: hostOf(agentState()).topology, incarnation: 1, connection: 3, epoch: 7 };
    let finish: (note: string | null) => void = () => {};
    const run = () => new Promise<string | null>((resolve) => { finish = resolve; });
    expect(restartHeld(restarts, holds, host as never, "w1:p1", "Claude", run, () => 0)).toBe(true);
    expect([...holds.held([hostOf(shellState())], 10).keys()]).toEqual([key]);
    finish(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...holds.held([hostOf(shellState())], 20).keys()]).toEqual([key]);
    expect([...holds.held([hostOf(agentState())], 30).keys()]).toEqual([]);
  });
});

describe("the 20 s exit limit holds against a late snapshot", () => {
  it("the shell's snapshot answers at 26 s: nothing more is typed", async () => {
    const m = fakeMachine(agentState(), { leavesAfter: 1 });
    const fresh = m.site.fresh;
    let calls = 0;
    m.site.fresh = async () => {
      if (++calls === 2) await m.site.sleep!(25_000);
      return fresh();
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: Claude did not exit");
    expect(m.writes.map((w) => w[0])).toEqual(["sendText", "agentKeys"]);
  });

  it("a snapshot that never answers: the wait ends at the limit (the real clock)", async () => {
    vi.useFakeTimers();
    try {
      const m = fakeMachine(agentState(), { leavesAfter: null });
      delete (m.site as { now?: unknown }).now;
      delete (m.site as { sleep?: unknown }).sleep;
      const fresh = m.site.fresh;
      let calls = 0;
      m.site.fresh = () => (++calls === 1 ? fresh() : new Promise<boolean>(() => {}));
      let note: string | null | undefined;
      void restartAgent(m.site, "w1:p1", bindingFor(agentState())).then((value) => (note = value));
      await vi.advanceTimersByTimeAsync(20_500);
      expect(note).toBe("Not restarted: Claude did not exit");
      expect(m.writes.map((w) => w[0])).toEqual(["sendText", "agentKeys"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shell shown in time still gets the resume", async () => {
    const m = fakeMachine(agentState(), { leavesAfter: 19 });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBeNull();
    expect(m.elapsed()).toBe(19_000);
  });
});

describe("the id check, table-driven for all three kinds", () => {
  const goodFor: Record<string, string> = { claude: claudeID, codex: claudeID, grok: "grok_9f2c41ab77" };
  // Each kind's own good id broken: an embedded space, options, short, spaces or controls around it.
  const broken = (good: string): string[] => [
    `${good.slice(0, 6)} ${good.slice(7)}`,
    `${good} --print`,
    `--${good}`,
    "--latest",
    "-r",
    good.slice(0, 5),
    ` ${good}`,
    `${good} `,
    `${good}\n`,
    `${good}\t`,
    `${good.slice(0, 6)}\u0007${good.slice(7)}`,
    "",
  ];

  it("no command, not known, Restart greyed, and a tap sends nothing for each", async () => {
    const { restartCommand, restartDisabledReason, restartSessionKnown } = await import("../src/shared/agent-restart");
    const { absentStartCommands } = await import("../src/shared/start-commands");
    for (const kind of ["claude", "codex", "grok"]) {
      for (const value of broken(goodFor[kind]!)) {
        const session = { source: `herdr:${kind}`, agent: kind, kind: "id", value };
        const what = `${kind} ${JSON.stringify(value)}`;
        expect(restartCommand(kind, session, absentStartCommands), what).toBeNull();
        expect(restartSessionKnown(kind, session), what).toBe(false);
        expect(
          restartDisabledReason({ isAgent: true, status: "idle", dialog: false, online: true, sessionKnown: restartSessionKnown(kind, session), busy: false, name: "Agent", machine: "Mac mini" }),
          what,
        ).toBe("No session id known to resume");
        const state = agentState({ kind, session });
        const m = fakeMachine(state);
        // An empty value is no session to the fresh check ("another agent"); either way nothing goes.
        expect(await restartAgent(m.site, "w1:p1", bindingFor(state)), what).toBe(
          value === "" ? "Not restarted: another agent is in this pane now" : "Not restarted: no session id known to resume",
        );
        expect(m.writes, what).toEqual([]);
      }
      const good = { source: `herdr:${kind}`, agent: kind, kind: "id", value: goodFor[kind]! };
      expect(restartCommand(kind, good, absentStartCommands)).not.toBeNull();
      expect(restartSessionKnown(kind, good)).toBe(true);
    }
  });
});

describe("a held bubble stays with its own agent (kind, terminal, session)", () => {
  const key = "mac/w1:p1";
  const scope = { terminalID: "t-7", session: claudeID };
  type State = ReturnType<typeof agentState>;
  const hostOf = (state: State) => ({ id: "mac", topology: { panes: state.pane === null ? [] : [state.pane], agents: state.agent === null ? [] : [state.agent] } as never });

  async function held() {
    const { PendingMessages, RestartHolds, pendingScopes } = await import("../src/shared/chat/pending");
    const pending = new PendingMessages();
    const holds = new RestartHolds();
    pending.add(key, "check the release notes", 0, scope);
    holds.hold(key, scope, 0, "claude");
    const snapshot = (state: State, nowMs = 1_000) => {
      const hosts = [hostOf(state)];
      const { scopes, covers } = pendingScopes(hosts, holds.held(hosts, nowMs));
      pending.reconcile(scopes, covers);
    };
    return { pending, holds, snapshot };
  }

  it("Codex arrives on that terminal after the resume, its session not reported yet: no bubble", async () => {
    const { pending, holds, snapshot } = await held();
    snapshot(shellState());
    holds.ended(key, true, 2_000);
    snapshot(agentState({ kind: "codex", session: null }), 3_000);
    expect(pending.forPane(key)).toEqual([]);
  });

  it("Codex in the pane before the resume went: no bubble", async () => {
    const { pending, snapshot } = await held();
    snapshot(agentState({ kind: "codex", session: null }));
    expect(pending.forPane(key)).toEqual([]);
  });

  it("A's session on another terminal: no bubble", async () => {
    const { pending, holds, snapshot } = await held();
    snapshot(shellState());
    holds.ended(key, true, 2_000);
    snapshot(agentState({ terminal: "t-9" }), 3_000);
    expect(pending.forPane(key)).toEqual([]);
  });

  it("Claude back on that terminal, its session not reported yet: kept (the same kind and terminal), then A's: kept", async () => {
    const { pending, holds, snapshot } = await held();
    snapshot(shellState());
    holds.ended(key, true, 2_000);
    snapshot(agentState({ session: null }), 3_000);
    expect(pending.forPane(key)).toHaveLength(1);
    snapshot(agentState(), 4_000);
    expect(pending.forPane(key)).toHaveLength(1);
  });
});
