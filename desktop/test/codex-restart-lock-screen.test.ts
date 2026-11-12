// Restart on a Codex that ran in daemon mode (a plain
// `codex`, or Herdr's session restore). Its background service still holds the
// conversation, so the resumed `codex resume <id> --no-daemon` draws "This
// conversation is open in another app" and waits. Adari reads the resumed
// screen: the exact lock screen gets a note and, every 15 s for up to 5 min,
// the single key `r` while the latest read still shows it and every check
// holds; the prompt ends the restart as usual; any typing, a run change or a
// dialog stops it with no key. A fake Codex, fake screens, a fake clock.

import { describe, expect, it, vi } from "vitest";

import { restartAgent, restartLockRetryMs, restartLockWaitMs, restartResumeWatchMs, type RestartSite } from "../src/main/herdr/restart";
import { AgentRestarts, restartHeld } from "../src/renderer/components/restart";
import {
  codexLockShown,
  codexResumeScreen,
  lockStopReasons,
  restartDisabledReason,
  restartSessionKnown,
  restartTexts,
} from "../src/shared/agent-restart";
import { IPC, type RestartNoteEvent } from "../src/shared/ipc-contract";
import { startCommandsWith } from "../src/shared/start-commands";
import { agentState, bindingFor, claudeID, shellState, type PaneState } from "./support/restart-machine";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const codexSession = { source: "herdr:codex", agent: "codex", kind: "id", value: claudeID };
const codex = agentState({ kind: "codex", session: codexSession });
/** The resumed Codex before it reports its session (Herdr names none yet). */
const resumedNoSession = agentState({ kind: "codex", session: null });
const resume = `codex resume ${claudeID} --no-daemon`;

const lockRow = `  \u{1F512}  This conversation is open in another app${" ".repeat(93)}r to retry`;
const helpRow = "      Close it there and press R to continue here.";
const keysRow = "   r retry   f fork   \u{2190}/esc command center   \u{2303}c/q exit   \u{2303}t transcript";
const shellLine = `guest@mini hello-app % ${resume}`;
/** A recorded frame (a clean-home test, Codex 0.167.0). */
const locked = [shellLine, "", lockRow, helpRow, keysRow, "", ""].join("\n");
const footer = "  GPT-6.1-Sol default \u{B7} ~/code/hello-app \u{B7} Reply exactly hello";
/** The resumed conversation at Codex's prompt. */
const prompt = ["• hello", "", "\u{203A} Ask Codex to do anything", "", footer].join("\n");
/** The shell with the resume command typed, Codex not drawn yet. */
const starting = [shellLine, ""].join("\n");

