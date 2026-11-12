// The tall-frame pieces one by one (matcher.ts needsTallRead,
// readPromptScreen, readingCut and a Bash frame's `run`; subject.ts
// pendingToolCalls, commandEndsWith and promptSubject). prompt-tall.test.ts
// and prompt-tall-headless.test.ts hold the behaviour each one serves. Last, the
// demo's tall screens and captures 131-133 (demo-tall.ts, capture.ts
// tallCardCaptureSteps).

import { describe, expect, it } from "vitest";

import { tallCardCaptureSteps } from "../src/main/capture";
import { demoHostIds } from "../src/main/demo/demo-hosts";
import {
  demoTallBashScreen,
  demoTallCommand,
  demoTallCutCall,
  demoTallCutCommand,
  demoTallCutDescription,
  demoTallCutScreen,
  demoTallDescription,
  demoTallEditFile,
  demoTallEditScreen,
} from "../src/main/demo/demo-tall";
import { bashDetail, makeTurn, toolCall, type ChatItem, type ChatToolCall } from "../src/shared/chat/model";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { makeSessionRef } from "../src/shared/chat/locator";
import { TranscriptParser } from "../src/shared/chat/parser";
import { cardContent } from "../src/shared/prompt/card";
import { matchPrompt, needsTallRead, promptReadLines, promptTallReadLines, readingCut, readingMatch, readPromptScreen, type CutFrame, type PromptMatch } from "../src/shared/prompt/matcher";
import { commandEndsWith, pendingToolCalls, promptSubject } from "../src/shared/prompt/subject";
import { L } from "./support/prompt-fixtures";
import { heredoc, longDiff, tail, tallBash, tallDescription, tallEdit, tallEditFile, tallFirstLine, yesAlwaysNo } from "./support/tall-prompts";

function matched(text: string, kind: string | null = "claude"): PromptMatch {
  const match = readingMatch(matchPrompt(text, "w1:p1", kind));
  if (match === null) throw new Error("expected a match");
  return match;
}

function cutOf(text: string): CutFrame {
  const cut = readingCut(matchPrompt(text, "w1:p1", "claude"));
  if (cut === null) throw new Error("expected a cut frame");
  return cut;
}

describe("the taller read", () => {
  it("is asked for a full read of a Claude pane ending in its frame cut off at the top, and for nothing else", () => {
    expect(promptReadLines).toBe(40);
    expect(promptTallReadLines).toBe(200);
    const cut = tail(tallBash(heredoc(60)), 40);
    expect(needsTallRead(cut, "claude")).toBe(true);
    expect(needsTallRead(cut, "Claude")).toBe(true);
    for (const kind of ["codex", "grok", "cursor", null, undefined]) expect(needsTallRead(cut, kind), `${kind}`).toBe(false);
    // A frame read whole, a whole pane shorter than the read, an edit's frame cut off too.
    expect(needsTallRead(L.claude2_1_303Bash, "claude")).toBe(false);
    expect(needsTallRead(tail(tallBash(heredoc(60)), 200), "claude")).toBe(false);
    expect(needsTallRead(tail(tallBash(heredoc(60)), 39), "claude")).toBe(false);
    expect(needsTallRead(tail(tallEdit(longDiff(40)), 40), "claude")).toBe(true);
  });

  it("readPromptScreen: 40 lines, then 200 once for a cut frame; one read for anything else", async () => {
    const screen = tallBash(heredoc(250));
    const asked: number[] = [];
    const read = (text: string) => (lines: number) => {
      asked.push(lines);
      return Promise.resolve(tail(text, lines));
    };
    // Still cut after the taller read: no third read.
    expect(await readPromptScreen(read(screen), "claude")).toBe(tail(screen, 200));
    expect(asked).toEqual([40, 200]);
    asked.length = 0;
    expect(await readPromptScreen(read(L.claude2_1_303Bash), "claude")).toBe(tail(L.claude2_1_303Bash, 40));
    expect(asked).toEqual([40]);
    asked.length = 0;
    expect(await readPromptScreen(read(screen), "codex")).toBe(tail(screen, 40));
    expect(asked).toEqual([40]);
  });

  it("readingCut: an unmatched reading's cut frame (Claude's own Yes/No too); null for any other", () => {
    const yesNo = matchPrompt(tail(tallBash(heredoc(250)), 200), "w1:p1", "claude");
    expect(yesNo.type).toBe("unmatched");
    expect(readingCut(yesNo)).toEqual({ question: "Do you want to proceed?", rows: heredoc(250).slice(-194).map((row) => row.trim()), lines: ["Do you want to proceed?", "❯ 1. Yes", "2. No", "Esc to cancel · Tab to amend"] });
    const three = matchPrompt(tail(tallBash(heredoc(250), yesAlwaysNo), 200), "w1:p1", "claude");
    expect(three.type).toBe("unmatched");
    expect(readingCut(three)?.rows.at(-1)).toBe("EOF");
    expect(readingCut(matchPrompt(L.claude2_1_303Bash, "w1:p1", "claude"))).toBeNull();
    expect(readingCut(null)).toBeNull();
    // An edit's cut frame holds its diff rows under the dashed rule (when that rule is on screen, only those under it).
    expect(cutOf(tail(tallEdit(longDiff(40)), 40)).question).toBe("Do you want to make this edit to summary.ts?");
  });
});

