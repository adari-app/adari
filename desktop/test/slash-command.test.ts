// A line starting with `/` typed in the Chat box goes to Claude Code or Codex
// as a command. Sent through Herdr's agent.prompt like any message, it would
// show as the user's pending bubble, which the transcript never matches (a
// command's lines are not the user's typing), so it would sit as "Queued" and
// then "Not seen in the transcript yet". Instead it is typed (pane.send_text,
// no paste markers), then its Return (agent.send_keys), checked on a fresh
// snapshot before each, and Chat shows it as a small command row, never a
// bubble of the user's. Ordinary messages are unchanged.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { planSend, sendBound, type SendSite } from "../src/main/herdr/send";
import type { AgentInfo, TopologyPaneInfo } from "../src/main/herdr/wire";
import { isSlashCommand } from "../src/shared/slash-command";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HookHost, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { commandRows } = await import("../src/renderer/chat/command-rows");

describe("what is a command", () => {
  it("one line whose first word is / and a command name", () => {
    expect(isSlashCommand("/model opus")).toBe(true);
    expect(isSlashCommand("/effort high")).toBe(true);
    expect(isSlashCommand("  /compact keep the plan  ")).toBe(true);
    expect(isSlashCommand("/clear")).toBe(true);
    expect(isSlashCommand("/plugin:skill-name args")).toBe(true);
    // A path is a message, not a command.
    expect(isSlashCommand("/Users/dev/notes.md please read this")).toBe(false);
    expect(isSlashCommand("/tmp/x")).toBe(false);
    expect(isSlashCommand("// not a command")).toBe(false);
    expect(isSlashCommand("/ model")).toBe(false);
    expect(isSlashCommand("/model opus\nand then this")).toBe(false);
    expect(isSlashCommand("please run /model opus")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
  });
});

describe("the Send rule for a command", () => {
  it("is typed and then Return for Claude Code and Codex; ordinary messages and other agents are unchanged", () => {
    expect(planSend("/model opus", { isAgent: true, kind: "claude" })).toEqual({ kind: "typed", text: "/model opus", keys: ["Enter"] });
    expect(planSend("  /effort high ", { isAgent: true, kind: "codex" })).toEqual({ kind: "typed", text: "/effort high", keys: ["Enter"] });
    expect(planSend("fix the build", { isAgent: true, kind: "claude" })).toEqual({ kind: "prompt", text: "fix the build" });
    expect(planSend("/Users/dev/a.md read it", { isAgent: true, kind: "claude" })).toEqual({ kind: "prompt", text: "/Users/dev/a.md read it" });
    expect(planSend("/model opus", { isAgent: true, kind: "opencode" })).toEqual({ kind: "input", text: "\u001b[200~/model opus\u001b[201~", keys: ["Enter"] });
    expect(planSend("/bin/ls", { isAgent: false, kind: null })).toEqual({ kind: "input", text: "/bin/ls", keys: ["Enter"] });
  });
});

function pane(agent: string, status = "idle"): TopologyPaneInfo {
  return { paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agentStatus: status, revision: 1n as never, agent };
}

function info(agent: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return { paneID: "w1:p1", agent, terminalID: "t1", agentSession: { source: `herdr:${agent}`, agent, kind: "id", value: "s-1" }, ...extra };
}

function site(state: { pane: TopologyPaneInfo | null; agent: AgentInfo | null }, afterText: (() => void) | null = null) {
  const log: unknown[][] = [];
  const s: SendSite = {
    writer: {
      prompt: async (paneID, text) => void log.push(["prompt", paneID, text]),
      sendInput: async (paneID, text, keys) => void log.push(["input", paneID, text, keys]),
      sendText: async (paneID, text) => {
        log.push(["text", paneID, text]);
        afterText?.();
      },
      agentKeys: async (paneID, keys) => void log.push(["agentKeys", paneID, keys]),
    },
    fresh: async () => {
      log.push(["fresh"]);
      return true;
    },
    pane: () => state.pane,
    agent: () => state.agent,
    // A command line goes only for the run it was picked on.
    run: () => ({ connection: 1, arrival: 1 }),
  };
  return { site: s, log };
}

const bindClaude = { terminalID: "t1", isAgent: true, kind: "claude", session: "s-1", run: { connection: 1, arrival: 1 } };

describe("a bound command", () => {
  it("is typed without paste markers, checked again, then its Return pressed through agent.send_keys", async () => {
    const m = site({ pane: pane("claude"), agent: info("claude") });
    await sendBound(m.site, "w1:p1", "/model opus", bindClaude);
    expect(m.log).toEqual([["fresh"], ["text", "w1:p1", "/model opus"], ["fresh"], ["agentKeys", "w1:p1", ["Enter"]]]);
  });

  it("an ordinary message still goes as agent.prompt", async () => {
    const m = site({ pane: pane("claude"), agent: info("claude") });
    await sendBound(m.site, "w1:p1", "fix it", bindClaude);
    expect(m.log).toEqual([["fresh"], ["prompt", "w1:p1", "fix it"]]);
  });

  it("is refused while the agent shows a dialog: nothing is typed into it", async () => {
    for (const agent of [info("claude", { agentStatus: "blocked" }), info("claude", { inputPending: true })]) {
      const m = site({ pane: pane("claude"), agent });
      await expect(sendBound(m.site, "w1:p1", "/effort max", bindClaude)).rejects.toThrow(
        "Not sent: Herdr says the agent is waiting for an answer in its terminal. The text is kept.",
      );
      expect(m.log).toEqual([["fresh"]]);
    }
  });

  it("gets no Return when the pane changed after it was typed", async () => {
    const state = { pane: pane("claude") as TopologyPaneInfo | null, agent: info("claude") as AgentInfo | null };
    const m = site(state, () => {
      state.pane = null;
    });
    await expect(sendBound(m.site, "w1:p1", "/model opus", bindClaude)).rejects.toThrow(
      "Typed into claude, but the pane is gone, so no Return was pressed. Check the terminal before sending again.",
    );
    expect(m.log.filter((entry) => entry[0] === "agentKeys")).toEqual([]);
  });
});

// MARK: - the box

interface Pending {
  readonly text: string;
  resolve(): void;
  reject(error: Error): void;
}

let sends: Pending[] = [];

beforeEach(() => {
  sends = [];
  composerDrafts.clear();
  commandRows.clear();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: (_hostId: string, _paneId: string, text: string) => new Promise<void>((resolve, reject) => sends.push({ text, resolve, reject })),
      copyText: () => undefined,
    },
  });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function hostOf(agent: string): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent, agent_status: "working", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent, agent_status: "working", agent_session: { source: `herdr:${agent}`, agent, kind: "id", value: "s-1" } }],
  });
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology } as unknown as HostView;
}

