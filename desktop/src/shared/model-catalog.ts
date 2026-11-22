// Each agent's model list, read from the agent itself on the machine its pane
// lives on, in one shape (CatalogModel), for the Model chip's picker, the
// Effort chip and New agent.
//
// What each agent's CLI gives (at the versions named):
// - Claude Code (2.1.322): no list command, but it answers the question its
//   SDK asks at start: `claude -p --no-session-persistence --setting-sources ""
//   --input-format stream-json --output-format stream-json --verbose` with one
//   `initialize` control request on stdin prints one `control_response` line
//   whose response holds `models` (and exits when stdin ends): no prompt sent,
//   no tokens, no hooks, no session file. Each model's `value` (what `/model`
//   and `--model` take), `displayName`, `description`, `resolvedModel`,
//   `supportsEffort` and `supportedEffortLevels`. The same response carries
//   the account (an email, an organisation), commands and agents: only the
//   models are read, into new objects of CatalogModel's own fields.
// - Codex (codex-cli 0.167.0): `codex debug models`, JSON: each model's slug,
//   display_name, description, default_reasoning_level,
//   supported_reasoning_levels ({effort, description}), visibility ("list" or
//   "hide") and priority; some 40 keys per model, a few very long: only these
//   are read, each bounded. No model is marked as Codex's default.
// - Grok Build (1.0.77): `grok models`, plain text: "Available models:" then
//   one "  - <id>" per model, the default as "  * <id> (default)".
// - Cursor Agent (2026.11.05): `cursor-agent --list-models` (`cursor agent`
//   takes the same flag), "<id> - <Label>" per line, "(default)" after the
//   default's label, a Tip line last; effort and Fast are part of many ids,
//   and some labels carry zero-width spaces after "Fast".
// - OpenCode (1.18.21): `opencode models`, one "provider/model" per line;
//   `opencode models --verbose` prints each id line followed by
//   one JSON object (`name`, `providerID`, `variants`, beside `api`,
//   `headers`, `options` and `cost`; some 450 KB for 379 models). Only the id,
//   the display name, the provider id and the variant names are kept (a
//   provider's options can hold a key: never kept, logged or shown).
// - Antigravity CLI (1.5.14): `agy models`, plain text: "Fetching available
//   models..." and then one "<id><TAB><label>" row per model in the CLI's own
//   order (Gemini 4 Neon first); a label's last bracket is its level where it
//   is one ("Gemini 4 Neon (High)"). Inside an SSH session it exits 1 with
//   "Fetching available models..." and "Error: Please sign in to view
//   available models. ..." on stderr (its sign-in is in the Mac's login
//   keychain, which SSH cannot open). While no list was ever read for the
//   machine, a failed read shows agyBuiltIn (the 23 rows of the local list,
//   2026-11-22) under one line (agySshSignInLine, or agyFallbackLine), never
//   stored. 1.5.13 had no such command: a run that says its command is unknown
//   (agyLacksListCommand) leaves no list, and the picker says antigravityNoList
//   as it always did (builtInCatalog's `none`, model-choices.ts agyFamilies).
//
// Nothing here runs anything: main's catalog service (src/main/model-catalogs.ts)
// runs listCommand's argv (with its stdin line, for Claude Code) and gives the
// output to parseCatalog.

/** The agents with a model list (Chat kinds; Gemini CLI gets none: it is deprecated). */
export type CatalogAgent = "claude" | "codex" | "grok" | "cursor" | "opencode" | "agy";

export const catalogAgents: readonly CatalogAgent[] = ["claude", "codex", "grok", "cursor", "opencode", "agy"];

export function isCatalogAgent(value: unknown): value is CatalogAgent {
  return typeof value === "string" && (catalogAgents as readonly string[]).includes(value);
}

/** The agent kind's catalog, or null for a kind without one. */
export function catalogAgentOf(kind: string | null | undefined): CatalogAgent | null {
  return isCatalogAgent(kind) ? kind : null;
}

/** The agent's name in the picker's lines ("Could not read Cursor's models: …"). */
export const catalogAgentNames: Readonly<Record<CatalogAgent, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  opencode: "OpenCode",
  agy: "Antigravity CLI",
};

