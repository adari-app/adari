// "Update ready" on a pane whose Claude Code has a newer
// version installed (Adari). The reader is the twin of HerdrKit's
// AgentUpdateLine and AgentUpdateWatch (Sources/HerdrKit/AgentUpdateMark.swift):
// Claude Code's "✔ Update installed · Restart to update" read only in its footer
// position (right above the prompt box's top rule), never in the conversation;
// the reads budgeted (once on sight, every 5 minutes, when a pane turns idle or
// done, never within 30 s; never a shell, an exited agent or an offline
// machine). The main process's service reads over a fake Herdr client; the
// sidebar row shows the mark with its tooltip, the header's mark opens a card
// with the same words, and nothing is ever sent to the pane.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import { FixtureTransport } from "../src/main/demo/demo-backend";
import { HerdrClient } from "../src/main/herdr/client";
import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { UpdateMarkService, type UpdateMarkHosts } from "../src/main/update-marks";
import { findRow, type SidebarHost } from "../src/shared/desktop-sidebar";
import type { HostView } from "../src/shared/ipc-contract";
import { UpdateWatch, readUpdateLine, updateReadLines, updateWatchFloorMs, updateWatchIntervalMs, type UpdateWatchPane } from "../src/shared/update-mark";
import { eventually } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";
import { nowUnixMs } from "./support/sidebar-fixture";

const { MainPane } = await import("../src/renderer/components/MainPane");
const { UpdateMark, updateMarkWords } = await import("../src/renderer/components/UpdateMark");

/** Retries `check` until it passes (or eventually's deadline), then runs it once more. */
async function until(check: () => void): Promise<void> {
  await eventually(() => {
    try {
      check();
      return true;
    } catch {
      return false;
    }
  });
  check();
}

const line = "✔ Update installed · Restart to update";
const rule = (width: number): string => "─".repeat(width);

/** A Claude Code screen `width` wide: the turn, a blank, the footer rows right-aligned, the box and its status lines. */
function screen(turn: readonly string[], footer: readonly string[] = [], width = 100, align = true): string {
  const padded = footer.map((row) => (align ? " ".repeat(Math.max(0, width - [...row].length)) + row : row));
  return [...turn, "", ...padded, rule(width), "❯ ", rule(width), "  Opus 5.5 (1M context) | 34% ctx | v2.1.312", "  ⏵⏵ auto mode on"].join("\n");
}

const turn = ["❯ carry on", "", "⏺ The change is committed.", "", "✻ Cogitated for 3m 12s"];

