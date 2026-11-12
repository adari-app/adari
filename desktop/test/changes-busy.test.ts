// The across-agents Changes screen always finishes loading. With 25 agents,
// about ten working, every turn that finishes asks for a new read; if the new
// read ended the one running, no read would live long enough to finish
// ("Reading every agent's folder…" for minutes).
// Here the screen (on the hooks host) talks to the real ChangesService over a
// fake Herdr (25 agent panes, a turn finishing every 2 s), a fake git (each
// command 600 ms) and fake SFTP transcripts (each 300 ms): one read takes about
// 6 s. A refresh asked while a read runs waits for it (one more read after it,
// at most one waiting); the Refresh button and a new machine set still restart.
// And a transcript read that never answers gives its permit back at its
// deadline, its row saying it could not be read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChangesService, type ChangesHosts } from "../src/main/changes/service";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { TranscriptFileReader } from "../src/shared/chat/feed";
import { makeSessionRef, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { changesLimits, defaultChangesLimits, gitOutput, type GitSection } from "../src/shared/changes/git";
import { collectOverview, type AgentChangesPane } from "../src/shared/changes/overview";
import { AgentChangesGitReader, CommandGate, type ReadOnlyCommandRunner } from "../src/shared/changes/reader";
import type { HostView } from "../src/shared/ipc-contract";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChangesOverview } = await import("../src/renderer/changes/ChangesOverview");

const start = 1_793_588_400_000;
const agents = 25;
const uuid = (index: number): string => "5b1d7c2e-0000-4000-8000-" + String(index).padStart(12, "0");
const folderOf = (index: number): string => `/Users/me/wt/agent-${index}`;
const transcriptOf = (index: number): string => `/Users/me/.claude/projects/-Users-me-wt-agent-${index}/${uuid(index)}.jsonl`;

/** Herdr's answer: 25 Claude agents in three workspaces, each in its own worktree; `working` names the ones working. */
function topology(working: ReadonlySet<number>): SessionTopology {
  const index = Array.from({ length: agents }, (_, i) => i + 1);
  const ws = (i: number): string => `w${(i % 3) + 1}`;
  const status = (i: number): string => (working.has(i) ? "working" : "done");
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [1, 2, 3].map((n) => ({
      workspace_id: `w${n}`,
      number: n,
      label: `space ${n}`,
      focused: n === 1,
      pane_count: 9,
      tab_count: 1,
      active_tab_id: `w${n}:t1`,
      agent_status: "done",
    })),
    tabs: [1, 2, 3].map((n) => ({ tab_id: `w${n}:t1`, workspace_id: `w${n}`, number: 1, label: "main", focused: n === 1, pane_count: 9, agent_status: "done" })),
    panes: index.map((i) => ({
      pane_id: `p${i}`,
      terminal_id: `t-p${i}`,
      workspace_id: ws(i),
      tab_id: `${ws(i)}:t1`,
      focused: i === 1,
      cwd: folderOf(i),
      agent: "claude",
      agent_status: status(i),
      revision: 1,
    })),
    layouts: [],
    agents: index.map((i) => ({
      pane_id: `p${i}`,
      name: `agent-${i}`,
      agent: "claude",
      agent_status: status(i),
      cwd: folderOf(i),
      agent_session: { source: "herdr:claude", agent: "claude", kind: "path", value: transcriptOf(i) },
    })),
  });
}

const statusSections = (nonce: string): string => {
  const sections: [GitSection, string][] = [
    ["HEAD", "refs/heads/main\n"],
    ["OID", "a".repeat(40) + "\n"],
    ["TOP", "/f\n"],
    ["STATUS", " M a.swift\0"],
    ["UNSTAGED", "2\t1\ta.swift\0"],
    ["STAGED", ""],
  ];
  return gitOutput(sections, nonce);
};

/** Fake git: every command answers its folder's status after `delayMs`; counts what ran, what was ended and the most at once. */
class SlowGit implements ReadOnlyCommandRunner {
  runs = 0;
  ended = 0;
  running = 0;
  most = 0;
  constructor(private readonly delayMs: number) {}
  runReadOnlyCommand(command: string, _max: number, signal?: AbortSignal): Promise<string> {
    this.runs += 1;
    this.running += 1;
    this.most = Math.max(this.most, this.running);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.running -= 1;
        const nonce = /HERDR-CHANGES-([^-]+)-/.exec(command)?.[1] ?? "";
        resolve(statusSections(nonce));
      }, this.delayMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          this.running -= 1;
          this.ended += 1;
          reject(new Error("closed"));
        },
        { once: true },
      );
    });
  }
}