/** One model as the picker lists it. */
export interface CatalogModel {
  /** What the agent's flag and `/model` take ("gpt-6.1-sol", "openrouter/~anthropic/claude-opus-latest", "opus"). */
  readonly id: string;
  /** Its name in the row ("GPT-6.1-Sol", "Opus 5.5"). */
  readonly label: string;
  /** The header it sits under (OpenCode's provider, a Cursor family), or null. */
  readonly group: string | null;
  /** The effort levels it takes, in the agent's order; empty: the agent says none for it here. */
  readonly efforts: readonly string[];
  /** Its own default level among `efforts`, or null when the agent does not say. */
  readonly defaultEffort: string | null;
  /** The agent's default model (Grok's `*`, Cursor's "(default)", Claude Code's `default`). */
  readonly isDefault: boolean;
  /** One line about it (Codex's and Claude Code's description), or absent. */
  readonly note?: string;
  /** The full model an alias names now (Claude Code's `resolvedModel`: "opus" names "claude-opus-5-5"), or absent. */
  readonly resolves?: string;
  /**
   * OpenCode's variant names for the model (`--verbose`'s `variants` keys: "low", "medium"), present
   * (maybe empty) only when its list was read with display names; absent for every other agent.
   */
  readonly variants?: readonly string[];
}

/** What the picker gets for one machine and agent. */
export interface CatalogView {
  readonly agent: CatalogAgent;
  readonly models: readonly CatalogModel[];
  /** When the list was read (ms since 1970); null: never read (nothing yet, or Claude Code's fallback). */
  readonly readAt: number | null;
  /** "Could not read Cursor's models: <reason>." (the cached list stays), or null. */
  readonly error: string | null;
  /** A read is under way. */
  readonly loading: boolean;
  /** Why this agent has no list to show (Antigravity CLI while none was read), or null. */
  readonly none: string | null;
  /**
   * The quiet line over a list read on This Mac and shown for another Mac whose own list needs its
   * login keychain (Cursor's failed, Claude Code's shorter); absent or null for a machine's own list.
   */
  readonly borrowed?: string | null;
}

/**
 * The agents whose list needs the machine's login keychain (over SSH Cursor's fails, Claude Code
 * answers as signed out): another Mac's list for them may be shown from This Mac's.
 */
export const keychainAgents: ReadonlySet<CatalogAgent> = new Set<CatalogAgent>(["claude", "cursor"]);

/** The line over This Mac's list shown for another Mac. */
export function borrowedLine(machine: string): string {
  return `List read on This Mac; ${machine}'s own list needs its login keychain.`;
}

/** The quiet line in Claude Code's model picker on a running pane. */
export const claudePickNote = "Claude Code also makes this the default for new sessions on this Mac.";

/** A failed list's reason when the program said the login keychain is locked (another Mac, over SSH). */
export const keychainLockedReason = "the Mac's login keychain is locked over SSH";

/** The words Cursor Agent prints over SSH ("Error: Your macOS login keychain is locked."). */
export function saysKeychainLocked(line: string): boolean {
  return hasPhrase(line, "keychain is locked");
}

/** How long a program's own line may be in the failure line (the line stays one line in the picker). */
const maxSaidLength = 100;

/**
 * A program's first plain line of `text` (its stderr, or its stdout when it failed with a
 * message there): terminal escapes and control characters out, the first line with words, a leading "Error:" label
 * off, cut to maxSaidLength; null when there is none.
 */
export function firstPlainLine(text: string): string | null {
  const stripped = text
    // OSC and the other string escapes, up to BEL or ESC \.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[\]P_^][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    // CSI sequences, then any other two-byte escape.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-_]?/g, "");
  for (const raw of stripped.split(/\r\n|\r|\n|\u2028|\u2029/u)) {
    const line = cleanLabel(raw).replace(/^(?:error|fatal)\s*:\s*/i, "");
    if (!/\p{L}/u.test(line)) continue;
    return cut(line, maxSaidLength);
  }
  return null;
}

/** Antigravity CLI's picker line for a CLI with no `agy models` (1.5.13: the command is unknown): no model can be passed. */
export const antigravityNoList = "Antigravity CLI's models are in its own picker.";

/** Antigravity CLI's progress line before its list (on stderr): never the reason a list failed. */
const agyProgressLine = /^Fetching available models\.*$/i;

/**
 * The first plain line of a list program's stderr (firstPlainLine), Antigravity CLI's "Fetching available models..."
 * skipped: what the program said about a failure.
 */
export function saidLine(text: string): string | null {
  return firstPlainLine(
    text
      .split(/\r\n|\r|\n|\u2028|\u2029/u)
      .filter((line) => !agyProgressLine.test(cleanLabel(line)))
      .join("\n"),
  );
}

