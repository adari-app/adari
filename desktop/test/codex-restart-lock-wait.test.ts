// The lock wait's `r` goes only to the run seen with the read that showed the
// lock: the snapshot and the run come before that read, and a later snapshot
// never supplies the run. The five minutes count from the first read that
// showed the lock, so a slow snapshot after it is inside them. And a capture
// of a real locked pane (Codex 0.167.0, the resumed conversation's history
// right above the lock) is the lock screen.
// A fake Codex, fake screens, a fake clock.

import { describe, expect, it } from "vitest";

import { restartAgent, restartLockRetryMs, restartLockWaitMs, type RestartSite } from "../src/main/herdr/restart";
import { codexLockShown, codexResumeScreen, lockStopReasons, restartTexts } from "../src/shared/agent-restart";
import { startCommandsWith } from "../src/shared/start-commands";
import { agentState, bindingFor, claudeID, shellState, type PaneState } from "./support/restart-machine";

const codexSession = { source: "herdr:codex", agent: "codex", kind: "id", value: claudeID };
const codex = agentState({ kind: "codex", session: codexSession });
const resumedNoSession = agentState({ kind: "codex", session: null });

const lockRow = `  \u{1F512}  This conversation is open in another app${" ".repeat(63)}r to retry`;
const helpRow = "      Close it there and press R to continue here.";
const keysRow = "   r retry   f fork   \u{2190}/esc command center   \u{2303}c/q exit   \u{2303}t transcript";
/** A capture of a real locked pane (Codex 0.167.0; the capture dropped blank rows). */
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

/** A fake Codex: /exit with its first Return, the shell, then the resume into `screens` (the last one stays). */
function fakeResume(screens: string[]) {
  const writes: { keys: unknown[]; at: number; run: Run }[] = [];
  const m = {
    clock: 1_000_000,
    state: codex as PaneState,
    phase: "running" as "running" | "leaving" | "resumed",
    run: { connection: 3, arrival: 1 } as Run,
    reads: 0,
    freshes: 0,
    /** The clock when the first read that showed the lock began (null: none yet). */
    firstLockedAt: null as number | null,
    /** Snapshots taken since that read began. */
    freshesAfterLock: 0,
    onFresh: (_after: number) => undefined as void,
    onRead: (_reads: number) => undefined as void,
    notes: [] as string[],
  };
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
        m.run = { connection: 3, arrival: 2 };
      },
    },
    machine: "Mac mini",
    fresh: async () => {
      m.freshes += 1;
      m.state = m.phase === "running" ? codex : m.phase === "leaving" ? shellState(codex.pane?.terminalID) : resumedNoSession;
      if (m.phase === "leaving") m.run = null;
      if (m.firstLockedAt !== null) {
        m.freshesAfterLock += 1;
        m.onFresh(m.freshesAfterLock);
      }
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
  /** Every `r` after the resume, with when it went and to which run. */
  const retries = () => writes.slice(writes.findIndex((write) => write.keys[0] === "input") + 1);
  return { m, site, start, retries };
}

const lockWait = restartTexts.lockWait("Codex");
const lockGaveUp = restartTexts.lockGaveUp("Codex");

describe("the real locked pane (Codex 0.167.0) is the lock screen", () => {
  it("with the resumed conversation's history right above it, with or without a blank row", () => {
    expect(codexLockShown(captured)).toBe(true);
    expect(codexResumeScreen(captured)).toBe("locked");
    expect(codexLockShown(capturedBlank)).toBe(true);
    expect(codexResumeScreen(capturedBlank)).toBe("locked");
  });

  it("Codex's prompt under that history is not", () => {
    const back = [...history, "", "\u{203A} Ask Codex to do anything", "", footer].join("\n");
    expect(codexLockShown(back)).toBe(false);
    expect(codexResumeScreen(back)).toBe("prompt");
  });

  it("the restart on that screen: the note, one `r`, then the prompt", async () => {
    const x = fakeResume([captured, capturedBlank, prompt]);
    expect(await x.start()).toBeNull();
    expect(x.m.notes).toEqual([lockWait]);
    expect(x.retries().map((write) => write.keys)).toEqual([["r"]]);
  });
});

