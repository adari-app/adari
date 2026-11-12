// The finder for herdr-core Claude and Codex
// panes whose argv names no session (main/herdr/core-session-finder.ts), the
// core's fenced setter (CoreFollower.setSession), the projection's verified
// generation (CorePaneRuns.shown) and the readers' current-snapshot filter
// (shared/chat/core-pane-session.ts), ported from the iPhone app's
// CoreChatSessionTests and its core Chat boundary and reader tests. The
// hosts are in-memory projections of the core's terminals; the lookups are
// fakes or the real one on a synthetic home (support/core-chat-home.ts).

import { afterEach, describe, expect, it } from "vitest";

import { herdrSession, chatSession as changesSession } from "../src/main/changes/service";
import { agentSessionKey } from "../src/shared/changes/content";
import { decodeCoreTerminal, type CoreTerminal } from "../src/main/herdr/core-wire";
import { CoreFollower, type CoreFollowerOptions } from "../src/main/herdr/core-follower";
import { CoreModel } from "../src/main/herdr/core-model";
import { CorePaneRuns, projectCore, type CorePaneRun } from "../src/main/herdr/core-projection";
import { CoreBackoff, CoreSession } from "../src/main/herdr/core-session";
import {
  CoreObservationClock,
  CoreSessionFinder,
  CoreSessionPublication,
  coreFound,
  type CoreFinderAgent,
  type CoreSessionHost,
  type CoreTranscriptLocating,
} from "../src/main/herdr/core-session-finder";
import type { CoreFoundSession, SessionTopology } from "../src/main/herdr/wire";
import { coreClaudeProjectSlug, transcriptSessionID, type CoreEarlierSession, type CoreFolderRef, type CoreFolderResult } from "../src/shared/chat/core-folder-lookup";
import {
  claudeAmbiguousKind,
  claudeAmbiguousNote,
  codexAmbiguousNote,
  coreChatSession,
  coreLookup,
  shownCoreSession,
  type CoreRulePane,
} from "../src/shared/chat/core-pane-session";
import { paneSession } from "../src/shared/chat/locator";
import { paneSessions } from "../src/main/away/service";
import { SearchService } from "../src/main/search/service";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import type { HostView } from "../src/shared/ipc-contract";
import type { SearchViewState } from "../src/shared/search/view";
import { a, b, c, home, LocalHomeReader, projectFolder as folder, setModified, transcript } from "./support/core-chat-home";
import { eventually, pause } from "./support/core-test-link";
import { FakeCore } from "./support/fake-core";

const me = process.pid;
const parent = process.ppid;
const g1 = "20261108010000";
const g2 = "20261109010000";
/** The agent process's start every FakeCoreReader lookup reads. */
const lookupGeneration = "20261109000000";
const created = 1_761_000_000_000;

function terminal(
  address = "t1",
  options: { kind?: string; pid?: number; folder?: string; foregroundName?: string; argv?: readonly string[]; turn?: number; state?: string } = {},
): CoreTerminal {
  const kind = options.kind ?? "claude";
  const fg = options.foregroundName ?? kind;
  const cwd = options.folder ?? folder;
  const pid = options.pid ?? me;
  return decodeCoreTerminal(
    FakeCore.terminal(address, {
      argv: options.argv ?? [kind],
      cwd,
      state: options.state ?? "live",
      status: FakeCore.status("idle", kind),
      turn: options.turn ?? 0,
      foreground: FakeCore.foreground(fg, options.argv ?? [fg], cwd, pid),
      pid,
    }),
  );
}

const path = (id: string, at = folder): string => `/h/.claude/projects/${coreClaudeProjectSlug(at)}/${id}.jsonl`;

/** FakeCoreHost: the core's terminals, the sessions it was handed (through the publication's fence), and its projection. */
class FakeCoreHost implements CoreSessionHost {
  readonly sessions = new Map<string, CoreFoundSession>();
  readonly generations = new Map<string, string>();
  readonly given: [string, CoreFoundSession | null][] = [];

  constructor(public terminals: CoreTerminal[]) {}

  terminal(address: string): CoreTerminal | undefined {
    return this.terminals.find((candidate) => candidate.address === address);
  }

  replace(terminals: CoreTerminal[]): void {
    this.terminals = terminals;
  }

  setSession(publication: CoreSessionPublication, address: string): boolean {
    return publication.apply(this.terminal(address), () => {
      if (publication.session === null) this.sessions.delete(address);
      else this.sessions.set(address, publication.session);
      if (publication.generation === null) this.generations.delete(address);
      else this.generations.set(address, publication.generation);
      this.given.push([address, publication.session]);
    });
  }

  snapshot(): SessionTopology {
    return projectCore({ model: new CoreModel(1, this.terminals), machineName: "fixture", sessions: this.sessions, generations: this.generations }).topology;
  }
}

/** FakeCoreReader: one transcript (or none), as the lookup answers it (skipped, or found before under this pid for another process: none). */
class FakeCoreReader implements CoreTranscriptLocating {
  calls = 0;
  failure = false;
  private gate: (() => void) | null = null;
  private started: (() => void) | null = null;
  private hasStarted = false;

  constructor(
    public path: string | null,
    private readonly blockFirst = false,
    public generation = lookupGeneration,
  ) {}

  waitUntilStarted(): Promise<void> {
    if (this.hasStarted) return Promise.resolve();
    return new Promise((resolve) => {
      this.started = resolve;
    });
  }

