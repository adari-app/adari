// Changes for each window, a port of the Swift app's
// CompanionAgentChangesModel and CompanionChangesOverviewModel reads. One
// agent: its transcript read backwards first (through the machine's gate; its
// first turn may move the session's start earlier), then its folder's git
// status and the commits since that start, together. The across-agents
// screen: every machine in the sidebar, git once per folder and each session's
// own files (shared/changes/overview.ts). git runs on the machine through its
// backend's read-only runner (an SSH machine's transcript connection, an exec
// per command; the demo's memory), bounded and timed (shared/changes/reader.ts),
// at most three commands at once per machine connection: one gate per backend.
// Each window has one agent read, one diff and one overview read per machine
// at a time: a newer one ends the older, which answers null; closing ends them
// all. The across-agents screen reads each machine on its own (its
// rows show as it finishes), and the page asks for a new read only when it
// means to end the one running (Refresh, a new set of machines): a finished
// turn waits for the read running (ChangesOverview.tsx). A diff runs only for a
// file or a commit the window's last read listed.

import type { ChangesAgentResult, ChangesDiffRequest, ChangesDiffResult, HostView } from "../../shared/ipc-contract";
import type { TranscriptFileReader } from "../../shared/chat/feed";
import { paneSession, sessionRefFromAgentSession, type TranscriptSessionRef } from "../../shared/chat/locator";
import { geminiFamilyFormatOfAgent, isGeminiFamilyFormat } from "../../shared/chat/agents/gemini-family";
import { isStoreAgentFormat } from "../../shared/chat/agents/store-agents";
import { isPiFormat } from "../../shared/chat/agents/pi-locator";
import { isOpenCodeFormat } from "../../shared/chat/agents/opencode-locate";
import { coreChatSession } from "../../shared/chat/core-pane-session";
import { changesText, changesTools, fallbackSinceSeconds, type ChangesOverviewHost } from "../../shared/changes/content";
import { defaultChangesLimits, type AgentChangesLimits, type AgentCommit, type GitFileChange } from "../../shared/changes/git";
import { collectOverview, groupedOverview, readToolsInGate, sharingPanes, type AgentChangesPane, type AgentOverviewRow } from "../../shared/changes/overview";
import { AgentChangesGitReader, ChangesCancelled, CommandGate, type ReadOnlyCommandRunner } from "../../shared/changes/reader";
import type { AgentToolChanges } from "../../shared/changes/tools";
import { buildSidebarModel, sidebarInputFromTopology } from "../../shared/sidebar-model";
import type { HerdrHostBackend } from "../herdr/backend";
import type { SessionTopology } from "../herdr/wire";

/** What the service reads from the machines in the sidebar. */
export interface ChangesHosts {
  list(): HostView[];
  backend(hostId: string): HerdrHostBackend | null;
}

export interface ChangesServiceOptions {
  readonly limits?: AgentChangesLimits;
  /** ms since 1970. */
  readonly now?: () => number;
  readonly nonce?: () => string;
}

/** The last agent read of a window: what its diffs may open. */
interface LastRead {
  readonly hostId: string;
  readonly paneId: string;
  readonly folder: string | null;
  readonly backend: HerdrHostBackend;
  readonly files: readonly GitFileChange[];
  readonly commits: readonly AgentCommit[];
}

interface WindowChanges {
  agent: AbortController | null;
  diff: AbortController | null;
  /** The overview read running for each machine, by its id. */
  readonly overview: Map<string, AbortController>;
  last: LastRead | null;
}

/** The agent panes the sidebar lists (every one, whatever is folded or searched), in its Priority order, with their workspace. */
export function changesPanes(topology: SessionTopology, macID: string, nowMs: number, session: (paneId: string) => TranscriptSessionRef | null): AgentChangesPane[] {
  const model = buildSidebarModel(sidebarInputFromTopology(topology, { macID, nowUnixMs: nowMs }));
  const seen = new Set<string>();
  const panes: AgentChangesPane[] = [];
  for (const row of model.priorityRows) {
    if (!row.isAgent || seen.has(row.paneID)) continue;
    seen.add(row.paneID);
    panes.push({ paneId: row.paneID, name: row.name, kind: row.kind, folder: row.cwd ?? null, workspace: row.workspaceLabel, session: session(row.paneID) });
  }
  return panes;
}