/** Fake SFTP: each pane's transcript (empty) is found after `delayMs`; `never` holds every locate forever. */
class SlowTranscripts implements TranscriptFileReader<TranscriptSessionRef> {
  locates = 0;
  constructor(
    private readonly delayMs: number,
    private readonly never = false,
  ) {}
  locate(session: TranscriptSessionRef): Promise<string | null> {
    this.locates += 1;
    if (this.never) return new Promise(() => undefined);
    return new Promise((resolve) => setTimeout(() => resolve(session.lookup.kind === "path" ? session.lookup.path : null), this.delayMs));
  }
  size(): Promise<number> {
    return Promise.resolve(0);
  }
  read(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }
}

class FakeHerdr implements ChangesHosts {
  working = new Set(Array.from({ length: 10 }, (_, i) => i + 1));
  readonly backends = new Map<string, HerdrHostBackend>();
  views: HostView[] = [];
  constructor(
    readonly git: SlowGit,
    readonly transcripts: SlowTranscripts,
  ) {
    this.add("mini", "Mac mini");
  }
  add(id: string, name: string): void {
    this.views.push({ id, name, kind: "ssh", address: `me@${id}:22`, platform: "macOS", state: "connected", error: null, topology: topology(this.working), fetchedAtMs: start });
    this.backends.set(id, { kind: "ssh", transcripts: () => this.transcripts, changesRunner: () => this.git } as unknown as HerdrHostBackend);
  }
  /** One working agent finishes its turn; the next one starts one. */
  finishATurn(): void {
    const done = Math.min(...this.working);
    this.working.delete(done);
    let next = (Math.max(...this.working, done) % agents) + 1;
    while (this.working.has(next)) next = (next % agents) + 1;
    this.working.add(next);
    this.views = this.views.map((view) => ({ ...view, topology: topology(this.working) }));
  }
  list(): HostView[] {
    return this.views;
  }
  backend(id: string): HerdrHostBackend | null {
    return this.backends.get(id) ?? null;
  }
}

const owner = { id: 1 };

function screen(herdr: FakeHerdr) {
  const service = new ChangesService(herdr, { now: () => start });
  let calls = 0;
  const bridge = {
    changesOverview: (hostId: string) => {
      calls += 1;
      return service.overview(owner, hostId);
    },
    closeChanges: () => service.close(owner),
  };
  const props = () => ({ bridge, hosts: herdr.list(), onOpenAgent: () => undefined, onClose: () => undefined });
  const host = new HookHost(ChangesOverview, props());
  return {
    host,
    calls: () => calls,
    render: () => host.render(props()),
    rows: () => elements(host.tree).filter((e) => typeof e.props["data-item"] === "string" && (e.props["data-item"] as string).includes("|agent|")).length,
    loading: () => elements(host.tree).some((e) => e.props["className"] === "ch-loading"),
    refresh: () => elements(host.tree).find((e) => e.props["aria-label"] === "Refresh" || e.props["aria-label"] === "Reading"),
  };
}

