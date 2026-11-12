// A fake Herdr for demo mode: a transport that answers protocol 22 requests
// from a fixture snapshot (so the real HerdrClient and decoders run), and
// terminals that play the repo's recorded byte streams. No host, no network,
// no process. Typing into a demo terminal does nothing; a message sent from the
// composer is answered "ok" and, for a pane with a Chat transcript, written
// into that transcript a moment later (demo-chat.ts).

import { parseReplay, type ReplayRecording } from "../../shared/replay";
import { DemoTranscriptReader } from "./demo-chat";
import { defaultTree, describeTree, layoutJson, removeLeaf, setRatioAt, splitLeaf, treePanes, type DemoTabLayout } from "./demo-layout";
import type { HerdrHostBackend, HostUploads, TerminalHandle, TerminalSink } from "../herdr/backend";
import { MemoryUploadSftp } from "../uploads/memory";
import { MemoryStartCommandsFiles } from "../start-commands-memory";
import { saveStartCommand } from "../start-commands-write";
import { browseFolder } from "../folder-browse";
import type { FolderListing } from "../../shared/folder-browse";
import { demoFolderTree, type DemoFolderTree } from "./demo-folders";
import { readFirstStartCommandsFile, maximumStartCommandsBytes, type AgentStartCommands } from "../../shared/start-commands";
import { uploadFilePrefix, uploadFolderPrefix } from "../../shared/attachments";
import { removeUpload, uploadAttachment } from "../uploads/upload";
import { DemoGit } from "./demo-git";
import { DemoRemote } from "./demo-remote";
import { HerdrClient } from "../herdr/client";
import { pasteEnd, pasteStart, returnKey } from "../herdr/send";
import type { EventSink, EventSubscription } from "../herdr/events";
import type { TerminalDimensions } from "../herdr/terminal";
import type { HerdrTransport } from "../herdr/transport";
import type { SessionTopology, TopologyPaneInfo } from "../herdr/wire";
import type { DemoFixtures, DemoHost } from "./demo-hosts";
import { DemoCodexLiveReply, DemoCursorLiveReply, DemoLiveReply, type DemoStreamingPane } from "./demo-live";
import { DemoGrokPane } from "./demo-grok-pane";
import type { DemoClaudeQueue } from "./demo-claude-queue";
import type { DemoRunningCall } from "./demo-tall";
import { grokSummaryPath } from "../../shared/chat/locator";
import { integrationTargets } from "../../shared/integrations";

/** The integrations the demo machines have (their agents' kinds). */
const demoAvailableIntegrations: readonly string[] = ["claude", "codex", "grok", "cursor"];

/** The folder the demo Grok pane's top line shows (initials, as Grok draws it). */
const demoGrokFolder = "/U/d/c/w/tidepool-narration";

type Json = Record<string, unknown>;

/**
 * What a real Herdr does on a clean home, for the captures
 * only (off until a capture sets it; demo machines only, never a real connection). `busy`: a new pane's first
 * starts of that kind answer `agent_pane_busy` (its shell still in its startup files; Infinity: it never gets there).
 * `notReady`: the kind's start answers `agent_not_ready` and its pane shows the agent's own sign-in screen. `missing`:
 * the start answers ok (or the typed start command is taken) and the pane's shell prints `zsh: command not found: <program>`. `home`: a cwd the machine does
 * not have (a `~` path included: Herdr does not expand it) gives a pane in its home, without an error.
 */
export interface DemoStartQuirks {
  readonly busy?: Readonly<Record<string, number>>;
  readonly notReady?: readonly string[];
  readonly missing?: readonly string[];
  /**
   * Captures 169-170: kinds whose started agent Herdr names no session for yet
   * (a Codex just started with Herdr's hook, before its first turn).
   */
  readonly noSession?: readonly string[];
  /** Capture 171: the screen a started agent of the kind shows (Codex's hook review). */
  readonly startScreen?: Readonly<Record<string, string>>;
  readonly home?: { readonly path: string; has(folder: string): boolean };
}

/** The sign-in screen a `notReady` kind's pane shows (an invented one; the demo's agents are not real programs). */
export function demoSignInScreen(title: string): string {
  return [`  ${title}`, "", "  Sign in to continue.", "", "  > 1. Sign in with your browser", "    2. Use an API key", "", "  Press Enter to continue"].join("\n");
}

/** Answers one request line the way a protocol 22 server would, from a snapshot. */
export class FixtureTransport implements HerdrTransport {
  /** Every request line received, in order. */
  readonly requests: string[] = [];
  /** Each tab's split tree (demo-layout.ts), made when first asked for. */
  private readonly layouts = new Map<string, DemoTabLayout>();
  private readonly listeners = new Set<(kind: string, paneId: string | null) => void>();

  /** Each blocked pane's screens for `pane.read` (demo-prompts.ts); a key sent moves to the next. */
  private readonly screens: Map<string, string[]>;

  constructor(
    private readonly snapshot: Json,
    screens: Readonly<Record<string, readonly string[]>> = {},
    /** The pane, or panes (Claude's, Codex's and Cursor's), whose screen shows its reply being written. */
    live: DemoStreamingPane | readonly DemoStreamingPane[] | null = null,
    /** The Grok panes that draw their box and take their /model command (demo-grok-pane.ts). */
    private readonly groks: readonly DemoGrokPane[] = [],
  ) {
    this.screens = new Map(Object.entries(screens).map(([pane, list]) => [pane, [...list]]));
    this.lives = live === null ? [] : Array.isArray(live) ? [...(live as readonly DemoStreamingPane[])] : [live as DemoStreamingPane];
  }

  private readonly lives: readonly DemoStreamingPane[];

  /** A streaming Codex pane's status as Herdr would say it (working from the user's message until its reply lands, then done). */
  private applyLiveStatus(): void {
    for (const live of this.lives) {
      // A streaming Cursor pane's status the same way.
      if (!(live instanceof DemoCodexLiveReply) && !(live instanceof DemoCursorLiveReply)) continue;
      const status = live.status();
      if (status === null) continue;
      const pane = this.paneJson(live.paneID);
      const agent = list(this.snapshot["agents"]).find((entry) => entry["pane_id"] === live.paneID);
      if (pane !== undefined) pane["agent_status"] = status;
      if (agent !== undefined) Object.assign(agent, { agent_status: status, status_since_unix_ms: live.statusSince() });
    }
  }

  /** What the pane shows now ("" for a pane without screens). */
  screen(paneId: string): string {
    return this.screens.get(paneId)?.[0] ?? "";
  }

  /**
   * Captures 131-133: the pane's screens from now on (a key sent moves to the next,
   * as for the demo's own); returns the ones it had, to be put back after.
   */
  show(paneId: string, screens: readonly string[]): readonly string[] {
    const had = this.screens.get(paneId) ?? [];
    if (screens.length === 0) this.screens.delete(paneId);
    else this.screens.set(paneId, [...screens]);
    return had;
  }

