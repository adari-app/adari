// Pane life (App/CompanionPaneLife.swift): what the app saw of
// each pane across the snapshots it was given. Kept in the page for the
// window's life, per machine route (the host id and the address it reaches,
// so a host edited to reach another machine never shows the first one's
// panes) and pane:
//
// - the arrivals: one more each time a snapshot shows an agent in a pane the
//   snapshot before showed without one (a start after an exit, a resume that
//   keeps its session id). A hand-off pick is bound to the arrival it saw;
// - the connection generation per machine: one more each time a machine
//   answers again after it stopped (connecting or offline), so a pick taken on
//   the connection before is refused;
// - the agent that last ran in each pane (its kind, its terminal and the last
//   session Herdr reported), so a pane whose agent left offers the Resume
//   chip: it fills `cl --resume <id>` (Claude, with the Mac's start command)
//   or `codex resume <id>`, never runs it.

import type { AgentInfo, AgentSessionInfo, SessionTopology, TopologyPaneInfo } from "../main/herdr/wire";
import { isCursorStorePath } from "./chat/cursor-store";
import { isGrokSessionID, isValidSessionID } from "./chat/locator";
import { commandFor, cursorAgentCommand, plainCommandRefusal, startCommandsDisplayPath, type AgentStartCommands } from "./start-commands";
import { codexResumeLine } from "./codex-start";

export { plainCommandRefusal } from "./start-commands";

/** What the page remembers of the agent that last ran in a pane. */
export interface PaneAgentMemory {
  /** Herdr's kind ("claude", "codex", …), lowercased. */
  readonly kind: string;
  /** "Claude", "Codex", or Herdr's display name. */
  readonly title: string;
  /** The pane's terminal it ran in. */
  readonly terminalID: string;
  /** The last session Herdr reported for it (null: none yet). */
  readonly session: AgentSessionInfo | null;
  /**
   * For a Grok run Herdr names no session for, the session Chat followed for
   * the pane in this run (its id; null or absent: none). A new run starts without one.
   */
  readonly followed?: string | null;
}

/** The Grok session Chat follows for a pane, with the terminal its agent runs in. */
export interface FollowedSession {
  readonly terminalID: string;
  readonly session: string;
}

/** The kinds New agent and Resume know by name. */
export const knownAgentTitles: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex" };

/** "Claude", "Codex", or the name Herdr shows for another kind. */
export function agentTitle(kind: string, display: string | undefined): string {
  const known = knownAgentTitles[kind];
  if (known !== undefined) return known;
  if (display !== undefined && display !== "") return display;
  return kind.slice(0, 1).toUpperCase() + kind.slice(1);
}

/** What pane life needs of a machine (HostView has it). */
export interface PaneLifeHost {
  readonly id: string;
  readonly address: string;
  readonly state: "connecting" | "connected" | "offline";
  readonly topology: SessionTopology | null;
}

/** The machine's route: its id and the address it reaches. */
export function routeOf(host: Pick<PaneLifeHost, "id" | "address">): string {
  return `${host.id}|${host.address}`;
}

/** The agent `snapshot` lists in `pane` (not archived), if any. */
export function agentIn(pane: Pick<TopologyPaneInfo, "paneID">, snapshot: SessionTopology): AgentInfo | null {
  return snapshot.agents.find((agent) => agent.paneID === pane.paneID && agent.archived === undefined) ?? null;
}

/** An agent runs in the pane: its agent entry, or the pane's own agent field. */
export function runsAgentIn(pane: TopologyPaneInfo, snapshot: SessionTopology): boolean {
  return agentIn(pane, snapshot) !== null || (pane.agent !== undefined && pane.agent !== "");
}

const paneKey = (route: string, paneID: string): string => `${route}\u0000${paneID}`;

export class PaneLife {
  private readonly arrivals = new Map<string, number>();
  private readonly running = new Map<string, boolean>();
  /** route → the panes' keys seen on it (to drop a route at once). */
  private readonly routes = new Map<string, Set<string>>();
  private readonly connections = new Map<string, number>();
  private readonly live = new Map<string, boolean>();
  private readonly memories = new Map<string, PaneAgentMemory>();

  /** Takes in every machine as the page has it now; a machine no longer listed is forgotten. */
  observeHosts(hosts: readonly PaneLifeHost[]): void {
    const listed = new Set(hosts.map(routeOf));
    for (const route of this.routes.keys()) {
      if (!listed.has(route)) this.dropRoute(route);
    }
    const ids = new Set(hosts.map((host) => host.id));
    for (const id of this.connections.keys()) {
      if (!ids.has(id)) {
        this.connections.delete(id);
        this.live.delete(id);
      }
    }
    for (const host of hosts) this.observe(host);
  }

  /** One machine as the page has it now. */
  observe(host: PaneLifeHost): void {
    const route = routeOf(host);
    // The host's other routes (it was edited): forgotten.
    for (const other of this.routes.keys()) {
      if (other !== route && other.startsWith(`${host.id}|`)) this.dropRoute(other);
    }
    const connected = host.state === "connected" && host.topology !== null;
    if (connected && this.live.get(host.id) !== true) this.connections.set(host.id, (this.connections.get(host.id) ?? 0) + 1);
    this.live.set(host.id, connected);
    if (!connected || host.topology === null) return;
    this.observeSnapshot(route, host.topology);
  }

