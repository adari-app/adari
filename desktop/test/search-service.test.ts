// The main process's "Search conversations" (src/main/search/service.ts),
// ported from the Swift app's CompanionSearchModelTests: every connected
// machine is searched and its results grouped by pane (newest first), an
// offline machine gets its line, a query too short clears, a new query and the
// screen's close cancel the old commands, a machine that does not answer in
// time offers Try again, "N more" reads the rest of a pane, and a machine that
// connects is searched. End to end through the demo machine (DemoRemote
// answering the search from the fixture transcripts). Fixtures only.

import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoRemote } from "../src/main/demo/demo-remote";
import { DemoTranscriptReader, demoAgentSession, demoTranscripts, type DemoTranscript } from "../src/main/demo/demo-chat";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import { SearchService, type SearchHosts, type SearchOwner } from "../src/main/search/service";
import type { HostView } from "../src/shared/ipc-contract";
import type { RemoteCommandRunner } from "../src/shared/remote-command";
import { searchBounds } from "../src/shared/search/search";
import { statusText } from "../src/shared/search/text";
import { groupMore, groupShown, type SearchViewState } from "../src/shared/search/view";
import { user } from "./support/chat-lines";
import { SearchFakeRemote } from "./support/search-fake";

const startMs = Date.parse("2026-11-02T09:00:00.000Z");
const lighthouseSession = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e70";
/** A pane where the user asked about the lighthouse eight times (more than the 5 shown). */
const lighthouse: DemoTranscript = {
  paneID: "w7:p1L",
  agent: "claude",
  sessionID: lighthouseSession,
  path: `/Users/demo/.claude/projects/-srv-lighthouse/${lighthouseSession}.jsonl`,
  cwd: "/srv/lighthouse",
  working: false,
  lines: Array.from({ length: 8 }, (_, index) =>
    user(`Lighthouse question ${index + 1}`, `l${index + 1}`, index * 60, {
      sessionId: lighthouseSession,
    }),
  ),
};
const transcripts = [...demoTranscripts(startMs), lighthouse];
const designPane = "w7:p1H";

/** The demo Mac mini's agents, one workspace, each with its transcript named by id; a shell pane with none. */
function topology(): SessionTopology {
  const panes = transcripts.map((transcript) => ({
    pane_id: transcript.paneID,
    terminal_id: `t-${transcript.paneID}`,
    workspace_id: "w7",
    tab_id: "w7:t1",
    focused: false,
    cwd: transcript.cwd,
    agent: transcript.agent,
    agent_status: transcript.working ? "working" : "done",
    revision: 1,
  }));
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [
      {
        workspace_id: "w7",
        number: 1,
        label: "companion",
        focused: true,
        pane_count: panes.length + 2,
        tab_count: 1,
        active_tab_id: "w7:t1",
        agent_status: "working",
      },
    ],
    tabs: [
      {
        tab_id: "w7:t1",
        workspace_id: "w7",
        number: 1,
        label: "main",
        focused: true,
        pane_count: panes.length + 2,
        agent_status: "working",
      },
    ],
    panes: [
      ...panes,
      {
        pane_id: "w7:gk",
        terminal_id: "t-gk",
        workspace_id: "w7",
        tab_id: "w7:t1",
        focused: false,
        cwd: "/srv",
        agent: "grok",
        agent_status: "idle",
        revision: 1,
      },
      {
        pane_id: "w7:sh",
        terminal_id: "t-sh",
        workspace_id: "w7",
        tab_id: "w7:t1",
        focused: true,
        cwd: "/srv",
        agent_status: "unknown",
        revision: 1,
      },
    ],
    layouts: [],
    agents: [
      ...transcripts.map((transcript) => ({
        pane_id: transcript.paneID,
        agent: transcript.agent,
        agent_status: transcript.working ? "working" : "done",
        cwd: transcript.cwd,
        agent_session: demoAgentSession(transcript),
      })),
      { pane_id: "w7:gk", agent: "grok", agent_status: "idle", cwd: "/srv" },
    ],
  });
}

class FakeHosts implements SearchHosts {
  readonly views = new Map<string, HostView>();
  readonly backends = new Map<string, HerdrHostBackend>();