/**
 * The session Herdr names for the pane (the across-agents screen reads only these, as the Swift app
 * does); a Grok pane's as Chat binds it (its folder when Herdr names none, its peers' sessions
 * excluded, none when it cannot be told).
 */
export function herdrSession(topology: SessionTopology, paneId: string): TranscriptSessionRef | null {
  const agent = topology.agents.find((candidate) => candidate.paneID === paneId);
  const pane = topology.panes.find((candidate) => candidate.paneID === paneId);
  const kind = (agent?.agent ?? pane?.agent)?.toLowerCase();
  // Changes reads no Cursor chat (its folder's git only).
  if (kind === "cursor") return null;
  // Nor Gemini CLI's, Qwen Code's or Antigravity's yet.
  if (geminiFamilyFormatOfAgent(kind) !== null) return null;
  if (kind === "kimi") return null; // nor a Kimi session
  if (kind === "kiro") return null; // nor a Kiro session yet (its folder's git only)
  if (isStoreAgentFormat(kind)) return null; // nor a Hermes, Mastra Code or Cline session yet
  // Nor a Pi, omp, Copilot, Droid, OpenCode or Kilo session for 0.1.0: Changes' folder check knows Claude's and
  // Codex's lines only (each needs its own ownership check first).
  if ((kind !== undefined && isPiFormat(kind)) || kind === "copilot" || kind === "github-copilot" || kind === "droid" || isOpenCodeFormat(kind)) return null;
  if (kind === "grok") return chatSession(topology, paneId);
  // A herdr-core Claude or Codex pane's found by folder, as Chat finds it.
  if (coreChatSession(paneId, topology.agents, topology.panes) !== undefined) return chatSession(topology, paneId);
  const ref = agent?.agentSession === undefined ? null : sessionRefFromAgentSession(agent.agentSession);
  if (ref !== null && isGeminiFamilyFormat(ref.format)) return null;
  if (ref?.format === "kimi") return null;
  // Changes reads no Maki transcript yet (its folder's git only).
  if (ref?.format === "maki") return null;
  if (ref?.format === "kiro") return null;
  // The same six by the session Herdr names.
  if (ref !== null && (isPiFormat(ref.format) || ref.format === "copilot" || ref.format === "droid" || isOpenCodeFormat(ref.format))) return null;
  return ref?.format === "cursor" ? null : ref;
}

/** The pane's session as Chat finds it (locator.paneSession, the one rule). */
export function chatSession(topology: SessionTopology, paneId: string): TranscriptSessionRef | null {
  const session = paneSession(topology, paneId);
  return session === null || session === "ambiguous" ? null : session.ref;
}

/** The overview's rows carry counts, not every edit's lines. */
function light(changes: AgentToolChanges): AgentToolChanges {
  return { ...changes, thisTurn: [], session: changes.session.map((file) => ({ ...file, edits: [] })) };
}

function lightRow(row: AgentOverviewRow): AgentOverviewRow {
  return row.tools.kind === "read" ? { ...row, tools: { kind: "read", changes: light(row.tools.changes) } } : row;
}

export class ChangesService {
  private readonly windows = new Map<number, WindowChanges>();
  /** One gate per machine connection (its backend): every Changes view of a machine runs at most `commandsAtOnce` at a time. */
  private readonly gates = new WeakMap<HerdrHostBackend, CommandGate>();
  private readonly limits: AgentChangesLimits;
  private readonly now: () => number;
  private readonly nonce: (() => string) | undefined;
  /** Agent reads started (tests). */
  reads = 0;

  constructor(
    private readonly hosts: ChangesHosts,
    options: ChangesServiceOptions = {},
  ) {
    this.limits = options.limits ?? defaultChangesLimits;
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce;
  }

  private window(owner: { readonly id: number }): WindowChanges {
    let window = this.windows.get(owner.id);
    if (window === undefined) {
      window = { agent: null, diff: null, overview: new Map(), last: null };
      this.windows.set(owner.id, window);
    }
    return window;
  }

