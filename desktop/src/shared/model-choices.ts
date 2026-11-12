// What a model's Effort chip offers, the start flags New agent adds, and the
// command a live pick types, each from the agent's own catalog
// (model-catalog.ts).
//
// Effort belongs to the model (T3 Code's rule): the Effort chip lists only the
// levels the current model takes, its default marked; when the model changes
// and the chosen level is not one of its levels, the choice falls back to that
// model's default (no nearest-level rounding).
//
// Start flags (each CLI's --help): Claude Code
// `--model <alias or name>` and `--effort <level>`; Codex `-m <model>` and
// `-c model_reasoning_effort=<level>` (Codex reads the value as TOML and takes
// a word that is not TOML as itself); Grok `-m <id>` and
// `--reasoning-effort <level>`; Cursor Agent `--model <id>` (its effort is part
// of the id); OpenCode `-m provider/model`. Nothing is passed that is not in
// the catalog and of the agent's strict id pattern.

import { claudeLevels, cursorLevels, effortPattern, grokLevels, isModelId, type CatalogAgent, type CatalogModel } from "./model-catalog";

/** What a model's Effort chip offers: its levels in the agent's order and its own default (null: the agent does not say). */
export interface EffortChoices {
  readonly levels: readonly string[];
  readonly defaultLevel: string | null;
}

/** Codex's levels before its catalog has been read (the old fixed list). */
const codexUnread: readonly string[] = ["low", "medium", "high", "xhigh"];

const none: EffortChoices = { levels: [], defaultLevel: null };

/** The rows a picker lists for `agent` (Claude Code's `default` is the "Agent's default" row, not a model row). */
export function listedModels(agent: CatalogAgent, models: readonly CatalogModel[]): readonly CatalogModel[] {
  return agent === "claude" ? models.filter((model) => model.id !== "default") : models;
}

/** The agent's default model as the catalog names it (Claude Code's `default` entry, Grok's `*`, Cursor's Auto), or null. */
export function catalogDefault(models: readonly CatalogModel[]): CatalogModel | null {
  return models.find((model) => model.isDefault) ?? null;
}

/** The words beside "Agent's default": the model it is now (Claude Code: "Fable 5.2"; Grok: "Grok 4.6"), or null. */
export function defaultNote(agent: CatalogAgent, models: readonly CatalogModel[]): string | null {
  const model = catalogDefault(models);
  if (model === null) return null;
  return agent === "claude" ? (model.note ?? null) : model.label;
}

/** The levels each of `models` takes, in the first one's order (Codex's default model is not named: its safe levels). */
function sharedLevels(models: readonly CatalogModel[]): string[] {
  const withLevels = models.filter((model) => model.efforts.length > 0);
  if (withLevels.length === 0) return [];
  return withLevels[0]!.efforts.filter((level) => withLevels.every((model) => model.efforts.includes(level)));
}

/** A Claude Code model by what a picker or a transcript names: its value, or an alias that resolves to it now. */
export function claudeModelOf(models: readonly CatalogModel[], id: string | null): CatalogModel | null {
  if (id === null) return null;
  const exact = models.find((model) => model.id === id);
  if (exact !== undefined) return exact;
  return models.find((model) => model.id !== "default" && model.resolves === id) ?? models.find((model) => model.resolves === id) ?? null;
}

/**
 * The levels and default for `modelId` (null: the agent's default model) by `agent`'s catalog: Codex's per model
 * (its default model is not named: the levels every listed model takes); Claude Code's per model (Haiku 4.5: none),
 * the `default` entry's for its default; Grok's four (`grok models` says none per model); Cursor's from its footer
 * (cursorEffortChoices); OpenCode and Antigravity CLI none. A model the catalog does not have: the agent's levels.
 */
export function effortChoices(agent: CatalogAgent, models: readonly CatalogModel[], modelId: string | null): EffortChoices {
  switch (agent) {
    case "codex": {
      if (modelId === null) return models.length === 0 ? { levels: codexUnread, defaultLevel: null } : { levels: sharedLevels(models), defaultLevel: null };
      const model = models.find((one) => one.id === modelId);
      if (model === undefined) return { levels: codexUnread, defaultLevel: null };
      // An entry that names no levels takes the agent's.
      return model.efforts.length === 0 ? { levels: codexUnread, defaultLevel: null } : { levels: model.efforts, defaultLevel: model.defaultEffort };
    }
    case "claude": {
      const model = claudeModelOf(models, modelId ?? "default");
      if (model === null) return { levels: claudeLevels, defaultLevel: null };
      return { levels: model.efforts, defaultLevel: model.defaultEffort };
    }
    case "grok":
      return { levels: grokLevels, defaultLevel: null };
    case "cursor":
      return { levels: cursorLevels, defaultLevel: null };
    case "opencode":
    case "agy":
      return none;
  }
}

