// A Codex the snapshot showed before the read that showed the lock is the run the
// lock wait is bound to. If that Codex is gone during the read (the pane shows
// the shell), the restart stops with the lasting gone note and no key: it never
// looks again and binds whatever Codex shows up next. Looking again is only for
// a snapshot that had no Codex before the read (Codex not registered yet).
// A fake Codex, fake screens, a fake clock; one case uses the real PaneLife
// arrival tracker.

import { describe, expect, it } from "vitest";

import { restartAgent, restartLockRetryMs, restartLockWaitMs, type RestartSite } from "../src/main/herdr/restart";
import { codexLockShown, lockStopReasons, restartTexts } from "../src/shared/agent-restart";
import { PaneLife } from "../src/shared/pane-life";
import { startCommandsWith } from "../src/shared/start-commands";
import { agentState, bindingFor, claudeID, shellState, type PaneState } from "./support/restart-machine";

const codexSession = { source: "herdr:codex", agent: "codex", kind: "id", value: claudeID };
const codex = agentState({ kind: "codex", session: codexSession });
const resumedNoSession = agentState({ kind: "codex", session: null });
const shell = shellState(codex.pane?.terminalID);

const lockRow = `  \u{1F512}  This conversation is open in another app${" ".repeat(63)}r to retry`;
const helpRow = "      Close it there and press R to continue here.";
const keysRow = "   r retry   f fork   \u{2190}/esc command center   \u{2303}c/q exit   \u{2303}t transcript";
/** A capture of the real pane (Codex 0.167.0; the capture dropped blank rows). */
const history = [
  "\u{2022} Chat needs Herd's Codex integration on This Mac, and it is not installed.",
  "  Worked for 8s \u{2022} 8:53 PM",
  "\u{203A} Reply with exactly: resumed",
  "\u{2022} resumed",
  "  Worked for 3s \u{2022} 8:57 PM",
];
const captured = [...history, lockRow, helpRow, keysRow].join("\n");
const capturedBlank = [...history, "", lockRow, helpRow, keysRow].join("\n");
const locked = ["", lockRow, helpRow, keysRow, ""].join("\n");
const footer = "  GPT-6.1-Sol default \u{B7} ~/code/hello-app \u{B7} Reply exactly hello";
const prompt = ["\u{2022} hello", "", "\u{203A} Ask Codex to do anything", "", footer].join("\n");

type Run = { connection: number; arrival: number } | null;

const lockWait = restartTexts.lockWait("Codex");
const lockGaveUp = restartTexts.lockGaveUp("Codex");
const goneStop = restartTexts.lockStopped("Codex", lockStopReasons.gone("Codex"));

/**
 * A fake Codex: /exit with its first Return, the shell, then the resume into `screens` (the last one stays).
 * `paneLife`: the run's arrival comes from the real PaneLife class, fed every pane state the fake shows;
 * else the fake sets it (arrival 2 at the resume) and the test moves it.
 */
