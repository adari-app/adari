// The needs-you mark clears when the question is gone.
// Two reads in a row, at least 1 s apart, both after the block began, both
// showing nothing prompt-like: the pane shows as working until Herdr's status
// changes. A prompt again brings the mark back at once; a failed read keeps
// Herdr's mark; a pane Herdr does not say is blocked is never read.

import { describe, expect, it } from "vitest";

import { demoAskScreen, demoBashDone, demoEditScreen, demoQuartzDone, demoUnmatchedScreen } from "../src/main/demo/demo-prompts";
import { PromptService, promptReadIntervalMs, type PromptHosts } from "../src/main/prompt/prompts";
import { buildDesktopSidebar, findRow } from "../src/shared/desktop-sidebar";
import type { HostView } from "../src/shared/ipc-contract";
import { matchPrompt } from "../src/shared/prompt/matcher";
import { afterRead, applyCleared, marked, promptLike, quietGapMs } from "../src/shared/prompt/quiet";
import { F, L, Launch } from "./support/prompt-fixtures";
import { setup, show } from "./support/prompt-herdr";
import { bundledFixturesForTests } from "./support/demo-fixtures";

describe("prompt-like screens", () => {
  it("every question, read or not, is prompt-like", () => {
    const questions = {
      claudeEdit: F.claudeEdit,
      claudeBash: F.claudeBash,
      codexCommand: F.codexCommand,
      grokMenu: F.grokMenu,
      codexYesNo: F.codexYesNo,
      defaultYes: F.defaultYes,
      bracketAlone: F.bracketAlone,
      unsupportedApproval: F.unsupportedApproval,
      ...Launch,
      bash: L.claude2_1_303Bash,
      write: L.claude2_1_303Write,
      trust: L.claude2_1_303Trust,
      named: L.claude2_1_303NamedBash,
      narrow39: L.claude2_1_303Narrow39Bash,
      narrow54: L.claude2_1_303Narrow54Bash,
      codex: L.codex0_163_0Dialog,
      codex51: L.codex0_163_0Narrow51Dialog,
      demoEditScreen,
      demoAskScreen,
      demoUnmatchedScreen,
    };
    for (const [name, text] of Object.entries(questions)) {
      if (name.endsWith("Field")) continue;
      expect(promptLike(text), name).toBe(true);
    }
  });

  it("fields, working screens and answered screens are not", () => {
    const quiet = {
      working: F.working,
      staleList: F.staleList,
      claudeInput: F.claudeInput,
      codexInput: F.codexInput,
      grokInput: F.grokInput,
      pairingFeedbackField: Launch.pairingFeedbackField,
      afterNo: L.claude2_1_303AfterNo,
      idle: L.claude2_1_303IdleField,
      typed: L.claude2_1_303Typed,
      cleared: L.claude2_1_303ClearedANSI,
      claudeWorking: L.claude2_1_303Working,
      early: L.claude2_1_303WorkingEarly,
      narrowAfterNo: L.claude2_1_303Narrow54AfterNo,
      codexAfterNo: L.codex0_163_0AfterNo,
      codexIdle: L.codex0_163_0IdleField,
      codexWorking: L.codex0_163_0Working,
      codexAfter3: L.codex0_163_0Narrow51After3,
      grokIdle: L.grok1_0_60IdleField,
      demoQuartzDone,
      bashDone: demoBashDone(bundledFixturesForTests().bashDialog),
      empty: "",
    };
    for (const [name, text] of Object.entries(quiet)) expect(promptLike(text), name).toBe(false);
  });
});

describe("the two-read rule (afterRead)", () => {
  const seen = 1_000;
  const quiet = L.claude2_1_303AfterNo;

  it("two quiet reads in a row, at least 1 s apart, after the block began, clear the mark", () => {
    const one = afterRead(marked, { startedAt: 2_000, text: quiet }, seen);
    expect(one.cleared).toBe(false);
    expect(afterRead(one, { startedAt: 2_000 + quietGapMs, text: quiet }, seen).cleared).toBe(true);
  });

  it("not when they are under 1 s apart, nor with a read begun before the block", () => {
    const one = afterRead(marked, { startedAt: 2_000, text: quiet }, seen);
    expect(afterRead(one, { startedAt: 2_999, text: quiet }, seen).cleared).toBe(false);
    const before = afterRead(marked, { startedAt: 500, text: quiet }, seen);
    expect(afterRead(before, { startedAt: 2_000, text: quiet }, seen).cleared).toBe(false);
  });

  it("a prompt between them, or a failed read, starts again; either brings a cleared mark back at once", () => {
    const one = afterRead(marked, { startedAt: 2_000, text: quiet }, seen);
    const prompt = afterRead(one, { startedAt: 3_000, text: L.claude2_1_303Bash }, seen);
    expect(prompt).toEqual(marked);
    expect(afterRead(prompt, { startedAt: 4_000, text: quiet }, seen).cleared).toBe(false);
    const failed = afterRead(one, { startedAt: 3_000, text: null }, seen);
    expect(failed).toEqual(marked);
    const cleared = afterRead(one, { startedAt: 4_000, text: quiet }, seen);
    expect(cleared.cleared).toBe(true);
    expect(afterRead(cleared, { startedAt: 6_500, text: quiet }, seen).cleared).toBe(true);
    expect(afterRead(cleared, { startedAt: 6_500, text: demoUnmatchedScreen }, seen).cleared).toBe(false);
    expect(afterRead(cleared, { startedAt: 6_500, text: null }, seen).cleared).toBe(false);
  });
});

