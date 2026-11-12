// Rows under the box shaped like a slash list prove `/exit` only with exactly
// one row marked selected ("› ") and that row `/exit`. A wholly unmarked list
// can be the user's draft's next rows (Codex indents a draft's continuation
// with two spaces, as it indents its list): typed, never exit, and no extra
// Return. The recorded no-list frame and a list with `/exit` marked stay exit.
// Fake Codex, fake screens, a fake clock.

import { describe, expect, it } from "vitest";

import { restartAgent, type RestartSite } from "../src/main/herdr/restart";
import { codexExitRow, restartTexts } from "../src/shared/agent-restart";
import { startCommandsWith } from "../src/shared/start-commands";
import { agentState, bindingFor, claudeID, shellState, type PaneState } from "./support/restart-machine";

const codexSession = { source: "herdr:codex", agent: "codex", kind: "id", value: claudeID };
const codex = agentState({ kind: "codex", session: codexSession });
const resume = `codex resume ${claudeID} --no-daemon`;

const mark = "\u{203A}";
const footer = "  GPT-6.1-Sol default \u{B7} ~/code/hello-app \u{B7} Reply exactly hello";
const frame = (...rows: string[]): string => ["• hello", "", "  Worked for 8s \u{2022} 8:53 PM", ...rows].join("\n");
/** The recorded frame (Codex 0.167.0, the clean-home test): `/exit` in the row, the footer right under it, the last row. */
const recorded = frame(`${mark} /exit`, footer);
/** A two-line draft: the user's `/exit`, Shift+Enter, then Restart's own `/exit` on the next row. */
const twoLineDraft = frame(`${mark} /exit`, "  /exit", footer);
/** A draft's next row shaped like a list row with a description. */
const describedDraft = frame(`${mark} /exit`, "  /exit    explain what this command does/exit", footer);

describe("an unmarked list never proves /exit", () => {
  it.each([
    ["the two-line /exit draft", twoLineDraft],
    ["a slash-shaped continuation with a description", describedDraft],
  ])("%s: typed, never exit", (_name, screen) => {
    expect(codexExitRow(screen)).toBe("typed");
  });

  it.each([
    ["one unmarked /exit row", ["  /exit    exit Codex"]],
    ["/exit then /quit, none marked", ["  /exit    exit Codex", "  /quit    exit Codex"]],
    ["/help then /exit, none marked", ["  /help    Show help", "  /exit    Exit"]],
    ["an unmarked list with blank rows round it", ["", "  /exit    exit Codex", "  /quit    exit Codex", ""]],
    ["bare commands, none marked", ["  /exit", "  /quit"]],
    ["one other command, unmarked", ["  /help    Show help"]],
  ])("%s: not exit", (_name, rows) => {
    expect(codexExitRow(frame(`${mark} /exit`, ...rows, footer))).not.toBe("exit");
  });

  it("the recorded frame (no list) stays exit", () => {
    expect(codexExitRow(recorded)).toBe("exit");
    expect(codexExitRow(frame(`${mark} /exit`, "", footer))).toBe("exit");
  });

  it.each([
    ["one marked /exit row", [`  ${mark} /exit    exit Codex`]],
    ["/exit marked over /quit", [`  ${mark} /exit    exit Codex`, "    /quit    exit Codex"]],
    ["/exit marked under /help", ["    /help    Show help", `  ${mark} /exit    Exit`]],
    ["/exit marked, blank rows round the list", ["", `  ${mark} /exit    exit Codex`, "    /quit    exit Codex", ""]],
  ])("a list with /exit positively marked stays exit: %s", (_name, rows) => {
    expect(codexExitRow(frame(`${mark} /exit`, ...rows, footer))).toBe("exit");
  });

  it("a marked row that is not /exit, or two marked rows: typed", () => {
    expect(codexExitRow(frame(`${mark} /exit`, "  /exit    Exit", `  ${mark} /help    Show help`, footer))).toBe("typed");
    expect(codexExitRow(frame(`${mark} /exit`, `  ${mark} /exit    Exit`, `  ${mark} /quit    Exit`, footer))).toBe("typed");
  });
});

/** A fake Codex: it leaves on the given Return (null: never); its screen; its clock; the page's run and the pane's input counts. */
function fakeCodex(screen: string, exitsOn: number | null = 2) {
  const writes: unknown[][] = [];
  let clock = 1_000_000;
  let state: PaneState = codex;
  let returns = 0;
  const site: RestartSite = {
    writer: {
      sendText: async (pane, text) => void writes.push(["sendText", pane, text]),
      agentKeys: async (pane, keys) => {
        writes.push(["agentKeys", pane, [...keys]]);
        returns += 1;
      },
      sendInput: async (pane, text, keys) => void writes.push(["sendInput", pane, text, [...keys]]),
    },
    machine: "Mac mini",
    fresh: async () => {
      state = exitsOn !== null && returns >= exitsOn ? shellState(codex.pane?.terminalID) : codex;
      return true;
    },
    pane: () => state.pane,
    agent: () => state.agent,
    identity: () => ({ incarnation: 1, connection: 3, epoch: 7 }),
    snapshotEpoch: () => 7,
    startCommands: async () => startCommandsWith({ type: "read" }, { claude: "cl" }),
    read: async () => screen,
    entry: () => true,
    run: () => ({ connection: 3, arrival: 1 }),
    inputs: () => [5, 8, 12],
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const enters = (): number => writes.filter((write) => write[0] === "agentKeys").length;
  return { site, writes, enters };
}

describe("end to end: exactly one agent key for an unmarked list", () => {
  it.each([
    ["the two-line /exit draft", twoLineDraft],
    ["a slash-shaped continuation with a description", describedDraft],
    ["an unmarked list of /exit and /quit", frame(`${mark} /exit`, "  /exit    exit Codex", "  /quit    exit Codex", footer)],
  ])("%s: one Return, no resume, and the note says /exit is still typed", async (_name, screen) => {
    const m = fakeCodex(screen);
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBe(restartTexts.exitTyped("Codex"));
    expect(m.enters()).toBe(1);
    expect(m.writes.some((write) => write[0] === "sendInput")).toBe(false);
  });

  it.each([
    ["the recorded frame", recorded],
    ["a list with /exit marked", frame(`${mark} /exit`, `  ${mark} /exit    exit Codex`, "    /quit    exit Codex", "", footer)],
  ])("%s: the one extra Return goes, Codex leaves and resumes", async (_name, screen) => {
    const m = fakeCodex(screen);
    expect(await restartAgent(m.site, "w1:p1", bindingFor(codex, "Codex"))).toBeNull();
    expect(m.writes).toEqual([
      ["sendText", "w1:p1", "/exit"],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["sendInput", "w1:p1", resume, ["Enter"]],
    ]);
  });
});
