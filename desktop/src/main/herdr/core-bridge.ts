// herdr-core behind the app's own transport seam (the Swift client's
// CoreBridgeTransport.swift, CoreTUIWire.swift). HerdrClient writes protocol 22
// request lines (Herdr's TUI server API); this transport answers them from the
// core: reads from the live subscription's model (CoreFollower), actions as
// herdr-core calls (core-actions.ts). So HerdrClient, and with it the sidebar,
// the needs-you list, Chat and the box, run unchanged against either kind of
// Herdr. A method herdr-core has no counterpart for is refused the way an older
// Herdr refuses a method it does not know (`invalid_request`, "unknown variant
// `<method>`"), which the app already treats as "this Herdr cannot do that".

import { coreJSONString, jsonString, member, tryParseCoreJSON, type CoreJSON } from "./core-json";
import { CoreRPCError } from "./core-connection";
import type { CoreFollower } from "./core-follower";
import type { HerdrTransport } from "./transport";
import { APIError, type AgentInfo, type SessionTopology, type TabInfo, type TopologyPaneInfo, type WorkspaceInfo } from "./wire";

/** A request line, read leniently: id, method and params. */
export interface BridgeRequest {
  readonly id: CoreJSON;
  readonly method: string;
  readonly params: CoreJSON;
}

export function parseBridgeRequest(line: string): BridgeRequest {
  const json = tryParseCoreJSON(line);
  const method = jsonString(member(json, "method"));
  if (json === undefined || method === undefined) throw new APIError("invalid_request", "not a request line");
  return { id: member(json, "id") ?? null, method, params: member(json, "params") ?? {} };
}

export function unknownMethod(method: string): APIError {
  return new APIError("invalid_request", `unknown variant \`${method}\`: herdr-core (Herdr App) has no such method`);
}

/** herdr-core's error as the app's: its `data.kind` is the code (with its hint in the message), so a refusal reads as Herdr's would. */
export function coreApiError(error: CoreRPCError): APIError {
  const code = error.kind === "not_found" ? "pane_not_found" : (error.kind ?? "core_error");
  return new APIError(code, error.description);
}

export function errorLine(id: CoreJSON, error: APIError): string {
  return coreJSONString({ id, error: { code: error.code, message: error.serverMessage } });
}

/** The protocol 22 shapes HerdrClient decodes, written from the app's own types; a missing field is left out, as the server does. */
export const CoreTUIWire = {
  workspace(w: WorkspaceInfo): CoreJSON {
    return {
      workspace_id: w.workspaceID,
      number: w.number,
      label: w.label,
      focused: w.focused,
      pane_count: w.paneCount,
      tab_count: w.tabCount,
      active_tab_id: w.activeTabID,
      agent_status: w.agentStatus,
    };
  },

  tab(t: TabInfo): CoreJSON {
    return {
      tab_id: t.tabID,
      workspace_id: t.workspaceID,
      number: t.number,
      label: t.label,
      focused: t.focused,
      pane_count: t.paneCount,
      agent_status: t.agentStatus,
    };
  },

  pane(p: TopologyPaneInfo): CoreJSON {
    return without({
      pane_id: p.paneID,
      terminal_id: p.terminalID,
      workspace_id: p.workspaceID,
      tab_id: p.tabID,
      focused: p.focused,
      agent_status: p.agentStatus,
      revision: p.revision,
      cwd: p.cwd,
      foreground_cwd: p.foregroundCWD,
      label: p.label,
      agent: p.agent,
      title: p.title,
      terminal_title_stripped: p.terminalTitleStripped,
      display_agent: p.displayAgent,
    });
  },

  agent(a: AgentInfo): CoreJSON {
    return without({
      pane_id: a.paneID,
      agent: a.agent,
      agent_status: a.agentStatus,
      input_pending: a.inputPending,
      input_prompt_kind: a.inputPromptKind,
      name: a.name,
      tab_id: a.tabID,
      workspace_id: a.workspaceID,
      terminal_id: a.terminalID,
      terminal_title_stripped: a.terminalTitleStripped,
      cwd: a.cwd,
      focused: a.focused,
      interactive_ready: a.interactiveReady,
      launch_pending: a.launchPending,
      revision: a.revision,
      state_change_seq: a.stateChangeSeq,
      status_since_unix_ms: a.statusSinceUnixMs,
      turn: a.turn,
      completion_seq: a.completionSeq,
      machine_id: a.machineID,
      reachability: a.reachability,
      last_known_status: a.lastKnownStatus,
      agent_session:
        a.agentSession === undefined
          ? undefined
          : { source: a.agentSession.source, agent: a.agentSession.agent, kind: a.agentSession.kind, value: a.agentSession.value },
      // A session found by folder, with its run and the folder it was proved in, kept over the wire.
      core_found:
        a.coreFound === undefined
          ? undefined
          : without({
              source: a.coreFound.source,
              agent: a.coreFound.agent,
              kind: a.coreFound.kind,
              value: a.coreFound.value,
              found_by: a.coreFound.foundBy,
              found_in: a.coreFound.foundIn,
            }),
    });
  },

  topology(t: SessionTopology): CoreJSON {
    return without({
      version: t.version,
      protocol: t.protocolVersion,
      workspaces: t.workspaces.map((w) => CoreTUIWire.workspace(w)),
      tabs: t.tabs.map((tab) => CoreTUIWire.tab(tab)),
      panes: t.panes.map((p) => CoreTUIWire.pane(p)),
      agents: t.agents.map((a) => CoreTUIWire.agent(a)),
      focused_workspace_id: t.focusedWorkspaceID,
      focused_tab_id: t.focusedTabID,
      focused_pane_id: t.focusedPaneID,
    });
  },
};

function without(record: Record<string, CoreJSON | undefined>): CoreJSON {
  const out: Record<string, CoreJSON> = {};
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value;
  return out;
}

/** The core's answer to one action request (null: not an action this bridge knows). */
export type CoreActionHandler = (request: BridgeRequest) => Promise<CoreJSON | null>;

export class CoreBridgeTransport implements HerdrTransport {
  constructor(
    readonly follower: CoreFollower,
    private readonly act: CoreActionHandler = () => Promise.resolve(null),
  ) {}

  async roundTrip(requestLine: string): Promise<string> {
    let request: BridgeRequest;
    try {
      request = parseBridgeRequest(requestLine);
    } catch (error) {
      if (error instanceof APIError) return errorLine(null, error);
      throw error;
    }
    try {
      const result = await this.answer(request);
      return coreJSONString({ id: request.id, result });
    } catch (error) {
      if (error instanceof APIError) return errorLine(request.id, error);
      if (error instanceof CoreRPCError) return errorLine(request.id, coreApiError(error));
      throw error;
    }
  }

  /** The follower owns the connection; the backend closes it. */
  close(): void {}

  connectionEpoch(): number | null {
    return this.follower.epoch;
  }

  async answer(request: BridgeRequest): Promise<CoreJSON> {
    switch (request.method) {
      case "session.snapshot":
        return { snapshot: CoreTUIWire.topology((await this.follower.snapshot()).topology) };
      case "agent.list":
        return { agents: (await this.follower.snapshot()).agents.map((agent) => CoreTUIWire.agent(agent)) };
      case "ping": {
        const connection = await this.follower.connection();
        return { version: connection.hello.version, core: true };
      }
      default: {
        const answer = await this.act(request);
        if (answer !== null) return answer;
        throw unknownMethod(request.method);
      }
    }
  }
}
