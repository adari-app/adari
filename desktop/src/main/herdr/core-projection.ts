// herdr-core's terminals as the workspaces, tabs, panes and agents the app
// already shows (SessionTopology, AgentInfo), so the sidebar, the needs-you
// list, Chat and the box run unchanged (the Swift client's
// CoreProjection.swift).
//
// Groups: Herdr App's spaces and tabs (its `herdr-app` document, and the
// `herdr.space` / `herdr.tab` labels it puts on the terminals it starts);
// terminals in no space go to a group named after the machine; terminals on
// machines the core added (`studio/t7`) go under that machine.

import { isGrokSessionID, isValidSessionID } from "../../shared/chat/locator";
import { isCoreGeneration } from "../../shared/chat/core-folder-lookup";
import { coreFolderKinds, isAmbiguousSession } from "../../shared/chat/core-pane-session";
import { defaultWorkspaceName } from "../../shared/new-workspace";
import { uint64Max, wideInt, type WideInt } from "../../shared/wide-int";
import { coreJSONString } from "./core-json";
import { CoreIDs, CoreLayoutDocument, type CoreLayoutSpace, type CoreModel } from "./core-model";
import { coreMachineOf, isLive, type CoreMachineView, type CoreTerminal } from "./core-wire";
import type { AgentInfo, AgentSessionInfo, CoreFoundSession, SessionTopology, TabInfo, TopologyPaneInfo, WorkspaceInfo } from "./wire";
import { codexResumeArgvID } from "../../shared/codex-start";

/** Which agent runs in a terminal, from what runs in it now. */
export const CoreAgentKind = {
  /** The kinds the app knows by name. */
  known: ["claude", "codex", "grok", "cursor"] as readonly string[],

  /**
   * `claude`, `codex`, `grok` or `cursor`, from the foreground process (its name, argv[0], or for a script host
   * such as node the script it runs), then the program's 7501 `app`; undefined for anything else (a shell, vim).
   * A process is Cursor's agent by a name that starts with `cursor-agent`, or as `cursor agent` (the Cursor app's
   * launcher with `agent`); `cursor` alone is the editor. A bare `agent` is not Cursor's (Grok Build installs
   * `agent` too, a link to its binary beside `grok`, so on a Mac with both the `agent` on PATH can be Grok's), so
   * it is left to what else names the program.
   */
  detect(terminal: CoreTerminal): string | undefined {
    // Nothing runs in an ended terminal.
    if (terminal.state === "finished") return undefined;
    if (terminal.foreground !== undefined) {
      const kind = CoreAgentKind.detectProcess(terminal.foreground.name, terminal.foreground.argv);
      if (kind !== undefined) return kind;
    } else if (isLive(terminal) && terminal.pid !== undefined) {
      // No foreground read yet: what the terminal was started with.
      const kind = CoreAgentKind.detectProcess(undefined, terminal.argv);
      if (kind !== undefined) return kind;
    }
    const app = terminal.status?.app?.toLowerCase();
    if (app !== undefined) return CoreAgentKind.known.find((kind) => app === kind || app.startsWith(`${kind} `) || app.startsWith(`${kind}-`));
    return undefined;
  },

  detectProcess(name: string | undefined, argv: readonly string[]): string | undefined {
    const candidates: string[] = [];
    if (name !== undefined) candidates.push(name);
    const first = argv[0];
    if (first !== undefined) candidates.push(first);
    const hosts = new Set(["node", "bun", "deno", "python", "python3"]);
    if (first !== undefined && hosts.has(basename(first).toLowerCase())) {
      // `node /…/claude` or `node /…/@anthropic-ai/claude-code/cli.js`.
      const script = argv.slice(1).find((word) => !word.startsWith("-"));
      if (script !== undefined) {
        candidates.push(script);
        if (script.includes("claude-code")) return "claude";
        if (script.includes("/codex")) return "codex";
        if (script.toLowerCase().includes("/cursor-agent")) return "cursor";
      }
    }
    // `cursor agent …`: the Cursor app's launcher running its agent (`cursor` with anything else is the editor).
    if (first !== undefined && basename(first).toLowerCase() === "cursor" && argv[1] === "agent") return "cursor";
    for (const candidate of candidates) {
      const base = basename(candidate).toLowerCase();
      if (base.startsWith("cursor-agent")) return "cursor";
      for (const kind of CoreAgentKind.known) {
        if (kind !== "cursor" && (base === kind || base.startsWith(`${kind}-`) || base.startsWith(`${kind}.`))) return kind;
      }
    }
    return undefined;
  },

  /**
   * The agent session a terminal's argv names, when it names one: `claude --resume <id>` / `-r <id>` /
   * `--session-id <id>`, `codex resume <id>` (`--no-daemon` before or after the id), `grok -r <id>` / `--resume <id>`, `cursor agent --resume <id>` (or `cursor-agent`) /
   * `--resume=<id>`. Herdr App and herdr-core never name sessions; without one Chat says it has none, as it does
   * for a TUI pane without one.
   */
  session(terminal: CoreTerminal, kind: string): AgentSessionInfo | undefined {
    const argv = terminal.foreground?.argv ?? (isLive(terminal) ? terminal.argv : undefined);
    if (argv === undefined) return undefined;
    let id: string | undefined;
    switch (kind) {
      case "claude":
        argv.forEach((word, index) => {
          if (["--resume", "-r", "--session-id"].includes(word) && index + 1 < argv.length) id = argv[index + 1];
          else if (word.startsWith("--resume=") || word.startsWith("--session-id=")) id = word.slice(word.indexOf("=") + 1);
        });
        break;
      case "codex":
        // `--no-daemon` before or after the id (codex-start.ts codexResumeArgvID).
        id = codexResumeArgvID(argv) ?? undefined;
        break;
      case "grok":
        // `grok -r <id>`, `--resume <id>`, `--resume=<id>`; `--resume` also takes a title, which is no id.
        argv.forEach((word, index) => {
          if (["--resume", "-r"].includes(word) && index + 1 < argv.length) id = argv[index + 1];
          else if (word.startsWith("--resume=")) id = word.slice("--resume=".length);
        });
        if (id === undefined || !isGrokSessionID(id)) return undefined;
        break;
      case "cursor":
        // `cursor agent --resume <chat id>` (or `cursor-agent`), `--resume=<chat id>`; `--resume` alone opens a picker: no id.
        argv.forEach((word, index) => {
          if (word === "--resume" && index + 1 < argv.length) id = argv[index + 1];
          else if (word.startsWith("--resume=")) id = word.slice("--resume=".length);
        });
        if (id === undefined || !isGrokSessionID(id)) return undefined;
        break;
      default:
        return undefined;
    }
    if (id === undefined || !isValidSessionID(id)) return undefined;
    return { source: `herdr:${kind}`, agent: kind, kind: "id", value: id };
  },
};

