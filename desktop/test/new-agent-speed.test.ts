// The Mac: New agent shows its pane at once, names a step before it, reads the
// Model and Effort check and the start commands together, and keeps each start's timings. Through the real
// registerIpc door (Electron's ipcMain faked) over a fake Herdr (new-agent-world.ts) on a fake clock, with the real
// HerdrClient, HostRegistry, IntegrationService and LayoutService. What goes on the wire is compared with what
// 34da24eb sent for the same runs (new-agent-34da24eb.json, recorded there with new-agent-scenarios.ts).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, run: (...args: unknown[]) => unknown) => registered.handles.set(channel, run), on: () => undefined },
  protocol: {},
}));

const { registerIpc } = await import("../src/main/ipc");
const { IPC } = await import("../src/shared/ipc-contract");
const { newAgentWorld, flush, requestCost, commandsCost } = await import("./support/new-agent-world");
const { scenarios } = await import("./support/new-agent-scenarios");
const { speedLine, speedSections, speedLimit, SpeedLog } = await import("../src/shared/speed-record");
const { feedbackIssueUrl } = await import("../src/shared/feedback");
const { speedLogs, feedbackRepo } = await import("../src/main/feedback");
const { isStartId, newAgentProgressTexts, withMadePanes, madePaneKeptMs } = await import("../src/shared/new-agent");
const { TerminalSessions } = await import("../src/main/terminals");
const { HostRegistry } = await import("../src/main/hosts");

type Recorded = Record<string, { readonly log: readonly string[]; readonly result: unknown }>;
const main: Recorded = JSON.parse(readFileSync(path.join(import.meta.dirname, "support", "new-agent-34da24eb.json"), "utf8"));

type SpeedRecord = import("../src/shared/speed-record").SpeedRecord;

/** A later turn: a record is kept after the answer it times (speed-record.ts keepLater). */
const turn = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/**
 * A world with its door registered, New agent's records kept, and a start that gives a start id. Its page puts a made
 * pane on screen at once (newAgentShown as the pane is told; `shows: false`, never); its start settles after the
 * record is kept.
 */
async function world(options: Parameters<typeof newAgentWorld>[3] = {}, more: Record<string, unknown> = {}, shows = true) {
  const w = await newAgentWorld(registerIpc as never, registered.handles, IPC.newAgentProgress, options);
  const records: SpeedRecord[] = [];
  w.register({ speed: { record: (record: SpeedRecord) => records.push(record) }, ...more });
  const send = w.page.send.bind(w.page);
  w.page.send = (channel, payload) => {
    send(channel, payload);
    const said = payload as unknown as Record<string, unknown>;
    if (shows && channel === IPC.newAgentProgress && said["type"] === "pane") void registered.handles.get(IPC.newAgentShown)!(w.event, said["startId"], said["paneId"]);
  };
  let n = 0;
  const start = (request: Record<string, unknown>): Promise<unknown> => {
    n += 1;
    const answer = registered.handles.get(IPC.newAgent)!(w.event, "mini", request, `start-000${n}`) as Promise<unknown>;
    return answer.then(
      async (value) => {
        await turn();
        return value;
      },
      async (error: unknown) => {
        await turn();
        throw error;
      },
    );
  };
  return { ...w, records, start };
}

const tab = (kind: string, more: Record<string, unknown> = {}) => ({ workspaceId: "w1", folder: "/fixture", kind, ...more });
const at = (log: readonly string[], method: string): number => log.findIndex((line) => line.startsWith(`${method} `));
type Seen = import("./support/new-agent-world").ProgressSeen;
const panes = (w: { progress: readonly Seen[] }): Seen[] => w.progress.filter((said) => said.payload["type"] === "pane");
const steps = (w: { progress: readonly { payload: Record<string, unknown> }[] }) => w.progress.filter((said) => said.payload["type"] === "step").map((said) => said.payload["words"]);

describe("what goes to the machine is what 34da24eb sent", () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))("%s", async (name, scenario) => {
    const w = await world(scenario.options);
    const result = await scenario.run(w, w.start);
    const recorded = main[name]!;
    expect(result).toEqual(recorded.result);
    // Every run, the typed start with its integration out of date too, byte for byte 34da24eb's.
    expect(w.log).toEqual(recorded.log);
  });

  it("a typed start's integration step comes before its tab, as on 34da24eb: no shell exists to type into while it runs", async () => {
    const w = await world({ integrations: { claude: "outdated" }, agentsJson: { claude: "cl" }, install: "hold" });
    const run = w.start(tab("claude"));
    await flush();
    // The update is out and nothing is made: no pane told, no tab asked for, the line names the step.
    expect(w.log).toEqual(["(read agents.json)", 'integration.install {"target":"claude"}']);
    expect(panes(w)).toEqual([]);
    expect(steps(w).at(-1)).toBe("Updating Herdr's Claude Code integration on Mac mini…");
    w.release();
    await run;
    expect(w.log).toEqual(main["a typed start, integration outdated"]!.log);
    expect(at(w.log, "integration.install")).toBeLessThan(at(w.log, "tab.create"));
    expect(panes(w)[0]!.logIndex).toBe(at(w.log, "tab.create") + 1);
  });

  it("the oracle holds every run New agent is asked for here", () => {
    expect(Object.keys(main).sort()).toEqual(scenarios.map((scenario) => scenario.name).sort());
  });
});