/** A failed `agy models` read's reason when the CLI asked to be signed in over SSH (its sign-in is in the keychain). */
export const agySshSignInReason = "its sign-in is in the Mac's keychain, which SSH cannot open";

/** `text` holds `phrase` as whole words (`\b` at both ends, ASCII case folded; its spaces exactly one space). */
export function hasPhrase(text: string, phrase: string): boolean {
  const lower = text.replace(/[A-Z]/g, (char) => char.toLowerCase());
  const word = (char: string | undefined): boolean => char !== undefined && /\w/.test(char);
  for (let at = lower.indexOf(phrase); at >= 0; at = lower.indexOf(phrase, at + 1)) {
    if (!word(lower[at - 1]) && !word(lower[at + phrase.length])) return true;
  }
  return false;
}

/** Antigravity CLI's words asking to be signed in ("Please sign in to view available models."). */
const agySignInPhrases: readonly string[] = ["please sign in", "sign in to view"];

export function saysAgySignIn(line: string): boolean {
  return agySignInPhrases.some((phrase) => hasPhrase(line, phrase));
}

/** The words a CLI says a command is unknown in ("unknown command", "unrecognized subcommand", "no such command"). */
const unknownCommandPhrases: readonly string[] = ["unknown", "unrecognized", "unrecognised", "invalid", "no such"].flatMap((word) => [`${word} command`, `${word} subcommand`]);

/**
 * Antigravity CLI with no `agy models` (1.5.13): its answer says the command is unknown (unknownCommandPhrases). Any
 * other failure is a list that could not be read now.
 */
export function agyLacksListCommand(text: string): boolean {
  return unknownCommandPhrases.some((phrase) => hasPhrase(text, phrase));
}

/** The words after a failed read's line over Antigravity CLI's built-in list. */
export const agyBuiltInNote = "Showing the models Adari knows.";

/** The line over Antigravity CLI's built-in list when it asked to be signed in over SSH. */
export const agySshSignInLine = `Antigravity CLI cannot list its models over SSH (its sign-in is in the Mac's keychain). ${agyBuiltInNote}`;

/** The line over Antigravity CLI's built-in list after any other failed read: the could-not-read line and the note. */
export function agyFallbackLine(reason: string): string {
  return reason === agySshSignInReason ? agySshSignInLine : `${catalogErrorLine("agy", reason)} ${agyBuiltInNote}`;
}

/** The line over a list whose last read failed. */
export function catalogErrorLine(agent: CatalogAgent, reason: string): string {
  return `Could not read ${catalogAgentNames[agent]}'s models: ${reason.replace(/\.$/, "")}.`;
}

/** The line over Claude Code's built-in aliases, shown when its own list could not be read and none is cached. */
export function claudeFallbackLine(reason: string): string {
  return `${catalogErrorLine("claude", reason)} Showing its four aliases.`;
}

// MARK: - bounds and patterns

/** A list's output past this is not read (Codex's JSON with every key is some hundreds of KB). */
export const maxCatalogBytes = 4 * 1_024 * 1_024;
/** At most this many models are kept from one list (OpenCode lists some 400). */
export const maxCatalogModels = 2_000;
/** A list command gets this long: 15 s (Claude Code's answer takes about 3 s on a Mac mini). */
export const catalogTimeoutMs = 20_000;
export const claudeTimeoutMs = 15_000;
/** A list older than this is read again (in the background, the cached one shown meanwhile). */
export const catalogFreshMs = 10 * 60_000;
const maxLabelLength = 80;
const maxNoteLength = 160;
const maxLevels = 12;

/** An effort level as any agent writes one ("low", "xhigh", "ultra"). */
export const effortPattern = /^[a-z]{1,16}$/;

/**
 * The strict shape of a model id per agent (nothing else reaches a command line, quoted or not):
 * Codex's and Grok's slugs, Cursor's ids, OpenCode's `provider/model` (OpenRouter's `~vendor/name` included),
 * Claude Code's aliases (`default`, `opus`) and full names (`claude-haiku-4-5-20251001`), `[1m]` after either.
 */
