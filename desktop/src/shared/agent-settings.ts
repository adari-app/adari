// What the Model and Effort chips in the message box's row show, read from
// the pane's transcript by a small reader of its own, separate from the chat
// parsers.
//
// Claude Code 2.1.316: the model is the newest assistant line's
// `message.model` (claude-opus-5-5 reads "Opus 5.5"), or a newer `/model`
// result ("Set model to …" in a <local-command-stdout> user line); the effort
// is the newest line naming it: an assistant line's top-level `effort`
// (Claude Code writes it on every one, "xhigh"), or a
// `/effort` result ("Set effort level to <level>…", or "Effort '<x>' exceeds
// the cap …; set to '<level>' instead"), else Default. Codex
// 0.166.0: its rollout's newest `turn_context` (`payload.model`, `payload.effort`).
//
// A pick goes as the agent's own command line: Claude Code's `/effort <level>`
// here (pickCommand); a line that names a model (Claude Code's `/model <value>`,
// Codex's `/model <model> --reasoning=<level>`: its in-session /model takes an
// argument, the 0.166.0 binary says "Unexpected argument '…'. Use
// '--reasoning=<level>' or '--speed=<tier>'.") only from the machine's model
// list, made in main (model-choices.ts modelPickCommand).

import { lineAuthor } from "./chat/claude-parser";
import { isTranscriptStoreReading, type CursorContext } from "./chat/cursor-store";
import {
  isTranscriptIdentityReading,
  isTranscriptWatching,
  type FeedSession,
  type TranscriptFileReader,
  type TranscriptIdentityRead,
  type TranscriptIdentityReading,
  type TranscriptReadOptions,
  type TranscriptWatch,
  type TranscriptWatchSink,
} from "./chat/feed";
import type { ContextLimits } from "./context-meter";
import { grokSummaryPath, maxGrokSummaryBytes } from "./chat/locator";
import { isPiFormat, type PiFormat } from "./chat/agents/pi-locator";
import { isOpenCodeFormat, type OpenCodeFormat } from "./chat/agents/opencode-locate";
import { isGeminiFamilyFormat, type GeminiFamilyFormat } from "./chat/agents/gemini-family";
import { isStoreAgentFormat, type StoreAgentFormat } from "./chat/agents/store-agents";
import type { KiroFormat } from "./chat/agents/kiro-locate";
import { codexModeOfTurn, cursorModeOfWord, grokModeOfWord, readClaudeModeScreen, type ModeAgent } from "./approval-modes";

/** What the chips show; null: not known (Effort: Default). */
export interface AgentSettings {
  /** The model's id as the transcript wrote it ("claude-opus-5-5", "gpt-5.5"), or null when only a label is known. */
  readonly model: string | null;
  /** The model as the chip shows it ("Opus 5.5"). */
  readonly modelLabel: string | null;
  /** The effort level ("high"); null is the default. */
  readonly effort: string | null;
  /** The context used by the newest turn (null: not known, or compacted since). */
  readonly used?: number | null;
  /** Codex's model_context_window, when its token_count says. */
  readonly window?: number | null;
  /** Where in the transcript the newest compaction is (a byte offset), or null. */
  readonly compactedAt?: number | null;
  /**
   * Where Claude Code's newest line saying a compaction failed is
   * (a byte offset; its own line, never a subagent's or your typing), or null.
   */
  readonly compactFailedAt?: number | null;
  /** Where the newest count (or the compaction that cleared it) is (a byte offset), or null. */
  readonly usedAt?: number | null;
  /** Codex's approval mode by its newest turn_context (approval-modes.ts codexModeOfTurn; null: no preset); absent before one. */
  readonly mode?: string | null;
  /** Where that turn_context is (a byte offset): a pick's mode shows until a newer one. */
  readonly modeAt?: number | null;
}

/** The pane's terminal and agent session the values were read for. */
export interface SettingsScope {
  readonly terminalID: string;
  readonly session: string | null;
}

/** The values as a chat update carries them, with what they are for. */
export interface PaneSettings extends AgentSettings {
  readonly scope: SettingsScope;
  /** Your auto-compact settings, only those keys (context-meter.ts). */
  readonly limits?: ContextLimits | null;
}

export const emptySettings: AgentSettings = { model: null, modelLabel: null, effort: null };

export type ChipAgent = "claude" | "codex";
/** The chips' picks, and the context card's Compact. */
/** "mode", the Permissions chip (its picks go to main's modePick, never as a command line here). */
export type ChipKind = "model" | "effort" | "compact" | "mode";
export type ClaudeFamily = "fable" | "opus" | "sonnet" | "haiku";

/** Claude Code's model aliases, in the menu's order. */
export const claudeModels: readonly { readonly alias: ClaudeFamily; readonly label: string }[] = [
  { alias: "fable", label: "Fable" },
  { alias: "opus", label: "Opus" },
  { alias: "sonnet", label: "Sonnet" },
  { alias: "haiku", label: "Haiku" },
];

/**
 * Claude Code's levels. Which a model takes is the server's per-model cap
 * (not in the binary), so all five are offered; Claude Code's own reply says
 * when it set a lower one.
 */
export const claudeEfforts: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
/** Codex's levels offered before its list is read (then the model's own, model-choices.ts effortChoices). */
export const codexEfforts: readonly string[] = ["low", "medium", "high", "xhigh"];

const effortNames: Readonly<Record<string, string>> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", minimal: "Minimal", ultra: "Ultra", none: "None" };

export function effortLabel(level: string | null): string {
  if (level === null) return "Default";
  return effortNames[level] ?? level;
}

/** The panes that get chips: a Claude or Codex agent. */
export function chipAgent(isAgent: boolean, kind: string | null | undefined): ChipAgent | null {
  if (!isAgent) return null;
  return kind === "claude" || kind === "codex" ? kind : null;
}

const families: readonly ClaudeFamily[] = ["fable", "opus", "sonnet", "haiku"];

/** "claude-opus-5-5" → "Opus 5.5", "claude-3-5-haiku-20241022" → "Haiku 3.5"; anything else as it is. */
export function modelLabel(id: string): string {
  const bare = id.trim().replace(/\[[^\]]*\]$/, "");
  const parts = bare.toLowerCase().split("-");
  if (parts[0] !== "claude") return bare;
  const at = parts.findIndex((part) => (families as readonly string[]).includes(part));
  if (at < 0) return bare;
  const version = (list: readonly string[]): string[] => {
    const out: string[] = [];
    for (const part of list) {
      if (!/^\d{1,2}$/.test(part)) break;
      out.push(part);
    }
    return out;
  };
  let numbers = version(parts.slice(at + 1));
  if (numbers.length === 0) numbers = version(parts.slice(1, at));
  const name = parts[at]!.charAt(0).toUpperCase() + parts[at]!.slice(1);
  return numbers.length === 0 ? name : `${name} ${numbers.join(".")}`;
}

/** The Claude family a model id or label names, or null. */
export function modelFamily(model: string | null): ClaudeFamily | null {
  if (model === null) return null;
  const words = model.toLowerCase().split(/[^a-z]+/);
  return families.find((family) => words.includes(family)) ?? null;
}

const levelPattern = /^[a-z]+$/;

/** The command line a pick types, or null when it cannot go (a value outside the menus, Codex's model not known). */
export function pickCommand(agent: ChipAgent, kind: ChipKind, value: string, _settings: AgentSettings): string | null {
  if (kind === "compact") return value === "compact" ? "/compact" : null;
  if (kind === "mode") return null;
  // A command that names a model (Claude Code's or Codex's
  // `/model …`, Codex's Effort) is made only in main from the machine's list (model-choices.ts modelPickCommand).
  if (agent === "claude" && kind === "effort") return claudeEfforts.includes(value) ? `/effort ${value}` : null;
  return null;
}

// MARK: - the reader

// Claude Code colours the words it prints (ESC [ … m).
const ansi = new RegExp(String.fromCharCode(0x1b) + "\\[[0-9;]*[A-Za-z]", "g");
const stdoutOpen = "<local-command-stdout>";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A user or system line's text: a string, or its text blocks. */
function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record !== null && record["type"] === "text" && typeof record["text"] === "string") out.push(record["text"]);
  }
  return out;
}

