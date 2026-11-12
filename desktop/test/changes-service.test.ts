// The main process's Changes reads (src/main/changes/
// service.ts) on the demo machines with the demo's fixture git
// (src/main/demo/demo-git.ts). The same cases as CompanionChangesModelTests'
// testAnAgentsFolderAndCommitsFromTheFixturesGit,
// testNoFolderRunsNothingAndOfflineSaysSo, testANewPaneOrConnectionDropsWhatWasShown,
// testAFilesAndACommitsDiffAndTryAgain, testABackwardReadWhenTheChatHoldsPartOfTheSession,
// testEveryAgentByWorkspaceChangesFirst, testEveryAgentOfflineWithoutASource,
// testPanesAndWhoShares; and the desktop's own: a diff only of what the last
// read listed, three commands at once per machine, a close ends every read.

import { describe, expect, it } from "vitest";

import { ChangesService, changesPanes, herdrSession, type ChangesHosts } from "../src/main/changes/service";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { DemoGit, demoGitCommit, demoGitFolders } from "../src/main/demo/demo-git";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import type { SessionTopology } from "../src/main/herdr/wire";
import { overviewItems } from "../src/shared/changes/content";
import { documentFromGit } from "../src/shared/changes/diff";
import { shortHash } from "../src/shared/changes/git";
import { rowGitStatus, rowHasChanges, rowToolFileCount, sharingPanes } from "../src/shared/changes/overview";
import type { ReadOnlyCommandRunner } from "../src/shared/changes/reader";
import type { HostState, HostView } from "../src/shared/ipc-contract";
import { bundledFixturesForTests } from "./support/demo-fixtures";

/** 2 November 2026, 03:00 UTC: the demo's start. */
const start = 1_793_588_400_000;
const macBuildPane = "w7:p1G";

/** Records the commands it runs for another runner. */
class Recording implements ReadOnlyCommandRunner {
  readonly commands: string[] = [];
  constructor(private readonly inner: ReadOnlyCommandRunner) {}
  runReadOnlyCommand(command: string, max: number, signal?: AbortSignal): Promise<string> {
    this.commands.push(command);
    return this.inner.runReadOnlyCommand(command, max, signal);
  }
}

/** Never answers until its signal fires. */
class Slow implements ReadOnlyCommandRunner {
  runs = 0;
  runReadOnlyCommand(_command: string, _max: number, signal?: AbortSignal): Promise<string> {
    this.runs += 1;
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("ended")), { once: true }));
  }
}

/** Fails every command, counting them. */
class Failing implements ReadOnlyCommandRunner {
  runs = 0;
  runReadOnlyCommand(): Promise<string> {
    this.runs += 1;
    return Promise.reject(new Error("cannot connect"));
  }
}

interface Machine {
  readonly view: HostView;
  readonly backend: HerdrHostBackend;
}

async function machine(
  id: string = demoHostIds.macMini,
  options: { runner?: ReadOnlyCommandRunner; state?: HostState; topology?: (topology: SessionTopology) => SessionTopology } = {},
): Promise<Machine & { git: DemoGit }> {
  const host = demoHosts(bundledFixturesForTests(), start).find((candidate) => candidate.descriptor.id === id)!;
  const demo = new DemoBackend(host, bundledFixturesForTests(), undefined, () => start);
  const git = demo.changesRunner();
  const runner = options.runner ?? git;
  const backend = { kind: "demo", transcripts: () => demo.transcripts(), changesRunner: () => runner } as unknown as HerdrHostBackend;
  const snapshot = await demo.snapshot();
  const topology = options.topology === undefined ? snapshot : options.topology(snapshot);
  const view: HostView = { ...host.descriptor, state: options.state ?? "connected", error: null, topology, fetchedAtMs: start };
  return { view, backend, git };
}

function hosts(...machines: Machine[]): ChangesHosts {
  return {
    list: () => machines.map((m) => m.view),
    backend: (id) => machines.find((m) => m.view.id === id)?.backend ?? null,
  };
}

const service = (list: ChangesHosts): ChangesService => new ChangesService(list, { now: () => start });
const owner = { id: 1 };

/** The page asks each machine on its own; every machine's answer, in the sidebar's order. */
async function everyMachine(list: ChangesHosts) {
  const changes = service(list);
  return { hosts: await Promise.all(list.list().map(async (host) => (await changes.overview(owner, host.id))!)) };
}

