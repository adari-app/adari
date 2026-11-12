// New agent on a slow shell
// and when it cannot start. A new shell still in its startup files answers
// `agent_pane_busy`: the same start to the same pane every 250 ms for 15 s,
// never a second pane, only that code; at 15 s the pane closes with a plain
// line. `agent_not_ready` (the agent at its own sign-in screen) keeps the pane.
// A shell that says it cannot find the program is named, read within its
// bounds, and nothing else in the pane counts. No raw Herdr code in any line
// (New agent, Restart). A fake Herdr with a fake clock; nothing real.

import { describe, expect, it } from "vitest";

import {
  AgentStartFailed,
  missingLookMs,
  missingProgramLine,
  newAgent,
  newAgentTexts,
  paneBusyRetryMs,
  paneBusyTimeoutMs,
  withoutCode,
  type NewAgentHerdr,
} from "../src/main/herdr/new-agent";
import { restartAgent } from "../src/main/herdr/restart";
import { APIError, type AgentInfo, type TabCreation, type TopologyPaneInfo } from "../src/main/herdr/wire";
import { restartTexts } from "../src/shared/agent-restart";
import { absentStartCommands, parseStartCommands } from "../src/shared/start-commands";
import { agentState, bindingFor, fakeMachine } from "./support/restart-machine";

const mac = { name: "Mac mini", home: async () => "/Users/fixture" };
const rawCode = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+:/;

/** A clock whose sleeps pass at once and move its time on. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

/** A fake Herdr: `starts` answers each agent.start in turn (the last one repeats), `texts` each pane.read. */
class StartHerdr implements NewAgentHerdr {
  readonly calls: string[] = [];
  starts: (APIError | Error | "ok")[] = ["ok"];
  texts: string[] = [""];
  /** What agent.list says of the new pane (absent: nothing). */
  paneAgent: AgentInfo | null = null;
  typedAgent: string | null = null;
  private typed = false;
  private started = 0;
  private reads = 0;
  readonly at: () => number;

  constructor(clock: { now(): number }) {
    this.at = () => clock.now();
  }

  agentList(): Promise<AgentInfo[]> {
    this.calls.push("agent.list");
    const typed = this.typed && this.typedAgent !== null ? [{ paneID: "w1:pn1", name: "claude", agent: this.typedAgent }] : [];
    return Promise.resolve([...(this.paneAgent === null ? [] : [this.paneAgent]), ...typed]);
  }
  createTerminalTab(workspaceID: string, label: string | null): Promise<TabCreation> {
    this.calls.push("tab.create");
    return Promise.resolve({ tab: { tabID: "w1:tn1", workspaceID, label }, rootPane: { paneID: "w1:pn1", tabID: "w1:tn1" } } as unknown as TabCreation);
  }
  splitPane(): Promise<TopologyPaneInfo> {
    this.calls.push("pane.split");
    return Promise.resolve({ paneID: "w1:ps1", tabID: "w1:t1" } as unknown as TopologyPaneInfo);
  }
  startAgent(name: string, kind: string, paneID: string): Promise<AgentInfo> {
    this.calls.push(`agent.start ${paneID} @${this.at()}`);
    const answer = this.starts[Math.min(this.started, this.starts.length - 1)]!;
    this.started += 1;
    return answer === "ok" ? Promise.resolve({ paneID, name, agent: kind }) : Promise.reject(answer);
  }
  closePane(paneID: string): Promise<void> {
    this.calls.push(`pane.close ${paneID}`);
    return Promise.resolve();
  }
  sendInput(pane: string, text: string): Promise<void> {
    this.calls.push(`pane.send_input ${pane} ${text}`);
    this.typed = true;
    return Promise.resolve();
  }
  paneText(pane: string, lines: number): Promise<string> {
    this.calls.push(`pane.read ${pane} ${lines} @${this.at()}`);
    const text = this.texts[Math.min(this.reads, this.texts.length - 1)]!;
    this.reads += 1;
    return Promise.resolve(text);
  }
  count(prefix: string): number {
    return this.calls.filter((call) => call.startsWith(prefix)).length;
  }
}