describe("the pane shows as soon as it exists", () => {
  it("Herdr's own start: the pane's answer comes right after tab.create, before agent.start, the wait and the refresh", async () => {
    const w = await world({ integrations: { claude: "current" } });
    const base = w.now();
    await w.start(tab("claude"));
    const pane = panes(w);
    expect(pane).toHaveLength(1);
    expect(pane[0]!.payload).toMatchObject({ type: "pane", paneId: "w1:pn1", tabId: "w1:tn1", startId: "start-0001" });
    // By the fake's call order: the pane was told once tab.create answered and nothing after it had gone.
    // (logIndex: how many requests had gone when it was told.)
    expect(pane[0]!.logIndex).toBe(at(w.log, "tab.create") + 1);
    expect(pane[0]!.logIndex).toBeLessThanOrEqual(at(w.log, "agent.start"));
    expect(pane[0]!.logIndex).toBeLessThanOrEqual(w.log.indexOf("session.snapshot {}"));
    // By the clock: the agents.json read, the name's agent.list and tab.create, nothing more.
    expect(pane[0]!.at - base).toBe(commandsCost + requestCost["agent.list"]! + requestCost["tab.create"]!);
  });

  it("before the agent is reported: a typed start whose agent comes on the third look", async () => {
    const w = await world({ integrations: { claude: "current" }, agentsJson: { claude: "cl" }, typedAfterLooks: 2 });
    const result = (await w.start(tab("claude")).then((answer) => {
      w.log.push("(answered)");
      return answer;
    })) as { start: { type: string } };
    expect(result.start.type).toBe("typed");
    // The pane was told before the command was typed, before any of the wait's looks, and before the answer.
    const pane = panes(w)[0]!;
    const looks = w.log.flatMap((line, index) => (line === "agent.list {}" ? [index] : []));
    expect(looks).toHaveLength(4);
    expect(pane.logIndex).toBeLessThanOrEqual(at(w.log, "pane.send_input"));
    expect(pane.logIndex).toBeLessThanOrEqual(looks[1]!);
    expect(pane.logIndex).toBeLessThan(w.log.indexOf("(answered)"));
    expect(pane.at).toBeLessThan(w.now() - 2_000);
  });

  it("a split: its pane shows once pane.split answered, before agent.start and the layouts' reread", async () => {
    const w = await world({ integrations: { claude: "current" } });
    await w.start({ ...tab("claude"), where: { type: "split", direction: "right", targetPaneId: "w1:p1", binding: w.bind("w1:p1") } });
    const pane = panes(w)[0]!;
    expect(pane.payload["paneId"]).toMatch(/^w1:new/);
    expect(pane.logIndex).toBe(at(w.log, "pane.split") + 1);
    expect(pane.logIndex).toBeLessThanOrEqual(at(w.log, "agent.start"));
    expect(pane.logIndex).toBeLessThan(w.log.indexOf("(reread mini)"));
  });

  it("a start Herdr refuses after the pane was shown: the pane is closed and the answer says today's words", async () => {
    const w = await world({ integrations: { claude: "current" }, refuseStart: "launch_failed" });
    await expect(w.start(tab("claude"))).rejects.toThrow("Herdr did not start Claude Code: the pane is gone");
    expect(panes(w)).toHaveLength(1);
    expect(w.log).toContain('pane.close {"pane_id":"w1:pn1"}');
    expect(w.records[0]!.outcome).toBe("closed");
  });

  it("a refused Model and Effort check makes no pane, and says why as before", async () => {
    const catalogs = { settled: async () => ({ agent: "claude", models: [model("claude-opus-4-6")], readAt: 0, error: null, loading: false, none: null }) };
    const w = await world({ integrations: { claude: "current" } }, { modelCatalogs: catalogs });
    await expect(w.start(tab("claude", { model: "claude-made-up-9" }))).rejects.toThrow("Nothing was made.");
    expect(panes(w)).toEqual([]);
    expect(w.log.filter((line) => !line.startsWith("(read"))).toEqual([]);
    expect(w.records[0]!.outcome).toBe("refused");
  });

  it("a page that gives no start id hears nothing and gets the answer as before; a bad id is a bad request", async () => {
    const w = await world({ integrations: { claude: "current" } });
    await registered.handles.get(IPC.newAgent)!(w.event, "mini", tab("claude"));
    expect(w.progress).toEqual([]);
    await expect(Promise.resolve().then(() => registered.handles.get(IPC.newAgent)!(w.event, "mini", tab("claude"), "x y"))).rejects.toThrow("bad request");
    await expect(Promise.resolve().then(() => registered.handles.get(IPC.newAgent)!(w.event, "mini", tab("claude"), "start-0001", "more"))).rejects.toThrow("bad request");
    expect(isStartId("2b1c7a8e-0f4e-4a7c-9a51-2f0e3c1d9b77")).toBe(true);
    expect(isStartId("short")).toBe(false);
  });
});

const model = (id: string) => ({ id, label: id, group: null, efforts: [], defaultEffort: null, isDefault: false });