  release(): void {
    this.gate?.();
    this.gate = null;
  }

  async locateCore(ref: CoreFolderRef, earlier: readonly CoreEarlierSession[]): Promise<CoreFolderResult | null> {
    this.calls += 1;
    if (this.calls === 1 && this.blockFirst) {
      this.hasStarted = true;
      this.started?.();
      await new Promise<void>((resolve) => {
        this.gate = resolve;
      });
    }
    if (this.failure) throw new Error("synthetic");
    const id = this.path === null ? null : transcriptSessionID(this.path, ref.format)?.toLowerCase();
    if (id === null || id === undefined || ref.excluding.includes(id)) return { generation: this.generation, path: null };
    const before = earlier.filter((item) => item.id === id);
    if (before.length > 0 && !before.some((item) => item.generation === this.generation)) return { generation: this.generation, path: null };
    return { generation: this.generation, path: this.path };
  }

  async coreProcessGeneration(): Promise<string | null> {
    if (this.failure) throw new Error("synthetic");
    return this.generation;
  }
}

async function observe(finder: CoreSessionFinder, host: FakeCoreHost, earlier?: CoreFound[]): Promise<CoreFound[]> {
  const snapshot = host.snapshot();
  return finder.observe(snapshot.agents, snapshot.panes, earlier === undefined ? {} : { earlier });
}

type CoreFound = ReturnType<typeof coreFound>;

const runOf = (value: CoreTerminal): CorePaneRun => {
  const run = CorePaneRuns.of(value, "claude");
  if (run === undefined) throw new Error("no run");
  return run;
};

const agentOf = (topology: SessionTopology, paneID = "hc:t1") => topology.agents.find((agent) => agent.paneID === paneID);

/** `foundBy` of `run`: its key, a colon, the process's start (14 digits). */
const isMarker = (marker: string | undefined, run: string): boolean => marker !== undefined && marker.startsWith(run + ":") && /^[0-9]{14}$/.test(marker.slice(run.length + 1));

// MARK: - The real lookup on a synthetic home (CoreChatSessionTests)

