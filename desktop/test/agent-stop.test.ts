// The Stop square. In Chat, while Herdr says the pane's
// agent works, the box is empty and the machine answers, an outlined square
// (Stop, "Stop (Esc)") stands in Send's place (the iPhone and iPad app's
// CompanionChatStop.shows); typing or attaching brings Send back. A click sends
// Escape to that pane's agent once (`agent.send_keys ["Escape"]`); while it is
// in flight the square is busy and a second click does nothing. The real
// Composer runs on the small hooks host (test/support/fake-hooks.ts) with a fake
// bridge; the main process's stop handler runs for real on a fake machine.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type AgentInfo, type SessionTopology, type TopologyPaneInfo } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { stopShows } from "../src/shared/agent-stop";
import { IPC } from "../src/shared/ipc-contract";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { agentStops } = await import("../src/renderer/components/agent-stop");
const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");

interface StopCall {
  readonly hostId: string;
  readonly paneId: string;
  readonly binding: unknown;
  resolve(note: string | null): void;
}

let stops: StopCall[] = [];

beforeEach(() => {
  stops = [];
  composerDrafts.clear();
  agentStops.clear();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: () => Promise.resolve(),
      stopAgent: (hostId: string, paneId: string, binding: unknown) =>
        new Promise<string | null>((resolve) => stops.push({ hostId, paneId, binding, resolve })),
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

/** One pane w1:p1 with `agent` in it, Herdr saying `status`. */
function topologyOf(status: string, agent: string | null = "claude"): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [
      {
        pane_id: "w1:p1",
        terminal_id: "t-7",
        workspace_id: "w1",
        tab_id: "w1:t1",
        focused: false,
        ...(agent === null ? {} : { agent }),
        agent_status: status,
        revision: 1,
      },
    ],
    layouts: [],
    agents:
      agent === null
        ? []
        : [
            {
              pane_id: "w1:p1",
              agent,
              agent_status: status,
              terminal_id: "t-7",
              state_change_seq: 12,
              status_since_unix_ms: 1_762_000_000_000,
              agent_session: { source: `herdr:${agent}`, agent, kind: "id", value: "s-1" },
            },
          ],
  });
}

function hostOf(state: HostView["state"], topology: SessionTopology): HostView {
  return { id: "mac-mini", name: "Mac mini", state, topology, connection: 3, incarnation: 1, epoch: 7 } as HostView;
}

const workingRow = {
  paneID: "w1:p1",
  name: "claude 1",
  workspaceLabel: "ops",
  isAgent: true,
  kind: "claude",
  status: "working",
  glyph: "working",
} as SidebarRow;

function composer(host: HostView, row: SidebarRow) {
  const ui = new HookHost(Composer, { host, row, floating: true, stops: true });
  ui.render();
  const button = (label: string) => elements(ui.tree).find((e) => e.type === "button" && e.props["aria-label"] === label);
  return {
    ui,
    stop: () => button("Stop"),
    send: () => button("Send"),
    click: (label: string) => (button(label)!.props["onClick"] as () => void)(),
    type: (value: string) =>
      (elements(ui.tree).find((e) => e.type === "textarea")!.props["onChange"] as (e: unknown) => void)({ target: { value } }),
  };
}

describe("when Stop shows (the iPad's CompanionChatStop.shows)", () => {
  const base = { isAgent: true, status: "working", online: true, boxHasContent: false } as const;
  it("shows for a working agent with an empty box on a machine that answers", () => {
    expect(stopShows(base)).toBe(true);
  });
  it("hides for text or attachments in the box, a shell, an exited agent, a dialog, an idle agent or an offline machine", () => {
    expect(stopShows({ ...base, boxHasContent: true })).toBe(false);
    expect(stopShows({ ...base, isAgent: false })).toBe(false);
    expect(stopShows({ ...base, status: "blocked" })).toBe(false);
    expect(stopShows({ ...base, status: "idle" })).toBe(false);
    expect(stopShows({ ...base, status: "done" })).toBe(false);
    expect(stopShows({ ...base, online: false })).toBe(false);
  });
});

