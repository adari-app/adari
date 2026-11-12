// Golden tests: the repo's protocol 22 fixtures (copied from HerdrKit's tests,
// kept in sync by fixtures-sync.test.ts) decode through the TS decoders and the
// TS HerdrClient to exactly what HerdrKit's tests expect, field by field.
// Sources of the expectations:
//   OfficialCompanionTests.testOfficialAgentListDecodesWithoutForkFields
//   OfficialCompanionTests.testOfficialSessionSnapshotDecodesWorkspaceTabsAndPlainPanes
//   MockWireFixtureTests.testMockAgentListDecodesRealisticStatuses
//   SidebarFixture (the user's 0.9.5 server) via SidebarModelTests' topology

import { describe, expect, it } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { DecodingError } from "../src/main/herdr/decode";
import type { HerdrTransport } from "../src/main/herdr/transport";
import {
  APIError,
  agentDisplayName,
  agentIdentity,
  decodeAgentInfo,
  decodeReply,
  decodeSessionTopology,
  decodeTopologyPaneInfo,
  effectiveCWD,
  ignoreResult,
  isAgentPane,
  isArchived,
  isAwaitingMenuInput,
} from "../src/main/herdr/wire";
import { readFixture } from "./support/swift-fixtures";

class FixtureTransport implements HerdrTransport {
  readonly requests: string[] = [];
  constructor(private readonly reply: string) {}
  roundTrip(requestLine: string): Promise<string> {
    this.requests.push(requestLine);
    return Promise.resolve(this.reply);
  }
  close(): void {}
}

function sidebarTopologyJSON(agentsJSON = "[]"): string {
  // SidebarFixture.topology: the three lists as one snapshot.
  return (
    '{"version":"0.9.5","protocol":22,"workspaces":' +
    readFixture("protocol22/sidebar-workspaces.json") +
    ',"tabs":' +
    readFixture("protocol22/sidebar-tabs.json") +
    ',"panes":' +
    readFixture("protocol22/sidebar-panes.json") +
    ',"layouts":[],"agents":' +
    agentsJSON +
    "}"
  );
}

describe("official agent.list (OfficialCompanionTests)", () => {
  it("decodes without the fork's fields", async () => {
    const transport = new FixtureTransport(readFixture("protocol22/official-agent-list.json"));
    const agents = await new HerdrClient(transport).agentList();

    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.terminalID).toBe("t-01");
    expect(agentDisplayName(agent)).toBe("reviewer");
    expect(agent.agent).toBe("codex");
    expect(agent.agentStatus).toBe("working");
    expect(agent.composer).toBeUndefined();
    expect(agent.sessionTransfer).toBeUndefined();
    // Every field HerdrKit's AgentInfo reads, and nothing it does not.
    expect(agent).toEqual({
      agent: "codex",
      agentStatus: "working",
      inputPending: undefined,
      inputPromptKind: undefined,
      name: "reviewer",
      paneID: "p1",
      tabID: "t1",
      workspaceID: "w1",
      terminalID: "t-01",
      terminalTitleStripped: "Codex",
      cwd: "/tmp/project",
      focused: true,
      interactiveReady: true,
      launchPending: undefined,
      composer: undefined,
      revision: 12,
      stateChangeSeq: 9,
      statusSinceUnixMs: undefined,
      turn: undefined,
      turnEpoch: undefined,
      lastCompletedTurn: undefined,
      completionSeq: undefined,
      agentSession: undefined,
      machineID: undefined,
      reachability: undefined,
      lastKnownStatus: undefined,
      archived: undefined,
      account: undefined,
      accountConfigDir: undefined,
      accountUnresolved: undefined,
      sessionTransfer: undefined,
    });
    expect(agentIdentity(agent)).toBe("p1");
    // The request the client sent: HerdrClient's envelope and id scheme.
    expect(transport.requests).toEqual(['{"id":"herdrkit:agent.list:1","method":"agent.list","params":{}}']);
  });
});

