// The context ring left of the paperclip, its
// card and its Compact. The used count comes from the lines the Chat already
// reads (no read of its own); the limit from the user's own settings, read only and
// bounded, only the auto-compact keys kept; the pane's screen ("Context low
// (N% remaining)") wins when it shows; Compact goes the hidden way the chips'
// picks go, held while the pane works, once.

import { describe, expect, it } from "vitest";

import { AgentSettingsReader } from "../src/shared/agent-settings";
import {
  claudeModelWindow,
  codexCompactLimit,
  contextSettingsPaths,
  contextView,
  formatTokens,
  keepCompactSettings,
  ringLevel,
  screenContextRemaining,
  settingsReadLimit,
  type ContextLimits,
} from "../src/shared/context-meter";
import { ContextSettings } from "../src/main/chat/context-settings";
import { TranscriptNotFoundError, type TranscriptFileReader } from "../src/shared/chat/feed";
import { AgentPicks, type PickContext } from "../src/renderer/components/agent-picks";
import { contextCard } from "../src/renderer/components/ContextRing";
import { demoCaptureSteps } from "../src/main/capture";
import type { SendBinding } from "../src/shared/send-binding";

const line = (value: unknown): string => JSON.stringify(value);

const assistant = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", message: { model: "claude-opus-5-5", usage }, ...extra });

describe("the used count, from the lines the Chat reads", () => {
  it("Claude Code: the newest main-chain assistant usage, input + cache creation + cache read + output", () => {
    const reader = new AgentSettingsReader("claude");
    reader.line(assistant({ input_tokens: 10, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 200_000, output_tokens: 90 }), 0);
    expect(reader.settings.used).toBe(202_100);
    // A subagent's line (sidechain) is never the pane's count.
    reader.line(assistant({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 5, output_tokens: 1 }, { isSidechain: true }), 100);
    expect(reader.settings.used).toBe(202_100);
    reader.line(assistant({ input_tokens: 4, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 211_000, output_tokens: 996 }), 200);
    expect(reader.settings.used).toBe(213_000);
    // A line read later from earlier in the file (Load earlier) never replaces it.
    reader.line(assistant({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }), 50);
    expect(reader.settings.used).toBe(213_000);
  });

  it("Claude Code: as Claude Code counts it, the last iteration that is not a compaction or an advisor's", () => {
    const reader = new AgentSettingsReader("claude");
    reader.line(
      assistant({
        input_tokens: 9,
        cache_creation_input_tokens: 9,
        cache_read_input_tokens: 9,
        output_tokens: 9,
        iterations: [
          { type: "message", input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 50_000, output_tokens: 500 },
          { type: "compaction", input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
        ],
      }),
      0,
    );
    expect(reader.settings.used).toBe(50_600);
  });

  it("a compaction clears the count until the next turn, and is noted where it is", () => {
    const reader = new AgentSettingsReader("claude");
    reader.line(assistant({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 300_000, output_tokens: 0 }), 0);
    expect(reader.settings.compactedAt).toBeNull();
    reader.line(line({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }), 500);
    expect(reader.settings.used).toBeNull();
    expect(reader.settings.compactedAt).toBe(500);
  });

  it("Codex: the newest token_count's last_token_usage total and its model_context_window", () => {
    const reader = new AgentSettingsReader("codex");
    const count = (total: number) =>
      line({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: total }, model_context_window: 272_000 } } });
    reader.line(count(10_000), 0);
    reader.line(count(54_400), 100);
    reader.line(line({ type: "event_msg", payload: { type: "token_count", info: null } }), 200);
    expect([reader.settings.used, reader.settings.window]).toEqual([54_400, 272_000]);
    reader.line(line({ type: "compacted", payload: { message: "summary" } }), 300);
    expect([reader.settings.used, reader.settings.compactedAt]).toEqual([null, 300]);
  });
});