  /** A whole snapshot of the machine `route` reaches. */
  private observeSnapshot(route: string, snapshot: SessionTopology): void {
    const keys = this.routes.get(route) ?? new Set<string>();
    this.routes.set(route, keys);
    for (const pane of snapshot.panes) {
      const key = paneKey(route, pane.paneID);
      keys.add(key);
      if (!runsAgentIn(pane, snapshot)) {
        this.running.set(key, false);
        continue;
      }
      const arrived = this.running.get(key) !== true;
      if (arrived) this.arrivals.set(key, (this.arrivals.get(key) ?? 0) + 1);
      this.running.set(key, true);
      const info = agentIn(pane, snapshot);
      const kind = (info?.agent ?? pane.agent ?? "agent").toLowerCase();
      const terminal = info?.terminalID !== undefined && info.terminalID !== "" ? info.terminalID : pane.terminalID;
      const previous = this.memories.get(key);
      // A report without a session keeps the last one while the same kind runs in the same terminal.
      // A Cursor run's session is its own (as the Swift app's
      // followsPerRun): a new arrival that names none never keeps an earlier run's.
      const sameRun = previous !== undefined && previous.kind === kind && previous.terminalID === terminal && !(kind === "cursor" && arrived);
      this.memories.set(key, {
        kind,
        title: agentTitle(kind, pane.displayAgent),
        terminalID: terminal,
        session: info?.agentSession ?? (sameRun ? previous.session : null),
        // The session Chat followed is this run's only.
        followed: !arrived && sameRun ? (previous.followed ?? null) : null,
      });
    }
  }

  /**
   * Chat follows `followed.session` for the pane: kept for the Grok run now in
   * it (the same terminal, still running), so Resume can offer it after the agent leaves. Ignored for
   * another kind, terminal or pane, a run that ended, or what is not a Grok session id.
   */
  followed(hostId: string, paneID: string, followed: FollowedSession): void {
    if (!isGrokSessionID(followed.session)) return;
    for (const route of this.routes.keys()) {
      if (!route.startsWith(`${hostId}|`)) continue;
      const key = paneKey(route, paneID);
      const memory = this.memories.get(key);
      // A Cursor run's chat the same way.
      if (memory === undefined || this.running.get(key) !== true || (memory.kind !== "grok" && memory.kind !== "cursor") || memory.terminalID !== followed.terminalID) continue;
      this.memories.set(key, { ...memory, followed: followed.session });
    }
  }

  /** How many times an agent arrived in the pane while the page watched. */
  arrival(host: Pick<PaneLifeHost, "id" | "address">, paneID: string): number {
    return this.arrivals.get(paneKey(routeOf(host), paneID)) ?? 0;
  }

  /** The machine's connection generation (0: never answered while watched). */
  connection(hostId: string): number {
    return this.connections.get(hostId) ?? 0;
  }

  /** The agent that last ran in the pane, if the page saw one. */
  memory(host: Pick<PaneLifeHost, "id" | "address">, paneID: string): PaneAgentMemory | null {
    return this.memories.get(paneKey(routeOf(host), paneID)) ?? null;
  }

  /**
   * The agent that left `pane`, while no agent runs in it and its terminal is
   * the one the agent ran in; null while one runs, for a pane the page never
   * saw an agent in on this route, or for another terminal in the pane.
   */
  exited(host: Pick<PaneLifeHost, "id" | "address">, pane: TopologyPaneInfo, snapshot: SessionTopology): PaneAgentMemory | null {
    if (runsAgentIn(pane, snapshot)) return null;
    const memory = this.memory(host, pane.paneID);
    if (memory === null || pane.terminalID === "" || memory.terminalID !== pane.terminalID) return null;
    return memory;
  }

  /** Whether the machine answers now. */
  isLive(hostId: string): boolean {
    return this.live.get(hostId) === true;
  }

  private dropRoute(route: string): void {
    for (const key of this.routes.get(route) ?? []) {
      this.arrivals.delete(key);
      this.running.delete(key);
      this.memories.delete(key);
    }
    this.routes.delete(route);
  }
}

// MARK: - The Resume chip

/** The chip's offer: its title and the command its tap puts in the box. */
export interface ResumeOffer {
  readonly title: string;
  readonly command: string;
}