describe("the lock screen, exactly", () => {
  it("the recorded frame, and its plain variants", () => {
    expect(codexLockShown(locked)).toBe(true);
    // Without the lock glyph, without the right-hand hint, with the glyph's emoji form.
    expect(codexLockShown([shellLine, "  This conversation is open in another app", helpRow, keysRow].join("\n"))).toBe(true);
    expect(codexLockShown(["  \u{1F512}  This conversation is open in another app", helpRow, keysRow].join("\n"))).toBe(true);
    expect(codexLockShown(["  \u{1F512}\u{FE0F}  This conversation is open in another app", helpRow, keysRow].join("\n"))).toBe(true);
    // The key row at the bottom of a taller screen, blank rows between.
    expect(codexLockShown([lockRow, helpRow, "", "", "", keysRow, "", ""].join("\n"))).toBe(true);
    // Codex's other keys may differ; it starts "r retry" then "f fork".
    expect(codexLockShown([lockRow, helpRow, "   r retry   f fork"].join("\n"))).toBe(true);
    expect(codexResumeScreen(locked)).toBe("locked");
  });

  it("quoted inside a reply (Codex's box and footer under it): not the lock screen", () => {
    const quoted = ["• Codex showed this:", "", lockRow, helpRow, keysRow, "", "\u{203A} Ask Codex to do anything", "", footer].join("\n");
    expect(codexLockShown(quoted)).toBe(false);
    expect(codexResumeScreen(quoted)).toBe("prompt");
    // Quoted with a bullet or a quote mark: not the rows.
    expect(codexLockShown(["• This conversation is open in another app", helpRow, keysRow].join("\n"))).toBe(false);
    expect(codexLockShown(["> This conversation is open in another app", "> Close it there and press R to continue here.", `> ${keysRow.trim()}`].join("\n"))).toBe(false);
  });

  it("a partial frame: not the lock screen", () => {
    expect(codexLockShown([shellLine, lockRow, helpRow, ""].join("\n"))).toBe(false);
    expect(codexLockShown([shellLine, lockRow, keysRow].join("\n"))).toBe(false);
    expect(codexLockShown([shellLine, helpRow, keysRow].join("\n"))).toBe(false);
    expect(codexLockShown([lockRow, "", helpRow, keysRow].join("\n"))).toBe(false);
    expect(codexLockShown(keysRow)).toBe(false);
    expect(codexLockShown("")).toBe(false);
    expect(codexLockShown([lockRow, "      Close it there and press R to", keysRow].join("\n"))).toBe(false);
  });

  it("text after it, or between its rows: not the lock screen", () => {
    expect(codexLockShown([lockRow, helpRow, keysRow, "", "guest@mini hello-app % "].join("\n"))).toBe(false);
    expect(codexLockShown([lockRow, helpRow, keysRow, "  r"].join("\n"))).toBe(false);
    expect(codexLockShown([lockRow, helpRow, "  something else", keysRow].join("\n"))).toBe(false);
    expect(codexLockShown([`${lockRow} and more`, helpRow, keysRow].join("\n"))).toBe(false);
    expect(codexLockShown([lockRow, `${helpRow} Or not.`, keysRow].join("\n"))).toBe(false);
  });

  it("another key row: not the lock screen", () => {
    expect(codexLockShown([lockRow, helpRow, "   r retry   q quit"].join("\n"))).toBe(false);
    expect(codexLockShown([lockRow, helpRow, "   f fork   r retry"].join("\n"))).toBe(false);
    expect(codexLockShown([lockRow, helpRow, "   r retry"].join("\n"))).toBe(false);
    expect(codexLockShown([lockRow, helpRow, "   R retry   f fork"].join("\n"))).toBe(false);
    expect(codexLockShown([lockRow, helpRow, "   r retry   f forked"].join("\n"))).toBe(false);
    expect(codexLockShown([lockRow, helpRow, "   r retry   f fork and more"].join("\n"))).toBe(false);
  });

  it("the resumed screen: the prompt, or nothing known", () => {
    expect(codexResumeScreen(prompt)).toBe("prompt");
    expect(codexResumeScreen(starting)).toBeNull();
    expect(codexResumeScreen("")).toBeNull();
    // An old box above the shell's line (scrollback) is not the resumed prompt.
    expect(codexResumeScreen(["\u{203A} /exit", footer, shellLine].join("\n"))).toBeNull();
  });
});

interface ResumeOptions {
  /** The screens after the resume, one per read (the last one stays). */
  screens?: string[];
  /** The resumed agent as Herdr shows it (Codex with no session yet by default). */
  resumed?: PaneState;
}