describe("the `r` is bound to the run seen with the read that showed the lock", () => {
  it("the snapshot after the first locked read shows a new arrival: no `r`, ever, and the stop note", async () => {
    const x = fakeResume([locked, locked, prompt]);
    let readRun: Run = null;
    x.m.onRead = (reads) => {
      if (reads === 1) readRun = x.m.run && { ...x.m.run };
    };
    // The first snapshot after the first locked read: the same connection, a new arrival (another run).
    x.m.onFresh = (after) => {
      if (after === 1) x.m.run = { connection: 3, arrival: 3 };
    };
    expect(await x.start()).toBe(restartTexts.lockStopped("Codex", lockStopReasons.otherAgent));
    expect(readRun).toEqual({ connection: 3, arrival: 2 });
    expect(x.retries()).toEqual([]);
  });

  it("another run during the first locked read itself: no `r`, and the stop note", async () => {
    const x = fakeResume([locked, locked, prompt]);
    x.m.onRead = (reads) => {
      if (reads === 1) x.m.run = { connection: 3, arrival: 3 };
    };
    expect(await x.start()).toBe(restartTexts.lockStopped("Codex", lockStopReasons.otherAgent));
    expect(x.retries()).toEqual([]);
  });

  it("a new connection in the snapshot after the first locked read: no `r`", async () => {
    const x = fakeResume([locked, locked, prompt]);
    x.m.onFresh = (after) => {
      if (after === 1) x.m.run = { connection: 4, arrival: 2 };
    };
    expect(await x.start()).toBe(restartTexts.lockStopped("Codex", lockStopReasons.otherAgent));
    expect(x.retries()).toEqual([]);
  });

  it("every `r` goes to the run seen with the first locked read (the third snapshot changes it)", async () => {
    const x = fakeResume([locked, locked, prompt]);
    let readRun: Run = null;
    x.m.onRead = (reads) => {
      if (reads === 1) readRun = x.m.run && { ...x.m.run };
    };
    const fresh = x.site.fresh;
    x.site.fresh = async () => {
      const answer = await fresh();
      if (x.m.freshes === 3) x.m.run = { connection: 3, arrival: 3 };
      return answer;
    };
    await x.start();
    expect(x.retries().filter((write) => write.run?.arrival !== (readRun as Run)?.arrival)).toEqual([]);
  });

  it("the run unchanged: the one `r` goes to it", async () => {
    const x = fakeResume([locked, locked, prompt]);
    expect(await x.start()).toBeNull();
    expect(x.retries()).toEqual([{ keys: ["r"], at: expect.any(Number), run: { connection: 3, arrival: 2 } }]);
  });
});

describe("five minutes from the first locked read", () => {
  it("a 16 s snapshot after the first locked read: no `r` at or after 5 minutes from it, and the lasting note", async () => {
    const x = fakeResume([locked]);
    x.m.onFresh = (after) => {
      if (after === 1) x.m.clock += 16_000;
    };
    expect(await x.start()).toBe(lockGaveUp);
    expect(x.m.notes).toEqual([lockWait]);
    const deadline = x.m.firstLockedAt! + restartLockWaitMs;
    expect(x.retries().length).toBeGreaterThan(0);
    expect(x.retries().every((write) => write.keys.join() === "r" && write.at < deadline)).toBe(true);
    // The wait ends at the deadline, not 16 s after it.
    expect(x.m.clock).toBe(deadline);
  });

  it("a 16 s snapshot (the third snapshot): no `r` at or after 5 minutes from the first locked read", async () => {
    const x = fakeResume([locked]);
    const fresh = x.site.fresh;
    x.site.fresh = async () => {
      const answer = await fresh();
      if (x.m.freshes === 3) x.m.clock += 16_000;
      return answer;
    };
    expect(await x.start()).toBe(lockGaveUp);
    expect(x.retries().filter((write) => write.at >= x.m.firstLockedAt! + restartLockWaitMs)).toEqual([]);
  });

  it("a 16 s snapshot before every round: still none at or after the deadline", async () => {
    const x = fakeResume([locked]);
    x.m.onFresh = () => {
      x.m.clock += 16_000;
    };
    expect(await x.start()).toBe(lockGaveUp);
    const deadline = x.m.firstLockedAt! + restartLockWaitMs;
    expect(x.retries().every((write) => write.at < deadline)).toBe(true);
  });

  it("a lock first shown without Codex in Herdr's snapshot: the five minutes still count from that read", async () => {
    const x = fakeResume([locked]);
    // Herdr shows the shell for the first two snapshots after the resume; the third shows Codex.
    const fresh = x.site.fresh;
    let after = 0;
    x.site.fresh = async () => {
      const answer = await fresh();
      if (x.m.phase === "resumed" && ++after <= 2) x.m.state = shellState(codex.pane?.terminalID);
      return answer;
    };
    expect(await x.start()).toBe(lockGaveUp);
    const deadline = x.m.firstLockedAt! + restartLockWaitMs;
    expect(x.retries().every((write) => write.at < deadline)).toBe(true);
    expect(x.m.clock).toBe(deadline);
  });

  it("a read that ends at the deadline: no `r` on it", async () => {
    const x = fakeResume([locked]);
    x.m.onRead = (reads) => {
      if (reads === 2) x.m.clock = x.m.firstLockedAt! + restartLockWaitMs;
    };
    expect(await x.start()).toBe(lockGaveUp);
    expect(x.retries()).toEqual([]);
  });

  it("no delays: one `r` every 15 s, all before the deadline", async () => {
    const x = fakeResume([locked]);
    expect(await x.start()).toBe(lockGaveUp);
    expect(x.retries()).toHaveLength(restartLockWaitMs / restartLockRetryMs - 1);
    expect(x.retries().every((write) => write.at < x.m.firstLockedAt! + restartLockWaitMs)).toBe(true);
  });
});