const uuidAtEnd = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const uuid = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * A session id the chip may put after `--resume` or `resume`: the
 * session-id shape Claude and Codex both use, a UUID
 * (Codex's rollout files end with it). Never anything a CLI could read as an
 * option ("--latest", "-c") or another word.
 */
export function isResumableSessionID(value: string): boolean {
  return uuid.test(value) && isValidSessionID(value);
}

/** The session id the chip resumes: an id that is a UUID; for a transcript path, the UUID its file name ends with. */
export function resumeSessionID(session: AgentSessionInfo | null): string | null {
  if (session === null) return null;
  switch (session.kind) {
    case "id":
      return isResumableSessionID(session.value) ? session.value : null;
    case "path": {
      // Grok's `~/.grok/sessions/<folder>/<id>/updates.jsonl` names its session by its folder.
      // Cursor's `~/.cursor/chats/<md5>/<id>/store.db` the same way.
      if (session.value.endsWith("/updates.jsonl") || isCursorStorePath(session.value)) {
        const id = session.value.split("/").at(-2) ?? "";
        return isResumableSessionID(id) ? id : null;
      }
      const file = session.value.split("/").at(-1) ?? "";
      const dot = file.lastIndexOf(".");
      const stem = dot > 0 ? file.slice(0, dot) : file;
      const id = uuidAtEnd.exec(stem)?.[0] ?? null;
      return id !== null && isResumableSessionID(id) ? id : null;
    }
    default:
      return null;
  }
}

/**
 * The id the chip resumes for the agent that left: Herdr's session's; for Grok, else the session
 * Chat followed in that run (never a fresh newest pick).
 */
function memoryResumeID(memory: PaneAgentMemory): string | null {
  const named = resumeSessionID(memory.session);
  if (named !== null || (memory.kind !== "grok" && memory.kind !== "cursor")) return named;
  const followed = memory.followed ?? null;
  return followed !== null && isGrokSessionID(followed) && isResumableSessionID(followed) ? followed : null;
}

/** One line of visible text: no line break, control or invisible formatting character. */
export function isPlainLine(line: string): boolean {
  if (line.trim() === "") return false;
  return !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(line);
}

/** Why no chip shows for a kind, logged once each (never the command itself). */
const refusalsLogged = new Set<string>();
export let logResumeRefusal: (line: string) => void = (line) => console.info(line);
export function setResumeLog(log: (line: string) => void): void {
  logResumeRefusal = log;
}

function refuse(kind: string, why: string): null {
  const key = `${kind}|${why}`;
  if (!refusalsLogged.has(key)) {
    refusalsLogged.add(key);
    logResumeRefusal(`no Resume chip for ${kind}: ${why}`);
  }
  return null;
}

/**
 * The start command the chip fills for `kind`: the one configured while it is
 * a plain command; the kind's executable only when nothing is configured for
 * it. A configured command refused, or a file not read, shows no chip: never
 * the executable, a command you did not configure. Null while not known.
 */
export function resumeStartCommand(kind: "claude" | "codex" | "grok" | "cursor", commands: AgentStartCommands | null): string | null {
  if (commands === null) return null;
  // Cursor's agent starts as `cursor agent` (the Cursor app's `cursor` takes `agent`;
  // `cursor-agent` is an older alias a Mac with only the app does not have). Editable start kinds' stock commands.
  const executable = kind === "cursor" ? cursorAgentCommand : kind;
  switch (commands.status.type) {
    case "absent":
      return executable;
    case "malformed":
    case "unreadable":
      return refuse(kind, `${startCommandsDisplayPath} was not read: ${commands.status.reason}`);
    case "read": {
      const configured = commandFor(commands, kind);
      if (configured !== null) {
        const refusal = plainCommandRefusal(configured);
        return refusal === null ? configured : refuse(kind, `its command ${refusal}`);
      }
      const refused = commands.refused[kind];
      return refused === undefined ? executable : refuse(kind, refused);
    }
  }
}

/**
 * What the chip fills: Claude's `<start> --resume <id>`, Codex's `<start> resume <id> --no-daemon`, Grok's
 * `<start> --resume <id>`; null for another kind, no id, or no plain command.
 */
export function resumeCommand(memory: PaneAgentMemory, commands: AgentStartCommands | null): string | null {
  // Cursor's `cursor agent --resume <id>`, the chat Chat followed as Grok's.
  if (memory.kind !== "claude" && memory.kind !== "codex" && memory.kind !== "grok" && memory.kind !== "cursor") return null;
  const id = memoryResumeID(memory);
  if (id === null) return null;
  const start = resumeStartCommand(memory.kind, commands);
  if (start === null) return null;
  // Codex's with `--no-daemon` once (codex-start.ts codexResumeLine).
  const line = memory.kind === "codex" ? codexResumeLine(start, id) : `${start} --resume ${id}`;
  return isPlainLine(line) ? line : null;
}

/** The chip's title: "Resume" and the session's first eight characters. */
export function resumeTitle(memory: PaneAgentMemory): string | null {
  const id = memoryResumeID(memory);
  return id === null ? null : `Resume ${id.slice(0, 8)}`;
}

/** The chip for the agent that left a pane, or null. */
export function resumeOffer(exited: PaneAgentMemory | null, commands: AgentStartCommands | null): ResumeOffer | null {
  if (exited === null) return null;
  const command = resumeCommand(exited, commands);
  const title = resumeTitle(exited);
  return command === null || title === null ? null : { title, command };
}

/** The shell box's placeholder once the pane's agent left. */
export const shellPlaceholder = "Run a command";