describe("one agent's Changes", () => {
  it("reads its folder's git and the commits since its session began, one exec each", async () => {
    const mac = await machine();
    const recording = new Recording(mac.git);
    const changes = service(hosts({ ...mac, backend: { ...mac.backend, changesRunner: () => recording } as HerdrHostBackend }));
    const result = (await changes.agent(owner, demoHostIds.macMini, macBuildPane))!;
    expect(result.online).toBe(true);
    expect(result.folder).toBe(demoGitFolders.macBuild);
    expect(result.kind).toBe("claude");
    expect(result.git.kind === "read" && result.git.read.kind).toBe("repository");
    if (result.git.kind !== "read" || result.git.read.kind !== "repository") return;
    const status = result.git.read.status;
    expect(status.head).toEqual({ kind: "branch", name: "z/aurora-web-mac" });
    expect(status.files.map((file) => file.path)).toEqual(["App/Terminal/CompanionTerminalView.swift", "App/CompanionChatComposer.swift", "notes/mac-input.md"]);
    expect(status.files[0]!.added).toBe(5);
    expect(result.commits.kind === "read" && result.commits.read.kind === "commits" && result.commits.read.commits.map(shortHash)).toEqual(["4f1c2a9", "9b8a7c6"]);
    // Its own calls: the Edit of its first turn; the turn running changed nothing yet.
    expect(result.tools.kind).toBe("read");
    if (result.tools.kind !== "read") return;
    expect(result.tools.changes.session.map((file) => file.path)).toEqual([demoGitFolders.macBuild + "/App/Terminal/CompanionTerminalView.swift"]);
    expect(result.tools.changes.thisTurn).toEqual([]);
    expect(result.tools.changes.thisTurnRunning).toBe(true);
    expect(result.tools.changes.fromSessionStart).toBe(true);
    // The transcript's first turn is the session's start: the commits since then.
    expect(result.sinceKnown).toBe(true);
    expect(result.commitsSince).toBe(result.tools.changes.firstTurnAt);
    expect(result.commitsSince).toBe(Math.floor((start - 31 * 60_000) / 1000));
    expect(recording.commands.length).toBe(2);
    expect(recording.commands.every((command) => command.startsWith("/bin/sh -c "))).toBe(true);
    expect(result.sharing).toEqual([]);
  });

  it("without a transcript reads the last 12 hours' commits and says who shares the folder", async () => {
    const mac = await machine();
    const result = (await service(hosts(mac)).agent(owner, demoHostIds.macMini, "w2:p1"))!;
    expect(result.folder).toBe(demoGitFolders.quartz);
    expect(result.tools).toEqual({ kind: "none", reason: "No transcript is read for this agent: this shows its folder's git only." });
    expect(result.sinceKnown).toBe(false);
    expect(result.commitsSince).toBe(start / 1000 - 12 * 3600);
    expect(result.sharing.length).toBe(1);
    expect(result.commits.kind === "read" && result.commits.read.kind === "commits" && result.commits.read.commits.length).toBe(1);
  });

  it("runs nothing for a pane with no folder, and says offline when the machine is", async () => {
    const mac = await machine(demoHostIds.macMini, {
      topology: (topology) => ({
        ...topology,
        panes: topology.panes.map((pane) => (pane.paneID === macBuildPane ? { ...pane, cwd: undefined, foregroundCWD: undefined } : pane)),
        agents: topology.agents.map((agent) => (agent.paneID === macBuildPane ? { ...agent, cwd: undefined } : agent)),
      }),
    });
    const changes = service(hosts(mac));
    const none = (await changes.agent(owner, demoHostIds.macMini, macBuildPane))!;
    expect(none.git).toEqual({ kind: "noFolder" });
    expect(none.commits).toEqual({ kind: "noFolder" });
    expect(mac.git.commands).toEqual([]);
    const offline = await machine(demoHostIds.macMini, { state: "offline" });
    const result = (await service(hosts(offline)).agent(owner, demoHostIds.macMini, macBuildPane))!;
    expect(result.online).toBe(false);
    expect(result.git).toEqual({ kind: "offline" });
    expect(result.commits).toEqual({ kind: "offline" });
    expect(offline.git.commands).toEqual([]);
  });

  it("ends an older read when a newer one starts, and every read on close", async () => {
    const slow = new Slow();
    const mac = await machine(demoHostIds.macMini, { runner: slow });
    const changes = service(hosts(mac));
    const first = changes.agent(owner, demoHostIds.macMini, macBuildPane);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = changes.agent(owner, demoHostIds.macMini, "w2:p1");
    expect(await first).toBeNull();
    const other = changes.agent({ id: 2 }, demoHostIds.macMini, "w2:p1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    changes.close(owner);
    expect(await second).toBeNull();
    changes.closeAll();
    expect(await other).toBeNull();
    expect(slow.runs).toBeGreaterThan(0);
  });

  it("reads a file's and a commit's diff, only of what the last read listed, and again after a failure", async () => {
    const mac = await machine();
    const changes = service(hosts(mac));
    await changes.agent(owner, demoHostIds.macMini, macBuildPane);
    const sidebar = await changes.diff(owner, demoHostIds.macMini, macBuildPane, { kind: "file", path: "App/Terminal/CompanionTerminalView.swift" });
    expect(sidebar?.kind).toBe("text");
    if (sidebar?.kind !== "text") return;
    expect(sidebar.bound).toBe(256 * 1_024);
    const document = documentFromGit(sidebar.text, sidebar.bound);
    expect(document.rows[0]!.kind).toBe("section");
    expect(document.rows[0]!.text).toBe("Not staged");
    expect(document.files.map((file) => file.name)).toEqual(["App/Terminal/CompanionTerminalView.swift"]);
    expect(document.rows.some((row) => row.kind === "added" && row.text.includes("Shift-Return"))).toBe(true);

    const untracked = await changes.diff(owner, demoHostIds.macMini, macBuildPane, { kind: "file", path: "notes/mac-input.md" });
    expect(untracked?.kind).toBe("text");
    if (untracked?.kind !== "text") return;
    const fresh = documentFromGit(untracked.text, untracked.bound);
    expect(fresh.rows[0]!.text).toBe("Untracked");
    expect(fresh.added).toBe(3);

    const commit = await changes.diff(owner, demoHostIds.macMini, macBuildPane, { kind: "commit", hash: demoGitCommit });
    expect(commit?.kind).toBe("text");
    if (commit?.kind !== "text") return;
    expect(commit.bound).toBe(512 * 1_024);
    const shown = documentFromGit(commit.text, commit.bound);
    expect(shown.rows[0]!.text).toBe("commit " + demoGitCommit);
    expect(shown.added).toBe(3);

    // Not listed by the last read, or another pane's: nothing runs.
    const before = mac.git.commands.length;
    expect(await changes.diff(owner, demoHostIds.macMini, macBuildPane, { kind: "file", path: "/etc/passwd" })).toEqual({ kind: "failed" });
    expect(await changes.diff(owner, demoHostIds.macMini, macBuildPane, { kind: "commit", hash: "b".repeat(40) })).toEqual({ kind: "failed" });
    expect(await changes.diff(owner, demoHostIds.macMini, "w2:p1", { kind: "file", path: "Quartz/PaywallView.swift" })).toEqual({ kind: "failed" });
    expect(await changes.diff({ id: 9 }, demoHostIds.macMini, macBuildPane, { kind: "file", path: "notes/mac-input.md" })).toEqual({ kind: "failed" });
    expect(mac.git.commands.length).toBe(before);

    // A runner that fails: the folder reads as failed, and a diff of a listed file fails and runs again.
    const failing = new Failing();
    const broken = service(hosts({ ...mac, backend: { ...mac.backend, changesRunner: () => failing } as HerdrHostBackend }));
    const read = (await broken.agent(owner, demoHostIds.macMini, macBuildPane))!;
    expect(read.git).toEqual({ kind: "read", read: { kind: "failed" } });
    expect(read.commits).toEqual({ kind: "read", read: { kind: "failed" } });
    expect(await broken.diff(owner, demoHostIds.macMini, macBuildPane, { kind: "file", path: "notes/mac-input.md" })).toEqual({ kind: "failed" });
    expect(failing.runs).toBe(2);
  });

  it("answers offline for a diff once the machine is gone", async () => {
    const mac = await machine();
    const list = { machines: [mac] as Machine[] };
    const changes = service({ list: () => list.machines.map((m) => m.view), backend: (id) => list.machines.find((m) => m.view.id === id)?.backend ?? null });
    await changes.agent(owner, demoHostIds.macMini, macBuildPane);
    list.machines = [];
    expect(await changes.diff(owner, demoHostIds.macMini, macBuildPane, { kind: "file", path: "notes/mac-input.md" })).toEqual({ kind: "offline" });
  });
});

describe("every agent's Changes", () => {
  it("lists each machine's agents by workspace, changes first, git once per folder", async () => {
    const mac = await machine();
    const box = await machine(demoHostIds.buildBox);
    const result = await everyMachine(hosts(mac, box));
    expect(result.hosts.map((host) => [host.name, host.state])).toEqual([
      ["Mac mini", "read"],
      ["build-box", "read"],
    ]);
    const groups = result.hosts[0]!.groups;
    const rows = groups.flatMap((group) => group.rows);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.some((row) => row.pane.paneId === "w8:p1")).toBe(false);
    const macBuild = rows.find((row) => row.pane.paneId === macBuildPane)!;
    expect(rowHasChanges(macBuild)).toBe(true);
    expect(rowGitStatus(macBuild)?.files.length).toBe(3);
    expect(rowToolFileCount(macBuild)).toBe(1);
    // Counts only: the edits' lines stay in the main process.
    expect(macBuild.tools.kind === "read" && macBuild.tools.changes.session[0]!.edits).toEqual([]);
    const fable = rows.find((row) => row.pane.paneId === "w2:p1")!;
    const rollout = rows.find((row) => row.pane.paneId === "w2:p70")!;
    expect(rowGitStatus(fable)).toEqual(rowGitStatus(rollout));
    expect(rollout.tools).toEqual({ kind: "noTranscript" });
    const atelier = rows.find((row) => row.pane.paneId === "w5:pH")!;
    expect(atelier.git).toEqual({ kind: "notARepository" });
    expect(rowToolFileCount(atelier)).toBe(0);
    const design = rows.find((row) => row.pane.paneId === "w7:p1H")!;
    expect(rowGitStatus(design)?.files).toEqual([]);
    expect(rowHasChanges(design)).toBe(false);
    expect(groups[0]!.rows[0] !== undefined && rowHasChanges(groups[0]!.rows[0])).toBe(true);
    for (const group of groups) {
      const flags = group.rows.map(rowHasChanges);
      expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    }
    const items = overviewItems("read", "Mac mini", groups);
    expect(items[0]!.id).toBe("mac");
    expect(items[0]!.kind.type === "mac" && items[0]!.kind.detail).toMatch(/with changes$/);
    expect(items[1]!.kind).toEqual({ type: "workspace", name: groups[0]!.workspace });
    // build-box: no folder there is a repository.
    expect(result.hosts[1]!.groups.flatMap((group) => group.rows).every((row) => row.git?.kind === "notARepository")).toBe(true);
  });

  it("runs at most three commands at once on a machine", async () => {
    let running = 0;
    let most = 0;
    const git = new DemoGit(start);
    const counting: ReadOnlyCommandRunner = {
      async runReadOnlyCommand(command, max, signal) {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
        return git.runReadOnlyCommand(command, max, signal);
      },
    };
    const mac = await machine(demoHostIds.macMini, { runner: counting });
    await everyMachine(hosts(mac));
    expect(most).toBe(3);
  });

  it("shows an offline machine as offline", async () => {
    const mac = await machine(demoHostIds.macMini, { state: "offline" });
    const result = await everyMachine(hosts(mac));
    expect(result.hosts).toEqual([{ hostId: demoHostIds.macMini, name: "Mac mini", state: "offline", groups: [] }]);
    expect(mac.git.commands).toEqual([]);
  });

  it("lists the agent panes with their workspace and folder, and who shares a folder", async () => {
    const mac = await machine();
    const topology = mac.view.topology!;
    const panes = changesPanes(topology, demoHostIds.macMini, start, (paneId) => herdrSession(topology, paneId));
    expect(panes.some((pane) => pane.paneId === "w8:p1")).toBe(false);
    const fable = panes.find((pane) => pane.paneId === "w2:p1")!;
    expect(fable.workspace).toBe("Quartz");
    expect(fable.folder).toBe(demoGitFolders.quartz);
    expect(sharingPanes("w2:p1", demoGitFolders.quartz, panes).length).toBe(1);
    expect(sharingPanes(macBuildPane, demoGitFolders.macBuild, panes)).toEqual([]);
    expect(panes.find((pane) => pane.paneId === macBuildPane)!.session).not.toBeNull();
    expect(panes.find((pane) => pane.paneId === "w2:p70")!.session).toBeNull();
  });
});
