// A Herdr whose state changes behind the app's back: one machine's tabs, panes (each with its terminal), agents and layouts,
// answered in the wire shapes of Herdr 0.9.5's schema (pane.layout's
// PaneLayoutSnapshot, pane_info, pane_zoom, layout_split_ratio_set,
// agent_list, agent_started), plus session.snapshot through `backend()`.
// A test changes `tabs` or the panes directly (another client, Herdr's TUI, a
// restart that reuses ids) without the app's cached snapshot knowing, holds a
// pane.split at `splitGate`, or makes the machine stop answering.

import { defaultTree, describeTree, layoutJson, removeLeaf, setRatioAt, splitLeaf, treePanes, type DemoTabLayout } from "../../src/main/demo/demo-layout";
import { HerdrClient } from "../../src/main/herdr/client";
import type { HerdrHostBackend } from "../../src/main/herdr/backend";
import type { HerdrTransport } from "../../src/main/herdr/transport";
import { decodeSessionTopology, type SessionTopology } from "../../src/main/herdr/wire";

type Json = Record<string, unknown>;

export interface LivePane {
  terminal: string;
  /** The agent running there ("claude"), or null for a shell. */
  agent: string | null;
  session: string | null;
}

export interface LiveTab {
  readonly workspaceId: string;
  layout: DemoTabLayout;
}

export class LiveHerdr implements HerdrTransport {
  readonly sent: { method: string; params: Json }[] = [];
  readonly tabs = new Map<string, LiveTab>();
  readonly panes = new Map<string, LivePane>();
  readonly client = new HerdrClient(this);
  /** Awaited inside pane.split before the pane is made (to overlap two splits). */
  splitGate: (() => Promise<void>) | null = null;
  /** session.snapshot fails (the machine stopped answering). */
  offline = false;
  /** agent.start is refused. */
  refuseStart = false;
  /**
   * The backend's command connection (fix 3, 1a: HerdrHostBackend.connectionEpoch): a test
   * sets the next number for a reconnect that every snapshot survived; null while none is held.
   */
  epoch: number | null = 1;
  /** Runs after a request's answer is made, before it is returned (to drop a connection mid-check). */
  afterAnswer: ((method: string) => void) | null = null;
  private serial = 0;

  /** A tab of `paneIds` (Herdr's arrangement for panes split in turn); each pane a shell unless `agents` names it. */
  addTab(tabId: string, paneIds: readonly string[], agents: Readonly<Record<string, string>> = {}, workspaceId = "w1"): void {
    this.tabs.set(tabId, { workspaceId, layout: { root: defaultTree(paneIds), zoomed: false, focused: paneIds[0]! } });
    for (const paneId of paneIds) {
      const agent = agents[paneId] ?? null;
      this.panes.set(paneId, { terminal: `term-${paneId}`, agent, session: agent === null ? null : `session-${paneId}` });
    }
  }

  /** A pane added to the tab by someone else (Herdr's TUI, another client): the app's cached snapshot does not know. */
  splitBehind(tabId: string, target: string, newPaneId: string): void {
    const tab = this.tabs.get(tabId)!;
    tab.layout = { ...tab.layout, root: splitLeaf(tab.layout.root, target, "right", newPaneId) };
    this.panes.set(newPaneId, { terminal: `term-${newPaneId}`, agent: null, session: null });
  }

  tabOf(paneId: string): string | null {
    for (const [tabId, tab] of this.tabs) if (treePanes(tab.layout.root).includes(paneId)) return tabId;
    return null;
  }

  /** The tab's panes now. */
  tabPanes(tabId: string): string[] {
    const tab = this.tabs.get(tabId);
    return tab === undefined ? [] : treePanes(tab.layout.root);
  }

  /** The mutations sent (the reads left out: pane.layout, agent.list, session.snapshot). */
  mutations(): string[] {
    const reads = new Set(["pane.layout", "agent.list", "session.snapshot"]);
    return this.sent.filter((request) => !reads.has(request.method)).map((request) => request.method);
  }

  topology(): SessionTopology {
    return decodeSessionTopology(this.topologyJson());
  }

  /** session.snapshot's `snapshot`, as Herdr sends it. */
  topologyJson(): Json {
    const tabs = [...this.tabs.entries()];
    const panes = tabs.flatMap(([tabId, tab]) =>
      treePanes(tab.layout.root).map((paneId) => {
        const pane = this.panes.get(paneId)!;
        return {
          pane_id: paneId,
          terminal_id: pane.terminal,
          workspace_id: tab.workspaceId,
          tab_id: tabId,
          focused: tab.layout.focused === paneId,
          cwd: "/fixture",
          ...(pane.agent === null ? {} : { agent: pane.agent }),
          agent_status: pane.agent === null ? "unknown" : "idle",
          revision: 1,
        };
      }),
    );
    const workspaces = [...new Set(tabs.map(([, tab]) => tab.workspaceId))];
    return {
      version: "0.9.5",
      protocol: 22,
      workspaces: workspaces.map((workspaceId, index) => ({
        workspace_id: workspaceId,
        number: index + 1,
        label: workspaceId,
        focused: index === 0,
        pane_count: panes.filter((pane) => pane.workspace_id === workspaceId).length,
        tab_count: tabs.filter(([, tab]) => tab.workspaceId === workspaceId).length,
        active_tab_id: tabs.find(([, tab]) => tab.workspaceId === workspaceId)![0],
        agent_status: "idle",
      })),
      tabs: tabs.map(([tabId, tab], index) => ({
        tab_id: tabId,
        workspace_id: tab.workspaceId,
        number: index + 1,
        label: tabId,
        focused: index === 0,
        pane_count: treePanes(tab.layout.root).length,
        agent_status: "idle",
      })),
      panes,
      layouts: [],
      agents: this.agentsJson(),
    };
  }

