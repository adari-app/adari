// Restart on Codex 0.167.0, which can keep a typed `/exit` in
// its input row after the Return (its slash list takes it). While Codex has
// not left, its screen is read; with the row holding exactly `/exit` and
// nothing else, one more Return goes, once, under the first one's checks
// (the machine's entry, the connection, the pane, terminal, agent, session
// and run, no dialog). Anything else in the row, or a dialog: no key and a
// note; giving up with `/exit` still typed, the note says so. A fake Codex,
// fake screens, a fake clock; Claude Code and Grok keep their one Return.

import { describe, expect, it, vi } from "vitest";

import { restartAgent, type RestartSite } from "../src/main/herdr/restart";
import { codexExitRow, exitRowKinds, restartTexts } from "../src/shared/agent-restart";
import { IPC } from "../src/shared/ipc-contract";
import { startCommandsWith } from "../src/shared/start-commands";
import { agentState, bindingFor, claudeID, grokID, shellState, type PaneState } from "./support/restart-machine";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const codexSession = { source: "herdr:codex", agent: "codex", kind: "id", value: claudeID };
const codex = agentState({ kind: "codex", session: codexSession });
const resume = `codex resume ${claudeID} --no-daemon`;

/** A frame read from Codex 0.167.0: `/exit` in the row after the Return, not run. */
const stuck = ["• hello", "", "  Worked for 8s \u{2022} 8:53 PM", "\u{203A} /exit", "  GPT-6.1-Sol default \u{B7} ~/code/hello-app \u{B7} Reply exactly hello"].join("\n");
/** The same with its slash list open under the row (the selected row marked), the footer the last row. */
const stuckList = ["• hello", "", "\u{203A} /exit", "  \u{203A} /exit    exit Codex", "    /quit    exit Codex", "", "  gpt-6.1-sol default \u{B7} ~/code/hello-app"].join("\n");
/** The row empty again (its placeholder): it took the /exit. */
const cleared = ["• hello", "", "\u{203A} Ask Codex to do anything", "", "  gpt-6.1-sol default \u{B7} ~/code/hello-app", "  ? for shortcuts"].join("\n");
/** `/exit` and other text in the row. */
const withText = ["• hello", "", "\u{203A} /exit and then fix the tests", "", "  gpt-6.1-sol default \u{B7} ~/code/hello-app"].join("\n");
/** `/exit` and the user's draft's next row under it. */
const withDraftRow = ["• hello", "", "\u{203A} /exit", "  fix the tests too", "", "  gpt-6.1-sol default \u{B7} ~/code/hello-app"].join("\n");
/** The user's draft before the typed `/exit`. */
const draftFirst = ["• hello", "", "\u{203A} fix the tests/exit", "", "  gpt-6.1-sol default \u{B7} ~/code/hello-app"].join("\n");
/** An approval over the box (no row at the margin is the box). */
const dialog = ["• I want to run a command", "", "  Would you like to run the following command?", "", "  $ rm -rf build", "", "\u{203A} 1. Yes, proceed", "  2. No, and tell Codex what to do differently", "", "  Press enter to confirm or esc to cancel"].join("\n");

interface CodexOptions {
  /** The Return that makes it leave (null: it never does). */
  exitsOn?: number | null;
  /** Its screen while it runs, after `returns` Returns. */
  screen?: (returns: number) => string;
  /** What the pane shows after `returns` Returns while it runs (the agent as it was by default). */
  state?: (returns: number) => PaneState;
  kind?: PaneState;
  /** No screen to read (the backend has no pane.read). */
  unreadable?: boolean;
}

