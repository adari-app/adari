// The context ring's numbers and words.
//
// Used: what the Chat's own reads carry (agent-settings.ts's reader): Claude
// Code's newest main-chain assistant usage, input + cache creation + cache
// read + output (Claude Code 2.1.316 counts it so, from the last usage
// iteration that is not a compaction's or an advisor's when the line has
// them), and Codex's newest token_count (info.last_token_usage.total_tokens,
// info.model_context_window).
//
// The limit, your own value first: the auto-compact window from your settings
// (the config folder's settings.json, then the pane folder's
// .claude/settings.json, then .claude/settings.local.json; the later wins), or
// Codex's model_auto_compact_token_limit; else the model's window (Claude: 1M
// for a model Claude Code's table gives 1M natively, or an id with [1m];
// otherwise 200k; Codex: model_context_window). Only the auto-compact keys are
// ever kept from those files (keepCompactSettings). When the pane's screen
// shows "Context low (N% remaining)", that percent wins.
//
// The card's tick is where compaction fires: for Claude Code, 80% of the
// window (2.1.316's default summary buffer, 0.2), lowered by
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE or set by autoCompactThreshold; none when
// autoCompactEnabled is false. For Codex, its limit when set.

import type { ChipAgent } from "./agent-settings";

/** The most read of one settings file: a larger one is passed over. */
export const settingsReadLimit = 64 * 1_024;
/** A file's settings are read again after this long (and on a reconnect). */
export const settingsRereadMs = 60_000;

export type SettingsFileKind = "user" | "project" | "local";

export const compactEnvNames = ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"] as const;
export type CompactEnvName = (typeof compactEnvNames)[number];

export type CompactWindow = number | "auto";

/** The only values ever kept from a Claude Code settings file. */
export interface KeptCompactSettings {
  readonly autoCompactWindow?: CompactWindow | Readonly<Record<string, CompactWindow>>;
  readonly autoCompactEnabled?: boolean;
  readonly autoCompactThreshold?: number;
  readonly env?: Readonly<Partial<Record<CompactEnvName, string>>>;
}

export type CompactKey = "autoCompactWindow" | "autoCompactEnabled" | "autoCompactThreshold" | CompactEnvName;

/** The files' settings together, each with the file it came from. */
export interface CompactSettings extends KeptCompactSettings {
  readonly from: Readonly<Partial<Record<CompactKey, SettingsFileKind>>>;
}

/** What the main process sends for the ring with a chat update. */
export interface ContextLimits {
  readonly claude?: CompactSettings;
  /** Codex's model_auto_compact_token_limit, null when it is not set. */
  readonly codexLimit?: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isWindowNumber = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1_000 && value <= 10_000_000;

function keptWindow(value: unknown): CompactWindow | null {
  if (value === "auto") return "auto";
  return isWindowNumber(value) ? value : null;
}

/**
 * A settings file's text: only the auto-compact keys, checked; nothing else
 * of it is kept. Null when it is not a JSON object (damaged).
 */
export function keepCompactSettings(text: string): KeptCompactSettings | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const out: {
    autoCompactWindow?: CompactWindow | Record<string, CompactWindow>;
    autoCompactEnabled?: boolean;
    autoCompactThreshold?: number;
    env?: Partial<Record<CompactEnvName, string>>;
  } = {};
  const window = value["autoCompactWindow"];
  const plain = keptWindow(window);
  if (plain !== null) out.autoCompactWindow = plain;
  else if (isRecord(window)) {
    const byModel: Record<string, CompactWindow> = {};
    for (const [model, entry] of Object.entries(window).slice(0, 32)) {
      const kept = keptWindow(entry);
      if (kept !== null && /^[A-Za-z0-9._:\-[\]]{1,64}$/.test(model)) byModel[model] = kept;
    }
    if (Object.keys(byModel).length > 0) out.autoCompactWindow = byModel;
  }
  if (typeof value["autoCompactEnabled"] === "boolean") out.autoCompactEnabled = value["autoCompactEnabled"];
  const threshold = value["autoCompactThreshold"];
  if (typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0 && threshold <= 10_000_000) out.autoCompactThreshold = threshold;
  const env = value["env"];
  if (isRecord(env)) {
    const kept: Partial<Record<CompactEnvName, string>> = {};
    for (const name of compactEnvNames) {
      const entry = env[name];
      const text = typeof entry === "number" && Number.isFinite(entry) ? String(entry) : entry;
      if (typeof text === "string" && /^\d{1,8}(\.\d{1,4})?$/.test(text.trim())) kept[name] = text.trim();
    }
    if (Object.keys(kept).length > 0) out.env = kept;
  }
  return out;
}