/** The level a model change keeps: the chosen one when the new model takes it, else the model's default (null: the agent's own). */
export function fallbackEffort(choices: EffortChoices, chosen: string | null): string | null {
  if (chosen !== null && choices.levels.includes(chosen)) return chosen;
  return choices.defaultLevel !== null && choices.levels.includes(choices.defaultLevel) ? choices.defaultLevel : null;
}

// MARK: - Cursor's variants

/** The words Cursor's labels add after a model's name: its level, Fast, Thinking, the 1M context, "(NO ZDR)". */
const cursorTail = /\s+(?:Low|Medium|High|Extra High|Max|None|Minimal|Fast|Thinking|1M|\(NO ZDR\))$/i;
const cursorLevelWord = /\b(?:Low|Medium|High|Extra High|Max|None|Minimal)\b/i;

/** "Grok 4.7 Medium Fast" → "Grok 4.7"; "Claude Opus 5 1M Thinking" → "Claude Opus 5". */
export function cursorBaseLabel(label: string): string {
  let base = label.replace(/\s+/g, " ").trim();
  for (let index = 0; index < 8; index += 1) {
    const next = base.replace(cursorTail, "");
    if (next === base) break;
    base = next;
  }
  return base;
}

/** The level a Cursor id carries ("grok-4.7-medium-fast" → "medium"), or null. */
export function cursorIdLevel(id: string): string | null {
  return /-(none|minimal|low|medium|high|xhigh|max)(?:-fast)?$/.exec(id)?.[1] ?? null;
}