function fakeResume(screens: string[], options: { paneLife?: boolean } = {}) {
  const writes: { keys: unknown[]; at: number; run: Run }[] = [];
  const life = options.paneLife === true ? new PaneLife() : null;
  const host = { id: "mac-mini", address: "fake-route", state: "connected" as const };
  const m = {
    clock: 1_000_000,
    state: codex as PaneState,
    phase: "running" as "running" | "leaving" | "resumed",
    run: { connection: 3, arrival: 1 } as Run,
    reads: 0,
    /** Snapshots taken after the resume command went. */
    resumedFreshes: 0,
    /** Whether each snapshot after the resume answers (default: yes). */
    freshAnswers: (_n: number) => true as boolean,
    /** The pane state Herdr shows at the nth snapshot after the resume (default: the resumed Codex). */
    resumedState: (_n: number) => resumedNoSession as PaneState,
    firstLockedAt: null as number | null,
    onRead: (_reads: number) => undefined as void,
    notes: [] as string[],
    /** Each read: its number, the clock, what the pane showed and the run. */
    trace: [] as { read: number; at: number; agent: string; run: Run }[],
  };
  /** Herdr's snapshot now goes to PaneLife (when used), which supplies the run's arrival. */
  const observe = (): void => {
    if (life === null) return;
    const topology = { version: "fake", protocol: 22, workspaces: [], tabs: [], layouts: [], panes: m.state.pane ? [m.state.pane] : [], agents: m.state.agent ? [m.state.agent] : [] };
    life.observe({ ...host, topology } as never);
    m.run = { connection: 3, arrival: life.arrival(host, "w1:p1") };
  };
  /** The pane shows `state` now (a topology update between snapshots). */
  const show = (state: PaneState): void => {
    m.state = state;
    observe();
  };
  observe();
  const site: RestartSite = {
    writer: {
      sendText: async (_pane, text) => void writes.push({ keys: ["text", text], at: m.clock, run: m.run }),
      agentKeys: async (_pane, keys) => {
        writes.push({ keys: [...keys], at: m.clock, run: m.run && { ...m.run } });
        if (m.phase === "running") m.phase = "leaving";
      },
      sendInput: async (_pane, text) => {
        writes.push({ keys: ["input", text], at: m.clock, run: m.run });
        m.phase = "resumed";
        if (life === null) m.run = { connection: 3, arrival: 2 };
      },
    },
    machine: "Mac mini",
    fresh: async () => {
      if (m.phase === "running") m.state = codex;
      else if (m.phase === "leaving") {
        m.state = shell;
        if (life === null) m.run = null;
      } else {
        m.resumedFreshes += 1;
        if (!m.freshAnswers(m.resumedFreshes)) return false;
        m.state = m.resumedState(m.resumedFreshes);
      }
      observe();
      return true;
    },
    pane: () => m.state.pane,
    agent: () => m.state.agent,
    identity: () => ({ incarnation: 1, connection: 3, epoch: 7 }),
    snapshotEpoch: () => 7,
    startCommands: async () => startCommandsWith({ type: "read" }, { claude: "cl" }),
    read: async () => {
      if (m.phase !== "resumed") throw new Error("read before the resume");
      const screen = screens[Math.min(m.reads, screens.length - 1)]!;
      if (codexLockShown(screen) && m.firstLockedAt === null) m.firstLockedAt = m.clock;
      m.reads += 1;
      m.trace.push({ read: m.reads, at: m.clock, agent: m.state.agent?.agent ?? "shell", run: m.run && { ...m.run } });
      m.onRead(m.reads);
      return screen;
    },
    entry: () => true,
    run: () => m.run,
    inputs: () => [0, 0, 0],
    note: (text) => void m.notes.push(text),
    now: () => m.clock,
    sleep: async (ms) => {
      m.clock += ms;
    },
  };
  const start = (): Promise<string | null> => restartAgent(site, "w1:p1", { ...bindingFor(codex, "Codex"), run: { connection: 3, arrival: 1 } });
  /** Every key after the resume, with when it went and to which run. */
  const retries = () => writes.slice(writes.findIndex((write) => write.keys[0] === "input") + 1);
  return { m, site, start, retries, show };
}

describe("a Codex seen before the locked read and gone during it stops the wait", () => {
  it("the shell during the first locked read, then Codex on arrival 3: no `r`, ever, and the lasting gone note", async () => {
    const x = fakeResume([locked, locked, locked, prompt]);
    let readRun: Run = null;
    // During the first locked read the pane shows the shell; the run tracker keeps arrival 2 there.
    x.m.onRead = (reads) => {
      if (reads === 1) {
        readRun = x.m.run && { ...x.m.run };
        x.show(shell);
      }
    };
    // From the next snapshot on: Codex again, a new arrival.
    x.m.resumedState = (n) => {
      if (n >= 2) x.m.run = { connection: 3, arrival: 3 };
      return resumedNoSession;
    };
    expect(await x.start()).toBe(goneStop);
    expect(readRun).toEqual({ connection: 3, arrival: 2 });
    expect(x.retries()).toEqual([]);
    expect(x.m.notes).toEqual([]);
    // It stopped on that read: no later snapshot or read was taken.
    expect(x.m.reads).toBe(1);
    expect(x.m.resumedFreshes).toBe(1);
  });

  it("with the real PaneLife: arrival 2 kept at the shell, 3 when Codex shows again, and no `r` to 3", async () => {
    const x = fakeResume([locked, locked, locked, prompt], { paneLife: true });
    let arrivalAtShell: number | undefined;
    // During the first locked read the pane shows the shell; every later snapshot shows Codex again.
    x.m.onRead = (reads) => {
      if (reads === 1) {
        x.show(shell);
        arrivalAtShell = x.m.run?.arrival;
      }
    };
    const result = await x.start();
    const evidence = JSON.stringify({ result, trace: x.m.trace, retries: x.retries() });
    expect(x.m.trace[0], evidence).toEqual({ read: 1, at: expect.any(Number), agent: "codex", run: { connection: 3, arrival: 2 } });
    expect(arrivalAtShell, evidence).toBe(2);
    expect(x.retries().filter((write) => write.run?.arrival !== 2), evidence).toEqual([]);
    expect(x.retries(), evidence).toEqual([]);
    expect(result, evidence).toBe(goneStop);
    // Had the restart looked again, PaneLife would have counted Codex's return as arrival 3.
    x.show(shell);
    x.show(resumedNoSession);
    expect(x.m.run?.arrival).toBe(3);
  });

  it("the binding is kept across later reads: a snapshot that did not answer at the first locked read, then the shell, then arrival 3", async () => {
    const x = fakeResume([locked, locked, locked, prompt], { paneLife: true });
    // The snapshot before the first read does not answer (Herdr's last one shows Codex, arrival 2).
    x.m.freshAnswers = (n) => n !== 1;
    let seen = false;
    // The pane shows the shell from the second snapshot, Codex again (arrival 3) from the third.
    x.m.resumedState = (n) => {
      if (n === 1) return resumedNoSession;
      if (n === 2) return shell;
      seen = true;
      return resumedNoSession;
    };
    // Before the resume's first snapshot is skipped, Herdr's last view is the resumed Codex.
    const sendInput = x.site.writer.sendInput;
    x.site.writer.sendInput = async (pane, text, keys) => {
      await sendInput(pane, text, keys);
      x.show(resumedNoSession);
    };
    expect(await x.start()).toBe(goneStop);
    expect(x.m.trace[0]?.run).toEqual({ connection: 3, arrival: 2 });
    expect(seen).toBe(false);
    expect(x.retries()).toEqual([]);
  });

  it("Codex gone during the first locked read and never back: the gone note, no key", async () => {
    const x = fakeResume([locked]);
    x.m.onRead = (reads) => {
      if (reads === 1) x.show(shell);
    };
    x.m.resumedState = (n) => (n === 1 ? resumedNoSession : shell);
    expect(await x.start()).toBe(goneStop);
    expect(x.retries()).toEqual([]);
  });
});

