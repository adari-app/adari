// Restart on Codex: the extra Return after a typed `/exit` goes only for a
// screen whose whole bottom proves it, never after any input to the pane since
// the restart began, and only to the run the page showed at the click. Fake
// Codex, fake screens, a fake clock; the IPC tests run the real handler with
// the real PaneInputs counter and composer-write marks.

import { describe, expect, it, vi } from "vitest";

import { boxChecks, composerWrites } from "../src/main/herdr/claude-box";
import { restartAgent, type RestartSite } from "../src/main/herdr/restart";
import { PaneInputs } from "../src/main/pane-inputs";
import { restartBindingOf } from "../src/renderer/components/restart";
import { codexExitRow, isRestartBinding, restartTexts, type RestartBinding } from "../src/shared/agent-restart";
import { IPC } from "../src/shared/ipc-contract";
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
const resume = `codex resume ${claudeID} --no-daemon`;

const footer = "  GPT-6.1-Sol default \u{B7} ~/code/hello-app \u{B7} Reply exactly hello";
const frame = (...rows: string[]): string => ["• hello", "", "  Worked for 8s \u{2022} 8:53 PM", ...rows].join("\n");
/** The recorded frame (Codex 0.167.0, the clean-home test): `/exit` in the row, the footer right under it, the last row. */
const recorded = frame("\u{203A} /exit", footer);
/** Its slash list open, `/exit` selected. */
const listExit = frame("\u{203A} /exit", "  \u{203A} /exit    exit Codex", "    /quit    exit Codex", "", footer);

describe("the extra Return only for a screen that proves /exit", () => {
  it("the recorded frame and a list selecting /exit stay exit", () => {
    expect(codexExitRow(recorded)).toBe("exit");
    expect(codexExitRow(listExit)).toBe("exit");
    expect(codexExitRow(frame("\u{203A} /exit", "  GPT-6.1-Sol default \u{B7} ~/code/hello-app"))).toBe("exit");
    expect(codexExitRow(`${recorded}\n\n`)).toBe("exit");
  });

  it("a wrapped draft with a row that looks like a footer: typed, never exit", () => {
    expect(codexExitRow(frame("\u{203A} /exit", "  notes \u{B7} keep this draft", "  still my draft", footer))).toBe("typed");
    expect(codexExitRow(frame("\u{203A} /exit", "  gpt default \u{B7} ~/code/other", footer))).toBe("typed");
  });

  it("text after the footer: not exit", () => {
    expect(codexExitRow(frame("\u{203A} /exit", footer, "  Continue? Press Enter to approve"))).not.toBe("exit");
    expect(codexExitRow(frame("\u{203A} /exit", footer, "  ? for shortcuts"))).not.toBe("exit");
  });

  it("a bare row cut mid-draw (no footer): not exit", () => {
    expect(codexExitRow("\u{203A} /exit")).not.toBe("exit");
    expect(codexExitRow(frame("\u{203A} /exit", "  GPT-6.1-Sol def"))).not.toBe("exit");
    expect(codexExitRow(frame("\u{203A} /exit", "  \u{203A} /exit    exit Codex"))).not.toBe("exit");
  });

  it("a list with another command selected: typed, never exit", () => {
    expect(codexExitRow(frame("\u{203A} /exit", "  /exit    Exit", "  \u{203A} /help    Show help", footer))).toBe("typed");
    expect(codexExitRow(frame("\u{203A} /exit", "  /help    Show help", "  /exit    Exit", footer))).toBe("typed");
    expect(codexExitRow(frame("\u{203A} /exit", "  \u{203A} /exit    Exit", "  \u{203A} /quit    Exit", footer))).toBe("typed");
    expect(codexExitRow(frame("\u{203A} /exit", "  /exit    Exit", "", "  /quit    Exit", footer))).toBe("typed");
    // An unmarked list proves nothing, even one row of /exit.
    expect(codexExitRow(frame("\u{203A} /exit", "  /exit    exit Codex", footer))).toBe("typed");
  });

  it("/exit on the next row of an earlier draft is typed", () => {
    expect(codexExitRow(frame("\u{203A} review my draft", "  /exit", footer))).toBe("typed");
    expect(codexExitRow(frame("\u{203A} Ask Codex to do anything", "", footer))).toBe("clear");
  });
});