describe("the line (the twin of AgentUpdateLine)", () => {
  it("reads the line above the box, right-aligned, beside the effort note, in its colours", () => {
    expect(readUpdateLine(screen(turn, [line]))).toBe(true);
    expect(readUpdateLine(screen(turn, [`${line}  ◐ medium · /effort`]))).toBe(true);
    const coloured = "\u001B[32m✔\u001B[39m \u001B[2mUpdate installed · Restart to update\u001B[22m";
    expect(readUpdateLine("\u001B]0;title\u0007" + screen(turn, [coloured], 100, false).replaceAll("─", "\u001B[38;5;244m─\u001B[39m"))).toBe(true);
    const titled = screen(turn, [line]).replace(rule(100), `${rule(70)} aurora-web-session ─`);
    expect(readUpdateLine(titled)).toBe(true);
  });

  it("reads it wrapped or cut at a narrow width", () => {
    expect(readUpdateLine(screen(["❯ hi"], ["✔ Update installed ·", "Restart to update"], 24))).toBe(true);
    expect(readUpdateLine(screen(["❯ hi"], ["✔ Update", "installed · Restart", "to update"], 18))).toBe(true);
    expect(readUpdateLine(screen(["❯ hi"], ["✔ Update installed · Re…"], 30))).toBe(true);
    expect(readUpdateLine(screen(["❯ hi"], ["✔ Update inst…"], 14))).toBe(true);
  });

  it("never counts the words in the conversation, the draft or below the box", () => {
    expect(readUpdateLine(screen([`❯ what does ${line} mean?`, "", `⏺ It means: ${line}.`, `  ${line}`]))).toBe(false);
    expect(readUpdateLine(["⏺ The footer says", `  ${line}`, rule(60), "❯ ", rule(60), "  Opus | 22% ctx"].join("\n"))).toBe(false);
    expect(readUpdateLine(screen(turn).replace("❯ \n", `❯ ${line}\n`))).toBe(false);
    expect(readUpdateLine(`${screen(turn)}\n  ${line}`)).toBe(false);
  });

  it("a quoted box above a dialog never marks (only the live footer at the end counts)", () => {
    const footer = ["", line, rule(60), "❯ ", rule(60), "  Opus | 22% ctx"];
    const quoted = ["⏺ Example terminal output:", "", "```", ...footer, "```", "", rule(60), " Bash command", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel"];
    expect(readUpdateLine(quoted.join("\n"))).toBeNull();
    const boxed = ["⏺ Example:", "", "```", ...footer, "```", "", rule(60), " Do you want to proceed?", " ❯ 1. Yes", "   2. No", rule(60), " Esc to cancel"];
    expect(readUpdateLine(boxed.join("\n"))).toBeNull();
    const live = ["⏺ Example:", "", "```", ...footer, "```", "", "⏺ Done.", "", rule(60), "❯ ", rule(60), "  Opus | 22% ctx"];
    expect(readUpdateLine(live.join("\n"))).toBe(false);
    const real = ["⏺ Example:", "", "```", ...footer, "```", "", "⏺ Done.", "", line, rule(60), "❯ ", rule(60), "  Opus | 22% ctx"];
    expect(readUpdateLine(real.join("\n"))).toBe(true);
  });

  it("a quoted footer followed by the conversation never marks; the live footer's status rows still do", () => {
    const footer = ["", line, rule(60), "❯ ", rule(60), "  Opus | 22% ctx"];
    const suffixes = [
      ["```", "", "⏺ Now checking the next file.", "  Reading package.json…"],
      ["```"],
      ["", "⏺ Done."],
      ["  ⎿  Read 40 lines"],
      ["  status 2", "  status 3", "  status 4", "  status 5", "  status 6"],
    ];
    for (const suffix of suffixes) {
      expect(readUpdateLine(["⏺ Example:", "", "```", ...footer, ...suffix].join("\n")), suffix.join(" / ")).not.toBe(true);
    }
    const live = ["⏺ Done.", "", line, rule(60), "❯ ", rule(60), "  Opus 5.5 | 24% ctx | aurora-web-main", "  ⏵⏵ auto mode on · 3 monitors", "", ""];
    expect(readUpdateLine(live.join("\n"))).toBe(true);
  });

  it("only the footer's own status rows follow the box (a tool's plain output never marks)", () => {
    const printed = ["⏺ Bash(cat captured-screen.txt; git diff --stat)", "  ⎿", "", line, rule(60), "❯", rule(60), "  Opus | 22% ctx",
      "  src/App.ts | 2 ++", "  1 file changed, 2 insertions(+)"];
    expect(readUpdateLine(printed.join("\n"))).not.toBe(true);
    const plain = [
      ["  src/App.ts | 2 ++"],
      ["  1 file changed, 2 insertions(+)"],
      ["  Opus | 22% ctx", "  src/App.ts", "  README.md"],
      ["  done"],
      ["  Opus | src/App.ts"],
      ["  ⏵⏵ auto mode on", "  total 48"],
    ];
    for (const rows of plain) {
      expect(readUpdateLine([line, rule(60), "❯ ", rule(60), ...rows].join("\n")), rows.join(" / ")).not.toBe(true);
    }
    // Each recorded footer's status rows (the claude-2.1.303-* and 2.1.316 reads, the demo's), and the other shapes, cut at the edge.
    const recorded = [
      ["  Haiku 5.5 | 4% ctx | z-shapes | Shapes-c.txt write command | v2.1.303", "  ⏸ manual mode on", ""],
      ["  Haiku 5.5 | ctx:- | z-shapes | v2.1.303", "  ⏸ manual mode on · ← for agents", ""],
      ["  Opus 5.5 (1M context) | 34% ctx | aurora-web-cleanup-session | aurora-web-cleanup-session | v2.1.303", "  ⏵⏵ auto mode on (shift+tab to cycle)", ""],
      ["  Haiku 5.5 | 4% ctx | z-narrow | z-…", "  ⏸ manual mode on", ""],
      ["  Haiku 5.5 | 4% ctx | z-narrow | z-narrow-54 | v2.…", "  ⏸ manual mode on", ""],
      ["  Haiku 5.5 | ctx:- | z-narrow | z-narrow-54 | v2.1…", "  ⏸ manual mode on · ← for agents", ""],
      ["  Opus 5.5 | 24% ctx | aurora-web-main | Adari Mac app build 0.1.0 | v2.1.316", "  ⏵⏵ auto mode on · 3 monitors", ""],
      ["  Opus 5.5 | 12% ctx | aurora-web-paste-wrap-session | aurora…", "  ⏵⏵ auto mode on (shift+tab to cycle)", ""],
      ["  Opus 5.5 | 12% ctx | aurora-web-main | v2.1.312", "  ⏵⏵ auto mode on (shift+tab to cycle)"],
      ["  ? for shortcuts"],
      ["  ? for sh…"],
      ["  Opus 5.5 | 4…", "  ⏵⏵ au…"],
      ["  Opus 5.5 | 22% ctx", "  ✔ Update installed ·", "  Restart to update"],
      ["  Tip: Use /btw to ask a quick side question without", "     interrupting Claude's current work"],
    ];
    const above = [[line], ["✔ Update installed ·", "Restart to update"], ["✔ Update inst…"]];
    for (const rows of recorded) {
      for (const footer of above) {
        const text = [...turn, "", ...footer, rule(60), "❯ ", rule(60), ...rows];
        expect(readUpdateLine(text.join("\n")), rows.join(" / ")).toBe(true);
        const coloured = text.map((row) => (row === "" ? "" : `\u001b[2m${row}\u001b[22m\u001b[0m`));
        expect(readUpdateLine(coloured.join("\n")), `coloured: ${rows.join(" / ")}`).toBe(true);
      }
      expect(readUpdateLine([...turn, "", rule(60), "❯ ", rule(60), ...rows].join("\n")), rows.join(" / ")).toBe(false);
    }
  });

  it("is false without the line, and has no answer without the box", () => {
    expect(readUpdateLine(screen(turn))).toBe(false);
    expect(readUpdateLine(screen(turn, ["◐ medium · /effort"]))).toBe(false);
    expect(readUpdateLine(screen(["  Updated to latest. Got 8 features, 37 bugfixes, and 6 other changes."]))).toBe(false);
    expect(readUpdateLine("")).toBeNull();
    expect(readUpdateLine("dev@mini ~ % ls\nDesktop\ndev@mini ~ % ")).toBeNull();
    expect(readUpdateLine([rule(60), " Bash command", " Do you want to proceed?", " ❯ 1. Yes", "   2. No"].join("\n"))).toBeNull();
  });

  // On a Claude Code 2.1.316 screen the conversation's
  // last row, a grey "●" notice, sits right above the right-aligned line with
  // no blank between. A conversation row ends the footer when every footer
  // row under it is right-aligned to the box rule's right end (within 2
  // columns); a footer row drawn any other way is the conversation's.
  describe("the line right under the conversation (no blank between)", () => {
    const right = (row: string, width: number): string => " ".repeat(Math.max(0, width - [...row].length)) + row;
    const box = (width: number, top = rule(width)): string[] => [
      top, "❯", rule(width), "  Opus 5.5 | 0% ctx | someproject | Some session title | v2.1.316", "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ];
    const notice = '● Compacted while idle, before the prompt cache expired · turn off with "idleCompaction": false in settings.json';
    const read = ["  Read ../../docs/some-feature.plan.md (45 lines)", ""];

    it("reads a real screen: the update line right under a ● notice, a pane 120 wide", () => {
      expect(readUpdateLine([...read, notice, right(line, 120), ...box(120)].join("\n"))).toBe(true);
      const coloured = [...read, `\u001B[2m${notice}\u001B[22m`, `${" ".repeat(82)}\u001B[32m✔\u001B[39m \u001B[2mUpdate installed · Restart to update\u001B[22m`];
      expect(readUpdateLine([...coloured, ...box(120)].join("\n"))).toBe(true);
    });

    it("still reads it with a blank row between (today's path)", () => {
      expect(readUpdateLine([...read, notice, "", right(line, 120), ...box(120)].join("\n"))).toBe(true);
    });

    it("reads it right under a ⏺ reply, beside the effort note, within 2 columns of the edge, under a titled rule", () => {
      const reply = ["❯ carry on", "", "⏺ The change is committed."];
      expect(readUpdateLine([...reply, right(line, 100), ...box(100)].join("\n"))).toBe(true);
      expect(readUpdateLine([...reply, right(`${line}  ◐ medium · /effort`, 100), ...box(100)].join("\n"))).toBe(true);
      expect(readUpdateLine([...reply, right(line, 98), ...box(100)].join("\n"))).toBe(true);
      expect(readUpdateLine([...reply, "  ⎿  Done", right(line, 100), ...box(100)].join("\n"))).toBe(true);
      const titled = `${rule(100 - 21)} aurora-web-session ─`;
      expect([...titled].length).toBe(100);
      expect(readUpdateLine([...reply, right(line, 100), ...box(100, titled)].join("\n"))).toBe(true);
    });

    it("reads it wrapped at a narrow width, each of its rows right-aligned, under a ● row", () => {
      expect(readUpdateLine(["● Compacted while idle", right("✔ Update installed ·", 24), right("Restart to update", 24), ...box(24)].join("\n"))).toBe(true);
      const three = ["✔ Update", "installed · Restart", "to update"].map((row) => right(row, 20));
      expect(readUpdateLine(["⏺ Done.", ...three, ...box(20)].join("\n"))).toBe(true);
      expect(readUpdateLine(["● Compacted", right("✔ Update installed · Re…", 30), ...box(30)].join("\n"))).toBe(true);
    });

    it("never reads the words in a conversation row drawn any other way right above the rule", () => {
      expect(readUpdateLine(["⏺ The footer says", `  ${line}`, ...box(120)].join("\n"))).toBe(false);
      expect(readUpdateLine(["⏺ The footer says", line, ...box(120)].join("\n"))).toBe(false);
      expect(readUpdateLine(["⏺ The footer says", `${" ".repeat(40)}${line}`, ...box(120)].join("\n"))).toBe(false);
      expect(readUpdateLine(["⏺ It reads", right(line, 117), ...box(120)].join("\n"))).toBe(false);
      expect(readUpdateLine(["⏺ The footer says", "  ✔ Update installed ·", right("Restart to update", 60), ...box(60)].join("\n"))).toBe(false);
      expect(readUpdateLine(["⏺ The footer says", right("✔ Update installed ·", 60), "  Restart to update", ...box(60)].join("\n"))).toBe(false);
      // The conversation's mark right above the rule: no footer at all.
      expect(readUpdateLine(["⏺ Done.", right(`● ${line}`, 100), ...box(100)].join("\n"))).toBe(false);
      // More rows than the line ever wraps to.
      const four = ["✔ Update", "installed", "· Restart", "to update"].map((row) => right(row, 20));
      expect(readUpdateLine(["⏺ Done.", ...four, ...box(20)].join("\n"))).toBe(false);
    });
  });
});

const pane = (id: string, over: Partial<UpdateWatchPane> = {}): UpdateWatchPane => ({
  id,
  kind: "claude",
  identity: `s-${id}`,
  settled: true,
  exited: false,
  ...over,
});
const twenty = (settled = true): UpdateWatchPane[] => Array.from({ length: 20 }, (_, i) => pane(`p${i + 1}`, { settled }));

describe("the read budget (the twin of AgentUpdateWatch), on a fake clock", () => {
  it("reads 20 agent panes once every 5 minutes: 4 reads a minute", () => {
    const watch = new UpdateWatch();
    let reads = 0;
    for (let ms = 0; ms < 3_600_000; ms += 5_000) {
      for (const id of watch.due(twenty(), ms, true)) {
        reads += 1;
        watch.observe(id, `s-${id}`, watch.token(id) ?? -1, screen(turn), ms);
      }
    }
    expect(updateWatchIntervalMs).toBe(300_000);
    expect(reads).toBe(240);
    expect(reads / 60).toBe(4);
  });

  it("reads a pane that turns idle or done, never within the floor; flapping stays under 2 a minute a pane", () => {
    const watch = new UpdateWatch();
    expect(watch.due([pane("p1", { settled: false })], 0, true)).toEqual(["p1"]);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, screen(turn), 0);
    expect(watch.due([pane("p1", { settled: false })], 60_000, true)).toEqual([]);
    expect(watch.due([pane("p1")], 90_000, true)).toEqual(["p1"]);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, screen(turn), 90_000);
    watch.due([pane("p1", { settled: false })], 95_000, true);
    expect(watch.due([pane("p1")], 100_000, true)).toEqual([]);
    expect(updateWatchFloorMs).toBe(30_000);
    const flapping = new UpdateWatch();
    let reads = 0;
    for (let ms = 0; ms < 600_000; ms += 5_000) {
      for (const id of flapping.due(twenty((ms / 5_000) % 2 === 0), ms, true)) {
        reads += 1;
        flapping.observe(id, `s-${id}`, flapping.token(id) ?? -1, screen(turn), ms);
      }
    }
    expect(reads / 10).toBeLessThanOrEqual(40);
  });

  // "Another CLI" is one with no readable notice (Grok Build, Cursor Agent, Gemini); Codex's notice is read.
  it("never reads a shell, an exited agent, another CLI, or an offline machine; one read a pane at a time", () => {
    const watch = new UpdateWatch();
    expect(watch.due([pane("sh", { kind: null }), pane("x", { exited: true }), pane("g", { kind: "grok" }), pane("cu", { kind: "cursor" }), pane("ge", { kind: "gemini" })], 0, true)).toEqual([]);
    expect(watch.due(twenty(), 0, false)).toEqual([]);
    expect(watch.due([pane("p1")], 0, true)).toEqual(["p1"]);
    expect(watch.due([pane("p1")], 400_000, true)).toEqual([]);
  });

  it("clears the mark after a restart's fresh screen and with a new session; a dialog keeps it", () => {
    const watch = new UpdateWatch();
    watch.due([pane("p1")], 0, true);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, screen(turn, [line]), 0);
    expect([...watch.marked()]).toEqual(["p1"]);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, "Do you want to proceed?\n❯ 1. Yes", 1);
    expect(watch.ready("p1")).toBe(true);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, screen(["  Updated to latest.", "", "❯ /resume"]), 2);
    expect(watch.ready("p1")).toBe(false);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, screen(turn, [line]), 3);
    expect(watch.due([pane("p1", { identity: "s-new" })], 4, true)).toEqual(["p1"]);
    expect(watch.ready("p1")).toBe(false);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, screen(turn, [line]), 5);
    expect(watch.ready("p1")).toBe(false);
    watch.observe("p1", "s-new", watch.token("p1") ?? -1, screen(turn, [line]), 6);
    watch.due([], 7, true);
    expect(watch.marked().size).toBe(0);
  });
});

