// The Model and Effort chips in the message box's
// row, right after the agent (`Claude · Opus 5.5 · High · folder · machine`),
// for a Claude or Codex pane only. Each opens a small
// menu at the chip, T3 Code style, the current value ticked; a pick goes as
// its own command (agent-picks.ts), never into the box.
//
// A Cursor pane's chips show its footer (`Grok 4.7`,
// `Medium · Fast`) and only while one reads; its Effort menu is T3 Code's
// traits menu: Effort, then Context, then Fast, the current ones ticked; its
// Model opens Cursor's own selector in the Terminal (as Codex's picker does).
//
// The Model chip opens the model picker
// (ModelPicker.tsx: the agent's own list on the pane's machine, searchable,
// favourites, the current model ticked); a pick goes as the agent's own
// `/model …` line (Claude Code, Codex), made in main from the machine's
// list (IPC.modelPick, model-choices.ts modelPickCommand). The Effort menu
// and the commands resolve against the model and effort a pick not yet
// confirmed names, else the transcript's. Grok's and OpenCode's list shows read only, with the way
// to their own picker.
//
// Cursor's too, as Grok's: its `/model <words>` filters its own list by family
// names and takes no id (it answers `Models matching "claude-haiku-5-5-medium" (no matches)`, the model
// unchanged), so its list shows for reference, the footer's model ticked, and "Choose in the Terminal…" opens its
// own `/model` list there.
//
// A row picks on a running Grok, Cursor or OpenCode
// pane. Grok: `/model <id>` made in main (Grok also makes it its default for new sessions: the menu's one quiet
// line). Cursor: one row per family as Cursor's own list names it; main types `/model <family name>`; a family whose
// name is inside another's opens Cursor's own list in the Terminal instead (its title says so); another family on
// the footer after the pick is said in the line ("Cursor chose …"). OpenCode: the display names (the id small), and
// main drives OpenCode's own list (IPC.openCodePick). "Choose in the Terminal…" stays. The Effort menu lists the levels the current model takes,
// its own default marked. Before the agent says its model, the chips show New
// agent's choice, else "Default" (agent-picks.ts chip). An OpenCode pane gets
// the Model chip only.
//
// The Permissions chip after them, for a Claude, Codex, Grok
// or Cursor pane (shown even while Model and Effort wait for their values):
// T3 Code's ComposerContextPermissions, the mode's icon and the agent's own
// word ("Permissions" and a plain shield while none reads); its menu lists the
// agent's modes, each with its icon and description, the current one ticked
// (Claude's bypass only while it is on, greyed: nothing reaches it). Opening
// the menu never types; a pick goes to main (agent-picks.ts pickMode).

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { HostView } from "../../shared/ipc-contract";
import type { SidebarRow } from "../../shared/sidebar-model";
import {
  cursorEffortChip,
  cursorEffortLabel,
  cursorEfforts,
  cursorWindows,
  effortLabel,
  grokEfforts,
  grokWindowWord,
  grokWindows,
  type AgentSettings,
  type ChipKind,
  type CursorFooter,
} from "../../shared/agent-settings";
import { approvalMode, menuModes, type ModeAgent, type ModeIcon as ModeIconKind } from "../../shared/approval-modes";
import {
  claudeModelOf,
  cursorCurrentId,
  cursorEffortChoices,
  cursorFamilies,
  cursorFamilyName,
  cursorFamilyOf,
  currentModelId,
  defaultNote,
  effortChoices,
  listedModels,
  liveModelPick,
  modelPickCommand,
  withRunningModel,
  type EffortChoices,
  type ModelPick,
  type RunningModel,
} from "../../shared/model-choices";
import { catalogAgentNames, claudePickNote, type CatalogAgent, type CatalogModel, type CatalogView } from "../../shared/model-catalog";
import { favouriteModels, toggleFavourite, type PrefsStorage } from "../../shared/model-prefs";
import { CheckIcon, ChevronDownIcon, ModeIcon } from "../icons";
import { agentPicks, pickContext, type PickContext, type PickRequest } from "./agent-picks";
import { draftKey } from "./composer-drafts";
import { useEscapeOwner } from "./escape-owners";
import { modelCatalogStore } from "./model-catalog-store";
import { ModelPicker } from "./ModelPicker";

