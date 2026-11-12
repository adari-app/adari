// A Grok pane's Model and
// Effort chips from the summary.json beside its updates.jsonl
// (`current_model_id`, `reasoning_effort`; nothing guessed), and a pick: one
// typed `/model <id> <window> <effort>` and Enter, only with Grok's box on
// screen and empty, settled when its border (or summary.json) shows it. The
// recorded screens are Grok Build 1.0.70's; the same results as
// Tests/HerdrKitTests/GrokChipsTests.swift and GrokPickTests.swift.

import { describe, expect, it } from "vitest";

import {
  AgentSettingsReader,
  grokCommand,
  grokFilesOf,
  grokModelLabel,
  grokPickOf,
  grokWindowWord,
  parseGrokSignalsWindow,
  parseGrokSummary,
  readGrokScreen,
  tapReader,
  type GrokPick,
} from "../src/shared/agent-settings";
import { DemoGrokPane } from "../src/main/demo/demo-grok-pane";
import { driveGrokPick, grokPickTexts, grokSettleReads, pickGrokBound, type CursorMenuIO } from "../src/main/herdr/send";
import { grokModelScreen } from "./support/grok-model-fixtures";

const summary = (model: string | null = "grok-4.7", effort: string | null = "high"): string =>
  JSON.stringify({ info: { cwd: "/Users/demo/shed-plan" }, ...(model === null ? {} : { current_model_id: model }), ...(effort === null ? {} : { reasoning_effort: effort }) });

describe("summary.json", () => {
  it("names the model and each effort as the other chips word them", () => {
    for (const effort of ["low", "medium", "high", "xhigh"]) expect(parseGrokSummary(summary("grok-4.7", effort))).toEqual({ model: "grok-4.7", modelLabel: "Grok 4.7", effort });
    expect(parseGrokSummary(summary("grok-4.6", "low"))?.modelLabel).toBe("Grok 4.6");
    expect(grokModelLabel("grok-4.7")).toBe("Grok 4.7");
  });

  it("a missing field, another word, a bad or too large file: nothing", () => {
    for (const text of [summary(null), summary("grok-4.7", null), summary("grok-4.7", "max"), summary("grok-4.7", "High"), summary("grok-4.7-build"), summary("gpt-5"), '{"current_model_id":4.7,"reasoning_effort":"high"}', "not json", "[]", ""]) {
      expect(parseGrokSummary(text), text).toBeNull();
    }
    expect(parseGrokSummary(summary().slice(0, -1) + `,"pad":"${"x".repeat(64 * 1_024)}"}`)).toBeNull();
    expect(parseGrokSignalsWindow('{"contextTokensUsed":1800,"contextWindowTokens":256000}')).toBe(256_000);
    expect(parseGrokSignalsWindow('{"contextWindowTokens":"256000"}')).toBeNull();
  });

  it("is read beside the session with its reads (and signals.json's window); none: no chips", async () => {
    const path = "/Users/demo/.grok/sessions/x/019a/updates.jsonl";
    const files = new Map<string, string>([
      [path, '{"update":1}\n'],
      ["/Users/demo/.grok/sessions/x/019a/summary.json", summary("grok-4.6", "medium")],
      ["/Users/demo/.grok/sessions/x/019a/signals.json", '{"contextTokensUsed":1800,"contextWindowTokens":500000}'],
    ]);
    const reads: string[] = [];
    const base = {
      locate: async () => path,
      size: async (file: string) => {
        if (!files.has(file)) throw new Error("gone");
        return new TextEncoder().encode(files.get(file)!).length;
      },
      read: async (file: string, offset: number, max: number) => {
        reads.push(file);
        return new TextEncoder().encode(files.get(file)!).slice(offset, offset + max);
      },
    };
    const settings = new AgentSettingsReader("grok");
    let changes = 0;
    const tapped = tapReader(base as never, settings, () => (changes += 1));
    await tapped.size(path);
    await tapped.read(path, 0, 100);
    await expect.poll(() => settings.settings.modelLabel).toBe("Grok 4.6");
    expect(settings.settings.effort).toBe("medium");
    expect(settings.settings.window).toBe(500_000);
    expect(changes).toBe(1);
    expect(new Set(reads)).toEqual(new Set([path, "/Users/demo/.grok/sessions/x/019a/summary.json", "/Users/demo/.grok/sessions/x/019a/signals.json"]));
    // Read again only with the session grown, at most every 10 s: an idle read reads nothing more.
    const before = reads.length;
    await tapped.read(path, 14, 100);
    expect(reads.length).toBe(before + 1);

    const none = new AgentSettingsReader("grok");
    files.set("/Users/demo/.grok/sessions/x/019a/summary.json", JSON.stringify({ info: { cwd: "/x" } }));
    const plain = tapReader(base as never, none, () => undefined);
    await plain.size(path);
    await plain.read(path, 0, 100);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(none.settings.modelLabel).toBeNull();
    expect(none.settings.effort).toBeNull();
  });
});