/**
 * Each pane's read times on 5 s ticks from `from` up to `to`
 * (ms), each read answered at once with `screenOf`'s screen for it.
 */
function readTimes(
  watch: UpdateWatch,
  panes: () => readonly UpdateWatchPane[],
  to: number,
  screenOf: (id: string, ms: number) => string,
  from = 0,
): Record<string, number[]> {
  const times: Record<string, number[]> = {};
  for (let ms = from; ms < to; ms += 5_000) {
    const now = panes();
    for (const id of watch.due(now, ms, true)) {
      (times[id] ??= []).push(ms);
      watch.observe(id, now.find((candidate) => candidate.id === id)!.identity, watch.token(id) ?? -1, screenOf(id, ms), ms);
    }
  }
  return times;
}

/** from, from + step … up to (not including) to. */
const every = (from: number, to: number, step: number): number[] =>
  Array.from({ length: Math.floor((to - from - 1) / step) + 1 }, (_, i) => from + i * step);

describe("once one pane on the machine is marked, the others are read every minute for 30 minutes", () => {
  const plain = (): string => screen(turn);
  const marked = (): string => screen(turn, [line]);
  const two = (): UpdateWatchPane[] => [pane("p1"), pane("p2")];

  it("before any mark, a pane is not due again for 5 minutes", () => {
    const watch = new UpdateWatch();
    expect(watch.due(two(), 0, true)).toEqual(["p1", "p2"]);
    for (const id of ["p1", "p2"]) watch.observe(id, `s-${id}`, watch.token(id) ?? -1, plain(), 0);
    expect(watch.due(two(), 60_000, true)).toEqual([]);
    expect(watch.due(two(), 299_999, true)).toEqual([]);
    expect(watch.due(two(), 300_000, true)).toEqual(["p1", "p2"]);
    expect(watch.marked().size).toBe(0);
  });

  it("after one pane is marked, another unmarked pane is due at 60 s, not before; the marked pane stays at 5 minutes", () => {
    const watch = new UpdateWatch();
    expect(watch.due(two(), 0, true)).toEqual(["p1", "p2"]);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, marked(), 0);
    watch.observe("p2", "s-p2", watch.token("p2") ?? -1, plain(), 0);
    expect([...watch.marked()]).toEqual(["p1"]);
    expect(watch.due(two(), 59_999, true)).toEqual([]);
    expect(watch.due(two(), 60_000, true)).toEqual(["p2"]);
    watch.observe("p2", "s-p2", watch.token("p2") ?? -1, plain(), 60_000);
    const times = readTimes(watch, two, 600_000, (id) => (id === "p1" ? marked() : plain()), 65_000);
    expect(times["p2"]).toEqual(every(120_000, 600_000, 60_000));
    expect(times["p1"]).toEqual([300_000]);
  });

  it("a line shown mid-turn is marked within a minute once another pane is marked", () => {
    const watch = new UpdateWatch();
    const working = (): UpdateWatchPane[] => [pane("p1"), pane("p2", { settled: false })];
    // p1 is marked at 0; p2 shows the line from 150 s on, mid-turn (it never turns idle).
    const times = readTimes(watch, working, 600_000, (id, ms) => (id === "p1" || ms >= 150_000 ? marked() : plain()));
    expect(times["p2"]).toEqual([0, 60_000, 120_000, 180_000, 480_000]);
    expect(watch.ready("p2")).toBe(true);
  });

  it("30 minutes after the first mark, unmarked panes go back to 5 minutes (a later mark does not extend it)", () => {
    const watch = new UpdateWatch();
    const three = (): UpdateWatchPane[] => [pane("p1"), pane("p2"), pane("p3")];
    // p1 is marked at 0; p3 shows the line from 600 s on.
    const times = readTimes(watch, three, 3_600_000, (id, ms) => (id === "p1" || (id === "p3" && ms >= 600_000) ? marked() : plain()));
    expect(watch.marked()).toEqual(new Set(["p1", "p3"]));
    expect(times["p2"]).toEqual([...every(0, 1_800_000, 60_000), ...every(2_040_000, 3_600_000, 300_000)]);
    expect(times["p3"]).toEqual([...every(0, 600_000, 60_000), ...every(600_000, 3_600_000, 300_000)]);
    expect(times["p1"]).toEqual(every(0, 3_600_000, 300_000));
  });

  it("with no pane marked any more the reads go back to 5 minutes; a later mark starts a new 30 minutes", () => {
    const watch = new UpdateWatch();
    watch.due(two(), 0, true);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, marked(), 0);
    watch.observe("p2", "s-p2", watch.token("p2") ?? -1, plain(), 0);
    readTimes(watch, two, 300_000, (id) => (id === "p1" ? marked() : plain()), 5_000);
    // p1 restarted on its own (the line gone): no pane is marked.
    expect(watch.due(two(), 300_000, true)).toEqual(["p1", "p2"]);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, plain(), 300_000);
    watch.observe("p2", "s-p2", watch.token("p2") ?? -1, plain(), 300_000);
    expect(watch.marked().size).toBe(0);
    expect(watch.due(two(), 360_000, true)).toEqual([]);
    expect(watch.due(two(), 599_999, true)).toEqual([]);
    // A later update: p2 is marked at 600 s, and p1 is read every minute again.
    expect(watch.due(two(), 600_000, true)).toEqual(["p1", "p2"]);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, plain(), 600_000);
    watch.observe("p2", "s-p2", watch.token("p2") ?? -1, marked(), 600_000);
    expect(watch.due(two(), 659_999, true)).toEqual([]);
    expect(watch.due(two(), 660_000, true)).toEqual(["p1"]);
  });

  it("a second machine's watch is unaffected", () => {
    const first = new UpdateWatch();
    const second = new UpdateWatch();
    first.due(two(), 0, true);
    first.observe("p1", "s-p1", first.token("p1") ?? -1, marked(), 0);
    first.observe("p2", "s-p2", first.token("p2") ?? -1, plain(), 0);
    expect(second.due(two(), 0, true)).toEqual(["p1", "p2"]);
    for (const id of ["p1", "p2"]) second.observe(id, `s-${id}`, second.token(id) ?? -1, plain(), 0);
    expect(first.due(two(), 60_000, true)).toEqual(["p2"]);
    expect(second.due(two(), 60_000, true)).toEqual([]);
    expect(second.due(two(), 299_999, true)).toEqual([]);
    expect(second.due(two(), 300_000, true)).toEqual(["p1", "p2"]);
  });

  it("a pane with a new identity starts over, as today; the marked pane's new session ends the minute reads", () => {
    const watch = new UpdateWatch();
    watch.due(two(), 0, true);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, marked(), 0);
    watch.observe("p2", "s-p2", watch.token("p2") ?? -1, plain(), 0);
    // p2's new session is read on sight, then every minute (p1 is still marked).
    const renewed = (): UpdateWatchPane[] => [pane("p1"), pane("p2", { identity: "s-p2b" })];
    expect(watch.due(renewed(), 30_000, true)).toEqual(["p2"]);
    watch.observe("p2", "s-p2b", watch.token("p2") ?? -1, plain(), 30_000);
    expect(watch.due(renewed(), 89_999, true)).toEqual([]);
    expect(watch.due(renewed(), 90_000, true)).toEqual(["p2"]);
    watch.observe("p2", "s-p2b", watch.token("p2") ?? -1, plain(), 90_000);
    // p1's new session: read on sight, its mark gone; no pane is marked, p2 goes back to 5 minutes.
    const restarted = (): UpdateWatchPane[] => [pane("p1", { identity: "s-p1b" }), pane("p2", { identity: "s-p2b" })];
    expect(watch.due(restarted(), 100_000, true)).toEqual(["p1"]);
    expect(watch.marked().size).toBe(0);
    watch.observe("p1", "s-p1b", watch.token("p1") ?? -1, plain(), 100_000);
    expect(watch.due(restarted(), 150_000, true)).toEqual([]);
    expect(watch.due(restarted(), 389_999, true)).toEqual([]);
    expect(watch.due(restarted(), 390_000, true)).toEqual(["p2"]);
  });

  it("the read budget at rest with 20 panes and none marked is unchanged: 4 reads a minute", () => {
    const watch = new UpdateWatch();
    const times = readTimes(watch, () => twenty(), 3_600_000, () => plain());
    const reads = Object.values(times).reduce((sum, list) => sum + list.length, 0);
    expect(watch.marked().size).toBe(0);
    expect(reads).toBe(240);
    expect(reads / 60).toBe(4);
  });
});