/** A fake Codex: its writes, its snapshots, its screen, its clock. */
function fakeCodex(options: CodexOptions = {}) {
  const start = options.kind ?? codex;
  const writes: unknown[][] = [];
  let clock = 1_000_000;
  let state = start;
  let returns = 0;
  let leaving = false;
  let reads = 0;
  const machine = { entry: true, run: { connection: 3, arrival: 1 } as { connection: number; arrival: number } | null };
  const exitsOn = options.exitsOn === undefined ? 2 : options.exitsOn;
  const site: RestartSite = {
    writer: {
      sendText: async (pane, text) => void writes.push(["sendText", pane, text]),
      agentKeys: async (pane, keys) => {
        writes.push(["agentKeys", pane, [...keys]]);
        if (keys.includes("Enter")) returns += 1;
        if (exitsOn !== null && returns >= exitsOn) leaving = true;
      },
      sendInput: async (pane, text, keys) => void writes.push(["sendInput", pane, text, [...keys]]),
    },
    machine: "Mac mini",
    fresh: async () => {
      state = leaving ? shellState(start.pane?.terminalID) : (options.state?.(returns) ?? start);
      return true;
    },
    pane: () => state.pane,
    agent: () => state.agent,
    identity: () => ({ incarnation: 1, connection: 3, epoch: 7 }),
    snapshotEpoch: () => 7,
    startCommands: async () => startCommandsWith({ type: "read" }, { claude: "cl" }),
    ...(options.unreadable === true
      ? {}
      : {
          read: async () => {
            reads += 1;
            return options.screen?.(returns) ?? (returns === 0 ? cleared : stuck);
          },
        }),
    entry: () => machine.entry,
    run: () => machine.run,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const enters = (): number => writes.filter((write) => write[0] === "agentKeys").length;
  return { site, writes, machine, enters, reads: () => reads, elapsed: () => clock - 1_000_000 };
}

describe("Codex's input row (codexExitRow)", () => {
  it("the frame read from Codex: exactly /exit, the footer right under it", () => {
    expect(codexExitRow(stuck)).toBe("exit");
  });
  it("exactly /exit with its slash list open and the footer a blank row below", () => {
    expect(codexExitRow(stuckList)).toBe("exit");
  });
  it("/exit with other text, in the row or on the user's draft's next row: typed, never exit", () => {
    expect(codexExitRow(withText)).toBe("typed");
    expect(codexExitRow(withDraftRow)).toBe("typed");
    expect(codexExitRow(draftFirst)).toBe("typed");
  });
  it("the placeholder: clear; a dialog, a shell or nothing: no row", () => {
    expect(codexExitRow(cleared)).toBe("clear");
    expect(codexExitRow(dialog)).toBeNull();
    expect(codexExitRow("demo@mini hello-app % ")).toBeNull();
    expect(codexExitRow("")).toBeNull();
  });
  it("only Codex is read (Claude Code and Grok keep their one Return; Cursor has no Restart)", () => {
    expect([...exitRowKinds]).toEqual(["codex"]);
  });
});

describe("Restart on a Codex that keeps /exit typed after the first Return", () => {
  it("one more Return runs it: Codex exits and resumes, exactly one extra Return", async () => {
    const m = fakeCodex({ exitsOn: 2 });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.writes).toEqual([
      ["sendText", "w1:p1", "/exit"],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["sendInput", "w1:p1", resume, ["Enter"]],
    ]);
  });

  it("the same with its slash list open under the row", async () => {
    const m = fakeCodex({ exitsOn: 2, screen: () => stuckList });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.enters()).toBe(2);
    expect(m.writes.at(-1)).toEqual(["sendInput", "w1:p1", resume, ["Enter"]]);
  });

  it("a Codex that takes the first Return: no extra Return", async () => {
    const m = fakeCodex({ exitsOn: 1 });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.enters()).toBe(1);
  });

  it("never more than one extra: a Codex that keeps /exit after both gives up with the note naming /exit", async () => {
    const m = fakeCodex({ exitsOn: null });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe("Not restarted: Codex did not exit. /exit is still typed in its terminal.");
    expect(m.enters()).toBe(2);
    expect(m.writes.some((write) => write[0] === "sendInput")).toBe(false);
    expect(m.elapsed()).toBeGreaterThanOrEqual(20_000);
  });

  it("/exit plus other text in the row: no extra Return, and the note says /exit is still typed", async () => {
    for (const screen of [withText, withDraftRow, draftFirst]) {
      const m = fakeCodex({ exitsOn: 2, screen: () => screen });
      expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.exitTyped("Codex"));
      expect(m.enters()).toBe(1);
    }
  });

  it("a dialog Herdr reports after the Return: no extra Return, the note says it waits for an answer", async () => {
    const m = fakeCodex({ exitsOn: 2, state: (returns) => (returns === 0 ? codex : agentState({ kind: "codex", session: codexSession, pending: true })) });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe("Not restarted: Codex is waiting for an answer");
    expect(m.enters()).toBe(1);
  });

  it("a dialog on its screen only: no extra Return, and the did-not-exit note at the limit", async () => {
    const m = fakeCodex({ exitsOn: 2, screen: () => dialog });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.didNotExit("Codex"));
    expect(m.enters()).toBe(1);
  });

  it("a Codex that never exits with its row clear: the did-not-exit note, no extra Return", async () => {
    const m = fakeCodex({ exitsOn: null, screen: () => cleared });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe("Not restarted: Codex did not exit");
    expect(m.enters()).toBe(1);
    expect(m.reads()).toBeGreaterThanOrEqual(2);
  });

  it("no screen to read: one Return and the did-not-exit note", async () => {
    const m = fakeCodex({ exitsOn: null, unreadable: true });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.didNotExit("Codex"));
    expect(m.enters()).toBe(1);
  });
});

