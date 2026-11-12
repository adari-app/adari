// One deadline per phase
// of a New agent, checked before every request and after every await and
// every sleep's wake. The busy retry (15 s), the look after Herdr's start
// (3 s) and the typed command's wait (90 s) each keep the deadline they began
// with; a read waits at most the time left (the live clock's alarm) and a
// reply that comes after the deadline is not used. A start sent whose answer
// did not come keeps its pane: it may still be coming up. Each phase has a
// slow-reply and a late-wake case.
// Fake Herdr only; the clock is a fake one, or the live clock on vitest's fake
// timers.

import { afterEach, describe, expect, it, vi } from "vitest";

import { RequestTimedOutError } from "../src/main/herdr/errors";
import {
  liveClock,
  missingLookMs,
  newAgent,
  newAgentTexts,
  paneBusyTimeoutMs,
  type NewAgentClock,
  type NewAgentHerdr,
} from "../src/main/herdr/new-agent";
import { APIError, type AgentInfo, type TabCreation, type TopologyPaneInfo } from "../src/main/herdr/wire";
import { absentStartCommands, parseStartCommands } from "../src/shared/start-commands";

const mac = { name: "Mac mini" };
const codex = { workspaceId: "w1", folder: null, kind: "codex" };
const typed = parseStartCommands(new TextEncoder().encode('{"codex":"cx"}'));
const busy = () => new APIError("agent_pane_busy", "not at its prompt");

/** A clock a test moves: sleeps pass at once and move it by `ms` plus `late` (a wake that comes late). */
function testClock(late = 0) {
  let time = 0;
  const clock = {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    sleep: (ms: number) => {
      time += Math.max(0, ms) + late;
      return Promise.resolve();
    },
  };
  return clock;
}

/** A fake Herdr recording each request with the time it was sent; each answer can move the clock (a slow reply). */
class TimedHerdr implements NewAgentHerdr {
  readonly calls: { method: string; at: number }[] = [];
  starts: () => Promise<AgentInfo> = () => Promise.resolve({ paneID: "w1:pn1", name: "codex", agent: "codex" });
  lists: () => Promise<AgentInfo[]> = () => Promise.resolve([]);
  texts: () => Promise<string> = () => Promise.resolve("");

  constructor(private readonly clock: { now(): number }) {}

  private record(method: string): void {
    this.calls.push({ method, at: this.clock.now() });
  }
  agentList(): Promise<AgentInfo[]> {
    this.record("agent.list");
    return this.lists();
  }
  createTerminalTab(workspaceID: string, label: string | null): Promise<TabCreation> {
    this.record("tab.create");
    return Promise.resolve({ tab: { tabID: "w1:tn1", workspaceID, label }, rootPane: { paneID: "w1:pn1", tabID: "w1:tn1" } } as unknown as TabCreation);
  }
  splitPane(): Promise<TopologyPaneInfo> {
    this.record("pane.split");
    return Promise.resolve({ paneID: "w1:ps1", tabID: "w1:t1" } as unknown as TopologyPaneInfo);
  }
  startAgent(): Promise<AgentInfo> {
    this.record("agent.start");
    return this.starts();
  }
  closePane(): Promise<void> {
    this.record("pane.close");
    return Promise.resolve();
  }
  sendInput(): Promise<void> {
    this.record("pane.send_input");
    return Promise.resolve();
  }
  paneText(): Promise<string> {
    this.record("pane.read");
    return this.texts();
  }

  times(method: string): number[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.at);
  }
}

const run = (herdr: NewAgentHerdr, clock: NewAgentClock, commands = absentStartCommands) => newAgent(herdr, commands, codex, clock, 90_000, 1_000, mac);

// MARK: - The busy retry's 15 s

