// The demo's Herdr gains only what the
// captures need, off until a capture sets it: a kind whose new pane answers
// `agent_pane_busy` for its first starts, one that answers `agent_not_ready`
// with its sign-in screen, one whose shell prints `zsh: command not found`, and
// a cwd the machine does not have giving a pane in its home. Each runs here
// through the real HerdrClient, newAgent and newWorkspace, with a fake clock.

import { describe, expect, it } from "vitest";

import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { newAgent } from "../src/main/herdr/new-agent";
import { newWorkspace } from "../src/main/herdr/new-workspace";
import { absentStartCommands, parseStartCommands } from "../src/shared/start-commands";
import { bundledFixturesForTests } from "./support/demo-fixtures";

const start = Date.UTC(2026, 10, 10, 12, 0, 0);

function demo(id: string = demoHostIds.macMini) {
  const host = demoHosts(bundledFixturesForTests(), start).find((candidate) => candidate.descriptor.id === id)!;
  return { host, backend: new DemoBackend(host, bundledFixturesForTests(), undefined, () => start) };
}

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

const methods = (backend: DemoBackend) => backend.transport.requests.map((line) => (JSON.parse(line) as { method: string }).method);

describe("the demo's start quirks", () => {
  it("off by default: a start goes through at once, a folder it lacks is kept as asked", async () => {
    const { backend } = demo();
    const result = await newAgent(backend.workspaceActions(), absentStartCommands, { workspaceId: "w7", folder: "/Users/demo/nowhere", kind: "codex" }, fakeClock(), 90_000, 1_000, { name: "Mac mini", home: () => backend.homeFolder() });
    expect(result.summary).toBeNull();
    expect(methods(backend).filter((method) => method === "agent.start")).toHaveLength(1);
  });

  it("busy for the first starts, then started in the same pane", async () => {
    const { backend } = demo();
    backend.setStartQuirks({ busy: { codex: 3 } });
    const result = await newAgent(backend.workspaceActions(), absentStartCommands, { workspaceId: "w7", folder: null, kind: "codex" }, fakeClock(), 90_000, 1_000, { name: "Mac mini" });
    expect(methods(backend).filter((method) => method === "agent.start")).toHaveLength(4);
    expect(methods(backend).filter((method) => method === "tab.create")).toHaveLength(1);
    const snapshot = await backend.snapshot();
    expect(snapshot.panes.find((pane) => pane.paneID === result.paneId)?.agent).toBe("codex");
  });

  it("busy for ever: the pane closed after 15 s with the plain line", async () => {
    const { backend } = demo();
    backend.setStartQuirks({ busy: { codex: Number.POSITIVE_INFINITY } });
    const failure = (await newAgent(backend.workspaceActions(), absentStartCommands, { workspaceId: "w7", folder: null, kind: "codex" }, fakeClock(), 90_000, 1_000, { name: "Mac mini" }).catch((error: unknown) => error)) as Error;
    expect(failure.message).toBe("The new shell on Mac mini did not reach its prompt in 15 seconds, so Codex was not started.");
    expect(methods(backend).at(-1)).toBe("pane.close");
  });

  it("not ready: the pane stays with its sign-in screen", async () => {
    const { backend } = demo();
    backend.setStartQuirks({ notReady: ["codex"] });
    const result = await newAgent(backend.workspaceActions(), absentStartCommands, { workspaceId: "w7", folder: null, kind: "codex" }, fakeClock(), 90_000, 1_000, { name: "Mac mini" });
    expect(result.summary).toBe("Codex started in its tab but is waiting there, for example to sign in. Answer it in the tab.");
    expect(await backend.paneText(result.paneId, 20)).toContain("Sign in to continue.");
    expect(methods(backend)).not.toContain("pane.close");
  });

  it("missing: Herdr's ok, then the shell's line named", async () => {
    const { backend } = demo();
    backend.setStartQuirks({ missing: ["claude"] });
    const result = await newAgent(backend.workspaceActions(), absentStartCommands, { workspaceId: "w7", folder: null, kind: "claude" }, fakeClock(), 90_000, 1_000, { name: "Mac mini" });
    expect(result.summary).toBe("Claude Code is not installed on Mac mini: its shell says “zsh: command not found: claude”.");
    expect(methods(backend)).not.toContain("pane.close");
  });

  it("missing on the typed path: agents.json's command typed, the shell's line named, the tab left open", async () => {
    const { backend } = demo();
    backend.setStartQuirks({ missing: ["claude"] });
    const commands = parseStartCommands(new TextEncoder().encode('{"claude": "claude"}'));
    const result = await newAgent(backend.workspaceActions(), commands, { workspaceId: "w7", folder: null, kind: "claude" }, fakeClock(), 90_000, 1_000, { name: "Mac mini" });
    expect(result).toMatchObject({ start: { type: "noAgent", command: "claude" }, summary: "Claude Code is not installed on Mac mini: its shell says “zsh: command not found: claude”." });
    expect(methods(backend).filter((method) => method === "pane.send_input")).toHaveLength(1);
    expect(methods(backend)).not.toContain("pane.close");
  });

  it("a folder it does not have (a ~ path too): the pane is in its home, and New workspace and New agent say so", async () => {
    const { backend, host } = demo();
    backend.setStartQuirks({}, true);
    const machine = { name: "Mac mini", home: () => backend.homeFolder() };
    const agent = await newAgent(backend.workspaceActions(), absentStartCommands, { workspaceId: "w7", folder: "~/Code/gone-app", kind: "shell" }, fakeClock(), 90_000, 1_000, machine);
    expect(agent.summary).toBe("The shell was made, but its tab is in /Users/demo, not /Users/demo/Code/gone-app (Herdr could not use that folder).");
    const hosts = {
      backend: () => backend,
      list: () => [{ ...host.descriptor, state: "connected", error: null, topology: { workspaces: [] }, fetchedAtMs: start, connection: 1, incarnation: 1, epoch: 1 } as never],
      fresh: async () => true,
      connection: () => 1,
      connectionIdentity: () => ({ incarnation: 1, epoch: 1 }) as never,
    };
    const binding = { connection: 1, incarnation: 1, epoch: 1 };
    const there = await newWorkspace(hosts, host.descriptor.id, { folder: "~/Code/", name: "Code", binding });
    expect(there).toMatchObject({ folder: "~/Code/", elsewhere: null });
    const gone = await newWorkspace(hosts, host.descriptor.id, { folder: "~/Code/gone-app", name: "gone-app", binding });
    expect(gone.elsewhere).toBe("gone-app was made, but its shell is in /Users/demo, not /Users/demo/Code/gone-app (Herdr could not use that folder)");
    backend.setStartQuirks(null);
  });
});