/** A Cursor id with Fast on ("…-fast"). */
export function cursorIdFast(id: string): boolean {
  return id.endsWith("-fast");
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The catalog's variants of the model Cursor's footer names ("Grok 4.7": grok-4.7-low, …-medium-fast, …). */
export function cursorVariants(models: readonly CatalogModel[], footerModel: string): CatalogModel[] {
  const name = cursorBaseLabel(footerModel);
  return models.filter((model) => sameName(cursorBaseLabel(model.label), name));
}

/**
 * Cursor's Effort chip for the footer's model: its four levels (the Edit Parameters rows the pick drives) cut to
 * those the catalog lists a variant of, when it lists any; the default, the level of the variant whose label names
 * none ("Grok 4.6" is cursor-grok-4.6-high).
 */
export function cursorEffortChoices(models: readonly CatalogModel[], footerModel: string): EffortChoices {
  const variants = cursorVariants(models, footerModel);
  const listed = new Set(variants.map((model) => cursorIdLevel(model.id)).filter((level): level is string => level !== null));
  const levels = listed.size === 0 ? cursorLevels : cursorLevels.filter((level) => listed.has(level));
  const plain = variants.find((model) => !cursorIdFast(model.id) && !cursorLevelWord.test(model.label.replace(cursorBaseLabel(model.label), "")));
  const level = plain === undefined ? null : cursorIdLevel(plain.id);
  return { levels: levels.length === 0 ? cursorLevels : levels, defaultLevel: level !== null && levels.includes(level) ? level : null };
}

/** The catalog id Cursor's footer is on (its model, level and Fast), or null when the catalog has no such row. */
export function cursorCurrentId(models: readonly CatalogModel[], footer: { readonly model: string; readonly effort: string; readonly fast: boolean }): string | null {
  const variants = cursorVariants(models, footer.model);
  const exact = variants.find((model) => cursorIdFast(model.id) === footer.fast && cursorIdLevel(model.id) === footer.effort);
  if (exact !== undefined) return exact.id;
  return variants.length === 1 ? variants[0]!.id : null;
}

// MARK: - Cursor's families

/**
 * The words after a family's name in Cursor's labels and in its list's right column: a level, Fast, Thinking or "No
 * Thinking", a window ("1M", "300K"), "(NO ZDR)".
 */
const cursorFamilyTail = /\s+(?:No Thinking|Thinking|Low|Medium|High|Extra High|Max|None|Minimal|Fast|\d{1,4}(?:\.\d{1,2})?[KM]|\(NO ZDR\))$/i;

/**
 * A Cursor label's family as Cursor's own `/model` list names it ("Claude Opus 5 1M Low Thinking" →
 * "Claude Opus 5"; "Claude Haiku 5.5  Low No Thinking" → "Claude Haiku 5.5"; "Auto"), or a footer's model line
 * ("Composer 2.5 Fast" → "Composer 2.5"; "Claude Opus 5.5 300K Medium" → "Claude Opus 5.5").
 */
export function cursorFamilyName(label: string): string {
  let base = label
    .replace(/[\p{Cf}\p{Cc}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  for (let index = 0; index < 10; index += 1) {
    const next = base.replace(cursorFamilyTail, "");
    if (next === base) break;
    base = next;
  }
  return base;
}

/** A family name `/model <words>` may carry as typed: letters, digits, spaces, dots, hyphens; nothing else. */
const typeableFamily = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,63}$/;

/** One Cursor family as the running pane's Model menu lists it. */
export interface CursorFamily {
  /** Its name, as Cursor's list names it ("Claude Opus 5.5"). */
  readonly name: string;
  /** The first catalog id of the family (the row's id; main finds the family again from it). */
  readonly id: string;
  /** The catalog ids in it. */
  readonly ids: readonly string[];
  /**
   * Why `/model <name>` is not typed for it (its row opens Cursor's own list in the Terminal), or null: its name is
   * inside another family's (Cursor takes the first family the words match: `/model Claude Opus 5` gives "Claude
   * Opus 5.5 300K Medium"), or it has characters a typed command does not carry.
   */
  readonly terminalOnly: string | null;
}

const words = (name: string): string[] => name.toLowerCase().split(" ").filter((word) => word !== "");

/**
 * Whether every word of `inner` is inside a word of `outer`, in order (case ignored): "Claude Opus 5" in "Claude Opus
 * 5.5", "Gemini 3 Flash" in "Gemini 3.8 Flash". Wider than a plain substring on purpose (how Cursor matches the words
 * is not known beyond what its screen showed): such a family is never typed.
 */
export function cursorFamilyInside(inner: string, outer: string): boolean {
  const a = words(inner);
  const b = words(outer);
  if (a.length === 0 || a.join(" ") === b.join(" ")) return false;
  let at = 0;
  for (const word of a) {
    while (at < b.length && !b[at]!.includes(word)) at += 1;
    if (at >= b.length) return false;
    at += 1;
  }
  return true;
}

/** Cursor's catalog as its families, in the catalog's order (Auto first, as Cursor's list has it). */
export function cursorFamilies(models: readonly CatalogModel[]): CursorFamily[] {
  const byName = new Map<string, { name: string; ids: string[] }>();
  for (const model of models) {
    const name = cursorFamilyName(model.label);
    if (name === "") continue;
    const key = name.toLowerCase();
    const entry = byName.get(key);
    if (entry === undefined) byName.set(key, { name, ids: [model.id] });
    else entry.ids.push(model.id);
  }
  const all = Array.from(byName.values());
  return all.map(({ name, ids }): CursorFamily => {
    const outer = all.find((other) => cursorFamilyInside(name, other.name));
    const terminalOnly =
      outer !== undefined
        ? `Opens Cursor's own list in the Terminal: typed, \u{201C}${name}\u{201D} would pick ${outer.name}.`
        : typeableFamily.test(name)
          ? null
          : "Opens Cursor's own list in the Terminal: its name cannot be typed as a command.";
    return { name, id: ids[0]!, ids, terminalOnly };
  });
}

/** The family a Cursor catalog id belongs to, or null. */
export function cursorFamilyOf(models: readonly CatalogModel[], id: string): CursorFamily | null {
  return cursorFamilies(models).find((family) => family.ids.includes(id)) ?? null;
}

/** The family Cursor's footer (its model, or its whole model line) names. */
export function sameCursorFamily(a: string, b: string): boolean {
  return cursorFamilyName(a).toLowerCase() === cursorFamilyName(b).toLowerCase();
}

/**
 * The row of Grok's list a name on its screen stands for ("Grok 4.7 Fast" in its border or its
 * "Switched to …" line; the list says "Grok 4.7 Build Fast", grok-4.7-build-fast), or null when none (or more than
 * one) does. In order: a row whose label is the name (case ignored); a row whose id is the name's words joined by
 * `-` (grok-4.7-fast); else the one row whose label has the name's words in order with its own first two words
 * the name's (Grok and the version), and no word the name has that it lacks.
 */
export function grokRowOfScreenName(models: readonly CatalogModel[], name: string): string | null {
  const words = (text: string): string[] => text.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
  const said = words(name);
  if (said.length < 2 || said[0] !== "grok") return null;
  const exact = models.filter((model) => model.label.trim().toLowerCase() === said.join(" "));
  if (exact.length === 1) return exact[0]!.id;
  const byId = models.filter((model) => model.id.toLowerCase() === said.join("-"));
  if (byId.length === 1) return byId[0]!.id;
  const inOrder = (label: readonly string[]): boolean => {
    let at = 0;
    for (const word of label) if (word === said[at]) at += 1;
    return at === said.length;
  };
  const near = models.filter((model) => {
    const label = words(model.label);
    return label[0] === said[0] && label[1] === said[1] && inOrder(label);
  });
  return near.length === 1 ? near[0]!.id : null;
}

/** The model names Grok's "Switched to <name> (<level> effort)" lines give, in screen order. */
export function grokSwitchedNames(screen: string): { readonly name: string; readonly effort: string }[] {
  const out: { name: string; effort: string }[] = [];
  for (const line of screen.split("\n")) {
    const match = /^\s+Switched to (Grok [0-9.]+(?: [A-Za-z]+)*) \((low|medium|high|xhigh) effort\)\s*$/u.exec(line);
    if (match !== null) out.push({ name: match[1]!, effort: match[2]! });
  }
  return out;
}

// MARK: - the current model

/** What the transcript (or footer, or files) says the pane runs: an id and the label shown for it. */
export interface RunningModel {
  readonly id: string | null;
  readonly label: string | null;
}

/**
 * The catalog id to tick for what the pane runs: the same id, or for Claude Code the alias that resolves to it now
 * ("claude-opus-5-5" ticks `opus`), or the row of the same label; null when none matches.
 */
export function currentModelId(agent: CatalogAgent, models: readonly CatalogModel[], running: RunningModel): string | null {
  const listed = listedModels(agent, models);
  if (running.id !== null) {
    if (listed.some((model) => model.id === running.id)) return running.id;
    if (agent === "claude") {
      const alias = listed.find((model) => model.resolves === running.id);
      if (alias !== undefined) return alias.id;
    }
  }
  // A 1M form keeps its base model's label ("Opus 5.5"): only its own id ticks a row.
  if (running.label !== null && running.id?.endsWith("[1m]") !== true) {
    const named = listed.find((model) => sameName(model.label, running.label!));
    if (named !== undefined) return named.id;
  }
  return null;
}

/**
 * The catalog joined with the model the pane runs (for Claude Code, its list joined with its
 * transcript's model): a model the list does not name is added first, "In use now", with the levels of the model
 * it is a form of when the list has one (claude-opus-5-5[1m] takes Opus 5.5's).
 */
export function withRunningModel(agent: CatalogAgent, models: readonly CatalogModel[], running: RunningModel): readonly CatalogModel[] {
  if (running.id === null || !isModelId(agent, running.id) || currentModelId(agent, models, running) !== null) return models;
  const base = agent === "claude" ? claudeModelOf(models, running.id.replace(/\[1m\]$/, "")) : null;
  const extra: CatalogModel = {
    id: running.id,
    label: running.label ?? running.id,
    group: null,
    efforts: base?.efforts ?? (agent === "claude" ? claudeLevels : []),
    defaultEffort: base?.defaultEffort ?? null,
    isDefault: false,
    note: "In use now",
  };
  return [extra, ...models];
}

/**
 * The Model chip's words for New agent's choice before the agent says its own, as the agent
 * will name it: Codex's slug (its transcript's), Cursor's model without its level and Fast words (its footer's),
 * else the list's label.
 */
export function startChipLabel(agent: CatalogAgent, models: readonly CatalogModel[], id: string): string {
  if (agent === "codex") return id;
  const label = models.find((model) => model.id === id)?.label ?? id;
  return agent === "cursor" ? cursorBaseLabel(label) : label;
}

// MARK: - New agent's flags

/** New agent's choice: a model and an effort, each null for the agent's default (no flag). */
export interface StartChoice {
  readonly model: string | null;
  readonly effort: string | null;
}

/** One flag and its value (the flag is the app's own word; the value came from a catalog and is quoted when typed). */
export interface StartFlag {
  readonly flag: string;
  readonly value: string;
}

export type StartFlags = { readonly ok: true; readonly flags: readonly StartFlag[] } | { readonly ok: false; readonly reason: string };

/** The agents New agent offers an Effort row for (Cursor's effort is part of its model id; OpenCode's start has none). */
export function startTakesEffort(agent: CatalogAgent): boolean {
  return agent === "claude" || agent === "codex" || agent === "grok";
}

/** The agents New agent offers a Model row for (Antigravity CLI: none to read). */
export function startTakesModel(agent: CatalogAgent): boolean {
  return agent !== "agy";
}

/**
 * The start flags for New agent's choice, each value checked against `models` (the machine's catalog for the agent)
 * and the agent's strict pattern; anything else is refused with why (nothing outside them reaches a command line).
 */
export function startFlags(agent: CatalogAgent, choice: StartChoice, models: readonly CatalogModel[]): StartFlags {
  const refuse = (reason: string): StartFlags => ({ ok: false, reason });
  const model = choice.model === "default" && agent === "claude" ? null : choice.model;
  if (model !== null) {
    if (!startTakesModel(agent) || !isModelId(agent, model)) return refuse("That model is not one this agent names.");
    if (!listedModels(agent, models).some((one) => one.id === model)) return refuse("That model is not in the agent's list on this machine.");
  }
  const effort = choice.effort;
  if (effort !== null) {
    if (!startTakesEffort(agent) || !effortPattern.test(effort)) return refuse("That effort is not one this agent takes at start.");
    if (!effortChoices(agent, models, model).levels.includes(effort)) return refuse("That model does not take that effort.");
  }
  const flags: StartFlag[] = [];
  switch (agent) {
    case "claude":
      if (model !== null) flags.push({ flag: "--model", value: model });
      if (effort !== null) flags.push({ flag: "--effort", value: effort });
      break;
    case "codex":
      if (model !== null) flags.push({ flag: "-m", value: model });
      if (effort !== null) flags.push({ flag: "-c", value: `model_reasoning_effort=${effort}` });
      break;
    case "grok":
      if (model !== null) flags.push({ flag: "-m", value: model });
      if (effort !== null) flags.push({ flag: "--reasoning-effort", value: effort });
      break;
    case "cursor":
      if (model !== null) flags.push({ flag: "--model", value: model });
      break;
    case "opencode":
      if (model !== null) flags.push({ flag: "-m", value: model });
      break;
    case "agy":
      break;
  }
  return { ok: true, flags };
}

/** A word Herdr's agent.start may carry as it is: plain characters, `~` only after a `/` (never expanded by a shell). */
const plainWord = /^(?!~)(?:[A-Za-z0-9._/:=@+,-]|(?<=\/)~){1,256}$/;

export function isPlainWord(word: string): boolean {
  return plainWord.test(word);
}

/** The flags as argv words (agent.start's args). */
export function flagWords(flags: readonly StartFlag[]): string[] {
  return flags.flatMap((one) => [one.flag, one.value]);
}

/** One word for a shell line, single-quoted. */
export function quoteWord(word: string): string {
  return `'${word.split("'").join(`'"'"'`)}'`;
}

/** The flags as typed after a start command: each value single-quoted (`--model 'opus' --effort 'high'`). */
export function typedFlags(flags: readonly StartFlag[]): string {
  return flags.map((one) => `${one.flag} ${quoteWord(one.value)}`).join(" ");
}

/** Each agent's start flags and what their value is (a model, a level, Codex's effort setting). */
const startFlagKinds: Readonly<Record<Exclude<CatalogAgent, "agy">, Readonly<Record<string, "model" | "effort" | "codex-effort">>>> = {
  claude: { "--model": "model", "--effort": "effort" },
  codex: { "-m": "model", "-c": "codex-effort" },
  grok: { "-m": "model", "--reasoning-effort": "effort" },
  cursor: { "--model": "model" },
  opencode: { "-m": "model" },
};

/**
 * herdr-core's agent.start (core-actions.ts): Herdr's start args checked word by word, as the shell line's words after
 * `exec <kind>`: first the fixed words Adari's start gives (`fixed`, Codex's --no-daemon), then pairs of the kind's own
 * flags and a value of their pattern, each value single-quoted. Null when any word is not so (nothing is typed).
 */
export function coreStartWords(kind: string, fixed: readonly string[], args: readonly string[]): string[] | null {
  const out: string[] = [];
  let at = 0;
  const left = [...fixed];
  while (at < args.length && left.includes(args[at]!)) {
    left.splice(left.indexOf(args[at]!), 1);
    out.push(args[at]!);
    at += 1;
  }
  if (at === args.length) return out;
  if (!isCatalogAgentKind(kind)) return null;
  const flags = startFlagKinds[kind];
  for (; at < args.length; at += 2) {
    const flag = args[at]!;
    const value = args[at + 1];
    const what = Object.hasOwn(flags, flag) ? flags[flag] : undefined;
    if (what === undefined || value === undefined || !isPlainWord(value)) return null;
    const fits = what === "model" ? isModelId(kind, value) : what === "effort" ? effortPattern.test(value) : /^model_reasoning_effort=[a-z]{1,16}$/.test(value);
    if (!fits) return null;
    out.push(`${flag} ${quoteWord(value)}`);
  }
  return out;
}

const isCatalogAgentKind = (kind: string): kind is Exclude<CatalogAgent, "agy"> => Object.hasOwn(startFlagKinds, kind);

// MARK: - live picks

/**
 * The agents whose model a live pick sets by a typed command.
 * Cursor Agent's `/model <words>` filters its own list by family names and takes no id.
 * Grok Build 1.0.77 takes `/model <id>` (an id `grok models` lists:
 * "Switched to Grok 4.6 (low effort)", and it becomes Grok's default for new sessions); Cursor Agent 2026.11.11 takes
 * `/model <family name>` and switches at once to the first family the words match, keeping that family's remembered
 * variant. A Cursor pick names a catalog id; main types its family's name (never a family whose name is inside
 * another's). OpenCode's is its own sequence in main (IPC.openCodePick), never a typed `/model`.
 */
export const modelPickAgents = ["claude", "codex", "grok", "cursor"] as const;
export type ModelPickAgent = (typeof modelPickAgents)[number];

/**
 * A live model pick as the page asks main for it: the agent, the model (its id in the
 * agent's list; Claude Code's `default` too) and the effort (Codex's level; null for the others, and for Codex the
 * model's default). Never a finished command: main builds that (modelPickCommand) from the machine's list.
 */
export interface ModelPick {
  readonly agent: ModelPickAgent;
  readonly model: string;
  readonly effort: string | null;
}

/** A model pick as it crosses to main: these three fields only, each of its pattern. */
export function isModelPick(value: unknown): value is ModelPick {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => key !== "agent" && key !== "model" && key !== "effort")) return false;
  const agent = v["agent"];
  if (typeof agent !== "string" || !(modelPickAgents as readonly string[]).includes(agent)) return false;
  return typeof v["model"] === "string" && isModelId(agent as ModelPickAgent, v["model"]) && (v["effort"] === null || (typeof v["effort"] === "string" && effortPattern.test(v["effort"])));
}

