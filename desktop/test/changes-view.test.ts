// The Changes views on the hooks host (no DOM): an agent's
// Changes (the loading rows, then the read; a file's, an edit's and a commit's
// diff with Back; Try again; once more when the agent leaves Working; another
// pane drops what was shown; closing ends the reads) and the across-agents
// screen (every machine, a row opens the agent, Refresh, a pane leaving Working
// reads once more). Ports of CompanionChangesUITests' shapes and
// CompanionChangesHookTests testTheScreenReadsAgainWhenATurnFinishes.

import { describe, expect, it, vi } from "vitest";

import { gitFileChange, type AgentCommit, type GitFolderStatus } from "../src/shared/changes/git";
import type { AgentChangedFile } from "../src/shared/changes/tools";
import { emptyToolChanges } from "../src/shared/changes/tools";
import type { ChangesOverviewHost } from "../src/shared/changes/content";
import type { ChangesAgentResult, ChangesDiffRequest, ChangesDiffResult, HostView } from "../src/shared/ipc-contract";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChangesView } = await import("../src/renderer/changes/ChangesView");
const { ChangesOverview } = await import("../src/renderer/changes/ChangesOverview");
const { DiffView } = await import("../src/renderer/changes/DiffView");

const folder = "/Users/fixture/app";
const clock = 1_793_588_400;