  /** Captures 175-176: panes whose turn runs with the user's messages waiting in Claude's queue. */
  private readonly queues = new Map<string, DemoClaudeQueue>();

  /** The pane's Claude queue from now on (null: none; its screens and keys as before). */
  setQueue(paneId: string, queue: DemoClaudeQueue | null): void {
    if (queue === null) this.queues.delete(paneId);
    else this.queues.set(paneId, queue);
  }

  /** The pane's Claude queue, if it has one. */
  queue(paneId: string): DemoClaudeQueue | null {
    return this.queues.get(paneId) ?? null;
  }

  /** Capture 133: the pane's agent status as Herdr says it; returns the one it had (null for no such pane). */
  setStatus(paneId: string, status: string): string | null {
    const pane = this.paneJson(paneId);
    if (pane === undefined) return null;
    const had = String(pane["agent_status"]);
    pane["agent_status"] = status;
    const agent = list(this.snapshot["agents"]).find((entry) => entry["pane_id"] === paneId);
    if (agent !== undefined) agent["agent_status"] = status;
    return had;
  }

  /**
   * Captures 155-157: the pane's folder (`cwd`, on its pane and its agent) and the session Herdr
   * names for it (`agent_session`; null: none), each only when given; returns what puts both back as they were.
   */
  setPaneSession(paneId: string, change: { readonly cwd?: string; readonly session?: Json | null }): () => void {
    const pane = this.paneJson(paneId);
    const agent = list(this.snapshot["agents"]).find((entry) => entry["pane_id"] === paneId);
    const kept = [pane, agent].filter((entry): entry is Json => entry !== undefined).map((entry) => ({ entry, had: { ...entry } }));
    for (const { entry } of kept) {
      if (change.cwd !== undefined) {
        entry["cwd"] = change.cwd;
        if ("foreground_cwd" in entry) entry["foreground_cwd"] = change.cwd;
      }
      if (change.session === null) delete entry["agent_session"];
      else if (change.session !== undefined && entry === agent) entry["agent_session"] = change.session;
    }
    return () => {
      for (const { entry, had } of kept) {
        for (const key of Object.keys(entry)) delete entry[key];
        Object.assign(entry, had);
      }
    };
  }

  /**
   * Captures 158-162 (demo only, never a real connection): Herdr's agent
   * integrations on this fake, every 0.9.5 target: Claude Code's, Codex's, Grok Build's and Cursor Agent's current and
   * available (their agents run on the demo machines), the rest not installed and not available.
   */
  private readonly integrations = new Map<string, { state: string; available: boolean }>(
    integrationTargets.map((target) => [target, demoAvailableIntegrations.includes(target) ? { state: "current", available: true } : { state: "not_installed", available: false }]),
  );
  /** Installs asked of this fake (the tests count them). */
  readonly installs: string[] = [];

  /** For the captures: one target's state; returns what puts it back. */
  setIntegration(target: string, state: string): () => void {
    const held = this.integrations.get(target);
    if (held === undefined) return () => undefined;
    const had = held.state;
    held.state = state;
    return () => {
      held.state = had;
    };
  }

  /**
   * Capture 194 (demo only): one target's integration reported as found on this
   * machine (its agent there) in `state`; returns what puts it back.
   */
  setIntegrationFound(target: string, state: string): () => void {
    const held = this.integrations.get(target);
    if (held === undefined) return () => undefined;
    const had = { state: held.state, available: held.available };
    held.state = state;
    held.available = true;
    return () => {
      held.state = had.state;
      held.available = had.available;
    };
  }

  private integrationList(): Json[] {
    return [...this.integrations].map(([target, entry]) => ({ target, label: target, command: target, available: entry.available, state: entry.state }));
  }

