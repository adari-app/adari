// Integers from the wire are checked against the width
// of the Swift field they decode into (UInt32, UInt64, Int/Int64: Swift's Int is
// 64-bit here), and kept exact: JSON.parse rounds any integer beyond 2^53, so
// two counters one apart would compare equal and a value past the field's
// range would be accepted after rounding. A safe integer stays a number; a
// wider one is a bigint (never rounded). Number.isSafeInteger alone would be
// wrong: it refuses valid UInt64 and Int values above 2^53.
//
// The JSON here is text with the literals spliced in raw, so they reach the
// parser exactly as a server would send them.

import { describe, expect, it } from "vitest";

import { DecodingError, parseJsonLine } from "../src/main/herdr/decode";
import {
  decodeAgentInfo,
  decodeReply,
  decodeSessionSnapshotResult,
  decodeSessionTopology,
  decodeTabInfo,
  decodeTopologyPaneInfo,
  decodeWorkspaceInfo,
} from "../src/main/herdr/wire";
import { buildSidebarModel, sidebarInputFromTopology } from "../src/shared/sidebar-model";

type Width = "UInt32" | "UInt64" | "Int64";

const workspace = (field: string, n: string): string =>
  JSON.stringify({ workspace_id: "w1", number: 1, label: "api", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }).replace(
    `"${field}":1`,
    `"${field}":${n}`,
  );