describe("the service: blocked panes read every 2.5 s, the mark cleared and brought back", () => {
  const step = async (context: Awaited<ReturnType<typeof setup>>, ms = 2_500): Promise<void> => {
    context.time.t += ms;
    await context.service.tick();
  };
  const cleared = (context: Awaited<ReturnType<typeof setup>>): boolean => context.service.list().find((prompt) => prompt.paneId === "w1:p1")!.cleared;

  it("two quiet reads clear it; the page shows the pane working, outside Needs you", async () => {
    const context = await setup(L.claude2_1_303AfterNo);
    expect(cleared(context)).toBe(false);
    await step(context);
    expect(cleared(context)).toBe(true);
    expect(context.pushed.at(-1)!.find((prompt) => prompt.paneId === "w1:p1")!.cleared).toBe(true);
    const herdr = context.registry.list();
    const shown = applyCleared(herdr, context.service.list());
    const sidebar = (hosts: readonly HostView[]) => buildDesktopSidebar(hosts, { search: "", nowUnixMs: 20_000, seenDone: {} });
    expect(sidebar(herdr).needsYou.map((entry) => entry.row.paneID)).toEqual(["w1:p1"]);
    expect(sidebar(shown).needsYou).toEqual([]);
    expect(sidebar(herdr).badge).toBe(1);
    expect(sidebar(shown).badge).toBe(0);
    const row = findRow(shown, "mac", "w1:p1", { nowUnixMs: 20_000, seenDone: {} })!;
    expect(row.status).toBe("working");
    expect(row.glyph).not.toBe("needsYou");
    expect(findRow(herdr, "mac", "w1:p1", { nowUnixMs: 20_000, seenDone: {} })!.glyph).toBe("needsYou");
  });

  it("a prompt again brings the mark back at the next read", async () => {
    const context = await setup(L.claude2_1_303AfterNo);
    await step(context);
    expect(cleared(context)).toBe(true);
    show(context.herdr, "w1:p1", L.claude2_1_303Bash);
    await step(context);
    expect(cleared(context)).toBe(false);
  });

  it("a failed read keeps Herdr's mark, and brings a cleared one back", async () => {
    const context = await setup(L.claude2_1_303AfterNo);
    context.herdr.readFails = true;
    await step(context);
    expect(cleared(context)).toBe(false);
    context.herdr.readFails = false;
    await step(context);
    expect(cleared(context)).toBe(false);
    await step(context);
    expect(cleared(context)).toBe(true);
    context.herdr.readFails = true;
    await step(context);
    expect(cleared(context)).toBe(false);
  });

  it("a read across a reconnect proves nothing", async () => {
    const context = await setup(L.claude2_1_303AfterNo);
    const read = context.herdr.roundTrip.bind(context.herdr);
    context.herdr.roundTrip = (line: string) => {
      if ((JSON.parse(line) as { method: string }).method === "pane.read") context.epoch.value += 1;
      return read(line);
    };
    await step(context);
    await step(context);
    expect(cleared(context)).toBe(false);
  });

  it("only until Herdr's status changes: a new block starts marked", async () => {
    const context = await setup(L.claude2_1_303AfterNo);
    await step(context);
    expect(cleared(context)).toBe(true);
    context.herdr.agentEntry("w1:p1")["status_since_unix_ms"] = 9_000;
    await context.registry.refreshAll();
    await step(context, 0);
    expect(cleared(context)).toBe(false);
  });

  it("a pane Herdr does not say is blocked is never read; nor any pane of a machine that does not answer", async () => {
    const context = await setup(L.claude2_1_303AfterNo);
    for (let index = 0; index < 4; index += 1) await step(context);
    const read = context.herdr.sent("pane.read").map((params) => params["pane_id"]);
    expect(new Set(read)).toEqual(new Set(["w1:p1"]));
    expect(read).toHaveLength(5);
    (context.registry as unknown as { entries: { state: string }[] }).entries[0]!.state = "offline";
    await step(context);
    expect(context.herdr.sent("pane.read")).toHaveLength(5);
    // Herdr says it is working now: no more reads, and nothing to clear.
    context.herdr.agentEntry("w1:p1")["agent_status"] = "working";
    context.herdr.paneEntry("w1:p1")["agent_status"] = "working";
    await context.registry.refreshAll();
    await step(context);
    expect(context.herdr.sent("pane.read")).toHaveLength(5);
    expect(context.service.list()).toEqual([]);
  });

  it("start reads every 2.5 s", () => {
    const intervals: number[] = [];
    const clock = { now: () => 0, sleep: () => Promise.resolve(), every: (ms: number) => (intervals.push(ms), () => undefined) };
    const service = new PromptService({ list: () => [] } as unknown as PromptHosts, () => undefined, clock);
    service.start();
    service.stop();
    expect(promptReadIntervalMs).toBe(2_500);
    expect(intervals).toEqual([2_500]);
  });
});