describe("controls: a first snapshot genuinely without Codex still looks again", () => {
  it("Codex registers later: one `r`, then the prompt", async () => {
    const x = fakeResume([locked, locked, locked, prompt]);
    x.m.resumedState = (n) => (n === 1 ? shell : resumedNoSession);
    expect(await x.start()).toBeNull();
    expect(x.m.notes).toEqual([lockWait]);
    expect(x.retries()).toEqual([{ keys: ["r"], at: expect.any(Number), run: { connection: 3, arrival: 2 } }]);
  });

  it("Codex registers later with the real PaneLife: one `r` to its arrival, then the prompt", async () => {
    const x = fakeResume([locked, locked, locked, prompt], { paneLife: true });
    x.m.resumedState = (n) => (n === 1 ? shell : resumedNoSession);
    expect(await x.start()).toBeNull();
    expect(x.retries()).toEqual([{ keys: ["r"], at: expect.any(Number), run: { connection: 3, arrival: 2 } }]);
  });

  it("Codex registers later and the lock stays: the five minutes still count from the first locked read", async () => {
    const x = fakeResume([locked]);
    x.m.resumedState = (n) => (n === 1 ? shell : resumedNoSession);
    expect(await x.start()).toBe(lockGaveUp);
    const deadline = x.m.firstLockedAt! + restartLockWaitMs;
    expect(x.m.clock).toBe(deadline);
    expect(x.retries().length).toBeGreaterThan(0);
    expect(x.retries().every((write) => write.keys.join() === "r" && write.at < deadline && write.run?.arrival === 2)).toBe(true);
  });

  it("the real capture end to end, with and without a blank row: the note, one `r`, then the prompt", async () => {
    const x = fakeResume([captured, capturedBlank, prompt]);
    expect(await x.start()).toBeNull();
    expect(x.m.notes).toEqual([lockWait]);
    expect(x.retries()).toEqual([{ keys: ["r"], at: expect.any(Number), run: { connection: 3, arrival: 2 } }]);
  });

  it("no delays: 19 `r` keys every 15 s, all to the bound run and before the deadline", async () => {
    const x = fakeResume([locked]);
    expect(await x.start()).toBe(lockGaveUp);
    const deadline = x.m.firstLockedAt! + restartLockWaitMs;
    expect(x.retries()).toHaveLength(restartLockWaitMs / restartLockRetryMs - 1);
    expect(x.retries().map((write) => write.at)).toEqual(Array.from({ length: 19 }, (_, i) => x.m.firstLockedAt! + (i + 1) * restartLockRetryMs));
    expect(x.retries().every((write) => write.keys.join() === "r" && write.at < deadline && write.run?.arrival === 2)).toBe(true);
  });
});