  /** Herdr's events as this fake makes them (layout.updated, pane.created, …). */
  onEvent(listener: (kind: string, paneId: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(kind: string, paneId: string | null): void {
    for (const listener of Array.from(this.listeners)) listener(kind, paneId);
  }

  /** The tab's tree, kept in step with the tab's panes in the snapshot. */
  private tabLayout(tabId: string): DemoTabLayout | null {
    const panes = list(this.snapshot["panes"])
      .filter((pane) => pane["tab_id"] === tabId)
      .map((pane) => String(pane["pane_id"]));
    if (panes.length === 0) return null;
    let tab = this.layouts.get(tabId);
    const known = tab === undefined ? [] : treePanes(tab.root);
    if (tab === undefined || known.length !== panes.length || known.some((pane) => !panes.includes(pane))) {
      const focused = tab !== undefined && panes.includes(tab.focused) ? tab.focused : panes[0]!;
      tab = { root: defaultTree(panes), zoomed: false, focused };
      this.layouts.set(tabId, tab);
    }
    return tab;
  }

  private quirks: DemoStartQuirks | null = null;
  /** Each pane's starts answered busy so far. */
  private readonly busyStarts = new Map<string, number>();

  /** For the captures: what this fake does as a Herdr on a clean home does (null: as before); returns the ones it had. */
  setStartQuirks(quirks: DemoStartQuirks | null): DemoStartQuirks | null {
    const had = this.quirks;
    this.quirks = quirks;
    this.busyStarts.clear();
    return had;
  }

  /** The cwd a new pane gets: the one asked, or (quirks.home) the home for a folder the machine does not have. */
  private placedCwd(asked: unknown): string | undefined {
    if (typeof asked !== "string") return undefined;
    const home = this.quirks?.home;
    if (home === undefined) return asked;
    return asked.startsWith("/") && home.has(asked) ? asked : home.path;
  }

  /** A quirk's answer to `agent.start` in the pane, or null for the usual start. */
  private quirkStart(paneId: string, kind: string, name: string): Promise<string> | null {
    const quirks = this.quirks;
    if (quirks === null || this.paneJson(paneId) === undefined) return null;
    const busy = quirks.busy?.[kind];
    if (busy !== undefined) {
      const answered = this.busyStarts.get(paneId) ?? 0;
      if (answered < busy) {
        this.busyStarts.set(paneId, answered + 1);
        return refuse("agent_pane_busy", `agent target pane ${paneId} is not an available shell`);
      }
    }
    if (quirks.notReady?.includes(kind) === true) {
      this.screens.set(paneId, [demoSignInScreen(kind.slice(0, 1).toUpperCase() + kind.slice(1))]);
      return refuse("agent_not_ready", "agent probe is blocked during startup and is not ready for prompts");
    }
    if (quirks.missing?.includes(kind) === true) {
      const prompt = this.screen(paneId);
      this.screens.set(paneId, [`${prompt}${kind}\nzsh: command not found: ${kind}\n${prompt}`]);
      const agent = { pane_id: paneId, name, agent: kind, agent_status: "unknown", interactive_ready: false, launch_pending: true };
      return Promise.resolve(JSON.stringify({ id: null, result: { type: "agent_started", agent } }));
    }
    return null;
  }

  private paneJson(paneId: string): Json | undefined {
    return list(this.snapshot["panes"]).find((pane) => pane["pane_id"] === paneId);
  }

  roundTrip(requestLine: string): Promise<string> {
    this.requests.push(requestLine);
    let request: Json;
    try {
      request = JSON.parse(requestLine) as Json;
    } catch {
      return Promise.resolve(JSON.stringify({ id: null, error: { code: "invalid_request", message: "not JSON" } }));
    }
    const id = request["id"];
    const method = request["method"];
    const answer = (result: unknown): Promise<string> => Promise.resolve(JSON.stringify({ id, result }));
    switch (method) {
      case "session.snapshot":
        this.applyLiveStatus();
        return answer({ type: "session_snapshot", snapshot: this.snapshot });
      case "agent.list":
        return answer({ type: "agent_list", agents: this.snapshot["agents"] ?? [] });
      // The demo's integrations (demo only), and an install that makes one current.
      case "integration.list":
        return answer({ type: "integration_list", integrations: this.integrationList() });
      case "integration.install": {
        const target = object(request["params"])["target"];
        const entry = typeof target === "string" ? this.integrations.get(target) : undefined;
        if (entry === undefined) return refuse("invalid_params", "unknown integration target");
        this.installs.push(String(target));
        const was = entry.state;
        entry.state = "current";
        // Herdr 0.9.5's real shape, its lines under `details`.
        return answer({
          type: "integration_install",
          target,
          details: {
            messages: [was === "outdated" ? `Updated the ${String(target)} integration to the current version.` : `Installed the ${String(target)} integration.`, `Running ${String(target)} agents pick it up when they start again.`],
          },
        });
      }
      case "tab.create":
        return answer(this.createTab(object(request["params"])));
      case "workspace.create": {
        // Herdr: a workspace with one tab holding a shell at the folder, focus left alone (focus false).
        const params = object(request["params"]);
        if (typeof params["label"] !== "string" || params["label"].trim() === "") return refuse("invalid_params", "label must not be empty");
        const made = this.createWorkspace(params);
        this.emit("workspace.created", null);
        return answer(made);
      }
      case "agent.start": {
        const params = object(request["params"]);
        const quirk = this.quirkStart(String(params["pane_id"]), String(params["kind"]), String(params["name"]));
        if (quirk !== null) return quirk.then((line) => line.replace('"id":null', `"id":${JSON.stringify(id)}`));
        const agent = this.startAgent(String(params["pane_id"]), String(params["kind"]), String(params["name"]));
        return agent === null ? refuse("pane_not_found", "no such pane") : answer({ type: "agent_started", agent });
      }
      case "pane.close": {
        const paneId = String(object(request["params"])["pane_id"]);
        const closing = this.paneJson(paneId);
        const tabId = closing === undefined ? null : String(closing["tab_id"]);
        const tab = tabId === null ? undefined : this.layouts.get(tabId);
        this.snapshot["panes"] = list(this.snapshot["panes"]).filter((pane) => pane["pane_id"] !== paneId);
        this.snapshot["agents"] = list(this.snapshot["agents"]).filter((agent) => agent["pane_id"] !== paneId);
        if (closing === undefined) return answer({ type: "ok" });
        this.countTabPanes(tabId!);
        // The tab's tree loses the pane; its sibling takes the space (Herdr's close).
        const root = tab === undefined ? null : removeLeaf(tab.root, paneId);
        if (tab !== undefined && root !== null) {
          const left = treePanes(root);
          this.layouts.set(tabId!, { root, zoomed: tab.zoomed && left.includes(tab.focused), focused: left.includes(tab.focused) ? tab.focused : left[0]! });
        } else if (tab !== undefined) {
          this.layouts.delete(tabId!);
        }
        this.emit("pane.closed", paneId);
        const rest = tab === undefined || root === null ? null : this.layouts.get(tabId!)!.focused;
        if (rest !== null) this.emit("layout.updated", rest);
        this.closeEmptied(tabId!, String(closing["workspace_id"]));
        return answer({ type: "ok" });
      }
      case "pane.rename": {
        // Herdr 0.9.5 PaneRenameParams { pane_id, label: string | null }: the pane's label set
        // (trimmed, as Herdr trims it) or, null or blank, cleared; pane.updated told; answered pane_info { pane }.
        const params = object(request["params"]);
        const pane = this.paneJson(String(params["pane_id"]));
        if (pane === undefined) return refuse("pane_not_found", "no such pane");
        const label = params["label"] ?? null;
        if (label !== null && typeof label !== "string") return refuse("invalid_params", "label must be a string or null");
        const trimmed = label === null ? "" : label.trim();
        if (trimmed === "") delete pane["label"];
        else pane["label"] = trimmed;
        pane["revision"] = (typeof pane["revision"] === "number" ? pane["revision"] : 0) + 1;
        this.emit("pane.updated", String(pane["pane_id"]));
        return answer({ type: "pane_info", pane });
      }
      case "tab.rename": {
        // Herdr 0.9.5 TabRenameParams { tab_id, label } (both required): the tab's label set
        // (trimmed), tab.renamed told; answered tab_info { tab }. A blank label is refused, as a workspace's.
        const params = object(request["params"]);
        const tab = list(this.snapshot["tabs"]).find((candidate) => candidate["tab_id"] === params["tab_id"]);
        if (tab === undefined) return refuse("tab_not_found", "no such tab");
        if (typeof params["label"] !== "string" || params["label"].trim() === "") return refuse("invalid_params", "label must not be empty");
        tab["label"] = params["label"].trim();
        this.emit("tab.renamed", null);
        return answer({ type: "tab_info", tab });
      }
      case "workspace.rename": {
        // Herdr 0.9.5 WorkspaceRenameParams { workspace_id, label } (both required): the label set,
        // workspace.renamed told; answered workspace_info { workspace }. A blank label is refused, as workspace.create's.
        const params = object(request["params"]);
        const workspace = list(this.snapshot["workspaces"]).find((candidate) => candidate["workspace_id"] === params["workspace_id"]);
        if (workspace === undefined) return refuse("workspace_not_found", "no such workspace");
        if (typeof params["label"] !== "string" || params["label"].trim() === "") return refuse("invalid_params", "label must not be empty");
        workspace["label"] = params["label"].trim();
        this.emit("workspace.renamed", null);
        return answer({ type: "workspace_info", workspace });
      }
      case "pane.split": {
        const params = object(request["params"]);
        const target = this.paneJson(String(params["target_pane_id"]));
        const direction = params["direction"];
        if (target === undefined || params["workspace_id"] !== target["workspace_id"]) return refuse("pane_not_found", "no such pane");
        if (direction !== "right" && direction !== "down") return refuse("invalid_params", "direction must be right or down");
        const tabId = String(target["tab_id"]);
        const tab = this.tabLayout(tabId)!;
        this.created += 1;
        const pane: Json = {
          pane_id: `${String(target["workspace_id"])}:ps${this.created}`,
          terminal_id: `demo-split-${this.created}`,
          workspace_id: target["workspace_id"],
          tab_id: tabId,
          focused: false,
          ...(typeof params["cwd"] === "string" ? { cwd: this.placedCwd(params["cwd"]) } : typeof target["cwd"] === "string" ? { cwd: target["cwd"] } : {}),
          agent_status: "unknown",
          revision: 1,
        };
        this.snapshot["panes"] = [...list(this.snapshot["panes"]), pane];
        this.countTabPanes(tabId);
        const newPaneId = String(pane["pane_id"]);
        // focus false (the window's split): Herdr's focus stays on the pane it was on.
        this.layouts.set(tabId, {
          root: splitLeaf(tab.root, String(target["pane_id"]), direction, newPaneId),
          zoomed: false,
          focused: params["focus"] === true ? newPaneId : tab.focused,
        });
        this.emit("pane.created", newPaneId);
        this.emit("layout.updated", String(target["pane_id"]));
        return answer({ type: "pane_info", pane });
      }
      case "layout.set_split_ratio": {
        // Herdr 0.9.5: { tab_id?, pane_id?, path: [bool], ratio }: the split at the path (false first, true second) takes the ratio.
        const params = object(request["params"]);
        const steps = params["path"];
        const ratio = params["ratio"];
        if (!Array.isArray(steps) || !steps.every((step) => typeof step === "boolean") || typeof ratio !== "number" || !Number.isFinite(ratio)) {
          return refuse("invalid_params", "path (booleans) and ratio");
        }
        const byPane = typeof params["pane_id"] === "string" ? this.paneJson(params["pane_id"]) : undefined;
        const tabId = typeof params["tab_id"] === "string" ? params["tab_id"] : byPane === undefined ? null : String(byPane["tab_id"]);
        const tab = tabId === null ? null : this.tabLayout(tabId);
        if (tabId === null || tab === null) return refuse("tab_not_found", "no such tab");
        const root = setRatioAt(tab.root, steps as boolean[], Math.min(0.9, Math.max(0.1, ratio)));
        if (root === null) return refuse("invalid_params", "no split at that path");
        this.layouts.set(tabId, { ...tab, root });
        this.emit("layout.updated", tab.focused);
        const workspaceId = String(this.paneJson(tab.focused)?.["workspace_id"] ?? "");
        return answer({
          type: "layout_split_ratio_set",
          layout: { workspace_id: workspaceId, tab_id: tabId, zoomed: tab.zoomed, focused_pane_id: tab.focused, root: describeTree(root) },
        });
      }
      case "pane.zoom": {
        // Herdr 0.9.5: { pane_id, mode: toggle | on | off }, mode toggle when left out (other params ignored).
        const params = object(request["params"]);
        const mode = params["mode"] ?? "toggle";
        if (mode !== "toggle" && mode !== "on" && mode !== "off") return refuse("invalid_params", "mode must be toggle, on or off");
        const pane = this.paneJson(String(params["pane_id"]));
        if (pane === undefined) return refuse("pane_not_found", "no such pane");
        const tabId = String(pane["tab_id"]);
        const tab = this.tabLayout(tabId)!;
        const paneId = String(pane["pane_id"]);
        // A tab of one pane has nothing to zoom over.
        const single = treePanes(tab.root).length === 1;
        const zoomed = single ? false : mode === "toggle" ? !tab.zoomed : mode === "on";
        const next = { ...tab, zoomed, focused: paneId };
        this.layouts.set(tabId, next);
        this.emit("layout.updated", paneId);
        const zoomChanged = zoomed !== tab.zoomed;
        const focusChanged = paneId !== tab.focused;
        return answer({
          type: "pane_zoom",
          zoom: {
            changed: zoomChanged || focusChanged,
            zoom_changed: zoomChanged,
            focus_changed: focusChanged,
            pane_id: paneId,
            focused_pane_id: paneId,
            zoomed,
            layout: layoutJson(tabId, String(pane["workspace_id"]), next),
            reason: single ? "single_pane" : zoomChanged ? null : zoomed ? "already_zoomed" : "already_unzoomed",
          },
        });
      }
      case "pane.send_input": {
        // A start command typed into a new shell (New agent with agents.json): its agent appears there.
        const params = object(request["params"]);
        const kind = demoTypedKind(String(params["text"] ?? ""));
        const paneId = String(params["pane_id"]);
        // For the captures: a `missing` kind's typed command is one the shell cannot find.
        if (kind !== null && this.quirks?.missing?.includes(kind) === true && this.paneJson(paneId) !== undefined) {
          const program = String(params["text"]).trim().split(/\s+/)[0] ?? kind;
          const prompt = this.screen(paneId);
          this.screens.set(paneId, [`${prompt}${String(params["text"]).trim()}\nzsh: command not found: ${program}\n${prompt}`]);
          return answer({ type: "ok" });
        }
        if (kind !== null && !list(this.snapshot["agents"]).some((agent) => agent["pane_id"] === paneId)) {
          this.startAgent(paneId, kind, kind);
        }
        return answer({ type: "ok" });
      }
      case "pane.layout": {
        const pane = this.paneJson(String(object(request["params"])["pane_id"]));
        const tabId = pane === undefined ? "" : String(pane["tab_id"]);
        const tab = pane === undefined ? null : this.tabLayout(tabId);
        if (pane === undefined || tab === null) return refuse("pane_not_found", "no such pane");
        return answer({ type: "pane_layout", layout: layoutJson(tabId, String(pane["workspace_id"]), tab) });
      }
      case "pane.read": {
        // The pane's screen as plain text, its last `lines` lines (source recent).
        const params = object(request["params"]);
        const paneId = String(params["pane_id"]);
        const pane = this.paneJson(paneId);
        if (pane === undefined) return refuse("pane_not_found", "no such pane");
        const lines = typeof params["lines"] === "number" ? params["lines"] : 40;
        const live = this.lives.find((each) => each.paneID === paneId);
        const grok = this.groks.find((each) => each.paneID === paneId);
        // A question still waiting on the pane's own screens (its approval frame) shows
        // over the Grok box; once its key answers it, Grok's box draws the pane again.
        const waiting = (this.screens.get(paneId)?.length ?? 0) > 1;
        const queue = this.queues.get(paneId);
        const shown = queue !== undefined ? queue.screen() : live !== undefined ? live.screen() : grok !== undefined && !waiting ? grok.screen() : this.screen(paneId);
        const text = shown.split("\n").slice(-lines).join("\n");
        return answer({
          type: "pane_read",
          read: { pane_id: paneId, workspace_id: pane["workspace_id"], tab_id: pane["tab_id"], source: "recent", format: "text", text, revision: 1, truncated: false },
        });
      }
      case "pane.send_keys": {
        // A key answers the pane's question: its next screen shows.
        const paneId = String(object(request["params"])["pane_id"]);
        if (this.paneJson(paneId) === undefined) return refuse("pane_not_found", "no such pane");
        const list = this.screens.get(paneId);
        if (list !== undefined && list.length > 1) list.shift();
        // The Cursor pane's keys go to its model menu (demo-cursor-menu.ts).
        const cursor = this.lives.find((each) => each.paneID === paneId);
        if (cursor instanceof DemoCursorLiveReply) cursor.menu.keys(stringList(object(request["params"])["keys"]));
        // Claude's Shift+Tab, Codex's /permissions list and its digits.
        if (cursor instanceof DemoLiveReply || cursor instanceof DemoCodexLiveReply) cursor.keys(stringList(object(request["params"])["keys"]));
        this.groks.find((each) => each.paneID === paneId)?.keys(stringList(object(request["params"])["keys"]));
        return answer({ type: "ok" });
      }
      case "pane.send_text": {
        // Text typed into the Cursor pane's box (not the user's pasted message) goes to its menu.
        const params = object(request["params"]);
        const cursor = this.lives.find((each) => each.paneID === String(params["pane_id"]));
        const text = typeof params["text"] === "string" ? params["text"] : "";
        if (cursor instanceof DemoCursorLiveReply && !text.startsWith(pasteStart)) cursor.menu.type(text);
        // `/permissions` typed into Codex's box (the user's messages go by agent.prompt).
        if (cursor instanceof DemoCodexLiveReply && !text.startsWith(pasteStart)) cursor.type(text);
        this.groks.find((each) => each.paneID === String(params["pane_id"]))?.type(text);
        return answer({ type: "ok" });
      }
      case "agent.send_keys": {
        // Up, Ctrl+U and Backspace in a pane whose Claude queue shows.
        const params = object(request["params"]);
        this.queues.get(String(params["target"] ?? params["pane_id"]))?.keys(stringList(params["keys"]));
        // Capture 221: a typed command's Return (send.ts) reaches the Grok pane's box too.
        this.groks.find((each) => each.paneID === String(params["target"] ?? params["pane_id"]))?.keys(stringList(params["keys"]));
        return answer({ type: "ok" });
      }
      case "agent.prompt":
        return answer({ type: "agent_prompted", delivery: "submitted" });
      default:
        return Promise.resolve(
          JSON.stringify({ id, error: { code: "unknown_method", message: `the demo does not answer ${String(method)}` } }),
        );
    }
  }

  close(): void {}

  /** The tab's (and its workspace's) pane count, as the snapshot says. */
  /**
   * As Herdr does, a tab left with no pane closes (tab.closed), and a workspace left with
   * no tab closes (workspace.closed). In Herdr, an attach's EOF that ends a scratch tab's one shell
   * closes its tab, and pane.move reports closed_tab_id and closed_workspace_id
   * for the tab and workspace its last pane left (the 0.9.5 schema's PaneMoveResult).
   */
  private closeEmptied(tabId: string, workspaceId: string): void {
    const panes = list(this.snapshot["panes"]);
    if (panes.some((pane) => pane["tab_id"] === tabId)) return;
    this.snapshot["tabs"] = list(this.snapshot["tabs"]).filter((tab) => tab["tab_id"] !== tabId);
    this.layouts.delete(tabId);
    this.emit("tab.closed", null);
    const tabs = list(this.snapshot["tabs"]).filter((tab) => tab["workspace_id"] === workspaceId);
    if (tabs.length === 0) {
      this.snapshot["workspaces"] = list(this.snapshot["workspaces"]).filter((workspace) => workspace["workspace_id"] !== workspaceId);
      this.emit("workspace.closed", null);
      return;
    }
    for (const workspace of list(this.snapshot["workspaces"])) {
      if (workspace["workspace_id"] !== workspaceId) continue;
      workspace["tab_count"] = tabs.length;
      if (workspace["active_tab_id"] === tabId) workspace["active_tab_id"] = tabs[0]!["tab_id"];
    }
  }

  private countTabPanes(tabId: string): void {
    const panes = list(this.snapshot["panes"]);
    for (const tab of list(this.snapshot["tabs"])) {
      if (tab["tab_id"] === tabId) tab["pane_count"] = panes.filter((pane) => pane["tab_id"] === tabId).length;
    }
    for (const workspace of list(this.snapshot["workspaces"])) {
      workspace["pane_count"] = panes.filter((pane) => pane["workspace_id"] === workspace["workspace_id"]).length;
    }
  }

  private created = 0;

  /** `tab.create`: a tab with one shell pane in the workspace, at the folder. */
  private createTab(params: Json): Json {
    this.created += 1;
    const workspaceId = String(params["workspace_id"]);
    const tabId = `${workspaceId}:tn${this.created}`;
    const tabs = list(this.snapshot["tabs"]);
    const tab: Json = {
      tab_id: tabId,
      workspace_id: workspaceId,
      number: tabs.filter((candidate) => candidate["workspace_id"] === workspaceId).length + 1,
      label: typeof params["label"] === "string" ? params["label"] : "",
      focused: false,
      pane_count: 1,
      agent_status: "unknown",
    };
    const pane: Json = {
      pane_id: `${workspaceId}:pn${this.created}`,
      terminal_id: `demo-new-${this.created}`,
      workspace_id: workspaceId,
      tab_id: tabId,
      focused: false,
      ...(typeof params["cwd"] === "string" ? { cwd: this.placedCwd(params["cwd"]) } : {}),
      agent_status: "unknown",
      revision: 1,
    };
    this.snapshot["tabs"] = [...tabs, tab];
    this.snapshot["panes"] = [...list(this.snapshot["panes"]), pane];
    // A new shell sits at its prompt (what its terminal shows and `pane.read` reads).
    const folder = this.placedCwd(params["cwd"]) ?? "~";
    this.screens.set(String(pane["pane_id"]), [`you@demo ${folder.split("/").filter((part) => part !== "").pop() ?? "~"} % `]);
    return { type: "tab_created", tab, root_pane: pane };
  }

  /** `workspace.create`: the workspace, its first tab and that tab's shell pane at the folder, after the others. */
  private createWorkspace(params: Json): Json {
    this.created += 1;
    const workspaces = list(this.snapshot["workspaces"]);
    const workspaceId = `wn${this.created}`;
    const tabId = `${workspaceId}:t1`;
    const workspace: Json = {
      workspace_id: workspaceId,
      number: workspaces.length + 1,
      label: params["label"],
      focused: false,
      pane_count: 1,
      tab_count: 1,
      active_tab_id: tabId,
      agent_status: "unknown",
    };
    const tab: Json = { tab_id: tabId, workspace_id: workspaceId, number: 1, label: "", focused: false, pane_count: 1, agent_status: "unknown" };
    const pane: Json = {
      pane_id: `${workspaceId}:p1`,
      terminal_id: `demo-new-${this.created}`,
      workspace_id: workspaceId,
      tab_id: tabId,
      focused: false,
      ...(typeof params["cwd"] === "string" ? { cwd: this.placedCwd(params["cwd"]) } : {}),
      agent_status: "unknown",
      revision: 1,
    };
    this.snapshot["workspaces"] = [...workspaces, workspace];
    this.snapshot["tabs"] = [...list(this.snapshot["tabs"]), tab];
    this.snapshot["panes"] = [...list(this.snapshot["panes"]), pane];
    return { type: "workspace_created", workspace, tab, root_pane: pane };
  }

  /** An agent of `kind` in the pane, idle at its prompt, with a session. */
  private startAgent(paneId: string, kind: string, name: string): Json | null {
    const pane = list(this.snapshot["panes"]).find((candidate) => candidate["pane_id"] === paneId);
    if (pane === undefined) return null;
    this.screens.delete(paneId);
    const startScreen = this.quirks?.startScreen?.[kind];
    if (startScreen !== undefined) this.screens.set(paneId, [startScreen]);
    pane["agent"] = kind;
    pane["agent_status"] = "idle";
    const agent: Json = {
      pane_id: paneId,
      name,
      agent: kind,
      agent_status: "idle",
      terminal_id: pane["terminal_id"],
      interactive_ready: true,
      ...(this.quirks?.noSession?.includes(kind) === true
        ? {}
        : { agent_session: { source: `herdr:${kind}`, agent: kind, kind: "id", value: `5e55${String(this.created).padStart(4, "0")}-0000-4000-8000-00000000demo`.slice(0, 36) } }),
    };
    this.snapshot["agents"] = [...list(this.snapshot["agents"]), agent];
    return agent;
  }
}

function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

/** A request's key names. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
}

function refuse(code: string, message: string): Promise<string> {
  return Promise.resolve(JSON.stringify({ id: null, error: { code, message } }));
}

/** The kind a typed start command starts on a demo machine (`cl` is Claude, as agents.json says). */
export function demoTypedKind(text: string): string | null {
  const word = text.trim().split(/\s+/)[0] ?? "";
  if (word === "cl" || word === "claude") return "claude";
  if (word === "codex" || word === "grok") return word;
  return null;
}

/** What a demo terminal shows. */
export type DemoScript =
  | { readonly kind: "replay"; readonly recording: ReplayRecording; readonly loop: boolean }
  | { readonly kind: "text"; readonly text: string };

/** Timers, injectable so tests run a replay without waiting. */
export interface DemoClock {
  schedule(run: () => void, delayMs: number): () => void;
}

export const realClock: DemoClock = {
  schedule(run, delayMs) {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
};

/**
 * The demo machines' agents.json: Claude's stock `claude`; Settings › Chat edits it in memory (demoStartFiles),
 * as a real machine's file is edited over SFTP.
 */
export const demoStartCommands = '{\n  "claude": "claude"\n}\n';

/** A demo machine's home with its `~/.adari/agents.json` (demoStartCommands, 0600, in a 0700 folder). */
export function demoStartFiles(home: string): MemoryStartCommandsFiles {
  const files = new MemoryStartCommandsFiles(home);
  files.addFolder(`${home}/.adari`, 0o700);
  files.addFile(`${home}/.adari/agents.json`, demoStartCommands, 0o600);
  return files;
}

/** How long after a send the demo writes the message into its transcript. */
export const demoTranscriptDelayMs = 1_500;

/** A pause between the end of a looping recording and its next pass. */
export const loopPauseMs = 1_200;

const clearScreen = "\u001b[0m\u001b[2J\u001b[3J\u001b[H";
/** DECAWM off: a line wider than the terminal is cut at the edge, not wrapped (the capture is 131 columns). */
const noAutowrap = "\u001b[?7l";

/** The text script's bytes: autowrap off, the screen cleared, then the lines with CR LF endings. */
export function textScreen(text: string): Uint8Array {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  return new TextEncoder().encode(noAutowrap + clearScreen + lines.join("\r\n"));
}

/** Plays a script into a sink with the recording's own timing; loops if asked. */
export class ReplayTerminal implements TerminalHandle {
  private cancel: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly script: DemoScript,
    private readonly sink: TerminalSink,
    private readonly clock: DemoClock = realClock,
  ) {}

  start(): void {
    // After the open call has returned, so the page knows the session first.
    this.cancel = this.clock.schedule(() => this.begin(), 0);
  }

  private begin(): void {
    if (this.closed) return;
    if (this.script.kind === "text") {
      this.sink.data(textScreen(this.script.text));
      return;
    }
    this.play(this.script.recording, this.script.loop, 0);
  }

  private play(recording: ReplayRecording, loop: boolean, index: number): void {
    if (this.closed) return;
    const chunk = recording.chunks[index];
    if (chunk === undefined) {
      if (loop && recording.chunks.length > 0) this.cancel = this.clock.schedule(() => this.play(recording, loop, 0), loopPauseMs);
      return;
    }
    this.sink.data(chunk.bytes);
    const next = recording.chunks[index + 1];
    if (next === undefined) {
      this.play(recording, loop, index + 1);
      return;
    }
    const delay = Math.max(0, Math.round((next.time - chunk.time) * 1000));
    this.cancel = this.clock.schedule(() => this.play(recording, loop, index + 1), delay);
  }

  input(): void {}

  resize(): void {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel?.();
    this.cancel = null;
  }
}

/** Which script a pane plays: needs you shows the dialog, working streams, a printing shell streams too, the rest is idle. */
export function demoScriptFor(
  snapshot: Json,
  pane: TopologyPaneInfo,
  fixtures: DemoFixtures,
  printing: readonly string[] = [],
  /** What `pane.read` shows for the pane now ("" or absent: the Bash dialog). */
  screen = "",
): DemoScript {
  const agents = Array.isArray(snapshot["agents"]) ? (snapshot["agents"] as Json[]) : [];
  const agent = agents.find((candidate) => candidate["pane_id"] === pane.paneID);
  const isAgent = pane.agent !== undefined && pane.agent !== "";
  if (isAgent && agent !== undefined && (agent["agent_status"] === "blocked" || agent["input_pending"] === true)) {
    return { kind: "text", text: screen === "" ? fixtures.bashDialog : screen };
  }
  if ((isAgent && pane.agentStatus === "working") || (!isAgent && printing.includes(pane.paneID))) {
    return { kind: "replay", recording: parseReplay(fixtures.heavy), loop: true };
  }
  // A shell made here (New agent's shell, the terminal drawer's) shows its prompt.
  if (!isAgent && screen !== "") return { kind: "text", text: screen };
  return { kind: "replay", recording: parseReplay(fixtures.idle), loop: false };
}

/** One demo machine. */
export class DemoBackend implements HerdrHostBackend {
  readonly kind = "demo" as const;
  readonly transport: FixtureTransport;
  private readonly client: HerdrClient;
  private readonly terminals = new Set<TerminalHandle>();
  private readonly reader: DemoTranscriptReader;
  private readonly remote: DemoRemote;
  private readonly pending = new Set<() => void>();
  private readonly files: MemoryUploadSftp;
  /** Its `~/.adari/agents.json`, which Settings › Chat edits. */
  private readonly startFiles: MemoryStartCommandsFiles;
  /** Its invented folders, for the folder field's list. */
  private readonly folders: DemoFolderTree;
  /** Git from memory (demo-git.ts), its commits before the demo's start. */
  private readonly git: DemoGit;
  /** The panes whose replies stream on their screens (demo-live.ts: Claude's, Codex's and Cursor's). */
  private readonly lives: readonly DemoStreamingPane[];

  constructor(
    private readonly host: DemoHost,
    /** The recorded streams the terminals play; null for a machine with terminals of its own (host.terminal, the showcase). */
    private readonly fixtures: DemoFixtures | null,
    private readonly clock: DemoClock = realClock,
    private readonly now: () => number = Date.now,
  ) {
    this.lives = [
      ...(host.liveReply === undefined ? [] : [new DemoLiveReply(host.liveReply, now)]),
      ...(host.codexLiveReply === undefined ? [] : [new DemoCodexLiveReply(host.codexLiveReply, now)]),
      ...(host.cursorLiveReply === undefined ? [] : [new DemoCursorLiveReply(host.cursorLiveReply, now)]),
    ];
    // The Grok pane's box, its summary.json written again on a switch.
    const groks = host.transcripts
      .filter((transcript) => transcript.agent === "grok")
      .map((transcript) => {
        const summary = grokSummaryPath(transcript.path);
        const pane: DemoGrokPane = new DemoGrokPane(transcript.paneID, demoGrokFolder, "Faded the narration's last clip out over 0.35 s; the render passes.", () => {
          if (summary !== null) this.reader.setFile(summary, pane.summary(transcript.cwd));
        });
        return pane;
      });
    this.transport = new FixtureTransport(host.snapshot, host.screens, this.lives, groks);
    this.client = new HerdrClient(this.transport);
    this.reader = new DemoTranscriptReader(host.transcripts, now, this.lives);
    this.git = new DemoGit(now(), host.git);
    this.remote = new DemoRemote(host.transcripts, this.reader, now(), host.commits);
    this.files = new MemoryUploadSftp(host.home ?? "/Users/demo");
    this.startFiles = demoStartFiles(host.home ?? "/Users/demo");
    this.folders = demoFolderTree(host.descriptor.platform ?? null, host.snapshot);
    seedDemoUploads(this.files, host.uploads ?? 0, now());
  }

  snapshot(): Promise<SessionTopology> {
    return this.client.sessionTopology();
  }

  paneText(paneID: string, lines: number): Promise<string> {
    return this.client.paneText(paneID, lines);
  }

  sendInput(paneID: string, text: string, keys: readonly string[]): Promise<void> {
    return this.client.sendInput(paneID, text, keys);
  }

  /** The message pasted into the streaming Cursor pane, until its Return. */
  private readonly pasted = new Map<string, string>();

  async sendText(paneID: string, text: string): Promise<void> {
    await this.client.sendText(paneID, text);
    // Cursor takes the user's message as a paste, then its Return (send.ts promptKinds, sendBoundNow).
    if (!this.lives.some((live) => live.paneID === paneID && live instanceof DemoCursorLiveReply)) return;
    // A chip's `/model` is Cursor's menu, never the user's message (nor are its approval toggles).
    if (text === "/model" || text === "/auto-review" || text === "/run-everything") return;
    const message = text.startsWith(pasteStart) && text.endsWith(pasteEnd) ? text.slice(pasteStart.length, -pasteEnd.length) : text;
    if (message.trim() === "") this.pasted.delete(paneID);
    else this.pasted.set(paneID, message);
  }

  async agentKeys(paneID: string, keys: readonly string[]): Promise<void> {
    await this.client.agentSendKeys(paneID, keys);
    // The Return sends the paste: the streaming Cursor pane records and answers it as prompt() does.
    const message = this.pasted.get(paneID);
    if (message === undefined || !keys.includes(returnKey)) return;
    this.pasted.delete(paneID);
    this.recordSent(paneID, message);
  }

  async prompt(paneID: string, text: string): Promise<void> {
    await this.client.prompt(paneID, text);
    // While the pane's Claude queue shows, the user's message waits there (the transcript has nothing yet).
    const queue = this.transport.queue(paneID);
    if (queue !== null) {
      queue.add(text);
      return;
    }
    this.recordSent(paneID, text);
  }

  /** The user's sent message lands in the pane's transcript a moment later; a streaming pane starts its reply. */
  private recordSent(paneID: string, text: string): void {
    const agents = Array.isArray(this.host.snapshot["agents"]) ? (this.host.snapshot["agents"] as Json[]) : [];
    const working = agents.some((agent) => agent["pane_id"] === paneID && agent["agent_status"] === "working");
    const cancel = this.clock.schedule(() => {
      this.pending.delete(cancel);
      if (this.reader.record(paneID, text, working, this.now())) this.lives.find((live) => live.paneID === paneID)?.start(text);
    }, demoTranscriptDelayMs);
    this.pending.add(cancel);
  }

  transcripts(): DemoTranscriptReader {
    return this.reader;
  }

  /**
   * Captures 131-133: the pane blocked on `screens`, and (133) `running`
   * written into its transcript as Chat's running call; returns what puts its screens and status back (the
   * transcript keeps the call: 133 is the last capture).
   */
  showPrompt(paneId: string, screens: readonly string[], running: DemoRunningCall | null): () => void {
    const had = this.transport.show(paneId, screens);
    const status = this.transport.setStatus(paneId, "blocked");
    if (running !== null) this.reader.running(paneId, running, this.now());
    return () => {
      this.transport.show(paneId, had);
      if (status !== null) this.transport.setStatus(paneId, status);
    };
  }

  /** Captures 165-166: Claude Code's /model confirmation written into a Claude pane's transcript. */
  printCommandOutput(paneId: string, stdout: string): boolean {
    return this.reader.commandPrinted(paneId, stdout, this.now());
  }

  /**
   * Captures 173-174: the pane's agent status as Herdr says it (working while a
   * monitor's turn runs, done when it ends); returns the one it had (null for no such pane).
   */
  setPaneStatus(paneId: string, status: string): string | null {
    return this.transport.setStatus(paneId, status);
  }

  /**
   * Captures 221-222: the pane at its prompt (no question on its screens, idle);
   * returns what puts its screens and status back.
   */
  idleForCapture(paneId: string): () => void {
    const had = this.transport.show(paneId, []);
    const status = this.transport.setStatus(paneId, "idle");
    return () => {
      this.transport.show(paneId, had);
      if (status !== null) this.transport.setStatus(paneId, status);
    };
  }

  /** Capture 174: Claude Code's compaction lands in the pane's transcript now. */
  compacted(paneId: string): boolean {
    return this.reader.compacted(paneId, this.now());
  }

  /** Captures 181-185: the Codex pane's transcript names `model` and `effort` now. */
  codexModel(paneId: string, model: string, effort: string): boolean {
    return this.reader.codexModel(paneId, model, effort, this.now());
  }

  /** The demo machine's uploads, in memory; Chat's thumbnails read them back. */
  uploads(): HostUploads {
    return {
      machineKey: `demo@${this.host.descriptor.id}`,
      upload: async (data, extension, signal) => {
        const remote = await uploadAttachment(this.files, data, extension, undefined, signal === undefined ? {} : { signal });
        this.reader.store(remote.path, data);
        return remote;
      },
      discard: (path) => removeUpload(this.files, path),
      withFiles: (work) => work(this.files),
    };
  }

  workspaceActions(): HerdrClient {
    return this.client;
  }

  /** The fake's integration.list and integration.install (demo only). */
  integrations(): HerdrClient {
    return this.client;
  }

  /** For the captures: one integration's state on the fake (demo only); returns what puts it back. */
  setIntegration(target: string, state: string): () => void {
    return this.transport.setIntegration(target, state);
  }

  /** Capture 194: one target's integration found on this machine (demo only). */
  setIntegrationFound(target: string, state: string): () => void {
    return this.transport.setIntegrationFound(target, state);
  }

  paneActions(): HerdrClient {
    return this.client;
  }

  /** `pane.read` and `pane.send_keys` on the demo's screens. */
  promptIO(): HerdrClient {
    return this.client;
  }

  /** The fake Herdr's events, acknowledged as Herdr's stream does before the first one. */
  subscribeEvents(kinds: readonly string[], sink: EventSink): EventSubscription {
    let open = true;
    const off = this.transport.onEvent((kind, paneId) => {
      if (open && kinds.includes(kind)) this.clock.schedule(() => open && sink.event(kind, paneId), 0);
    });
    const cancel = this.clock.schedule(() => open && sink.started(), 0);
    return {
      close: () => {
        open = false;
        cancel();
        off();
      },
    };
  }

  /** The demo machine's `~/.adari/agents.json` (`claude`, and what Settings › Chat saved since). */
  readStartCommandsFile(): Promise<Uint8Array | null> {
    const home = this.startFiles.homePath;
    return readFirstStartCommandsFile(async (relative) => {
      const entry = await this.startFiles.lstat(`${home}/${relative}`);
      return entry === null ? null : this.startFiles.read(`${home}/${relative}`, maximumStartCommandsBytes + 1);
    });
  }

  /** The folder field's listing, from the demo machine's invented tree (demo-folders.ts). */
  browseFolder(directory: string): Promise<FolderListing> {
    return browseFolder(this.folders, directory);
  }

  /**
   * For the captures: a clean-home Herdr's ways (DemoStartQuirks), with `home` as this machine's own invented
   * tree (a folder it does not have gives a pane in its home); null puts the usual answers back.
   */
  setStartQuirks(quirks: Omit<DemoStartQuirks, "home"> | null, fallBackHome = false): void {
    const tree = this.folders;
    this.transport.setStartQuirks(
      quirks === null ? null : { ...quirks, ...(fallBackHome ? { home: { path: tree.homePath, has: (folder: string) => tree.hasFolder(folder) } } : {}) },
    );
  }

  /** For the captures: the pane's folder and named session changed (demo only); returns what puts them back. */
  setPaneSession(paneId: string, change: { readonly cwd?: string; readonly session?: Json | null }): () => void {
    return this.transport.setPaneSession(paneId, change);
  }

  /** The demo machine's invented home (its folder tree's). */
  homeFolder(): Promise<string> {
    return this.folders.home();
  }

  /** Settings › Chat's save, into the demo machine's file in memory (start-commands-write.ts). */
  saveStartCommand(kind: string, command: string): Promise<AgentStartCommands> {
    return saveStartCommand(this.startFiles, kind, command);
  }

  changesRunner(): DemoGit {
    return this.git;
  }

  /** git log and search answered from the demo's fixtures (demo-remote.ts). */
  commands(): DemoRemote {
    return this.remote;
  }

  openTerminal(pane: TopologyPaneInfo, size: TerminalDimensions, sink: TerminalSink): Promise<TerminalHandle> {
    const own = this.host.terminal;
    if (own !== undefined || this.fixtures === null) {
      const terminal = own?.(pane, size, sink, this.clock) ?? new ReplayTerminal({ kind: "text", text: "" }, sink, this.clock);
      if (own === undefined) (terminal as ReplayTerminal).start();
      this.terminals.add(terminal);
      return Promise.resolve({
        input: (data) => terminal.input(data),
        resize: (cols, rows) => terminal.resize(cols, rows),
        close: () => {
          this.terminals.delete(terminal);
          terminal.close();
        },
      });
    }
    const script = demoScriptFor(this.host.snapshot, pane, this.fixtures, this.host.printing, this.transport.screen(pane.paneID));
    const terminal = new ReplayTerminal(script, sink, this.clock);
    this.terminals.add(terminal);
    terminal.start();
    return Promise.resolve({
      input: () => undefined,
      resize: () => undefined,
      close: () => {
        this.terminals.delete(terminal);
        terminal.close();
      },
    });
  }

  close(): void {
    for (const terminal of this.terminals) terminal.close();
    this.terminals.clear();
    for (const cancel of this.pending) cancel();
    this.pending.clear();
  }
}

/**
 * `count` uploads already on a demo machine (Settings › Uploaded images counts them), each in its own
 * folder as the uploader makes them, of a few sizes, the oldest about two weeks back (none due for the 30-day sweep).
 */
export function seedDemoUploads(files: MemoryUploadSftp, count: number, nowMs: number): void {
  const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");
  // One buffer under every file (only its length is read: the count's sizes), so the demo holds no 50 MB of zeros.
  const bytes = new Uint8Array(420_000);
  for (let i = 0; i < count; i += 1) {
    const folder = `${files.home}/${uploadFolderPrefix}${hex(0xad4a1 * (i + 1), 32).slice(-32)}`;
    const uuid = `${hex(i + 1, 8)}-5e7a-4c1d-9a2b-${hex(0x3c0ffee + i, 12)}`;
    const at = nowMs - (14 * 24 * 60 - i * 7) * 60_000;
    const size = [182_400, 96_350, 411_900, 58_120][i % 4]!;
    files.addFolder(folder, at);
    files.addFile(`${folder}/${uploadFilePrefix}${uuid}.${i % 5 === 4 ? "jpg" : "png"}`, bytes.subarray(0, size), at);
  }
}