interface CodexOptions {
  exitsOn?: number | null;
  screen?: (returns: number) => string;
}

/** A fake Codex: its writes, its snapshots, its screen, its clock, its pane's input counts. */
function fakeCodex(options: CodexOptions = {}) {
  const writes: unknown[][] = [];
  let clock = 1_000_000;
  let state: PaneState = codex;
  let returns = 0;
  let leaving = false;
  const machine = { run: { connection: 3, arrival: 1 } as { connection: number; arrival: number } | null, inputs: [0, 0, 0] };
  const exitsOn = options.exitsOn === undefined ? 2 : options.exitsOn;
  const site: RestartSite = {
    writer: {
      sendText: async (pane, text) => void writes.push(["sendText", pane, text]),
      agentKeys: async (pane, keys) => {
        writes.push(["agentKeys", pane, [...keys]]);
        returns += 1;
        if (exitsOn !== null && returns >= exitsOn) leaving = true;
      },
      sendInput: async (pane, text, keys) => void writes.push(["sendInput", pane, text, [...keys]]),
    },
    machine: "Mac mini",
    fresh: async () => {
      state = leaving ? shellState(codex.pane?.terminalID) : codex;
      return true;
    },
    pane: () => state.pane,
    agent: () => state.agent,
    identity: () => ({ incarnation: 1, connection: 3, epoch: 7 }),
    snapshotEpoch: () => 7,
    startCommands: async () => startCommandsWith({ type: "read" }, { claude: "cl" }),
    read: async () => options.screen?.(returns) ?? recorded,
    entry: () => true,
    run: () => machine.run,
    inputs: () => [...machine.inputs],
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const enters = (): number => writes.filter((write) => write[0] === "agentKeys").length;
  return { site, writes, machine, enters };
}

describe("end to end: no extra Return on a screen that does not prove /exit", () => {
  it.each([
    ["a wrapped draft with a footer-looking row", frame("\u{203A} /exit", "  notes \u{B7} keep this draft", "  still my draft", footer)],
    ["text after the footer", frame("\u{203A} /exit", footer, "  Continue? Press Enter to approve")],
    ["a bare row cut mid-draw", "\u{203A} /exit"],
    ["a list with /help selected", frame("\u{203A} /exit", "  /exit    Exit", "  \u{203A} /help    Show help", footer)],
  ])("%s: one Return, and the note says /exit is still typed", async (_name, screen) => {
    const m = fakeCodex({ exitsOn: 2, screen: () => screen });
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.exitTyped("Codex"));
    expect(m.enters()).toBe(1);
    expect(m.writes.some((write) => write[0] === "sendInput")).toBe(false);
  });

  it("a frame cut mid-draw, then the whole recorded frame: the extra Return goes on the whole one", async () => {
    const m = fakeCodex({ exitsOn: 2 });
    let reads = 0;
    m.site.read = async () => (++reads === 1 ? "\u{203A} /exit" : recorded);
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    // One more read after the resume (Codex's prompt there: done).
    expect(reads).toBe(3);
    expect(m.enters()).toBe(2);
    expect(m.writes.at(-1)).toEqual(["sendInput", "w1:p1", resume, ["Enter"]]);
  });

  it("the recorded frame and a list selecting /exit still restart, with exactly one extra Return", async () => {
    for (const screen of [recorded, listExit]) {
      const m = fakeCodex({ exitsOn: 2, screen: () => screen });
      expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
      expect(m.writes).toEqual([
        ["sendText", "w1:p1", "/exit"],
        ["agentKeys", "w1:p1", ["Enter"]],
        ["agentKeys", "w1:p1", ["Enter"]],
        ["sendInput", "w1:p1", resume, ["Enter"]],
      ]);
    }
  });
});