  private gate(backend: HerdrHostBackend): CommandGate {
    let gate = this.gates.get(backend);
    if (gate === undefined) {
      gate = new CommandGate(this.limits.commandsAtOnce);
      this.gates.set(backend, gate);
    }
    return gate;
  }

  /** The machine's git reader, or null while it is offline or has no runner. */
  private git(host: HostView | undefined, backend: HerdrHostBackend | null): AgentChangesGitReader | null {
    if (host === undefined || backend === null || host.state === "offline") return null;
    const runner: ReadOnlyCommandRunner | null = backend.changesRunner?.() ?? null;
    if (runner === null) return null;
    return this.nonce === undefined
      ? new AgentChangesGitReader(runner, this.gate(backend), this.limits)
      : new AgentChangesGitReader(runner, this.gate(backend), this.limits, this.nonce);
  }

  /** One agent's Changes; null when a newer read (or a close) ended it. */
  async agent(owner: { readonly id: number }, hostId: string, paneId: string): Promise<ChangesAgentResult | null> {
    const window = this.window(owner);
    window.agent?.abort();
    const control = new AbortController();
    window.agent = control;
    const signal = control.signal;
    this.reads += 1;
    const host = this.hosts.list().find((candidate) => candidate.id === hostId);
    const backend = this.hosts.backend(hostId);
    const topology = host?.topology ?? null;
    const pane = topology?.panes.find((candidate) => candidate.paneID === paneId);
    const agentInfo = topology?.agents.find((candidate) => candidate.paneID === paneId);
    const kind = (agentInfo?.agent ?? pane?.agent ?? "").toLowerCase();
    const rawFolder = pane === undefined ? (agentInfo?.cwd ?? null) : (pane.foregroundCWD ?? pane.cwd ?? agentInfo?.cwd ?? null);
    const folder = rawFolder !== null && rawFolder.trim().length > 0 ? rawFolder : null;
    const panes = topology === null ? [] : changesPanes(topology, hostId, this.now(), () => null);
    const sharing = sharingPanes(paneId, folder, panes);
    const git = this.git(host, backend);
    const base = { hostId, paneId, kind, folder, sharing };
    if (git === null || backend === null) {
      if (window.agent === control) window.agent = null;
      window.last = null;
      return {
        ...base,
        online: false,
        tools: { kind: "none", reason: changesText.toolsOffline },
        git: { kind: "offline" },
        commits: { kind: "offline" },
        commitsSince: null,
        sinceKnown: false,
      };
    }
    const ref = topology === null ? null : chatSession(topology, paneId);
    const transcripts: TranscriptFileReader<TranscriptSessionRef> | null = backend.transcripts();
    try {
      let tools: AgentToolChanges | null = null;
      if (ref !== null && transcripts !== null) {
        const read = await readToolsInGate(git.gate, ref, folder, transcripts, this.limits, signal);
        if (read.kind === "read") tools = read.changes;
      }
      if (signal.aborted) throw new ChangesCancelled();
      const start = tools?.firstTurnAt ?? null;
      const since = start ?? Math.floor(this.now() / 1000) - fallbackSinceSeconds;
      const toolsState = changesTools(null, tools, false, kind);
      if (folder === null) {
        window.last = { hostId, paneId, folder, backend, files: [], commits: [] };
        return { ...base, online: true, tools: toolsState, git: { kind: "noFolder" }, commits: { kind: "noFolder" }, commitsSince: since, sinceKnown: start !== null };
      }
      const [status, log] = await Promise.all([git.status(folder, signal), git.commits(folder, since, signal)]);
      if (signal.aborted) throw new ChangesCancelled();
      window.last = {
        hostId,
        paneId,
        folder,
        backend,
        files: status.kind === "repository" ? status.status.files : [],
        commits: log.kind === "commits" ? log.commits : [],
      };
      return {
        ...base,
        online: true,
        tools: toolsState,
        git: { kind: "read", read: status },
        commits: { kind: "read", read: log },
        commitsSince: since,
        sinceKnown: start !== null,
      };
    } catch (error) {
      if (error instanceof ChangesCancelled || signal.aborted) return null;
      throw error;
    } finally {
      if (window.agent === control) window.agent = null;
    }
  }