export type BuiltPick = { readonly ok: true; readonly command: string } | { readonly ok: false; readonly reason: string };

/**
 * The one place a live model pick's command is made, in main from the machine's list (the
 * page uses the same to show and copy it): Claude Code `/model <value>` (a model its list names, or `default`; no
 * effort: its Effort chip types `/effort`); Codex `/model <slug> --reasoning=<level>`, the level one of that model's
 * own (the agent's where its entry names none; null: the model's default); Grok `/model <id>`, Cursor
 * `/model <family name>` (cursorFamilies: never a family whose name is inside another's). Anything else (OpenCode's)
 * is refused with why.
 */
export function modelPickCommand(pick: ModelPick, models: readonly CatalogModel[]): BuiltPick {
  const refuse = (reason: string): BuiltPick => ({ ok: false, reason });
  // Only the agents a live pick names (the type says so; a value from the page is checked here too).
  if (!(modelPickAgents as readonly string[]).includes(pick.agent)) return refuse("this agent's model is chosen in its own list.");
  if (!isModelId(pick.agent, pick.model)) return refuse("that model is not one this agent names.");
  if (pick.effort !== null && !effortPattern.test(pick.effort)) return refuse("that effort is not one this agent takes.");
  const listed = pick.model === "default" && pick.agent === "claude" ? true : models.some((model) => model.id === pick.model);
  if (!listed) return refuse("that model is not in the agent's list on this machine.");
  switch (pick.agent) {
    case "claude":
      return pick.effort === null ? { ok: true, command: `/model ${pick.model}` } : refuse("that model's effort is not set with its model here.");
    case "grok":
      // The id as `grok models` lists it (checked above); its effort stays the Effort chip's.
      return pick.effort === null ? { ok: true, command: `/model ${pick.model}` } : refuse("that model's effort is not set with its model here.");
    case "cursor": {
      // The family's name as Cursor's list names it, never a family Cursor would read as another.
      if (pick.effort !== null) return refuse("that model's effort is not set with its model here.");
      const family = cursorFamilyOf(models, pick.model);
      if (family === null) return refuse("that model is not in the agent's list on this machine.");
      if (family.terminalOnly !== null) return refuse(`${family.name} is chosen in Cursor's own list (its name is inside another family's).`);
      return { ok: true, command: `/model ${family.name}` };
    }
    case "codex": {
      const choices = effortChoices("codex", models, pick.model);
      const level = pick.effort ?? choices.defaultLevel;
      if (level === null) return refuse("that model needs an effort level.");
      if (!choices.levels.includes(level)) return refuse("that model does not take that effort.");
      return { ok: true, command: `/model ${pick.model} --reasoning=${level}` };
    }
  }
}