/** A fake Codex that takes /exit with its first Return, then is resumed into `screens`. */
function fakeResume(options: ResumeOptions = {}) {
  const writes: unknown[][] = [];
  const at: number[] = [];
  let clock = 1_000_000;
  let state: PaneState = codex;
  let phase: "running" | "leaving" | "resumed" = "running";
  let reads = 0;
  const screens = options.screens ?? [locked, locked, locked, prompt];
  const machine = {
    run: { connection: 3, arrival: 1 } as { connection: number; arrival: number } | null,
    inputs: [0, 0, 0],
    resumed: options.resumed ?? resumedNoSession,
    onRead: (_reads: number) => undefined as void,
    refuseR: false,
  };
  const notes: string[] = [];
  const site: RestartSite = {
    writer: {
      sendText: async (pane, text) => void writes.push(["sendText", pane, text]),
      agentKeys: async (pane, keys) => {
        writes.push(["agentKeys", pane, [...keys]]);
        at.push(clock);
        if (keys[0] === "r" && machine.refuseR) throw new Error("refused");
        if (phase === "running") phase = "leaving";
      },
      sendInput: async (pane, text, keys) => {
        writes.push(["sendInput", pane, text, [...keys]]);
        phase = "resumed";
        machine.run = { connection: 3, arrival: 2 };
      },
    },
    machine: "Mac mini",
    fresh: async () => {
      state = phase === "running" ? codex : phase === "leaving" ? shellState(codex.pane?.terminalID) : machine.resumed;
      if (phase === "leaving") machine.run = null;
      return true;
    },
    pane: () => state.pane,
    agent: () => state.agent,
    identity: () => ({ incarnation: 1, connection: 3, epoch: 7 }),
    snapshotEpoch: () => 7,
    startCommands: async () => startCommandsWith({ type: "read" }, { claude: "cl" }),
    read: async () => {
      if (phase !== "resumed") throw new Error("read before the resume");
      const screen = screens[Math.min(reads, screens.length - 1)]!;
      reads += 1;
      machine.onRead(reads);
      return screen;
    },
    entry: () => true,
    run: () => machine.run,
    inputs: () => [...machine.inputs],
    note: (text) => void notes.push(text),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const afterResume = (): unknown[][] => writes.slice(writes.findIndex((write) => write[0] === "sendInput") + 1);
  const rKeys = (): number => afterResume().filter((write) => write[0] === "agentKeys").length;
  return { site, writes, machine, notes, afterResume, rKeys, reads: () => reads, at, clock: () => clock, setState: (next: PaneState) => (state = next) };
}

const lockWait = "Codex is still holding this conversation in its background service. Adari retries every 15 seconds for up to 5 minutes.";
const lockGaveUp = "Not resumed yet: Codex says this conversation is open in another app. Press R in its terminal to retry.";

describe("the resume lands on the lock screen", () => {
  it("the texts are the lock wait's own words, with no em dash", () => {
    expect(restartTexts.lockWait("Codex")).toBe(lockWait);
    expect(restartTexts.lockGaveUp("Codex")).toBe(lockGaveUp);
    for (const text of [lockWait, lockGaveUp, restartTexts.lockStopped("Codex", lockStopReasons.typed("Codex"))]) expect(text).not.toContain("\u{2014}");
  });

  it("locked for three reads, then the prompt: the note, one r per still-locked read after the first wait, then the normal result", async () => {
    const m = fakeResume({ screens: [locked, locked, locked, prompt] });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.notes).toEqual([lockWait]);
    expect(m.reads()).toBe(4);
    // Before the resume: /exit and one Return; after it: only `r`, twice (reads 2 and 3 were still locked).
    expect(m.writes.slice(0, 3)).toEqual([
      ["sendText", "w1:p1", "/exit"],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["sendInput", "w1:p1", resume, ["Enter"]],
    ]);
    expect(m.afterResume()).toEqual([
      ["agentKeys", "w1:p1", ["r"]],
      ["agentKeys", "w1:p1", ["r"]],
    ]);
    // 15 s apart.
    expect(m.at[2]! - m.at[1]!).toBe(restartLockRetryMs);
  });

  it("locked for one read, then the prompt: the note, no key", async () => {
    const m = fakeResume({ screens: [locked, prompt] });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.notes).toEqual([lockWait]);
    expect(m.rKeys()).toBe(0);
  });

  it("the shell's line first, then the lock, then the prompt: the wait starts at the lock", async () => {
    const m = fakeResume({ screens: [starting, starting, locked, locked, prompt] });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.notes).toEqual([lockWait]);
    expect(m.afterResume()).toEqual([["agentKeys", "w1:p1", ["r"]]]);
  });

  it("the prompt straight after the resume: no note, no key, one read", async () => {
    const m = fakeResume({ screens: [prompt] });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.notes).toEqual([]);
    expect(m.rKeys()).toBe(0);
    expect(m.reads()).toBe(1);
  });

  it("neither the prompt nor the lock within the watch: the normal result, no key", async () => {
    const m = fakeResume({ screens: [starting] });
    const start = m.clock();
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.notes).toEqual([]);
    expect(m.rKeys()).toBe(0);
    expect(m.clock() - start).toBeLessThanOrEqual(restartResumeWatchMs + 2_000);
  });

  it("an unread screen (the read fails) during the wait: no key that round", async () => {
    const m = fakeResume({ screens: [locked, locked, prompt] });
    const read = m.site.read!;
    let count = 0;
    m.site.read = async () => {
      count += 1;
      if (count === 2) throw new Error("no screen");
      return await read();
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.afterResume()).toEqual([["agentKeys", "w1:p1", ["r"]]]);
  });

  it("another screen between two locked reads: no key on it", async () => {
    const m = fakeResume({ screens: [locked, starting, locked, prompt] });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.afterResume()).toEqual([["agentKeys", "w1:p1", ["r"]]]);
  });

  it("Herdr shows no agent in the pane yet when the lock first shows: it looks again, then waits", async () => {
    const m = fakeResume({ screens: [locked, locked, locked, prompt] });
    const resumed = m.machine.resumed;
    m.machine.resumed = shellState(codex.pane?.terminalID);
    m.machine.onRead = (reads) => {
      if (reads === 1) m.machine.resumed = resumed;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.notes).toEqual([lockWait]);
    expect(m.afterResume()).toEqual([["agentKeys", "w1:p1", ["r"]]]);
  });

  it("Herdr already names the same session: the wait goes on as with none", async () => {
    const m = fakeResume({ screens: [locked, locked, prompt], resumed: codex });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.afterResume()).toEqual([["agentKeys", "w1:p1", ["r"]]]);
  });
});