describe("the command", () => {
  it("one per effort and window, nothing when what it needs is not known", () => {
    for (const level of ["low", "medium", "high", "xhigh"]) expect(grokCommand({ kind: "effort", value: level }, { model: "grok-4.6", window: "256k", effort: "high" })).toBe(`/model grok-4.6 256k ${level}`);
    expect(grokCommand({ kind: "context", value: "500k" }, { model: "grok-4.7", window: "256k", effort: "xhigh" })).toBe("/model grok-4.7 500k xhigh");
    expect(grokCommand({ kind: "model" }, { model: null, window: null, effort: null })).toBe("/model");
    expect(grokCommand({ kind: "effort", value: "high" }, { model: "grok-4.6", window: null, effort: "low" })).toBeNull();
    expect(grokCommand({ kind: "effort", value: "high" }, { model: "grok-4.6; rm", window: "256k", effort: "low" })).toBeNull();
    expect([grokWindowWord(256_000), grokWindowWord(500_000), grokWindowWord(200_000)]).toEqual(["256k", "500k", null]);
    expect([grokPickOf("picker"), grokPickOf("effort:xhigh"), grokPickOf("context:500k"), grokPickOf("effort:max"), grokPickOf("context:1m")]).toEqual([
      { kind: "model" },
      { kind: "effort", value: "xhigh" },
      { kind: "context", value: "500k" },
      null,
      null,
    ]);
  });

  it("the recorded screens read: the box, the border, the top line's window", () => {
    expect(readGrokScreen(grokModelScreen("00-idle"))).toEqual({ draft: "", borderModel: "Grok 4.6", borderEffort: "high", window: null, mode: "alwaysApprove" });
    expect(readGrokScreen(grokModelScreen("12-restored-high"))).toEqual({ draft: "", borderModel: "Grok 4.6", borderEffort: "high", window: "256k", mode: "alwaysApprove" });
    expect(readGrokScreen(grokModelScreen("07-after-medium"))?.borderEffort).toBe("medium");
    expect(readGrokScreen(grokModelScreen("08-typed-full-high"))?.draft).toBe("/model grok-4.6 256k high");
    expect(readGrokScreen(grokModelScreen("11-after-xhigh"))?.borderEffort).toBe("xhigh");
    expect(readGrokScreen(grokModelScreen("02-selector"))?.draft).toBe("/model <model> [window] [effort]");
    expect(readGrokScreen("  Allow Grok to run swift test?\n  1. Yes\n  2. No")).toBeNull();
  });
});

function pane(grok: DemoGrokPane, screen?: (text: string) => string, stop: string | null = null) {
  const log: string[] = [];
  let reads = 0;
  const io: CursorMenuIO = {
    read: async () => {
      reads += 1;
      return screen === undefined ? grok.screen() : screen(grok.screen());
    },
    type: async (text) => {
      log.push(`type ${text}`);
      grok.type(text);
    },
    keys: async (keys) => {
      log.push(keys.join(","));
      grok.keys(keys);
    },
    check: () => stop,
  };
  return { io, log, reads: () => reads };
}