/** What a command printed: the text in its <local-command-stdout> tag, colours out; null for anything else. */
function commandOutput(text: string): string | null {
  const lead = text.replace(/^\s+/, "");
  if (!lead.startsWith(stdoutOpen)) return null;
  const end = lead.indexOf("</local-command-stdout>");
  return (end < 0 ? lead.slice(stdoutOpen.length) : lead.slice(stdoutOpen.length, end)).replace(ansi, "");
}

/** A model's name longer than this is not one (the chip keeps its label). */
export const maxModelLabelLength = 40;

/** A name's closing quote for each opening one (straight and curly). */
const closingQuote: Readonly<Record<string, string>> = { "'": "'", '"': '"', "‘": "’", "“": "”" };

/** The name at the start of `text`: a quoted one up to its closing quote, else up to " and ", " for ", "(" or the end. */
function leadingName(text: string): string {
  const close = closingQuote[text[0] ?? ""];
  if (close !== undefined) {
    const end = text.indexOf(close, 1);
    if (end > 0) return text.slice(1, end).trim();
  }
  return text
    .split(/ and | for |\(/)[0]!
    .replace(/[.:]\s*$/, "")
    .trim();
}

/**
 * Claude Code's line that a compaction failed ("Error: Compaction
 * failed: …", "Error during compaction: …", "Error compacting conversation"): a system line's text, or a
 * command's output (its <local-command-stdout> or <local-command-stderr> tag) in a user line. Plain words of
 * your own never count.
 */
function compactFailure(text: string, system: boolean): boolean {
  const lead = text.replace(/^\s+/, "");
  if (!system && !lead.startsWith(stdoutOpen) && !lead.startsWith("<local-command-stderr>")) return false;
  const plain = lead.replace(ansi, "");
  return /\b(?:error|fail(?:ed|ure)?)\b[^\n]{0,80}\bcompact(?:ion|ing)?\b|\bcompact(?:ion|ing)?\b[^\n]{0,80}\b(?:error|fail(?:ed|ure)?)\b/i.test(plain);
}

/**
 * The model's name in Claude Code's confirmation, old and new: "Set model to Opus 5.5 (default)" → "Opus 5.5";
 * "Set model to Default (Opus 5.5)" → "Opus 5.5"; "Set model to 'Fable 5.2' and saved as your default for new
 * sessions" → "Fable 5.2"; an id → its label. Null when none reads, or a name longer than
 * 40 characters (not a model's name).
 */
export function setModelLabel(output: string): string | null {
  const match = /Set model to ([^\n<]+)/.exec(output);
  if (match === null) return null;
  const rest = match[1]!.trim();
  const inner = /^Default \(([^)]+)\)/i.exec(rest);
  const label = leadingName(inner !== null ? inner[1]!.trim() : rest);
  if (label === "" || label.length > maxModelLabelLength) return null;
  return /^claude-/i.test(label) ? modelLabel(label) : label;
}

/** The level a command set; undefined when it is not an effort result; null for the default. */
function setEffort(output: string): string | null | undefined {
  const capped = /Effort '([a-z]+)' exceeds the cap\b[^;]*; set to '([a-z]+)' instead/.exec(output);
  if (capped !== null) return capped[2]!;
  const match = /Set effort level to ([a-z]+)/.exec(output);
  if (match === null) return undefined;
  const level = match[1]!;
  if (level === "auto" || level === "unset" || level === "default") return null;
  return levelPattern.test(level) ? level : undefined;
}

const count = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
};

/**
 * Claude Code's own count of a turn's context (2.1.316): input + cache
 * creation + cache read + output, of the last usage iteration that is not a
 * compaction's or an advisor's when the line has them, else of the usage.
 */
function claudeUsed(value: unknown): number | null {
  let usage = asRecord(value);
  if (usage === null) return null;
  const iterations = usage["iterations"];
  if (Array.isArray(iterations)) {
    const last = iterations
      .map(asRecord)
      .filter((entry): entry is Record<string, unknown> => entry !== null && entry["type"] !== "compaction" && entry["type"] !== "advisor_message")
      .at(-1);
    if (last !== undefined) usage = last;
  }
  const total = count(usage, "input_tokens") + count(usage, "cache_creation_input_tokens") + count(usage, "cache_read_input_tokens") + count(usage, "output_tokens");
  return total > 0 ? total : null;
}

/**
 * Reads the chips' values line by line. Each value is the newest line's that
 * names it, by its byte offset in the file: a line read later from earlier in
 * the file (Load earlier) never replaces a newer one.
 */
export class AgentSettingsReader {
  private model: string | null = null;
  private label: string | null = null;
  private modelAt = -1;
  private effort: string | null = null;
  private effortAt = -1;
  private used: number | null = null;
  private window: number | null = null;
  private usedAt = -1;
  private compactedAt: number | null = null;
  private compactFailedAt: number | null = null;
  private mode: string | null = null;
  private modeAt = -1;
  /** The transcript the reads are of (the tap says), for the settings beside it. */
  file: string | null = null;

  /** A Grok feed's reader reads nothing from its lines (its chips are not built yet); nor a Cursor feed's. */
  // Nor a Gemini CLI, Qwen Code or Antigravity feed's (GeminiFamilyFormat).
  constructor(
    readonly format:
      | ChipAgent
      | "grok"
      | "cursor"
      | PiFormat
      | OpenCodeFormat
      | GeminiFamilyFormat
      | "copilot"
      | "droid"
      | "kimi" // Nor a Kimi feed's
      // Nor a Maki feed's (no chips for it yet).
      | "maki"
      | StoreAgentFormat // Nor a Hermes, Mastra Code or Cline feed's
      | KiroFormat, // Nor a Kiro feed's
  ) {}

  get settings(): AgentSettings {
    return {
      model: this.model,
      modelLabel: this.label,
      effort: this.effort,
      used: this.used,
      window: this.window,
      compactedAt: this.compactedAt,
      // Only once one was read (otherwise the values' shape is unchanged).
      ...(this.compactFailedAt !== null ? { compactFailedAt: this.compactFailedAt } : {}),
      usedAt: this.usedAt >= 0 ? this.usedAt : null,
      // Codex's mode once a turn_context named one (or none).
      ...(this.modeAt >= 0 ? { mode: this.mode, modeAt: this.modeAt } : {}),
    };
  }

  /** Grok's summary.json (null: none that reads: no chips); a change counts as newer (a pick settles on it). */
  grokSummary(summary: GrokSummary | null): void {
    if ((summary?.model ?? null) !== this.model) this.modelAt += 1;
    if ((summary?.effort ?? null) !== this.effort) this.effortAt += 1;
    this.model = summary?.model ?? null;
    this.label = summary?.modelLabel ?? null;
    this.effort = summary?.effort ?? null;
  }

  /** Grok's window from its signals.json (its Context pick settles on it). */
  grokWindow(window: number | null): void {
    if (window !== this.window) this.effortAt += 1;
    this.window = window;
  }

  /** Grok's signals.json, the ring's used of its window (the window as grokWindow). */
  grokSignals(signals: { readonly used: number | null; readonly window: number | null }): void {
    this.grokWindow(signals.window);
    this.used = signals.window === null ? null : signals.used;
  }

  /** Forgets everything (the file was replaced). */
  reset(): void {
    this.model = null;
    this.label = null;
    this.modelAt = -1;
    this.effort = null;
    this.effortAt = -1;
    this.used = null;
    this.window = null;
    this.usedAt = -1;
    this.compactedAt = null;
    this.compactFailedAt = null;
    this.mode = null;
    this.modeAt = -1;
  }