describe("the across-agents screen with 25 busy agents", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: start });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the rows within one read's time while a turn finishes every 2 s, and finishes", async () => {
    const herdr = new FakeHerdr(new SlowGit(600), new SlowTranscripts(300));
    const view = screen(herdr);
    view.render();
    expect(view.loading()).toBe(true);
    // A turn finishes every 2 s for 30 s.
    let shownAt: number | null = null;
    for (let t = 2_000; t <= 30_000; t += 2_000) {
      await vi.advanceTimersByTimeAsync(2_000);
      herdr.finishATurn();
      view.render();
      if (shownAt === null && view.rows() > 0) shownAt = t;
    }
    expect(shownAt, "rows shown within one read's time (about 6 s)").not.toBeNull();
    expect(shownAt!).toBeLessThanOrEqual(8_000);
    expect(view.rows()).toBe(agents);
    // Coalesced: one read after another, never one per finished turn (15 turns finished).
    expect(view.calls()).toBeLessThanOrEqual(Math.ceil(30_000 / 6_000) + 2);
    expect(herdr.git.ended, "a finished turn never ends a read").toBe(0);
    // The turns stop: the last read waiting runs, then nothing more.
    await vi.advanceTimersByTimeAsync(15_000);
    view.render();
    expect(view.refresh()?.props["className"]).toBe("ib");
    expect(herdr.git.running).toBe(0);
    expect(herdr.git.most).toBeLessThanOrEqual(3);
    const settled = view.calls();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(view.calls()).toBe(settled);
    view.host.unmount();
  });

  it("the Refresh button still restarts a read that runs; leaving the screen ends it", async () => {
    const herdr = new FakeHerdr(new SlowGit(600), new SlowTranscripts(300));
    const view = screen(herdr);
    view.render();
    await vi.advanceTimersByTimeAsync(1_000);
    const before = view.calls();
    const button = view.refresh();
    expect(button).toBeDefined();
    expect(button!.props["disabled"]).not.toBe(true);
    (button!.props["onClick"] as () => void)();
    expect(view.calls()).toBe(before + 1);
    expect(herdr.git.ended, "the running read was ended").toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(7_000);
    view.render();
    expect(view.rows()).toBe(agents);
    expect(view.refresh()?.props["className"]).toBe("ib");
    // Leaving ends the read running.
    (view.refresh()!.props["onClick"] as () => void)();
    await vi.advanceTimersByTimeAsync(1_000);
    const ended = herdr.git.ended;
    view.host.unmount();
    expect(herdr.git.ended).toBeGreaterThan(ended);
    expect(herdr.git.running).toBe(0);
  });

  it("a second machine shows its rows when it finishes, before a slower one", async () => {
    const herdr = new FakeHerdr(new SlowGit(600), new SlowTranscripts(300));
    const fast = new SlowGit(10);
    herdr.add("box", "build-box");
    herdr.backends.set("box", { kind: "ssh", transcripts: () => new SlowTranscripts(10), changesRunner: () => fast } as unknown as HerdrHostBackend);
    const view = screen(herdr);
    view.render();
    await vi.advanceTimersByTimeAsync(1_000);
    view.render();
    expect(view.rows(), "build-box's rows, while the Mac mini still reads").toBe(agents);
    expect(view.loading()).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    view.render();
    expect(view.rows()).toBe(2 * agents);
    expect(view.loading()).toBe(false);
    view.host.unmount();
  });
});

describe("a transcript read that never answers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: start });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives its permit back at its deadline, its row saying it could not be read", async () => {
    const git = new SlowGit(100);
    const gate = new CommandGate(3);
    const reader = new AgentChangesGitReader(git, gate, defaultChangesLimits);
    // Three transcripts that never answer: every permit of the Mac's gate held by one.
    const panes: AgentChangesPane[] = Array.from({ length: 3 }, (_, i) => ({
      paneId: `p${i + 1}`,
      name: `agent-${i + 1}`,
      kind: "claude",
      folder: folderOf(i + 1),
      workspace: "space",
      session: makeSessionRef("claude", { kind: "path", path: transcriptOf(i + 1) }),
    }));
    let rows: Awaited<ReturnType<typeof collectOverview>> | null = null;
    void collectOverview({ panes, transcripts: new SlowTranscripts(0, true), git: reader, limits: defaultChangesLimits }).then((r) => (rows = r));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(rows, "still waiting before the deadline").toBeNull();
    expect(gate.available).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rows, "answered at the deadline").not.toBeNull();
    expect(gate.available).toBe(3);
    expect(rows!.every((row) => row.tools.kind === "unreadable")).toBe(true);
    expect(rows!.every((row) => row.git?.kind === "repository")).toBe(true);
    // The gate serves the next command at once.
    const next = reader.status(folderOf(9));
    await vi.advanceTimersByTimeAsync(200);
    expect((await next).kind).toBe("repository");
  });

  it("an agent's own Changes is not held by it either", async () => {
    const herdr = new FakeHerdr(new SlowGit(100), new SlowTranscripts(0, true));
    const service = new ChangesService(herdr, { now: () => start, limits: changesLimits({}) });
    let answer: unknown = null;
    void service.agent(owner, "mini", "p3").then((a) => (answer = a));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(answer).not.toBeNull();
    expect((answer as { git: { kind: string } }).git.kind).toBe("read");
  });
});