describe("the busy retry keeps one 15 s deadline", () => {
  it("a late wake sends no start after 15 s; the pane is closed with the sentence", async () => {
    const clock = testClock(20_000);
    const herdr = new TimedHerdr(clock);
    herdr.starts = () => Promise.reject(busy());
    await expect(run(herdr, clock)).rejects.toThrow(newAgentTexts.busy("Mac mini", "Codex"));
    expect(herdr.times("agent.start")).toEqual([0]);
    expect(herdr.calls.at(-1)?.method).toBe("pane.close");
  });

  it("a slow busy answer that crosses 15 s: no other start, the pane closed", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    let tries = 0;
    herdr.starts = () => {
      tries += 1;
      if (tries === 3) clock.advance(16_000);
      return Promise.reject(busy());
    };
    await expect(run(herdr, clock)).rejects.toThrow(newAgentTexts.busy("Mac mini", "Codex"));
    expect(herdr.times("agent.start")).toEqual([0, 250, 500]);
    expect(herdr.calls.at(-1)?.method).toBe("pane.close");
  });

  it("every start is sent by 15 s and the last at 15 s exactly, on time", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    herdr.starts = () => Promise.reject(busy());
    await expect(run(herdr, clock)).rejects.toThrow("15 seconds");
    const times = herdr.times("agent.start");
    expect(times).toHaveLength(61);
    expect(times.at(-1)).toBe(paneBusyTimeoutMs);
    expect(times.every((at) => at <= paneBusyTimeoutMs)).toBe(true);
  });

  it("a start whose answer did not come (it may have reached Herdr): the pane stays, the line says it may still be coming up", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    let tries = 0;
    herdr.starts = () => {
      tries += 1;
      return Promise.reject(tries === 1 ? busy() : new RequestTimedOutError(10, true));
    };
    const made = await run(herdr, clock);
    expect(made.start).toEqual({ type: "herdr" });
    expect(made.summary).toBe(newAgentTexts.unsure("Codex", "Mac mini", "tab"));
    expect(herdr.calls.map((call) => call.method)).not.toContain("pane.close");
    expect(herdr.calls.map((call) => call.method)).not.toContain("pane.read");
    expect(herdr.times("agent.start")).toHaveLength(2);
  });

  it("a start proved unsent (it never left the app) is closed as before", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    herdr.starts = () => Promise.reject(new RequestTimedOutError(10, false));
    await expect(run(herdr, clock)).rejects.toThrow("the host did not answer within 10 seconds");
    expect(herdr.calls.at(-1)?.method).toBe("pane.close");
  });

  it("a start taken after 15 s is a start: the agent's tab, nothing closed", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    herdr.starts = () => {
      clock.advance(17_000);
      return Promise.resolve({ paneID: "w1:pn1", name: "codex", agent: "codex", interactiveReady: true });
    };
    const made = await run(herdr, clock);
    expect(made.start).toEqual({ type: "herdr" });
    expect(herdr.calls.map((call) => call.method)).not.toContain("pane.close");
  });
});

// MARK: - The look after Herdr's start: 3 s

describe("the look after Herdr's start keeps one 3 s deadline", () => {
  it("a slow agent.list crossing 3 s: no pane.read after it", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    let lists = 0;
    herdr.lists = () => {
      lists += 1;
      if (lists > 1) clock.advance(4_000);
      return Promise.resolve([]);
    };
    await run(herdr, clock);
    expect(herdr.times("pane.read").every((at) => at <= missingLookMs)).toBe(true);
    expect(herdr.calls.filter((call) => call.at > missingLookMs)).toEqual([]);
  });

  it("a late wake: no read after 3 s", async () => {
    const clock = testClock(4_000);
    const herdr = new TimedHerdr(clock);
    const made = await run(herdr, clock);
    expect(made.summary).toBeNull();
    expect(herdr.times("pane.read")).toEqual([0]);
    expect(herdr.calls.filter((call) => call.at > missingLookMs)).toEqual([]);
  });

  it("a slow pane.read whose text comes after 3 s is not used", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    herdr.texts = () => {
      clock.advance(8_000);
      return Promise.resolve("zsh: command not found: codex");
    };
    const made = await run(herdr, clock);
    expect(made.summary).toBeNull();
    expect(herdr.times("pane.read")).toEqual([0]);
    expect(herdr.calls.filter((call) => call.method === "agent.list" && call.at > 0)).toEqual([]);
  });

  it("a slow agent.list reply after 3 s is not used either: its ready agent does not count, no read follows", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    let lists = 0;
    herdr.lists = () => {
      lists += 1;
      if (lists === 2) clock.advance(3_500);
      return Promise.resolve([]);
    };
    await run(herdr, clock);
    expect(herdr.calls.filter((call) => call.at > missingLookMs)).toEqual([]);
  });

  it("on time, the look still reads every 500 ms up to 3 s and finds the shell's line", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    let reads = 0;
    herdr.texts = () => Promise.resolve(++reads === 7 ? "zsh: command not found: codex" : "");
    const made = await run(herdr, clock);
    expect(herdr.times("pane.read")).toEqual([0, 500, 1_000, 1_500, 2_000, 2_500, 3_000]);
    expect(made.summary).toBe(newAgentTexts.notInstalled("Codex", "Mac mini", "zsh: command not found: codex"));
  });
});

// MARK: - The typed command's wait: 90 s