  /** One whole line at `offset`; true when a value changed. */
  line(text: string, offset: number): boolean {
    if (this.format === "grok" || this.format === "cursor") return false;
    if (isPiFormat(this.format)) return false; // Pi's and omp's chips are not built yet.
    if (isOpenCodeFormat(this.format)) return false; // OpenCode's and Kilo's chips are not built yet.
    if (isGeminiFamilyFormat(this.format)) return false;
    if (this.format === "copilot" || this.format === "droid") return false; // No chips read from their lines yet
    if (this.format === "kimi") return false;
    // Maki's lines name no chip values Chat reads.
    if (this.format === "maki") return false;
    if (isStoreAgentFormat(this.format)) return false; // Nor Hermes's, Mastra Code's or Cline's.
    if (this.format === "kiro") return false; // Kiro's lines name no chip values Chat reads.
    if (this.format === "claude") {
      // An assistant line naming its effort and no model is read too.
      if (!text.includes('"model"') && !text.includes('"effort"') && !text.includes(stdoutOpen) && !text.includes("ompact")) return false;
    } else if (!text.includes("turn_context") && !text.includes("token_count") && !text.includes("compacted")) {
      return false;
    }
    let object: Record<string, unknown> | null;
    try {
      object = asRecord(JSON.parse(text));
    } catch {
      return false;
    }
    if (object === null) return false;
    return this.format === "claude" ? this.claude(object, offset) : this.codex(object, offset);
  }

  private setModel(model: string | null, label: string, offset: number): boolean {
    if (offset <= this.modelAt) return false;
    this.modelAt = offset;
    const changed = model !== this.model || label !== this.label;
    this.model = model;
    this.label = label;
    return changed;
  }

  private setEffort(level: string | null, offset: number): boolean {
    if (offset <= this.effortAt) return false;
    this.effortAt = offset;
    const changed = level !== this.effort;
    this.effort = level;
    return changed;
  }

  private setUsed(used: number, window: number | null, offset: number): boolean {
    if (offset <= this.usedAt) return false;
    this.usedAt = offset;
    const changed = used !== this.used || window !== this.window;
    this.used = used;
    this.window = window;
    return changed;
  }

  /** Codex's approval mode, the newest turn_context's (a newer one, even the same mode, settles a pick: its offset moved). */
  private setMode(mode: string | null, offset: number): boolean {
    if (offset <= this.modeAt) return false;
    this.modeAt = offset;
    this.mode = mode;
    return true;
  }

  /** A compaction: the count before it is no longer the context's. */
  private setCompacted(offset: number): boolean {
    if (this.compactedAt !== null && offset <= this.compactedAt) return false;
    this.compactedAt = offset;
    if (offset > this.usedAt) {
      this.usedAt = offset;
      this.used = null;
    }
    return true;
  }

  private claude(object: Record<string, unknown>, offset: number): boolean {
    if (object["isSidechain"] === true) return false;
    const type = object["type"];
    const message = asRecord(object["message"]);
    if ((type === "system" && object["subtype"] === "compact_boundary") || object["isCompactSummary"] === true) return this.setCompacted(offset);
    if (type === "assistant") {
      // Claude Code writes the session's effort on every assistant line (a top-level
      // `effort`, one of its levels); the newest line naming it wins, this or a `/effort` result.
      const effort = object["effort"];
      const effortChanged = typeof effort === "string" && claudeEfforts.includes(effort) && this.setEffort(effort, offset);
      const model = message?.["model"];
      if (typeof model !== "string" || model === "" || model.startsWith("<")) return effortChanged;
      const used = claudeUsed(message?.["usage"]);
      const usedChanged = used !== null && this.setUsed(used, null, offset);
      return this.setModel(model, modelLabel(model), offset) || usedChanged || effortChanged;
    }
    // Your own typing is never a command's result; nor a message you sent while it worked.
    if (object["promptSource"] === "typed") return false;
    if (object["promptSource"] === "queued" && lineAuthor(object) === "typed") return false;
    const texts = type === "user" ? textsOf(message?.["content"]) : type === "system" ? textsOf(object["content"]) : [];
    let changed = false;
    for (const text of texts) {
      // Claude's word that a compaction failed (a Compact waiting for
      // the transcript then ends: agent-picks.ts).
      if (compactFailure(text, type === "system") && (this.compactFailedAt === null || offset > this.compactFailedAt)) {
        this.compactFailedAt = offset;
        changed = true;
      }
      const output = commandOutput(text);
      if (output === null) continue;
      const label = setModelLabel(output);
      if (label !== null) changed = this.setModel(null, label, offset) || changed;
      const effort = setEffort(output);
      if (effort !== undefined) changed = this.setEffort(effort, offset) || changed;
    }
    return changed;
  }

  private codex(object: Record<string, unknown>, offset: number): boolean {
    const payload0 = asRecord(object["payload"]);
    if (object["type"] === "compacted" || (object["type"] === "event_msg" && payload0?.["type"] === "context_compacted")) return this.setCompacted(offset);
    if (object["type"] === "event_msg" && payload0?.["type"] === "token_count") {
      const info = asRecord(payload0["info"]);
      const total = asRecord(info?.["last_token_usage"])?.["total_tokens"];
      if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return false;
      const window = info?.["model_context_window"];
      return this.setUsed(total, typeof window === "number" && window > 0 ? window : null, offset);
    }
    if (object["type"] !== "turn_context") return false;
    const payload = asRecord(object["payload"]);
    if (payload === null) return false;
    let changed = false;
    const model = payload["model"];
    if (typeof model === "string" && model !== "") changed = this.setModel(model, modelLabel(model), offset) || changed;
    const effort = payload["effort"] ?? payload["reasoning_effort"];
    changed = this.setEffort(typeof effort === "string" && levelPattern.test(effort) ? effort : null, offset) || changed;
    // The turn's approval policy, reviewer and sandbox, as Codex's presets.
    changed = this.setMode(codexModeOfTurn(payload), offset) || changed;
    return changed;
  }
}

// MARK: - the tap on the chat's reads

const NEWLINE = 0x0a;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Whole lines out of the bytes a transcript read returned, each with its
 * offset. A read that follows on from the last one continues its partial
 * line; any other (a first load, Load earlier) starts afresh, its first line
 * dropped unless it starts the file (it may be the end of a line).
 */
export class TranscriptLineTap {
  private end = -1;
  private partial: Uint8Array | null = null;
  private partialAt = 0;

  constructor(private readonly onLine: (text: string, offset: number) => void) {}

  /** Where the last read ended (-1: none yet). */
  get position(): number {
    return this.end;
  }

  /** Another file: nothing carries over. */
  reset(): void {
    this.end = -1;
    this.partial = null;
  }

  /** The file's size now; true when it is shorter than what was read (replaced): read afresh. */
  size(size: number): boolean {
    if (size >= this.end) return false;
    this.end = -1;
    this.partial = null;
    return true;
  }

  read(offset: number, bytes: Uint8Array): void {
    let start = 0;
    let carried: Uint8Array | null = null;
    let carriedAt = offset;
    if (offset === this.end && this.partial !== null) {
      carried = this.partial;
      carriedAt = this.partialAt;
    } else if (offset !== this.end && offset > 0) {
      const first = bytes.indexOf(NEWLINE);
      if (first < 0) {
        this.partial = null;
        this.end = offset + bytes.length;
        return;
      }
      start = first + 1;
    }
    this.partial = null;
    for (;;) {
      const newline = bytes.indexOf(NEWLINE, start);
      if (newline < 0) break;
      let line = bytes.subarray(start, newline);
      let lineAt = offset + start;
      if (carried !== null) {
        const joined = new Uint8Array(carried.length + line.length);
        joined.set(carried, 0);
        joined.set(line, carried.length);
        line = joined;
        lineAt = carriedAt;
        carried = null;
      }
      const text = decoder.decode(line).replace(/\r$/, "");
      if (text.trim() !== "") this.onLine(text, lineAt);
      start = newline + 1;
    }
    if (start < bytes.length || carried !== null) {
      const rest = bytes.slice(start);
      if (carried !== null) {
        const joined = new Uint8Array(carried.length + rest.length);
        joined.set(carried, 0);
        joined.set(rest, carried.length);
        this.partial = joined;
        this.partialAt = carriedAt;
      } else {
        this.partial = rest;
        this.partialAt = offset + start;
      }
      // A line longer than the chat reads is not the chips' (the follower drops those too).
      if (this.partial.length > 8 * 1_024 * 1_024) this.partial = null;
    }
    this.end = offset + bytes.length;
  }
}