const files = { model: "grok-4.6", window: "256k", effort: "high" };
const drive = (p: ReturnType<typeof pane>, pick: GrokPick, sent = files) => driveGrokPick(p.io, pick, sent, async () => undefined).then((done) => done.result);
const demo = (initial = {}) => new DemoGrokPane("wD:pK", "/U/demo/shed-plan", "Done.", () => undefined, { model: "grok-4.6", ...initial });

describe("a pick", () => {
  it("types one command and Enter, and settles on the border", async () => {
    const grok = demo();
    const p = pane(grok);
    expect(await drive(p, { kind: "effort", value: "medium" })).toEqual({ type: "set", effort: "medium", window: "256k" });
    expect(p.log).toEqual(["type /model grok-4.6 256k medium", "Enter"]);
    // Read again right before Enter (4 reads).
    expect(p.reads()).toBe(4);
    const wide = pane(grok);
    expect(await drive(wide, { kind: "context", value: "500k" }, { ...files, effort: "medium" })).toEqual({ type: "set", effort: "medium", window: "500k" });
    expect(wide.log).toEqual(["type /model grok-4.6 500k medium", "Enter"]);
    const same = pane(grok);
    expect(await drive(same, { kind: "effort", value: "medium" }, { ...files, window: "500k", effort: "medium" })).toEqual({ type: "set", effort: "medium", window: "500k" });
    expect(same.log).toEqual([]);
  });

  it("the Model chip opens Grok's list", async () => {
    const grok = demo();
    const p = pane(grok);
    expect(await drive(p, { kind: "model" })).toEqual({ type: "opened" });
    expect(p.log).toEqual(["type /model", "Enter"]);
    expect(grok.state.listOpen).toBe(true);
  });

  it("the user's text, a dialog or an unknown window: nothing typed", async () => {
    const drafted = pane(demo({ draft: "fix the shed door" }));
    expect(await drive(drafted, { kind: "effort", value: "low" })).toEqual({ type: "refused", note: grokPickTexts.draft });
    const dialog = pane(demo(), () => "  Allow Grok to run swift test?\n  1. Yes");
    expect(await drive(dialog, { kind: "effort", value: "low" })).toEqual({ type: "refused", note: grokPickTexts.noBox });
    const unknown = pane(demo(), (text) => text.replace("/ 256K", "/ 200K"));
    expect(await drive(unknown, { kind: "effort", value: "low" }, { ...files, window: null as never })).toEqual({ type: "refused", note: grokPickTexts.unknown });
    expect([...drafted.log, ...dialog.log, ...unknown.log]).toEqual([]);
  });

  it("a failed settle leaves a note; a wrong box is left alone; a stop sends nothing", async () => {
    const deaf = pane(demo(), (text) => text.replace(/\((low|medium|high|xhigh)\) ·/u, "(high) ·"));
    expect(await drive(deaf, { kind: "effort", value: "low" })).toEqual({ type: "refused", note: grokPickTexts.notShown });
    expect(deaf.log).toEqual(["type /model grok-4.6 256k low", "Enter"]);
    expect(deaf.reads()).toBe(3 + grokSettleReads);
    const garbled = demo();
    const back = pane(garbled, (text) => text.replace("\u{276F} /model grok-4.6 256k low ", "\u{276F} /model grok-4.6 256k lo  "));
    expect(await drive(back, { kind: "effort", value: "low" })).toEqual({ type: "refused", note: grokPickTexts.unexpected });
    // What the box shows is not the pick's own: left as it is (no Backspace, no Enter).
    expect(back.log).toEqual(["type /model grok-4.6 256k low"]);
    expect(garbled.state.draft).toBe("/model grok-4.6 256k low");
    const stopped = pane(demo(), undefined, "another program is in this pane now");
    expect(await drive(stopped, { kind: "effort", value: "low" })).toEqual({ type: "refused", note: grokPickTexts.stopped("another program is in this pane now") });
    expect(stopped.log).toEqual([]);
  });

  it("settles when summary.json shows it (its effort, then signals.json's window)", async () => {
    // The real send and settle path (pickGrokBound), the border never showing the
    // switch; the settle's file confirmation is the tapped reader's own bounded read of summary.json and
    // signals.json, which the pane writes when it switches.
    const run = async (pick: GrokPick, initial: { effort: string; window: string }) => {
      const grok = demo(initial);
      const before = { ...grok.state };
      const sessionFile = "/U/demo/.grok/sessions/x/019a/updates.jsonl";
      const body = (path: string): string =>
        path === sessionFile
          ? '{"update":1}\n'
          : path.endsWith("summary.json")
            ? grok.summary("/U/demo/shed-plan")
            : JSON.stringify({ contextTokensUsed: 1_800, contextWindowTokens: grok.state.window === "500k" ? 500_000 : 256_000 });
      const reader = {
        locate: async () => sessionFile,
        size: async (path: string) => new TextEncoder().encode(body(path)).length,
        read: async (path: string, offset: number, max: number) => new TextEncoder().encode(body(path)).slice(offset, offset + max),
      };
      const settings = new AgentSettingsReader("grok");
      const tap = tapReader(reader as never, settings, () => undefined);
      await tap.size(sessionFile);
      await tap.read(sessionFile, 0, 100);
      await tap.refreshGrok();
      const writes: string[] = [];
      // The border and the top line keep showing what it was (a screen that lags).
      const shown = (text: string) =>
        text.replace(/\((low|medium|high|xhigh)\) ·/u, `(${before.effort}) ·`).replace(/\/ (256K|500K) │/u, `/ ${before.window.toUpperCase()} │`);
      const site = {
        writer: { sendText: async (_p: string, text: string) => (writes.push(text), grok.type(text)) } as never,
        calls: { paneRead: async () => shown(grok.screen()), paneSendKeys: async (_p: string, keys: readonly string[]) => (writes.push(keys.join(",")), grok.keys(keys)) },
        fresh: async () => true,
        pane: () => ({ paneID: "wD:pK", terminalID: "t", agent: "grok", agentStatus: "idle" }) as never,
        agent: () => ({ paneID: "wD:pK", agent: "grok", agentStatus: "idle" }) as never,
        run: () => ({ connection: 3, arrival: 2 }),
      };
      const confirm = async () => {
        await tap.refreshGrok();
        return grokFilesOf(settings.settings);
      };
      const binding = { terminalID: "t", isAgent: true, kind: "grok", session: null, run: { connection: 3, arrival: 2 } };
      const done = await pickGrokBound(site, "wD:pK", pick, { ...files, ...initial }, binding, async () => undefined, confirm);
      return { done, writes };
    };
    const effort = await run({ kind: "effort", value: "medium" }, { effort: "high", window: "256k" });
    expect(effort.done.result).toEqual({ type: "set", effort: "medium", window: "256k" });
    expect(effort.writes).toEqual(["/model grok-4.6 256k medium", "Enter"]);
    const window = await run({ kind: "context", value: "500k" }, { effort: "medium", window: "256k" });
    expect(window.done.result).toEqual({ type: "set", effort: "medium", window: "500k" });
    expect(window.writes).toEqual(["/model grok-4.6 500k medium", "Enter"]);
  });

  it("a busy Grok, another run or a Claude binding: nothing read or typed", async () => {
    const run = (status: string, kind = "grok", arrival = 2) => {
      const grok = demo();
      const writes: string[] = [];
      const site = {
        writer: { sendText: async (_p: string, text: string) => (writes.push(text), grok.type(text)) } as never,
        calls: { paneRead: async () => grok.screen(), paneSendKeys: async (_p: string, keys: readonly string[]) => (writes.push(keys.join(",")), grok.keys(keys)) },
        fresh: async () => true,
        pane: () => ({ paneID: "wD:pK", terminalID: "t", agent: kind, agentStatus: status }) as never,
        agent: () => ({ paneID: "wD:pK", agent: kind, agentStatus: status }) as never,
        run: () => ({ connection: 3, arrival: 2 }),
      };
      return pickGrokBound(site, "wD:pK", { kind: "effort", value: "medium" }, files, { terminalID: "t", isAgent: true, kind, session: null, run: { connection: 3, arrival } }, async () => undefined).then((done) => ({ done, writes, grok }));
    };
    const idle = await run("idle");
    expect(idle.done.result).toEqual({ type: "set", effort: "medium", window: "256k" });
    expect(idle.writes).toEqual(["/model grok-4.6 256k medium", "Enter"]);
    const busy = await run("working");
    expect(busy.done.result).toEqual({ type: "busy" });
    const other = await run("idle", "grok", 1);
    const claude = await run("idle", "claude");
    expect(other.done.result.type).toBe("refused");
    expect(claude.done.result.type).toBe("refused");
    expect([...busy.writes, ...other.writes, ...claude.writes]).toEqual([]);
  });
});