describe("a step before the pane says what it is doing", () => {
  it("a stalled integration step in front of Herdr's own start: the dialog's line names it while it runs", async () => {
    const w = await world({ integrations: { codex: "not_installed" }, install: "hold" });
    const run = w.start(tab("codex"));
    await flush();
    // The install is out, the pane not made: the line names the step on the machine.
    expect(steps(w)).toEqual([newAgentProgressTexts.commands("Mac mini"), null, "Installing Herdr's Codex integration on Mac mini…"]);
    expect(panes(w)).toEqual([]);
    w.rings[0]!();
    await run;
    expect(steps(w).at(-1)).toBeNull();
    expect(panes(w)).toHaveLength(1);
    w.release();
    await flush();
    expect(w.records[0]!.steps.find((step) => step.name === "integration")?.word).toBe("stalled");
  });

  it("an outdated one: Updating …", async () => {
    const w = await world({ integrations: { claude: "outdated" } });
    await w.start(tab("claude"));
    expect(steps(w)).toContain(newAgentProgressTexts.integration("update", "Claude Code", "Mac mini"));
    expect(newAgentProgressTexts.integration("update", "Claude Code", "Mac mini")).toBe("Updating Herdr's Claude Code integration on Mac mini…");
    expect(w.records[0]!.steps.find((step) => step.name === "integration")?.word).toBe("update");
  });

  it("a second New agent while the first's install runs waits on it, and says so as an update or install", async () => {
    const w = await world({ integrations: { codex: "not_installed" }, install: "hold" });
    const first = w.start(tab("codex"));
    const second = w.start(tab("codex"));
    await flush();
    expect(w.log.filter((line) => line.startsWith("integration.install"))).toHaveLength(1);
    w.release();
    await Promise.all([first, second]);
    const words = w.records.map((record) => record.steps.find((step) => step.name === "integration")?.word).sort();
    expect(words).toEqual(["install", "waited"]);
  });

  it("the Model and Effort check names the model list, and runs beside the start commands' read", async () => {
    let reading = false;
    const catalogs = {
      settled: async () => {
        reading = true;
        // The list's read takes 300 ms on the clock; the start commands' read goes meanwhile.
        await flush();
        w.advance(300);
        return { agent: "claude", models: [model("claude-opus-4-6")], readAt: 0, error: null, loading: false, none: null };
      },
    };
    const w = await world({ integrations: { claude: "current" } }, { modelCatalogs: catalogs });
    await w.start(tab("claude", { model: "claude-opus-4-6" }));
    expect(reading).toBe(true);
    expect(steps(w)[0]).toBe("Checking the model list on Mac mini…");
    const record = w.records[0]!;
    const ms = (name: string) => record.steps.find((step) => step.name === name)?.ms;
    expect(ms("flags")).toBe(300 + commandsCost);
    expect(ms("commands")).toBe(commandsCost);
    // Together: the pane came after the longer of the two, not their sum.
    expect(record.shownMs).toBe(300 + commandsCost + requestCost["agent.list"]! + requestCost["tab.create"]!);
    expect(w.log[0]).toBe("(read agents.json)");
    expect(w.log).toContain('agent.start {"name":"claude","kind":"claude","pane_id":"w1:pn1","args":["--model","claude-opus-4-6"]}');
  });
});

describe("each New agent's record", () => {
  it("Herdr's own start: every step in whole milliseconds from the fake clock, numbers and fixed words only", async () => {
    const w = await world({ integrations: { claude: "current" } });
    await w.start(tab("claude"));
    const record = w.records[0]!;
    expect(record.what).toBe("start");
    expect(record.kind).toBe("claude");
    expect(record.steps).toEqual([
      { name: "flags", ms: 0 },
      { name: "commands", ms: commandsCost },
      { name: "integration", ms: 0, word: "none" },
      { name: "list", ms: requestCost["agent.list"] },
      { name: "pane", ms: requestCost["tab.create"] },
      { name: "start", ms: requestCost["agent.start"] },
      { name: "wait", ms: requestCost["pane.read"]! + requestCost["agent.list"]! },
      { name: "refresh", ms: requestCost["session.snapshot"] },
    ]);
    expect(record.shownMs).toBe(commandsCost + 20 + 30);
    expect(record.totalMs).toBe(commandsCost + 20 + 30 + 40 + 30 + 25);
    expect(record.outcome).toBe("started");
    expect(speedLine(record)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ start claude: flags 0, commands 12, integration none 0, list 20, pane 30, start 40, wait 30, refresh 25, shown 62, total 157; started$/);
  });

  it("a typed start: the integration step before the name's list and the tab, the wait's looks and sleeps counted", async () => {
    const w = await world({ integrations: { claude: "outdated" }, agentsJson: { claude: "cl" }, typedAfterLooks: 2 });
    await w.start(tab("claude"));
    const record = w.records[0]!;
    expect(record.steps.map((step) => step.name)).toEqual(["flags", "commands", "integration", "list", "pane", "start", "wait", "refresh"]);
    expect(record.steps.find((step) => step.name === "integration")).toEqual({ name: "integration", ms: 550, word: "update" });
    // Three looks (each an agent.list, the two that found nothing also the pane's text) and two one-second sleeps.
    expect(record.steps.find((step) => step.name === "wait")?.ms).toBe(3 * 20 + 2 * 10 + 2 * 1_000);
    expect(record.outcome).toBe("started");
  });

  it("outcomes: a shell, no agent after the typed command, the program not installed", async () => {
    const shell = await world({ integrations: {} });
    await shell.start(tab("shell"));
    expect(shell.records[0]!.outcome).toBe("shell");
    expect(shell.records[0]!.kind).toBe("shell");
    const none = await world({ integrations: { claude: "current" }, agentsJson: { claude: "cl" }, typedNeverStarts: true, paneText: "zsh: command not found: cl" });
    await none.start(tab("claude"));
    expect(none.records[0]!.outcome).toBe("noAgent");
    const missing = await world({ integrations: { claude: "current" }, paneText: "zsh: command not found: claude" });
    await missing.start(tab("claude"));
    expect(missing.records[0]!.outcome).toBe("noAgent");
  });

  it("a kind named only in agents.json is kept as other, never its own spelling", async () => {
    const w = await world({ integrations: {}, agentsJson: { "my-secret-tool": "mytool" } });
    await w.start(tab("my-secret-tool"));
    expect(w.records[0]!.kind).toBe("other");
    expect(speedLine(w.records[0]!)).not.toContain("secret");
  });

  it("nothing but numbers and fixed words: no folder, command, machine, pane or session", async () => {
    const w = await world({ integrations: { claude: "outdated" }, agentsJson: { claude: "cl --flag" } });
    await w.start(tab("claude"));
    const line = speedLine(w.records[0]!);
    for (const word of ["fixture", "Mac mini", "mini", "w1", "pn1", "--flag", "session", "/"]) expect(line).not.toContain(word);
    expect(line.replace(/^\S+Z /, "")).toMatch(/^start [a-z]+: ([a-z]+( [a-z]+)? \d+(, )?)+, shown \d+, total \d+; [a-zA-Z]+$/);
  });
});