const tab = (field: string, n: string): string =>
  JSON.stringify({ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" }).replace(
    `"${field}":1`,
    `"${field}":${n}`,
  );
const agent = (fields: string): string => `{"pane_id":"w1:p1",${fields}}`;
const transfer = (fields: string): string =>
  agent(`"session_transfer":{"id":"t1","source":"claude","target":"codex","phase":"done",${fields}}`);
const omission = (key: string) => (n: string) =>
  decodeAgentInfo(parseJsonLine(transfer(`"message_count":1,"omissions":{"${key}":${n}}`))).sessionTransfer?.omissions;

/** Every integer field the TS decoders read, with the Swift type that bounds it (Sources/HerdrKit/Wire.swift). */
const fields: { name: string; width: Width; read: (literal: string) => unknown }[] = [
  {
    name: "snapshot.protocol (UInt32)",
    width: "UInt32",
    read: (n) => decodeSessionTopology(parseJsonLine(`{"version":"0.9.5","protocol":${n},"workspaces":[],"tabs":[],"panes":[],"agents":[]}`)).protocolVersion,
  },
  { name: "workspace.number (Int)", width: "Int64", read: (n) => decodeWorkspaceInfo(parseJsonLine(workspace("number", n))).number },
  { name: "workspace.pane_count (Int)", width: "Int64", read: (n) => decodeWorkspaceInfo(parseJsonLine(workspace("pane_count", n))).paneCount },
  { name: "workspace.tab_count (Int)", width: "Int64", read: (n) => decodeWorkspaceInfo(parseJsonLine(workspace("tab_count", n))).tabCount },
  { name: "tab.number (Int)", width: "Int64", read: (n) => decodeTabInfo(parseJsonLine(tab("number", n))).number },
  { name: "tab.pane_count (Int)", width: "Int64", read: (n) => decodeTabInfo(parseJsonLine(tab("pane_count", n))).paneCount },
  {
    name: "pane.revision (UInt64)",
    width: "UInt64",
    read: (n) =>
      decodeTopologyPaneInfo(
        parseJsonLine(`{"pane_id":"w1:p1","terminal_id":"t","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"idle","revision":${n}}`),
      ).revision,
  },
  { name: "agent.revision (Int)", width: "Int64", read: (n) => decodeAgentInfo(parseJsonLine(agent(`"revision":${n}`))).revision },
  { name: "agent.state_change_seq (UInt64)", width: "UInt64", read: (n) => decodeAgentInfo(parseJsonLine(agent(`"state_change_seq":${n}`))).stateChangeSeq },
  {
    name: "agent.status_since_unix_ms (UInt64)",
    width: "UInt64",
    read: (n) => decodeAgentInfo(parseJsonLine(agent(`"status_since_unix_ms":${n}`))).statusSinceUnixMs,
  },
  { name: "agent.turn (Int)", width: "Int64", read: (n) => decodeAgentInfo(parseJsonLine(agent(`"turn":${n}`))).turn },
  { name: "agent.turn_epoch (UInt64)", width: "UInt64", read: (n) => decodeAgentInfo(parseJsonLine(agent(`"turn_epoch":${n}`))).turnEpoch },
  { name: "agent.completion_seq (UInt64)", width: "UInt64", read: (n) => decodeAgentInfo(parseJsonLine(agent(`"completion_seq":${n}`))).completionSeq },
  {
    name: "agent.last_completed_turn.turn (Int)",
    width: "Int64",
    read: (n) => decodeAgentInfo(parseJsonLine(agent(`"last_completed_turn":{"turn":${n}}`))).lastCompletedTurn?.turn,
  },
  {
    name: "agent.last_completed_turn.turn_epoch (UInt64)",
    width: "UInt64",
    read: (n) => decodeAgentInfo(parseJsonLine(agent(`"last_completed_turn":{"turn_epoch":${n}}`))).lastCompletedTurn?.turnEpoch,
  },
  {
    name: "agent.last_completed_turn.completed_unix_ms (Int64)",
    width: "Int64",
    read: (n) => decodeAgentInfo(parseJsonLine(agent(`"last_completed_turn":{"completed_unix_ms":${n}}`))).lastCompletedTurn?.completedUnixMs,
  },
  {
    name: "agent.session_transfer.message_count (UInt64)",
    width: "UInt64",
    read: (n) => decodeAgentInfo(parseJsonLine(transfer(`"message_count":${n},"omissions":{}`))).sessionTransfer?.messageCount,
  },
  ...(
    [
      ["tool_records", "toolRecords"],
      ["reasoning_records", "reasoningRecords"],
      ["system_records", "systemRecords"],
      ["attachment_records", "attachmentRecords"],
      ["metadata_records", "metadataRecords"],
      ["unsupported_blocks", "unsupportedBlocks"],
      ["sidechain_records", "sidechainRecords"],
    ] as const
  ).map(([key, property]) => ({
    name: `agent.session_transfer.omissions.${key} (UInt64)`,
    width: "UInt64" as const,
    read: (n: string) => omission(key)(n)?.[property],
  })),
];

/** In range: the literal and the exact value it must decode to (a number when safe, else a bigint). */
const accepted: Record<Width, readonly (readonly [string, number | bigint])[]> = {
  UInt32: [
    ["0", 0],
    ["22", 22],
    ["4294967295", 4294967295],
  ],
  UInt64: [
    ["0", 0],
    ["9007199254740991", 9007199254740991],
    ["9007199254740992", 9007199254740992n],
    ["9007199254740993", 9007199254740993n],
    ["18446744073709551615", 18446744073709551615n],
  ],
  Int64: [
    ["-1", -1],
    ["0", 0],
    ["9007199254740993", 9007199254740993n],
    ["-9007199254740993", -9007199254740993n],
    ["9223372036854775807", 9223372036854775807n],
    ["-9223372036854775808", -9223372036854775808n],
  ],
};

/** Out of range, not an integer, or a double too large to be exact. */
const refused: Record<Width, readonly string[]> = {
  UInt32: ["-1", "4294967296", "18446744073709551615", "1.5", "1e100"],
  UInt64: ["-1", "18446744073709551616", "1e100", "1.5", "1e16", '"1"', "true"],
  Int64: ["9223372036854775808", "-9223372036854775809", "1e100", "-1e100", "1.5", "1e16"],
};

describe("integer fields: width and precision", () => {
  for (const field of fields) {
    it(`${field.name}: in range decodes exactly, out of range or inexact is refused`, () => {
      for (const [literal, value] of accepted[field.width]) expect(field.read(literal), literal).toBe(value);
      for (const literal of refused[field.width]) expect(() => field.read(literal), literal).toThrow(DecodingError);
    });
  }
});

describe("parseJsonLine", () => {
  it("keeps integers beyond 2^53 exact as bigints and leaves the rest as numbers", () => {
    const value = parseJsonLine(
      '{"a":9007199254740993,"b":9007199254740991,"c":0.1,"d":1e100,"e":[18446744073709551615],"f":-9223372036854775808,"g":-0}',
    ) as Record<string, unknown>;
    expect(value["a"]).toBe(9007199254740993n);
    expect(value["b"]).toBe(9007199254740991);
    expect(value["c"]).toBe(0.1);
    expect(value["d"]).toBe(1e100);
    expect(value["e"]).toEqual([18446744073709551615n]);
    expect(value["f"]).toBe(-9223372036854775808n);
    expect(value["g"]).toBe(-0);
  });

  it("keeps two counters one apart above 2^53 distinct and ordered", () => {
    const a = decodeAgentInfo(parseJsonLine(agent('"completion_seq":9007199254740992,"state_change_seq":18446744073709551614'))).completionSeq!;
    const b = decodeAgentInfo(parseJsonLine(agent('"completion_seq":9007199254740993,"state_change_seq":18446744073709551615'))).completionSeq!;
    expect(a === b).toBe(false);
    expect(a < b).toBe(true);
  });
});

/** A snapshot reply line: one tab per workspace, one Claude agent (blocked) or shell per pane. */
function snapshotLine(workspaces: { id: string; number: string; panes: { id: string; since?: string }[] }[]): string {
  const ws = workspaces.map(
    (w) =>
      `{"workspace_id":"${w.id}","number":${w.number},"label":"${w.id}","focused":false,"pane_count":${w.panes.length},"tab_count":1,"active_tab_id":"${w.id}:t1","agent_status":"idle"}`,
  );
  const tabs = workspaces.map(
    (w) => `{"tab_id":"${w.id}:t1","workspace_id":"${w.id}","number":1,"label":"main","focused":false,"pane_count":${w.panes.length},"agent_status":"idle"}`,
  );
  const panes = workspaces.flatMap((w) =>
    w.panes.map(
      (p) =>
        `{"pane_id":"${p.id}","terminal_id":"t-${p.id}","workspace_id":"${w.id}","tab_id":"${w.id}:t1","focused":false,${p.since === undefined ? "" : '"agent":"claude",'}"agent_status":"${p.since === undefined ? "unknown" : "blocked"}","revision":1}`,
    ),
  );
  const agents = workspaces.flatMap((w) =>
    w.panes
      .filter((p) => p.since !== undefined)
      .map((p) => `{"pane_id":"${p.id}","agent":"claude","agent_status":"blocked","status_since_unix_ms":${p.since}}`),
  );
  return `{"id":"r1","result":{"snapshot":{"version":"0.9.5","protocol":22,"workspaces":[${ws.join(",")}],"tabs":[${tabs.join(",")}],"panes":[${panes.join(",")}],"agents":[${agents.join(",")}]}}}`;
}

const model = (line: string) =>
  buildSidebarModel(sidebarInputFromTopology(decodeReply(line, decodeSessionSnapshotResult), { macID: "mac", nowUnixMs: 1_800_000_000_000 }));

describe("ordering on wide values", () => {
  it("puts the newer of two status times one millisecond apart above 2^53 first", () => {
    const line = snapshotLine([
      {
        id: "w1",
        number: "1",
        panes: [
          { id: "w1:p1", since: "9007199254740992" },
          { id: "w1:p2", since: "9007199254740993" },
        ],
      },
    ]);
    expect(model(line).priorityRows.map((row) => row.paneID)).toEqual(["w1:p2", "w1:p1"]);
  });

  it("orders workspaces by number when the numbers differ only above 2^53", () => {
    const line = snapshotLine([
      { id: "w1", number: "9007199254740993", panes: [{ id: "w1:p1" }] },
      { id: "w2", number: "9007199254740992", panes: [{ id: "w2:p1" }] },
    ]);
    expect(model(line).projects.map((project) => project.header.workspaceID)).toEqual(["w2", "w1"]);
  });

  it("refuses a snapshot whose protocol does not fit a UInt32", () => {
    expect(() => decodeReply(snapshotLine([]).replace('"protocol":22', '"protocol":4294967296'), decodeSessionSnapshotResult)).toThrow(DecodingError);
  });
});