describe("a plain core Claude or Codex pane gets its folder's newest transcript", () => {
  it("Claude: the newest written since the agent started, held while its process start is the same", async () => {
    const at = home();
    transcript(at, "claude", a, { age: -100_000_000 });
    transcript(at, "claude", b, { age: 10 });
    transcript(at, "claude", c, { age: 20 });
    transcript(at, "claude", "44444444-4444-4444-8444-444444444444", { folder: "/Users/fixture/other", age: 30 });
    const host = new FakeCoreHost([terminal("t1", { pid: me })]);
    const reader = new LocalHomeReader(at);
    const start = host.snapshot();
    expect(agentOf(start)?.agentSession, "herdr-core names none").toBeUndefined();
    expect(agentOf(start)?.coreFound).toBeUndefined();
    const finder = new CoreSessionFinder(host, reader);
    const found = await finder.observe(start.agents, start.panes);
    expect(found.map((item) => item.session)).toEqual([c]);

    const after = host.snapshot();
    const session = agentOf(after)?.coreFound;
    expect(session).toMatchObject({ source: "herdr:claude", agent: "claude", kind: "id", value: c, foundIn: folder });
    expect(isMarker(session?.foundBy, `claude:${me}:${created}`), "marked with its run and its process's start").toBe(true);
    expect(agentOf(after)?.agentSession, "identity stays the argv's (none)").toBeUndefined();
    // Chat, Away and Changes read the same one.
    expect(coreChatSession("hc:t1", after.agents, after.panes)).toEqual({ source: "herdr:claude", agent: "claude", kind: "id", value: c });
    const chat = paneSession(after, "hc:t1");
    expect(chat !== null && chat !== "ambiguous" ? chat.ref : null).toEqual({ format: "claude", lookup: { kind: "id", id: c } });
    expect(changesSession(after, "hc:t1")).toEqual({ format: "claude", lookup: { kind: "id", id: c } });
    expect(herdrSession(after, "hc:t1")).toEqual({ format: "claude", lookup: { kind: "id", id: c } });
    // An open Changes reads again when the found session changes (its context key).
    expect(agentSessionKey(start, "hc:t1")).toBeNull();
    expect(agentSessionKey(after, "hc:t1")).toBe(JSON.stringify(["herdr:claude", "claude", "id", c]));

    // Held, it is checked against the process's start (the real ps) on the next snapshot.
    expect(await finder.observe(after.agents, after.panes)).toEqual([]);
    expect(reader.checked).toEqual([me]);
    expect(agentOf(host.snapshot())?.coreFound, "the same process keeps it").toEqual(session);
  });

  it("Codex: the newest rollout whose session_meta names the folder", async () => {
    const at = home();
    const x = "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b";
    const y = "019a3c2f-8e52-7c31-8a4f-3d2e1f0a9b8c";
    const z = "019a3c30-9f63-7d42-9b5a-4e3f2a1b0c9d";
    transcript(at, "codex", x, { age: -100_000_000 });
    transcript(at, "codex", y, { age: 20 });
    transcript(at, "codex", z, { folder: "/Users/fixture/other", age: 30 });
    const host = new FakeCoreHost([terminal("t1", { kind: "codex", pid: me })]);
    const finder = new CoreSessionFinder(host, new LocalHomeReader(at));
    await observe(finder, host);
    const after = host.snapshot();
    expect(agentOf(after)?.coreFound).toMatchObject({ source: "herdr:codex", agent: "codex", kind: "id", value: y });
    expect(changesSession(after, "hc:t1")).toEqual({ format: "codex", lookup: { kind: "id", id: y } });
  });

  it("two plain Claude panes in one folder are both refused with the note, and nothing is looked up", async () => {
    const at = home();
    transcript(at, "claude", b);
    const host = new FakeCoreHost([terminal("t1", { pid: me }), terminal("t2", { pid: parent })]);
    const reader = new LocalHomeReader(at);
    const finder = new CoreSessionFinder(host, reader);
    expect(await observe(finder, host)).toEqual([]);
    expect(reader.located, "no guess").toEqual([]);
    const after = host.snapshot();
    for (const paneID of ["hc:t1", "hc:t2"]) {
      expect(agentOf(after, paneID)?.coreFound?.kind, paneID).toBe(claudeAmbiguousKind);
      expect(agentOf(after, paneID)?.coreFound?.foundBy, paneID).toBeDefined();
      expect(coreChatSession(paneID, after.agents, after.panes), paneID).toBe("ambiguous");
      expect(paneSession(after, paneID), paneID).toBe("ambiguous");
      expect(changesSession(after, paneID), paneID).toBeNull();
    }
    expect(claudeAmbiguousNote).toBe("Two Claude sessions are open in this folder, so Chat can't tell which is this pane's");
    expect(codexAmbiguousNote).toBe("Two Codex sessions are open in this folder, so Chat can't tell which is this pane's");
    // A second snapshot changes nothing.
    expect(await observe(finder, host)).toEqual([]);
    expect(host.snapshot().agents.map((agent) => agent.coreFound?.kind)).toEqual([claudeAmbiguousKind, claudeAmbiguousKind]);

    // The ambiguity ends when the peer closes, and Chat appears.
    host.replace([terminal("t1", { pid: me })]);
    await observe(finder, host);
    expect(agentOf(host.snapshot())?.coreFound?.value).toBe(b);
  });

  it("a core pane beside a TUI pane that names its session never takes it", async () => {
    const at = home();
    transcript(at, "claude", a, { age: -100_000_000 });
    transcript(at, "claude", b, { age: 10 });
    transcript(at, "claude", c, { age: 20 });
    const host = new FakeCoreHost([terminal("t1", { pid: me })]);
    const reader = new LocalHomeReader(at);
    const finder = new CoreSessionFinder(host, reader);
    let named: string | null = c;
    const merged = (): { agents: CoreFinderAgent[]; panes: CoreRulePane[] } => {
      const core = host.snapshot();
      const tuiAgent: CoreFinderAgent = {
        paneID: "w1:p1",
        agent: "claude",
        cwd: folder,
        ...(named === null ? {} : { agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: named } }),
      };
      return { agents: [tuiAgent, ...core.agents], panes: [{ paneID: "w1:p1", agent: "claude", cwd: folder, foregroundCWD: folder }, ...core.panes] };
    };
    let snapshot = merged();
    await finder.observe(snapshot.agents, snapshot.panes);
    expect(finder.given("t1")?.value, "never the TUI pane's newer one").toBe(b);
    expect(reader.located.at(-1)?.excluding).toEqual([c]);
    expect(coreLookup("w1:p1", snapshot.agents, snapshot.panes)).toEqual({ kind: "none" });

    // The TUI pane now names b: b leaves the core pane at once (readers too, before the finder runs); c is the newest no pane names.
    named = b;
    snapshot = merged();
    const stale = { agents: snapshot.agents.map((agent) => (agent.paneID === "hc:t1" ? { ...agent, coreFound: host.sessions.get("t1") } : agent)), panes: snapshot.panes };
    expect(coreChatSession("hc:t1", stale.agents, stale.panes), "a peer names it now").toBeNull();
    await finder.observe(snapshot.agents, snapshot.panes);
    expect(finder.given("t1")?.value).toBe(c);
    expect(reader.located.at(-1)?.excluding).toEqual([b]);

    // A TUI pane of the agent in the folder that names none: refused, never a guess.
    named = null;
    snapshot = merged();
    await finder.observe(snapshot.agents, snapshot.panes);
    expect(finder.given("t1")?.kind).toBe(claudeAmbiguousKind);
  });

  it("a new run in the same core pane never takes back the earlier run's session, also after a reconnect", async () => {
    const at = home();
    const run1Path = transcript(at, "claude", b, { age: 10 });
    const host = new FakeCoreHost([terminal("t1", { pid: parent })]);
    const reader = new LocalHomeReader(at);
    const finder = new CoreSessionFinder(host, reader);
    const first = await observe(finder, host);
    expect(first.map((item) => item.session)).toEqual([b]);
    const run1 = first[0]?.run as string;
    expect(isMarker(run1, `claude:${parent}:${created}`), run1).toBe(true);

    // Run 2: the agent exited and started again in the same pane (another process).
    host.replace([terminal("t1", { pid: me })]);
    expect(agentOf(host.snapshot())?.coreFound, "the core shows run 1's session for run 1 only, at once").toBeUndefined();
    expect(await observe(finder, host), "b is newest and written since run 2 started, but run 1's").toEqual([]);
    expect(reader.located.at(-1)?.excluding).toEqual([b]);
    expect(reader.located.at(-1)?.sinceProcess).toBe(me);
    expect(agentOf(host.snapshot())?.coreFound).toBeUndefined();

    // Its own written: found on the next snapshot.
    transcript(at, "claude", c, { age: 20 });
    expect((await observe(finder, host)).map((item) => item.session)).toEqual([c]);
    expect(agentOf(host.snapshot())?.coreFound?.value).toBe(c);

    // After a reconnect (a fresh finder), the app's record of run 1 keeps b out too.
    setModified(run1Path, Date.now() / 1000 + 40);
    const fresh = new CoreSessionFinder(host, reader);
    const seeded = await observe(fresh, host, [coreFound("hc:t1", run1, b)]);
    expect(seeded.map((item) => item.session), "b is newer again, still run 1's").toEqual([c]);
  });

  it("a TUI pane, a core pane its argv names and another machine's pane are never bound", async () => {
    const at = home();
    transcript(at, "claude", b);
    const named = ["claude", "--resume", c];
    const host = new FakeCoreHost([terminal("t3", { argv: named }), terminal("remote/t1")]);
    const reader = new LocalHomeReader(at);
    const finder = new CoreSessionFinder(host, reader);
    const snapshot = host.snapshot();
    expect(coreLookup("hc:t3", snapshot.agents, snapshot.panes)).toEqual({ kind: "none" });
    expect(coreLookup("hc:remote/t1", snapshot.agents, snapshot.panes)).toEqual({ kind: "none" });
    expect(coreLookup("w1:p1", [{ paneID: "w1:p1", agent: "claude", cwd: folder }], [])).toEqual({ kind: "none" });
    expect(await observe(finder, host)).toEqual([]);
    expect(reader.located).toEqual([]);
    const after = host.snapshot();
    expect(agentOf(after, "hc:t3")?.agentSession).toEqual({ source: "herdr:claude", agent: "claude", kind: "id", value: c });
    expect(agentOf(after, "hc:t3")?.coreFound).toBeUndefined();
    expect(coreChatSession("hc:t3", after.agents, after.panes), "the argv's rules, as before").toBeUndefined();
    expect(CorePaneRuns.of(terminal("remote/t1"), "claude")).toBeUndefined();
  });
});