/**
 * The chat feed's reader with the settings reader on its reads: what the
 * chat reads, the chips read too, with no read of their own. `changed` runs
 * once after a read that changed what the chips show.
 */
/** Grok's summary.json and signals.json are read again at most this often (Sources/HerdrKit ChatFeed's grokSignalsInterval). */
export const grokFilesIntervalMs = 10_000;

/**
 * One bounded read of a Grok session's summary.json and signals.json
 * outside the growth throttle (Chat shown or back, a turn's end, after a pick); false when there is none to
 * read (not Grok, no transcript yet). Never on a timer.
 */
export interface GrokFilesRefresh {
  refreshGrok(): Promise<boolean>;
}

export function tapReader<S extends FeedSession>(
  reader: TranscriptFileReader<S>,
  settings: AgentSettingsReader,
  changed: () => void,
): TranscriptFileReader<S> & GrokFilesRefresh {
  const tap = new TranscriptLineTap((text, offset) => settings.line(text, offset));
  const same = (a: AgentSettings, b: AgentSettings): boolean =>
    a.model === b.model &&
    a.modelLabel === b.modelLabel &&
    a.effort === b.effort &&
    a.used === b.used &&
    a.window === b.window &&
    a.compactedAt === b.compactedAt &&
    (a.compactFailedAt ?? null) === (b.compactFailedAt ?? null) &&
    a.usedAt === b.usedAt &&
    (a.mode ?? null) === (b.mode ?? null) &&
    (a.modeAt ?? null) === (b.modeAt ?? null);
  // The file was replaced and the values went with it: said with the next read. While
  // that is pending, the settings last notified (the baseline): the next read notifies only a net change from
  // them (an identical transcript reread notifies nothing). Null: no reset pending.
  let baseline: AgentSettings | null = null;
  /** The settings start over; the first reset since the last notification keeps what that notification said. */
  const resetSettings = (): void => {
    const before = settings.settings;
    settings.reset();
    if (baseline === null && !same(before, settings.settings)) baseline = before;
  };
  /** A read or pushed bytes are in: notify a change from `before`, or with a reset pending, from the baseline. */
  const settle = (before: AgentSettings): void => {
    const last = baseline ?? before;
    baseline = null;
    if (!same(last, settings.settings)) changed();
  };
  // A Grok session's summary.json and signals.json, read on its first read and then
  // with a read that found it grown, at most every grokFilesIntervalMs (never on a timer while it is idle).
  let grokReadAt: number | null = null;
  // A grown read the throttle held back; the next read or size after the interval
  // reads the files (a short turn's last bytes inside the interval still reach the chips).
  let grokPending = false;
  const readGrokFiles = (path: string, force = false): Promise<boolean> => {
    const summary = grokSummaryPath(path);
    if (settings.format !== "grok" || summary === null) return Promise.resolve(false);
    const now = Date.now();
    if (!force && grokReadAt !== null && now - grokReadAt < grokFilesIntervalMs) {
      grokPending = true;
      return Promise.resolve(false);
    }
    grokReadAt = now;
    grokPending = false;
    const small = async (file: string): Promise<string | null> => {
      try {
        const size = await reader.size(file);
        if (size <= 0 || size > maxGrokSummaryBytes) return null;
        return new TextDecoder().decode(await reader.read(file, 0, size));
      } catch {
        return null;
      }
    };
    return Promise.all([small(summary), small(summary.slice(0, -"summary.json".length) + "signals.json")]).then(([summaryText, signalsText]) => {
      if (file !== path) return false;
      const before = settings.settings;
      settings.grokSummary(summaryText === null ? null : parseGrokSummary(summaryText));
      settings.grokSignals(signalsText === null ? { used: null, window: null } : parseGrokSignals(signalsText));
      if (!same(before, settings.settings)) {
        // Notified now: with a reset pending, this is what the chips show (the next read's baseline).
        if (baseline !== null) baseline = settings.settings;
        changed();
      }
      return true;
    });
  };
  let file: string | null = null;
  // The inode the reads with identity last gave for `file` (null: none yet, or a reset since).
  let inode: number | null = null;
  // Moves on when a watch's reset or another file starts the tap over: a
  // read with identity sent before it is retired when it comes back.
  let generation = 0;
  // The feed said it reads the file again from its start: the next read is that reread
  // (authoritative: tapped, its framing the live tap's, and it says any pending start-over).
  let rereading = false;
  // The settings started over and the reread has not said it yet (a second start-over for the same
  // replacement starts nothing over again).
  let fresh = false;
  // A read with identity answered while the inode is still unknown after reads
  // without one (a load before the relay was up): the feed may throw it away (its poll starts over), so nothing
  // of it is tapped, notified or taken as the inode until the feed says it kept it; any other call drops it.
  let held: { readonly path: string; readonly offset: number; readonly read: TranscriptIdentityRead; readonly generation: number } | null = null;
  const onFile = (path: string): void => {
    if (path === file) return;
    file = path;
    settings.file = path;
    grokReadAt = null;
    grokPending = false;
    inode = null;
    generation += 1;
    tap.reset();
  };
  /** The settings start over (another file under the name, or a shorter one): said with the reread. */
  const startOver = (): void => {
    held = null;
    tap.reset();
    if (!fresh) resetSettings();
    fresh = true;
  };
  /** The bytes of a read from `offset` reach the chips (a read from before the live tail's end frames its own lines). */
  const tapRead = (path: string, offset: number, bytes: Uint8Array): void => {
    // A read from before the live tail's end (Load earlier) frames its own lines; the live
    // tail keeps its cursor and partial line. The offsets keep an older line from replacing a newer one.
    if (tap.position >= 0 && offset < tap.position) new TranscriptLineTap((text, at) => settings.line(text, at)).read(offset, bytes);
    else tap.read(offset, bytes);
    if (bytes.length > 0 || grokReadAt === null || grokPending) void readGrokFiles(path);
  };
  /** A read's bytes are in: notify a change (fresh: from the settings last notified, with this reread). */
  const settled = (before: AgentSettings): void => {
    fresh = false;
    settle(before);
  };
  /**
   * The reader beneath's read with identity, its size and bytes tapped as size()
   * and read() tap theirs:
   * - a reply sent before the tap started over (a watch's reset, another file) taps nothing, takes
   *   no inode and says nothing; the feed still has it (it discards it or plans again);
   * - one that finds another inode, or a shorter file, starts the settings over and taps none of its
   *   bytes (the feed throws them away): the feed's reread from the start sets the live tap's framing and says it;
   * - an empty one reads Grok's files on the file's first read (or one held back), as read() does;
   * - one answered while the inode is unknown after reads without identity is
   *   held until the feed says it kept it (keptIdentityRead), else dropped: a poll the feed throws away queues
   *   no notification and leaves the last-notified settings as they were.
   */
  const identityRead =
    (identity: TranscriptIdentityReading) =>
    async (path: string, asked: number, maxBytes: number, options?: TranscriptReadOptions): Promise<TranscriptIdentityRead | null> => {
      held = null;
      const sent = generation;
      const read = await identity.readWithIdentity(path, asked, maxBytes, options);
      // None now (no relay): the feed asks the size and reads, tapped as ever.
      if (read === null) return null;
      // A tail read says where it started; its bytes are the file's (a run left out filled).
      const offset = read.offset ?? asked;
      // Retired by a start-over while it was out (a watch's reset, another file).
      if (sent !== generation) return read;
      onFile(path);
      const authoritative = rereading;
      rereading = false;
      const replaced = inode !== null && read.ino !== inode;
      const shorter = !replaced && tap.size(read.size);
      if (replaced || shorter) {
        inode = read.ino;
        startOver();
        // The read that found it is thrown away by the feed: none of its bytes; its reread says it.
        if (!authoritative) return read;
      } else if (!authoritative && inode === null && tap.position >= 0) {
        // This file was read without identity; held until the feed keeps it.
        held = { path, offset, read, generation };
        return read;
      }
      apply(path, offset, read, authoritative);
      return read;
    };
  /** A read with identity the feed keeps: its inode taken, its bytes tapped and said as read()'s. */
  const apply = (path: string, offset: number, read: TranscriptIdentityRead, authoritative: boolean): void => {
    inode = read.ino;
    if (read.data.length === 0 && !authoritative) {
      // Nothing new (as size()); the file's first read still reads Grok's files.
      if (grokReadAt === null || grokPending) void readGrokFiles(path);
      return;
    }
    const before = settings.settings;
    tapRead(path, offset, read.data);
    settled(before);
  };
  return {
    locate: (session) => reader.locate(session),
    async size(path) {
      held = null;
      const size = await reader.size(path);
      onFile(path);
      if (grokPending) void readGrokFiles(path);
      if (tap.size(size)) resetSettings();
      return size;
    },
    async read(path, offset, maxBytes) {
      held = null;
      const bytes = await reader.read(path, offset, maxBytes);
      onFile(path);
      rereading = false;
      const before = settings.settings;
      tapRead(path, offset, bytes);
      settled(before);
      return bytes;
    },
    // Only when the reader beneath has it (SFTP and exec stay without it).
    // And its reads past the tap (an image fetched on show, a line read again
    // whole, the look-back): the chips see none of their bytes, nor do they move its inode or framing.
    ...(isTranscriptIdentityReading(reader)
      ? {
          readWithIdentity: identityRead(reader),
          readRange: (path: string, offset: number, maxBytes: number, options?: TranscriptReadOptions): Promise<TranscriptIdentityRead | null> =>
            reader.readWithIdentity(path, offset, maxBytes, options),
        }
      : {}),
    // The feed reads the file again from its start next: the live
    // tap's framing is that reread's; a replacement the feed found (its inode another, or unknown after a load)
    // starts the settings over too, said with that reread.
    startingOver: (path: string, replaced: boolean): void => {
      // A held read is thrown away with the start-over (nothing of it was said).
      held = null;
      onFile(path);
      rereading = true;
      if (!replaced) {
        tap.reset();
        return;
      }
      inode = null;
      startOver();
    },
    // The feed kept the read with identity it was just answered: what was held of it now.
    keptIdentityRead: (path: string): void => {
      const kept = held;
      held = null;
      if (kept === null || kept.path !== path || kept.generation !== generation) return;
      apply(path, kept.offset, kept.read, false);
    },
    // The chips' look-back reads past the tap (the feed guards its answer, then feeds
    // its whole lines to the settings itself); the reader beneath (the warming gate) as every read.
    readUntapped: (path: string, offset: number, maxBytes: number): Promise<Uint8Array> => reader.read(path, offset, maxBytes),
    // A Cursor store's revision and ring, from the reader beneath.
    storeRevision: (path: string): Promise<number> => (isTranscriptStoreReading(reader) ? reader.storeRevision(path) : Promise.resolve(0)),
    storeContext: (path: string): Promise<CursorContext | null> => (isTranscriptStoreReading(reader) ? reader.storeContext(path) : Promise.resolve(null)),
    refreshGrok: (): Promise<boolean> => (file === null ? Promise.resolve(false) : readGrokFiles(file, true)),
    // The reader beneath's watch; its pushed bytes reach the chips as a read's do.
    watch: (path: string, offset: number, sink: TranscriptWatchSink): Promise<TranscriptWatch | null> => {
      if (!isTranscriptWatching(reader)) return Promise.resolve(null);
      return reader.watch(path, offset, {
        grew: (at, size, data, omitted) => {
          onFile(path);
          const before = settings.settings;
          if (tap.position >= 0 && at < tap.position) new TranscriptLineTap((text, line) => settings.line(text, line)).read(at, data);
          else tap.read(at, data);
          if (data.length > 0 || grokPending) void readGrokFiles(path);
          settled(before);
          // The runs left out go on with the bytes.
          if (omitted === undefined) sink.grew(at, size, data);
          else sink.grew(at, size, data, omitted);
        },
        // The file was replaced: the settings start over with the feed (a longer replacement
        // passes the size check, so the tap's old offsets would refuse its earlier lines), and the feed's reread
        // fills them from fresh offsets. The chips hear it once, with that reread (the pending
        // reset, as a shorter replacement's), so they do not blank and come back during a slow reread, and
        // only when the reread's settings differ from the ones last notified.
        reset: () => {
          startOver();
          // The reread's identity is the new file's (no second start-over for it); a read with identity
          // still out was sent before it and is retired.
          inode = null;
          generation += 1;
          sink.reset();
        },
        gone: () => sink.gone(),
        ended: () => sink.ended(),
      });
    },
  } as TranscriptFileReader<S> & GrokFilesRefresh;
}