describe("a Bash frame's command and description", () => {
  it("the live frames: the command's rows as drawn, the description without its Tip (wrapped or not)", () => {
    expect(matched(L.claude2_1_303Bash).run).toEqual({ rows: ["echo shapes-c > /private/tmp/z-shapes/c.txt"], description: "Write shapes-c to c.txt in z-shapes directory" });
    expect(matched(L.claude2_1_303NamedBash).run?.description).toBe('Write "named" into n.txt in z-shapes2 directory');
    expect(matched(L.claude2_1_303Narrow54Bash).run).toEqual({ rows: ["echo mid > /private/tmp/z-narrow/m.txt"], description: 'Write "mid" to m.txt in z-narrow directory' });
    expect(matched(L.claude2_1_303Narrow39Bash).run).toEqual({ rows: ["echo narrow >", "/private/tmp/z-narrow/n.txt"], description: 'Write "narrow" to n.txt in z-narrow directory' });
    // A Write frame, an edit and other agents' frames carry none.
    expect(matched(L.claude2_1_303Write).run).toBeUndefined();
    expect(matched(tail(tallEdit(longDiff(40)), 200)).run).toBeUndefined();
    expect(matched(L.codex0_163_0Dialog, null).run).toBeUndefined();
  });

  it("a heredoc keeps its indentation and the Tip wrapped at 80 cells stays out of the description", () => {
    const run = matched(tail(tallBash(heredoc(30), undefined, 0, 80), 200)).run!;
    expect(run.description).toBe(tallDescription);
    expect(run.rows[4]).toBe("    data = json.loads(name.read_text())");
  });

  it("the card: one row stays in the header; two or more show as the block, six rows and N more", () => {
    const one = cardContent(matched(L.claude2_1_303Bash), "claude");
    expect([one.target, one.description, one.commandRows, one.commandMore]).toEqual(["echo shapes-c > /private/tmp/z-shapes/c.txt", null, [], 0]);
    const two = cardContent(matched(L.claude2_1_303Narrow39Bash), "claude");
    expect([two.target, two.description, two.commandRows, two.commandMore]).toEqual([null, 'Write "narrow" to n.txt in z-narrow directory', ["echo narrow >", "/private/tmp/z-narrow/n.txt"], 0]);
    // Grok's and Codex's cards are as before.
    const codex = cardContent(matched(L.codex0_163_0Dialog, null), "codex");
    expect([codex.description, codex.commandRows, codex.commandMore]).toEqual([null, [], 0]);
  });
});