// Quiet needs readable content.
describe("blank or control-only reads, and unmarked menus, never clear", () => {
  const blanks = ["", " \n\t\n", "\u001b[2J\u001b[H"];

  for (const text of blanks) {
    it(`two reads of ${JSON.stringify(text)}, 2.5 s apart, keep the mark; one brings a cleared mark back`, () => {
      const one = afterRead(marked, { startedAt: 1_000, text }, 1_000);
      expect(afterRead(one, { startedAt: 3_500, text }, 1_000).cleared).toBe(false);
      const quiet = L.claude2_1_303AfterNo;
      const cleared = afterRead(afterRead(marked, { startedAt: 1_000, text: quiet }, 1_000), { startedAt: 3_500, text: quiet }, 1_000);
      expect(cleared.cleared).toBe(true);
      expect(afterRead(cleared, { startedAt: 6_000, text }, 1_000)).toEqual(marked);
    });
  }

  it("a blank read between two quiet ones breaks the row", () => {
    const quiet = L.claude2_1_303AfterNo;
    const one = afterRead(marked, { startedAt: 1_000, text: quiet }, 1_000);
    const blank = afterRead(one, { startedAt: 2_000, text: "\u001b[2J" }, 1_000);
    expect(afterRead(blank, { startedAt: 3_500, text: quiet }, 1_000).cleared).toBe(false);
  });

  it("an unsupported approval with unmarked numbered options is prompt-like (it stays marked and shows unmatched)", () => {
    const text = "Do you want to run this command?\n$ npm install\n1. Yes\n2. No";
    expect(matchPrompt(text, "w1:p1").type).toBe("unmatched");
    expect(promptLike(text)).toBe(true);
    const one = afterRead(marked, { startedAt: 1_000, text }, 1_000);
    expect(afterRead(one, { startedAt: 3_500, text }, 1_000).cleared).toBe(false);
  });

  it("the service: a pane that reads blank stays in Needs you", async () => {
    const context = await setup("\u001b[2J\u001b[H");
    for (let index = 0; index < 3; index += 1) {
      context.time.t += 2_500;
      await context.service.tick();
    }
    expect(context.service.list()[0]!.cleared).toBe(false);
  });
});

// A cleared override applies only
// to the block and connection it cleared, checked on every host update (not
// only at main's next 2.5 s read).
describe("a stale cleared override is dropped on the next host update", () => {
  const statusAfter = async (change: string): Promise<string> => {
    const context = await setup(L.claude2_1_303AfterNo);
    context.time.t += 2_500;
    await context.service.tick();
    expect(context.service.list()[0]!.cleared).toBe(true);
    const stale = context.service.list();
    if (change === "new block") context.herdr.agentEntry("w1:p1")["status_since_unix_ms"] = 9_999;
    if (change === "new terminal") context.herdr.paneEntry("w1:p1")["terminal_id"] = "replacement-terminal";
    if (change === "done") {
      context.herdr.agentEntry("w1:p1")["agent_status"] = "done";
      context.herdr.paneEntry("w1:p1")["agent_status"] = "done";
    }
    if (change === "new connection") context.epoch.value += 1;
    await context.registry.refreshAll();
    // No prompt tick in between: the page still holds the old list.
    return applyCleared(context.registry.list(), stale)[0]!.topology!.panes.find((pane) => pane.paneID === "w1:p1")!.agentStatus;
  };

  for (const change of ["new block", "new terminal", "new connection"]) {
    it(`after a ${change}, the pane shows Herdr's blocked`, async () => {
      expect(await statusAfter(change)).toBe("blocked");
    });
  }

  it("after done, the pane shows done", async () => {
    expect(await statusAfter("done")).toBe("done");
  });

  it("control: the same block on the same connection stays working", async () => {
    expect(await statusAfter("nothing")).toBe("working");
  });
});