describe("the wait stops with no key", () => {
  it.each([
    ["the user's Terminal typing", 0],
    ["a composer write", 1],
    ["a box mark", 2],
  ])("%s during the wait: no key, and the note says so", async (_name, which) => {
    const m = fakeResume({ screens: [locked] });
    m.machine.onRead = (reads) => {
      if (reads === 2) m.machine.inputs[which]! += 1;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.lockStopped("Codex", lockStopReasons.typed("Codex")));
    expect(m.rKeys()).toBe(0);
    expect(m.notes).toEqual([lockWait]);
  });

  it("typing during the read that showed the lock again: that read gets no key", async () => {
    const m = fakeResume({ screens: [locked] });
    m.machine.onRead = (reads) => {
      if (reads === 3) m.machine.inputs[0]! += 1;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.lockStopped("Codex", lockStopReasons.typed("Codex")));
    // Read 2 got its `r`; read 3 (typing during it) none, and the wait ended.
    expect(m.afterResume()).toEqual([["agentKeys", "w1:p1", ["r"]]]);
  });

  it("typing before the lock showed (since the restart began): no wait, no key", async () => {
    const m = fakeResume({ screens: [locked] });
    const sendInput = m.site.writer.sendInput;
    m.site.writer.sendInput = async (pane, text, keys) => {
      await sendInput(pane, text, keys);
      m.machine.inputs[0]! += 1;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.lockStopped("Codex", lockStopReasons.typed("Codex")));
    expect(m.rKeys()).toBe(0);
    expect(m.notes).toEqual([]);
  });

  it("another run in the pane during the wait: no key", async () => {
    const m = fakeResume({ screens: [locked] });
    m.machine.onRead = (reads) => {
      if (reads === 2) m.machine.run = { connection: 3, arrival: 3 };
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.lockStopped("Codex", lockStopReasons.otherAgent));
    expect(m.rKeys()).toBe(0);
  });

  it("a dialog during the wait: no key", async () => {
    const m = fakeResume({ screens: [locked] });
    m.machine.onRead = (reads) => {
      if (reads === 2) m.setState(agentState({ kind: "codex", session: null, pending: true }));
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.lockStopped("Codex", lockStopReasons.waiting("Codex")));
    expect(m.rKeys()).toBe(0);
  });

  it("Herdr reports blocked on the next snapshot: no key", async () => {
    const m = fakeResume({ screens: [locked] });
    m.machine.onRead = (reads) => {
      if (reads === 1) m.machine.resumed = agentState({ kind: "codex", session: null, status: "blocked" });
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.lockStopped("Codex", lockStopReasons.waiting("Codex")));
    expect(m.rKeys()).toBe(0);
  });

  it("another session, another agent kind, another terminal, the pane gone: no key", async () => {
    const other = { source: "herdr:codex", agent: "codex", kind: "id", value: "11111111-2222-3333-4444-555555555555" };
    for (const [next, why] of [
      [agentState({ kind: "codex", session: other }), lockStopReasons.otherAgent],
      [agentState({ kind: "claude", session: null }), lockStopReasons.otherAgent],
      [agentState({ kind: "codex", session: null, terminal: "t-9" }), lockStopReasons.otherTerminal],
      [{ pane: null, agent: null }, lockStopReasons.paneGone],
    ] as const) {
      const m = fakeResume({ screens: [locked] });
      m.machine.onRead = (reads) => {
        if (reads === 1) m.machine.resumed = next;
      };
      expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.lockStopped("Codex", why));
      expect(m.rKeys()).toBe(0);
    }
  });

  it("the connection changed, or the machine's entry replaced: no key", async () => {
    const a = fakeResume({ screens: [locked] });
    a.machine.onRead = (reads) => {
      if (reads === 2) a.site.identity = () => ({ incarnation: 1, connection: 4, epoch: 7 });
    };
    expect(await restartAgent(a.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.lockStopped("Codex", lockStopReasons.connectionChanged("Mac mini")));
    expect(a.rKeys()).toBe(0);
    const b = fakeResume({ screens: [locked] });
    b.machine.onRead = (reads) => {
      if (reads === 2) b.site.entry = () => false;
    };
    expect(await restartAgent(b.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.lockStopped("Codex", lockStopReasons.connectionChanged("Mac mini")));
    expect(b.rKeys()).toBe(0);
  });

  it("Herdr refuses the `r`: one try, then the note, no other key", async () => {
    const m = fakeResume({ screens: [locked] });
    m.machine.refuseR = true;
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.lockStopped("Codex", lockStopReasons.refused));
    expect(m.afterResume()).toEqual([["agentKeys", "w1:p1", ["r"]]]);
  });

  it("a snapshot that did not come: no key that round", async () => {
    const m = fakeResume({ screens: [locked, locked, locked, prompt] });
    const fresh = m.site.fresh;
    let calls = 0;
    m.site.fresh = async () => {
      calls += 1;
      const ok = await fresh();
      return m.reads() === 1 && calls > 2 ? false : ok;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.afterResume()).toEqual([["agentKeys", "w1:p1", ["r"]]]);
  });
});

