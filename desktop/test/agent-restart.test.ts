// Restart, on the user's tap only. The exact keys, in
// order, for each agent: `/exit` typed to the agent (pane.send_text) and its
// Return (agent.send_keys), then, once the pane shows its shell in the same
// terminal, the agent's resume command and Return typed into the shell
// (pane.send_input): Claude `cl --resume <id>` (the Resume chip's command),
// Codex `codex resume <id> --no-daemon`, Grok `grok --resume <id>`. A fake machine, a fake
// clock; nothing else is ever written, and never agent.restart.

import { describe, expect, it } from "vitest";

import { restartAgent, restartExitTimeoutMs } from "../src/main/herdr/restart";
import { restartCommand, restartTexts } from "../src/shared/agent-restart";
import { absentStartCommands, startCommandsWith } from "../src/shared/start-commands";
import { agentState, bindingFor, claudeID, fakeMachine, grokID } from "./support/restart-machine";

describe("the resume command table", () => {
  it("builds each agent's resume line for the same session", () => {
    const id = { source: "herdr:claude", agent: "claude", kind: "id", value: claudeID };
    expect(restartCommand("claude", id, startCommandsWith({ type: "read" }, { claude: "cl" }))).toBe(`cl --resume ${claudeID}`);
    expect(restartCommand("claude", id, absentStartCommands)).toBe(`claude --resume ${claudeID}`);
    expect(restartCommand("codex", { ...id, agent: "codex" }, absentStartCommands)).toBe(`codex resume ${claudeID} --no-daemon`);
    expect(restartCommand("grok", { source: "herdr:grok", agent: "grok", kind: "id", value: grokID }, absentStartCommands)).toBe(`grok --resume ${grokID}`);
  });

  it("takes the id at the end of a transcript path, as the Resume chip does", () => {
    const path = { source: "herdr:claude", agent: "claude", kind: "path", value: `/Users/x/.claude/projects/p/${claudeID}.jsonl` };
    expect(restartCommand("claude", path, absentStartCommands)).toBe(`claude --resume ${claudeID}`);
  });

  it("has no command without a session id, for another kind, or while the commands are not known", () => {
    expect(restartCommand("claude", null, absentStartCommands)).toBeNull();
    expect(restartCommand("grok", null, absentStartCommands)).toBeNull();
    expect(restartCommand("grok", { source: "herdr:grok", agent: "grok", kind: "id", value: "--latest" }, absentStartCommands)).toBeNull();
    expect(restartCommand("cursor", { source: "x", agent: "cursor", kind: "id", value: claudeID }, absentStartCommands)).toBeNull();
    expect(restartCommand("claude", { source: "x", agent: "claude", kind: "id", value: claudeID }, null)).toBeNull();
    expect(restartCommand("claude", { source: "x", agent: "claude", kind: "id", value: claudeID }, startCommandsWith({ type: "read" }, { claude: "cl; rm" }))).toBeNull();
  });
});

describe("the restart's keys", () => {
  it("Claude: /exit, its Return, then cl --resume <id> and Return in the shell", async () => {
    const m = fakeMachine(agentState());
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBeNull();
    expect(m.writes).toEqual([
      ["sendText", "w1:p1", "/exit"],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["sendInput", "w1:p1", `cl --resume ${claudeID}`, ["Enter"]],
    ]);
  });

  it("Codex: codex resume <id>", async () => {
    const codex = agentState({ kind: "codex", session: { source: "herdr:codex", agent: "codex", kind: "id", value: claudeID } });
    const m = fakeMachine(codex);
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.writes).toEqual([
      ["sendText", "w1:p1", "/exit"],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["sendInput", "w1:p1", `codex resume ${claudeID} --no-daemon`, ["Enter"]],
    ]);
  });

  it("Grok: grok --resume <id>, its row in the same table", async () => {
    const grok = agentState({ kind: "grok", session: { source: "herdr:grok", agent: "grok", kind: "id", value: grokID } });
    const m = fakeMachine(grok);
    expect(await restartAgent(m.site, "w1:p1", bindingFor(grok, "Grok"))).toBeNull();
    expect(m.writes.at(-1)).toEqual(["sendInput", "w1:p1", `grok --resume ${grokID}`, ["Enter"]]);
  });

  it("types the resume command only once the shell shows, never before", async () => {
    const m = fakeMachine(agentState(), { leavesAfter: 5 });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBeNull();
    expect(m.elapsed()).toBe(5_000);
    expect(m.writes.filter((write) => write[0] === "sendInput")).toHaveLength(1);
  });

  it("an agent that does not exit within 20 s: nothing more is typed, and the note says so", async () => {
    const m = fakeMachine(agentState(), { leavesAfter: null });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState()))).toBe("Not restarted: Claude did not exit");
    expect(m.elapsed()).toBeGreaterThanOrEqual(restartExitTimeoutMs);
    expect(m.elapsed()).toBeLessThan(restartExitTimeoutMs + 2_000);
    expect(m.writes).toEqual([
      ["sendText", "w1:p1", "/exit"],
      ["agentKeys", "w1:p1", ["Enter"]],
    ]);
    expect(restartTexts.didNotExit("Codex")).toBe("Not restarted: Codex did not exit");
  });
});