export interface ChipMenuItem {
  readonly label: string;
  readonly ticked: boolean;
  /** Shown greyed, with why. */
  readonly disabledReason?: string;
  /** A line under the menu's items (what the levels depend on). */
  readonly pick: PickRequest | null;
  /** The group this item starts, its header shown above it ("Effort", "Context", "Fast"). */
  readonly group?: string;
  /** The mode's icon and its line under the word (the Permissions menu). */
  readonly icon?: ModeIconKind;
  readonly description?: string;
  /** A word at the item's right ("default": the model's own level). */
  readonly tag?: string;
}

/** This window's localStorage (the pickers' favourites), or null where it is not allowed. */
export function prefsStorage(): PrefsStorage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

/**
 * The Permissions menu: the agent's own modes in its order, the current one ticked; Claude's bypass
 * only while on, greyed; while it is on, every other mode is greyed too (read-only).
 */
export function modeMenu(agent: ModeAgent, current: string | null): ChipMenuItem[] {
  const shown = approvalMode(agent, current);
  const readOnly = shown !== null && !shown.offered;
  const items: ChipMenuItem[] = menuModes(agent).map((mode) => ({
    label: mode.label,
    ticked: current === mode.id,
    icon: mode.icon,
    description: mode.description,
    ...(readOnly ? { disabledReason: "It was started with bypass permissions; Shift+Tab does not leave it" } : {}),
    pick: { kind: "mode", value: mode.id, label: mode.label },
  }));
  if (shown !== null && !shown.offered) {
    items.push({ label: shown.label, ticked: true, icon: shown.icon, description: shown.description, disabledReason: "It was started this way; the menu cannot switch to it", pick: null });
  }
  return items.map((item, index) => (index === 0 ? { ...item, group: "Permissions" } : item));
}

/** A Cursor pane's menus, from its footer. Effort's items carry `effort:<level>`, `context:<window>`, `fast:on|off`. */
export function cursorMenu(kind: ChipKind, footer: CursorFooter, choices: EffortChoices | null = null): ChipMenuItem[] {
  if (kind === "model") {
    return [
      { label: footer.model, ticked: true, disabledReason: "Cursor's models are in its own selector", pick: null },
      { label: "Choose in the Terminal\u{2026}", ticked: false, pick: { kind: "model", value: "picker", label: "Choosing\u{2026}" } },
    ];
  }
  // Only the levels the catalog lists a variant of for the footer's model, its default marked.
  const offered = choices === null ? cursorEfforts : cursorEfforts.filter((level) => choices.levels.includes(level));
  const efforts = (offered.length === 0 ? cursorEfforts : offered).map((level, index): ChipMenuItem => ({
    label: cursorEffortLabel(level),
    ticked: footer.effort === level,
    pick: { kind: "effort", value: `effort:${level}`, label: cursorEffortChip({ ...footer, effort: level }) },
    ...(index === 0 ? { group: "Effort" } : {}),
    ...(choices?.defaultLevel === level ? { tag: "default" } : {}),
  }));
  const windows = cursorWindows.map((window, index): ChipMenuItem => ({
    label: window,
    ticked: footer.window === window,
    ...(footer.window === null ? { disabledReason: "Cursor's footer shows no window" } : {}),
    pick: { kind: "effort", value: `context:${window}`, label: cursorEffortChip(footer) },
    ...(index === 0 ? { group: "Context" } : {}),
  }));
  const fast: ChipMenuItem = {
    label: "Fast",
    ticked: footer.fast,
    pick: { kind: "effort", value: footer.fast ? "fast:off" : "fast:on", label: cursorEffortChip({ ...footer, fast: !footer.fast }) },
    group: "Fast",
  };
  return [...efforts, ...windows, fast];
}

