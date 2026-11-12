// The Model and Effort chips' values, read from the
// pane's transcript by their own small reader (src/shared/agent-settings.ts),
// never by the chat parsers. Fixture lines are hand-made in Claude Code
// 2.1.316's shapes (a `/model` run leaves a
// <command-name> user line and a <local-command-stdout> user line with "Set
// model to …"; `/effort` the same with "Set effort level to …") and Codex's
// rollout `turn_context` shape.

import { describe, expect, it } from "vitest";

import {
  AgentSettingsReader,
  TranscriptLineTap,
  chipAgent,
  claudeEfforts,
  claudeModels,
  codexEfforts,
  effortLabel,
  modelFamily,
  modelLabel,
  pickCommand,
  tapReader,
} from "../src/shared/agent-settings";
import type { TranscriptFileReader } from "../src/shared/chat/feed";

const session = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
const stamp = (second: number): string => `2026-11-03T02:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`;

function assistant(model: string, second: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    isSidechain: false,
    message: { content: [{ text: "Done.", type: "text" }], id: `msg_${second}`, model, role: "assistant", stop_reason: "end_turn", type: "message" },
    sessionId: session,
    timestamp: stamp(second),
    type: "assistant",
    uuid: `a-${second}`,
    ...extra,
  });
}

function typed(text: string, second: number): string {
  return JSON.stringify({
    isSidechain: false,
    message: { content: text, role: "user" },
    origin: { kind: "human" },
    promptSource: "typed",
    sessionId: session,
    timestamp: stamp(second),
    type: "user",
    uuid: `u-${second}`,
  });
}