describe("official session.snapshot (OfficialCompanionTests)", () => {
  it("decodes workspaces, tabs and plain panes", async () => {
    const transport = new FixtureTransport(readFixture("protocol22/official-session-snapshot.json"));
    const topology = await new HerdrClient(transport).sessionTopology();

    expect(topology.version).toBe("0.9.0");
    expect(topology.protocolVersion).toBe(22);
    expect(topology.workspaces[0]?.label).toBe("Mobile work");
    expect(topology.tabs[0]?.workspaceID).toBe("w1");
    expect(topology.panes[0]?.terminalID).toBe("term plain");
    expect(effectiveCWD(topology.panes[0]!)).toBe("/tmp/actual folder");
    expect(isAgentPane(topology.panes[0]!)).toBe(false);
    expect(isAgentPane(topology.panes[1]!)).toBe(true);

    expect(topology.focusedWorkspaceID).toBe("w1");
    expect(topology.focusedTabID).toBe("w1:t1");
    expect(topology.focusedPaneID).toBe("w1:p1");
    expect(topology.workspaces).toEqual([
      {
        workspaceID: "w1",
        number: 1,
        label: "Mobile work",
        focused: true,
        paneCount: 2,
        tabCount: 1,
        activeTabID: "w1:t1",
        agentStatus: "working",
      },
    ]);
    expect(topology.tabs).toEqual([
      {
        tabID: "w1:t1",
        workspaceID: "w1",
        number: 1,
        label: "shells",
        focused: true,
        paneCount: 2,
        agentStatus: "working",
      },
    ]);
    expect(topology.panes).toEqual([
      {
        paneID: "w1:p1",
        terminalID: "term plain",
        workspaceID: "w1",
        tabID: "w1:t1",
        focused: true,
        cwd: "/tmp/requested",
        foregroundCWD: "/tmp/actual folder",
        label: "plain shell",
        agent: undefined,
        title: undefined,
        terminalTitleStripped: undefined,
        displayAgent: undefined,
        agentStatus: "unknown",
        revision: 3,
      },
      {
        paneID: "w1:p2",
        terminalID: "term-agent",
        workspaceID: "w1",
        tabID: "w1:t1",
        focused: false,
        cwd: "/tmp",
        foregroundCWD: undefined,
        label: undefined,
        agent: "codex",
        title: undefined,
        terminalTitleStripped: undefined,
        displayAgent: "Codex",
        agentStatus: "working",
        revision: 4,
      },
    ]);
    expect(topology.agents).toEqual([]);
    expect(transport.requests).toEqual(['{"id":"herdrkit:session.snapshot:1","method":"session.snapshot","params":{}}']);
  });
});

describe("mock agent.list (MockWireFixtureTests)", () => {
  it("decodes realistic statuses", async () => {
    const agents = await new HerdrClient(new FixtureTransport(readFixture("protocol22/mock-agent-list.json"))).agentList();

    expect(agents).toHaveLength(10);
    expect(agents.filter(isArchived)).toHaveLength(1);
    const first = agents[0]!;
    expect(first.paneID).toBe("w1:p1");
    expect(agentDisplayName(first)).toBe("beacon");
    expect(first.agent).toBe("claude");
    expect(first.cwd).toBe("/root/phone-app");
    expect(first.agentStatus).toBe("blocked");
    const known = new Set(["idle", "working", "blocked", "done", "unknown"]);
    for (const agent of agents) expect(known.has(agent.agentStatus ?? "idle")).toBe(true);

    // The fields the mock exercises beyond the first row.
    expect(agents.map((a) => a.name)).toEqual([
      "beacon",
      "bookshop",
      "trendline",
      "herdr-tools",
      "crm-sync",
      "stock-screener",
      "discovery",
      "bank-check",
      "air-box/air-box",
      "flatfinder",
    ]);
    expect(agents.filter(isAwaitingMenuInput).map((a) => a.paneID)).toEqual(["w1:p1", "w1:p2"]);
    expect(agents[3]).toMatchObject({ account: "claude-alt", accountConfigDir: "/root/.claude-9" });
    expect(agents[4]).toMatchObject({ account: "retired-account", accountUnresolved: true });
    expect(agents[8]).toMatchObject({
      paneID: "air-box/w1:p9",
      agentStatus: "unknown",
      lastKnownStatus: "blocked",
      machineID: "air-box",
      reachability: "degraded",
    });
    expect(agents[9]?.archived).toEqual({ at: "2026-08-26T18:00:00Z", by: "lena", reason: "parked for the weekend" });
  });
});