// MARK: - the service over a fake Herdr client

type Json = Record<string, unknown>;

function topology(panes: readonly { id: string; agent?: string; status: string; session?: string }[]): SessionTopology {
  const json = {
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "api", focused: true, pane_count: panes.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: panes.length, agent_status: "idle" }],
    panes: panes.map((p) => ({
      pane_id: p.id,
      terminal_id: `term-${p.id}`,
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
      ...(p.agent === undefined ? {} : { agent: p.agent }),
      agent_status: p.status,
      revision: 1,
    })),
    layouts: [],
    agents: panes
      .filter((p) => p.agent !== undefined)
      .map((p) => ({
        pane_id: p.id,
        agent: p.agent,
        agent_status: p.status,
        ...(p.session === undefined ? {} : { agent_session: { source: "herdr", agent: p.agent, kind: "id", value: p.session } }),
      })),
  };
  return decodeSessionTopology(json);
}

/** A fake Herdr: `pane.read` answers each pane's screen and counts the reads; anything that writes fails the test. */
class FakeHerdr {
  readonly reads: Json[] = [];
  readonly writes: string[] = [];
  screens: Record<string, string> = {};
  readonly client: HerdrClient;
  constructor() {
    this.client = new HerdrClient({
      roundTrip: (requestLine: string) => {
        const request = JSON.parse(requestLine) as { id: string; method: string; params: Json };
        if (request.method !== "pane.read") {
          this.writes.push(request.method);
          return Promise.resolve(JSON.stringify({ id: request.id, error: { code: "unexpected", message: request.method } }));
        }
        this.reads.push(request.params);
        const text = this.screens[String(request.params["pane_id"])] ?? "";
        return Promise.resolve(JSON.stringify({ id: request.id, result: { type: "pane_read", read: { pane_id: request.params["pane_id"], text } } }));
      },
      close: () => undefined,
    } as never);
  }
}