export const modelIdPatterns: Readonly<Record<CatalogAgent, RegExp>> = {
  claude: /^(?:[a-z]{1,24}|claude-[a-z0-9]+(?:[-.][a-z0-9]+){0,7})(?:\[1m\])?$/,
  codex: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  grok: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  cursor: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  opencode: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9~][A-Za-z0-9~._:@+/-]{0,191}$/,
  // `agy models`' ids ("gemini-4-neon-high", "gemini-3.8-flash-low", "gemini-pro-orchestrator-g1-pro").
  agy: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
};

export function isModelId(agent: CatalogAgent, id: unknown): id is string {
  return typeof id === "string" && modelIdPatterns[agent].test(id);
}

// MARK: - the list commands

/** One list command: the program and its arguments (argv; never a shell line), what goes to its stdin, its time. */
export interface ListCommand {
  /** The program ("codex", "/opt/homebrew/bin/codex", "~/.local/bin/cursor-agent": `~/` is the machine's home). */
  readonly program: string;
  readonly args: readonly string[];
  /** One line written to its stdin before stdin is closed (Claude Code's initialize request), or null: stdin empty. */
  readonly stdin: string | null;
  readonly timeoutMs: number;
}

/** Claude Code's initialize control request (one line; its answer names the models). */
export const claudeInitializeLine = JSON.stringify({ type: "control_request", request_id: "adari-models", request: { subtype: "initialize" } });

/** The arguments that make Claude Code answer the initialize request and nothing else. */
export const claudeListArgs: readonly string[] = [
  "-p",
  "--no-session-persistence",
  "--setting-sources",
  "",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
];

/** Each agent's stock program and the arguments that list its models. */
const listArgs: Readonly<Record<CatalogAgent, { readonly stock: ListCommand; readonly programs: readonly string[] }>> = {
  claude: { stock: { program: "claude", args: claudeListArgs, stdin: claudeInitializeLine, timeoutMs: claudeTimeoutMs }, programs: ["claude"] },
  codex: { stock: { program: "codex", args: ["debug", "models"], stdin: null, timeoutMs: catalogTimeoutMs }, programs: ["codex"] },
  grok: { stock: { program: "grok", args: ["models"], stdin: null, timeoutMs: catalogTimeoutMs }, programs: ["grok"] },
  cursor: { stock: { program: "cursor", args: ["agent", "--list-models"], stdin: null, timeoutMs: catalogTimeoutMs }, programs: ["cursor-agent", "cursor"] },
  // With each model's display name, provider and variants (parseOpenCodeModels keeps only those).
  opencode: { stock: { program: "opencode", args: ["models", "--verbose"], stdin: null, timeoutMs: catalogTimeoutMs }, programs: ["opencode"] },
  // About 2 s on a signed-in Mac (2026-11-21).
  agy: { stock: { program: "agy", args: ["models"], stdin: null, timeoutMs: catalogTimeoutMs }, programs: ["agy"] },
};

/** A program word the list may run: a name or a path of plain characters (a start command's own rule), `~/` allowed. */
const programWord = /^(?:~\/)?[A-Za-z0-9._/+@-]{1,255}$/;

/**
 * The command that lists `agent`'s models on a machine whose start command for it is `startCommand` (null: none
 * set): the binary that command names when it is the agent's own (`codex`, a path ending in `/codex`; Cursor's
 * `cursor-agent`, or `cursor agent`), else the stock one found on the machine's PATH. A wrapper such as `cl` or `cx`
 * is never run for a list. Null for an agent with no list command (none now: Antigravity CLI's is `agy models`).
 */
export function listCommand(agent: CatalogAgent, startCommand: string | null): ListCommand | null {
  const entry = listArgs[agent];
  if (startCommand === null) return entry.stock;
  const words = startCommand.trim().split(/\s+/).filter((word) => word !== "");
  const at = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const program = at < 0 ? null : words[at]!;
  if (program === null || !programWord.test(program) || program.includes("..")) return entry.stock;
  const name = program.split("/").at(-1) ?? "";
  if (!entry.programs.includes(name)) return entry.stock;
  if (agent === "cursor") {
    if (name === "cursor-agent") return { ...entry.stock, program, args: ["--list-models"] };
    // `cursor` is the app's launcher: only `cursor agent` runs the agent.
    return words[at + 1] === "agent" ? { ...entry.stock, program, args: ["agent", "--list-models"] } : entry.stock;
  }
  return { ...entry.stock, program };
}

// MARK: - the parsers

export type ParsedCatalog = { readonly ok: true; readonly models: readonly CatalogModel[] } | { readonly ok: false; readonly reason: string };

const refused = (reason: string): ParsedCatalog => ({ ok: false, reason });