/** A Grok pane's menus: Model opens Grok's own list; Effort is Effort, then Context, ticked by its files. */
export function grokMenu(kind: ChipKind, settings: AgentSettings): ChipMenuItem[] {
  if (kind === "model") {
    return [
      { label: settings.modelLabel ?? "Not known yet", ticked: settings.modelLabel !== null, disabledReason: "Grok's models are in its own list", pick: null },
      { label: "Choose in the Terminal\u{2026}", ticked: false, pick: { kind: "model", value: "picker", label: "Choosing\u{2026}" } },
    ];
  }
  const window = grokWindowWord(settings.window);
  const efforts = grokEfforts.map((level, index): ChipMenuItem => ({
    label: effortLabel(level),
    ticked: settings.effort === level,
    pick: { kind: "effort", value: `effort:${level}`, label: effortLabel(level) },
    ...(index === 0 ? { group: "Effort" } : {}),
  }));
  const windows = grokWindows.map((word, index): ChipMenuItem => ({
    label: word.toUpperCase(),
    ticked: window === word,
    pick: { kind: "effort", value: `context:${word}`, label: effortLabel(settings.effort) },
    ...(index === 0 ? { group: "Context" } : {}),
  }));
  return [...efforts, ...windows];
}

/** The pane's agent as its catalog names it (every agent with chips has one). */
const catalogAgentOfContext = (context: PickContext): CatalogAgent => context.agent;

/** What the pane runs, as the picker reads it: the transcript, Cursor's footer, Grok's files. */
export function runningModel(context: PickContext, key: string, models: readonly CatalogModel[]): RunningModel {
  if (context.agent === "cursor") {
    const footer = agentPicks.cursorFooter(key, context.binding);
    if (footer !== null) return { id: cursorCurrentId(models, footer), label: footer.model };
    // The model line read after a pick (no effort word): its family.
    const line = agentPicks.cursorModelLine(key, context.binding);
    return { id: null, label: line?.family ?? null };
  }
  // OpenCode's as its footer named it after a pick here (nothing else reads it).
  if (context.agent === "opencode") {
    const seen = agentPicks.openCodeModel(key, context.binding);
    return seen === null ? { id: null, label: null } : { id: seen.model, label: seen.label };
  }
  const settings = agentPicks.settings(key, context.binding);
  return { id: settings.model, label: settings.modelLabel };
}

/** The Model chip's picker for the pane: its rows, the ticked one, "Agent's default", read only or not, its action. */
export interface ChipPickerSpec {
  readonly agent: CatalogAgent;
  readonly models: readonly CatalogModel[];
  readonly current: string | null;
  /** null: no such row (Cursor's families: Auto is one of them). */
  readonly defaultRow: { readonly ticked: boolean; readonly note: string | null; readonly disabledReason?: string } | null;
  readonly readOnly: string | null;
  /** The menu's one quiet line over rows that pick (Grok's, Claude Code's), or null. */
  readonly note: string | null;
  /** Rows named as the agent's own list names them, no id beside (Cursor's families). */
  readonly hideIds: boolean;
  /** Grok and Cursor: its own list in the Terminal (`/model`); OpenCode: the Terminal shown. */
  readonly action: "terminal-pick" | "show-terminal" | null;
}

/** Why a row of the Model menu made no pick (the list it was checked against does not take it). */
export function rowRefusedText(agent: CatalogAgent, view: CatalogView | null): string {
  const name = catalogAgentNames[agent];
  if (view === null || view.loading) return `Not set: ${name}'s list on this machine is still being read. Pick again once it shows.`;
  return `Not set: ${name}'s list on this machine does not name that model the way a pick here needs. Choose it in ${name}'s own list.`;
}