describe("any input to the pane calls the extra Return off", () => {
  const typedNote = "Not restarted: you typed in Codex's terminal while it was exiting. /exit may still be typed there.";

  it.each([
    ["the user's Terminal typing", 0],
    ["a composer write", 1],
    ["a box mark", 2],
  ])("%s during the screen read: no extra Return, and the note says so", async (_name, which) => {
    const m = fakeCodex({ exitsOn: 2 });
    m.site.read = async () => {
      m.machine.inputs[which]! += 1;
      return recorded;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(typedNote);
    expect(restartTexts.typedMeanwhile("Codex")).toBe(typedNote);
    expect(m.enters()).toBe(1);
    expect(m.writes.some((write) => write[0] === "sendInput")).toBe(false);
  });

  it("typing between /exit and its Return: no Return at all", async () => {
    const m = fakeCodex({ exitsOn: 1 });
    const sendText = m.site.writer.sendText;
    m.site.writer.sendText = async (pane, text) => {
      await sendText(pane, text);
      m.machine.inputs[0]! += 1;
    };
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(typedNote);
    expect(m.enters()).toBe(0);
  });

  it("input counted before the click's restart began does not stop it", async () => {
    const m = fakeCodex({ exitsOn: 2 });
    m.machine.inputs = [5, 2, 9];
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.enters()).toBe(2);
  });
});