// MARK: - The core and the projection (CoreChatSessionTests)

describe("the core shows a found session only for its run and its verified process start", () => {
  it("the projection never shows one over the argv's, for another run, or for a start it did not verify", () => {
    const value = terminal("t1", { pid: 77 });
    const start = "00001793502000";
    const found: CoreFoundSession = { source: "herdr:claude", agent: "claude", kind: "id", value: b, foundBy: `claude:77:${created}:${start}`, foundIn: folder };
    expect(CorePaneRuns.key(runOf(value))).toBe(`claude:77:${created}`);
    const project = (terminals: CoreTerminal[], session: CoreFoundSession, generations: Record<string, string> = {}) =>
      projectCore({ model: new CoreModel(1, terminals), machineName: "m", sessions: new Map([["t1", session]]), generations: new Map(Object.entries(generations)) }).agents[0];
    expect(project([value], found, { t1: start })?.coreFound).toEqual(found);
    expect(project([value], found)?.coreFound, "none verified").toBeUndefined();
    expect(project([value], found, { t1: "00001793502001" })?.coreFound, "another process start").toBeUndefined();
    // A 14-digit suffix alone is no verification.
    expect(project([value], { ...found, foundBy: `claude:77:${created}:${g1}` })?.coreFound).toBeUndefined();
    expect(project([value], { ...found, foundBy: `claude:77:${created}` }, { t1: start })?.coreFound, "a marker with no process start").toBeUndefined();
    const refusal: CoreFoundSession = { source: "herdr:claude", agent: "claude", kind: claudeAmbiguousKind, value: folder, foundBy: `claude:77:${created}` };
    expect(project([value], refusal)?.coreFound, "a refusal names no transcript").toEqual(refusal);
    expect(project([value], { ...found, foundBy: `claude:78:${created}:${start}` }, { t1: start })?.coreFound).toBeUndefined();
    const named = terminal("t1", { pid: 77, argv: ["claude", "-r", c] });
    const argv = project([named], found, { t1: start });
    expect(argv?.agentSession?.value).toBe(c);
    expect(argv?.coreFound).toBeUndefined();
  });

  it("the core applies a publication only for the newest snapshot and its run (CoreFollower.setSession)", async () => {
    const core = new FakeCore([
      FakeCore.terminal("t1", { argv: ["claude"], cwd: folder, status: FakeCore.status("idle"), foreground: FakeCore.foreground("claude", ["claude"], folder, me), pid: me }),
    ]);
    const options: CoreFollowerOptions = { heartbeatSilenceSeconds: 30, watchdogIntervalSeconds: 0.05, machinePollSeconds: 60, snapshotWaitSeconds: 2 };
    const follower = new CoreFollower(new CoreSession({ backoff: new CoreBackoff(0.01, 0.02), helloTimeoutSeconds: 2, makeLink: () => core.makeLink() }), options);
    closers.push(() => follower.close());
    await follower.snapshot();
    const value = follower.terminal("t1") as CoreTerminal;
    const run = runOf(value);
    const start = "00001793502000";
    const session: CoreFoundSession = { source: "herdr:claude", agent: "claude", kind: "id", value: b, foundBy: CorePaneRuns.key(run) + ":" + start, foundIn: folder };
    const clock = new CoreObservationClock();
    const one = clock.next();
    const two = clock.next();
    const publication = (found: CoreFoundSession | null, forRun: CorePaneRun | null, observation: number) =>
      new CoreSessionPublication(found, found === null ? null : start, forRun, observation, clock);
    const shown = () => follower.projection?.agents.find((agent) => agent.paneID === "hc:t1")?.coreFound;

    expect(follower.setSession(publication(session, run, one), "t1"), "decided on a snapshot a newer one replaced").toBe(false);
    expect(follower.setSession(publication(session, { ...run, pid: run.pid + 1 }, two), "t1"), "the terminal no longer runs that run").toBe(false);
    expect(shown()).toBeUndefined();
    expect(follower.setSession(publication(session, run, two), "t1")).toBe(true);
    expect(shown()).toEqual(session);
    expect(follower.setSession(publication(null, null, one), "t1")).toBe(false);
    clock.next();
    expect(follower.setSession(publication(null, null, two), "t1"), "one snapshot later, nothing decided on the last applies").toBe(false);
    expect(shown()).toEqual(session);
    // Run 2 in the same terminal: the core shows run 1's session for run 1 only.
    core.setForeground("t1", FakeCore.foreground("claude", ["claude"], folder, parent));
    expect(await eventually(() => follower.terminal("t1")?.foreground?.pid === parent, 1_000)).toBe(true);
    expect(shown()).toBeUndefined();
  });
});

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