function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.at(-1) ?? path;
}

/**
 * As the Swift client's CorePaneSession.Run: one run of a Claude or Codex agent in a herdr-core
 * terminal: the terminal (its address and `created_ms`) and the agent's process.
 */
export interface CorePaneRun {
  readonly address: string;
  readonly kind: string;
  readonly pid: number;
  readonly createdMs: WideInt;
}

export const CorePaneRuns = {
  /**
   * The run of a `kind` agent in `terminal`: its foreground process, else (no foreground read yet) the terminal's
   * own program. Undefined for an ended terminal, one with no process, or one on a machine the core added (its
   * transcripts are there). That process must itself be the agent, by its own name or argv;
   * a shell or another program in front of it is no run (the 7501 `app` alone never makes one).
   */
  of(terminal: CoreTerminal, kind: string): CorePaneRun | undefined {
    if (!coreFolderKinds.some((known) => known === kind) || !isLive(terminal) || coreMachineOf(terminal.address) !== undefined) return undefined;
    let pid: number;
    if (terminal.foreground !== undefined) {
      if (CoreAgentKind.detectProcess(terminal.foreground.name, terminal.foreground.argv) !== kind) return undefined;
      pid = terminal.foreground.pid;
    } else {
      if (terminal.pid === undefined || CoreAgentKind.detectProcess(undefined, terminal.argv) !== kind) return undefined;
      pid = terminal.pid;
    }
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return undefined;
    return { address: terminal.address, kind, pid, createdMs: terminal.createdMs };
  },

  /** What a found session carries (`foundBy`): `<kind>:<pid>:<created_ms>`. */
  key(run: CorePaneRun): string {
    return `${run.kind}:${run.pid}:${String(run.createdMs)}`;
  },

  same(a: CorePaneRun, b: CorePaneRun): boolean {
    return a.address === b.address && a.kind === b.kind && a.pid === b.pid && a.createdMs === b.createdMs;
  },

  /** Whether `marker` names this run whatever its process start: what a refusal, which names no transcript, is checked by. */
  marks(run: CorePaneRun, marker: string): boolean {
    const key = CorePaneRuns.key(run);
    return marker === key || (marker.startsWith(key + ":") && isCoreGeneration(marker.slice(key.length + 1)));
  },

  /** A found transcript is this run's own process: its key and exactly the start verified now; false with none. */
  owns(run: CorePaneRun, marker: string, generation: string | undefined): boolean {
    return generation !== undefined && isCoreGeneration(generation) && marker === CorePaneRuns.key(run) + ":" + generation;
  },

  /**
   * What the core shows of a session found for `terminal` (CoreProjection.session): never over a session the argv
   * names, only while the run it was found for is the terminal's (a new run never shows the last one's), and a
   * transcript only for the process start the finder verified (`generation`); a refusal for its run.
   */
  shown(terminal: CoreTerminal, kind: string, found: CoreFoundSession | undefined, generation: string | undefined): CoreFoundSession | undefined {
    if (found === undefined || CoreAgentKind.session(terminal, kind) !== undefined) return undefined;
    const run = CorePaneRuns.of(terminal, kind);
    if (run === undefined) return undefined;
    if (isAmbiguousSession(found)) return CorePaneRuns.marks(run, found.foundBy) ? found : undefined;
    return CorePaneRuns.owns(run, found.foundBy, generation) ? found : undefined;
  },
};