/** The files in order (user, project, local): a later file's key wins, an env name each on its own. */
export function mergeCompactSettings(files: readonly { readonly kind: SettingsFileKind; readonly settings: KeptCompactSettings }[]): CompactSettings {
  const from: Partial<Record<CompactKey, SettingsFileKind>> = {};
  const merged: {
    autoCompactWindow?: KeptCompactSettings["autoCompactWindow"];
    autoCompactEnabled?: boolean;
    autoCompactThreshold?: number;
    env?: Partial<Record<CompactEnvName, string>>;
  } = {};
  for (const { kind, settings } of files) {
    if (settings.autoCompactWindow !== undefined) {
      merged.autoCompactWindow = settings.autoCompactWindow;
      from.autoCompactWindow = kind;
    }
    if (settings.autoCompactEnabled !== undefined) {
      merged.autoCompactEnabled = settings.autoCompactEnabled;
      from.autoCompactEnabled = kind;
    }
    if (settings.autoCompactThreshold !== undefined) {
      merged.autoCompactThreshold = settings.autoCompactThreshold;
      from.autoCompactThreshold = kind;
    }
    for (const name of compactEnvNames) {
      const entry = settings.env?.[name];
      if (entry === undefined) continue;
      merged.env = { ...merged.env, [name]: entry };
      from[name] = kind;
    }
  }
  return { ...merged, from };
}

/** Codex's model_auto_compact_token_limit, at the top level of config.toml (before any [table]). */
export function codexCompactLimit(toml: string): number | null {
  for (const raw of toml.split(/\r?\n/)) {
    const text = raw.trim();
    if (text.startsWith("[")) return null;
    const match = /^model_auto_compact_token_limit\s*=\s*([0-9][0-9_]{0,12})\s*(#.*)?$/.exec(text);
    if (match !== null) {
      const value = Number(match[1]!.replace(/_/g, ""));
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    }
  }
  return null;
}

/** The deepest settings path read (components below "/"). */
export const maxSettingsDepth = 32;

/**
 * A path the settings may be read under: absolute, made of plain
 * components (no "", ".", ".." or control characters, each at most 255
 * characters), at most `maxSettingsDepth` deep, and inside `home` (or home itself).
 */
export function isConfinedPath(path: string, home: string): boolean {
  if (!isPlainAbsolute(home) || !isPlainAbsolute(path)) return false;
  return path === home || path.startsWith(home.endsWith("/") ? home : `${home}/`);
}

const hasControl = (text: string): boolean => Array.from(text).some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);

function isPlainAbsolute(path: string): boolean {
  if (!path.startsWith("/") || path === "/" || path.endsWith("/")) return false;
  const parts = path.slice(1).split("/");
  return (
    parts.length <= maxSettingsDepth &&
    parts.every((part) => part !== "" && part !== "." && part !== ".." && part.length <= 255 && !hasControl(part))
  );
}

const fileName = /^[A-Za-z0-9._-]{1,200}\.jsonl$/;
const slugName = /^[A-Za-z0-9._-]{1,255}$/;

/**
 * The settings files for a pane's transcript, inside the machine's `home`:
 * Claude Code's three, or Codex's config.toml. None unless the
 * transcript has the expected shape (`<config>/projects/<slug>/<session>.jsonl`;
 * `<codex home>/sessions/<yyyy>/<mm>/<dd>/<rollout>.jsonl` or
 * `<codex home>/archived_sessions/<rollout>.jsonl`) and every folder is
 * confined to home (isConfinedPath); a pane folder outside it adds nothing.
 */