/** Invisible and control characters out (Cursor's zero-width spaces after "Fast"), runs of spaces as one. */
export function cleanLabel(text: string): string {
  return text
    .replace(/[\p{Cf}\p{Cc}\u{2028}\u{2029}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const cut = (text: string, length: number): string => ([...text].length <= length ? text : `${[...text].slice(0, length - 1).join("")}\u{2026}`);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** An agent's list output as models, or why it did not read (never a throw). */
export function parseCatalog(agent: CatalogAgent, text: string): ParsedCatalog {
  if (text.length > maxCatalogBytes) return refused(`its list is larger than ${maxCatalogBytes / 1_048_576} MB`);
  switch (agent) {
    case "claude":
      return parseClaudeModels(text);
    case "codex":
      return parseCodexModels(text);
    case "grok":
      return parseGrokModels(text);
    case "cursor":
      return parseCursorModels(text);
    case "opencode":
      return parseOpenCodeModels(text);
    case "agy":
      return parseAgyModels(text);
  }
}

/** The models a list gave, at most maxCatalogModels, each id once (the first kept). */
function kept(models: readonly CatalogModel[]): ParsedCatalog {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
    if (out.length >= maxCatalogModels) break;
  }
  return out.length === 0 ? refused("its list named no model") : { ok: true, models: out };
}

/** Effort levels from a list (strings, or `{effort}` records), each once, at most maxLevels. */
function levelsOf(value: unknown): string[] {
  const levels: string[] = [];
  if (!Array.isArray(value)) return levels;
  for (const level of value.slice(0, maxLevels)) {
    const effort = typeof level === "string" ? level : asRecord(level)?.["effort"];
    if (typeof effort === "string" && effortPattern.test(effort) && !levels.includes(effort)) levels.push(effort);
  }
  return levels;
}

/** The lines a stream-json output is read in (Claude Code's answer is one of the first; no more than this are looked at). */
const maxStreamLines = 200;

/**
 * Claude Code's answer to the initialize request: its `control_response` line's `models` only, each as a new
 * CatalogModel (the account, commands and agents beside them are never read). `default` is Claude Code's own
 * default ("Default", the model it names beside it); the others by Claude Code's order.
 */
export function parseClaudeModels(text: string): ParsedCatalog {
  let response: Record<string, unknown> | null = null;
  for (const line of text.split(/\r?\n/).slice(0, maxStreamLines)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"control_response"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record?.["type"] !== "control_response") continue;
    response = asRecord(record["response"]);
    break;
  }
  if (response === null) return refused("it gave no answer to the initialize request (cut off, or not Claude Code)");
  if (response["subtype"] === "error") return refused("it answered the initialize request with an error");
  const list = asRecord(response["response"])?.["models"] ?? response["models"];
  if (!Array.isArray(list)) return refused("its answer has no models");
  const rows: { id: string; label: string; note: string; efforts: string[]; resolves: string | null }[] = [];
  for (const raw of list.slice(0, maxCatalogModels)) {
    const record = asRecord(raw);
    if (record === null) continue;
    const id = record["value"];
    if (!isModelId("claude", id)) continue;
    const name = typeof record["displayName"] === "string" ? cleanLabel(record["displayName"]) : "";
    const description = typeof record["description"] === "string" ? cleanLabel(record["description"]) : "";
    const resolved = record["resolvedModel"];
    rows.push({
      id,
      label: name === "" ? id : cut(name, maxLabelLength),
      note: cut(description, maxNoteLength),
      efforts: record["supportsEffort"] === true ? levelsOf(record["supportedEffortLevels"]) : [],
      resolves: isModelId("claude", resolved) ? resolved : null,
    });
  }
  const models = rows.map((row): CatalogModel => {
    const isDefault = row.id === "default";
    // `default` reads "Default (recommended)" with the model as its description: "Default", the model it names beside it.
    const named = isDefault ? (rows.find((other) => other.id !== "default" && other.resolves !== null && other.resolves === row.resolves)?.label ?? row.note) : row.note;
    return {
      id: row.id,
      label: isDefault ? "Default" : row.label,
      group: null,
      efforts: row.efforts,
      defaultEffort: null,
      isDefault,
      ...(named === "" ? {} : { note: named }),
      ...(row.resolves === null ? {} : { resolves: row.resolves }),
    };
  });
  return kept(models);
}

/** `codex debug models`: the listed models (visibility "list" or none given) by priority, each with its levels and default. */
export function parseCodexModels(text: string): ParsedCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refused("its list is not JSON (cut off, or not Codex's)");
  }
  const list = Array.isArray(parsed) ? parsed : asRecord(parsed)?.["models"];
  if (!Array.isArray(list)) return refused("its list has no models");
  const rows: { model: CatalogModel; priority: number; order: number }[] = [];
  list.forEach((raw: unknown, order) => {
    const record = asRecord(raw);
    if (record === null) return;
    const slug = record["slug"];
    if (!isModelId("codex", slug)) return;
    const visibility = record["visibility"];
    if (visibility !== undefined && visibility !== "list") return;
    const levels = levelsOf(record["supported_reasoning_levels"]);
    const fallback = record["default_reasoning_level"];
    const defaultEffort = typeof fallback === "string" && levels.includes(fallback) ? fallback : null;
    const name = typeof record["display_name"] === "string" ? cleanLabel(record["display_name"]) : "";
    const description = typeof record["description"] === "string" ? cleanLabel(record["description"]) : "";
    const priority = typeof record["priority"] === "number" && Number.isFinite(record["priority"]) ? record["priority"] : Number.MAX_SAFE_INTEGER;
    rows.push({
      model: {
        id: slug,
        label: name === "" ? slug : cut(name, maxLabelLength),
        group: null,
        efforts: levels,
        defaultEffort,
        isDefault: false,
        ...(description === "" ? {} : { note: cut(description, maxNoteLength) }),
      },
      priority,
      order,
    });
  });
  rows.sort((a, b) => a.priority - b.priority || a.order - b.order);
  return kept(rows.map((row) => row.model));
}