// MARK: - The finder's boundaries: shells, reconnects, caps, folders and peers

describe("the finder's boundaries: shells, reconnects, caps, folders and peers", () => {
  it("a shell in front of the agent never acquires an older run's transcript", async () => {
    const value = terminal("t1", { pid: parent, foregroundName: "/bin/zsh" });
    expect(CorePaneRuns.of(value, "claude")).toBeUndefined();
    const host = new FakeCoreHost([value]);
    const reader = new FakeCoreReader(path(a));
    await observe(new CoreSessionFinder(host, reader), host);
    expect(host.sessions.get("t1")).toBeUndefined();
    expect(reader.calls).toBe(0);
  });

  it("a reused pid across a reconnect never reuses the old run's session (generationless history)", async () => {
    const value = terminal("t1", { pid: 5151 });
    const host = new FakeCoreHost([value]);
    const finder = new CoreSessionFinder(host, new FakeCoreReader(path(a)));
    await observe(finder, host, [coreFound("hc:t1", CorePaneRuns.key(runOf(value)), a)]);
    expect(host.sessions.get("t1")).toBeUndefined();
  });

  it("found and refused bindings repeat neither trips nor setters", async () => {
    const host = new FakeCoreHost([terminal()]);
    const reader = new FakeCoreReader(path(a));
    const finder = new CoreSessionFinder(host, reader);
    for (let n = 0; n < 10; n += 1) await observe(finder, host);
    expect(reader.calls).toBe(1);
    expect(host.given.length).toBe(1);
    host.replace([terminal(), terminal("t2", { pid: me + 1 })]);
    for (let n = 0; n < 10; n += 1) await observe(finder, host);
    expect(reader.calls).toBe(1);
    expect(host.given.length).toBe(3);
    host.replace([terminal()]);
    await observe(finder, host);
    expect(host.sessions.get("t1")?.value).toBe(a);
    host.replace([]);
    await observe(finder, host);
    expect(host.given.at(-1)?.[1]).toBeNull();
  });

  it("caps the first lookups at 120, and the rechecks after a found session too", async () => {
    const empty = new FakeCoreHost([terminal()]);
    const none = new FakeCoreReader(null);
    const finder = new CoreSessionFinder(empty, none);
    for (let n = 0; n < 130; n += 1) await observe(finder, empty);
    expect(none.calls).toBe(120);

    const host = new FakeCoreHost([terminal()]);
    const reader = new FakeCoreReader(path(a));
    const again = new CoreSessionFinder(host, reader);
    await observe(again, host);
    host.replace([terminal("t1", { turn: 1 })]);
    reader.failure = true;
    for (let n = 0; n < 130; n += 1) await observe(again, host);
    expect(reader.calls).toBeLessThanOrEqual(121);
  });

  it("a folder change takes the old folder's session back even when the lookup fails", async () => {
    const host = new FakeCoreHost([terminal()]);
    const reader = new FakeCoreReader(path(a));
    const finder = new CoreSessionFinder(host, reader);
    await observe(finder, host);
    expect(host.sessions.get("t1")?.value).toBe(a);
    host.replace([terminal("t1", { folder: "/Users/fixture/other" })]);
    reader.failure = true;
    await observe(finder, host);
    expect(host.sessions.get("t1")).toBeUndefined();
  });

  it("a delayed lookup never publishes a session a newer snapshot has a peer name", async () => {
    const host = new FakeCoreHost([terminal()]);
    const reader = new FakeCoreReader(path(a), true);
    const finder = new CoreSessionFinder(host, reader);
    const one = host.snapshot();
    const first = finder.observe(one.agents, one.panes);
    await reader.waitUntilStarted();
    host.replace([terminal(), terminal("t2", { pid: me + 1, argv: ["claude", "--resume", a] })]);
    const two = host.snapshot();
    const second = finder.observe(two.agents, two.panes);
    expect(finder.clock.latest, "numbered as delivered").toBe(2);
    reader.release();
    await Promise.all([first, second]);
    expect(host.given.some(([address, session]) => address === "t1" && session?.value === a)).toBe(false);
  });

  it("a new run, or a terminal its argv names, has what was found taken back; another machine's is never looked up", async () => {
    const host = new FakeCoreHost([terminal()]);
    const reader = new FakeCoreReader(path(a));
    const finder = new CoreSessionFinder(host, reader);
    await observe(finder, host);
    host.replace([terminal("t1", { pid: me + 1 })]);
    await observe(finder, host);
    expect(host.sessions.get("t1"), "the prior run's is excluded and the core cleared").toBeUndefined();
    host.replace([terminal("t1", { argv: ["claude", "--resume", b] })]);
    await observe(finder, host);
    expect(host.snapshot().agents[0]?.agentSession?.value).toBe(b);
    expect(host.snapshot().agents[0]?.coreFound).toBeUndefined();
    const before = reader.calls;
    const remote = new FakeCoreHost([terminal("other/t1")]);
    await observe(new CoreSessionFinder(remote, reader), remote);
    expect(reader.calls).toBe(before);
  });

  it("another machine's pane in the same folder never makes this machine's pane ambiguous", async () => {
    const host = new FakeCoreHost([terminal(), terminal("other/t2", { pid: me + 1 })]);
    const finder = new CoreSessionFinder(host, new FakeCoreReader(path(a)));
    await observe(finder, host);
    expect(host.sessions.get("t1")).toMatchObject({ kind: "id", value: a });
    expect(host.sessions.get("other/t2")).toBeUndefined();
  });

  it("a peer's named UUID is skipped in either hex case", async () => {
    const at = home();
    const id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    transcript(at, "claude", id);
    const host = new FakeCoreHost([terminal(), terminal("t2", { pid: me + 1, argv: ["claude", "--resume", id.toUpperCase()] })]);
    await observe(new CoreSessionFinder(host, new LocalHomeReader(at)), host);
    expect(host.sessions.get("t1")).toBeUndefined();
  });
});