describe("still locked at 5 minutes", () => {
  it("the lasting note, and no key after it; never another key", async () => {
    const m = fakeResume({ screens: [locked] });
    let lockAt = 0;
    m.machine.onRead = (reads) => {
      if (reads === 1) lockAt = m.clock();
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(lockGaveUp);
    expect(m.notes).toEqual([lockWait]);
    const keys = m.afterResume();
    expect(keys.every((write) => JSON.stringify(write) === JSON.stringify(["agentKeys", "w1:p1", ["r"]]))).toBe(true);
    // One `r` every 15 s, all before the 5 minutes ran out: 19 of them.
    expect(keys).toHaveLength(restartLockWaitMs / restartLockRetryMs - 1);
    const rTimes = m.at.slice(1);
    expect(rTimes.every((time) => time < lockAt + restartLockWaitMs)).toBe(true);
    expect(m.clock() - lockAt).toBe(restartLockWaitMs);
  });

  it("the prompt on the last read at 5 minutes: the normal result", async () => {
    // The first read, then one every 15 s before the 5 minutes: locked; the read at 5 minutes: the prompt.
    const screens = Array<string>(restartLockWaitMs / restartLockRetryMs).fill(locked);
    screens.push(prompt);
    const m = fakeResume({ screens });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.rKeys()).toBe(restartLockWaitMs / restartLockRetryMs - 1);
  });
});

describe("only Codex is read after the resume", () => {
  it("Claude Code: no read, the restart ends as usual", async () => {
    const claude = agentState();
    const m = fakeResume({ screens: [locked] });
    m.machine.resumed = claude;
    const fresh = m.site.fresh;
    m.site.fresh = async () => {
      await fresh();
      m.setState(m.writes.some((write) => write[0] === "agentKeys") ? (m.writes.some((write) => write[0] === "sendInput") ? claude : shellState()) : claude);
      return true;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(claude, "Claude Code"))).toBeNull();
    expect(m.reads()).toBe(0);
    expect(m.rKeys()).toBe(0);
    expect(m.writes.at(-1)).toEqual(["sendInput", "w1:p1", `cl --resume ${claudeID}`, ["Enter"]]);
  });
});