const bash = (command: string, fields: Partial<ChatToolCall> = {}): ChatToolCall => ({
  ...toolCall(`toolu_${command.length}`, "bash", "Bash", command, { detail: { type: "bash", bash: bashDetail(command) } }),
  ...fields,
});
const edit = (file: string, toolName = "Edit"): ChatToolCall => toolCall(`toolu_${toolName}`, "edit", toolName, file);
const call = (value: ChatToolCall): ChatItem => ({ type: "toolCall", value });
const timeline = (...turns: ChatItem[][]) => ({ turns: turns.map((items, index) => makeTurn(`t${index}`, { items })) });

describe("Chat's running calls and what the card may say of a cut frame", () => {
  it("pendingToolCalls: the newest turn's calls with no result while it runs; never the user's shell, a background task or a subagent", () => {
    const running = bash("echo a");
    const second = bash("echo c");
    const done = bash("echo b", { state: "ok" });
    expect(pendingToolCalls(timeline([call(running), call(done), call(second)]))).toEqual([running, second]);
    expect(pendingToolCalls(timeline([call(done)]))).toEqual([]);
    expect(pendingToolCalls(timeline([call(running)], [call(done)]))).toEqual([]);
    expect(pendingToolCalls(timeline([call(bash("ls", { isUserShell: true }))]))).toEqual([]);
    expect(pendingToolCalls(timeline([call(bash("sleep 9", { task: { kind: "shell", title: "sleep", state: "running" } as unknown as ChatToolCall["task"] }))]))).toEqual([]);
    expect(pendingToolCalls(timeline([call({ ...toolCall("a1", "agent", "Agent", "Review"), subagent: { type: null, background: false, name: null } })]))).toEqual([]);
    expect(pendingToolCalls(timeline())).toEqual([]);
    // A finished newest turn lends none (an interrupted call left running), and no earlier turn is looked at.
    expect(pendingToolCalls({ turns: [makeTurn("t0", { items: [call(running)] }), makeTurn("t1", { isFinished: true, endedAt: 1_000, items: [call(second)] })] })).toEqual([]);
  });

  it("commandEndsWith: the rows on screen as written, only whitespace (or nothing) between two rows", () => {
    expect(commandEndsWith("cd x\nprint(1)\nEOF\n", ["print(1)", "EOF"])).toBe(true);
    // A word-wrap took a space, a hard wrap nothing, a new line its indentation.
    expect(commandEndsWith('echo "one two"', ['echo "one', 'two"'])).toBe(true);
    expect(commandEndsWith("echo abcdef", ["echo abc", "def"])).toBe(true);
    expect(commandEndsWith("if x:\n    y = 1", ["if x:", "y = 1"])).toBe(true);
    // Spaces inside a row count (quoted whitespace).
    expect(commandEndsWith('print("ab")\nEOF', ['print("a b")', "EOF"])).toBe(false);
    expect(commandEndsWith('print("a b")\nEOF', ['print("ab")', "EOF"])).toBe(false);
    expect(commandEndsWith("echo a\nEOF\nmore", ["EOF"])).toBe(false);
    expect(commandEndsWith("echo a", [])).toBe(false);
  });

  it("a command: the one running call whose end is the screen's rows; its tool, description and lines", () => {
    const command = heredoc(250).join("\n");
    const cut = cutOf(tail(tallBash(heredoc(250)), 200));
    expect(promptSubject([bash(command, { bashDescription: tallDescription })], cut)).toEqual({
      kind: "run",
      toolName: "Bash",
      description: tallDescription,
      file: null,
      rows: heredoc(250),
    });
    expect(promptSubject([bash(`${command}\n\n`)], cut)?.rows.at(-1)).toBe("EOF");
    // Wrapped at 80 cells: the rows on screen are the command's end all the same.
    expect(promptSubject([bash(heredoc(250).join("\n"))], cutOf(tail(tallBash(heredoc(250), undefined, 0, 80), 200)))?.kind).toBe("run");
    for (const other of [heredoc(251).join("\n"), "echo another command", `${tallFirstLine}\nEOF`]) expect(promptSubject([bash(other)], cut), other.slice(0, 30)).toBeNull();
    // Another call beside it that does not agree changes nothing; two that agree name nothing.
    expect(promptSubject([bash("echo another command"), bash(command)], cut)?.kind).toBe("run");
    expect(promptSubject([bash(command), bash(["cd /elsewhere; python3 -I - <<'EOF'", ...heredoc(250).slice(1)].join("\n"))], cut)).toBeNull();
    expect(promptSubject([], cut)).toBeNull();
    expect(promptSubject(undefined, cut)).toBeNull();
    expect(promptSubject([bash(command)], null)).toBeNull();
  });

  it("a file: the question names its whole name; the card gets that name, never the call's folder", () => {
    const cut = cutOf(tail(tallEdit(longDiff(150)), 200));
    expect(promptSubject([edit(tallEditFile)], cut)).toEqual({ kind: "edit", toolName: "Edit", description: null, file: "summary.ts", rows: [] });
    expect(promptSubject([edit(tallEditFile, "MultiEdit")], cut)?.kind).toBe("edit");
    // Another folder's summary.ts shows as summary.ts only; mary.ts or summary.tsx is not summary.ts.
    expect(promptSubject([edit("/synthetic/other/summary.ts")], cut)?.file).toBe("summary.ts");
    for (const other of ["/synthetic/mary.ts", "desktop/src/probe/summary.tsx", "desktop/src/probe/other.ts", "summary"]) expect(promptSubject([edit(other)], cut), other).toBeNull();
    expect(promptSubject([edit("/tmp/summary.ts", "Write")], { ...cut, question: "Do you want to create summary.ts?" })?.kind).toBe("create");
    expect(promptSubject([toolCall("w", "web", "WebFetch", "https://example.com")], cut)).toBeNull();
    expect(promptSubject([toolCall("n", "edit", "NotebookEdit", "summary.ts")], cut)).toBeNull();
    // Two edits of files named summary.ts: which one is asked about, the screen cannot say.
    expect(promptSubject([edit(tallEditFile), edit("/synthetic/other/summary.ts")], cut)).toBeNull();
  });
});