// MARK: - The finder's boundaries: cached successes and snapshot order

describe("the finder's boundaries: cached successes and snapshot order", () => {
  it("a cached success is checked again for a reused pid with no turn change", async () => {
    const value = terminal("t1", { pid: 5151 });
    const host = new FakeCoreHost([value]);
    const reader = new FakeCoreReader(path(a), false, g1);
    const finder = new CoreSessionFinder(host, reader);
    await observe(finder, host);
    expect(host.sessions.get("t1")?.value).toBe(a);
    reader.generation = g2;
    reader.path = null;
    host.replace([value]);
    await observe(finder, host);
    expect(host.sessions.get("t1"), "an old success never certifies another process under the same tuple").toBeUndefined();
  });

  it("a session found for another process start is skipped after a reconnect", async () => {
    const value = terminal("t1", { pid: 5151 });
    const host = new FakeCoreHost([value]);
    const finder = new CoreSessionFinder(host, new FakeCoreReader(path(a), false, g2));
    await observe(finder, host, [coreFound("hc:t1", CorePaneRuns.key(runOf(value)) + ":" + g1, a)]);
    expect(host.sessions.get("t1")).toBeUndefined();
  });

  it("an older delivered snapshot arriving last never rebinds a peer's session", async () => {
    const host = new FakeCoreHost([terminal()]);
    const old = host.snapshot();
    host.replace([terminal(), terminal("t2", { pid: me + 1, argv: ["claude", "--resume", a] })]);
    const fresh = host.snapshot();
    const finder = new CoreSessionFinder(host, new FakeCoreReader(path(a), false, g1));
    await finder.observe(fresh.agents, fresh.panes, { sequence: 2 });
    await finder.observe(old.agents, old.panes, { sequence: 1 });
    expect(host.given.some(([address, session]) => address === "t1" && session?.value === a)).toBe(false);
  });

  it("a publication awaited never installs an id after a newer snapshot skips it", async () => {
    const value = terminal();
    const peer = terminal("t2", { pid: me + 1, argv: ["claude", "--resume", a] });
    const published: (CoreFoundSession | null)[] = [];
    let gate: (() => void) | null = null;
    let started: (() => void) | null = null;
    const publishing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    const host: CoreSessionHost = {
      terminal: (address) => (address === "t1" ? value : undefined),
      setSession: async (publication, address) => {
        if (publication.session !== null && first) {
          first = false;
          started?.();
          await new Promise<void>((resolve) => {
            gate = resolve;
          });
        }
        return publication.apply(address === "t1" ? value : undefined, () => published.push(publication.session));
      },
    };
    const project = (terminals: CoreTerminal[]) => projectCore({ model: new CoreModel(1, terminals), machineName: "fixture" }).topology;
    const old = project([value]);
    const finder = new CoreSessionFinder(host, new FakeCoreReader(path(a), false, g1));
    const one = finder.observe(old.agents, old.panes);
    await publishing;
    const fresh = project([value, peer]);
    const two = finder.observe(fresh.agents, fresh.panes);
    expect(finder.clock.latest).toBe(2);
    (gate as (() => void) | null)?.();
    await Promise.all([one, two]);
    expect(published.some((session) => session?.value === a)).toBe(false);
  });

  it("generationless history stays skipped when the id also has an entry with a generation", async () => {
    const value = terminal("t1", { pid: 5151 });
    const host = new FakeCoreHost([value]);
    const key = CorePaneRuns.key(runOf(value));
    const finder = new CoreSessionFinder(host, new FakeCoreReader(path(a), false, g2));
    await observe(finder, host, [coreFound("hc:t1", key, a), coreFound("hc:t1", key + ":" + g2, a)]);
    expect(host.sessions.get("t1")).toBeUndefined();
  });

  it("numbers snapshots on delivery: an older number never becomes the newest", () => {
    const clock = new CoreObservationClock();
    const one = clock.next();
    const two = clock.next();
    expect(clock.note(one)).toBe(false);
    expect(clock.latest).toBe(two);
    expect(clock.note(3)).toBe(true);
    let ran = false;
    expect(clock.whileNewest(two, () => (ran = true))).toBe(false);
    expect(ran).toBe(false);
    expect(clock.whileNewest(3, () => (ran = true))).toBe(true);
    expect(ran).toBe(true);
  });
});