describe("kept, logged and carried by Report a Problem", () => {
  const record = (n: number): SpeedRecord => ({
    what: "start",
    at: Date.UTC(2026, 10, 21, 15, 0, n),
    kind: "claude",
    steps: [
      { name: "flags", ms: 0 },
      { name: "commands", ms: 12 },
      { name: "integration", ms: 8_123, word: "update" },
      { name: "pane", ms: 50 },
    ],
    shownMs: 8_200,
    totalMs: 10_400 + n,
    outcome: "started",
  });

  it("the last 20 of each, oldest first, each logged once as its line beside the updates: lines", () => {
    const lines: string[] = [];
    const logs = speedLogs((line) => lines.push(line));
    for (let n = 0; n < 25; n += 1) logs.record(record(n));
    logs.record({ ...record(0), what: "picture", kind: "claude", steps: [{ name: "attach", ms: 900, bytes: 48_211 }], outcome: "taken" });
    expect(logs.starts.list()).toHaveLength(speedLimit);
    expect(speedLimit).toBe(20);
    expect(logs.starts.list()[0]!.totalMs).toBe(10_405);
    expect(logs.pictures.list()).toHaveLength(1);
    expect(lines).toHaveLength(26);
    expect(lines[0]).toBe("new-agent: 2026-11-21T15:00:00Z start claude: flags 0, commands 12, integration update 8123, pane 50, shown 8200, total 10400; started");
    expect(lines[25]).toBe("picture-send: 2026-11-21T15:00:00Z picture claude: attach 900 48211b, shown 8200, total 10400; taken");
    expect(new SpeedLog(3).list()).toEqual([]);
  });

  it("Report a Problem carries the newest that fit, with a count line, and nothing at all for Send Feedback", () => {
    const details = { version: "0.1.2", signedRelease: true, macOS: "26.1", chip: "Apple silicon" };
    const starts = Array.from({ length: 20 }, (_, n) => record(n));
    const url = feedbackIssueUrl("problem", details, feedbackRepo, [], { start: starts, picture: [] });
    expect(url.length).toBeLessThan(2_000);
    const body = decodeURIComponent(url.slice(url.indexOf("?body=") + 6));
    expect(body).toContain(`### ${speedSections.start}`);
    expect(body).toContain("- Kept: 20 (the last 20).");
    // The newest first.
    expect(body).toContain(`- ${speedLine(starts[19]!)}`);
    expect(body).not.toContain(`- ${speedLine(starts[0]!)}`);
    const feedback = feedbackIssueUrl("feedback", details, feedbackRepo, [], { start: starts, picture: [] });
    expect(decodeURIComponent(feedback)).not.toContain(speedSections.start);
    // A few fit whole.
    const few = decodeURIComponent(feedbackIssueUrl("problem", details, feedbackRepo, [], { start: starts.slice(0, 2), picture: [] }));
    expect(few).toContain(`- ${speedLine(starts[0]!)}`);
    expect(few).toContain(`- ${speedLine(starts[1]!)}`);
  });

  it("a real start's record goes through to the report", async () => {
    const w = await world({ integrations: { claude: "current" } });
    await w.start(tab("claude"));
    const details = { version: "0.1.2", signedRelease: false, macOS: "26.1", chip: "Apple silicon" };
    const body = decodeURIComponent(feedbackIssueUrl("problem", details, feedbackRepo, [], { start: w.records, picture: [] }));
    expect(body).toContain(speedLine(w.records[0]!));
    expect(body).not.toContain("Mac mini");
    expect(body).not.toContain("/fixture");
  });
});

// The review's probes taken in: timing only watches, a refusal is said as soon as the flags answer, the
// line names the step that runs, and the page can show the pane from Herdr's own answer.
describe("timing only watches", () => {
  const plain = async (): Promise<unknown> => {
    const w = await world({ integrations: { claude: "current" } });
    return w.start(tab("claude"));
  };

  it("a recorder that throws leaves the start's answer as it is (the agent started, not a failure)", async () => {
    const expected = await plain();
    const w = await world({ integrations: { claude: "current" } }, { speed: { record: () => { throw new Error("record failed"); } } });
    await expect(w.start(tab("claude"))).resolves.toEqual(expected);
    expect(w.log.some((line) => line.startsWith("agent.start"))).toBe(true);
  });

  it("a slow recorder is never in front of the answer: the record is kept after the start answered", async () => {
    let answered = false;
    let keptAfterAnswer: boolean | null = null;
    const slow = (): void => {
      keptAfterAnswer = answered;
      const until = Date.now() + 30;
      while (Date.now() < until) {
        // A slow log line.
      }
    };
    const w = await world({ integrations: { claude: "current" } }, { speed: { record: slow } });
    const answer = registered.handles.get(IPC.newAgent)!(w.event, "mini", tab("claude"), "start-slow-1") as Promise<unknown>;
    await answer.then(() => (answered = true));
    expect(keptAfterAnswer).toBeNull();
    await turn();
    expect(keptAfterAnswer).toBe(true);
  });

  it("a page whose progress send throws, and a timer whose clock throws, change nothing either", async () => {
    const expected = await plain();
    const w = await world({ integrations: { claude: "current" } });
    w.page.send = () => {
      throw new Error("page gone");
    };
    await expect(w.start(tab("claude"))).resolves.toEqual(expected);
    expect(w.records).toHaveLength(1);
    const { StepTimer } = await import("../src/shared/speed-record");
    let reads = 0;
    const timer = new StepTimer<string>(() => {
      reads += 1;
      if (reads > 1) throw new Error("clock gone");
      return 0;
    });
    const work = Promise.resolve("answer");
    // The step's own promise comes back unchanged; the throwing clock is dropped.
    expect(timer.time("step", () => work)).toBe(work);
    await expect(timer.time("step", () => Promise.reject(new Error("its own")))).rejects.toThrow("its own");
    expect(timer.since()).toBe(0);
  });
});