const rowOf = (kind: string) => ({ paneID: "w1:p1", name: "Notes", workspaceLabel: "notes", kind, isAgent: true, status: "working" }) as unknown as SidebarRow;

function box(agent: string) {
  const ui = new HookHost(Composer as (props: object) => unknown, { host: hostOf(agent), row: rowOf(agent) });
  ui.render();
  const textarea = () => find(ui.tree, "textarea")!;
  return {
    type: (value: string) => (textarea().props["onChange"] as (e: unknown) => void)({ target: { value } }),
    enter: () =>
      (textarea().props["onKeyDown"] as (e: unknown) => void)({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => undefined }),
    value: () => textarea().props["value"],
    error: () => find(ui.tree, "span", "cmp-note-t")?.props["children"], // the note line under the box
  };
}

describe("a command from the Chat box", () => {
  it("shows as a small command row, never a Queued bubble of the user's, and leaves the box once sent", async () => {
    const b = box("claude");
    b.type("/model opus");
    b.enter();
    expect(sends.map((sent) => sent.text)).toEqual(["/model opus"]);
    expect(pendingMessages.forPane("mac-mini/w1:p1")).toEqual([]);
    expect(commandRows.forPane("mac-mini/w1:p1").map((row) => [row.text, row.state])).toEqual([["/model opus", "sending"]]);
    sends[0]!.resolve();
    await flush();
    expect(commandRows.forPane("mac-mini/w1:p1").map((row) => [row.text, row.state])).toEqual([["/model opus", "sent"]]);
    expect(b.value()).toBe("");
  });

  it("a refused command leaves no row; the box keeps it with the note", async () => {
    const b = box("codex");
    b.type("/model gpt-5.5");
    b.enter();
    sends[0]!.reject(new Error("Not sent: Herdr says the agent is waiting for an answer in its terminal. The text is kept."));
    await flush();
    expect(commandRows.forPane("mac-mini/w1:p1")).toEqual([]);
    expect(b.value()).toBe("/model gpt-5.5");
    expect(b.error()).toBe("Not sent: Herdr says the agent is waiting for an answer in its terminal. The text is kept.");
  });

  it("an ordinary message is the user's bubble as before; another agent's / line too", () => {
    const b = box("claude");
    b.type("fix the build");
    b.enter();
    expect(pendingMessages.forPane("mac-mini/w1:p1").map((message) => message.text)).toEqual(["fix the build"]);
    const other = box("opencode");
    other.type("/model x");
    other.enter();
    expect(commandRows.forPane("mac-mini/w1:p1")).toEqual([]);
  });

  it("keeps the newest three rows, each for ten minutes", () => {
    let now = 5_000_000;
    for (const text of ["/a", "/b", "/c", "/d"]) commandRows.add("k", text, now);
    expect(commandRows.forPane("k", now).map((row) => row.text)).toEqual(["/b", "/c", "/d"]);
    now += 10 * 60_000;
    expect(commandRows.forPane("k", now)).toEqual([]);
  });
});