// MARK: - The readers take only what the latest snapshot allows

describe("readers filter a found session against the current snapshot", () => {
  const marker = `claude:5151:${created}:${g1}`;
  const found: CoreFoundSession = { source: "herdr:claude", agent: "claude", kind: "id", value: b, foundBy: marker, foundIn: folder };
  const topology = (cwd: string, extra: { agents?: CoreFinderAgent[]; panes?: CoreRulePane[] } = {}) => ({
    agents: [{ paneID: "hc:t1", agent: "claude", cwd, coreFound: found } as CoreFinderAgent, ...(extra.agents ?? [])],
    panes: [{ paneID: "hc:t1", agent: "claude", cwd, foregroundCWD: cwd } as CoreRulePane, ...(extra.panes ?? [])],
  });
  const hidden = (machine: ReturnType<typeof topology>): void => {
    expect(coreChatSession("hc:t1", machine.agents, machine.panes)).toBeNull();
    expect(paneSession(machine, "hc:t1"), "Chat and Away").toBeNull();
    const asTopology = { version: "", protocolVersion: 0, workspaces: [], tabs: [], ...machine } as unknown as SessionTopology;
    expect(changesSession(asTopology, "hc:t1"), "Changes").toBeNull();
    expect(herdrSession(asTopology, "hc:t1"), "Changes' list").toBeNull();
  };

  it("shown in the folder it was proved in", () => {
    const machine = topology(folder);
    expect(shownCoreSession(found, "hc:t1", machine.agents, machine.panes)).toEqual(found);
    const chat = paneSession(machine, "hc:t1");
    expect(chat !== null && chat !== "ambiguous" ? chat.ref : null).toEqual({ format: "claude", lookup: { kind: "id", id: b } });
  });

  it("the latest folder change hides the old folder's session before the finder runs (a mismatch is never shown)", () => {
    hidden(topology("/Users/fixture/other"));
    const unproved = { agents: [{ paneID: "hc:t1", agent: "claude", cwd: folder, coreFound: { ...found, foundIn: undefined } } as CoreFinderAgent], panes: topology(folder).panes };
    expect(coreChatSession("hc:t1", unproved.agents, unproved.panes), "proved nowhere").toBeNull();
  });

  it("an id a peer names now is hidden at once", () => {
    hidden(topology(folder, { agents: [{ paneID: "w1:p1", agent: "claude", cwd: folder, agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: b.toUpperCase() } }], panes: [{ paneID: "w1:p1", agent: "claude", cwd: folder }] }));
  });

  it("a peer that names none turns it into the refusal", () => {
    const machine = topology(folder, { agents: [{ paneID: "w1:p1", agent: "claude", cwd: folder }], panes: [{ paneID: "w1:p1", agent: "claude", cwd: folder }] });
    expect(coreChatSession("hc:t1", machine.agents, machine.panes)).toBe("ambiguous");
    expect(paneSession(machine, "hc:t1")).toBe("ambiguous");
  });

  it("an older observation never unhides an old-folder session in current readers", async () => {
    const value = terminal("t1", { pid: 5151, folder: "/Users/fixture/other" });
    const host = new FakeCoreHost([value]);
    const reader: CoreTranscriptLocating = {
      locateCore: async (ref) => ({ generation: g1, path: path(ref.folder === folder ? b : c, ref.folder) }),
      coreProcessGeneration: async () => g1,
    };
    const finder = new CoreSessionFinder(host, reader);
    const latest = host.snapshot();
    const old = projectCore({ model: new CoreModel(1, [terminal("t1", { pid: 5151 })]), machineName: "fixture" }).topology;
    await finder.observe(latest.agents, latest.panes, { sequence: 2 });
    await finder.observe(old.agents, old.panes, { sequence: 1 });
    expect(host.given.some(([, session]) => session?.value === b), "the older observation never rebinds the old folder's id").toBe(false);
    expect(host.sessions.get("t1")?.value).toBe(c);
  });

  it("a core pane with no session found yet is none, never the desktop's newest-in-folder guess", () => {
    const machine = { agents: [{ paneID: "hc:t1", agent: "claude", cwd: folder }], panes: [{ paneID: "hc:t1", agent: "claude", cwd: folder }] };
    expect(coreChatSession("hc:t1", machine.agents, machine.panes)).toBeNull();
    expect(paneSession(machine, "hc:t1")).toBeNull();
  });

  // A pane on a machine the core added has no folder rule here (its transcripts are
  // there; reads go to this host). It follows only a session it names.
  it("a foreign core pane naming no session follows no folder; one naming its session keeps it", () => {
    for (const agent of ["claude", "grok", "cursor"]) {
      const machine = { agents: [{ paneID: "hc:other/t1", agent, cwd: folder }], panes: [{ paneID: "hc:other/t1", agent, cwd: folder, foregroundCWD: folder }] };
      expect(coreChatSession("hc:other/t1", machine.agents, machine.panes), agent).toBeUndefined();
      expect(paneSession(machine, "hc:other/t1"), agent).toBeNull();
      expect(paneSessions({ version: "", protocolVersion: 0, workspaces: [], tabs: [], ...machine } as unknown as SessionTopology)["hc:other/t1"] ?? null, agent).toBeNull();
    }
    const named = {
      agents: [{ paneID: "hc:other/t1", agent: "claude", cwd: folder, agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: b } }],
      panes: [{ paneID: "hc:other/t1", agent: "claude", cwd: folder }],
    };
    const kept = paneSession(named, "hc:other/t1");
    expect(kept !== null && kept !== "ambiguous" ? kept.ref : null).toEqual({ format: "claude", lookup: { kind: "id", id: b } });
    // This machine's TUI panes keep their rules (the Claude folder fallback included).
    const tui = { agents: [{ paneID: "w1:p1", agent: "claude", cwd: folder }], panes: [{ paneID: "w1:p1", agent: "claude", cwd: folder }] };
    const fallback = paneSession(tui, "w1:p1");
    expect(fallback !== null && fallback !== "ambiguous" ? fallback.ref.lookup : null).toEqual({ kind: "folder", folder });
  });
});