/** herdr-core's status words as the app's (`AgentStatus` wire values). */
export const CoreStatusMapping = {
  /**
   * The status the app shows for a live terminal: `blocked` and `error` need you (`blocked`); `working`;
   * `idle`, `done`: with a `herdr.seen` label, `done` when `turn > herdr.seen`, else `idle`; without it the
   * core's own word; no status: `unknown`; another word: as sent (the app places it fail-closed).
   */
  wire(terminal: CoreTerminal): string {
    const word = terminal.status?.state;
    if (word === undefined) return "unknown";
    switch (word) {
      case "blocked":
      case "error":
        return "blocked";
      case "working":
        return "working";
      case "idle":
      case "done": {
        const seen = CoreStatusMapping.seenTurn(terminal);
        if (seen !== undefined) return terminal.turn > seen ? "done" : "idle";
        return word;
      }
      default:
        return word;
    }
  },

  /** `herdr.seen=<turn>`, when present and a number. */
  seenTurn(terminal: CoreTerminal): WideInt | undefined {
    const label = terminal.labels["herdr.seen"];
    if (label === undefined) return undefined;
    const trimmed = label.replace(/^[ \t]+|[ \t]+$/g, "");
    if (!/^\d+$/.test(trimmed)) return undefined;
    const value = BigInt(trimmed);
    return value > uint64Max ? undefined : wideInt(value);
  },

  /** `herdr.pinned`: present and non-empty. */
  isPinned(terminal: CoreTerminal): boolean {
    return (terminal.labels["herdr.pinned"] ?? "") !== "";
  },

  /** The most urgent of a group's statuses (blocked > done > working > idle); `unknown` when none. */
  urgent(statuses: readonly string[]): string {
    for (const word of ["blocked", "done", "working", "idle"]) if (statuses.includes(word)) return word;
    return statuses.find((status) => status !== "unknown") ?? "unknown";
  },
};

export interface CoreProjectionInput {
  readonly model: CoreModel;
  /** Layout documents by machine ("" is this machine). */
  readonly documents?: ReadonlyMap<string, CoreLayoutDocument>;
  /** What this core calls itself (`hello.core.name`). */
  readonly machineName: string;
  readonly version?: string;
  /** Machines this core added, by name, with their line now. */
  readonly machines?: ReadonlyMap<string, CoreMachineView>;
  /** Sessions found by folder for terminals whose argv names none, by address (CoreSessionFinder). */
  readonly sessions?: ReadonlyMap<string, CoreFoundSession>;
  /** The agent process's start the finder verified for each found session, by address. */
  readonly generations?: ReadonlyMap<string, string>;
  /**
   * The line to this core is down (why): every terminal is shown as on an unreachable machine (status unknown,
   * the last one kept), as the TUI server shows a machine it lost.
   */
  readonly lineDown?: string;
}