/** Files on the machine, read through the transcripts' reader; every read is logged. */
function machine(files: Record<string, string | number>) {
  const reads: { path: string; offset: number; max: number }[] = [];
  // The machine's home and real locations, as SFTP's realpath gives them.
  const reader: TranscriptFileReader & { home(): Promise<string>; realpath(path: string): Promise<string | null> } = {
    home: async () => "/Users/demo",
    realpath: async (path) => (files[path] === undefined ? null : path),
    locate: async () => null,
    size: async (path) => {
      const file = files[path];
      if (file === undefined) throw new TranscriptNotFoundError(path);
      return typeof file === "number" ? file : new TextEncoder().encode(file).length;
    },
    read: async (path, offset, max) => {
      reads.push({ path, offset, max });
      const file = files[path];
      if (typeof file !== "string") return new Uint8Array(max);
      return new TextEncoder().encode(file).subarray(offset, offset + max);
    },
  };
  return { reader, reads };
}

const transcript = "/Users/demo/.claude/projects/-Users-demo-Code-app/0b8c.jsonl";
const cwd = "/Users/demo/Code/app";

describe("the limit, the user's own value first", () => {
  it("finds the files from the transcript's config folder and the pane's folder; Codex's config.toml from its home", () => {
    expect(contextSettingsPaths("claude", transcript, cwd, "/Users/demo")).toEqual([
      { path: "/Users/demo/.claude/settings.json", kind: "user" },
      { path: "/Users/demo/Code/app/.claude/settings.json", kind: "project" },
      { path: "/Users/demo/Code/app/.claude/settings.local.json", kind: "local" },
    ]);
    expect(contextSettingsPaths("codex", "/Users/demo/.codex/sessions/2026/11/02/rollout-x.jsonl", cwd, "/Users/demo")).toEqual([
      { path: "/Users/demo/.codex/config.toml", kind: "user" },
    ]);
  });

  it("user, then project, then local: the later file wins", async () => {
    const { reader } = machine({
      "/Users/demo/.claude/settings.json": line({ autoCompactWindow: 300_000 }),
      "/Users/demo/Code/app/.claude/settings.json": line({ autoCompactWindow: 400_000 }),
    });
    const limits = await new ContextSettings().load(reader, "k", "claude", transcript, cwd);
    expect(limits.claude?.autoCompactWindow).toBe(400_000);
    expect(limits.claude?.from.autoCompactWindow).toBe("project");
    const local = machine({
      "/Users/demo/.claude/settings.json": line({ autoCompactWindow: 300_000 }),
      "/Users/demo/Code/app/.claude/settings.local.json": line({ autoCompactWindow: 500_000, autoCompactEnabled: false }),
    });
    const both = await new ContextSettings().load(local.reader, "k", "claude", transcript, cwd);
    expect([both.claude?.autoCompactWindow, both.claude?.autoCompactEnabled, both.claude?.from.autoCompactWindow]).toEqual([500_000, false, "local"]);
  });

  it("an env block's names count; nothing at all is no limit of the user's own", async () => {
    const { reader } = machine({
      "/Users/demo/.claude/settings.json": line({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "350000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" } }),
    });
    const limits = await new ContextSettings().load(reader, "k", "claude", transcript, cwd);
    expect(limits.claude?.env).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "350000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" });
    const none = await new ContextSettings().load(machine({}).reader, "k", "claude", transcript, cwd);
    expect(none.claude?.autoCompactWindow).toBeUndefined();
    expect(none.claude?.env).toBeUndefined();
  });

  it("a damaged file is passed over; a huge one is not read past the bound", async () => {
    const { reader, reads } = machine({
      "/Users/demo/.claude/settings.json": "{ not json",
      "/Users/demo/Code/app/.claude/settings.json": 40 * 1_024 * 1_024,
      "/Users/demo/Code/app/.claude/settings.local.json": line({ autoCompactWindow: 250_000 }),
    });
    const limits = await new ContextSettings().load(reader, "k", "claude", transcript, cwd);
    expect(limits.claude?.autoCompactWindow).toBe(250_000);
    expect(reads.every((read) => read.max <= settingsReadLimit)).toBe(true);
    expect(reads.some((read) => read.path.endsWith("/app/.claude/settings.json"))).toBe(false);
  });

  it("is read again at most once a minute, and again on a reconnect", async () => {
    let now = 0;
    const { reader, reads } = machine({ "/Users/demo/.claude/settings.json": line({ autoCompactWindow: 300_000 }) });
    const settings = new ContextSettings(() => now);
    await settings.load(reader, "mac-mini#1", "claude", transcript, cwd);
    await settings.load(reader, "mac-mini#1", "claude", transcript, cwd);
    expect(reads).toHaveLength(1);
    await settings.load(reader, "mac-mini#2", "claude", transcript, cwd);
    expect(reads).toHaveLength(2);
    now = 61_000;
    await settings.load(reader, "mac-mini#2", "claude", transcript, cwd);
    expect(reads).toHaveLength(3);
  });

  it("keeps only the auto-compact keys: nothing else from the file is kept", () => {
    const kept = keepCompactSettings(
      line({
        apiKeyHelper: "/bin/secret",
        permissions: { allow: ["Bash"] },
        autoCompactWindow: { opus: 400_000, sonnet: "auto" },
        autoCompactThreshold: 0.7,
        env: { ANTHROPIC_API_KEY: "sk-ant-x", CLAUDE_CODE_MAX_CONTEXT_TOKENS: 180_000, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "not a number" },
      }),
    );
    expect(kept).toEqual({ autoCompactWindow: { opus: 400_000, sonnet: "auto" }, autoCompactThreshold: 0.7, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "180000" } });
    expect(JSON.stringify(kept)).not.toMatch(/sk-ant|secret|Bash|ANTHROPIC/);
    expect(keepCompactSettings("[1,2]")).toBeNull();
    expect(keepCompactSettings("{ broken")).toBeNull();
  });

  it("Codex: model_auto_compact_token_limit at the top of config.toml, not inside a table", () => {
    expect(codexCompactLimit('model = "gpt-5.5"\nmodel_auto_compact_token_limit = 200_000\n')).toBe(200_000);
    expect(codexCompactLimit('[profiles.fast]\nmodel_auto_compact_token_limit = 9000\n')).toBeNull();
    expect(codexCompactLimit("")).toBeNull();
  });

  it("the model's window: 1M for a 1M model (Claude Code 2.1.316's table, or [1m]), else 200k", () => {
    expect(claudeModelWindow("claude-opus-5-5")).toBe(1_000_000);
    expect(claudeModelWindow("claude-sonnet-4-6")).toBe(200_000);
    expect(claudeModelWindow("claude-sonnet-4-6[1m]")).toBe(1_000_000);
    expect(claudeModelWindow("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(claudeModelWindow(null)).toBeNull();
  });
});