function hostsOf(herdr: FakeHerdr, view: () => HostView): UpdateMarkHosts & { ready: Record<string, readonly string[]> } {
  const ready: Record<string, readonly string[]> = {};
  return {
    ready,
    list: () => [view()],
    backend: () => ({ paneText: (paneId: string, lines: number) => herdr.client.paneText(paneId, lines) }),
    setUpdateReady: (hostId: string, panes: readonly string[]) => {
      ready[hostId] = panes;
    },
  };
}

function viewOf(state: HostView["state"], topo: SessionTopology): HostView {
  return { id: "mini", name: "Mac mini", kind: "ssh", address: "dev@mini:22", platform: "macOS", state, error: null, topology: topo, fetchedAtMs: 0, incarnation: 1 };
}

describe("a late answer never outlives its pane or session", () => {
  it("the pane gone (or never seen), or its session changed while the read was out: no mark", () => {
    const watch = new UpdateWatch();
    const marked = screen(turn, [line]);
    expect(watch.due([pane("p1")], 0, true)).toEqual(["p1"]);
    watch.due([], 1, true);
    watch.observe("p1", "s-p1", watch.token("p1") ?? -1, marked, 2);
    expect([...watch.marked()]).toEqual([]);
    watch.observe("p9", "s-p9", watch.token("p9") ?? -1, marked, 2);
    expect([...watch.marked()]).toEqual([]);
    expect(watch.due([pane("p2")], 0, true)).toEqual(["p2"]);
    expect(watch.due([pane("p2", { identity: "s-new" })], 1, true)).toEqual(["p2"]);
    watch.observe("p2", "s-p2", watch.token("p2") ?? -1, marked, 2);
    expect([...watch.marked()]).toEqual([]);
    watch.observe("p2", "s-new", watch.token("p2") ?? -1, marked, 3);
    expect([...watch.marked()]).toEqual(["p2"]);
  });
});

