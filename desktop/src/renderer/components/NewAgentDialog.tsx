// New agent (a dialog over its scrim):
// the workspace (every answering machine's), the folder on that Mac (the
// workspace's own, with the folders its panes are in as suggestions), and
// the kind: every agent that machine's Herdr can start (each
// with its glyph; any other kind the Mac's agents.json names; Claude Code
// runs "cl" there), or a shell. Return starts it, Escape
// cancels; ↑ ↓ change the kind. The new pane opens selected: Chat for an
// agent, the terminal for a shell. Nothing is sent to the agent. Where it
// opens: a new tab, or a split right or down of the focused
// pane when the workspace is its own (refused with a note when its tab
// already shows 4 panes).
//
// The folder is the workspace's unless you
// change it: "Starts in <folder>" with Change…, which opens the folder field
// that lists the folders under what you type on that machine
// (folder-browse.tsx; Choose… on This Mac) with the workspace's pane folders
// as rows. A workspace with no folder opens with the field.
//
// Model and Effort for an agent with a
// model list (Claude Code, Codex, Grok, Cursor, OpenCode): "Agent's default"
// for each at first (no flag), else the last choice for that machine and
// agent. Model opens the same picker as the Model chip; Effort lists the
// levels the chosen model takes, its default marked, and falls back to that
// model's default when a model without the chosen level is picked. The list is
// asked for only when you open either (or a remembered choice needs it); main
// checks the choice against it again before anything is made.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { NewAgentResult, NewAgentWhere } from "../../main/herdr/new-agent";
import { splitRefusal } from "../../shared/pane-layout";
import {
  defaultPlace,
  lastKind,
  newAgentKinds,
  newAgentNote,
  placeKey,
  rememberKind,
  type KindStorage,
  type NewAgentPlace,
  type NewAgentSplitTarget,
  type NewAgentWhereChoice,
} from "../../shared/new-agent";
import { handoffStore } from "../handoff/handoff-state";
import { CloseIcon, FolderIcon, SplitIcon, TerminalIcon } from "../icons";
import { AgentGlyph, agentName, ChatEarlyBadge } from "./agent-kind";
import { chooseButton, folderList, useFolderBrowse, type FolderCalls } from "./folder-browse";
import { startCommandsStore } from "./resume";
import { useEscapeOwner } from "./escape-owners";
import { agentPicks } from "./agent-picks";
import { modelCatalogStore } from "./model-catalog-store";
import { ModelPicker } from "./ModelPicker";
import { antigravityNoList, catalogAgentOf, type CatalogAgent } from "../../shared/model-catalog";
import { defaultNote, effortChoices, fallbackEffort, listedModels, startChipLabel, startTakesEffort, startTakesModel, type StartChoice } from "../../shared/model-choices";
import { favouriteModels, lastStartChoice, rememberStartChoice, toggleFavourite } from "../../shared/model-prefs";
import { effortLabel } from "../../shared/agent-settings";