/** What one core shows, in the app's types. */
export interface CoreProjection {
  readonly topology: SessionTopology;
  readonly agents: readonly AgentInfo[];
  /** Pane ids whose terminal carries `herdr.pinned` (shared with Herdr App). */
  readonly pinned: ReadonlySet<string>;
}

/** An ended terminal's title: how its program ended. */
export function endedTitle(terminal: CoreTerminal): string {
  switch (terminal.reason) {
    case "exited":
    case undefined:
      return terminal.exitCode === undefined ? "Exited" : `Exited (${terminal.exitCode})`;
    case "killed":
      return "Stopped";
    case "server_stop":
    case "stopped_by_restart":
      return "Ended: herdr-core stopped";
    case "host_shutdown":
      return "Ended: the machine shut down";
    default:
      return `Ended (${terminal.reason})`;
  }
}

/** Two projections show the same (Swift's Equatable). */
export function sameProjection(a: CoreProjection | null, b: CoreProjection | null): boolean {
  if (a === null || b === null) return a === b;
  return coreJSONString(a.topology) === coreJSONString(b.topology) && coreJSONString([...a.pinned].sort()) === coreJSONString([...b.pinned].sort());
}

interface Group {
  readonly id: string;
  readonly label: string;
  readonly tabs: { id: string; label: string }[];
  readonly panes: Map<string, CoreTerminal[]>;
}

function spaceLabel(space: CoreLayoutSpace): string {
  const name = space.name.trim();
  if (name !== "") return name;
  if (space.folder !== "") return defaultWorkspaceName(space.folder);
  return "Space";
}

export function projectCore(input: CoreProjectionInput): CoreProjection {
  const builder = new Builder(input);
  builder.build();
  return {
    topology: {
      version: input.version ?? "",
      protocolVersion: 0,
      workspaces: builder.workspaces,
      tabs: builder.tabs,
      panes: builder.panes,
      agents: builder.agents,
    },
    agents: builder.agents,
    pinned: builder.pinned,
  };
}

class Builder {
  readonly workspaces: WorkspaceInfo[] = [];
  readonly tabs: TabInfo[] = [];
  readonly panes: TopologyPaneInfo[] = [];
  readonly agents: AgentInfo[] = [];
  readonly pinned = new Set<string>();
  private readonly groups: Group[] = [];

  constructor(private readonly input: CoreProjectionInput) {}

  private document(machine: string): CoreLayoutDocument {
    return this.input.documents?.get(machine) ?? CoreLayoutDocument.empty;
  }

  build(): void {
    // Every terminal the core keeps, ended ones too: a finished terminal stays (an ended row, input refused)
    // until it is removed, as Herdr App keeps it; only `removed` drops it.
    const all = this.input.model.terminals;
    // This machine's spaces, in the document's order, each with its tabs.
    const local = this.document("");
    for (const space of local.spaces) this.ensureSpace(space, undefined);
    const remoteMachines: string[] = [];
    for (const terminal of all) {
      const machine = coreMachineOf(terminal.address);
      if (machine !== undefined) {
        if (!remoteMachines.includes(machine)) remoteMachines.push(machine);
        continue;
      }
      this.place(terminal, local);
    }
    for (const machine of [...remoteMachines].sort()) {
      const document = this.document(machine);
      for (const terminal of all) if (coreMachineOf(terminal.address) === machine) this.placeRemote(terminal, machine, document);
    }
    this.emit();
  }

  // MARK: - Placement

  private ensureSpace(space: CoreLayoutSpace, machine: string | undefined): void {
    const id = CoreIDs.space(space.id, machine);
    if (this.groups.some((group) => group.id === id)) return;
    const group: Group = { id, label: spaceLabel(space), tabs: [], panes: new Map() };
    space.tabs.forEach((tab, index) => group.tabs.push({ id: CoreIDs.tab(tab.id, machine), label: tab.name === "" ? `Tab ${index + 1}` : tab.name }));
    this.groups.push(group);
  }