describe("the chips", () => {
  it("show summary.json's model and effort on a Grok pane, its menus Effort then Context; Claude, Codex and Cursor as before", async () => {
    const { grokMenu, cursorMenu } = await import("../src/renderer/components/AgentChips");
    const settings = { model: "grok-4.6", modelLabel: "Grok 4.6", effort: "high", window: 256_000 };
    expect(grokMenu("effort", settings).map((item) => [item.group ?? "", item.label, item.ticked])).toEqual([
      ["Effort", "Low", false],
      ["", "Medium", false],
      ["", "High", true],
      ["", "Extra high", false],
      ["Context", "256K", true],
      ["", "500K", false],
    ]);
    expect(grokMenu("model", settings).map((item) => item.label)).toEqual(["Grok 4.6", "Choose in the Terminal\u{2026}"]);
    expect(cursorMenu("effort", { model: "Grok 4.7", window: "256K", effort: "medium", fast: false, percent: null }).map((item) => item.label)).toEqual([
      "Low",
      "Medium",
      "High",
      "Extra High",
      "256K",
      "500K",
      "Fast",
    ]);
  });
});

describe("the demo and its captures", () => {
  it("the demo's Grok pane takes Medium and its summary.json says it; steps 71-73", async () => {
    const { DemoBackend } = await import("../src/main/demo/demo-backend");
    const { demoHostIds, demoHosts } = await import("../src/main/demo/demo-hosts");
    const { bundledFixturesForTests } = await import("./support/demo-fixtures");
    const fixtures = bundledFixturesForTests();
    const host = demoHosts(fixtures, Date.now()).find((each) => each.descriptor.id === demoHostIds.macMini)!;
    const backend = new DemoBackend(host, fixtures);
    const transcript = host.transcripts.find((each) => each.agent === "grok")!;
    const summaryPath = transcript.path.replace(/updates\.jsonl$/, "summary.json");
    const read = async () => new TextDecoder().decode(await backend.transcripts().read(summaryPath, 0, 10_000));
    expect(parseGrokSummary(await read())).toEqual({ model: "grok-4.7", modelLabel: "Grok 4.7", effort: "high" });
    // The demo's pane waits on Grok's approval first;
    // its digit answers it, then Grok's box is drawn again.
    expect(readGrokScreen(await backend.paneText("wD:pK", 80))).toBeNull();
    await backend.promptIO().paneSendKeys("wD:pK", ["3"]);
    const screen = readGrokScreen(await backend.paneText("wD:pK", 80));
    expect(screen).toEqual({ draft: "", borderModel: "Grok 4.7", borderEffort: "high", window: "256k", mode: "alwaysApprove" });
    await backend.sendText("wD:pK", "/model grok-4.7 256k medium");
    await backend.promptIO().paneSendKeys("wD:pK", ["Enter"]);
    expect(readGrokScreen(await backend.paneText("wD:pK", 80))?.borderEffort).toBe("medium");
    expect(JSON.parse(await read())).toMatchObject({ info: { cwd: transcript.cwd }, current_model_id: "grok-4.7", reasoning_effort: "medium" });
    backend.close();

    const { grokChipsCaptureSteps } = await import("../src/main/capture");
    const steps = grokChipsCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual(["71-grok-chips", "72-grok-effort-menu", "73-grok-effort-medium"]);
    expect(steps[0]!.commands).toContainEqual({ type: "select-pane", hostId: demoHostIds.macMini, paneId: "wD:pK" });
  });
});