describe("the Stop square in Chat's box", () => {
  it("stands in Send's place while the agent works and the box is empty, with its tooltip", () => {
    const c = composer(hostOf("connected", topologyOf("working")), workingRow);
    expect(c.send()).toBeUndefined();
    expect(c.stop()?.props["title"]).toBe("Stop (Esc)");
    expect(String(c.stop()?.props["className"])).toContain("stop");
    c.ui.unmount();
  });

  it("gives Send back when the user types or attaches, and Stop again when the box empties", () => {
    const c = composer(hostOf("connected", topologyOf("working")), workingRow);
    c.type("one more thing");
    expect(c.stop()).toBeUndefined();
    expect(c.send()).toBeDefined();
    c.type("");
    expect(c.stop()).toBeDefined();
    composerDrafts.attach(draftKey("mac-mini", "w1:p1"), [{ name: "shot.png", extension: "png", image: true, data: new Uint8Array([1]) }]);
    c.ui.render();
    expect(c.stop()).toBeUndefined();
    expect(c.send()).toBeDefined();
    c.ui.unmount();
  });

  it("never shows for a shell pane, an exited agent, an agent waiting on a dialog, an idle agent or an offline machine", () => {
    const cases: [HostView, SidebarRow][] = [
      [hostOf("connected", topologyOf("unknown", null)), { ...workingRow, isAgent: false, kind: "shell", status: "absent", glyph: "shell" } as SidebarRow],
      [hostOf("connected", topologyOf("unknown", null)), { ...workingRow, isAgent: false, kind: "shell", status: "absent", glyph: "shell", exitedAgent: "claude" } as SidebarRow],
      [hostOf("connected", topologyOf("blocked")), { ...workingRow, status: "blocked", glyph: "needsYou" } as SidebarRow],
      [hostOf("connected", topologyOf("idle")), { ...workingRow, status: "idle", glyph: "idle" } as SidebarRow],
      [hostOf("offline", topologyOf("working")), workingRow],
      [hostOf("connecting", topologyOf("working")), workingRow],
    ];
    for (const [host, row] of cases) {
      const c = composer(host, row);
      expect(c.stop()).toBeUndefined();
      expect(c.send()).toBeDefined();
      c.ui.unmount();
    }
  });

  it("is not in the box over the terminal (Esc there is the terminal's)", () => {
    const ui = new HookHost(Composer, { host: hostOf("connected", topologyOf("working")), row: workingRow, overlay: true, onDismiss: () => undefined });
    ui.render();
    expect(elements(ui.tree).some((e) => e.props["aria-label"] === "Stop")).toBe(false);
    ui.unmount();
  });

  it("sends one Esc per press for the tile's own pane, bound to the terminal shown, the spinner a look only", async () => {
    const c = composer(hostOf("connected", topologyOf("working")), workingRow);
    c.click("Stop");
    c.click("Stop");
    expect(stops.map((s) => [s.hostId, s.paneId])).toEqual([
      ["mac-mini", "w1:p1"],
      ["mac-mini", "w1:p1"],
    ]);
    expect(stops[0]!.binding).toMatchObject({
      terminalID: "t-7",
      kind: "claude",
      session: "s-1",
      episode: { status: "working", seq: "12", since: "1762000000000" },
      incarnation: 1,
      connection: 3,
      name: "Claude Code",
    });
    expect(c.stop()?.props["aria-busy"]).toBe(true);
    expect(c.stop()?.props["title"]).toBe("Stopping…");
    expect(String(c.stop()?.props["className"])).toContain("busy");
    stops[0]!.resolve(null);
    stops[1]!.resolve(null);
    await flush();
    // Esc went: the spinner stays until Herdr reports the agent not working; a press still sends.
    expect(c.stop()?.props["aria-busy"]).toBe(true);
    c.click("Stop");
    expect(stops).toHaveLength(3);
    c.ui.unmount();
  });
});

// The main process: one `agent.send_keys ["Escape"]` to the pane, at once.
const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

function paneInfo(status: string): TopologyPaneInfo {
  return { paneID: "w1:p1", terminalID: "t-7", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: status, revision: 1 };
}

function agentInfo(status: string): AgentInfo {
  return {
    paneID: "w1:p1",
    agent: "claude",
    agentStatus: status,
    terminalID: "t-7",
    stateChangeSeq: 12,
    statusSinceUnixMs: 1_762_000_000_000,
    agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" },
  };
}

function stopMachine(remote: { pane: TopologyPaneInfo | null; agent: AgentInfo | null } = { pane: paneInfo("working"), agent: agentInfo("working") }) {
  const log: unknown[][] = [];
  const state = { cached: remote, remote };
  const backend = {
    agentKeys: async (paneID: string, keys: readonly string[]) => void log.push(["agentKeys", paneID, keys]),
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => state.cached.pane,
    agent: () => state.cached.agent,
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
    snapshotEpoch: () => 7,
    refresh: async () => undefined,
    fresh: async () => {
      log.push(["fresh"]);
      state.cached = state.remote;
      return true;
    },
  };
  registerIpc({ hosts } as never);
  const stop = registered.handles.get(IPC.paneStop)!;
  return { log, stop: (paneId: string, binding: unknown) => stop(event, "mac-mini", paneId, binding) as Promise<string | null> };
}

const shownBinding = {
  terminalID: "t-7",
  kind: "claude",
  session: "s-1",
  episode: { status: "working", seq: "12", since: "1762000000000" },
  incarnation: 1,
  connection: 3,
  epoch: 7,
  name: "Claude",
};

describe("the stop in the main process", () => {
  it("sends exactly one agent.send_keys Escape to the pane, with no fresh snapshot first", async () => {
    const m = stopMachine();
    expect(await m.stop("w1:p1", shownBinding)).toBeNull();
    expect(m.log).toEqual([["agentKeys", "w1:p1", ["Escape"]]]);
  });

  it("refuses a malformed request", async () => {
    const m = stopMachine();
    await expect(m.stop("w1:p1", { ...shownBinding, name: 7 })).rejects.toThrow("bad request");
    expect(m.log).toEqual([]);
  });
});