describe("the extra Return goes under the first one's checks", () => {
  const stopsAt = async (change: (m: ReturnType<typeof fakeCodex>) => void, note: string) => {
    const m = fakeCodex({ exitsOn: 2 });
    const read = m.site.read!;
    m.site.read = async () => {
      const screen = await read();
      change(m);
      return screen;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(note);
    expect(m.enters()).toBe(1);
    expect(m.writes.some((write) => write[0] === "sendInput")).toBe(false);
  };

  it("the machine's entry replaced while the screen was read: no key", async () => {
    await stopsAt((m) => {
      m.machine.entry = false;
    }, restartTexts.connectionChanged("Mac mini"));
  });

  it("another run of the agent in the pane: no key", async () => {
    await stopsAt((m) => {
      m.machine.run = { connection: 3, arrival: 2 };
    }, restartTexts.otherAgent);
  });

  it("another agent, terminal or session in the pane: no key", async () => {
    const other = agentState({ kind: "codex", session: { ...codexSession, value: "1c2d3e4f-0000-4000-8000-000000000000" } });
    const m = fakeCodex({ exitsOn: 2, state: (returns) => (returns === 0 ? codex : other) });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.otherAgent);
    expect(m.enters()).toBe(1);
  });

  it("the first Return checks the machine's entry and the run too", async () => {
    const m = fakeCodex({ exitsOn: 1 });
    const sendText = m.site.writer.sendText;
    m.site.writer.sendText = async (pane, text) => {
      await sendText(pane, text);
      m.machine.run = null;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.otherAgent);
    expect(m.enters()).toBe(0);
  });
});

describe("Claude Code and Grok keep their one Return", () => {
  it.each([
    ["Claude Code", agentState(), `cl --resume ${claudeID}`],
    ["Grok", agentState({ kind: "grok", session: { source: "herdr:grok", agent: "grok", kind: "id", value: grokID } }), `grok --resume ${grokID}`],
  ])("%s: its screen is never read for an extra Return", async (name, state, line) => {
    const m = fakeCodex({ kind: state, exitsOn: 1 });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(state, name))).toBeNull();
    expect(m.reads()).toBe(0);
    expect(m.writes).toEqual([
      ["sendText", "w1:p1", "/exit"],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["sendInput", "w1:p1", line, ["Enter"]],
    ]);
  });

  it("a Claude Code that never exits: one Return and the plain did-not-exit note", async () => {
    const m = fakeCodex({ kind: agentState(), exitsOn: null });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(agentState(), "Claude Code"))).toBe(restartTexts.didNotExit("Claude Code"));
    expect(m.enters()).toBe(1);
    expect(m.reads()).toBe(0);
  });
});

describe("the restart IPC reads Codex's screen through the pane's pane.read", () => {
  it("the stuck /exit gets its one extra Return and Codex resumes", async () => {
    const { registerIpc } = await import("../src/main/ipc");
    const { APP_ORIGIN } = await import("../src/main/protocol");
    const writes: unknown[][] = [];
    let state = codex;
    let returns = 0;
    const backend = {
      sendText: async (pane: string, text: string) => void writes.push(["sendText", pane, text]),
      agentKeys: async (pane: string, keys: readonly string[]) => {
        writes.push(["agentKeys", pane, [...keys]]);
        returns += 1;
      },
      sendInput: async (pane: string, text: string, keys: readonly string[]) => void writes.push(["sendInput", pane, text, [...keys]]),
      readStartCommandsFile: async () => null,
      promptIO: () => ({
        paneRead: async (pane: string, lines: number) => {
          writes.push(["paneRead", pane, lines]);
          return stuck;
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
      run: () => ({ connection: 3, arrival: 1 }),
      refresh: async () => undefined,
      fresh: async () => {
        if (returns >= 2) state = shellState();
        return true;
      },
    };
    registerIpc({ hosts } as never);
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const answer = registered.handles.get(IPC.paneRestart)!(event, "mac-mini", "w1:p1", bindingFor(codex, "Codex")) as Promise<string | null>;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await answer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(writes.filter((write) => write[0] !== "paneRead")).toEqual([
      ["sendText", "w1:p1", "/exit"],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["sendInput", "w1:p1", resume, ["Enter"]],
    ]);
    // The second read is after the resume (Codex's prompt there: done).
    expect(writes.filter((write) => write[0] === "paneRead")).toEqual([
      ["paneRead", "w1:p1", 60],
      ["paneRead", "w1:p1", 60],
    ]);
  });
});