describe("an answer belongs to its watch entry's lifetime", () => {
  it("A read, the shell, A resumed in the same terminal with its own clean read, then the pre-exit screen: no mark", () => {
    const watch = new UpdateWatch();
    const a = pane("p1", { identity: "claude|t1|session-A" });
    expect(watch.due([a], 0, true)).toEqual(["p1"]);
    const before = watch.token("p1");
    watch.due([], 1, true);
    expect(watch.due([a], 2, true)).toEqual(["p1"]);
    const after = watch.token("p1");
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
    watch.observe("p1", a.identity, after ?? -1, screen(turn), 3);
    expect(watch.ready("p1")).toBe(false);
    watch.observe("p1", a.identity, before ?? -1, screen(turn, [line]), 4);
    expect(watch.ready("p1")).toBe(false);
    watch.observe("p1", a.identity, after ?? -1, screen(turn, [line]), 5);
    expect(watch.ready("p1")).toBe(true);
  });
});

describe("the main process's reads (UpdateMarkService) over a fake Herdr client", () => {
  it("its reads take main's per-pane read gate (one read of a pane at a time with the card's and Chat's live reads)", async () => {
    const { PaneReadGate } = await import("../src/shared/chat/live-reader");
    const { paneReadKey } = await import("../src/main/chat/live-reads");
    const herdr = new FakeHerdr();
    herdr.screens = { "w1:p1": screen(turn, [line]) };
    const hosts = hostsOf(herdr, () => viewOf("connected", topology([{ id: "w1:p1", agent: "claude", status: "idle", session: "a" }])));
    const gate = new PaneReadGate();
    expect(gate.begin(paneReadKey("mini", "w1:p1"))).toBe(true);
    const service = new UpdateMarkService(hosts, () => 0, gate);
    service.hostsChanged();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(herdr.reads).toHaveLength(0);
    gate.end(paneReadKey("mini", "w1:p1"));
    await until(() => expect(hosts.ready["mini"]).toEqual(["w1:p1"]));
    expect(herdr.reads).toHaveLength(1);
    expect(gate.busy(paneReadKey("mini", "w1:p1"))).toBe(false);
  });

  // Only the covered CLIs' panes (Claude Code's and Codex's); w1:p3 is Grok Build, whose screen says nothing readable.
  it("reads only the Claude panes, short reads of the recent lines, and marks the one showing the line", async () => {
    const herdr = new FakeHerdr();
    herdr.screens = { "w1:p1": screen(turn, [line]), "w1:p2": screen(turn) };
    let now = 0;
    let topo = topology([
      { id: "w1:p1", agent: "claude", status: "idle", session: "a" },
      { id: "w1:p2", agent: "claude", status: "working", session: "b" },
      { id: "w1:p3", agent: "grok", status: "idle" },
      { id: "w1:p4", status: "unknown" },
    ]);
    let state: HostView["state"] = "connected";
    const hosts = hostsOf(herdr, () => viewOf(state, topo));
    const service = new UpdateMarkService(hosts, () => now);
    service.hostsChanged();
    await until(() => expect(hosts.ready["mini"]).toEqual(["w1:p1"]));
    expect(herdr.reads.map((r) => r["pane_id"]).sort()).toEqual(["w1:p1", "w1:p2"]);
    expect(herdr.reads[0]).toEqual({ pane_id: "w1:p1", source: "recent", lines: updateReadLines, format: "text", strip_ansi: true });
    expect(herdr.writes).toEqual([]);
    // Within the minute: nothing more. At the minute, the
    // unmarked Claude pane again (w1:p1 is marked), the marked one not.
    // Offline at the 5 minutes: nothing.
    now = 30_000;
    service.hostsChanged();
    await Promise.resolve();
    expect(herdr.reads).toHaveLength(2);
    now = 60_000;
    service.hostsChanged();
    await until(() => expect(herdr.reads).toHaveLength(3));
    expect(herdr.reads[2]!["pane_id"]).toBe("w1:p2");
    state = "offline";
    now = 300_000;
    service.hostsChanged();
    await Promise.resolve();
    expect(herdr.reads).toHaveLength(3);
    // Back, after the restart (same session, the line gone): the mark goes.
    state = "connected";
    herdr.screens["w1:p1"] = screen(["  Updated to latest.", "", "❯ /resume"]);
    service.hostsChanged();
    await until(() => expect(hosts.ready["mini"]).toEqual([]));
    // A new session in the pane with the line: marked; the agent gone (a shell): cleared without a read.
    herdr.screens["w1:p1"] = screen(turn, [line]);
    topo = topology([{ id: "w1:p1", agent: "claude", status: "idle", session: "c" }]);
    now = 310_000;
    service.hostsChanged();
    await until(() => expect(hosts.ready["mini"]).toEqual(["w1:p1"]));
    const before = herdr.reads.length;
    topo = topology([{ id: "w1:p1", status: "unknown" }]);
    service.hostsChanged();
    expect(hosts.ready["mini"]).toEqual([]);
    expect(herdr.reads).toHaveLength(before);
    expect(herdr.writes).toEqual([]);
  });

  it("puts the marks on the machine's HostView (HostRegistry.setUpdateReady), and only a change tells the window", () => {
    const changes: HostView[][] = [];
    const registry = new HostRegistry((hosts) => changes.push(hosts));
    registry.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "dev@mini:22", platform: "macOS" }, {
      kind: "demo",
      snapshot: () => new Promise(() => undefined),
      close: () => undefined,
    } as never);
    const count = changes.length;
    expect(registry.list()[0]?.updateReady).toBeUndefined();
    registry.setUpdateReady("mini", ["w1:p1"]);
    expect(registry.list()[0]?.updateReady).toEqual(["w1:p1"]);
    registry.setUpdateReady("mini", ["w1:p1"]);
    expect(changes.length).toBe(count + 1);
    registry.setUpdateReady("mini", []);
    expect(registry.list()[0]?.updateReady).toBeUndefined();
  });

  it("the demo's Mac mini shows the line on one Claude pane, and the capture's step 52 (after the needs-you card's 50, 51 grok-chat's, before the live row's 53) opens its card", async () => {
    const { demoHosts, demoUpdateReadyPaneId, demoUpdateReadyScreen } = await import("../src/main/demo/demo-hosts");
    const { bundledFixturesForTests } = await import("./support/demo-fixtures");
    const { demoCaptureSteps, demoUpdateReadyPane, grokCaptureSteps, liveRowCaptureSteps, needsCardCaptureSteps, sendCaptureSteps, updateMarkCaptureSteps } = await import("../src/main/capture");
    expect(readUpdateLine(demoUpdateReadyScreen)).toBe(true);
    const mini = demoHosts(bundledFixturesForTests(), 0)[0]!;
    expect(mini.screens?.[demoUpdateReadyPaneId]).toEqual([demoUpdateReadyScreen]);
    expect(demoUpdateReadyPane).toBe(demoUpdateReadyPaneId);
    const ids = { macMini: mini.descriptor.id, buildBox: "b" };
    // main.ts's order: the demo's, the send's (to 44), the needs-you card's (45-50), grok-chat's (51), this (52), the live row's (53-54).
    const all = [
      ...demoCaptureSteps(ids),
      ...sendCaptureSteps(ids),
      ...needsCardCaptureSteps(ids),
      ...grokCaptureSteps(ids),
      ...updateMarkCaptureSteps(ids),
      ...liveRowCaptureSteps(ids),
    ];
    expect(all.map((each) => each.name).filter((name) => name.includes("update-ready"))).toEqual(["52-update-ready"]);
    const at = all.findIndex((each) => each.name === "52-update-ready");
    expect(all[at - 1]!.name).toBe("51-grok-chat");
    expect(all[at + 1]!.name).toBe("53-live-row-streaming");
    expect(updateMarkCaptureSteps(ids)).toHaveLength(1);
    const step = all[at]!;
    expect(step.name).toBe("52-update-ready");
    expect(step.commands.at(-1)).toEqual({ type: "click", selector: ".mh .upd" });
  });

  it("the demo's fake Herdr answers pane.read from its screens (the capture's marked pane)", async () => {
    const transport = new FixtureTransport({ panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" }], agents: [] }, { "w1:p1": [screen(turn, [line])] });
    const client = new HerdrClient(transport);
    expect(readUpdateLine(await client.paneText("w1:p1", updateReadLines))).toBe(true);
    // A pane the snapshot lacks: Herdr's pane_not_found (as main's demo backend answers).
    await expect(client.paneText("w9:p9", updateReadLines)).rejects.toThrow();
  });
});

