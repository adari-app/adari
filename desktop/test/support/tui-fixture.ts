// A Herdr TUI server for the host tests (as the iPhone app's
// CoreHostTests.swift's TUIFixtureTransport). It answers `session.snapshot`
// and `agent.list` from the user's real 0.9.5 lists (sidebar-fixture.ts),
// records every request, and fails every round trip with `failure` when set.

import type { HerdrTransport, RoundTripOptions } from "../../src/main/herdr/transport";
import { readFixture } from "./swift-fixtures";

export class TUIFixtureTransport implements HerdrTransport {
  static readonly snapshotResult =
    '{"snapshot":{"version":"0.9.5","protocol":22,"workspaces":' +
    readFixture("protocol22/sidebar-workspaces.json") +
    ',"tabs":' +
    readFixture("protocol22/sidebar-tabs.json") +
    ',"panes":' +
    readFixture("protocol22/sidebar-panes.json") +
    ',"layouts":[],"agents":[]}}';

  static readonly agentsResult =
    '{"agents":[{"pane_id":"w7:p1","agent":"claude","agent_status":"working","workspace_id":"w7","tab_id":"w7:t1","terminal_id":"term_65efccd90520f9"}]}';

  readonly requests: string[] = [];
  /** When set, every round trip fails with it (no socket, a failed host). */
  failure: Error | null = null;
  closes = 0;
  epoch: number | null = 1;

  get methods(): string[] {
    return this.requests.map((line) => (JSON.parse(line) as { method?: string }).method ?? "");
  }

  roundTrip(requestLine: string, _options?: RoundTripOptions): Promise<string> {
    this.requests.push(requestLine);
    if (this.failure !== null) return Promise.reject(this.failure);
    const request = JSON.parse(requestLine) as { id?: unknown; method?: string };
    const id = JSON.stringify(request.id ?? null);
    switch (request.method) {
      case "session.snapshot":
        return Promise.resolve(`{"id":${id},"result":${TUIFixtureTransport.snapshotResult}}`);
      case "agent.list":
        return Promise.resolve(`{"id":${id},"result":${TUIFixtureTransport.agentsResult}}`);
      default:
        return Promise.resolve(`{"id":${id},"result":null}`);
    }
  }

  close(): void {
    this.closes += 1;
  }

  connectionEpoch(): number | null {
    return this.epoch;
  }
}