/** "grok-4.7" → "Grok 4.7"; "grok-4.7-build-fast" → "Grok 4.7 Build Fast"; another id as it is. */
export function grokCatalogLabel(id: string): string {
  if (!id.startsWith("grok-")) return id;
  return id
    .split("-")
    .map((word) => (/^[a-z]/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** Grok's levels (its summary.json's words; agent-settings.ts grokEfforts): `grok models` says none per model. */
export const grokLevels: readonly string[] = ["low", "medium", "high", "xhigh"];
/** Cursor's levels in its Edit Parameters (agent-settings.ts cursorEfforts). */
export const cursorLevels: readonly string[] = ["low", "medium", "high", "xhigh"];

/** `grok models`: the rows under "Available models:", the `*` one (or "(default)", or "Default model: x") Grok's default. */
export function parseGrokModels(text: string): ParsedCatalog {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+$/, ""));
  const header = lines.findIndex((line) => /^Available models:?$/i.test(line.trim()));
  if (header < 0) return refused("its list has no “Available models”");
  const named = lines.map((line) => /^Default model:\s*(\S+)$/i.exec(line.trim())?.[1]).find((id) => id !== undefined) ?? null;
  const models: CatalogModel[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() === "") continue;
    const match = /^\s+([-*])\s+(\S+)(\s+\(default\))?$/.exec(line);
    if (match === null) break;
    const id = match[2]!;
    if (!isModelId("grok", id)) continue;
    models.push({ id, label: grokCatalogLabel(id), group: null, efforts: [], defaultEffort: null, isDefault: match[1] === "*" || match[3] !== undefined || id === named });
  }
  return kept(models);
}

/** A Cursor label's family when the label makes it plain (its first word, one of these), else null. */
const cursorFamilies: readonly string[] = ["Claude", "GPT", "Codex", "Composer", "Grok", "Gemini", "Kimi", "GLM", "DeepSeek", "Muse"];

export function cursorFamily(label: string): string | null {
  const first = label.split(" ")[0] ?? "";
  return cursorFamilies.includes(first) ? first : null;
}

/** `cursor-agent --list-models`: "<id> - <Label>" rows, labels cleaned, "(default)" read off and taken out. */
export function parseCursorModels(text: string): ParsedCatalog {
  const models: CatalogModel[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^(\S+) - (.+)$/.exec(raw.trim());
    if (match === null) continue;
    const id = match[1]!;
    if (!isModelId("cursor", id)) continue;
    let label = cleanLabel(match[2]!);
    const isDefault = /\s*\(default\)$/i.test(label);
    if (isDefault) label = label.replace(/\s*\(default\)$/i, "");
    if (label === "") label = id;
    models.push({ id, label: cut(label, maxLabelLength), group: cursorFamily(label), efforts: [], defaultEffort: null, isDefault });
  }
  return kept(models);
}