/** Grok's Model menu's line: a pick there is also Grok's default for new sessions (grok-03: "✓ Default model"). */
export const grokDefaultNote = "Grok also makes this its default for new sessions.";

/**
 * Cursor's catalog as the running pane's rows: one per family, named as Cursor's list names it, its first
 * id the row's; a family Cursor would read as another (or that cannot be typed) carries why as its title.
 */
export function cursorFamilyRows(models: readonly CatalogModel[]): CatalogModel[] {
  return cursorFamilies(models).map((family) => ({
    id: family.id,
    label: family.name,
    group: null,
    efforts: [],
    defaultEffort: null,
    isDefault: family.name.toLowerCase() === "auto",
    ...(family.terminalOnly === null ? {} : { note: family.terminalOnly }),
  }));
}

export function chipPickerSpec(context: PickContext, key: string, view: CatalogView | null): ChipPickerSpec {
  const agent = catalogAgentOfContext(context);
  const all = view?.models ?? [];
  const listed = listedModels(agent, all);
  const running = runningModel(context, key, listed);
  const start = agentPicks.startShown(key, context.binding);
  const nothingSaid = running.id === null && running.label === null;
  if (agent === "cursor") {
    // One row per family; the footer's family ticked (else New agent's choice's), a pick on its way first.
    const models = cursorFamilyRows(all);
    const named = running.label ?? (start?.model == null ? null : (all.find((model) => model.id === start.model)?.label ?? null));
    let current = named === null ? null : (models.find((row) => row.label.toLowerCase() === cursorFamilyName(named).toLowerCase())?.id ?? null);
    const pending = agentPicks.effective(key, context.binding).model;
    if (pending !== null && models.some((row) => row.id === pending)) current = pending;
    return { agent, models, current, defaultRow: null, readOnly: null, note: null, hideIds: true, action: "terminal-pick" };
  }
  const models = withRunningModel(agent, listed, running);
  let current = currentModelId(agent, models, running);
  // A model picked and not yet confirmed is the one ticked (Grok's too).
  if (agent === "claude" || agent === "codex" || agent === "grok") {
    const pending = agentPicks.effective(key, context.binding).model;
    if (pending !== null && pending !== agentPicks.settings(key, context.binding).model && models.some((model) => model.id === pending)) current = pending;
  }
  if (current === null && nothingSaid && start?.model !== null && start?.model !== undefined && models.some((model) => model.id === start.model)) current = start.model;
  const ticked = nothingSaid && (start === null || start.model === null);
  const note = defaultNote(agent, all);
  const defaultRow =
    agent === "codex"
      ? { ticked, note, disabledReason: "Codex's default is the one in its config; pick a model by name" }
      : { ticked, note };
  // Grok's and OpenCode's rows pick; Grok's line says it also becomes its default for new sessions.
  // Claude Code's `/model` also changes its default for new sessions; the picker says so.
  const action = agent === "grok" ? "terminal-pick" : agent === "opencode" ? "show-terminal" : null;
  const pickNote = agent === "grok" ? grokDefaultNote : agent === "claude" ? claudePickNote : null;
  return { agent, models, current, defaultRow, readOnly: null, note: pickNote, hideIds: false, action };
}

/**
 * A picked model as its pick: the agent's own `/model …` line and what confirms it (null: the
 * agent takes no model by name here). `id` null is the agent's default (Claude Code's `default`);
 * Cursor's none (its `/model` takes no id; its list is read only, as Grok's).
 */