// MARK: - Cursor's footer and model menu
//
// Cursor (cursor-agent 2026.11.05, Grok 4.7) writes no model or effort in its
// store (its meta says only `lastUsedModel`), so its chips read the footer it
// draws under its box: `Grok 4.7 256K Medium`, then ` Fast` when Fast is on and
// ` · 6.8%` once the context is counted, then the folder. Nothing is guessed:
// a screen whose footer does not read so gives no values (no chips).
//
// A pick drives Cursor's own menu (`/model`, Enter, Tab: "<model> \u{2014} Edit
// Parameters"), each screen read and checked before the next key
// (readCursorScreen); the driver is src/main/herdr/send.ts driveCursorPick.

/** Cursor's effort levels, in its menu's order. */
export type CursorEffort = "low" | "medium" | "high" | "xhigh";
export const cursorEfforts: readonly CursorEffort[] = ["low", "medium", "high", "xhigh"];
/** Cursor's context windows for Grok 4.7, in its menu's order. */
export const cursorWindows: readonly string[] = ["256K", "500K"];

const cursorEffortWords: Readonly<Record<CursorEffort, string>> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High" };

/** Cursor's own word for a level ("Extra High"). */
export function cursorEffortLabel(level: CursorEffort): string {
  return cursorEffortWords[level];
}

function cursorEffortOf(word: string): CursorEffort | null {
  return cursorEfforts.find((level) => cursorEffortWords[level] === word) ?? null;
}

/** What Cursor's footer says. */
export interface CursorFooter {
  /** "Grok 4.7". */
  readonly model: string;
  /** The context window as drawn ("256K"), or null when the footer shows none. */
  readonly window: string | null;
  readonly effort: CursorEffort;
  readonly fast: boolean;
  /** The share of the window used ("6.8" of `· 6.8%`), or null before it is counted. */
  readonly percent: number | null;
  /**
   * The model row's right side, Cursor's approval setting: absent (none drawn) is its default,
   * "autoReview" (`Auto-review`), "runEverything" (`Run Everything`), null for a word this app does not know.
   */
  readonly approval?: "autoReview" | "runEverything" | null;
}

/** "256K" → 256000, "1M" → 1000000; null for anything else. */
export function cursorWindowTokens(window: string | null): number | null {
  if (window === null) return null;
  const match = /^(\d{1,4}(?:\.\d{1,2})?)([KM])$/.exec(window);
  if (match === null) return null;
  return Math.round(Number(match[1]) * (match[2] === "M" ? 1_000_000 : 1_000));
}

const footerPattern = /^ {2}(\S+(?: \S+)*?)(?: (\d{1,4}(?:\.\d{1,2})?[KM]))? (Low|Medium|High|Extra High)( Fast)?(?: \u{B7} (\d{1,3}(?:\.\d{1,2})?)%)?(?: {2,}(\S+(?: \S+)*))?$/u;

/** One footer line (`  Grok 4.7 256K Medium Fast · 6.8%`), or null. */
export function parseCursorFooterLine(line: string): CursorFooter | null {
  const match = footerPattern.exec(line.replace(/\s+$/, ""));
  if (match === null) return null;
  const effort = cursorEffortOf(match[3]!);
  if (effort === null) return null;
  const model = match[1]!;
  if (!/\p{L}/u.test(model) || model.includes("\u{2192}")) return null;
  const percent = match[5] === undefined ? null : Number(match[5]);
  if (percent !== null && !(percent >= 0 && percent <= 100)) return null;
  const footer: CursorFooter = { model, window: match[2] ?? null, effort, fast: match[4] !== undefined, percent };
  // The approval word at the row's right (Auto-review, Run Everything); none drawn, the default.
  if (match[6] === undefined) return footer;
  const mode = cursorModeOfWord(match[6]);
  return { ...footer, approval: mode === "autoReview" || mode === "runEverything" ? mode : null };
}