  /** The machine as HostRegistry and the services see it. */
  backend(): HerdrHostBackend {
    return {
      kind: "demo",
      snapshot: async () => {
        if (this.offline) throw new Error("the machine is not answering");
        return this.topology();
      },
      paneActions: () => this.client,
      workspaceActions: () => this.client,
      connectionEpoch: () => this.epoch,
      close: () => undefined,
    } as unknown as HerdrHostBackend;
  }

  async roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: string; method: string; params?: Json };
    const reply = await this.answer(request);
    this.afterAnswer?.(request.method);
    return reply;
  }

  private async answer(request: { id: string; method: string; params?: Json }): Promise<string> {
    const params = request.params ?? {};
    this.sent.push({ method: request.method, params });
    const answer = (result: unknown) => JSON.stringify({ id: request.id, result });
    const refuse = (code: string, message: string) => JSON.stringify({ id: request.id, error: { code, message } });
    if (this.offline) throw new Error("the machine is not answering");
    switch (request.method) {
      case "session.snapshot":
        return answer({ type: "session_snapshot", snapshot: this.topologyJson() });
      case "pane.layout": {
        const tabId = this.tabOf(String(params["pane_id"]));
        if (tabId === null) return refuse("pane_not_found", "no such pane");
        const tab = this.tabs.get(tabId)!;
        return answer({ type: "pane_layout", layout: layoutJson(tabId, tab.workspaceId, tab.layout) });
      }
      case "pane.split": {
        const target = String(params["target_pane_id"]);
        const tabId = this.tabOf(target);
        if (tabId === null || this.tabs.get(tabId)!.workspaceId !== params["workspace_id"]) return refuse("pane_not_found", "no such pane");
        await this.splitGate?.();
        const tab = this.tabs.get(tabId)!;
        this.serial += 1;
        const paneId = `w1:new${this.serial}`;
        tab.layout = { ...tab.layout, root: splitLeaf(tab.layout.root, target, params["direction"] === "down" ? "down" : "right", paneId) };
        this.panes.set(paneId, { terminal: `term-${paneId}`, agent: null, session: null });
        return answer({
          type: "pane_info",
          pane: { pane_id: paneId, terminal_id: `term-${paneId}`, workspace_id: tab.workspaceId, tab_id: tabId, focused: false, agent_status: "unknown", revision: 1 },
        });
      }
      case "pane.close": {
        const paneId = String(params["pane_id"]);
        const tabId = this.tabOf(paneId);
        if (tabId === null) return refuse("pane_not_found", "no such pane");
        const tab = this.tabs.get(tabId)!;
        const root = removeLeaf(tab.layout.root, paneId);
        if (root === null) this.tabs.delete(tabId);
        else tab.layout = { ...tab.layout, root, focused: treePanes(root)[0]! };
        this.panes.delete(paneId);
        return answer({ type: "ok" });
      }
      case "pane.zoom": {
        const paneId = String(params["pane_id"]);
        const tabId = this.tabOf(paneId);
        if (tabId === null) return refuse("pane_not_found", "no such pane");
        const tab = this.tabs.get(tabId)!;
        const zoomed = params["mode"] === "on" || (params["mode"] !== "off" && !tab.layout.zoomed);
        tab.layout = { ...tab.layout, zoomed, focused: paneId };
        const layout = layoutJson(tabId, tab.workspaceId, tab.layout);
        return answer({ type: "pane_zoom", zoom: { changed: true, zoom_changed: true, focus_changed: true, pane_id: paneId, focused_pane_id: paneId, zoomed, layout } });
      }
      case "layout.set_split_ratio": {
        const tabId = String(params["tab_id"]);
        const tab = this.tabs.get(tabId);
        if (tab === undefined) return refuse("tab_not_found", "no such tab");
        const root = setRatioAt(tab.layout.root, params["path"] as boolean[], Number(params["ratio"]));
        if (root === null) return refuse("invalid_params", "no split at that path");
        tab.layout = { ...tab.layout, root };
        return answer({
          type: "layout_split_ratio_set",
          layout: { workspace_id: tab.workspaceId, tab_id: tabId, zoomed: tab.layout.zoomed, focused_pane_id: tab.layout.focused, root: describeTree(root) },
        });
      }
      case "agent.list":
        return answer({ type: "agent_list", agents: this.agentsJson() });
      case "agent.start": {
        const paneId = String(params["pane_id"]);
        const pane = this.panes.get(paneId);
        if (pane === undefined) return refuse("pane_not_found", "no such pane");
        if (this.refuseStart) return refuse("agent_not_ready", "refused");
        pane.agent = String(params["kind"]);
        pane.session = `session-${paneId}`;
        return answer({ type: "agent_started", agent: this.agentJson(paneId, String(params["name"])) });
      }
      case "pane.send_input":
        return answer({ type: "ok" });
      default:
        return refuse("unknown_method", `not in this fake: ${request.method}`);
    }
  }

  close(): void {}

  private agentJson(paneId: string, name?: string): Json {
    const pane = this.panes.get(paneId)!;
    return {
      pane_id: paneId,
      name: name ?? pane.agent,
      agent: pane.agent,
      agent_status: "idle",
      terminal_id: pane.terminal,
      interactive_ready: true,
      ...(pane.session === null ? {} : { agent_session: { source: `herdr:${pane.agent}`, agent: pane.agent, kind: "id", value: pane.session } }),
    };
  }

  private agentsJson(): Json[] {
    return [...this.tabs.values()]
      .flatMap((tab) => treePanes(tab.layout.root))
      .filter((paneId) => this.panes.get(paneId)?.agent !== null)
      .map((paneId) => this.agentJson(paneId));
  }
}