describe("nothing slower than 34da24eb", () => {
  it("a refused Model and Effort check is said as soon as it answers, while the start commands are still being read", async () => {
    const catalogs = { settled: async () => ({ agent: "claude", models: [model("claude-opus-4-6")], readAt: 0, error: null, loading: false, none: null }) };
    const w = await world({ integrations: { claude: "current" } }, { modelCatalogs: catalogs });
    w.hold("(read agents.json)");
    let said: string | null = null;
    const run = registered.handles.get(IPC.newAgent)!(w.event, "mini", tab("claude", { model: "claude-made-up-9" }), "start-refused-1") as Promise<unknown>;
    run.catch((error: unknown) => (said = error instanceof Error ? error.message : String(error)));
    await flush();
    // The read is still out; the refusal is already the answer, as on 34da24eb (which read the flags first).
    expect(said).toContain("Nothing was made.");
    expect(panes(w)).toEqual([]);
    w.unhold("(read agents.json)");
    await flush();
    await turn();
    expect(w.log.filter((line) => !line.startsWith("(read"))).toEqual([]);
    expect(w.records[0]!.outcome).toBe("refused");
  });
});

describe("the line names the step in front of the pane that runs now", () => {
  it("the model list, then the start commands once the list answered, the integration step, the agent list, the tab", async () => {
    let listed: () => void = () => undefined;
    const listRead = new Promise<void>((done) => (listed = done));
    const catalogs = {
      settled: async () => {
        await listRead;
        return { agent: "claude", models: [model("claude-opus-4-6")], readAt: 0, error: null, loading: false, none: null };
      },
    };
    const w = await world({ integrations: { claude: "outdated" }, install: "hold" }, { modelCatalogs: catalogs });
    w.hold("(read agents.json)");
    w.hold("agent.list");
    w.hold("tab.create");
    const run = w.start(tab("claude", { model: "claude-opus-4-6" }));
    await flush();
    expect(steps(w).at(-1)).toBe("Checking the model list on Mac mini…");
    // The flags answered; only the start commands' read still runs: the line says so.
    listed();
    await flush();
    expect(steps(w).at(-1)).toBe("Reading the start commands on Mac mini…");
    w.unhold("(read agents.json)");
    await flush();
    expect(steps(w).at(-1)).toBe("Updating Herdr's Claude Code integration on Mac mini…");
    w.release();
    await flush();
    expect(steps(w).at(-1)).toBe("Reading the agent list on Mac mini…");
    w.unhold("agent.list");
    await flush();
    expect(steps(w).at(-1)).toBe("Making the new tab on Mac mini…");
    expect(panes(w)).toEqual([]);
    w.unhold("tab.create");
    await run;
    // Gone once the pane was made, then the pane.
    const said = w.progress.map((seen) => (seen.payload["type"] === "pane" ? "pane" : seen.payload["words"]));
    expect(said.slice(-2)).toEqual([null, "pane"]);
    expect(steps(w)).toEqual([
      "Checking the model list on Mac mini…",
      "Reading the start commands on Mac mini…",
      null,
      "Updating Herdr's Claude Code integration on Mac mini…",
      null,
      "Reading the agent list on Mac mini…",
      "Making the new tab on Mac mini…",
      null,
    ]);
    // 34da24eb's run for this machine, with the model's flags on its start.
    expect(w.log).toEqual(
      main["Herdr's own start, integration outdated (updated first)"]!.log.map((line) =>
        line.startsWith("agent.start ") ? 'agent.start {"name":"claude","kind":"claude","pane_id":"w1:pn1","args":["--model","claude-opus-4-6"]}' : line,
      ),
    );
  });

  it("a split names the new pane", async () => {
    const w = await world({ integrations: { claude: "current" } });
    w.hold("pane.split");
    const run = w.start({ ...tab("claude"), where: { type: "split", direction: "right", targetPaneId: "w1:p1", binding: w.bind("w1:p1") } });
    for (let i = 0; i < 10 && !w.log.some((line) => line.startsWith("pane.split")); i += 1) await flush();
    expect(steps(w).at(-1)).toBe("Making the new pane on Mac mini…");
    w.unhold("pane.split");
    await run;
    expect(steps(w).at(-1)).toBeNull();
  });
});