/** The footer's approval mode (approval-modes.ts ids): "default", "autoReview", "runEverything"; null for a word not known. */
export function cursorFooterMode(footer: CursorFooter): string | null {
  return footer.approval === undefined ? "default" : footer.approval;
}

/** Cursor's placeholders in its box: an empty box. */
export const cursorPlaceholders: readonly string[] = ["Plan, search, build anything", "Add a follow-up"];
const cursorStopHint = "ctrl+c to stop";
const arrow = "\u{2192}";

/** A row of Edit Parameters: its section, its label, whether it is chosen, whether the arrow is on it. */
export interface CursorParameterRow {
  readonly section: "context" | "effort" | "fast";
  readonly label: string;
  readonly chosen: boolean;
  readonly cursor: boolean;
}

/** What a Cursor screen shows at its bottom. */
export type CursorScreen =
  /** The box (empty: its placeholder) and the footer under it (null: none that reads). */
  | { readonly kind: "box"; readonly draft: string; readonly empty: boolean; readonly working: boolean; readonly footer: CursorFooter | null }
  /** The command list a `/` opens, the highlighted command (null: none). */
  | { readonly kind: "commands"; readonly draft: string; readonly highlighted: string | null }
  /** "Available models": the model the arrow is on (null: none). */
  | { readonly kind: "models"; readonly current: string | null }
  /** "<model> \u{2014} Edit Parameters": its rows. */
  | { readonly kind: "parameters"; readonly model: string; readonly rows: readonly CursorParameterRow[] }
  | { readonly kind: "other" };

const indentOf = (line: string): number => line.length - line.replace(/^ +/, "").length;
const isBoxLine = (line: string): boolean => indentOf(line) === 2 && (line.slice(2) === arrow || line.slice(2).startsWith(`${arrow} `));

/** What the box holds: its text, "ctrl+c to stop" taken off; "" for a placeholder. */
function boxDraft(line: string): { draft: string; working: boolean } {
  let text = line.slice(3).trim();
  let working = false;
  if (text.endsWith(cursorStopHint)) {
    working = true;
    text = text.slice(0, -cursorStopHint.length).trim();
  }
  return { draft: text, working };
}

const commandRow = /^(?: {3}\u{2192} \/| {5}\/| {5}\u{2193} more below$)/u;
/** Cursor's Shift+Tab mode line over its footer (`Plan (shift+tab to cycle)`). */
const cursorModeLine = /^ {2}[A-Z][a-z]+ \(shift\+tab to cycle\)$/u;
/** What `/auto-review` and `/run-everything` print under the folder. */
const cursorToggleLine = /^ {2}(?:Auto-review|Run Everything): (?:ON|OFF)(?: \([^)]*\))?$/u;
const parameterRow = new RegExp(`^(?: {4}| {2}${arrow} )([\u{25CF}\u{25CB}\u{25C9}\u{25EF}]) (.+?)( \u{2713})?$`, "u");

/**
 * Reads the bottom of a Cursor screen (cursor-agent 2026.11.05's shapes): its
 * box and footer, the command list under a typed `/model`, the model
 * selector, or a model's Edit Parameters. Anything else is "other".
 */
export function readCursorScreen(screen: string): CursorScreen {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/, ""));
  // Edit Parameters: its title, its rows, its hint line.
  const title = lines.findLastIndex((line) => / \u{2014} Edit Parameters(?: {2,}.*)?$/u.test(line) && indentOf(line) === 1);
  if (title >= 0 && lines.slice(title).some((line) => line.startsWith(" \u{2191}/\u{2193} to navigate"))) {
    const model = lines[title]!.slice(1).split(" \u{2014} Edit Parameters")[0]!.trim();
    const rows: CursorParameterRow[] = [];
    let section: "context" | "effort" | null = null;
    for (const line of lines.slice(title + 1)) {
      if (line === "  Context") section = "context";
      else if (line === "  Effort") section = "effort";
      const match = parameterRow.exec(line);
      if (match === null) continue;
      const mark = match[1]!;
      const label = match[2]!;
      const cursor = line.startsWith(`  ${arrow} `);
      if (label === "Fast" && (mark === "\u{25C9}" || mark === "\u{25EF}")) {
        rows.push({ section: "fast", label, chosen: mark === "\u{25C9}", cursor });
      } else if (section !== null && (mark === "\u{25CF}" || mark === "\u{25CB}")) {
        rows.push({ section, label, chosen: mark === "\u{25CF}", cursor });
      }
    }
    return model === "" ? { kind: "other" } : { kind: "parameters", model, rows };
  }
  // The selector: its title, its empty Filter line, its rows (exactly one current: the arrow's), its count, its hint
  // line (a filter typed in Terminal, or no current row, is not the selector a pick drives).
  const models = lines.findLastIndex((line) => line.startsWith(" Available models"));
  if (models >= 0 && lines.slice(models).some((line) => line.startsWith(" Type to filter"))) return readSelector(lines.slice(models + 1));
  const box = lines.findLastIndex(isBoxLine);
  if (box < 0) return { kind: "other" };
  const { draft, working } = boxDraft(lines[box]!);
  const below = lines.slice(box + 1).filter((line) => line !== "");
  // The command list: its rows under the box, the highlighted one with the arrow.
  if (below.length > 0 && below.every((line) => commandRow.test(line))) {
    const highlighted = below.find((line) => line.startsWith(`   ${arrow} /`));
    return { kind: "commands", draft, highlighted: highlighted === undefined ? null : (highlighted.slice(5).split(" ")[0] ?? null) };
  }
  // The box: the footer, then at most the folder, at the margin of two. Shift+Tab's mode line above
  // the footer (`Plan (shift+tab to cycle)`) and a toggle's result line under the folder (`Auto-review: ON
  // (Auto-review)`, `Run Everything: OFF`) stand there too (test/support/mode-fixtures.ts).
  let rows = below;
  if (rows.length > 0 && cursorModeLine.test(rows[0]!)) rows = rows.slice(1);
  if (rows.length === 3 && cursorToggleLine.test(rows[2]!)) rows = rows.slice(0, 2);
  if (rows.length === 0 || rows.length > 2 || rows.some((line) => indentOf(line) !== 2)) return { kind: "other" };
  return { kind: "box", draft: cursorPlaceholders.includes(draft) ? "" : draft, empty: cursorPlaceholders.includes(draft), working, footer: parseCursorFooterLine(rows[0]!) };
}

/** The selector's lines under its title: `Filter:` with nothing typed, rows, `1-10 of 46`, the hint; else "other". */
function readSelector(below: readonly string[]): CursorScreen {
  const lines = below.map((line) => line.trimEnd()).filter((line) => line !== "");
  const count = lines.findIndex((line) => /^ \d+-\d+ of \d+$/.test(line));
  if (lines[0] !== " Filter:" || count < 2 || !lines[count + 1]?.startsWith(" Type to filter")) return { kind: "other" };
  const rows = lines.slice(1, count);
  if (!rows.every((line) => /^ (?:\u{2192}| ) {2}\S/u.test(line))) return { kind: "other" };
  const current = rows.filter((line) => line.startsWith(` ${arrow} `));
  if (current.length !== 1) return { kind: "other" };
  const name = current[0]!.slice(3).trim().split(/ {2,}/)[0] ?? "";
  return name === "" ? { kind: "other" } : { kind: "models", current: name };
}

/**
 * The model line under Cursor's box as drawn, read or not as a footer ("Composer 2.5 Fast", "Auto",
 * "Claude Opus 5.5 300K Medium"): its words before any two spaces or " · ", or null when the screen is not the box.
 */