const busy = new APIError("agent_pane_busy", "agent target pane w1:pn1 is not an available shell");
const notReady = new APIError("agent_not_ready", "agent probe is blocked during startup and is not ready for prompts");
const codex = { workspaceId: "w1", folder: null, kind: "codex" } as const;
const start = (herdr: StartHerdr, clock: ReturnType<typeof fakeClock>, request: Parameters<typeof newAgent>[2] = codex, commands = absentStartCommands) =>
  newAgent(herdr, commands, request, clock, 90_000, 1_000, mac);

describe("a new shell not yet at its prompt", () => {
  it("agent_pane_busy is sent again to the same pane every 250 ms until it is taken", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.starts = [busy, busy, busy, "ok"];
    herdr.paneAgent = { paneID: "w1:pn1", agent: "codex", interactiveReady: true };
    const result = await start(herdr, clock);
    expect(herdr.calls.filter((call) => call.startsWith("agent.start"))).toEqual([
      "agent.start w1:pn1 @0",
      "agent.start w1:pn1 @250",
      "agent.start w1:pn1 @500",
      "agent.start w1:pn1 @750",
    ]);
    expect(herdr.count("tab.create")).toBe(1);
    expect(herdr.count("pane.close")).toBe(0);
    expect(result).toMatchObject({ paneId: "w1:pn1", start: { type: "herdr" }, summary: null });
  });

  it("a split's new pane the same way", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.starts = [busy, "ok"];
    await start(herdr, clock, { ...codex, where: { type: "split", direction: "down", targetPaneId: "w1:p1" } });
    expect(herdr.calls.filter((call) => call.startsWith("agent.start"))).toEqual(["agent.start w1:ps1 @0", "agent.start w1:ps1 @250"]);
    expect(herdr.count("pane.split")).toBe(1);
  });

  it("still busy at 15 s: the pane is closed and the line says why, in words", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.starts = [busy];
    const failure = (await start(herdr, clock).catch((error: unknown) => error)) as AgentStartFailed;
    expect(failure).toBeInstanceOf(AgentStartFailed);
    expect(failure.message).toBe("The new shell on Mac mini did not reach its prompt in 15 seconds, so Codex was not started.");
    expect(failure.message).not.toMatch(rawCode);
    expect(herdr.calls.at(-1)).toBe("pane.close w1:pn1");
    const tries = herdr.calls.filter((call) => call.startsWith("agent.start"));
    expect(tries).toHaveLength(paneBusyTimeoutMs / paneBusyRetryMs + 1);
    expect(tries.at(-1)).toBe(`agent.start w1:pn1 @${paneBusyTimeoutMs}`);
    expect(clock.sleeps.every((ms) => ms === paneBusyRetryMs)).toBe(true);
    expect(herdr.count("tab.create")).toBe(1);
  });

  it("only agent_pane_busy is tried again: another refusal is one try, the pane closed, Herdr's words without its code", async () => {
    for (const refusal of [new APIError("agent_start_failed", "codex is not installed"), new APIError("pane_not_found", "no such pane")]) {
      const clock = fakeClock();
      const herdr = new StartHerdr(clock);
      herdr.starts = [refusal];
      const failure = (await start(herdr, clock).catch((error: unknown) => error)) as AgentStartFailed;
      expect(herdr.count("agent.start")).toBe(1);
      expect(failure.message).toBe(newAgentTexts.refused("Codex", refusal.serverMessage));
      expect(failure.message).not.toMatch(rawCode);
      expect(herdr.calls.at(-1)).toBe("pane.close w1:pn1");
    }
  });

  it("the typed path (agents.json) is unchanged: typed once, never Herdr's start", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.typedAgent = "claude";
    const cl = parseStartCommands(new TextEncoder().encode('{"claude": "cl"}'));
    const result = await start(herdr, clock, { workspaceId: "w1", folder: null, kind: "claude" }, cl);
    expect(herdr.count("pane.send_input")).toBe(1);
    expect(herdr.count("agent.start")).toBe(0);
    expect(result.start).toEqual({ type: "typed", command: "cl" });
  });
});