/** One `--verbose` object past this is not read (the model keeps its id; a real one is some 1.2 KB). */
export const maxOpenCodeObjectBytes = 64 * 1_024;
/** At most this many variant names are kept per model. */
const maxVariants = 12;
/** A variant name as OpenCode's list and its "Select variant" show one ("low", "xhigh", "thinking-max"). */
const variantPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** A provider id as `--verbose` names it ("opencode", "openrouter"). */
const providerPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `opencode models` and `opencode models --verbose`: each "provider/model" line, followed under
 * `--verbose` by one JSON object, read as a new CatalogModel of four fields only: the id, its display name
 * (`name`, cleaned and cut; the id's model part when it names none), its provider id (`providerID`, the group;
 * the id's provider part when it names none) and its variant names (`variants`' keys). `api`, `headers`, `options`,
 * `cost` and everything else are never read into anything. An object past maxOpenCodeObjectBytes, or one that is not
 * JSON, keeps the model's id with no name. A plain line (no object after it) is read as an id alone, with no variants
 * field: the picker shows its id's model part, and no live pick types a name for it.
 */
export function parseOpenCodeModels(text: string): ParsedCatalog {
  const lines = text.split(/\r?\n/);
  const models: CatalogModel[] = [];
  let at = 0;
  while (at < lines.length && models.length < maxCatalogModels) {
    const id = lines[at]!.trim();
    at += 1;
    if (id === "" || !isModelId("opencode", id)) continue;
    const slash = id.indexOf("/");
    const plain: CatalogModel = { id, label: cut(id.slice(slash + 1), maxLabelLength), group: id.slice(0, slash), efforts: [], defaultEffort: null, isDefault: false };
    if (lines[at] !== "{") {
      models.push(plain);
      continue;
    }
    // The object: from its "{" line to the first "}" at the margin (a pretty-printed object's own end), bounded.
    const start = at;
    let bytes = 0;
    let end = -1;
    for (let line = start; line < lines.length; line += 1) {
      bytes += lines[line]!.length + 1;
      if (lines[line] === "}") {
        end = line;
        break;
      }
      if (bytes > maxOpenCodeObjectBytes) break;
    }
    if (end < 0) {
      // Too large, or cut off: the id alone; the reading goes on at the next id line.
      while (at < lines.length && !(lines[at] !== "{" && isModelId("opencode", lines[at]!.trim()) && lines[at + 1] === "{")) at += 1;
      models.push({ ...plain, variants: [] });
      continue;
    }
    at = end + 1;
    if (bytes > maxOpenCodeObjectBytes) {
      models.push({ ...plain, variants: [] });
      continue;
    }
    let record: Record<string, unknown> | null = null;
    try {
      record = asRecord(JSON.parse(lines.slice(start, end + 1).join("\n")));
    } catch {
      record = null;
    }
    if (record === null) {
      models.push({ ...plain, variants: [] });
      continue;
    }
    const rawName = record["name"];
    const name = typeof rawName === "string" ? cleanLabel(rawName) : "";
    const rawProvider = record["providerID"];
    const provider = typeof rawProvider === "string" && providerPattern.test(rawProvider) ? rawProvider : plain.group;
    const variantRecord = asRecord(record["variants"]);
    const variants = variantRecord === null ? [] : Object.keys(variantRecord).filter((key) => variantPattern.test(key)).slice(0, maxVariants);
    models.push({ ...plain, label: name === "" ? plain.label : cut(name, maxLabelLength), group: provider, variants });
  }
  return kept(models);
}

/**
 * `agy models`: each row "<id><TAB><label>", the id of the agent's pattern and the label with words, in the CLI's
 * order; any other row (its "Fetching available models..." line, a blank, an error, a row with another tab or none,
 * a missing label) is skipped. A carriage return at a row's end is not part of it. No model name is written here: a
 * model the CLI lists tomorrow shows up by itself. The levels are read off the labels later (model-choices.ts
 * agyFamilies): each row is one model here, its `efforts` empty.
 */
export function parseAgyModels(text: string): ParsedCatalog {
  const models: CatalogModel[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const row = raw.replace(/\r$/, "");
    const parts = row.split("\t");
    if (parts.length !== 2) continue;
    const id = parts[0]!;
    if (!isModelId("agy", id)) continue;
    const label = cleanLabel(parts[1]!);
    if (!/\p{L}/u.test(label)) continue;
    models.push({ id, label: cut(label, maxLabelLength), group: null, efforts: [], defaultEffort: null, isDefault: false });
  }
  return kept(models);
}