describe("a real 0.9.5 server (SidebarFixture)", () => {
  const topology = decodeSessionTopology(JSON.parse(sidebarTopologyJSON()));

  it("decodes every workspace, tab and pane", () => {
    expect(topology.version).toBe("0.9.5");
    expect(topology.protocolVersion).toBe(22);
    expect(topology.workspaces.map((w) => w.label)).toEqual([
      "notes",
      "Quartz",
      "Atelier",
      "Sundial",
      "herdr-companion",
      "Meterbox",
      "Inkwell",
      "Starling",
      "Bellhop",
      "Harbor",
      "Tidepool",
    ]);
    expect(topology.tabs).toHaveLength(16);
    expect(topology.panes).toHaveLength(19);
    // Each workspace's pane_count is the panes that name it.
    for (const workspace of topology.workspaces) {
      expect(topology.panes.filter((p) => p.workspaceID === workspace.workspaceID)).toHaveLength(Number(workspace.paneCount));
    }
    // 18 agents and one shell (w8:p1, reporting unknown).
    expect(topology.panes.filter(isAgentPane)).toHaveLength(18);
    const shell = topology.panes.find((p) => p.paneID === "w8:p1")!;
    expect(isAgentPane(shell)).toBe(false);
    expect(shell.agentStatus).toBe("unknown");
    expect(effectiveCWD(shell)).toBe("/Users/demo/code/meterbox");
    const labelled = topology.panes.find((p) => p.paneID === "w7:p1G")!;
    expect(labelled.label).toBe("aurora-web-mac · opus");
    expect(labelled.agent).toBe("claude");
    expect(labelled.agentStatus).toBe("working");
  });
});

describe("decoding rules (Swift Decodable semantics)", () => {
  it("surfaces a server error object as APIError", () => {
    const line = '{"id":"x","error":{"code":"pane_not_found","message":"no pane w9:p9"}}';
    expect(() => decodeReply(line, ignoreResult)).toThrow(APIError);
    try {
      decodeReply(line, ignoreResult);
    } catch (error) {
      expect(error).toMatchObject({ code: "pane_not_found", serverMessage: "no pane w9:p9" });
    }
  });

  it("accepts any result for calls that ignore it, but requires the key", () => {
    expect(() => decodeReply('{"id":"x","result":null}', ignoreResult)).not.toThrow();
    expect(() => decodeReply('{"id":"x","result":{"type":"ok"}}', ignoreResult)).not.toThrow();
    expect(() => decodeReply('{"id":"x"}', ignoreResult)).toThrow(DecodingError);
    expect(() => decodeReply("not json", ignoreResult)).toThrow(DecodingError);
  });

  it("treats a missing or null optional as absent and a wrong type as an error", () => {
    expect(decodeAgentInfo({ pane_id: "p", name: null }).name).toBeUndefined();
    expect(() => decodeAgentInfo({ pane_id: "p", name: 3 })).toThrow(DecodingError);
    expect(() => decodeAgentInfo({ name: "no pane" })).toThrow(DecodingError);
  });

  it("requires every TopologyPaneInfo field Swift requires", () => {
    const pane = {
      pane_id: "p",
      terminal_id: "t",
      workspace_id: "w",
      tab_id: "w:t",
      focused: false,
      agent_status: "idle",
      revision: 0,
    };
    expect(decodeTopologyPaneInfo(pane).paneID).toBe("p");
    for (const key of Object.keys(pane)) {
      const partial: Record<string, unknown> = { ...pane };
      delete partial[key];
      expect(() => decodeTopologyPaneInfo(partial)).toThrow(DecodingError);
    }
    expect(() => decodeTopologyPaneInfo({ ...pane, revision: -1 })).toThrow(DecodingError);
  });

  it("raises a pane with a pending menu to awaiting input", () => {
    expect(isAwaitingMenuInput({ paneID: "p", agentStatus: "working", inputPending: true })).toBe(true);
    expect(isAwaitingMenuInput({ paneID: "p", agentStatus: "blocked" })).toBe(true);
    expect(isAwaitingMenuInput({ paneID: "p", agentStatus: "idle", inputPending: false })).toBe(false);
  });

  it("keys an archived agent (no pane) on its terminal id", () => {
    expect(agentIdentity({ paneID: "", terminalID: "term-1", name: "n" })).toBe("term-1");
    expect(agentIdentity({ paneID: "", name: "n" })).toBe("n");
  });
});