export function modelPickRequest(agent: CatalogAgent, models: readonly CatalogModel[], id: string | null, effortNow: string | null): PickRequest | null {
  // The structured pick main checks and makes its line from; the line here only to show and copy.
  const named = (value: string): { readonly modelPick: ModelPick; readonly command: string } | null => {
    const modelPick = liveModelPick(agent, models, value, effortNow);
    const built = modelPick === null ? null : modelPickCommand(modelPick, models);
    return modelPick === null || built === null || !built.ok ? null : { modelPick, command: built.command };
  };
  switch (agent) {
    case "claude": {
      const value = id ?? "default";
      const pick = named(value);
      if (pick === null) return null;
      const model = claudeModelOf(models, value);
      const label = value === "default" ? (model?.note ?? "Default") : (model?.label ?? value);
      const ids = [model?.resolves, value].filter((one): one is string => one !== undefined && one !== "default");
      return { kind: "model", value, label, ...pick, expect: { ids, labels: [label] } };
    }
    case "codex": {
      if (id === null) return null;
      const pick = named(id);
      const model = models.find((one) => one.id === id);
      if (pick === null || model === undefined) return null;
      // The chip shows the slug, as the transcript names it once confirmed (no case change on the way).
      return { kind: "model", value: id, label: id, ...pick, expect: { ids: [id], labels: [model.label] } };
    }
    case "grok": {
      // `/model <id>` made in main; confirmed when Grok's files (or its label) name it.
      if (id === null) return null;
      const pick = named(id);
      const model = models.find((one) => one.id === id);
      if (pick === null || model === undefined) return null;
      return { kind: "model", value: id, label: model.label, ...pick, expect: { ids: [id], labels: [model.label] } };
    }
    case "cursor": {
      // The family's name typed in main; a family Cursor would read as another gives none (its row opens
      // Cursor's own list instead: AgentChips).
      if (id === null) return null;
      const family = cursorFamilyOf(models, id);
      const pick = named(id);
      if (pick === null || family === null) return null;
      return { kind: "model", value: id, label: family.name, ...pick, expect: { ids: [], labels: [family.name] } };
    }
    case "opencode": {
      // Only the id goes; main makes every key of the pick from the machine's list.
      if (id === null) return null;
      const model = models.find((one) => one.id === id);
      return model === undefined ? null : { kind: "model", value: id, label: model.label, openCodeModel: id };
    }
    case "agy":
      return null;
  }
}

/**
 * What a row of the running pane's picker asks for: its model pick (modelPickRequest); a Cursor family
 * that is never typed (its title says why) opens Cursor's own list in the Terminal, as "Choose in the Terminal…" does.
 */
export function chipRowRequest(spec: ChipPickerSpec, view: CatalogView | null, id: string | null, effortNow: string | null): PickRequest | null {
  if (spec.agent === "cursor") {
    if (id !== null && spec.models.find((row) => row.id === id)?.note !== undefined) return { kind: "model", value: "picker", label: "Choosing\u{2026}" };
    return modelPickRequest("cursor", view?.models ?? [], id, effortNow);
  }
  return modelPickRequest(spec.agent, [...spec.models, ...(view?.models ?? [])], id, effortNow);
}

/** The Effort menu's levels for the pane's current model (its catalog, or the agent's list). */
export function effortMenuChoices(context: PickContext, key: string, view: CatalogView | null): EffortChoices {
  const models = view?.models ?? [];
  if (context.agent === "cursor") {
    const footer = agentPicks.cursorFooter(key, context.binding);
    return footer === null ? effortChoices("cursor", models, null) : cursorEffortChoices(models, footer.model);
  }
  const settings = agentPicks.settings(key, context.binding);
  const start = agentPicks.startShown(key, context.binding);
  // The model a pick not yet confirmed names first, else the transcript's.
  const effective = agentPicks.effective(key, context.binding).model;
  const modelId = effective ?? (settings.modelLabel === null ? (start?.model ?? null) : null);
  if (context.agent === "claude" && modelId === null && settings.modelLabel !== null) {
    // A `/model` result names only a label ("Opus 5.5"): the catalog's row of that name.
    const named = models.find((model) => model.label.toLowerCase() === settings.modelLabel!.toLowerCase());
    return effortChoices("claude", models, named?.id ?? null);
  }
  return effortChoices(catalogAgentOfContext(context), models, modelId);
}