describe("the demo's tall approvals (captures 131-133)", () => {
  it("each is taller than the 40-line read and reads whole at 200: the command's 60 lines with its description, the edit's diff", async () => {
    const reads: number[] = [];
    const read = (screen: string) => async (lines: number) => {
      reads.push(lines);
      return tail(screen, lines);
    };
    expect(readingCut(matchPrompt(tail(demoTallBashScreen, promptReadLines), "w1:p1", "claude"))?.question).toBe("Do you want to proceed?");
    const run = readingMatch(matchPrompt(await readPromptScreen(read(demoTallBashScreen), "claude"), "w1:p1", "claude"))!;
    expect([run.question, run.options.map((option) => option.label), run.run?.rows, run.run?.description]).toEqual([
      "Do you want to proceed?",
      ["Yes", "No"],
      demoTallCommand,
      demoTallDescription,
    ]);
    const card = cardContent(run, "claude");
    expect([card.header, card.target, card.description, card.commandRows.length, card.commandMore]).toEqual(["Claude Code wants to run", null, demoTallDescription, 6, 54]);
    expect(matchPrompt(tail(demoTallEditScreen, promptReadLines), "w1:p1", "claude").type).toBe("unmatched");
    const edit = readingMatch(matchPrompt(await readPromptScreen(read(demoTallEditScreen), "claude"), "w1:p1", "claude"))!;
    expect([edit.context, cardContent(edit, "claude").target]).toEqual([{ type: "diff", added: 40, removed: 40 }, demoTallEditFile]);
    expect(reads).toEqual([promptReadLines, promptTallReadLines, promptReadLines, promptTallReadLines]);
  });

  it("131 the command and 132 the edit on the build box's screen; 133 a frame cut even at 200 on the Mac mini, Chat's call written; 133 puts it back", async () => {
    const shown: unknown[][] = [];
    const steps = tallCardCaptureSteps(demoHostIds, async (hostId, paneId, screens, running) => {
      shown.push([hostId, paneId, screens, running?.id ?? null]);
    });
    expect(steps.map((step) => step.name)).toEqual(["131-needs-card-tall-run", "132-needs-card-tall-edit", "133-needs-card-tall-cut"]);
    for (const step of steps) {
      const [hostId, paneId] = step.name.startsWith("133") ? [demoHostIds.macMini, "w6:p1"] : [demoHostIds.buildBox, "w1:p1"];
      expect(step.commands).toEqual([
        { type: "settings", open: false },
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId, folded: false },
        { type: "select-pane", hostId, paneId },
        { type: "set-tab", tab: "chat" },
      ]);
      for (const probe of [".nc-desc", ".nc-run .nc-cmd", ".nc-run .nc-more", ".nc-diff", ".nc-opt", "data-subject", ".nc-from", ".nc-file"]) expect(step.measure).toContain(probe);
      await step.before?.();
      await step.afterCapture?.();
    }
    expect(shown).toEqual([
      [demoHostIds.buildBox, "w1:p1", [demoTallBashScreen], null],
      [demoHostIds.buildBox, "w1:p1", [demoTallEditScreen], null],
      [demoHostIds.macMini, "w6:p1", [demoTallCutScreen], demoTallCutCall.id],
      [demoHostIds.macMini, "w6:p1", null, null],
    ]);
  });

  it("133 on the demo machine: its pane blocked on the frame, its transcript's newest turn running the call; put back after", async () => {
    const { DemoBackend } = await import("../src/main/demo/demo-backend");
    const { demoHosts } = await import("../src/main/demo/demo-hosts");
    const { bundledFixturesForTests } = await import("./support/demo-fixtures");
    const fixtures = bundledFixturesForTests();
    const backend = new DemoBackend(demoHosts(fixtures, Date.now()).find((each) => each.descriptor.id === demoHostIds.macMini)!, fixtures);
    const before = await backend.paneText("w6:p1", promptReadLines);
    const restore = backend.showPrompt("w6:p1", [demoTallCutScreen], demoTallCutCall);
    expect(backend.transport.setStatus("w6:p1", "blocked")).toBe("blocked");
    const screen = await readPromptScreen((lines) => backend.paneText("w6:p1", lines), "claude");
    expect(screen).toBe(tail(demoTallCutScreen, promptTallReadLines));
    const cut = readingCut(matchPrompt(screen, "w6:p1", "claude"))!;
    // Chat's timeline from the transcript as the demo now has it.
    const reader = backend.transcripts();
    const path = (await reader.locate(makeSessionRef("claude", { kind: "id", id: "7a3f0c2e-5b1d-4e6b-9c0d-6d656d6f0004" })!))!;
    const text = new TextDecoder().decode(await reader.read(path, 0, await reader.size(path)));
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder();
    text.split("\n").filter((line) => line !== "").forEach((line, index) => builder.apply(parser.parse(line, index).events, index));
    const pending = pendingToolCalls(builder.timeline);
    expect(pending.map((each) => each.id)).toEqual([demoTallCutCall.id]);
    expect(promptSubject(pending, cut)).toEqual({ kind: "run", toolName: "Bash", description: demoTallCutDescription, file: null, rows: demoTallCutCommand });
    restore();
    expect(backend.transport.setStatus("w6:p1", "done")).toBe("done");
    expect(await backend.paneText("w6:p1", promptReadLines)).toBe(before);
    backend.close();
  });

  it("133's frame is cut even at 200 rows, and Chat's running call (as the demo writes it) is the one the card names", () => {
    const cut = readingCut(matchPrompt(tail(demoTallCutScreen, promptTallReadLines), "w6:p1", "claude"))!;
    expect(cut.question).toBe("Do you want to proceed?");
    const call = bash(demoTallCutCall.input["command"]!, { bashDescription: demoTallCutDescription });
    expect(promptSubject([call], cut)).toEqual({ kind: "run", toolName: "Bash", description: demoTallCutDescription, file: null, rows: demoTallCutCommand });
  });
});