  /** A local terminal: its labels' space and tab, else the document's layout, else the machine's own group. */
  private place(terminal: CoreTerminal, document: CoreLayoutDocument): void {
    const spaceID = terminal.labels["herdr.space"];
    if (spaceID !== undefined && spaceID !== "") {
      const space = document.space(spaceID) ?? { id: spaceID, name: "", folder: terminal.cwd, tabs: [] };
      this.ensureSpace(space, undefined);
      const labelTab = terminal.labels["herdr.tab"];
      const tabID = labelTab !== undefined && labelTab !== "" ? labelTab : (space.tabs[0]?.id ?? spaceID);
      this.add(terminal, CoreIDs.space(spaceID), CoreIDs.tab(tabID), terminal.name ?? "");
      return;
    }
    const placed = document.placement(terminal.address);
    if (placed !== undefined) {
      this.ensureSpace(placed.space, undefined);
      this.add(terminal, CoreIDs.space(placed.space.id), CoreIDs.tab(placed.tab.id), placed.tab.name);
      return;
    }
    const name = this.input.machineName;
    this.ensureGroup(CoreIDs.machineGroup(), name === "" ? "This Mac" : name);
    this.add(terminal, CoreIDs.machineGroup(), CoreIDs.machineTab(), name === "" ? "Terminals" : name);
  }

  /** A terminal on a machine this core added: under that machine, in its space and tab when that machine's document names them. */
  private placeRemote(terminal: CoreTerminal, machine: string, document: CoreLayoutDocument): void {
    const group = CoreIDs.machineGroup(machine);
    this.ensureGroup(group, machine);
    const local = terminal.address.slice(machine.length + 1);
    let spaceName: string | undefined;
    let tabName: string | undefined;
    let tabID: string | undefined;
    const labelSpace = terminal.labels["herdr.space"];
    const space = labelSpace === undefined ? undefined : document.space(labelSpace);
    if (space !== undefined) {
      spaceName = spaceLabel(space);
      const id = terminal.labels["herdr.tab"] ?? space.tabs[0]?.id;
      tabID = id;
      tabName = space.tabs.find((tab) => tab.id === id)?.name;
    } else {
      const placed = document.placement(local);
      if (placed !== undefined) {
        spaceName = spaceLabel(placed.space);
        tabID = placed.tab.id;
        tabName = placed.tab.name;
      }
    }
    if (spaceName !== undefined && tabID !== undefined) {
      const label = [spaceName, tabName].filter((part): part is string => part !== undefined && part !== "").join(" · ");
      this.add(terminal, group, CoreIDs.tab(tabID, machine), label);
    } else {
      this.add(terminal, group, CoreIDs.machineTab(machine), machine);
    }
  }

  private ensureGroup(id: string, label: string): void {
    if (this.groups.some((group) => group.id === id)) return;
    this.groups.push({ id, label, tabs: [], panes: new Map() });
  }

  private add(terminal: CoreTerminal, groupID: string, tab: string, newTabLabel: string): void {
    const group = this.groups.find((candidate) => candidate.id === groupID);
    if (group === undefined) return;
    if (!group.tabs.some((candidate) => candidate.id === tab)) {
      group.tabs.push({ id: tab, label: newTabLabel === "" ? `Tab ${group.tabs.length + 1}` : newTabLabel });
    }
    const list = group.panes.get(tab);
    if (list === undefined) group.panes.set(tab, [terminal]);
    else list.push(terminal);
  }

  // MARK: - Output