/** The menus' items for the pane as shown (Effort's; Model's is the picker). */
export function chipMenu(kind: ChipKind, context: PickContext, key: string, view: CatalogView | null = null): ChipMenuItem[] {
  if (context.agent === "cursor") {
    const footer = agentPicks.cursorFooter(key, context.binding);
    return footer === null ? [] : cursorMenu(kind, footer, kind === "effort" ? effortMenuChoices(context, key, view) : null);
  }
  const settings = agentPicks.settings(key, context.binding);
  if (context.agent === "grok") return grokMenu(kind, settings);
  if (context.agent === "opencode" || kind !== "effort") return [];
  const choices = effortMenuChoices(context, key, view);
  if (choices.levels.length === 0) return [{ label: "This model takes no effort level", ticked: false, pick: null, disabledReason: "Its effort is fixed" }];
  // Ticked and named by the model and effort as picks not yet confirmed leave them.
  const effective = agentPicks.effective(key, context.binding);
  return choices.levels.map((level) => {
    const plain: PickRequest = { kind: "effort", value: level, label: effortLabel(level) };
    const item = { label: effortLabel(level), ticked: effective.effort === level, ...(choices.defaultLevel === level ? { tag: "default" } : {}) };
    if (context.agent !== "codex") return { ...item, pick: plain };
    // Codex's Effort names its model (`/model <slug> --reasoning=<level>`): a model pick main checks and makes.
    if (effective.model === null) return { ...item, disabledReason: "Codex's model is not known yet", pick: plain };
    const modelPick: ModelPick = { agent: "codex", model: effective.model, effort: level };
    const built = modelPickCommand(modelPick, view?.models ?? []);
    if (!built.ok) {
      const reading = (view === null || view.loading) && (view?.models.length ?? 0) === 0;
      return { ...item, disabledReason: reading ? "Reading Codex's models\u{2026}" : "Codex's list on this machine does not name this model", pick: plain };
    }
    return { ...item, pick: { ...plain, modelPick, command: built.command } };
  });
}

export function ChipMenu({ items, onPick, onClose }: { items: readonly ChipMenuItem[]; onPick(pick: PickRequest): void; onClose(): void }) {
  useEscapeOwner();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof window.addEventListener !== "function") return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (ref.current !== null && target !== null && !ref.current.parentElement?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const close = (): void => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);
  return (
    <div className={items.some((item) => item.icon !== undefined) ? "ctx chip-menu modes" : "ctx chip-menu"} ref={ref} role="menu">
      {items.map((item) => {
        const disabled = item.disabledReason !== undefined || item.pick === null;
        const button = (
          <button
            key={`${item.group ?? ""}${item.label}`}
            role="menuitemradio"
            aria-checked={item.ticked}
            className={disabled ? "ctx-i off" : "ctx-i"}
            aria-disabled={disabled}
            title={item.disabledReason}
            onClick={() => {
              if (disabled || item.pick === null) return;
              onClose();
              onPick(item.pick);
            }}
          >
            <span className="tk">{item.ticked ? <CheckIcon size={13} /> : null}</span>
            {item.icon === undefined ? null : (
              <span className="mi" data-mode-icon={item.icon}>
                <ModeIcon icon={item.icon} size={14} />
              </span>
            )}
            <span className="l">
              {item.label}
              {item.description === undefined ? null : <span className="ds">{item.description}</span>}
              {item.disabledReason === undefined ? null : <span className="why">{item.disabledReason}</span>}
            </span>
            {item.tag === undefined ? null : <span className="k">{item.tag}</span>}
          </button>
        );
        return item.group === undefined
          ? button
          : [
              <div key={`g-${item.group}`} className="chip-g" role="presentation">
                {item.group}
              </div>,
              button,
            ];
      })}
    </div>
  );
}