const claudeLimits = (settings: Record<string, unknown>, from: Record<string, string> = {}): ContextLimits => ({
  claude: { ...keepCompactSettings(line(settings)), from },
});

describe("the ring and its card", () => {
  it("the user's auto-compact window is the limit: 53% · 212k / 400k, the source said", () => {
    const view = contextView({
      agent: "claude",
      used: 212_000,
      window: null,
      model: "claude-opus-5-5",
      limits: claudeLimits({ autoCompactWindow: 400_000 }, { autoCompactWindow: "user" }),
      screenRemaining: null,
    });
    expect(view.headline).toBe("53% · 212k / 400k");
    expect(view.tooltip).toBe("212k of 400k");
    expect(view.source).toBe("compacts at 400k, autoCompactWindow in settings");
    expect(view.percent).toBe(53);
    expect(view.tickPercent).toBe(80);
  });

  it("with none of the user's own, the model's window; with no model, the used count alone", () => {
    const view = contextView({ agent: "claude", used: 212_000, window: null, model: "claude-opus-5-5", limits: claudeLimits({}), screenRemaining: null });
    expect([view.headline, view.source]).toEqual(["21% · 212k / 1M", "the model's 1M window"]);
    const alone = contextView({ agent: "claude", used: 212_000, window: null, model: null, limits: null, screenRemaining: null });
    expect([alone.headline, alone.tooltip, alone.percent]).toEqual(["212k used", "212k used", null]);
  });

  it("the env block's window and percent; Codex's limit and window", () => {
    const env = contextView({
      agent: "claude",
      used: 100_000,
      window: null,
      model: "claude-sonnet-4-6",
      limits: claudeLimits({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "150000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "60" } }, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "project" }),
      screenRemaining: null,
    });
    expect([env.headline, env.source, env.tickPercent]).toEqual(["67% · 100k / 150k", "compacts at 150k, CLAUDE_CODE_AUTO_COMPACT_WINDOW in the project's settings", 60]);
    const codex = contextView({ agent: "codex", used: 54_400, window: 272_000, model: "gpt-5.5", limits: { codexLimit: 200_000 }, screenRemaining: null });
    expect([codex.headline, codex.source]).toEqual(["27% · 54.4k / 200k", "compacts at 200k, model_auto_compact_token_limit in config.toml"]);
    const codexWindow = contextView({ agent: "codex", used: 54_400, window: 272_000, model: "gpt-5.5", limits: { codexLimit: null }, screenRemaining: null });
    expect(codexWindow.source).toBe("the model's 272k window");
  });

  it("the pane's screen wins when it shows Context low (N% remaining), and the card says so", () => {
    expect(screenContextRemaining("  ⎿ Context low (8% remaining) · Run /compact to compact & continue")).toBe(8);
    expect(screenContextRemaining("all quiet")).toBeNull();
    const view = contextView({
      agent: "claude",
      used: 212_000,
      window: null,
      model: "claude-opus-5-5",
      limits: claudeLimits({ autoCompactWindow: 400_000 }, { autoCompactWindow: "user" }),
      screenRemaining: 8,
    });
    expect(view.percent).toBe(92);
    expect(view.source).toBe("the pane's screen says Context low (8% remaining)");
    expect(view.level).toBe("red");
  });

  it("the accent below 80%, amber from 80%, red from 90%", () => {
    expect([ringLevel(79), ringLevel(80), ringLevel(89), ringLevel(90), ringLevel(null)]).toEqual(["accent", "amber", "amber", "red", "accent"]);
  });

  it("tokens read short: 950, 1.2k, 54.4k, 212k, 1M, 1.5M", () => {
    expect([950, 1_200, 54_400, 212_000, 1_000_000, 1_500_000].map(formatTokens)).toEqual(["950", "1.2k", "54.4k", "212k", "1M", "1.5M"]);
  });

  it("the card's words: Context, the numbers, the source, Compact or Compact after this turn", () => {
    const view = contextView({
      agent: "claude",
      used: 212_000,
      window: null,
      model: "claude-opus-5-5",
      limits: claudeLimits({ autoCompactWindow: 400_000 }, { autoCompactWindow: "user" }),
      screenRemaining: null,
    });
    const words = (card: ReturnType<typeof contextCard>) => [card.title, card.headline, card.source, card.button, card.disabled];
    expect(words(contextCard(view, null))).toEqual(["Context", "53% · 212k / 400k", "compacts at 400k, autoCompactWindow in settings", "Compact", false]);
    expect(words(contextCard(view, "held"))).toEqual(["Context", "53% · 212k / 400k", "compacts at 400k, autoCompactWindow in settings", "Compact after this turn", true]);
    expect(contextCard(view, "running").button).toBe("Compacting…");
    expect(contextCard(view, "waits").button).toBe("Compact after this turn");
  });
});

const binding: SendBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: "s1" };
const context = (status: PickContext["status"]): PickContext => ({ hostId: "mac-mini", paneId: "w7:p1", agent: "claude", status, binding });

describe("Compact", () => {
  it("goes as /compact the hidden way; held while the pane works, sent once, Compacted once the transcript shows it", async () => {
    let now = 0;
    const sent: string[] = [];
    const picks = new AgentPicks({ send: async (_h, _p, text) => void sent.push(text), copy: () => undefined, now: () => now });
    const key = "mac-mini/w7:p1";
    picks.receive(key, { model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: null, used: 300_000, compactedAt: null, scope: { terminalID: "t1", session: "s1" } }, "turn-1");
    picks.pick(context("working"), { kind: "compact", value: "compact", label: "Compact" });
    picks.pick(context("working"), { kind: "compact", value: "compact", label: "Compact" });
    expect(sent).toEqual([]);
    expect(picks.compacting(key, binding)).toBe("held");
    picks.sync(key, context("working"));
    expect(sent).toEqual([]);
    picks.sync(key, context("idle"));
    picks.sync(key, context("idle"));
    await Promise.resolve();
    expect(sent).toEqual(["/compact"]);
    now = 30_000;
    expect(picks.compacting(key, binding)).toBe("running");
    picks.receive(key, { model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: null, used: null, compactedAt: 9_000, scope: { terminalID: "t1", session: "s1" } }, "turn-2");
    expect(picks.compacting(key, binding)).toBeNull();
    expect(picks.confirmations(key, "turn-2")).toEqual(["Compacted"]);
  });

  it("a dialog holds it too", () => {
    const sent: string[] = [];
    const picks = new AgentPicks({ send: async (_h, _p, text) => void sent.push(text), copy: () => undefined, now: () => 0 });
    picks.pick(context("blocked"), { kind: "compact", value: "compact", label: "Compact" });
    expect(sent).toEqual([]);
    expect(picks.compacting("mac-mini/w7:p1", binding)).toBe("held");
  });
});

describe("the demo capture", () => {
  it("ends with a step with the context card open on the chips' pane (before New workspace's 39, 40)", async () => {
    const { demoHostIds } = await import("../src/main/demo/demo-hosts");
    // New workspace's two steps (39, 40) come after it.
    const step = demoCaptureSteps(demoHostIds).at(-3)!;
    expect(step.name).toBe("38-context-card"); // after the terminal copy's 36
    expect(step.commands).toEqual([
      { type: "click", selector: ".cmp-bar .chip.pick.effort .pick-b" },
      { type: "click", selector: ".cmp-bar .ctx-ring" },
    ]);
  });
});

describe("the chat update (the demo machine)", () => {
  it("carries the used count from the Chat's reads and the user's limits (none on the demo machine: the model's window)", async () => {
    const { ChatService } = await import("../src/main/chat/service");
    const { DemoBackend } = await import("../src/main/demo/demo-backend");
    const { demoHostIds, demoHosts } = await import("../src/main/demo/demo-hosts");
    const { HostRegistry } = await import("../src/main/hosts");
    const { bundledFixturesForTests } = await import("./support/demo-fixtures");
    const { eventually } = await import("./support/chat-lines");
    const registry = new HostRegistry(() => undefined);
    const fixtures = bundledFixturesForTests();
    for (const host of demoHosts(fixtures, Date.now())) registry.add(host.descriptor, new DemoBackend(host, fixtures));
    await registry.refreshAll();
    const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
    const updates: { settings?: { used?: number | null; limits?: ContextLimits | null; model: string | null } }[] = [];
    const page = { id: 1, send: (_channel: string, payload: never) => updates.push(payload), isDestroyed: () => false };
    service.open(page, demoHostIds.macMini, "w7:p1H");
    await eventually(() => typeof updates.at(-1)?.settings?.used === "number" && updates.at(-1)?.settings?.limits != null);
    const settings = updates.at(-1)!.settings!;
    expect(settings.used).toBeGreaterThan(190_000);
    expect(settings.limits).toEqual({ claude: { from: {} } });
    const view = contextView({ agent: "claude", used: settings.used!, window: null, model: settings.model, limits: settings.limits!, screenRemaining: null });
    expect(view.source).toBe("the model's 1M window");
    service.closeAll();
    registry.close();
  });
});