export interface NewAgentDialogProps {
  readonly places: readonly NewAgentPlace[];
  /** The workspace it opens for (⌘N: the selected pane's; a header's +: that one). */
  readonly wanted: { readonly hostId: string; readonly workspaceId: string } | null;
  readonly storage: KindStorage | null;
  /** The focused pane a split goes beside (null: no pane shown). */
  readonly splitTarget?: NewAgentSplitTarget | null;
  /** Where it opens set to (a tile's split menu: right or down). */
  readonly initialWhere?: NewAgentWhereChoice;
  /** The folder it opens with (a new workspace's Start an agent in it), else the workspace's own. */
  readonly initialFolder?: string;
  /** Opens for exactly `wanted` (a new workspace's Start an agent in it): refused while it is not there, never another. */
  readonly exact?: boolean;
  /** The folder field's list and This Mac's Choose… (absent: a plain field). */
  readonly folders?: FolderCalls | null;
  /** `models`, the Model and Effort chosen (absent, or both null: the agent's defaults). */
  start(place: NewAgentPlace, folder: string | null, kind: string, where: NewAgentWhere, models?: StartChoice): Promise<NewAgentResult>;
  onStarted(place: NewAgentPlace, result: NewAgentResult): void;
  onClose(): void;
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

type Phase = { readonly type: "editing" } | { readonly type: "working" } | { readonly type: "failed"; readonly message: string };

const whereChoices: readonly { readonly value: NewAgentWhereChoice; readonly title: string }[] = [
  { value: "tab", title: "New tab" },
  { value: "right", title: "Split right" },
  { value: "down", title: "Split down" },
];

export function NewAgentDialog({ places, wanted, storage, splitTarget = null, initialWhere = "tab", initialFolder, exact = false, folders = null, start, onStarted, onClose }: NewAgentDialogProps) {
  useEscapeOwner();
  const [key, setKey] = useState<string | null>(() => {
    if (exact && wanted !== null) return placeKey(wanted);
    const first = defaultPlace(places, wanted);
    return first === null ? null : placeKey(first);
  });
  const place = places.find((candidate) => placeKey(candidate) === key) ?? null;
  const [folder, setFolder] = useState(() => initialFolder ?? place?.folder ?? "");
  // "Starts in …" until Change… (or no folder to start in): then the field.
  const [changing, setChanging] = useState(() => (initialFolder ?? place?.folder ?? "").trim() === "");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // The keys (Return, ↑ ↓, Esc) are the dialog's while no field has focus.
    if (!changing) dialogRef.current?.focus();
  }, []);
  const [kind, setKind] = useState(() => lastKind(storage));
  const [phase, setPhase] = useState<Phase>({ type: "editing" });
  const [whereChoice, setWhereChoice] = useState<NewAgentWhereChoice>(initialWhere);
  // Closed (Escape, Cancel): a start still under way opens nothing.
  const closed = useRef(false);
  // The Model and Effort chosen per machine and agent this time (else the last remembered).
  const [modelChoices, setModelChoices] = useState<Readonly<Record<string, StartChoice>>>({});
  const [modelOpen, setModelOpen] = useState(false);
  const [modelFavourites, setModelFavourites] = useState<ReadonlySet<string>>(() => new Set());
  useSyncExternalStore(modelCatalogStore.subscribe, modelCatalogStore.version);

  const connection = place === null ? 0 : handoffStore.life.connection(place.hostId);
  const commands = useSyncExternalStore(startCommandsStore.subscribe, () =>
    place === null ? null : startCommandsStore.get(place.hostId, connection),
  );
  useEffect(() => {
    if (place !== null) startCommandsStore.load(window.herdrDesktop, place.hostId, connection);
  }, [place?.hostId, connection]);

  const kinds = useMemo(() => newAgentKinds(commands, place?.workspaceId ?? null), [commands, place?.workspaceId]);
  const choice = kinds.find((candidate) => candidate.kind === kind) ?? kinds[0]!;
  // The list scrolls; the kind picked (↑ ↓, or the one kept) stays in view.
  const kindList = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    kindList.current?.querySelector(".na-kind.on")?.scrollIntoView({ block: "nearest" });
  }, [choice.kind]);
  // A split only beside the focused pane, in its own workspace, while its tab shows fewer than 4.
  const target = splitTarget !== null && place !== null && place.hostId === splitTarget.hostId && place.workspaceId === splitTarget.workspaceId ? splitTarget : null;
  const refusal = target === null ? null : splitRefusal(target.tabPanes);
  const where: NewAgentWhereChoice = target === null || refusal !== null ? "tab" : whereChoice;
  // A split is bound to the pane as the window showed it when the dialog opened.
  const request: NewAgentWhere =
    where === "tab" || target === null ? { type: "tab" } : { type: "split", direction: where, targetPaneId: target.paneId, binding: target.binding };

  // The chosen agent's Model and Effort on this machine.
  const catalogAgent: CatalogAgent | null = choice.kind === "shell" ? null : catalogAgentOf(choice.kind);
  const choiceKey = place === null || catalogAgent === null ? null : `${place.hostId}|${catalogAgent}`;
  const catalog = place === null || catalogAgent === null ? null : modelCatalogStore.view(place.hostId, catalogAgent);
  const catalogModels = catalog?.models ?? [];
  const listed = catalogAgent === null ? [] : listedModels(catalogAgent, catalogModels);
  const remembered = choiceKey === null || place === null || catalogAgent === null ? { model: null, effort: null } : (modelChoices[choiceKey] ?? lastStartChoice(storage, place.hostId, catalogAgent));
  // A remembered model the machine's list no longer names (once it has been read) is the agent's default again.
  const listRead = catalog !== null && catalog.models.length > 0;
  const chosenModel = remembered.model !== null && (!listRead || listed.some((model) => model.id === remembered.model)) ? remembered.model : null;
  const levels = catalogAgent === null || !startTakesEffort(catalogAgent) ? null : effortChoices(catalogAgent, catalogModels, chosenModel);
  const chosenEffort = levels === null || remembered.effort === null ? null : listRead ? fallbackEffort(levels, remembered.effort) : remembered.effort;
  const chosen: StartChoice = { model: chosenModel, effort: chosenEffort };
  const chosenLabel = chosenModel === null ? "Agent's default" : (listed.find((model) => model.id === chosenModel)?.label ?? chosenModel);
  // The list is asked for when a remembered choice needs checking, or when you open Model or Effort.
  const needsList = remembered.model !== null || remembered.effort !== null;
  const loadList = (): void => {
    if (place !== null && catalogAgent !== null && catalogAgent !== "agy") modelCatalogStore.load(place.hostId, catalogAgent);
  };
  useEffect(() => {
    if (needsList && catalog === null) loadList();
    setModelOpen(false);
  }, [choiceKey]);
  const setChoice = (next: StartChoice): void => {
    if (choiceKey !== null) setModelChoices({ ...modelChoices, [choiceKey]: next });
  };
  const pickModel = (id: string | null): void => {
    if (catalogAgent === null) return;
    // T3 Code's rule: the chosen level stays when the new model takes it, else that model's default.
    const effort = levels === null ? null : fallbackEffort(effortChoices(catalogAgent, catalogModels, id), chosen.effort);
    setChoice({ model: id, effort });
  };

  const browse = useFolderBrowse({
    calls: folders,
    hostId: place?.hostId ?? null,
    machine: place?.hostName ?? "the machine",
    local: place?.local === true,
    offline: place === null,
    folder,
    setFolder,
    disabled: phase.type === "working",
  });

  const close = (): void => {
    closed.current = true;
    onClose();
  };

  const go = (): void => {
    if (place === null || phase.type === "working") return;
    setPhase({ type: "working" });
    rememberKind(storage, choice.kind);
    if (catalogAgent !== null && catalogAgent !== "agy") rememberStartChoice(storage, place.hostId, catalogAgent, chosen);
    const trimmed = folder.trim();
    const models = catalogAgent === null || catalogAgent === "agy" ? undefined : chosen;
    start(place, trimmed === "" ? null : trimmed, choice.kind, request, models).then(
      (result) => {
        if (closed.current) return;
        // The new pane's chips say the choice at once, until the agent says its own.
        if (models !== undefined && result.start.type !== "noAgent" && result.start.type !== "shell") {
          agentPicks.noteStart(place.hostId, result.paneId, { kind: result.kind, model: models.model, modelLabel: models.model === null || catalogAgent === null ? null : startChipLabel(catalogAgent, catalogModels, models.model), effort: models.effort });
        }
        onStarted(place, result);
      },
      (failure: unknown) => {
        if (!closed.current) setPhase({ type: "failed", message: message(failure) });
      },
    );
  };

  const move = (delta: number): void => {
    const index = kinds.findIndex((candidate) => candidate.kind === choice.kind);
    const next = kinds[Math.max(0, Math.min(kinds.length - 1, index + delta))]!;
    setKind(next.kind);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // The model picker's own keys while it is open (Esc closes it, not the dialog).
    if (modelOpen) return;
    // The folder list's keys first while it is open (Esc closes it; a second Esc closes the dialog).
    if (!event.nativeEvent.isComposing && browse.key(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      // A focused button (Cancel, a suggestion) does its own thing.
      const target = event.target as { tagName?: string } | null;
      if (target?.tagName === "BUTTON" || target?.tagName === "SELECT") return;
      event.preventDefault();
      go();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const target = event.target as { tagName?: string } | null;
      if (target?.tagName === "SELECT") return;
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    }
  };

  const working = phase.type === "working";
  const note =
    phase.type === "failed"
      ? `Not started: ${phase.message}`
      : working
        ? `Starting ${choice.kind === "shell" ? "a shell" : choice.title}…`
        : place === null
          ? exact
            ? "That workspace is not available now."
            : "No machine is answering."
          : refusal !== null
            ? `${refusal} ${newAgentNote(choice, place, folder)}`
            : target !== null && where !== "tab"
              ? `Beside ${target.name}, ${where === "right" ? "to the right" : "below"}: ${newAgentNote(choice, place, folder)}`
              : newAgentNote(choice, place, folder);
  const title = place === null ? "New agent" : `New agent in ${place.workspace}`;

  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="dlg na" role="dialog" aria-label={title} tabIndex={-1} ref={dialogRef} onKeyDown={onKeyDown}>
        <div className="dt">
          {title}
          <span className="sp" />
          <button className="ib" onClick={close} title="Close" aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="fld">
          <div className="lb">Workspace</div>
          <select
            className="inp"
            value={place === null ? "" : (key ?? "")}
            disabled={working || places.length === 0}
            aria-label="Workspace"
            onChange={(event) => {
              const next = places.find((candidate) => placeKey(candidate) === event.target.value) ?? null;
              setKey(next === null ? null : placeKey(next));
              setFolder(next?.folder ?? "");
              setChanging((next?.folder ?? "") === "");
            }}
          >
            {place === null && exact ? <option value="">Not available</option> : null}
            {places.map((candidate) => (
              <option key={placeKey(candidate)} value={placeKey(candidate)}>
                {candidate.hostName} · {candidate.workspace}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <div className="lb">Agent</div>
          <div className="na-kinds" role="radiogroup" aria-label="Agent" ref={kindList}>
            {kinds.map((candidate) => (
              <button
                key={candidate.kind}
                className={candidate.kind === choice.kind ? "na-kind on" : "na-kind"}
                role="radio"
                aria-checked={candidate.kind === choice.kind}
                data-kind={candidate.kind}
                disabled={working}
                onClick={() => setKind(candidate.kind)}
              >
                {/* The icon titled with the agent's name. */}
                <span className="ic" title={candidate.kind === "shell" ? "Shell" : agentName(candidate.kind)}>
                  {candidate.kind === "shell" ? <TerminalIcon size={14} /> : <AgentGlyph kind={candidate.kind} size={16} />}
                </span>
                <span className="t">
                  {candidate.title}
                  {candidate.kind === "shell" ? null : <ChatEarlyBadge kind={candidate.kind} />}
                </span>
                <span className="d">{candidate.detail}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="fld">
          <div className="lb">Where</div>
          <div className="na-where" role="radiogroup" aria-label="Where">
            {whereChoices
              .filter((candidate) => candidate.value === "tab" || target !== null)
              .map((candidate) => (
                <button
                  key={candidate.value}
                  className={candidate.value === where ? "on" : ""}
                  role="radio"
                  aria-checked={candidate.value === where}
                  data-where={candidate.value}
                  disabled={working || (candidate.value !== "tab" && refusal !== null)}
                  title={candidate.value === "tab" ? "A new tab in the workspace" : (refusal ?? `${candidate.title} beside ${target?.name ?? "the focused pane"}`)}
                  onClick={() => setWhereChoice(candidate.value)}
                >
                  {candidate.value === "tab" ? null : <SplitIcon size={13} />}
                  {candidate.title}
                </button>
              ))}
          </div>
        </div>
        {catalogAgent === null ? null : (
          <div className="fld na-models">
            <div className="lb">{levels === null ? "Model" : "Model and effort"}</div>
            {catalogAgent === "agy" || !startTakesModel(catalogAgent) ? (
              <div className="na-mnote">{antigravityNoList}</div>
            ) : (
              <div className="na-mrow">
                <div className="na-mwrap">
                  <button
                    type="button"
                    className={modelOpen ? "inp na-model open" : "inp na-model"}
                    aria-haspopup="dialog"
                    aria-expanded={modelOpen}
                    aria-label={`Model: ${chosenLabel}`}
                    data-model={chosenModel ?? ""}
                    disabled={working || place === null}
                    title={chosenModel === null ? "The agent starts with its own default model" : chosenModel}
                    onClick={() => {
                      if (modelOpen) {
                        setModelOpen(false);
                        return;
                      }
                      loadList();
                      if (place !== null) setModelFavourites(favouriteModels(storage, place.hostId, catalogAgent));
                      setModelOpen(true);
                    }}
                  >
                    <span className="t">{chosenLabel}</span>
                    {chosenModel === null && defaultNote(catalogAgent, catalogModels) !== null ? <span className="d">{defaultNote(catalogAgent, catalogModels)}</span> : null}
                  </button>
                  {modelOpen && place !== null ? (
                    <ModelPicker
                      agent={catalogAgent}
                      view={catalog}
                      models={listed}
                      current={chosenModel}
                      defaultRow={{ ticked: chosenModel === null, note: defaultNote(catalogAgent, catalogModels) }}
                      favourites={modelFavourites}
                      onToggleFavourite={(id) => setModelFavourites(toggleFavourite(storage, place.hostId, catalogAgent, id))}
                      onClose={() => {
                        setModelOpen(false);
                        dialogRef.current?.focus();
                      }}
                      onPick={pickModel}
                      placement="below"
                    />
                  ) : null}
                </div>
                {levels === null ? null : (
                  <select
                    className="inp na-effort"
                    aria-label="Effort"
                    value={chosen.effort ?? ""}
                    disabled={working || place === null || levels.levels.length === 0}
                    onFocus={loadList}
                    onMouseDown={loadList}
                    onChange={(event) => setChoice({ model: chosen.model, effort: event.target.value === "" ? null : event.target.value })}
                  >
                    <option value="">{levels.levels.length === 0 ? "No effort level" : "Agent's default effort"}</option>
                    {levels.levels.map((level) => (
                      <option key={level} value={level}>
                        {level === levels.defaultLevel ? `${effortLabel(level)} (model default)` : effortLabel(level)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            {catalog?.error !== null && catalog?.error !== undefined && (modelOpen || chosen.model !== null) ? <div className="fb-note">{catalog.error}</div> : null}
          </div>
        )}
        {changing ? (
          <div className="fld">
            <div className="lb">
              Folder on {place?.hostName ?? "the Mac"} <span className="o">optional</span>
            </div>
            <div className="fb-wrap">
              <div className="key-pick">
                <input
                  className="inp mono"
                  value={folder}
                  placeholder={place?.local === true ? "~/code/project, or Choose…" : "Type a folder: / or ~/"}
                  aria-label="Folder"
                  aria-expanded={browse.open}
                  disabled={working}
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => browse.typed(event.target.value)}
                  onBlur={() => browse.close()}
                />
                {chooseButton(browse, working)}
              </div>
              {folderList(browse)}
            </div>
            {browse.chooseNote === null ? null : <div className="fb-note">{browse.chooseNote}</div>}
            {place !== null && place.suggestions.length > 0 ? (
              <div className="nw-recent na-recent">
                {place.suggestions.map((path) => (
                  <button
                    key={path}
                    className={path === folder.trim() ? "nw-row on" : "nw-row"}
                    title={path}
                    aria-label={`Folder ${path}`}
                    disabled={working}
                    onClick={() => {
                      browse.close();
                      setFolder(path);
                    }}
                  >
                    <FolderIcon size={14} />
                    <span className="nm">{path.split("/").filter((part) => part !== "").pop() ?? path}</span>
                    <span className="pa">{path}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="fld">
            <div className="na-in" data-folder={folder.trim()}>
              <FolderIcon size={14} />
              <span className="t">Starts in</span>
              <span className="pa" title={folder.trim()}>
                {folder.trim()}
              </span>
              <span className="dot">·</span>
              <button className="lnk" aria-label="Change the folder" disabled={working} onClick={() => setChanging(true)}>
                Change…
              </button>
            </div>
          </div>
        )}
        <div className="df">
          <span className={phase.type === "failed" ? "note err" : "note"} role="status">
            {note}
          </span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn pri" onClick={go} disabled={working || place === null}>
            Start <kbd>↩</kbd>
          </button>
        </div>
      </div>
    </>
  );
}