export function cursorModelLineOf(screen: string): string | null {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/, ""));
  if (readCursorScreen(screen).kind !== "box") return null;
  const box = lines.findLastIndex(isBoxLine);
  let rows = lines.slice(box + 1).filter((line) => line !== "");
  if (rows.length > 0 && cursorModeLine.test(rows[0]!)) rows = rows.slice(1);
  const line = rows[0]?.trim().split(/ {2,}| \u{B7} /u)[0]?.trim() ?? "";
  return line === "" ? null : line;
}

/**
 * Cursor 2026.11.11 with `/model <words>` typed in its box (test/support/livepick-frames.ts): the box row, then
 * directly under it its own list for that command: ` Models matching "<words>"` (Max mode at its right), its rows
 * (the marked one ` →  <family>   <remembered variant>`), and its hint ` Edit prompt to filter • Enter to select • …`.
 * What the box holds, the words the header names, and the marked first row's first column; null for anything else
 * (another line on screen, no row, the first row not marked, a second marked row, another shape).
 */
export interface CursorModelMatches {
  readonly draft: string;
  readonly query: string;
  readonly marked: string;
}

const matchesHeader = /^ Models matching "([^"]+)"(?: {2,}Max mode: (?:ON|OFF))?$/u;
const matchesRow = /^ (\u{2192}| ) {2}(\S.*)$/u;
const matchesHint = /^ Edit prompt to filter \u{2022} Enter to select(?: \u{2022} .*)?$/u;

export function readCursorModelMatches(screen: string): CursorModelMatches | null {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/, ""));
  const box = lines.findLastIndex(isBoxLine);
  if (box < 0) return null;
  const { draft, working } = boxDraft(lines[box]!);
  if (working) return null;
  const below = lines.slice(box + 1).filter((line) => line !== "");
  const header = matchesHeader.exec(below[0] ?? "");
  if (header === null || below.length < 3 || !matchesHint.test(below[below.length - 1]!)) return null;
  const rows = below.slice(1, -1);
  if (!rows.every((line) => matchesRow.test(line))) return null;
  const first = matchesRow.exec(rows[0]!)!;
  if (first[1] !== arrow || rows.slice(1).some((line) => line.startsWith(` ${arrow}`))) return null;
  const marked = first[2]!.split(/ {2,}/)[0]!.trim();
  return marked === "" ? null : { draft, query: header[1]!, marked };
}

/**
 * What a read of the agent's screen after a typed command shows, for its Return:
 * "shows" the screen Return needs; "settling" one still plainly on its way (the box not yet holding the whole command,
 * or the command with no list under it yet); "differs" anything else (no Return).
 */
export type TypedScreenRead = "shows" | "settling" | "differs";

/**
 * Cursor's screen after `/model <family>` was typed (`command`): "shows" when the box
 * holds exactly the command with Cursor's own list for exactly that family under it, marked first (readCursorModelMatches);
 * "settling" while the box (its placeholder, the command list a `/` opens, or its list for words typed so far) holds
 * a beginning of the command, or the whole command with no list yet; "differs" for anything else: text not the
 * command's (yours joined to it), the whole command with a list for other words or another family marked, the agent
 * working, a dialog or another screen.
 */
export function cursorTypedRead(screen: string, command: string, family: string): TypedScreenRead {
  if (command !== `/model ${family}`) return "differs";
  const list = readCursorModelMatches(screen);
  if (list !== null) {
    if (list.draft === command) return list.query === family && list.marked === family ? "shows" : "differs";
    return list.draft.length < command.length && command.startsWith(list.draft) ? "settling" : "differs";
  }
  const read = readCursorScreen(screen);
  if (read.kind === "box") return !read.working && command.startsWith(read.draft) ? "settling" : "differs";
  if (read.kind === "commands") return command.startsWith(read.draft) ? "settling" : "differs";
  return "differs";
}

/**
 * Grok's screen after a typed `/model <id>` (`command`): "shows" when its box holds
 * exactly the command, "settling" while it holds a beginning of it, "differs" for anything else (other text, no box).
 */
export function grokTypedRead(screen: string, command: string): TypedScreenRead {
  const grok = readGrokScreen(screen);
  if (grok === null) return "differs";
  if (grok.draft === command) return "shows";
  return command.startsWith(grok.draft) ? "settling" : "differs";
}

/** The footer a screen shows under Cursor's box, or null (a menu open, no footer, one that does not read). */
export function parseCursorFooter(screen: string): CursorFooter | null {
  const read = readCursorScreen(screen);
  return read.kind === "box" ? read.footer : null;
}

/** The chips' values from a footer: the model, the effort, and the ring's share of the window. */
export function cursorFooterSettings(footer: CursorFooter): AgentSettings {
  const window = cursorWindowTokens(footer.window);
  const used = window === null || footer.percent === null ? null : Math.round((window * footer.percent) / 100);
  return { model: footer.model, modelLabel: footer.model, effort: footer.effort, used, window };
}

/** The Effort chip's words: "Medium", "Medium · Fast". */
export function cursorEffortChip(footer: CursorFooter): string {
  return footer.fast ? `${cursorEffortLabel(footer.effort)} \u{B7} Fast` : cursorEffortLabel(footer.effort);
}

/** One pick from a Cursor pane's chips: the model (Cursor's own selector), an effort, a context window, Fast on or off. */
export type CursorPick =
  | { readonly kind: "model" }
  | { readonly kind: "effort"; readonly value: CursorEffort }
  | { readonly kind: "context"; readonly value: string }
  | { readonly kind: "fast"; readonly value: boolean };

/** The footer already says what the pick sets. */
export function cursorPickShown(pick: CursorPick, footer: CursorFooter): boolean {
  switch (pick.kind) {
    case "model":
      return false;
    case "effort":
      return footer.effort === pick.value;
    case "context":
      return footer.window === pick.value;
    case "fast":
      return footer.fast === pick.value;
  }
}

/** The Edit Parameters row a pick moves to. */
export function cursorPickRow(pick: CursorPick): { readonly section: CursorParameterRow["section"]; readonly label: string } | null {
  switch (pick.kind) {
    case "model":
      return null;
    case "effort":
      return { section: "effort", label: cursorEffortLabel(pick.value) };
    case "context":
      return { section: "context", label: pick.value };
    case "fast":
      return { section: "fast", label: "Fast" };
  }
}

/** A pick as the page sends it (main checks it again). */
export function isCursorPick(value: unknown): value is CursorPick {
  const record = asRecord(value);
  if (record === null) return false;
  switch (record["kind"]) {
    case "model":
      return Object.keys(record).length === 1;
    case "effort":
      return typeof record["value"] === "string" && (cursorEfforts as readonly string[]).includes(record["value"]);
    case "context":
      return typeof record["value"] === "string" && cursorWindows.includes(record["value"]);
    case "fast":
      return typeof record["value"] === "boolean";
    default:
      return false;
  }
}

// MARK: - Grok's chips
//
// Grok writes no model or effort in its lines; it keeps both in the
// summary.json beside a session's updates.jsonl (`current_model_id`
// "grok-4.7", `reasoning_effort` "low" | "medium" | "high" | "xhigh"; T3 Code
// reads the same two from Grok's session setup) and its window in signals.json
// (`contextWindowTokens`). A pick is one typed command, `/model <id> <window>
// <effort>` and Enter (test/support/grok-model-fixtures.ts): Grok then says
// `Switched to Grok 4.6 (medium effort)` and its box's border reads
// `Grok 4.6 (medium)`. The same rules as
// Sources/HerdrKit/GrokSignals.swift.

/** Grok's effort words, in its menu's order. */
export const grokEfforts = ["low", "medium", "high", "xhigh"] as const;
/** Grok's windows, as its command words them. */
export const grokWindows = ["256k", "500k"] as const;

export interface GrokSummary {
  /** "grok-4.7". */
  readonly model: string;
  /** "Grok 4.7". */
  readonly modelLabel: string;
  readonly effort: string;
}

/** "grok-4.7" → "Grok 4.7"; null for another shape. */
export function grokModelLabel(model: string): string | null {
  return /^grok-[0-9]+(\.[0-9]+)*$/.test(model) ? `Grok ${model.slice("grok-".length)}` : null;
}