describe("the pane has its row when it is shown", () => {
  it("with no events, the pane told carries Herdr's answer, and the page's machines with it list the row before any snapshot", async () => {
    const { withMadePanes } = await import("../src/shared/new-agent");
    const { findRow } = await import("../src/shared/desktop-sidebar");
    const w = await world({ integrations: { claude: "current" } }, {}, false);
    w.hold("agent.start");
    const run = w.start(tab("claude"));
    for (let i = 0; i < 10 && panes(w).length === 0; i += 1) await flush();
    const told = panes(w)[0]!.payload as unknown as Extract<import("../src/shared/new-agent").NewAgentProgress, { type: "pane" }>;
    const hosts = w.registry.list();
    // The machine's last snapshot does not list it (no events here); Herdr's answer does.
    expect(findRow(hosts, "mini", told.paneId, { nowUnixMs: 0 })).toBeNull();
    expect(told.tab?.tabID).toBe("w1:tn1");
    expect(told.pane.paneID).toBe("w1:pn1");
    const made = withMadePanes(hosts, [{ hostId: "mini", connection: hosts[0]!.connection ?? 0, tab: told.tab, pane: told.pane, at: 0, heard: 1 }], 0, 1);
    const row = findRow(made.hosts, "mini", told.paneId, { nowUnixMs: 0 });
    expect(row?.paneID).toBe("w1:pn1");
    expect(made.kept).toHaveLength(1);
    // Nothing more was asked of the machine for it.
    expect(w.log.filter((line) => line.startsWith("session.snapshot"))).toEqual([]);
    // Main knows it too, for the window's terminal only (the snapshot's own pane() still does not list it).
    expect(w.registry.pane("mini", told.paneId)).toBeNull();
    expect(w.registry.madePane("mini", told.paneId)?.terminalID).toBe("term-w1:pn1");
    w.unhold("agent.start");
    await run;
    // Once a snapshot lists it, Herdr's answer is no longer needed; another connection's answer is never used.
    expect(withMadePanes(w.registry.list(), made.kept, 0, 2).kept).toEqual([]);
    expect(withMadePanes(hosts, [{ ...made.kept[0]!, connection: 999 }], 0, 1).kept).toEqual([]);
    // Listed by the final refresh, and forgotten as made once the start answered.
    expect(w.registry.madePane("mini", told.paneId)?.paneID).toBe("w1:pn1");
    w.registry.noteMade("mini", { ...told.pane, paneID: "w1:gone" }, { incarnation: w.registry.connectionIdentity("mini")!.incarnation, connection: w.registry.connection("mini")!, epoch: 1 });
    expect(w.registry.madePane("mini", "w1:gone")?.paneID).toBe("w1:gone");
    w.registry.forgetMade("mini", "w1:gone");
    expect(w.registry.madePane("mini", "w1:gone")).toBeNull();
    // This page never put it on screen: the record has no shown.
    expect(w.records[0]!.shownMs).toBeNull();
  });

  it("the record's shown is when the page put the pane on screen", async () => {
    const w = await world({ integrations: { claude: "current" } }, {}, false);
    w.hold("agent.start");
    const run = w.start(tab("claude"));
    for (let i = 0; i < 10 && panes(w).length === 0; i += 1) await flush();
    w.advance(70);
    await registered.handles.get(IPC.newAgentShown)!(w.event, panes(w)[0]!.payload["startId"], panes(w)[0]!.payload["paneId"]);
    w.unhold("agent.start");
    await run;
    expect(w.records[0]!.shownMs).toBe(commandsCost + requestCost["agent.list"]! + requestCost["tab.create"]! + 70);
    await expect(Promise.resolve().then(() => registered.handles.get(IPC.newAgentShown)!(w.event, "x y", "w1:pn1"))).rejects.toThrow("bad request");
  });
});

