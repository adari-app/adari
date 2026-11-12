// Restart only when it's safe. Greyed while the
// agent works ("Wait for it to finish, or Stop it first"), shows a dialog or a
// pending menu, while the machine is offline, or with no session id known. A
// fresh same-agent check (pane, terminal, kind, session) right before /exit,
// nothing awaited between it and the key; a pane that changed between the
// exit and the resume (closed, another terminal or agent, the connection)
// gets nothing more typed; one tap is one restart; the box's draft is kept.

import { describe, expect, it } from "vitest";

import { restartAgent } from "../src/main/herdr/restart";
import { restartDisabledReason, restartWaitText } from "../src/shared/agent-restart";
import { composerDrafts, draftKey } from "../src/renderer/components/composer-drafts";
import { AgentRestarts } from "../src/renderer/components/restart";
import { agentState, bindingFor, claudeID, fakeMachine, shellState } from "./support/restart-machine";

const exitWrites = [
  ["sendText", "w1:p1", "/exit"],
  ["agentKeys", "w1:p1", ["Enter"]],
];

describe("when Restart is greyed", () => {
  const base = { isAgent: true, status: "idle", dialog: false, online: true, sessionKnown: true, busy: false, name: "Claude", machine: "Mac mini" };

  it("is enabled for an idle or done agent with its session known on a machine that answers", () => {
    expect(restartDisabledReason(base)).toBeNull();
    expect(restartDisabledReason({ ...base, status: "done" })).toBeNull();
  });

  it("says why it is greyed", () => {
    expect(restartWaitText).toBe("Wait for it to finish, or Stop it first");
    expect(restartDisabledReason({ ...base, status: "working" })).toBe("Wait for it to finish, or Stop it first");
    expect(restartDisabledReason({ ...base, dialog: true })).toBe("Claude is waiting for an answer: answer it first");
    expect(restartDisabledReason({ ...base, status: "blocked" })).toBe("Claude is waiting for an answer: answer it first");
    expect(restartDisabledReason({ ...base, online: false })).toBe("Mac mini is offline");
    expect(restartDisabledReason({ ...base, sessionKnown: false })).toBe("No session id known to resume");
    expect(restartDisabledReason({ ...base, busy: true })).toBe("Restarting Claude…");
    expect(restartDisabledReason({ ...base, isAgent: false })).toBe("No agent in this pane");
  });
});

describe("the fresh check right before /exit", () => {
  it("refuses an agent working by the fresh snapshot: nothing is typed", async () => {
    const shown = agentState();
    const m = fakeMachine(agentState({ status: "working" }));
    expect(await restartAgent(m.site, "w1:p1", bindingFor(shown))).toBe("Not restarted: Claude is working. Wait for it to finish, or Stop it first");
    expect(m.writes).toEqual([]);
  });

  it("refuses an agent showing a dialog or a pending menu", async () => {
    const m = fakeMachine(agentState({ pending: true }));
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: Claude is waiting for an answer");
    expect(m.writes).toEqual([]);
  });

  it("refuses another agent, terminal or session than the page showed", async () => {
    const other = fakeMachine(agentState({ terminal: "t-9" }));
    expect(await restartAgent(other.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: another terminal is in this pane now");
    const session = fakeMachine(agentState({ session: { source: "herdr:claude", agent: "claude", kind: "id", value: "11111111-2222-4333-8444-555555555555" } }));
    expect(await restartAgent(session.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: another agent is in this pane now");
    expect([...other.writes, ...session.writes]).toEqual([]);
  });

  it("refuses with no session id known", async () => {
    const none = agentState({ session: null });
    const m = fakeMachine(none);
    expect(await restartAgent(m.site, "w1:p1", bindingFor(none))).toBe("Not restarted: no session id known to resume");
    expect(m.writes).toEqual([]);
  });

  it("refuses while the machine is offline", async () => {
    const m = fakeMachine(agentState());
    m.identity.connection = null;
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: Mac mini is offline");
    expect(m.writes).toEqual([]);
  });

  it("refuses when the fresh snapshot does not come", async () => {
    const m = fakeMachine(agentState());
    m.site.fresh = async () => false;
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: the app could not check Claude. Try again.");
    expect(m.writes).toEqual([]);
  });
});

describe("a pane that changed between the exit and the resume", () => {
  it("closed: nothing more is typed", async () => {
    const m = fakeMachine(agentState(), { after: { pane: null, agent: null } });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: the pane closed");
    expect(m.writes).toEqual(exitWrites);
  });

  it("another terminal in the pane: nothing more is typed", async () => {
    const m = fakeMachine(agentState(), { after: shellState("t-9") });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: another terminal is in this pane now");
    expect(m.writes).toEqual(exitWrites);
  });

  it("another agent started there: nothing more is typed", async () => {
    const codex = agentState({ kind: "codex", session: { source: "herdr:codex", agent: "codex", kind: "id", value: claudeID } });
    const m = fakeMachine(agentState(), { after: codex });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: another agent is in this pane now");
    expect(m.writes).toEqual(exitWrites);
  });

  it("reconnected meanwhile: nothing more is typed", async () => {
    const m = fakeMachine(agentState(), { leavesAfter: 3 });
    const fresh = m.site.fresh;
    let calls = 0;
    m.site.fresh = async () => {
      calls += 1;
      if (calls === 2) m.identity.connection = 4;
      return fresh();
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: the connection to Mac mini changed");
    expect(m.writes).toEqual(exitWrites);
  });
});

describe("one tap, one restart", () => {
  it("a second restart while one runs types nothing more and gets the first one's answer", async () => {
    const m = fakeMachine(agentState(), { leavesAfter: 3 });
    const first = restartAgent(m.site, "w1:p1", bindingFor(agentState()));
    const second = restartAgent(m.site, "w1:p1", bindingFor(agentState()));
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(m.writes.filter((write) => write[0] === "sendText")).toHaveLength(1);
    expect(m.writes.filter((write) => write[0] === "sendInput")).toHaveLength(1);
  });

  it("the page starts one at a time for a pane", async () => {
    const restarts = new AgentRestarts();
    let runs = 0;
    let finish: (note: string | null) => void = () => undefined;
    const run = () => {
      runs += 1;
      return new Promise<string | null>((resolve) => (finish = resolve));
    };
    expect(restarts.restart("mac|w1:p1", run, "Restarting Claude…")).toBe(true);
    expect(restarts.restart("mac|w1:p1", run, "Restarting Claude…")).toBe(false);
    expect(runs).toBe(1);
    expect(restarts.state("mac|w1:p1")).toEqual({ busy: true, note: "Restarting Claude…" });
    finish(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(restarts.state("mac|w1:p1").busy).toBe(false);
  });

  it("keeps the box's draft", async () => {
    const key = draftKey("mac", "w1:p1");
    composerDrafts.edit(key, "my next message");
    const before = composerDrafts.get(key);
    const restarts = new AgentRestarts();
    restarts.restart("mac|w1:p1", async () => null, "Restarting Claude…");
    await Promise.resolve();
    await Promise.resolve();
    expect(composerDrafts.get(key)).toBe(before);
    expect(composerDrafts.get(key).text).toBe("my next message");
  });
});