/** summary.json's model and effort, both known; null otherwise (nothing guessed). */
export function parseGrokSummary(text: string): GrokSummary | null {
  if (new TextEncoder().encode(text).length > maxGrokSummaryBytes) return null;
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) return null;
  const { current_model_id: model, reasoning_effort: effort } = object as Record<string, unknown>;
  if (typeof model !== "string" || typeof effort !== "string" || !(grokEfforts as readonly string[]).includes(effort)) return null;
  const modelLabel = grokModelLabel(model);
  return modelLabel === null ? null : { model, modelLabel, effort };
}

/** signals.json's `contextWindowTokens`, a whole positive count; null otherwise. */
export function parseGrokSignalsWindow(text: string): number | null {
  try {
    const value = (JSON.parse(text) as Record<string, unknown> | null)?.["contextWindowTokens"];
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** signals.json's `contextTokensUsed` and `contextWindowTokens` (the app's GrokSignals.context), each null when it does not read. */
export function parseGrokSignals(text: string): { readonly used: number | null; readonly window: number | null } {
  let object: Record<string, unknown> | null = null;
  try {
    object = asRecord(JSON.parse(text));
  } catch {
    object = null;
  }
  const count = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
  const window = count(object?.["contextWindowTokens"]);
  return { used: count(object?.["contextTokensUsed"]), window: window === 0 ? null : window };
}

/** 256000 → "256k", 500000 → "500k"; null for another. */
export function grokWindowWord(tokens: number | null | undefined): string | null {
  return tokens === 256_000 ? "256k" : tokens === 500_000 ? "500k" : null;
}

/** One pick from a Grok pane's chips. */
export type GrokPick = { readonly kind: "model" } | { readonly kind: "effort"; readonly value: string } | { readonly kind: "context"; readonly value: string };

/** The menu's value (`picker`, `effort:high`, `context:500k`) as a pick, or null. */
export function grokPickOf(value: string): GrokPick | null {
  if (value === "picker") return { kind: "model" };
  const [what, word] = value.split(":") as [string, string | undefined];
  if (what === "effort" && word !== undefined && (grokEfforts as readonly string[]).includes(word)) return { kind: "effort", value: word };
  if (what === "context" && word !== undefined && (grokWindows as readonly string[]).includes(word)) return { kind: "context", value: word };
  return null;
}

export function isGrokPick(value: unknown): value is GrokPick {
  if (typeof value !== "object" || value === null) return false;
  const pick = value as { kind?: unknown; value?: unknown };
  if (pick.kind === "model") return true;
  return typeof pick.value === "string" && grokPickOf(`${pick.kind === "effort" ? "effort" : pick.kind === "context" ? "context" : "?"}:${pick.value}`) !== null;
}

/** What the pick's command needs: summary.json's model and effort, the window (signals.json's or the screen's). */
export interface GrokFiles {
  readonly model: string | null;
  readonly effort: string | null;
  readonly window: string | null;
}

/** The command a pick types (then Enter): `/model grok-4.6 256k medium`; null when what it needs is not known. */
export function grokCommand(pick: GrokPick, files: GrokFiles): string | null {
  if (pick.kind === "model") return "/model";
  if (files.model === null || grokModelLabel(files.model) === null) return null;
  if (pick.kind === "effort") return files.window !== null && (grokWindows as readonly string[]).includes(files.window) ? `/model ${files.model} ${files.window} ${pick.value}` : null;
  return files.effort !== null && (grokEfforts as readonly string[]).includes(files.effort) ? `/model ${files.model} ${pick.value} ${files.effort}` : null;
}

/** The bottom of a Grok screen: its box's text, the border's model and effort, the top line's window. */
export interface GrokScreen {
  readonly draft: string;
  readonly borderModel: string | null;
  readonly borderEffort: string | null;
  readonly window: string | null;
  /** The border's mode word after the model and effort ("plan", "autoReview", "alwaysApprove"; none: "default"); null when the border does not read. */
  readonly mode: string | null;
}

/** Grok's box at the bottom of the screen, or null when there is none (a dialog in its place). */
export function readGrokScreen(screen: string): GrokScreen | null {
  const lines = screen.split("\n").map((line) => line.replace(/ +$/, ""));
  let bottom = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim().startsWith("\u{2570}") && lines[index]!.endsWith("\u{256F}")) {
      bottom = index;
      break;
    }
  }
  if (bottom < 2 || !lines[bottom - 2]!.trim().startsWith("\u{256D}")) return null;
  const row = lines[bottom - 1]!.trim();
  if (!row.startsWith("\u{2502} \u{276F}") || !row.endsWith("\u{2502}")) return null;
  const draft = row.slice("\u{2502} \u{276F}".length, -1).trim();
  const named = /─ (Grok [0-9.]+(?: [A-Za-z]+)*) \((low|medium|high|xhigh)\)(?: · ([^─]*))? ─╯$/u.exec(lines[bottom]!);
  let window: string | null = null;
  for (const line of lines) {
    const top = / [0-9.]+[KM]? \/ ([0-9]+)K │ /u.exec(line);
    if (top !== null) {
      window = `${top[1]}k`;
      break;
    }
  }
  return { draft, borderModel: named?.[1] ?? null, borderEffort: named?.[2] ?? null, window, mode: named === null ? null : grokModeOfWord(named[3]) };
}

/**
 * The approval mode a screen shows for the pane's agent: Claude Code's footer row, Grok's border,
 * Cursor's model row (approval-modes.ts ids); null when none reads (Codex's is in its rollout, not on screen).
 */
export function screenMode(agent: ModeAgent, screen: string): string | null {
  switch (agent) {
    case "claude":
      return readClaudeModeScreen(screen)?.mode ?? null;
    case "grok":
      return readGrokScreen(screen)?.mode ?? null;
    case "cursor": {
      const footer = parseCursorFooter(screen);
      return footer === null ? null : cursorFooterMode(footer);
    }
    case "codex":
      return null;
  }
}

/** A Grok pane's model, window and effort, each known. */
export interface GrokTuple {
  readonly model: string;
  readonly window: string;
  readonly effort: string;
}

/** The border's "Grok 4.6" as its id "grok-4.6"; null for another shape. */
export function grokModelId(label: string | null): string | null {
  if (label === null || !label.startsWith("Grok ")) return null;
  const id = `grok-${label.slice("Grok ".length)}`;
  return grokModelLabel(id) === label ? id : null;
}

/** The screen's model and effort (its border) and window (its top line), all known; null otherwise. */
export function grokScreenTuple(screen: GrokScreen): GrokTuple | null {
  const model = grokModelId(screen.borderModel);
  const { borderEffort: effort, window } = screen;
  if (model === null || effort === null || window === null) return null;
  if (!(grokEfforts as readonly string[]).includes(effort) || !(grokWindows as readonly string[]).includes(window)) return null;
  return { model, window, effort };
}

/** summary.json and signals.json agree with the screen: each part they name is the screen's (an unread part says nothing). */
export function grokFilesAgree(files: GrokFiles, screen: GrokTuple): boolean {
  return (files.model === null || files.model === screen.model) && (files.effort === null || files.effort === screen.effort) && (files.window === null || files.window === screen.window);
}

/** What a pick makes of the screen's tuple: only the chosen trait changes. */
export function grokTarget(pick: Exclude<GrokPick, { kind: "model" }>, screen: GrokTuple): GrokTuple {
  return pick.kind === "effort" ? { ...screen, effort: pick.value } : { ...screen, window: pick.value };
}

export function sameGrokTuple(a: GrokTuple | null, b: GrokTuple | null): boolean {
  return a !== null && b !== null && a.model === b.model && a.window === b.window && a.effort === b.effort;
}

/** The files' values as a pick reads them (the window as its word). */
export function grokFilesOf(settings: { readonly model: string | null; readonly effort: string | null; readonly window?: number | null }): GrokFiles {
  return { model: settings.model, effort: settings.effort, window: grokWindowWord(settings.window ?? null) };
}

/** The files name the whole tuple. */
export function grokFilesTuple(files: GrokFiles | null): GrokTuple | null {
  if (files === null || files.model === null || files.effort === null || files.window === null) return null;
  return { model: files.model, effort: files.effort, window: files.window };
}