describe("an agent waiting at its own screen", () => {
  it("agent_not_ready keeps the pane, which is the one shown, and says to answer it there", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.starts = [notReady];
    const result = await start(herdr, clock);
    expect(herdr.count("pane.close")).toBe(0);
    expect(herdr.count("agent.start")).toBe(1);
    expect(result).toMatchObject({ paneId: "w1:pn1", tabId: "w1:tn1", start: { type: "herdr" } });
    expect(result.summary).toBe("Codex started in its tab but is waiting there, for example to sign in. Answer it in the tab.");
  });

  it("after a busy shell too", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.starts = [busy, busy, notReady];
    const result = await start(herdr, clock);
    expect(herdr.count("pane.close")).toBe(0);
    expect(result.summary).toBe(newAgentTexts.waiting("Codex"));
  });

  it("Restart: keys refused with agent_not_ready leave the pane and say so in words; another refusal in Herdr's words", async () => {
    const m = fakeMachine(agentState());
    m.site.writer.sendText = async () => {
      throw new APIError("agent_not_ready", "agent probe is blocked during startup and is not ready for prompts");
    };
    const note = await restartAgent(m.site, "w1:p1", bindingFor(agentState()));
    expect(note).toBe(restartTexts.notReady("Claude"));
    expect(note).toBe("Not restarted: Claude is not ready for keys. If it is waiting in its tab, for example to sign in, answer it there.");
    expect(m.writes.some((write) => String(write[0]).includes("close"))).toBe(false);
    const other = fakeMachine(agentState());
    other.site.writer.agentKeys = async () => {
      throw new APIError("agent_input_pending", "the agent has a dialog open");
    };
    const words = await restartAgent(other.site, "w1:p1", bindingFor(agentState()));
    expect(words).toBe("Not restarted: Herdr refused the keys: the agent has a dialog open");
    expect(words).not.toMatch(rawCode);
  });
});

describe("a program the machine does not have", () => {
  it("each shell's line is found for the program", () => {
    expect(missingProgramLine("you@mac app % claude\nzsh: command not found: claude\nyou@mac app % ", "claude")).toBe("zsh: command not found: claude");
    expect(missingProgramLine("$ claude\nbash: claude: command not found\n$ ", "claude")).toBe("bash: claude: command not found");
    expect(missingProgramLine("-bash: codex: command not found", "codex")).toBe("-bash: codex: command not found");
    expect(missingProgramLine("bash: line 1: codex: command not found", "codex")).toBe("bash: line 1: codex: command not found");
    expect(missingProgramLine("fish: Unknown command: codex", "codex")).toBe("fish: Unknown command: codex");
    expect(missingProgramLine("fish: Unknown command: 'codex'", "codex")).toBe("fish: Unknown command: 'codex'");
    expect(missingProgramLine("sh: 1: grok: not found", "grok")).toBe("sh: 1: grok: not found");
    expect(missingProgramLine("sh: grok: not found", "grok")).toBe("sh: grok: not found");
    expect(missingProgramLine("/bin/zsh: command not found: cl", "cl")).toBe("/bin/zsh: command not found: cl");
  });

  it("ordinary output is never read as one: a file named not found, the program's own words, another program", () => {
    for (const text of [
      "ls: not found: No such file or directory",
      "cat: 'not found': No such file or directory",
      "$ touch 'claude: command not found'\n$ ls\nclaude: command not found",
      "Error: command not found: claude-helper",
      "claude says: zsh: command not found: claude (an example)",
      "zsh: command not found: claude-code",
      "zsh: command not found: codex",
      "  ▐▛███▜▌ Claude Code\n  Welcome back!",
    ]) {
      expect(missingProgramLine(text, "claude")).toBeNull();
    }
    expect(missingProgramLine("zsh: command not found: claude", "")).toBeNull();
  });

  it("after Herdr's start: the pane's shell line names it, the tab is left open", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.texts = ["you@mac ~ % ", "you@mac ~ % claude\nzsh: command not found: claude\nyou@mac ~ % "];
    const result = await start(herdr, clock, { workspaceId: "w1", folder: null, kind: "claude" });
    expect(result.summary).toBe("Claude Code is not installed on Mac mini: its shell says “zsh: command not found: claude”.");
    expect(result.summary).not.toMatch(rawCode);
    expect(herdr.count("pane.close")).toBe(0);
    expect(herdr.calls.filter((call) => call.startsWith("pane.read"))[0]).toMatch(/^pane\.read w1:pn1 20 /);
  });

  it("after Herdr's start, the read stops by 3 s, and at once once the agent answers", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.texts = ["you@mac ~ % codex\n"];
    const result = await start(herdr, clock);
    expect(result.summary).toBeNull();
    const reads = herdr.calls.filter((call) => call.startsWith("pane.read"));
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every((call) => Number(call.split("@")[1]) <= missingLookMs)).toBe(true);
    expect(clock.now()).toBeLessThanOrEqual(missingLookMs);

    const quick = fakeClock();
    const running = new StartHerdr(quick);
    running.paneAgent = { paneID: "w1:pn1", agent: "codex", agentStatus: "idle", interactiveReady: true };
    await start(running, quick);
    expect(running.count("pane.read")).toBe(1);
    expect(quick.now()).toBe(0);
  });

  it("a pane that cannot be read (no pane.read there): no look, no wait", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.paneText = () => Promise.reject(new APIError("unknown_method", "pane.read"));
    const result = await start(herdr, clock);
    expect(result.summary).toBeNull();
    expect(clock.now()).toBe(0);
    expect(herdr.count("agent.list")).toBe(1);
  });

  it("the typed path: every look of its wait reads the pane, and the program's line ends it", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.texts = ["you@mac ~ % ", "you@mac ~ % cl --fast\nbash: cl: command not found"];
    const cl = parseStartCommands(new TextEncoder().encode('{"claude": "cl --fast"}'));
    const result = await start(herdr, clock, { workspaceId: "w1", folder: null, kind: "claude" }, cl);
    expect(result).toMatchObject({ start: { type: "noAgent", command: "cl --fast" }, summary: "Claude Code is not installed on Mac mini: its shell says “bash: cl: command not found”." });
    expect(herdr.count("pane.read")).toBe(2);
    expect(herdr.count("pane.close")).toBe(0);
    expect(herdr.count("pane.send_input")).toBe(1);
  });

  it("the typed path's wait is still bounded at 90 s when the pane says nothing of the kind", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.texts = ["you@mac ~ % cl\nloading…"];
    const cl = parseStartCommands(new TextEncoder().encode('{"claude": "cl"}'));
    const result = await start(herdr, clock, { workspaceId: "w1", folder: null, kind: "claude" }, cl);
    expect(result.start.type).toBe("noAgent");
    expect(result.summary).toBe("No Claude Code agent appeared after typing “cl”. The pane is left open.");
    expect(clock.now()).toBe(90_000);
  });
});