// MARK: - Claude Code's fallback

/** Claude Code's `--effort` levels (its help: low, medium, high, xhigh, max). */
export const claudeLevels: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * What the picker shows for Claude Code when its own list could not be read and none is cached: its
 * four aliases (its help: "an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full
 * name"), each with its five levels, no default level claimed.
 */
export const claudeFallback: readonly CatalogModel[] = (["fable", "opus", "sonnet", "haiku"] as const).map((id) => {
  const label = id.charAt(0).toUpperCase() + id.slice(1);
  return { id, label, group: null, efforts: claudeLevels, defaultEffort: null, isDefault: false, note: `The latest ${label}` };
});

// MARK: - Antigravity CLI's built-in list

/**
 * `agy models` (1.5.14) as a signed-in Mac printed it on 2026-11-22: its 23 rows, ids and names as printed, in its order
 * (fixtures/agy/builtin-1.5.14.txt, which test/agy-list.test.ts keeps identical). Shown only while no list was ever read
 * for the machine; a read list replaces it, and it is never stored as read.
 */
const agyBuiltInRows: readonly (readonly [string, string])[] = [
  ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
  ["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"],
  ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
  ["gemini-4-neon-low", "Gemini 4 Neon (Low)"],
  ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
  ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
  ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
  ["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"],
  ["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
  ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)"],
  ["gemini-pro-orchestrator-g1-pro", "Orchestrator (Argon)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
  ["claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"],
  ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
  ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"],
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
];

/** Antigravity CLI's built-in list, each row as parseAgyModels reads one (no level claimed: they are read off the labels). */
export const agyBuiltIn: readonly CatalogModel[] = agyBuiltInRows.map(([id, label]) => ({ id, label, group: null, efforts: [], defaultEffort: null, isDefault: false }));

/** The catalog an agent has before anything is read: Antigravity's none line (no list read), the others empty. */
export function builtInCatalog(agent: CatalogAgent): CatalogView {
  return { agent, models: [], readAt: null, error: null, loading: false, none: agent === "agy" ? antigravityNoList : null };
}

/** A view as main sends it (anything else is refused by the page). */
export function isCatalogView(value: unknown): value is CatalogView {
  const record = asRecord(value);
  if (record === null || !isCatalogAgent(record["agent"]) || !Array.isArray(record["models"])) return false;
  const text = (item: unknown): boolean => item === null || typeof item === "string";
  return (
    (record["readAt"] === null || typeof record["readAt"] === "number") &&
    text(record["error"]) &&
    text(record["none"]) &&
    (record["borrowed"] === undefined || text(record["borrowed"])) &&
    typeof record["loading"] === "boolean" &&
    (record["models"] as unknown[]).every(isCatalogModel)
  );
}

/** One model as stored or sent (the disk cache is read through this too). */
export function isCatalogModel(value: unknown): value is CatalogModel {
  const row = asRecord(value);
  const text = (item: unknown): boolean => item === null || typeof item === "string";
  return (
    row !== null &&
    typeof row["id"] === "string" &&
    typeof row["label"] === "string" &&
    text(row["group"]) &&
    Array.isArray(row["efforts"]) &&
    (row["efforts"] as unknown[]).every((level) => typeof level === "string") &&
    text(row["defaultEffort"]) &&
    typeof row["isDefault"] === "boolean" &&
    (row["note"] === undefined || typeof row["note"] === "string") &&
    (row["resolves"] === undefined || typeof row["resolves"] === "string") &&
    (row["variants"] === undefined || (Array.isArray(row["variants"]) && (row["variants"] as unknown[]).every((name) => typeof name === "string")))
  );
}

/** Only CatalogModel's own fields of a model (what the disk cache writes and the page gets; nothing else rides along). */
export function catalogModelFields(model: CatalogModel): CatalogModel {
  return {
    id: model.id,
    label: model.label,
    group: model.group,
    efforts: [...model.efforts],
    defaultEffort: model.defaultEffort,
    isDefault: model.isDefault,
    ...(model.note === undefined ? {} : { note: model.note }),
    ...(model.resolves === undefined ? {} : { resolves: model.resolves }),
    ...(model.variants === undefined ? {} : { variants: [...model.variants] }),
  };
}