// MARK: - the header (the row: update-mark-row.test.ts, with the real React)

const markedHost: SidebarHost & HostView = {
  ...viewOf(
    "connected",
    topology([
      { id: "w1:p1", agent: "claude", status: "idle", session: "a" },
      { id: "w1:p2", agent: "claude", status: "idle", session: "b" },
    ]),
  ),
  updateReady: ["w1:p1"],
};

describe("the mark on the sidebar row and in the header", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts the mark beside the agent's name in the header; a click shows the words in a card, and nothing is sent", () => {
    const sent: unknown[] = [];
    vi.stubGlobal("window", { herdrDesktop: new Proxy({}, { get: (_t, name) => (...args: unknown[]) => (sent.push([name, ...args]), () => undefined) }) });
    const row = findRow([markedHost], "mini", "w1:p1", { nowUnixMs })!;
    expect(row.updateReady).toBe(true);
    const props = {
      host: markedHost,
      row,
      tab: "chat",
      onTab: () => undefined,
      mac: true,
      fontSize: 13,
      boxShown: false,
      onBoxShown: () => undefined,
      ghostty: { shown: false, enabled: false, reason: "" },
      onOpenInGhostty: () => undefined,
    };
    const main = new HookHost(MainPane as (p: object) => unknown, props);
    main.render();
    // Right after the crumb (whose last part is the agent's name), in the header.
    const header = elements(main.tree).find((e) => e.props["className"] === "mh")!;
    const parts = (header.props.children as unknown[]).filter((child) => child !== null && child !== false);
    const at = parts.findIndex((child) => (child as { props?: Record<string, unknown> }).props?.["className"] === "crumb");
    expect((parts[at + 1] as { type: unknown; props: Record<string, unknown> }).type).toBe(UpdateMark);
    expect((parts[at + 1] as { props: Record<string, unknown> }).props["card"]).toBe(true);
    const crumb = parts[at] as { props: { children: { props: Record<string, unknown> }[] } };
    expect(crumb.props.children.at(-1)!.props["className"]).toBe("nm");
    const other = findRow([markedHost], "mini", "w1:p2", { nowUnixMs })!;
    main.render({ ...props, row: other });
    expect(elements(main.tree).some((e) => e.type === UpdateMark)).toBe(false);
    main.unmount();

    const mark = new HookHost(UpdateMark as (p: object) => unknown, { card: true });
    mark.render();
    const button = () => elements(mark.tree).find((e) => e.type === "button")!;
    expect(button().props["aria-label"]).toBe("Update ready");
    expect(button().props["title"]).toBe(updateMarkWords);
    expect(elements(mark.tree).some((e) => e.props["role"] === "dialog")).toBe(false);
    (button().props["onClick"] as (e: unknown) => void)({ stopPropagation: () => undefined });
    const card = elements(mark.tree).find((e) => e.props["role"] === "dialog")!;
    expect(elements(card).flatMap((e) => (typeof e.props["children"] === "string" ? [e.props["children"]] : []))).toContain(updateMarkWords);
    (button().props["onClick"] as (e: unknown) => void)({ stopPropagation: () => undefined });
    expect(elements(mark.tree).some((e) => e.props["role"] === "dialog")).toBe(false);
    mark.unmount();
    // Nothing written to the pane: no send, prompt, keys or stop asked of the bridge.
    expect(sent.filter((call) => /send|prompt|keys|stop|input|text/i.test(String((call as unknown[])[0])))).toEqual([]);
  });
});