  private emit(): void {
    let number = 0;
    for (const group of this.groups) {
      const groupPanes = group.tabs.flatMap((tab) => group.panes.get(tab.id) ?? []);
      // A space from the document with nothing live in it is still a space (Herdr App shows it); the machine
      // groups only exist for their terminals.
      if (groupPanes.length === 0 && CoreIDs.spaceID(group.id) === undefined) continue;
      number += 1;
      const groupStatuses: string[] = [];
      group.tabs.forEach((tab, tabIndex) => {
        const members = group.panes.get(tab.id) ?? [];
        const tabStatuses = members.map((terminal) => this.emitPane(terminal, group.id, tab.id));
        groupStatuses.push(...tabStatuses);
        this.tabs.push({
          tabID: tab.id,
          workspaceID: group.id,
          number: tabIndex + 1,
          label: tab.label,
          focused: false,
          paneCount: members.length,
          agentStatus: CoreStatusMapping.urgent(tabStatuses),
        });
      });
      this.workspaces.push({
        workspaceID: group.id,
        number,
        label: group.label,
        focused: false,
        paneCount: groupPanes.length,
        tabCount: group.tabs.length,
        activeTabID: group.tabs[0]?.id ?? "",
        agentStatus: CoreStatusMapping.urgent(groupStatuses),
      });
    }
  }

  /** One pane (and its agent entry when an agent runs in it). Returns its status. */
  private emitPane(terminal: CoreTerminal, workspaceID: string, tabID: string): string {
    const paneID = CoreIDs.pane(terminal.address);
    const kind = CoreAgentKind.detect(terminal);
    let status = CoreStatusMapping.wire(terminal);
    const machine = coreMachineOf(terminal.address);
    let reachability: string | undefined;
    let lastKnown: string | undefined;
    if (this.input.lineDown !== undefined) {
      reachability = "unreachable";
    } else if (machine !== undefined) {
      const state = this.input.machines?.get(machine)?.state;
      reachability = state === undefined ? undefined : state === "connected" ? "reachable" : state === "connecting" ? "degraded" : "unreachable";
    }
    if (reachability === "degraded" || reachability === "unreachable") {
      lastKnown = status;
      status = "unknown";
    }
    const revision = this.input.model.revisions.get(terminal.address) ?? this.input.model.seq;
    const ended = terminal.state === "finished";
    if (ended) {
      status = "unknown";
      lastKnown = undefined;
    }
    const title = ended ? endedTitle(terminal) : terminal.title === "" ? undefined : terminal.title;
    const display = kind === undefined ? undefined : kind.slice(0, 1).toUpperCase() + kind.slice(1);
    if (CoreStatusMapping.isPinned(terminal)) this.pinned.add(paneID);
    this.panes.push(
      clean<TopologyPaneInfo>({
        paneID,
        terminalID: paneID,
        workspaceID,
        tabID,
        focused: false,
        cwd: terminal.cwd,
        foregroundCWD: terminal.foreground?.cwd,
        label: terminal.name,
        agent: kind,
        title,
        terminalTitleStripped: title,
        displayAgent: display,
        agentStatus: status,
        revision,
      }),
    );
    if (kind === undefined) return status;
    const word = terminal.status?.state;
    // Ready: it says idle or done; or it never reports status (no signal to wait for; terminal.send waits for
    // quiet itself).
    const ready = word === "idle" || word === "done" || (word === undefined && !terminal.reported);
    // The session the argv names (herdr-core names none), and a Claude or Codex
    // pane's found by folder beside it, for its run and verified process start only (CorePaneRuns.shown).
    const session = CoreAgentKind.session(terminal, kind);
    const supplied = this.input.sessions?.get(terminal.address);
    const coreFound = CorePaneRuns.shown(terminal, kind, supplied, this.input.generations?.get(terminal.address));
    this.agents.push(
      clean<AgentInfo>({
        agent: kind,
        agentStatus: status,
        inputPending: word === "blocked" ? true : undefined,
        inputPromptKind: terminal.status?.kind,
        name: terminal.name,
        paneID,
        tabID,
        workspaceID,
        terminalID: paneID,
        terminalTitleStripped: title,
        cwd: terminal.foreground?.cwd ?? terminal.cwd,
        focused: false,
        interactiveReady: ready,
        revision,
        stateChangeSeq: revision,
        statusSinceUnixMs: terminal.statusMs,
        turn: terminal.turn,
        completionSeq: terminal.turn,
        agentSession: session,
        coreFound,
        machineID: machine ?? (this.input.lineDown !== undefined ? this.input.machineName : undefined),
        reachability,
        lastKnownStatus: lastKnown,
      }),
    );
    return status;
  }
}

/** The record without its undefined members (a nil field is left out, as the server does). */
function clean<T extends object>(record: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value;
  return out as T;
}