/** The real restart IPC handler on a fake backend whose pane.read does `during` and returns the recorded frame. */
async function restartThroughIpc(during: (backend: object, inputs: PaneInputs) => void, binding: RestartBinding = bindingFor(codex, "Codex")) {
  const { registerIpc } = await import("../src/main/ipc");
  const { APP_ORIGIN } = await import("../src/main/protocol");
  const paneInputs = new PaneInputs();
  const submitted: string[] = [];
  let row = "/exit";
  let state: PaneState = codex;
  let returns = 0;
  const writes: unknown[][] = [];
  const backend = {
    sendText: async (pane: string, text: string) => void writes.push(["sendText", pane, text]),
    agentKeys: async (pane: string, keys: readonly string[]) => {
      writes.push(["agentKeys", pane, [...keys]]);
      returns += 1;
      submitted.push(row);
    },
    sendInput: async (pane: string, text: string, keys: readonly string[]) => void writes.push(["sendInput", pane, text, [...keys]]),
    readStartCommandsFile: async () => null,
    promptIO: () => ({
      paneRead: async () => {
        const captured = recorded;
        row = "/exit do not submit this private draft";
        during(backend, paneInputs);
        return captured;
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
  registerIpc({ hosts, paneInputs } as never);
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const answer = registered.handles.get(IPC.paneRestart)!(event, "mac-mini", "w1:p1", binding) as Promise<string | null>;
    await vi.advanceTimersByTimeAsync(25_000);
    return { note: await answer, submitted, writes, paneInputs };
  } finally {
    vi.useRealTimers();
  }
}

describe("input through the restart IPC: the real PaneInputs counter and composer writes", () => {
  it("typing in Codex's Terminal during pane.read: the extra Return never reaches the user's draft", async () => {
    const r = await restartThroughIpc((_backend, inputs) => inputs.bump("mac-mini", "w1:p1"));
    expect(r.paneInputs.generation("mac-mini", "w1:p1")).toBe(1);
    expect(r.submitted).toEqual(["/exit"]);
    expect(r.note).toBe(restartTexts.typedMeanwhile("Codex"));
  });

  it("a composer write to the pane during pane.read: no extra Return", async () => {
    const r = await restartThroughIpc((backend) => composerWrites.wrote(backend, "w1:p1"));
    expect(r.submitted).toEqual(["/exit"]);
    expect(r.note).toBe(restartTexts.typedMeanwhile("Codex"));
  });

  it("a box mark (Stop, Esc) on the pane during pane.read: no extra Return", async () => {
    const r = await restartThroughIpc((backend) => boxChecks.mark(backend, "w1:p1"));
    expect(r.submitted).toEqual(["/exit"]);
  });

  it("input to another pane does not stop it: the extra Return and the resume", async () => {
    const r = await restartThroughIpc((backend, inputs) => {
      inputs.bump("mac-mini", "w1:p2");
      composerWrites.wrote(backend, "w1:p2");
    });
    expect(r.note).toBeNull();
    expect(r.writes.at(-1)).toEqual(["sendInput", "w1:p1", resume, ["Enter"]]);
  });
});

describe("bound to the run that was clicked", () => {
  const page = (arrival: number) => ({
    topology: { panes: [codex.pane!], agents: [codex.agent!], workspaces: [], tabs: [] },
    incarnation: 1,
    connection: 3,
    epoch: 7,
    run: { connection: 3, arrivals: { "w1:p1": arrival } },
  });

  it("the click's binding carries the page's run", () => {
    expect(restartBindingOf(page(1) as never, "w1:p1", "Codex").run).toEqual({ connection: 3, arrival: 1 });
    expect(restartBindingOf({ ...page(1), run: undefined } as never, "w1:p1", "Codex").run).toBeUndefined();
  });

  it("the page's run 1, a fresh run 2 of the same session in the same terminal: nothing is typed", async () => {
    const m = fakeCodex({ exitsOn: 2 });
    m.site.fresh = async () => {
      m.machine.run = { connection: 3, arrival: 2 };
      return true;
    };
    expect(await restartAgent(m.site, "w1:p1", restartBindingOf(page(1) as never, "w1:p1", "Codex"))).toBe(restartTexts.otherAgent);
    expect(m.writes).toEqual([]);
  });

  it("a new run between /exit and its Return: no Return", async () => {
    const m = fakeCodex({ exitsOn: 1 });
    const sendText = m.site.writer.sendText;
    m.site.writer.sendText = async (pane, text) => {
      await sendText(pane, text);
      m.machine.run = { connection: 3, arrival: 2 };
    };
    expect(await restartAgent(m.site, "w1:p1", restartBindingOf(page(1) as never, "w1:p1", "Codex"))).toBe(restartTexts.otherAgent);
    expect(m.enters()).toBe(0);
  });

  it("a new run during the screen read: no extra Return", async () => {
    const m = fakeCodex({ exitsOn: 2 });
    m.site.read = async () => {
      m.machine.run = { connection: 4, arrival: 1 };
      return recorded;
    };
    expect(await restartAgent(m.site, "w1:p1", restartBindingOf(page(1) as never, "w1:p1", "Codex"))).toBe(restartTexts.otherAgent);
    expect(m.enters()).toBe(1);
  });

  it("an unchanged run restarts", async () => {
    const m = fakeCodex({ exitsOn: 2 });
    expect(await restartAgent(m.site, "w1:p1", restartBindingOf(page(1) as never, "w1:p1", "Codex"))).toBeNull();
    expect(m.enters()).toBe(2);
    expect(m.writes.at(-1)).toEqual(["sendInput", "w1:p1", resume, ["Enter"]]);
  });

  it("the IPC checks the page's run: a malformed one is refused, another run gets nothing typed", async () => {
    expect(isRestartBinding({ ...bindingFor(codex, "Codex"), run: { connection: 3, arrival: 1 } })).toBe(true);
    expect(isRestartBinding({ ...bindingFor(codex, "Codex"), run: { connection: 3 } })).toBe(false);
    expect(isRestartBinding({ ...bindingFor(codex, "Codex"), run: { connection: -1, arrival: 1 } })).toBe(false);
    expect(isRestartBinding({ ...bindingFor(codex, "Codex"), run: null })).toBe(false);
    const fresh = await restartThroughIpc(() => undefined, { ...bindingFor(codex, "Codex"), run: { connection: 3, arrival: 2 } });
    expect(fresh.writes).toEqual([]);
    expect(fresh.note).toBe(restartTexts.otherAgent);
  });
});