export function contextSettingsPaths(
  format: ChipAgent,
  transcriptPath: string,
  cwd: string | null,
  home: string,
): { path: string; kind: SettingsFileKind }[] {
  if (!isConfinedPath(transcriptPath, home)) return [];
  const parts = transcriptPath.slice(1).split("/");
  const name = parts.at(-1) ?? "";
  if (!fileName.test(name)) return [];
  const folder = (count: number): string => `/${parts.slice(0, parts.length - count).join("/")}`;
  if (format === "codex") {
    let codexHome: string | null = null;
    const [year, month, day] = parts.slice(-4, -1);
    if (parts.at(-5) === "sessions" && /^\d{4}$/.test(year ?? "") && /^\d{2}$/.test(month ?? "") && /^\d{2}$/.test(day ?? "")) codexHome = folder(5);
    else if (parts.at(-2) === "archived_sessions") codexHome = folder(2);
    if (codexHome === null || !isConfinedPath(codexHome, home)) return [];
    return [{ path: `${codexHome}/config.toml`, kind: "user" }];
  }
  if (parts.at(-3) !== "projects" || !slugName.test(parts.at(-2) ?? "")) return [];
  const config = folder(3);
  if (!isConfinedPath(config, home)) return [];
  const out: { path: string; kind: SettingsFileKind }[] = [{ path: `${config}/settings.json`, kind: "user" }];
  const project = cwd?.replace(/\/+$/, "") ?? null;
  if (project !== null && isConfinedPath(project, home)) {
    out.push({ path: `${project}/.claude/settings.json`, kind: "project" }, { path: `${project}/.claude/settings.local.json`, kind: "local" });
  }
  return out;
}

// Claude Code 2.1.316's model table, the models with a native 1M window.
const native1m = /^claude-(?:(?:fable|mythos|sonnet|haiku|opus)-5(?:-\d+)?|haiku-5-5|opus-4-[789])(?:-\d{8})?$/;

/** The Claude model's window: 1M for a native 1M model or one asked for with [1m], else 200k; null when the model is not known. */
export function claudeModelWindow(model: string | null): number | null {
  if (model === null || model === "") return null;
  const id = model.trim().toLowerCase();
  if (id.endsWith("[1m]")) return 1_000_000;
  return native1m.test(id) ? 1_000_000 : 200_000;
}

/** "Context low (8% remaining)" on the pane's screen: 8; null when it does not show. */
export function screenContextRemaining(text: string): number | null {
  const match = /Context low \((\d{1,3})% remaining\)/.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  return value <= 100 ? value : null;
}