/** The two user lines a slash command leaves: its name and arguments, then what it printed. */
function command(name: string, args: string, stdout: string, second: number): string[] {
  return [
    JSON.stringify({
      isSidechain: false,
      message: {
        content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`,
        role: "user",
      },
      sessionId: session,
      timestamp: stamp(second),
      type: "user",
      uuid: `c-${second}`,
    }),
    JSON.stringify({
      isSidechain: false,
      message: { content: `<local-command-stdout>${stdout}</local-command-stdout>`, role: "user" },
      sessionId: session,
      timestamp: stamp(second),
      type: "user",
      uuid: `o-${second}`,
    }),
  ];
}

function codexContext(model: string, effort: string | null, second: number): string {
  return JSON.stringify({
    payload: { approval_policy: "never", cwd: "/Users/fixture/proj", ...(effort === null ? {} : { effort }), model },
    timestamp: stamp(second),
    type: "turn_context",
  });
}

function read(format: "claude" | "codex", lines: readonly string[]) {
  const reader = new AgentSettingsReader(format);
  let offset = 0;
  for (const line of lines) {
    reader.line(line, offset);
    offset += line.length + 1;
  }
  return reader.settings;
}

describe("the chips' values from the transcript", () => {
  it("reads the model from the newest assistant line's message.model", () => {
    expect(read("claude", [typed("hi", 1), assistant("claude-sonnet-4-5-20250929", 2), typed("more", 3), assistant("claude-opus-5-5", 4)])).toMatchObject({
      model: "claude-opus-5-5",
      modelLabel: "Opus 5.5",
      effort: null,
    });
  });

  it("names models as the chip shows them", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelLabel("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(modelLabel("claude-3-5-haiku-20241022")).toBe("Haiku 3.5");
    expect(modelLabel("claude-haiku-5-5[1m]")).toBe("Haiku 5.5");
    expect(modelLabel("gpt-5.5-codex")).toBe("gpt-5.5-codex");
    expect(modelFamily("claude-opus-5-5")).toBe("opus");
    expect(modelFamily("Fable 5.1")).toBe("fable");
    expect(modelFamily("gpt-5.5")).toBeNull();
  });

  it("skips synthetic and subagent assistant lines", () => {
    expect(read("claude", [assistant("claude-opus-5-5", 1), assistant("<synthetic>", 2), assistant("claude-haiku-5-5", 3, { isSidechain: true })]).modelLabel).toBe("Opus 5.5");
  });

  it("a /model result newer than the newest reply is the model now", () => {
    const lines = [assistant("claude-opus-5-5", 1), ...command("model", "sonnet", "Set model to \u001b[1mSonnet 5.5\u001b[22m", 2)];
    expect(read("claude", lines)).toMatchObject({ modelLabel: "Sonnet 5.5" });
    // …until a reply names another.
    expect(read("claude", [...lines, assistant("claude-fable-5-1", 3)])).toMatchObject({ modelLabel: "Fable 5.1", model: "claude-fable-5-1" });
  });

  it("reads Set model to with a parenthesis and as a model id", () => {
    expect(read("claude", command("model", "default", "Set model to Default (Opus 5.5)", 1)).modelLabel).toBe("Opus 5.5");
    expect(read("claude", command("model", "opus", "Set model to Opus 5.5 (default)", 1)).modelLabel).toBe("Opus 5.5");
    expect(read("claude", command("model", "claude-haiku-5-5", "Set model to claude-haiku-5-5", 1)).modelLabel).toBe("Haiku 5.5");
  });

  it("reads the effort from the newest Set effort level to result, else Default", () => {
    expect(read("claude", [assistant("claude-opus-5-5", 1)]).effort).toBeNull();
    expect(read("claude", [...command("effort", "high", "Set effort level to high (this session only): Deeper reasoning", 1)]).effort).toBe("high");
    expect(
      read("claude", [
        ...command("effort", "high", "Set effort level to high: Deeper reasoning", 1),
        assistant("claude-opus-5-5", 2),
        ...command("effort", "xhigh", "Set effort level to xhigh: Even deeper", 3),
      ]).effort,
    ).toBe("xhigh");
    // A level over the model's cap: Claude Code sets the cap and says so.
    expect(read("claude", command("effort", "max", "Effort 'max' exceeds the cap for Haiku 5.5 set by your settings or organization; set to 'high' instead: …", 1)).effort).toBe("high");
    // auto: back to the default.
    expect(read("claude", [...command("effort", "high", "Set effort level to high: x", 1), ...command("effort", "auto", "Set effort level to auto: x", 2)]).effort).toBeNull();
  });

  it("reads the result from a text block and from a system local_command line", () => {
    const block = JSON.stringify({
      isSidechain: false,
      message: { content: [{ text: "<local-command-stdout>Set effort level to low</local-command-stdout>", type: "text" }], role: "user" },
      type: "user",
      uuid: "b",
    });
    expect(read("claude", [block]).effort).toBe("low");
    const system = JSON.stringify({ content: "<local-command-stdout>Set effort level to medium</local-command-stdout>", subtype: "local_command", type: "system", uuid: "s" });
    expect(read("claude", [system]).effort).toBe("medium");
  });

  it("the user's own message quoting the words is not a result", () => {
    expect(read("claude", [typed("why does it say Set effort level to max?", 1)]).effort).toBeNull();
    expect(read("claude", [typed("<local-command-stdout>Set effort level to max</local-command-stdout>", 1)]).effort).toBeNull();
  });

  it("the user's queued message quoting the words is not a result; another session's queued line or a plain result still is", () => {
    const queued = (text: string, fields: Record<string, unknown>): string =>
      JSON.stringify({ isSidechain: false, message: { content: text, role: "user" }, sessionId: session, timestamp: stamp(2), type: "user", uuid: "q-2", ...fields });
    const human = { promptSource: "queued", origin: { kind: "human" }, turnOrigin: "human" };
    expect(read("claude", [queued("<local-command-stdout>Set effort level to max</local-command-stdout>", human)]).effort).toBeNull();
    expect(read("claude", [assistant("claude-opus-5-5", 1), queued("<local-command-stdout>Set model to Haiku</local-command-stdout>", human)]).modelLabel).toBe("Opus 5.5");
    const peer = { promptSource: "queued", origin: { kind: "peer" }, turnOrigin: "peer" };
    expect(read("claude", [queued("<local-command-stdout>Set effort level to low</local-command-stdout>", peer)]).effort).toBe("low");
  });

  it("an older line read later (Load earlier) never replaces a newer value", () => {
    const reader = new AgentSettingsReader("claude");
    expect(reader.line(assistant("claude-opus-5-5", 9), 5_000)).toBe(true);
    expect(reader.line(assistant("claude-haiku-5-5", 1), 100)).toBe(false);
    expect(reader.settings.modelLabel).toBe("Opus 5.5");
    expect(reader.line("not json", 6_000)).toBe(false);
  });

  // Claude Code writes the effort on every assistant line (a top-level `effort`).
  it("an assistant line's effort sets it; the newest line naming it wins, a /effort result or an assistant line", () => {
    const opus = (second: number, effort?: unknown): string => assistant("claude-opus-5-5", second, effort === undefined ? {} : { effort });
    const xhigh = read("claude", [opus(1, "xhigh")]);
    expect(xhigh.effort).toBe("xhigh");
    expect(effortLabel(xhigh.effort)).toBe("Extra high");
    // A later /effort result overrides it, and a later assistant line overrides that.
    const results = [opus(1, "xhigh"), ...command("effort", "low", "Set effort level to low: Quicker", 2)];
    expect(read("claude", results).effort).toBe("low");
    expect(read("claude", [...results, opus(3, "max")]).effort).toBe("max");
    // A line with no effort leaves it as it was.
    expect(read("claude", [...results, opus(3)]).effort).toBe("low");
  });

  it("an unknown effort on an assistant line is passed over, and a sidechain line's never counts", () => {
    const opus = (second: number, extra: Record<string, unknown>): string => assistant("claude-opus-5-5", second, extra);
    for (const value of ["auto", "ultra", "XHIGH", "", 3, null, true, { level: "high" }]) {
      expect(read("claude", [opus(1, { effort: "high" }), opus(2, { effort: value })]).effort).toBe("high");
    }
    expect(read("claude", [opus(1, { effort: "medium" }), opus(2, { effort: "max", isSidechain: true })]).effort).toBe("medium");
    expect(read("claude", [opus(1, { effort: "max", isSidechain: true })]).effort).toBeNull();
  });

  // An assistant line that names its effort but no model.
  it("an effort-only assistant line sets the effort; a newer one overrides a command; an older one read later does not replace it", () => {
    const only = (effort: string, second: number): string =>
      JSON.stringify({ isSidechain: false, effort, message: { content: [], role: "assistant" }, sessionId: session, timestamp: stamp(second), type: "assistant", uuid: `e-${second}` });
    expect(read("claude", [only("xhigh", 1)]).effort).toBe("xhigh");
    expect(read("claude", [...command("effort", "low", "Set effort level to low: Quicker", 1), only("max", 2)]).effort).toBe("max");
    const reader = new AgentSettingsReader("claude");
    expect(reader.line(only("high", 9), 5_000)).toBe(true);
    expect(reader.line(only("low", 1), 100)).toBe(false);
    expect(reader.settings.effort).toBe("high");
    expect(read("claude", [only("high", 1), only("auto", 2)]).effort).toBe("high");
    expect(read("claude", [JSON.stringify({ isSidechain: true, effort: "max", message: { content: [] }, type: "assistant" })]).effort).toBeNull();
  });

  it("reads Codex's turn_context model and effort", () => {
    expect(read("codex", [codexContext("gpt-5.5-codex", "high", 1), codexContext("gpt-5.5", "medium", 2)])).toMatchObject({ model: "gpt-5.5", modelLabel: "gpt-5.5", effort: "medium" });
    expect(read("codex", [codexContext("gpt-5.5", null, 1)]).effort).toBeNull();
  });
});

describe("the chips' menus and commands", () => {
  it("Claude Code's aliases and its five levels (the cap is the server's: all five are offered)", () => {
    expect(claudeModels.map((model) => model.alias)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(claudeModels.map((model) => model.label)).toEqual(["Fable", "Opus", "Sonnet", "Haiku"]);
    expect(claudeEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(codexEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel(null)).toBe("Default");
  });

  it("which panes get chips: Claude and Codex agents only", () => {
    expect(chipAgent(true, "claude")).toBe("claude");
    expect(chipAgent(true, "codex")).toBe("codex");
    expect(chipAgent(true, "opencode")).toBeNull();
    expect(chipAgent(true, null)).toBeNull();
    expect(chipAgent(false, "claude")).toBeNull();
  });

  it("a pick's own command line (a line naming a model is made only in main, from the machine's list)", () => {
    const none = { model: null, modelLabel: null, effort: null };
    expect(pickCommand("claude", "effort", "xhigh", none)).toBe("/effort xhigh");
    expect(pickCommand("claude", "compact", "compact", none)).toBe("/compact");
    // Model lines (Claude's /model, Codex's /model <model> --reasoning=<level>, Codex's bare /model) are never made here.
    expect(pickCommand("claude", "model", "opus", none)).toBeNull();
    expect(pickCommand("codex", "effort", "high", { model: "gpt-5.5", modelLabel: "gpt-5.5", effort: null })).toBeNull();
    expect(pickCommand("codex", "effort", "high", none)).toBeNull();
    expect(pickCommand("codex", "model", "picker", none)).toBeNull();
    // Nothing outside the menus goes.
    expect(pickCommand("claude", "model", "opus; rm", none)).toBeNull();
    expect(pickCommand("claude", "effort", "ultra", none)).toBeNull();
  });
});

describe("the reader's tap on the transcript reads", () => {
  it("hands whole lines with their offsets, joining a line split across reads", () => {
    const seen: [string, number][] = [];
    const tap = new TranscriptLineTap((text, offset) => seen.push([text, offset]));
    const enc = new TextEncoder();
    tap.read(0, enc.encode('{"a":1}\n{"b"'));
    tap.read(12, enc.encode(':2}\n'));
    expect(seen).toEqual([
      ['{"a":1}', 0],
      ['{"b":2}', 8],
    ]);
  });

  it("drops the first, maybe partial, line of a read that does not follow on", () => {
    const seen: [string, number][] = [];
    const tap = new TranscriptLineTap((text, offset) => seen.push([text, offset]));
    tap.read(100, new TextEncoder().encode('tail"}\n{"c":3}\n'));
    expect(seen).toEqual([['{"c":3}', 107]]);
  });

  it("a shorter file (replaced) starts the reader over", async () => {
    const files = new Map<string, Uint8Array>();
    const enc = new TextEncoder();
    const first = assistant("claude-opus-5-5", 1) + "\n" + assistant("claude-haiku-5-5", 2) + "\n";
    files.set("/t.jsonl", enc.encode(first));
    const base: TranscriptFileReader = {
      locate: async () => "/t.jsonl",
      size: async (path) => files.get(path)!.length,
      read: async (path, offset, max) => files.get(path)!.subarray(offset, offset + max),
    };
    const reader = new AgentSettingsReader("claude");
    let changes = 0;
    const tapped = tapReader(base, reader, () => (changes += 1));
    await tapped.read("/t.jsonl", 0, await tapped.size("/t.jsonl"));
    expect(reader.settings.modelLabel).toBe("Haiku 5.5");
    files.set("/t.jsonl", enc.encode(assistant("claude-fable-5-1", 3) + "\n"));
    await tapped.read("/t.jsonl", 0, await tapped.size("/t.jsonl"));
    expect(reader.settings.modelLabel).toBe("Fable 5.1");
    // Once per read that changed what the chips show.
    expect(changes).toBe(2);
    await tapped.read("/t.jsonl", 0, await tapped.size("/t.jsonl"));
    expect(changes).toBe(2);
  });
});