describe("no raw Herdr code", () => {
  it("withoutCode takes off any snake_case code in front", () => {
    expect(withoutCode("agent_pane_busy: agent target pane w1:p3 is not an available shell")).toBe("agent target pane w1:p3 is not an available shell");
    expect(withoutCode("agent_not_ready: agent_probe_x: not ready")).toBe("not ready");
    expect(withoutCode("plain words: kept")).toBe("plain words: kept");
    expect(withoutCode("")).toBe("it did not say why");
  });

  it("a refused new tab, typing refused, and every sentence read without a code", async () => {
    const clock = fakeClock();
    const herdr = new StartHerdr(clock);
    herdr.createTerminalTab = () => Promise.reject(new APIError("workspace_not_found", "no such workspace"));
    await expect(start(herdr, clock)).rejects.toThrow("Herdr did not make the new tab: no such workspace");
    const typing = new StartHerdr(fakeClock());
    typing.sendInput = () => Promise.reject(new APIError("pane_not_found", "gone"));
    const cl = parseStartCommands(new TextEncoder().encode('{"claude": "cl"}'));
    const failure = (await start(typing, fakeClock(), { workspaceId: "w1", folder: null, kind: "claude" }, cl).catch((error: unknown) => error)) as Error;
    expect(failure.message).toBe("typing “cl” was refused: gone");
    for (const line of [
      newAgentTexts.busy("Mac mini", "Codex"),
      newAgentTexts.waiting("Codex"),
      newAgentTexts.notInstalled("Codex", "Mac mini", "zsh: command not found: codex"),
      newAgentTexts.refused("Codex", "x"),
      restartTexts.notReady("Codex"),
      restartTexts.refused("x"),
    ]) {
      expect(line).not.toMatch(rawCode);
      expect(line).not.toContain("—");
    }
  });
});