describe("the page", () => {
  it("main's note replaces Restarting… while the restart runs, and how it ended stays", async () => {
    const restarts = new AgentRestarts();
    let listener: ((event: RestartNoteEvent) => void) | null = null;
    restarts.attach({
      onRestartNote: (next) => {
        listener = next;
        return () => (listener = null);
      },
    });
    let finish: (note: string | null) => void = () => undefined;
    restarts.restart("mac|w1:p1", () => new Promise((resolve) => (finish = resolve)), "Restarting Codex\u{2026}");
    expect(restarts.state("mac|w1:p1")).toEqual({ busy: true, note: "Restarting Codex\u{2026}" });
    listener!({ hostId: "mac", paneId: "w1:p1", note: lockWait });
    expect(restarts.state("mac|w1:p1")).toEqual({ busy: true, note: lockWait });
    // Another pane's note: not this one's.
    listener!({ hostId: "mac", paneId: "w1:p2", note: lockWait });
    expect(restarts.state("mac|w1:p2")).toEqual({ busy: false, note: null });
    finish(lockGaveUp);
    await Promise.resolve();
    await Promise.resolve();
    expect(restarts.state("mac|w1:p1")).toEqual({ busy: false, note: lockGaveUp });
    // A late note after it ended: ignored.
    listener!({ hostId: "mac", paneId: "w1:p1", note: lockWait });
    expect(restarts.state("mac|w1:p1").note).toBe(lockGaveUp);
    restarts.attach(null);
    expect(listener).toBeNull();
  });

  it("a lock note means the resume went: the pane's held bubbles stay held until Codex is back", async () => {
    const ended: boolean[] = [];
    const holds = { hold: () => undefined, ended: (_key: string, resumed: boolean) => void ended.push(resumed) };
    const host = { id: "mac", topology: null, incarnation: 1, connection: 3, epoch: 7 };
    for (const note of [lockGaveUp, restartTexts.lockStopped("Codex", lockStopReasons.typed("Codex")), null, restartTexts.didNotExit("Codex")]) {
      const restarts = new AgentRestarts();
      restartHeld(restarts, holds as never, host as never, "w1:p1", "Codex", async () => note);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(ended).toEqual([true, true, true, false]);
  });

  it("a second Restart right after the resume, before Codex reports its session: refused", () => {
    expect(restartSessionKnown("codex", null)).toBe(false);
    expect(
      restartDisabledReason({ isAgent: true, status: "idle", dialog: false, online: true, sessionKnown: false, busy: false, name: "Codex", machine: "Mac mini" }),
    ).toBe("No session id known to resume");
  });
});

describe("the restart IPC tells the page the lock note while it waits", () => {
  it("through pane.read: the note on the page, `r` while locked, then the normal result", async () => {
    const { registerIpc } = await import("../src/main/ipc");
    const { APP_ORIGIN } = await import("../src/main/protocol");
    const writes: unknown[][] = [];
    const told: unknown[][] = [];
    let state = codex;
    let phase: "running" | "leaving" | "resumed" = "running";
    let reads = 0;
    const screens = [locked, locked, prompt];
    const backend = {
      sendText: async (pane: string, text: string) => void writes.push(["sendText", pane, text]),
      agentKeys: async (pane: string, keys: readonly string[]) => {
        writes.push(["agentKeys", pane, [...keys]]);
        if (phase === "running") phase = "leaving";
      },
      sendInput: async (pane: string, text: string, keys: readonly string[]) => {
        writes.push(["sendInput", pane, text, [...keys]]);
        phase = "resumed";
      },
      readStartCommandsFile: async () => null,
      promptIO: () => ({
        paneRead: async () => {
          if (phase !== "resumed") return "";
          return screens[Math.min(reads++, screens.length - 1)]!;
        },
        paneSendKeys: async () => undefined,
      }),
    };
    const hosts = {
      backend: () => backend,
      name: () => "Mac mini",
      pane: () => state.pane,
      agent: () => state.agent,
      connection: () => 3,
      connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
      snapshotEpoch: () => 7,
      run: () => (phase === "resumed" ? { connection: 3, arrival: 2 } : { connection: 3, arrival: 1 }),
      refresh: async () => undefined,
      fresh: async () => {
        state = phase === "running" ? codex : phase === "leaving" ? shellState() : resumedNoSession;
        return true;
      },
    };
    registerIpc({ hosts } as never);
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1, isDestroyed: () => false, send: (channel: string, value: unknown) => void told.push([channel, value]) } };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const answer = registered.handles.get(IPC.paneRestart)!(event, "mac-mini", "w1:p1", bindingFor(codex, "Codex")) as Promise<string | null>;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await answer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(told).toEqual([[IPC.paneRestartNote, { hostId: "mac-mini", paneId: "w1:p1", note: lockWait }]]);
    expect(writes).toEqual([
      ["sendText", "w1:p1", "/exit"],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["sendInput", "w1:p1", resume, ["Enter"]],
      ["agentKeys", "w1:p1", ["r"]],
    ]);
  });
});