/**
 * The pick a live model choice makes, or null when the agent takes none by name: Claude Code
 * the model alone; Codex the model with the level it keeps (fallbackEffort of the effort now: its own default when it
 * lacks that level); Grok its id alone, Cursor a catalog id (main types its family's name; a family
 * Cursor would read as another gives none: its row opens Cursor's own list). OpenCode's goes as its own sequence
 * (IPC.openCodePick): none here.
 */
export function liveModelPick(agent: CatalogAgent, models: readonly CatalogModel[], modelId: string, effortNow: string | null): ModelPick | null {
  if (agent !== "claude" && agent !== "codex" && agent !== "grok" && agent !== "cursor") return null;
  const effort = agent === "codex" ? fallbackEffort(effortChoices("codex", models, modelId), effortNow) : null;
  const pick: ModelPick = { agent, model: modelId, effort };
  return modelPickCommand(pick, models).ok ? pick : null;
}

/** The command `liveModelPick` would have main type (null: none), as the page shows and copies it. */
export function liveModelCommand(agent: CatalogAgent, models: readonly CatalogModel[], modelId: string, effortNow: string | null): string | null {
  const pick = liveModelPick(agent, models, modelId, effortNow);
  if (pick === null) return null;
  const built = modelPickCommand(pick, models);
  return built.ok ? built.command : null;
}

/** Whether a live model pick is confirmed by what the pane now reads (the transcript's model; Cursor takes none). */
export function liveModelConfirmed(agent: CatalogAgent, models: readonly CatalogModel[], modelId: string, running: RunningModel): boolean {
  switch (agent) {
    case "claude": {
      const picked = claudeModelOf(models, modelId);
      const target = picked?.resolves ?? modelId;
      if (running.id !== null && (running.id === target || running.id === modelId)) return true;
      // "Set model to Opus 5.5": the label Claude Code confirms with.
      const label = modelId === "default" ? (picked?.note ?? null) : (picked?.label ?? null);
      return label !== null && running.label !== null && sameName(running.label, label);
    }
    case "codex":
      return running.id === modelId;
    case "grok": {
      // The id in its summary.json, or the label Grok shows for it.
      if (running.id === modelId) return true;
      const label = models.find((model) => model.id === modelId)?.label ?? null;
      return label !== null && running.label !== null && sameName(running.label, label);
    }
    case "cursor": {
      // The footer's family is the picked id's family.
      const family = cursorFamilyOf(models, modelId);
      return family !== null && running.label !== null && sameCursorFamily(running.label, family.name);
    }
    case "opencode":
    case "agy":
      return false;
  }
}