  add(id: string, name: string, state: HostView["state"], runner: RemoteCommandRunner | null = null): void {
    const reader = new DemoTranscriptReader(transcripts);
    const commands = runner ?? new DemoRemote(transcripts, reader, startMs);
    this.views.set(id, {
      id,
      name,
      kind: "ssh",
      address: `me@${id}:22`,
      platform: "macOS",
      state,
      error: null,
      topology: state === "connected" ? topology() : null,
      fetchedAtMs: startMs,
    });
    this.backends.set(id, {
      transcripts: () => reader,
      commands: () => commands,
    } as unknown as HerdrHostBackend);
  }
  set(id: string, state: HostView["state"]): void {
    const view = this.views.get(id)!;
    this.views.set(id, {
      ...view,
      state,
      topology: state === "connected" ? topology() : view.topology,
    });
  }
  list(): HostView[] {
    return [...this.views.values()];
  }
  backend(id: string): HerdrHostBackend | null {
    return this.backends.get(id) ?? null;
  }
}

class FakeOwner implements SearchOwner {
  readonly sent: { channel: string; state: SearchViewState }[] = [];
  destroyed = false;
  constructor(readonly id = 1) {}
  send(channel: string, payload: SearchViewState): void {
    this.sent.push({ channel, state: payload });
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

/** Waits (macrotask turns) until the window's state passes `done`. */
async function until(search: SearchService, owner: FakeOwner, done: (state: SearchViewState) => boolean, timeoutMs = 5_000): Promise<SearchViewState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = search.state(owner);
    if (done(state)) return state;
    if (Date.now() > deadline) throw new Error("no such state: " + JSON.stringify(state.statuses));
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const finished = (state: SearchViewState): boolean => state.statuses.length > 0 && state.statuses.every((status) => status.phase !== "searching");
const phases = (state: SearchViewState): string[] => state.statuses.map((status) => `${status.name}: ${status.phase}`);

afterEach(() => {
  vi.useRealTimers();
});

describe("SearchService", () => {
  it("searches every connected machine, groups the hits by pane newest first, and gives an offline machine its line", async () => {
    const hosts = new FakeHosts();
    hosts.add("mini", "Mac mini", "connected");
    hosts.add("laptop", "Laptop", "offline");
    const owner = new FakeOwner();
    const search = new SearchService(hosts, "search-update", searchBounds.timeoutMs, 0);
    search.search(owner, "column");
    expect(phases(search.state(owner))).toEqual(["Mac mini: searching", "Laptop: offline"]);
    const state = await until(search, owner, finished);
    expect(state.searched).toBe("column");
    expect(phases(state)).toEqual(["Mac mini: done", "Laptop: offline"]);
    // w7:gk and the demo's Grok pane (wD:pK): search reads no Grok session;
    // nor the demo's Cursor pane (wC:p1).
    expect(state.statuses.map(statusText)).toEqual(["Mac mini: 3 panes have no transcript to search", "Laptop: offline"]);
    // Only the design pane says "column": the user's question and the reply's table, the reply first (newer).
    expect(state.groups.map((group) => group.id)).toEqual(["mini|" + designPane]);
    const group = state.groups[0]!;
    expect(group.pane).toMatchObject({
      name: expect.any(String),
      kind: "claude",
      folder: "/Users/demo/code/worktrees/aurora-web-design",
    });
    expect(group.matches.map((match) => match.author)).toEqual(["agent", "you"]);
    expect(group.matches[1]!.snippet!.text).toBe("Check the chat column widths against the design and list what differs.");
    expect(group.matches[1]!.snippet!.highlights).toEqual([{ start: 15, end: 21 }]);
    expect(group.matches.every((match) => match.messageID !== null && match.time !== null)).toBe(true);
    expect(group.matches[0]!.time!).toBeGreaterThan(group.matches[1]!.time!);
    // Each change went to the window on the given channel, never the same state twice.
    expect(owner.sent.every((sent) => sent.channel === "search-update")).toBe(true);
    const keys = owner.sent.map((sent) => JSON.stringify(sent.state));
    expect(new Set(keys).size).toBe(keys.length);
    expect(owner.sent.at(-1)!.state).toEqual(state);
  });

  it("clears for a query too short and searches nothing", async () => {
    const hosts = new FakeHosts();
    const runner = new SearchFakeRemote("", { hang: true });
    hosts.add("mini", "Mac mini", "connected", runner);
    const owner = new FakeOwner();
    const search = new SearchService(hosts, "search-update", searchBounds.timeoutMs, 0);
    search.search(owner, "co");
    expect(runner.commands).toHaveLength(1);
    search.search(owner, " c ");
    expect(runner.cancelledRuns).toBe(1);
    expect(search.state(owner)).toEqual({
      searched: null,
      statuses: [expect.objectContaining({ id: "mini", phase: "waiting" })],
      groups: [],
    });
    expect(runner.commands).toHaveLength(1);
  });

  it("cancels the old query's command for a new one, keeps a query searched once, and stops everything on close", async () => {
    const hosts = new FakeHosts();
    const runner = new SearchFakeRemote("", { hang: true });
    hosts.add("mini", "Mac mini", "connected", runner);
    const owner = new FakeOwner();
    const search = new SearchService(hosts, "search-update", searchBounds.timeoutMs, 0);
    search.search(owner, "alpha");
    search.search(owner, "  alpha ");
    expect(runner.commands).toHaveLength(1);
    search.search(owner, "beta");
    await Promise.resolve();
    expect(runner.commands).toHaveLength(2);
    expect(runner.cancelledRuns).toBe(1);
    const sent = owner.sent.length;
    search.close(owner);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runner.cancelledRuns).toBe(2);
    expect(search.state(owner)).toEqual({
      searched: null,
      statuses: [],
      groups: [],
    });
    expect(owner.sent).toHaveLength(sent);
  });

  it("says a machine did not answer in time and searches it again on Try again", async () => {
    const hosts = new FakeHosts();
    const runner = new SearchFakeRemote("", { hang: true });
    hosts.add("mini", "Mac mini", "connected", runner);
    const owner = new FakeOwner();
    const search = new SearchService(hosts, "search-update", 30, 0);
    search.search(owner, "column");
    const state = await until(search, owner, finished);
    expect(phases(state)).toEqual(["Mac mini: timedOut"]);
    expect(statusText(state.statuses[0]!)).toBe(`Mac mini: no answer in ${searchBounds.timeoutMs / 1000} s`);
    search.retry(owner, "mini");
    expect(runner.commands).toHaveLength(2);
    expect(phases(search.state(owner))).toEqual(["Mac mini: searching"]);
    search.close(owner);
  });

  it("says the search did not run when the command fails", async () => {
    const hosts = new FakeHosts();
    hosts.add("mini", "Mac mini", "connected", new SearchFakeRemote("", { failure: new Error("channel closed") }));
    const owner = new FakeOwner();
    const search = new SearchService(hosts, "search-update", searchBounds.timeoutMs, 0);
    search.search(owner, "column");
    const state = await until(search, owner, finished);
    expect(state.statuses.map(statusText)).toEqual(["Mac mini: the search did not run"]);
  });

  it("reads every match of a pane on N more", async () => {
    const hosts = new FakeHosts();
    hosts.add("mini", "Mac mini", "connected");
    const owner = new FakeOwner();
    const search = new SearchService(hosts, "search-update", searchBounds.timeoutMs, 0);
    search.search(owner, "lighthouse");
    const state = await until(search, owner, finished);
    expect(state.groups.map((candidate) => candidate.pane.id)).toEqual([lighthouse.paneID]);
    const group = state.groups[0]!;
    expect(groupShown(group)).toHaveLength(searchBounds.shownPerPane);
    expect(group.unread + groupMore(group)).toBeGreaterThan(0);
    const before = group.matches.length + group.unread;
    search.expand(owner, "mini", lighthouse.paneID);
    const expanded = await until(search, owner, (next) => {
      const found = next.groups.find((candidate) => candidate.pane.id === lighthouse.paneID)!;
      return found.expanded && !found.expanding && found.unread === 0;
    });
    const all = expanded.groups.find((candidate) => candidate.pane.id === lighthouse.paneID)!;
    expect(all.matches).toHaveLength(8);
    expect(before).toBe(8);
    expect(all.matches[0]!.snippet!.text).toBe("Lighthouse question 8");
    expect(groupShown(all)).toEqual(all.matches);
    expect(groupMore(all)).toBe(0);
    // Newest first.
    const times = all.matches.map((match) => match.time ?? 0);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("searches a machine that connects, and stops one that goes offline", async () => {
    const hosts = new FakeHosts();
    hosts.add("mini", "Mac mini", "connected");
    const laptopRunner = new SearchFakeRemote("", { hang: true });
    hosts.add("laptop", "Laptop", "offline", laptopRunner);
    const owner = new FakeOwner();
    const search = new SearchService(hosts, "search-update", searchBounds.timeoutMs, 0);
    search.search(owner, "column");
    await until(search, owner, finished);
    expect(laptopRunner.commands).toHaveLength(0);
    hosts.set("laptop", "connected");
    search.hostsChanged();
    expect(laptopRunner.commands).toHaveLength(1);
    expect(phases(search.state(owner))).toEqual(["Mac mini: done", "Laptop: searching"]);
    // The design pane's results stay while Laptop searches.
    expect(search.state(owner).groups.map((group) => group.id)).toEqual(["mini|" + designPane]);
    hosts.set("laptop", "offline");
    search.hostsChanged();
    await Promise.resolve();
    expect(laptopRunner.cancelledRuns).toBe(1);
    expect(phases(search.state(owner))).toEqual(["Mac mini: done", "Laptop: offline"]);
    // A change that is not a connection's searches nothing again.
    search.hostsChanged();
    expect(laptopRunner.commands).toHaveLength(1);
    search.close(owner);
  });

  it("keeps each window's search its own and drops a window that is gone", async () => {
    const hosts = new FakeHosts();
    const runner = new SearchFakeRemote("", { hang: true });
    hosts.add("mini", "Mac mini", "connected", runner);
    const one = new FakeOwner(1);
    const two = new FakeOwner(2);
    const search = new SearchService(hosts, "search-update", searchBounds.timeoutMs, 0);
    search.search(one, "alpha");
    search.search(two, "beta");
    expect(search.state(one).searched).toBe("alpha");
    expect(search.state(two).searched).toBe("beta");
    two.destroyed = true;
    search.hostsChanged();
    await Promise.resolve();
    expect(runner.cancelledRuns).toBe(1);
    expect(search.state(two).searched).toBeNull();
    search.closeAll();
    await Promise.resolve();
    expect(runner.cancelledRuns).toBe(2);
    expect(search.state(one).searched).toBeNull();
  });
});

describe("SearchService's pause", () => {
  it("cancels the running search the moment the query changes, and starts the new one after a 300 ms pause", async () => {
    vi.useFakeTimers();
    const hosts = new FakeHosts();
    const runner = new SearchFakeRemote("", { hang: true });
    hosts.add("mini", "Mac mini", "connected", runner);
    const owner = new FakeOwner();
    const search = new SearchService(hosts, "search-update");
    search.search(owner, "needle");
    expect(runner.commands).toHaveLength(0);
    expect(phases(search.state(owner))).toEqual(["Mac mini: searching"]);
    vi.advanceTimersByTime(searchBounds.pauseMs - 1);
    expect(runner.commands).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(runner.commands).toHaveLength(1);
    // An edit: the old command is cancelled now, not after the pause.
    search.search(owner, "needles");
    await Promise.resolve();
    expect(runner.cancelledRuns).toBe(1);
    expect(search.state(owner).searched).toBe("needles");
    expect(phases(search.state(owner))).toEqual(["Mac mini: searching"]);
    // Typing on restarts the pause; nothing is sent until it is over.
    vi.advanceTimersByTime(200);
    search.search(owner, "needles x");
    vi.advanceTimersByTime(200);
    expect(runner.commands).toHaveLength(1);
    // Back to the first query: a fresh run once the pause is over.
    search.search(owner, "needle");
    vi.advanceTimersByTime(searchBounds.pauseMs);
    expect(runner.commands).toHaveLength(2);
    search.close(owner);
    await Promise.resolve();
    expect(runner.cancelledRuns).toBe(2);
  });

  it("keeps the rows already found while the next query waits, and a machine that connects in the pause is started once", async () => {
    vi.useFakeTimers();
    const hosts = new FakeHosts();
    hosts.add("mini", "Mac mini", "connected");
    const laptop = new SearchFakeRemote("", { hang: true });
    hosts.add("laptop", "Laptop", "offline", laptop);
    const owner = new FakeOwner();
    const search = new SearchService(hosts, "search-update");
    search.search(owner, "column");
    vi.advanceTimersByTime(searchBounds.pauseMs);
    vi.useRealTimers();
    await until(search, owner, (state) => state.groups.length > 0 && state.statuses[0]!.phase === "done");
    vi.useFakeTimers();
    search.search(owner, "columns");
    expect(search.state(owner).groups.map((group) => group.id)).toEqual(["mini|" + designPane]);
    hosts.set("laptop", "connected");
    search.hostsChanged();
    expect(laptop.commands).toHaveLength(0);
    vi.advanceTimersByTime(searchBounds.pauseMs);
    expect(laptop.commands).toHaveLength(1);
    search.close(owner);
  });

  it("a query too short clears at once and drops the waiting one", () => {
    vi.useFakeTimers();
    const hosts = new FakeHosts();
    const runner = new SearchFakeRemote("", { hang: true });
    hosts.add("mini", "Mac mini", "connected", runner);
    const owner = new FakeOwner();
    const search = new SearchService(hosts, "search-update");
    search.search(owner, "needle");
    search.search(owner, "n");
    expect(search.state(owner).searched).toBeNull();
    vi.advanceTimersByTime(searchBounds.pauseMs * 2);
    expect(runner.commands).toHaveLength(0);
  });
});