/** 950, 1.2k, 54.4k, 212k, 1M, 1.5M. */
export function formatTokens(value: number): string {
  const short = (n: number): string => (n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
  if (value >= 1_000_000) return `${short(value / 1_000_000)}M`;
  if (value >= 1_000) return `${short(value / 1_000)}k`;
  return String(Math.round(value));
}

export type RingLevel = "accent" | "amber" | "red";

/** The accent below 80%, amber from 80%, red from 90%. */
export function ringLevel(percent: number | null): RingLevel {
  if (percent === null || percent < 80) return "accent";
  return percent < 90 ? "amber" : "red";
}

export interface ContextInput {
  /** Or Cursor, whose window and share come from its footer. */
  readonly agent: ChipAgent | "cursor" | "grok";
  readonly used: number | null;
  /** Codex's model_context_window. */
  readonly window: number | null;
  readonly model: string | null;
  readonly limits: ContextLimits | null;
  /** The percent remaining the pane's screen shows, or null. */
  readonly screenRemaining: number | null;
}

export interface ContextView {
  readonly used: number | null;
  readonly limit: number | null;
  /** Used of the limit, 0 to 100; null when there is no limit. */
  readonly percent: number | null;
  /** Where compaction fires, as a percent of the limit; null when not known. */
  readonly tickPercent: number | null;
  /** "53% · 212k / 400k", "212k used", "Not known yet". */
  readonly headline: string;
  /** "212k of 400k". */
  readonly tooltip: string;
  /** Where the limit comes from; null when there is none. */
  readonly source: string | null;
  readonly level: RingLevel;
}

const fileWords: Readonly<Record<SettingsFileKind, string>> = {
  user: "in settings",
  project: "in the project's settings",
  local: "in the project's local settings",
};

const envNumber = (settings: KeptCompactSettings | undefined, name: CompactEnvName): number | null => {
  const text = settings?.env?.[name];
  if (text === undefined) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** A per-model autoCompactWindow's entry for the model: its id, its id without a date or [1m], or its family. */
function windowFor(setting: KeptCompactSettings["autoCompactWindow"], model: string | null): CompactWindow | null {
  if (setting === undefined) return null;
  if (typeof setting === "number" || setting === "auto") return setting;
  if (model === null) return null;
  const id = model.toLowerCase().replace(/\[1m\]$/, "");
  const family = /(fable|mythos|opus|sonnet|haiku)/.exec(id)?.[1];
  for (const key of [model, id, id.replace(/-\d{8}$/, ""), family]) {
    if (key !== undefined && setting[key] !== undefined) return setting[key]!;
  }
  return null;
}

const percentOf = (used: number, limit: number): number => Math.max(0, Math.min(100, Math.round((used / limit) * 100)));

/** The ring and the card for the pane. */
export function contextView(input: ContextInput): ContextView {
  const { used } = input;
  let limit: number | null = null;
  let source: string | null = null;
  let compactAt: number | null = null;
  if (input.agent === "claude") {
    const settings = input.limits?.claude;
    const from = settings?.from ?? {};
    const maxTokens = envNumber(settings, "CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    let modelWindow = claudeModelWindow(input.model);
    let modelWords = modelWindow === null ? null : `the model's ${formatTokens(modelWindow)} window`;
    if (maxTokens !== null) {
      modelWindow = modelWindow === null ? maxTokens : Math.min(modelWindow, maxTokens);
      modelWords = `a ${formatTokens(modelWindow)} window, CLAUDE_CODE_MAX_CONTEXT_TOKENS ${fileWords[from.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? "user"]}`;
    }
    const envWindow = envNumber(settings, "CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    const setWindow = windowFor(settings?.autoCompactWindow, input.model);
    let own: number | null = null;
    let ownWords: string | null = null;
    if (envWindow !== null) {
      own = envWindow;
      ownWords = `CLAUDE_CODE_AUTO_COMPACT_WINDOW ${fileWords[from.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? "user"]}`;
    } else if (typeof setWindow === "number") {
      own = setWindow;
      ownWords = `autoCompactWindow ${fileWords[from.autoCompactWindow ?? "user"]}`;
    }
    if (own !== null && modelWindow !== null) own = Math.min(own, modelWindow);
    if (own !== null) {
      limit = own;
      source = `compacts at ${formatTokens(own)}, ${ownWords}`;
    } else if (modelWindow !== null) {
      limit = modelWindow;
      source = modelWords;
    }
    if (limit !== null && settings?.autoCompactEnabled !== false) {
      const threshold = settings?.autoCompactThreshold;
      compactAt =
        threshold === undefined ? limit * 0.8 : threshold < 1 ? limit * threshold : threshold <= 100 ? (limit * threshold) / 100 : Math.min(limit, threshold);
      const pct = envNumber(settings, "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
      if (pct !== null && pct <= 100) compactAt = Math.min(compactAt, (limit * pct) / 100);
    }
    if (limit !== null && settings?.autoCompactEnabled === false) source = `${source}; auto-compact is off`;
  } else if (input.agent === "grok") {
    // The window its signals.json names (the app's ContextView.grok).
    if (input.window !== null) {
      limit = input.window;
      source = `Grok's signals.json (${formatTokens(limit)} window)`;
    }
  } else if (input.agent === "cursor") {
    // The window its footer names (`256K`); Cursor compacts by itself, at a point it does not show.
    if (input.window !== null) {
      limit = input.window;
      source = `Cursor's footer (${formatTokens(limit)} window)`;
    }
  } else {
    const own = input.limits?.codexLimit ?? null;
    if (own !== null) {
      limit = input.window === null ? own : Math.min(own, input.window);
      source = `compacts at ${formatTokens(limit)}, model_auto_compact_token_limit in config.toml`;
      compactAt = limit;
    } else if (input.window !== null) {
      limit = input.window;
      source = `the model's ${formatTokens(limit)} window`;
    }
  }
  let percent = used !== null && limit !== null ? percentOf(used, limit) : null;
  const tickPercent = compactAt !== null && limit !== null ? percentOf(compactAt, limit) : null;
  let headline: string;
  let tooltip: string;
  if (used !== null && limit !== null) {
    headline = `${percent}% · ${formatTokens(used)} / ${formatTokens(limit)}`;
    tooltip = `${formatTokens(used)} of ${formatTokens(limit)}`;
  } else if (used !== null) {
    headline = `${formatTokens(used)} used`;
    tooltip = headline;
  } else {
    headline = "Not known yet";
    tooltip = "Context: not known yet (after the next turn)";
  }
  if (input.screenRemaining !== null) {
    percent = 100 - input.screenRemaining;
    source = `the pane's screen says Context low (${input.screenRemaining}% remaining)`;
    headline = used !== null && limit !== null ? `${percent}% · ${formatTokens(used)} / ${formatTokens(limit)}` : `${percent}%`;
    tooltip = `${percent}% used (the pane's screen)`;
  }
  return { used, limit, percent, tickPercent, headline, tooltip, source, level: ringLevel(percent) };
}