// Codex's notice, read by the same service the same budgeted way (UpdateWatch, the same short read).
describe("the service marks a Codex pane whose screen shows its update notice", () => {
  it("reads the Claude and Codex panes, never the Grok one, and marks the Codex pane showing the notice", async () => {
    const { demoCodexUpdateScreen } = await import("../src/main/demo/demo-hosts");
    const herdr = new FakeHerdr();
    herdr.screens = { "w1:p1": screen(turn), "w1:p2": demoCodexUpdateScreen, "w1:p3": "  Grok Build 1.4 (update available)\n> " };
    const topo = topology([
      { id: "w1:p1", agent: "claude", status: "idle", session: "a" },
      { id: "w1:p2", agent: "codex", status: "idle", session: "b" },
      { id: "w1:p3", agent: "grok", status: "idle", session: "c" },
    ]);
    const hosts = hostsOf(herdr, () => viewOf("connected", topo));
    const service = new UpdateMarkService(hosts, () => 0);
    service.hostsChanged();
    await until(() => expect(hosts.ready["mini"]).toEqual(["w1:p2"]));
    expect(herdr.reads.map((r) => r["pane_id"]).sort()).toEqual(["w1:p1", "w1:p2"]);
    expect(herdr.reads.find((r) => r["pane_id"] === "w1:p2")).toEqual({ pane_id: "w1:p2", source: "recent", lines: updateReadLines, format: "text", strip_ansi: true });
    expect(herdr.writes).toEqual([]);
  });
});