// MARK: - Search: desktop search reads the same session, as the current snapshot allows it

describe("search reads a found session only while the current snapshot allows it", () => {
  /** One search over `topology` on a fake host: the commands it runs and what it shows. */
  const search = (topology: SessionTopology) => {
    const commands: string[] = [];
    const backend = {
      commands: () => ({
        run: async (command: { text: string }) => {
          commands.push(command.text);
          return { bytes: new Uint8Array(), truncated: false };
        },
      }),
      transcripts: () => ({ read: async () => new Uint8Array() }),
    } as unknown as HerdrHostBackend;
    const view = { id: "m", name: "fixture", state: "connected", topology } as unknown as HostView;
    const service = new SearchService({ list: () => [view], backend: () => backend }, "search", 1_000, 0);
    const owner = { id: 1, send: (_channel: string, _state: SearchViewState) => undefined, isDestroyed: () => false };
    service.search(owner, "prompt");
    return { commands, state: () => service.state(owner), close: () => service.closeAll() };
  };

  for (const kind of ["claude", "codex"] as const) {
    it(`${kind}: a found binding is searched by its id; after a folder change or a peer naming it, nothing is`, async () => {
      const found = kind === "claude" ? path(a) : `/h/.codex/sessions/2026/11/09/rollout-2026-11-09T00-00-00-${a}.jsonl`;
      const host = new FakeCoreHost([terminal("t1", { kind })]);
      await observe(new CoreSessionFinder(host, new FakeCoreReader(found)), host);
      const bound = host.snapshot();
      expect(agentOf(bound)?.coreFound).toMatchObject({ kind: "id", value: a });

      const positive = search(bound);
      expect(await eventually(() => positive.commands.length > 0, 1_000)).toBe(true);
      expect(positive.commands).toHaveLength(1);
      expect(positive.commands[0]).toContain(a);
      positive.close();

      const other = "/Users/fixture/other";
      const moved = { ...bound, agents: bound.agents.map((agent) => ({ ...agent, cwd: other })), panes: bound.panes.map((pane) => ({ ...pane, cwd: other, foregroundCWD: other })) };
      // A TUI agent of the folder names it (an agent row, no pane of its own to search).
      const peer = { paneID: "w1:p1", agent: kind, cwd: folder, agentSession: { source: `herdr:${kind}`, agent: kind, kind: "id", value: a.toUpperCase() } };
      const named = { ...bound, agents: [...bound.agents, peer] } as unknown as SessionTopology;
      // With its own pane it is searched by its id, as its own; this pane never is.
      const withPane = { ...named, panes: [...bound.panes, { ...(bound.panes[0] as object), paneID: "w1:p1", terminalID: "term-peer" }] } as unknown as SessionTopology;
      expect(paneSessions(withPane)["hc:t1"]).toBeNull();
      expect(paneSessions(withPane)["w1:p1"]?.ref.lookup).toEqual({ kind: "id", id: a.toUpperCase() });
      for (const [label, hidden] of [["folder change", moved], ["peer names it", named]] as const) {
        expect(paneSessions(hidden)["hc:t1"], label).toBeNull();
        const run = search(hidden);
        // No target for the pane: the machine's search ends at once, the pane counted as unsearched.
        expect(run.state().statuses[0]?.phase, label).toBe("done");
        expect(run.state().statuses[0]?.unsearchedPanes, label).toBeGreaterThanOrEqual(1);
        await pause(20);
        expect(run.commands.filter((command) => command.includes(a)), label).toEqual([]);
        run.close();
      }
    });
  }
});