/** The two chips for the pane, or nothing (another agent, a shell). `onShowTerminal`: Codex's picker shows there. */
export function AgentChips({ host, row, onShowTerminal }: { host: HostView; row: SidebarRow; onShowTerminal?: () => void }) {
  useSyncExternalStore(agentPicks.subscribe, agentPicks.version);
  useSyncExternalStore(modelCatalogStore.subscribe, modelCatalogStore.version);
  const key = draftKey(host.id, row.paneID);
  const [open, setOpen] = useState<ChipKind | null>(null);
  // The stars for this machine and agent, read when the picker opens.
  const [favourites, setFavourites] = useState<ReadonlySet<string>>(() => new Set());
  // Codex's picker: its tile shows the Terminal only while this box still shows that pane.
  const shown = useRef<string | null>(key);
  shown.current = key;
  useEffect(() => () => {
    shown.current = null;
  }, []);
  const context = row.isAgent ? pickContext(host, row.paneID) : null;
  const agent = context === null ? null : catalogAgentOfContext(context);
  // A sent pick shows until the transcript confirms it, or for 10 s: then the transcript's value again.
  const expiry = agentPicks.nextExpiry(key);
  useEffect(() => {
    if (expiry === null) return;
    const timer = setTimeout(() => agentPicks.sync(key, pickContext(host, row.paneID)), Math.max(0, expiry - Date.now()) + 25);
    return () => clearTimeout(timer);
  }, [expiry, key, host, row.paneID]);
  useEffect(() => setOpen(null), [key]);
  // The Model menu's not-sent line shows until the next pick, or until a menu that showed it closes.
  useEffect(() => {
    if (open !== "model") return;
    agentPicks.modelMenuOpened(key);
    return () => agentPicks.modelMenuClosed(key);
  }, [open, key]);
  // The machine's list for the agent, asked for when the picker or the Effort menu opens (not before).
  useEffect(() => {
    if (agent === null || (open !== "model" && open !== "effort")) return;
    modelCatalogStore.load(host.id, agent);
    if (open === "model") setFavourites(favouriteModels(prefsStorage(), host.id, agent));
  }, [open, agent, host.id]);
  if (context === null || agent === null) return null;
  const view = modelCatalogStore.view(host.id, agent);
  // A Cursor pane's Effort chip only while its footer reads (nothing guessed).
  // A Grok pane's only while its summary.json names its model and effort.
  // The Model chip always (New agent's choice or "Default" until the agent says); OpenCode's alone.
  // The Permissions chip stays (it says "Permissions" while no mode reads).
  let effortChip = context.agent !== "opencode";
  if (context.agent === "cursor" && agentPicks.cursorFooter(key, context.binding) === null) effortChip = false;
  if (context.agent === "grok") {
    const settings = agentPicks.settings(key, context.binding);
    if (settings.modelLabel === null || settings.effort === null) effortChip = false;
  }
  const showTerminal =
    onShowTerminal === undefined
      ? null
      : () => {
          if (shown.current === key) onShowTerminal();
        };
  const pick = (request: PickRequest): void => agentPicks.pick(context, request, request.value === "picker" ? showTerminal : null);
  const chipButton = (kind: ChipKind) => {
    const view = agentPicks.chip(key, kind, context.binding);
    const name = kind === "model" ? "Model" : "Effort";
    return (
      <button
        className="pick-b"
        aria-haspopup={kind === "model" ? "dialog" : "menu"}
        aria-expanded={open === kind}
        aria-label={`${name}: ${view.label}${view.next ? " (next turn)" : ""}`}
        title={view.next ? `${name}: ${view.label} from the next turn (the agent is busy now)` : (view.title ?? `${name}: ${view.label}`)}
        onClick={() => setOpen(open === kind ? null : kind)}
      >
        <span className="ct">{view.label}</span>
        {view.next ? <span className="nx">next turn</span> : null}
        <ChevronDownIcon size={11} />
      </button>
    );
  };
  const chipClass = (kind: ChipKind): string => {
    const view = agentPicks.chip(key, kind, context.binding);
    return `chip pick ${kind}${view.next ? " next" : ""}${open === kind ? " open" : ""}`;
  };
  const modelChip = () => {
    const spec = chipPickerSpec(context, key, view);
    // The effort as picks not yet confirmed leave it (Codex's model pick keeps it when it can).
    const effortNow = agentPicks.effective(key, context.binding).effort ?? agentPicks.startShown(key, context.binding)?.effort ?? null;
    const action =
      spec.action === "terminal-pick"
        ? { label: "Choose in the Terminal\u{2026}", run: () => pick({ kind: "model", value: "picker", label: "Choosing\u{2026}" }) }
        : spec.action === "show-terminal" && showTerminal !== null
          ? { label: "Show the Terminal", run: showTerminal }
          : null;
    return (
      <span key="model" className={chipClass("model")}>
        {chipButton("model")}
        {open === "model" ? (
          <ModelPicker
            agent={spec.agent}
            view={view}
            models={spec.models}
            current={spec.current}
            defaultRow={spec.defaultRow}
            favourites={favourites}
            onToggleFavourite={(id) => setFavourites(toggleFavourite(prefsStorage(), host.id, spec.agent, id))}
            readOnly={spec.readOnly}
            note={spec.note}
            notice={agentPicks.modelNotSent(key, context.binding)}
            hideIds={spec.hideIds}
            action={action}
            onClose={() => setOpen(null)}
            onPick={(id) => {
              const request = chipRowRequest(spec, view, id, effortNow);
              // A row shown either picks or says why not.
              if (request !== null) pick(request);
              else agentPicks.refuseModel(context, rowRefusedText(spec.agent, view));
            }}
          />
        ) : null}
      </span>
    );
  };
  const effortChipView = () => (
    <span key="effort" className={chipClass("effort")}>
      {chipButton("effort")}
      {open === "effort" ? <ChipMenu items={chipMenu("effort", context, key, view)} onClose={() => setOpen(null)} onPick={pick} /> : null}
    </span>
  );
  // The Permissions chip: the mode's icon and word, its menu the agent's own modes.
  const modeChip = (modeAgent: ModeAgent) => {
    const view = agentPicks.modeChip(key, context.binding, modeAgent);
    const said = `${view.label}${view.next ? " (next turn)" : ""}`;
    const title = view.next
      ? `Permissions: ${view.label} from the next turn (the agent is busy now)`
      : view.warning
        ? `Permissions: ${view.label} is on: the last pick stopped there (it allows more than the one picked)`
        : view.mode === null
        ? "Permissions: the agent's mode is not known yet"
        : `Permissions: ${view.label}${view.description === null ? "" : ` \u2014 ${view.description}`}`;
    return (
      <span key="mode" className={`chip pick mode${view.next ? " next" : ""}${view.warning ? " warn" : ""}${open === "mode" ? " open" : ""}`}>
        <button className="pick-b" aria-haspopup="menu" aria-expanded={open === "mode"} aria-label={`Permissions: ${said}`} title={title} onClick={() => setOpen(open === "mode" ? null : "mode")}>
          <span className="mi" data-mode-icon={view.icon}>
            <ModeIcon icon={view.icon} size={13} />
          </span>
          <span className="ct">{view.label}</span>
          {view.next ? <span className="nx">next turn</span> : null}
          <span className="cv">
            <ChevronDownIcon size={11} />
          </span>
        </button>
        {open === "mode" ? <ChipMenu items={modeMenu(modeAgent, agentPicks.mode(key, context.binding))} onClose={() => setOpen(null)} onPick={(pick) => agentPicks.pick(context, pick)} /> : null}
      </span>
    );
  };
  return (
    <>
      {modelChip()}
      {effortChip ? effortChipView() : null}
      {context.agent === "opencode" ? null : modeChip(context.agent)}
    </>
  );
}