// The made pane is kept, in main and in the page, until a snapshot asked for after its creation lists it
// (or does not: closed), its failed start closed it, its machine's connection changed, or madePaneKeptMs passed; it
// belongs to the start that made it (the entry, connection and command connection that start was bound to), and only
// that start's window marks it shown. The first four are the review's probes, each red on cf9e707c.
describe("the made pane's life and owner", () => {
  type Told = Extract<import("../src/shared/new-agent").NewAgentProgress, { type: "pane" }>;
  const handle = { input: () => undefined, resize: () => undefined, close: () => undefined };
  type Backend = { snapshot: () => Promise<unknown>; connectionEpoch: () => number | null; openTerminal?: (pane: unknown) => Promise<unknown> };
  const backendOf = (w: Awaited<ReturnType<typeof world>>): Backend => w.registry.backend("mini") as unknown as Backend;
  const told = async (w: Awaited<ReturnType<typeof world>>): Promise<Told> => {
    for (let i = 0; i < 20 && panes(w).length === 0; i += 1) await flush();
    return panes(w)[0]!.payload as unknown as Told;
  };

  it("probe 1: a snapshot asked for before the creation's reply, answered after it without the pane, lets nothing go", async () => {
    const w = await world({ integrations: { claude: "current" } }, {}, false);
    const backend = backendOf(w);
    const old = w.live.topology();
    let release: () => void = () => undefined;
    const snapshot = backend.snapshot;
    backend.snapshot = async () => {
      await new Promise<void>((done) => (release = done));
      return old;
    };
    // Asked before the start: in flight while the pane is made, answered (without it) after the start answered.
    const refreshing = w.registry.refresh("mini");
    const run = w.start(tab("claude"));
    const made = await told(w);
    expect(w.registry.madePane("mini", made.paneId)?.paneID).toBe("w1:pn1");
    release();
    await refreshing;
    await run;
    expect(w.registry.pane("mini", made.paneId)).toBeNull();
    // Kept after the answer: that snapshot was asked before the creation, so it does not decide.
    expect(w.registry.madePane("mini", made.paneId)?.paneID).toBe("w1:pn1");
    expect(w.registry.list()[0]!.madePanes).toEqual(["w1:pn1"]);
    // A snapshot asked for now lists it: done.
    backend.snapshot = snapshot;
    await w.registry.refresh("mini");
    expect(w.registry.pane("mini", made.paneId)?.paneID).toBe("w1:pn1");
    expect(w.registry.list()[0]!.madePanes).toBeUndefined();
  });

  it("probe 2: a new command connection lets the made pane go, and its terminal no longer opens through it", async () => {
    const w = await world({ integrations: { claude: "current" } }, {}, false);
    w.hold("agent.start");
    const run = w.start(tab("claude"));
    const made = await told(w);
    const backend = backendOf(w);
    const opened: unknown[] = [];
    backend.openTerminal = async (pane) => {
      opened.push(pane);
      return handle;
    };
    expect(w.registry.madePane("mini", made.paneId)?.paneID).toBe("w1:pn1");
    // The command connection changes with no snapshot asked (the registry's connection number is the same).
    const connection = w.registry.connection("mini");
    backend.connectionEpoch = () => 2;
    expect(w.registry.connection("mini")).toBe(connection);
    expect(w.registry.madePane("mini", made.paneId)).toBeNull();
    expect(w.registry.list()[0]!.madePanes).toBeUndefined();
    const terminals = new TerminalSessions(w.registry as never);
    await expect(terminals.open(w.page as never, { hostId: "mini", paneId: made.paneId, cols: 80, rows: 24 })).rejects.toThrow("That pane is no longer listed.");
    terminals.closeAll();
    expect(opened).toEqual([]);
    backend.connectionEpoch = () => 1;
    w.unhold("agent.start");
    await run.catch(() => undefined);
    // The review's form: a reconnect's snapshot without the pane yet.
    const w2 = await world({ integrations: { claude: "current" } }, {}, false);
    w2.hold("agent.start");
    const run2 = w2.start(tab("claude"));
    const made2 = await told(w2);
    const backend2 = backendOf(w2);
    const old = w2.registry.list()[0]!.topology!;
    backend2.connectionEpoch = () => 2;
    backend2.snapshot = async () => old;
    await w2.registry.refresh("mini");
    expect(w2.registry.madePane("mini", made2.paneId)).toBeNull();
    w2.unhold("agent.start");
    await run2.catch(() => undefined);
  });

  it("probe 3: a creation reply that comes back to a replaced entry is dropped: not shown early, no terminal opens", async () => {
    const w = await world({ integrations: { claude: "current" } }, {}, false);
    const old = w.live.topology();
    w.hold("tab.create");
    const run = w.start(tab("claude")).catch((error: Error) => error.message);
    for (let i = 0; i < 20 && !w.log.some((line) => line.startsWith("tab.create")); i += 1) await flush();
    const backend = backendOf(w);
    const opened: unknown[] = [];
    w.registry.replace({ id: "mini", name: "Replacement", kind: "ssh", address: "fixture-replacement", platform: "macOS" }, {
      ...backend,
      snapshot: async () => old,
      openTerminal: async (pane: unknown) => {
        opened.push(pane);
        return handle;
      },
    } as never);
    await w.registry.refresh("mini");
    await flush();
    const terminals = new TerminalSessions(w.registry as never);
    w.unhold("tab.create");
    await run;
    // Herdr made it, but the start's entry is gone: the page heard of no pane, main keeps none.
    expect(panes(w)).toEqual([]);
    expect(w.registry.madePane("mini", "w1:pn1")).toBeNull();
    await expect(terminals.open(w.page as never, { hostId: "mini", paneId: "w1:pn1", cols: 80, rows: 24 })).rejects.toThrow("That pane is no longer listed.");
    terminals.closeAll();
    expect(opened).toEqual([]);
    expect(w.records[0]!.shownMs).toBeNull();
  });

  it("probe 4: another window's shown message, or one for another pane, is ignored; the asking window's counts", async () => {
    const w = await world({ integrations: { claude: "current" } }, {}, false);
    const shown = registered.handles.get(IPC.newAgentShown)!;
    const other = { ...w.event, sender: { ...w.page, id: 999 } };
    w.hold("tab.create");
    w.hold("agent.start");
    const run = w.start(tab("claude"));
    for (let i = 0; i < 20 && !w.log.some((line) => line.startsWith("tab.create")); i += 1) await flush();
    // Each is ignored, or refused as a bad request (a message without its pane): either way nothing is marked.
    const ignored = (...args: unknown[]): Promise<unknown> => Promise.resolve().then(() => shown(...args)).catch(() => undefined);
    // Before the pane exists: another window (the review's form, with the start id only, then with a pane), and this one.
    await ignored(other, "start-0001");
    await ignored(other, "start-0001", "w1:pn1");
    await ignored(w.event, "start-0001", "w1:pn1");
    w.unhold("tab.create");
    const made = await told(w);
    // After: another window, then this window for a pane its start did not make.
    await ignored(other, "start-0001", made.paneId);
    await ignored(w.event, "start-0001", "w1:p1");
    w.unhold("agent.start");
    await run;
    expect(w.records[0]!.shownMs).toBeNull();
    // The asking window, for its pane: counted.
    const w2 = await world({ integrations: { claude: "current" } }, {}, false);
    w2.hold("agent.start");
    const run2 = w2.start(tab("claude"));
    const made2 = await told(w2);
    await registered.handles.get(IPC.newAgentShown)!(w2.event, "start-0001", made2.paneId);
    w2.unhold("agent.start");
    await run2;
    expect(w2.records[0]!.shownMs).not.toBeNull();
    // A message missing its pane is a bad request, as before for anything malformed.
    await expect(Promise.resolve().then(() => registered.handles.get(IPC.newAgentShown)!(w2.event, "start-0001"))).rejects.toThrow("bad request");
  });

  it(`the bound: kept ${madePaneKeptMs} ms at most, in main and in the page`, async () => {
    const w = await world({ integrations: { claude: "current" } }, {}, false);
    let t = 1_000;
    const registry = new HostRegistry(() => undefined, () => t);
    registry.add({ id: "m2", name: "Fixture", kind: "ssh", address: "fixture", platform: "macOS" }, { snapshot: async () => w.live.topology(), connectionEpoch: () => 7, close: () => undefined } as never);
    await registry.refresh("m2");
    const pane = { ...w.live.topology().panes[0]!, paneID: "w1:pmade" };
    const binding = { incarnation: registry.connectionIdentity("m2")!.incarnation, connection: registry.connection("m2")!, epoch: 7 };
    expect(registry.noteMade("m2", pane, binding)).toBe(true);
    t += madePaneKeptMs - 1;
    expect(registry.madePane("m2", "w1:pmade")?.paneID).toBe("w1:pmade");
    expect(registry.list()[0]!.madePanes).toEqual(["w1:pmade"]);
    t += 1;
    expect(registry.madePane("m2", "w1:pmade")).toBeNull();
    expect(registry.list()[0]!.madePanes).toBeUndefined();
    // A binding the machine is not on now keeps nothing.
    expect(registry.noteMade("m2", pane, { ...binding, epoch: 8 })).toBe(false);
    expect(registry.noteMade("m2", pane, { ...binding, connection: binding.connection + 1 })).toBe(false);
    expect(registry.noteMade("m2", pane, { ...binding, incarnation: binding.incarnation + 1 })).toBe(false);
    expect(registry.madePane("m2", "w1:pmade")).toBeNull();
    // The page: the same bound from when it heard of it.
    const hosts = w.registry.list();
    const entry = { hostId: "mini", connection: hosts[0]!.connection ?? 0, tab: null, pane: { ...w.live.topology().panes[0]!, paneID: "w1:pmade" }, at: 5_000, heard: 1 };
    expect(withMadePanes(hosts, [entry], 5_000 + madePaneKeptMs - 1, 1).kept).toHaveLength(1);
    expect(withMadePanes(hosts, [entry], 5_000 + madePaneKeptMs, 1).kept).toEqual([]);
  });

  it("a start that fails and closes its pane: main lets it go and tells the page before the answer", async () => {
    const w = await world({ integrations: { claude: "current" }, refuseStart: "launch_failed" });
    await expect(w.start(tab("claude"))).rejects.toThrow("Herdr did not start Claude Code: the pane is gone");
    const closed = w.progress.filter((said) => said.payload["type"] === "closed");
    expect(closed.map((said) => said.payload)).toEqual([{ type: "closed", paneId: "w1:pn1", startId: "start-0001" }]);
    // Told after the pane was, and after the close went.
    expect(w.progress.indexOf(closed[0]!)).toBeGreaterThan(w.progress.indexOf(panes(w)[0]!));
    expect(closed[0]!.logIndex).toBeGreaterThan(w.log.indexOf('pane.close {"pane_id":"w1:pn1"}'));
    expect(w.registry.madePane("mini", "w1:pn1")).toBeNull();
    expect(w.registry.list()[0]!.madePanes).toBeUndefined();
    expect(w.records[0]!.outcome).toBe("closed");
  });

  it("closed by the person (a snapshot asked after the creation does not list it): let go in main and in the page", async () => {
    const w = await world({ integrations: { claude: "current" } }, {}, false);
    w.hold("agent.start");
    const run = w.start(tab("claude"));
    const made = await told(w);
    const page = withMadePanes(w.registry.list(), [{ hostId: "mini", connection: w.registry.connection("mini")!, tab: made.tab, pane: made.pane, at: 0, heard: 0 }], 0, 1);
    expect(page.kept).toHaveLength(1);
    const actions = (w.registry.backend("mini") as unknown as { paneActions: () => { closePane: (id: string) => Promise<unknown> } }).paneActions();
    await actions.closePane(made.paneId);
    await w.registry.refresh("mini");
    expect(w.registry.madePane("mini", made.paneId)).toBeNull();
    const after = w.registry.list();
    expect(after[0]!.madePanes).toBeUndefined();
    // The page's next list from main no longer carries it: gone there too.
    expect(withMadePanes(after, page.kept, 0, 2).kept).toEqual([]);
    w.unhold("agent.start");
    await run.catch(() => undefined);
  });

  it("no events: the pane is shown from the creation's reply, main's list carries it, and nothing more is asked", async () => {
    const w = await world({ integrations: { claude: "current" } }, {}, false);
    w.hold("agent.start");
    const run = w.start(tab("claude"));
    const made = await told(w);
    const hosts = w.registry.list();
    expect(hosts[0]!.madePanes).toEqual([made.paneId]);
    // The page heard of it with one list; a list sent after it (main's, carrying it) keeps it, a row from Herdr's answer.
    const entry = { hostId: "mini", connection: hosts[0]!.connection ?? 0, tab: made.tab, pane: made.pane, at: 0, heard: 1 };
    const shown = withMadePanes(hosts, [entry], 10, 2);
    expect(shown.kept).toHaveLength(1);
    expect(shown.hosts[0]!.topology!.panes.some((pane) => pane.paneID === made.paneId)).toBe(true);
    // Before any list after it, main's older list (without it) does not drop it.
    expect(withMadePanes([{ ...hosts[0]!, madePanes: undefined }], [entry], 10, 1).kept).toHaveLength(1);
    expect(withMadePanes([{ ...hosts[0]!, madePanes: undefined }], [entry], 10, 2).kept).toEqual([]);
    expect(w.log.filter((line) => line.startsWith("session.snapshot"))).toEqual([]);
    const opened: unknown[] = [];
    backendOf(w).openTerminal = async (pane) => {
      opened.push(pane);
      return handle;
    };
    const before = w.log.slice();
    const terminals = new TerminalSessions(w.registry as never);
    await terminals.open(w.page as never, { hostId: "mini", paneId: made.paneId, cols: 80, rows: 24 });
    terminals.closeAll();
    expect(opened).toEqual([made.pane]);
    expect(w.log).toEqual(before);
    w.unhold("agent.start");
    await run;
    // The start's own refresh, asked after the creation, lists it: done in main, and the page's copy goes with it.
    expect(w.registry.pane("mini", made.paneId)?.paneID).toBe(made.paneId);
    expect(w.registry.list()[0]!.madePanes).toBeUndefined();
    expect(withMadePanes(w.registry.list(), shown.kept, 20, 3).kept).toEqual([]);
  });
});