describe("the typed command's wait keeps one 90 s deadline", () => {
  it("agent.list replies of 9 s each: no pane.read after 90 s", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    let lists = 0;
    herdr.lists = () => {
      lists += 1;
      if (lists > 1) clock.advance(9_000);
      return Promise.resolve([]);
    };
    const made = await run(herdr, clock, typed);
    expect(herdr.times("pane.read").every((at) => at <= 90_000)).toBe(true);
    expect(herdr.calls.filter((call) => call.at > 90_000)).toEqual([]);
    expect(made.start).toEqual({ type: "noAgent", command: "cx" });
    expect(made.summary).toBe("No Codex agent appeared after typing “cx”. The pane is left open.");
  });

  it("a late wake: no look after 90 s", async () => {
    const clock = testClock(50_000);
    const herdr = new TimedHerdr(clock);
    const made = await run(herdr, clock, typed);
    expect(herdr.calls.filter((call) => call.at > 90_000)).toEqual([]);
    expect(herdr.times("agent.list")).toEqual([0, 0, 51_000]);
    expect(made.start).toEqual({ type: "noAgent", command: "cx" });
  });

  it("a shell's line read after 90 s is not used", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    let reads = 0;
    herdr.texts = () => {
      reads += 1;
      if (reads === 90) clock.advance(5_000);
      return Promise.resolve(reads === 90 ? "zsh: command not found: cx" : "");
    };
    const made = await run(herdr, clock, typed);
    expect(made.summary).toBe("No Codex agent appeared after typing “cx”. The pane is left open.");
    expect(herdr.calls.filter((call) => call.at > 90_000)).toEqual([]);
  });

  it("an agent.list reply after 90 s naming the agent is not used", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    let lists = 0;
    herdr.lists = () => {
      lists += 1;
      if (lists === 91) {
        clock.advance(2_000);
        return Promise.resolve([{ paneID: "w1:pn1", name: "codex", agent: "codex" }]);
      }
      return Promise.resolve([]);
    };
    const made = await run(herdr, clock, typed);
    expect(made.start).toEqual({ type: "noAgent", command: "cx" });
  });

  it("on time: the wait looks once a second up to 90 s", async () => {
    const clock = testClock();
    const herdr = new TimedHerdr(clock);
    await run(herdr, clock, typed);
    const looks = herdr.times("agent.list").slice(1);
    expect(looks).toHaveLength(91);
    expect(looks.at(-1)).toBe(90_000);
  });
});

// MARK: - The live clock's alarm: a read never waits past the time left

describe("on the live clock, a reply that does not come ends the wait at the deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** newAgent on the live clock over vitest's fake timers: when it settled, from its start. */
  async function timedRun(herdr: NewAgentHerdr, commands = absentStartCommands) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const began = Date.now();
    let settled: number | null = null;
    const result = newAgent(herdr, commands, codex, liveClock, 90_000, 1_000, mac).finally(() => {
      settled = Date.now() - began;
    });
    for (let i = 0; i < 400 && settled === null; i += 1) await vi.advanceTimersByTimeAsync(250);
    return { result: await result, settled: settled as number | null };
  }

  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

  it("a pane.read that never answers ends the 3 s look at 3 s", async () => {
    const herdr = new TimedHerdr({ now: () => Date.now() });
    herdr.texts = never;
    const { result, settled } = await timedRun(herdr);
    expect(result.summary).toBeNull();
    expect(settled).toBe(missingLookMs);
  });

  it("an agent.list that never answers ends the 3 s look at 3 s", async () => {
    const herdr = new TimedHerdr({ now: () => Date.now() });
    let lists = 0;
    herdr.lists = () => (++lists === 1 ? Promise.resolve([]) : never());
    const { settled } = await timedRun(herdr);
    expect(settled).toBe(missingLookMs);
  });

  it("a pane.read answering at 8 s with the shell's line: not used, the look ended at 3 s", async () => {
    const herdr = new TimedHerdr({ now: () => Date.now() });
    herdr.texts = () => new Promise((resolve) => setTimeout(() => resolve("zsh: command not found: codex"), 8_000));
    const { result, settled } = await timedRun(herdr);
    expect(result.summary).toBeNull();
    expect(settled).toBe(missingLookMs);
  });

  it("an agent.list that never answers ends the typed wait at 90 s", async () => {
    const herdr = new TimedHerdr({ now: () => Date.now() });
    let lists = 0;
    herdr.lists = () => (++lists <= 2 ? Promise.resolve([]) : never());
    const { result, settled } = await timedRun(herdr, typed);
    expect(result.start).toEqual({ type: "noAgent", command: "cx" });
    expect(settled).toBe(90_000);
  });

  it("the live clock's alarm rings after its time and can be stopped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let rang = false;
    const alarm = liveClock.alarm!(1_000);
    void alarm.rang.then(() => (rang = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(rang).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(rang).toBe(true);
    const stopped = liveClock.alarm!(1_000);
    let stoppedRang = false;
    void stopped.rang.then(() => (stoppedRang = true));
    stopped.cancel();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stoppedRang).toBe(false);
  });
});

describe("the new lines", () => {
  it("have no dash of any kind and no raw code", () => {
    const why = "Mac mini reconnected since New agent began.";
    const texts = [
      newAgentTexts.nothingMade(why),
      newAgentTexts.notStarted(why, "Codex", "tab"),
      newAgentTexts.notTyped(why, "cx", "pane"),
      newAgentTexts.leftOpen("Herdr did not start Codex: refused", why, "tab"),
      newAgentTexts.lookStopped(why, "tab"),
      newAgentTexts.waitStopped(why, "Codex", "cx"),
      newAgentTexts.unsure("Codex", "Mac mini", "tab"),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/[\u2014\u2013]/);
      expect(text).not.toMatch(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+:/);
    }
    expect(newAgentTexts.leftOpen("Herdr did not start Codex: refused", why, "tab")).toBe(
      "Herdr did not start Codex: refused. Mac mini reconnected since New agent began. Its tab was left open.",
    );
  });
});