/** A promise answered by the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function text(tree: unknown): string {
  const parts: string[] = [];
  for (const element of elements(tree)) {
    const children = element.props.children;
    for (const child of Array.isArray(children) ? children : [children]) if (typeof child === "string") parts.push(child);
  }
  return parts.join(" | ");
}

const byItem = (tree: unknown, id: string) => elements(tree).find((e) => e.props["data-item"] === id);
const byLabel = (tree: unknown, label: string) => elements(tree).find((e) => e.props["aria-label"] === label);
const click = (element: { props: Record<string, unknown> } | undefined): void => {
  expect(element).toBeDefined();
  (element!.props["onClick"] as () => void)();
};

const edited: AgentChangedFile = {
  path: folder + "/App/a.swift",
  added: 2,
  removed: 1,
  edits: [
    {
      callId: "c1",
      tool: "Edit",
      path: folder + "/App/a.swift",
      turnId: "t1",
      turnNumber: 1,
      turnMessage: "fix it",
      time: clock,
      added: 2,
      removed: 1,
      lines: [
        { kind: "removed", text: "old" },
        { kind: "added", text: "new" },
        { kind: "added", text: "newer" },
      ],
      moreLines: 0,
    },
  ],
};

const status: GitFolderStatus = {
  top: folder,
  head: { kind: "branch", name: "main" },
  files: [gitFileChange("App/a.swift", " ", "M", { added: 2, removed: 1 }), gitFileChange("notes.md", "?", "?")],
  cut: false,
};

const commit: AgentCommit = { hash: "4f1c2a9e7b3d5c6a8e9f0b1c2d3e4f5a6b7c8d9e", subject: "Add the away summary", time: clock, parents: 1, files: 1, added: 3, removed: 1 };

function agentResult(fields: Partial<ChangesAgentResult> = {}): ChangesAgentResult {
  return {
    hostId: "h1",
    paneId: "w1:p1",
    kind: "claude",
    folder,
    online: true,
    tools: { kind: "read", changes: { ...emptyToolChanges, session: [edited], turnCount: 1, firstTurnAt: clock } },
    git: { kind: "read", read: { kind: "repository", status } },
    commits: { kind: "read", read: { kind: "commits", commits: [commit] } },
    commitsSince: clock,
    sinceKnown: true,
    sharing: [],
    ...fields,
  };
}

class FakeBridge {
  readonly agentCalls: [string, string][] = [];
  readonly diffCalls: ChangesDiffRequest[] = [];
  closes = 0;
  readonly copied: string[] = [];
  agentAnswers: ReturnType<typeof deferred<ChangesAgentResult | null>>[] = [];
  diffAnswers: ReturnType<typeof deferred<ChangesDiffResult | null>>[] = [];
  overviewAnswers: ReturnType<typeof deferred<ChangesOverviewHost | null>>[] = [];
  readonly overviewHosts: string[] = [];
  overviewCalls = 0;
  changesAgent = (hostId: string, paneId: string): Promise<ChangesAgentResult | null> => {
    this.agentCalls.push([hostId, paneId]);
    const answer = deferred<ChangesAgentResult | null>();
    this.agentAnswers.push(answer);
    return answer.promise;
  };
  changesDiff = (_hostId: string, _paneId: string, request: ChangesDiffRequest): Promise<ChangesDiffResult | null> => {
    this.diffCalls.push(request);
    const answer = deferred<ChangesDiffResult | null>();
    this.diffAnswers.push(answer);
    return answer.promise;
  };
  changesOverview = (hostId: string): Promise<ChangesOverviewHost | null> => {
    this.overviewCalls += 1;
    this.overviewHosts.push(hostId);
    const answer = deferred<ChangesOverviewHost | null>();
    this.overviewAnswers.push(answer);
    return answer.promise;
  };
  closeChanges = (): void => {
    this.closes += 1;
  };
  copyText = (value: string): void => {
    this.copied.push(value);
  };
}

const diffText = (path: string): ChangesDiffResult => ({
  kind: "text",
  text: { parts: [{ title: "Not staged", text: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n` }], cut: false },
  bound: 256 * 1_024,
});

describe("an agent's Changes", () => {
  it("shows the loading rows, then what the read gave", async () => {
    const bridge = new FakeBridge();
    const host = new HookHost(ChangesView, { bridge, hostId: "h1", paneId: "w1:p1", kind: "claude", folder, working: false });
    let tree = host.render();
    expect(bridge.agentCalls).toEqual([["h1", "w1:p1"]]);
    expect(byItem(tree, "tools-loading")).toBeDefined();
    expect(byItem(tree, "git-loading")).toBeDefined();
    expect(byLabel(tree, "Reading")).toBeDefined();
    expect(byLabel(tree, "Folder " + folder)).toBeDefined();
    bridge.agentAnswers[0]!.resolve(agentResult());
    await settle();
    tree = host.tree;
    expect(byItem(tree, "tools-loading")).toBeUndefined();
    expect(byLabel(tree, "Refresh")).toBeDefined();
    const all = text(tree);
    expect(all).toContain("This turn");
    expect(all).toContain("This session");
    expect(all).toContain("In its folder now");
    expect(all).toContain("main · 1 file +2 −1 · 1 untracked");
    expect(all).toContain("Commits this session");
    expect(byLabel(tree, "App/a.swift, 2 added, 1 removed, 1 edit")).toBeDefined();
    expect(byLabel(tree, "modified, App/a.swift, 2 added, 1 removed")).toBeDefined();
    expect(byLabel(tree, "untracked, notes.md")).toBeDefined();
    expect(String(byItem(tree, "commit|" + commit.hash)?.props["aria-label"])).toMatch(/^Commit Add the away summary, 4f1c2a9 · .+ · 1 file$/);
  });

  it("opens an edit's, a file's and a commit's diff, with Back and Try again", async () => {
    const bridge = new FakeBridge();
    const host = new HookHost(ChangesView, { bridge, hostId: "h1", paneId: "w1:p1", kind: "claude", folder, working: false });
    host.render();
    bridge.agentAnswers[0]!.resolve(agentResult());
    await settle();

    // Its own edits: shown from the read, nothing asked.
    click(byItem(host.tree, "session|" + edited.path));
    let tree = host.tree;
    const diff = elements(tree).find((e) => e.type === DiffView);
    expect(diff).toBeDefined();
    expect(text(tree)).toContain("App/a.swift");
    expect(text(tree)).toContain("This session · 1 edit by its own calls");
    expect(bridge.diffCalls).toEqual([]);
    const document = diff!.props["document"] as { added: number; removed: number };
    expect([document.added, document.removed]).toEqual([2, 1]);
    click(byLabel(tree, "Back to Changes"));
    expect(byItem(host.tree, "git")).toBeDefined();

    // A folder file: reading, then its diff.
    click(byItem(host.tree, "git|App/a.swift"));
    expect(bridge.diffCalls).toEqual([{ kind: "file", path: "App/a.swift" }]);
    expect(text(host.tree)).toContain("Reading the diff…");
    expect(text(host.tree)).toContain("modified · not staged");
    bridge.diffAnswers[0]!.resolve(diffText("App/a.swift"));
    await settle();
    expect(elements(host.tree).find((e) => e.type === DiffView)).toBeDefined();
    click(byLabel(host.tree, "Back to Changes"));

    // A commit that fails: Try again asks again.
    click(byItem(host.tree, "commit|" + commit.hash));
    expect(bridge.diffCalls[1]).toEqual({ kind: "commit", hash: commit.hash });
    expect(text(host.tree)).toContain("Add the away summary");
    bridge.diffAnswers[1]!.resolve({ kind: "failed" });
    await settle();
    expect(text(host.tree)).toContain("git could not be read.");
    click(elements(host.tree).find((e) => e.props["className"] === "ch-try"));
    expect(bridge.diffCalls.length).toBe(3);
    bridge.diffAnswers[2]!.resolve({ kind: "notARepository" });
    await settle();
    expect(text(host.tree)).toContain("The folder is not a git repository.");
    expect(elements(host.tree).find((e) => e.props["className"] === "ch-try")).toBeUndefined();
  });

  it("reads again on Try again, on Refresh and once when the agent leaves Working", async () => {
    const bridge = new FakeBridge();
    const props = { bridge, hostId: "h1", paneId: "w1:p1", kind: "claude", folder, working: true };
    const host = new HookHost(ChangesView, props);
    host.render();
    bridge.agentAnswers[0]!.resolve(agentResult({ git: { kind: "read", read: { kind: "failed" } } }));
    await settle();
    expect(text(host.tree)).toContain("git could not be read.");
    click(elements(host.tree).find((e) => e.props["className"] === "ch-try"));
    expect(bridge.agentCalls.length).toBe(2);
    bridge.agentAnswers[1]!.resolve(agentResult());
    await settle();
    click(byLabel(host.tree, "Refresh"));
    expect(bridge.agentCalls.length).toBe(3);
    bridge.agentAnswers[2]!.resolve(agentResult());
    await settle();
    host.render({ ...props, working: true });
    expect(bridge.agentCalls.length).toBe(3);
    host.render({ ...props, working: false });
    expect(bridge.agentCalls.length).toBe(4);
    host.render({ ...props, working: false });
    expect(bridge.agentCalls.length).toBe(4);
  });

  it("drops what was shown for another pane, ignores an ended read, and closes the reads when it goes", async () => {
    const bridge = new FakeBridge();
    const props = { bridge, hostId: "h1", paneId: "w1:p1", kind: "claude", folder: folder as string | null, working: false };
    const host = new HookHost(ChangesView, props);
    host.render();
    bridge.agentAnswers[0]!.resolve(agentResult());
    await settle();
    click(byItem(host.tree, "session|" + edited.path));
    expect(elements(host.tree).find((e) => e.type === DiffView)).toBeDefined();
    host.render({ ...props, paneId: "w1:p2", folder: null, kind: "codex" });
    expect(elements(host.tree).find((e) => e.type === DiffView)).toBeUndefined();
    expect(byItem(host.tree, "git-none")).toBeDefined();
    expect(bridge.agentCalls[1]).toEqual(["h1", "w1:p2"]);
    bridge.agentAnswers[1]!.resolve(null);
    await settle();
    expect(byItem(host.tree, "tools-loading")).toBeDefined();
    bridge.agentAnswers[1]!.resolve(agentResult({ paneId: "w1:p2", online: false, git: { kind: "offline" }, commits: { kind: "offline" } }));
    host.unmount();
    expect(bridge.closes).toBe(1);
  });

  it("says offline with the machine's words", async () => {
    const bridge = new FakeBridge();
    const host = new HookHost(ChangesView, { bridge, hostId: "h1", paneId: "w1:p1", kind: "claude", folder, working: false });
    host.render();
    bridge.agentAnswers[0]!.resolve(
      agentResult({ online: false, tools: { kind: "none", reason: "Its own changes can't be read while the machine is offline." }, git: { kind: "offline" }, commits: { kind: "offline" } }),
    );
    await settle();
    expect(text(host.tree)).toContain("The machine is offline: its folders can't be read now.");
    expect(byItem(host.tree, "git")).toBeUndefined();
  });
});

function hostView(id: string, name: string, working: boolean, state: HostView["state"] = "connected"): HostView {
  return {
    id,
    name,
    kind: "demo",
    address: "demo",
    platform: "macOS",
    state,
    error: null,
    fetchedAtMs: 0,
    topology: { panes: [{ paneID: "w1:p1", agent: "claude", agentStatus: working ? "working" : "done" }], workspaces: [], tabs: [], agents: [] } as unknown as HostView["topology"],
  };
}

const overview: { hosts: ChangesOverviewHost[] } = {
  hosts: [
    {
      hostId: "h1",
      name: "Mac mini",
      state: "read",
      groups: [
        {
          workspace: "herdr",
          rows: [
            {
              pane: { paneId: "w1:p1", name: "app-build", kind: "claude", folder, workspace: "herdr", session: null },
              git: { kind: "repository", status },
              tools: { kind: "read", changes: { ...emptyToolChanges, session: [{ ...edited, edits: [] }] } },
            },
          ],
        },
      ],
    },
    { hostId: "h2", name: "build-box", state: "offline", groups: [] },
  ],
};

describe("every agent's Changes", () => {
  it("lists every machine's agents, and a row opens that agent", async () => {
    const bridge = new FakeBridge();
    const opened: [string, string][] = [];
    let closed = 0;
    const host = new HookHost(ChangesOverview, {
      bridge,
      hosts: [hostView("h1", "Mac mini", false), hostView("h2", "build-box", false, "offline")],
      onOpenAgent: (h: string, p: string) => opened.push([h, p]),
      onClose: () => (closed += 1),
    });
    let tree = host.render();
    // The offline machine is not asked.
    expect(bridge.overviewHosts).toEqual(["h1"]);
    expect(text(tree)).toContain("Reading every agent's folder…");
    expect(text(tree)).toContain("The machine is offline: its folders can't be read now.");
    bridge.overviewAnswers[0]!.resolve(overview.hosts[0]!);
    await settle();
    tree = host.tree;
    const all = text(tree);
    expect(all).toContain("Mac mini");
    expect(all).toContain("1 of 1 agent with changes");
    expect(all).toContain("herdr");
    expect(all).toContain("build-box");
    const row = byLabel(tree, "app-build, claude, main · 1 file +2 −1 · 1 untracked · 1 file by its own calls");
    expect(row?.props["className"]).toBe("ov-agent changed");
    click(row);
    expect(opened).toEqual([["h1", "w1:p1"]]);
    click(byLabel(tree, "Back"));
    expect(closed).toBe(1);
    host.unmount();
    expect(bridge.closes).toBe(1);
  });

  it("reads again on Refresh, when a machine comes or goes, and once when a pane leaves Working", async () => {
    const bridge = new FakeBridge();
    const props = { bridge, hosts: [hostView("h1", "Mac mini", true)], onOpenAgent: () => undefined, onClose: () => undefined };
    const host = new HookHost(ChangesOverview, props);
    host.render();
    bridge.overviewAnswers[0]!.resolve(overview.hosts[0]!);
    await settle();
    click(byLabel(host.tree, "Refresh"));
    expect(bridge.overviewCalls).toBe(2);
    bridge.overviewAnswers[1]!.resolve(overview.hosts[0]!);
    await settle();
    host.render({ ...props, hosts: [hostView("h1", "Mac mini", true)] });
    expect(bridge.overviewCalls).toBe(2);
    host.render({ ...props, hosts: [hostView("h1", "Mac mini", false)] });
    expect(bridge.overviewCalls).toBe(3);
    bridge.overviewAnswers[2]!.resolve(overview.hosts[0]!);
    await settle();
    host.render({ ...props, hosts: [hostView("h1", "Mac mini", false)] });
    expect(bridge.overviewCalls).toBe(3);
    host.render({ ...props, hosts: [hostView("h1", "Mac mini", false), hostView("h2", "build-box", false)] });
    expect(bridge.overviewCalls).toBe(5);
    expect(bridge.overviewHosts.slice(3)).toEqual(["h1", "h2"]);
    // An ended read (null) keeps what was shown; a machine with nothing shown says so instead of spinning.
    bridge.overviewAnswers[3]!.resolve(null);
    bridge.overviewAnswers[4]!.resolve(null);
    await settle();
    expect(text(host.tree)).toContain("app-build");
    expect(text(host.tree)).toContain("This machine's folders could not be read. Refresh to try again.");
    expect(byLabel(host.tree, "Refresh")?.props["className"]).toBe("ib");
  });

  it("a pane leaving Working while a read runs waits for it: one more read after it, never one per turn", async () => {
    const bridge = new FakeBridge();
    const props = { bridge, hosts: [hostView("h1", "Mac mini", true)], onOpenAgent: () => undefined, onClose: () => undefined };
    const host = new HookHost(ChangesOverview, props);
    host.render();
    expect(bridge.overviewCalls).toBe(1);
    for (let turn = 0; turn < 4; turn += 1) {
      host.render({ ...props, hosts: [hostView("h1", "Mac mini", true)] });
      host.render({ ...props, hosts: [hostView("h1", "Mac mini", false)] });
    }
    expect(bridge.overviewCalls, "the read running is not ended").toBe(1);
    expect(byLabel(host.tree, "Refresh")?.props["className"]).toBe("ib on");
    bridge.overviewAnswers[0]!.resolve(overview.hosts[0]!);
    await settle();
    expect(text(host.tree)).toContain("app-build");
    expect(bridge.overviewCalls, "one more, for the four turns").toBe(2);
    bridge.overviewAnswers[1]!.resolve(overview.hosts[0]!);
    await settle();
    expect(bridge.overviewCalls).toBe(2);
    expect(byLabel(host.tree, "Refresh")?.props["className"]).toBe("ib");
  });

  it("a machine whose read fails says so on it", async () => {
    const bridge = new FakeBridge();
    const failing = { ...bridge, changesOverview: (): Promise<ChangesOverviewHost | null> => Promise.reject(new Error("lost")), closeChanges: () => undefined };
    const host = new HookHost(ChangesOverview, { bridge: failing, hosts: [hostView("h1", "Mac mini", false)], onOpenAgent: () => undefined, onClose: () => undefined });
    host.render();
    await settle();
    expect(text(host.tree)).toContain("Mac mini");
    expect(text(host.tree)).toContain("This machine's folders could not be read. Refresh to try again.");
    expect(text(host.tree)).not.toContain("Reading every agent's folder…");
    expect(byLabel(host.tree, "Refresh")?.props["className"]).toBe("ib");
  });
});

// An open agent's Changes follows its context.
// Its folder, its session, the agent in the pane, the machine and that
// machine's connection: a change drops the old list and diff, reads again (or,
// offline, says so without reading), and an answer for an older context never
// shows.
const { MainPane } = await import("../src/renderer/components/MainPane");

describe("an open agent's Changes follows its context", () => {
  const other = "/Users/fixture/other";
  const third = "/Users/fixture/third";
  const base = { hostId: "h1", paneId: "w1:p1", kind: "claude", folder: folder as string | null, working: false, online: true, session: "claude|s1" as string | null };
  const loadingGit = (tree: unknown) => byItem(tree, "git-loading");

  it("a new folder drops the old rows and reads again; an older folder's answer never shows", async () => {
    const bridge = new FakeBridge();
    const props = { ...base, bridge };
    const host = new HookHost(ChangesView, props);
    host.render();
    bridge.agentAnswers[0]!.resolve(agentResult());
    await settle();
    expect(text(host.tree)).toContain("main · 1 file +2 −1 · 1 untracked");
    host.render({ ...props });
    expect(bridge.agentCalls.length, "the same context reads nothing").toBe(1);

    host.render({ ...props, folder: other });
    expect(bridge.agentCalls).toEqual([
      ["h1", "w1:p1"],
      ["h1", "w1:p1"],
    ]);
    expect(byLabel(host.tree, "Folder " + other)).toBeDefined();
    expect(loadingGit(host.tree)).toBeDefined();
    expect(text(host.tree)).not.toContain("main · 1 file");

    // A third folder while the second read is out: the second's answer is dropped.
    host.render({ ...props, folder: third });
    expect(bridge.agentCalls.length).toBe(3);
    bridge.agentAnswers[1]!.resolve(agentResult({ folder: other }));
    await settle();
    expect(byLabel(host.tree, "Folder " + third)).toBeDefined();
    expect(loadingGit(host.tree)).toBeDefined();
    bridge.agentAnswers[2]!.resolve(agentResult({ folder: third }));
    await settle();
    expect(byLabel(host.tree, "Folder " + third)).toBeDefined();
    expect(loadingGit(host.tree)).toBeUndefined();
    expect(text(host.tree)).toContain("main · 1 file +2 −1 · 1 untracked");
  });

  it("a new session in the pane, or another agent there, reads again; an open diff goes and its late answer never shows", async () => {
    const bridge = new FakeBridge();
    const props = { ...base, bridge };
    const host = new HookHost(ChangesView, props);
    host.render();
    bridge.agentAnswers[0]!.resolve(agentResult());
    await settle();
    click(byItem(host.tree, "git|App/a.swift"));
    expect(bridge.diffCalls.length).toBe(1);
    expect(text(host.tree)).toContain("Reading the diff…");

    host.render({ ...props, session: "claude|s2" });
    expect(bridge.agentCalls.length).toBe(2);
    expect(elements(host.tree).find((e) => e.props["data-testid"] === "changes-detail")).toBeUndefined();
    expect(byItem(host.tree, "tools-loading")).toBeDefined();
    bridge.diffAnswers[0]!.resolve(diffText("App/a.swift"));
    await settle();
    expect(elements(host.tree).find((e) => e.type === DiffView), "the old diff's answer").toBeUndefined();
    bridge.agentAnswers[1]!.resolve(agentResult());
    await settle();
    host.render({ ...props, session: "claude|s2" });
    expect(bridge.agentCalls.length).toBe(2);

    host.render({ ...props, session: null, kind: "codex" });
    expect(bridge.agentCalls.length).toBe(3);
    expect(byItem(host.tree, "tools-loading")).toBeDefined();
  });

  it("another machine with the same pane id reads again", async () => {
    const bridge = new FakeBridge();
    const props = { ...base, bridge };
    const host = new HookHost(ChangesView, props);
    host.render();
    bridge.agentAnswers[0]!.resolve(agentResult());
    await settle();
    host.render({ ...props, hostId: "h2" });
    expect(bridge.agentCalls[1]).toEqual(["h2", "w1:p1"]);
    expect(loadingGit(host.tree)).toBeDefined();
    bridge.agentAnswers[0]!.resolve(agentResult());
    await settle();
    expect(loadingGit(host.tree)).toBeDefined();
  });

  it("says the machine is offline at once, without reading, and reads again when it reconnects", async () => {
    const bridge = new FakeBridge();
    const props = { ...base, bridge };
    const host = new HookHost(ChangesView, props);
    host.render();
    bridge.agentAnswers[0]!.resolve(agentResult());
    await settle();
    click(byItem(host.tree, "commit|" + commit.hash));
    expect(bridge.diffCalls.length).toBe(1);

    host.render({ ...props, online: false });
    expect(bridge.agentCalls.length, "offline: nothing is read").toBe(1);
    let all = text(host.tree);
    expect(all).toContain("The machine is offline: its folders can't be read now.");
    expect(all).toContain("Its own changes can't be read while the machine is offline.");
    expect(all).not.toContain("main · 1 file");
    expect(all).not.toContain("Add the away summary");
    expect(byLabel(host.tree, "Refresh")?.props["disabled"]).toBe(true);
    bridge.diffAnswers[0]!.resolve(diffText("x"));
    await settle();
    expect(elements(host.tree).find((e) => e.type === DiffView)).toBeUndefined();
    // Leaving Working while offline reads nothing either.
    host.render({ ...props, online: false, working: true });
    host.render({ ...props, online: false, working: false });
    expect(bridge.agentCalls.length).toBe(1);

    host.render({ ...props, online: true });
    expect(bridge.agentCalls.length, "back online: read again").toBe(2);
    expect(loadingGit(host.tree)).toBeDefined();
    bridge.agentAnswers[1]!.resolve(agentResult());
    await settle();
    all = text(host.tree);
    expect(all).not.toContain("The machine is offline");
    expect(all).toContain("main · 1 file +2 −1 · 1 untracked");
  });

  it("an answer read before the machine went offline never shows", async () => {
    const bridge = new FakeBridge();
    const props = { ...base, bridge };
    const host = new HookHost(ChangesView, props);
    host.render();
    host.render({ ...props, online: false });
    bridge.agentAnswers[0]!.resolve(agentResult());
    await settle();
    expect(text(host.tree)).toContain("The machine is offline: its folders can't be read now.");
    expect(text(host.tree)).not.toContain("main · 1 file");
  });

  it("MainPane gives the view the machine's connection and the agent's session", () => {
    vi.stubGlobal("window", { herdrDesktop: new FakeBridge() });
    try {
      const session = (value: string) => ({ source: "herdr", agent: "claude", kind: "session_id", value });
      const topology = (agentSession: ReturnType<typeof session> | undefined) =>
        ({
          panes: [{ paneID: "w1:p1", agent: "claude", cwd: folder }],
          workspaces: [],
          tabs: [],
          agents: [{ paneID: "w1:p1", agent: "claude", cwd: folder, ...(agentSession === undefined ? {} : { agentSession }) }],
        }) as unknown as HostView["topology"];
      const machine: HostView = { ...hostView("h1", "Mac mini", false), topology: topology(session("s1")) };
      const row = { paneID: "w1:p1", tabID: "w1:t1", workspaceID: "w1", workspaceLabel: "app", cwd: folder, name: "agent", nameSource: "agent", kind: "claude", isAgent: true, status: "idle", glyph: "idle", isDimmed: false };
      const props = { host: machine, row, tab: "changes", onTab: () => undefined, mac: true, fontSize: 13, boxShown: false, onBoxShown: () => undefined, ghostty: { shown: false }, onOpenInGhostty: () => undefined };
      const pane = new HookHost(MainPane as (props: object) => unknown, props);
      pane.render();
      const view = () => elements(pane.tree).find((e) => e.type === ChangesView)!.props;
      expect(view()).toMatchObject({ hostId: "h1", paneId: "w1:p1", folder, online: true });
      const first = view()["session"];
      expect(typeof first).toBe("string");

      pane.render({ ...props, host: { ...machine, state: "offline" } });
      expect(view()["online"]).toBe(false);
      pane.render({ ...props, host: { ...machine, topology: topology(session("s2")) } });
      expect(view()["online"]).toBe(true);
      expect(view()["session"]).not.toBe(first);
      pane.render({ ...props, host: { ...machine, topology: topology(undefined) } });
      expect(view()["session"]).toBeNull();
      pane.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