  /** A file's or a commit's diff from the window's last read of the pane; null when a newer one (or a close) ended it. */
  async diff(owner: { readonly id: number }, hostId: string, paneId: string, request: ChangesDiffRequest): Promise<ChangesDiffResult | null> {
    const window = this.window(owner);
    window.diff?.abort();
    const control = new AbortController();
    window.diff = control;
    const signal = control.signal;
    const last = window.last;
    try {
      const host = this.hosts.list().find((candidate) => candidate.id === hostId);
      const backend = this.hosts.backend(hostId);
      if (last === null || last.hostId !== hostId || last.paneId !== paneId || last.backend !== backend) {
        return host === undefined || host.state === "offline" || backend === null ? { kind: "offline" } : { kind: "failed" };
      }
      if (last.folder === null) return { kind: "noFolder" };
      const git = this.git(host, backend);
      if (git === null) return { kind: "offline" };
      if (request.kind === "file") {
        const change = last.files.find((candidate) => candidate.path === request.path);
        if (change === undefined) return { kind: "failed" };
        const result = await git.fileDiff(last.folder, change, signal);
        return result.kind === "text" ? { kind: "text", text: result.text, bound: this.limits.fileDiffBytes } : result;
      }
      const commit = last.commits.find((candidate) => candidate.hash === request.hash);
      if (commit === undefined) return { kind: "failed" };
      const result = await git.show(last.folder, commit.hash, signal);
      return result.kind === "text" ? { kind: "text", text: result.text, bound: this.limits.commitBytes } : result;
    } catch (error) {
      if (error instanceof ChangesCancelled || signal.aborted) return null;
      throw error;
    } finally {
      if (window.diff === control) window.diff = null;
    }
  }

  /**
   * One machine's agents for the across-agents screen; null when a newer read
   * of it (or a close) ended it, or it is no longer listed. Ends the window's
   * reads of machines no longer listed or offline. A read that fails answers
   * "failed" on its machine.
   */
  async overview(owner: { readonly id: number }, hostId: string): Promise<ChangesOverviewHost | null> {
    const window = this.window(owner);
    const listed = this.hosts.list();
    for (const [id, running] of window.overview) {
      if (listed.some((host) => host.id === id && host.state !== "offline")) continue;
      running.abort();
      window.overview.delete(id);
    }
    window.overview.get(hostId)?.abort();
    const host = listed.find((candidate) => candidate.id === hostId);
    if (host === undefined) return null;
    const control = new AbortController();
    window.overview.set(hostId, control);
    const signal = control.signal;
    try {
      const read = await this.overviewHost(host, signal);
      return signal.aborted ? null : read;
    } catch (error) {
      if (error instanceof ChangesCancelled || signal.aborted) return null;
      return { hostId: host.id, name: host.name, state: "failed", groups: [] };
    } finally {
      if (window.overview.get(hostId) === control) window.overview.delete(hostId);
    }
  }

  private async overviewHost(host: HostView, signal: AbortSignal): Promise<ChangesOverviewHost> {
    const backend = this.hosts.backend(host.id);
    const git = this.git(host, backend);
    const topology = host.topology;
    if (git === null || backend === null || topology === null) return { hostId: host.id, name: host.name, state: "offline", groups: [] };
    const panes = changesPanes(topology, host.id, this.now(), (paneId) => herdrSession(topology, paneId));
    const rows = await collectOverview({ panes, transcripts: backend.transcripts(), git, limits: this.limits, signal });
    return { hostId: host.id, name: host.name, state: "read", groups: groupedOverview(rows.map(lightRow)) };
  }

  /** Ends the window's reads (its Changes closed, or it went away). */
  close(owner: { readonly id: number }): void {
    const window = this.windows.get(owner.id);
    if (window === undefined) return;
    this.windows.delete(owner.id);
    window.agent?.abort();
    window.diff?.abort();
    for (const running of window.overview.values()) running.abort();
  }

  closeAll(): void {
    for (const id of this.windows.keys()) this.close({ id });
  }
}
