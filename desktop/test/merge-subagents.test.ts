// Chat's subagents where they meet the model chips and Send to…. A typed `/`
// command and a chip's hidden pick leave Claude Code's two command lines in
// the transcript: they never show as the user's bubbles, never count as
// agents, and the model chips still read what they set. The Chat view shows
// the chips' command row and the Working line's agent count
// together (the command row is no agent). A subagent's report opens Send to…
// with the report as a reply, and the pick still carries the run the picker
// showed.

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { AgentSettingsReader } from "../src/shared/agent-settings";
import { runningSubagents } from "../src/shared/chat/model";
import { HandoffRecents, handoffList, listRows } from "../src/shared/handoff";
import type { HostView } from "../src/shared/ipc-contract";
import type { SendBinding } from "../src/shared/send-binding";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { session, shown, stamp, timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";
import { paneTopology } from "./support/pane-topology";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView, Turn } = await import("../src/renderer/chat/ChatView");
const { commandRows } = await import("../src/renderer/chat/command-rows");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { ComposerDrafts } = await import("../src/renderer/components/composer-drafts");
const { handoffStore, deliverHandoff } = await import("../src/renderer/handoff/handoff-state");

const typedFields = { promptSource: "typed", turnOrigin: "human", origin: { kind: "human" } };

/** The two user lines a slash command leaves (agent-settings.test.ts's shape): its name and arguments, then what it printed. */
function command(name: string, args: string, stdout: string, second: number, extra: Record<string, unknown> = {}): string[] {
  return [
    JSON.stringify({
      isSidechain: false,
      message: { content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`, role: "user" },
      sessionId: session,
      timestamp: stamp(second),
      type: "user",
      uuid: `c-${second}`,
      ...extra,
    }),
    // Its output line carries no typed fields (Claude Code writes it; agent-settings never reads the user's typing as a result).
    JSON.stringify({
      isSidechain: false,
      message: { content: `<local-command-stdout>${stdout}</local-command-stdout>`, role: "user" },
      sessionId: session,
      timestamp: stamp(second),
      type: "user",
      uuid: `o-${second}`,
    }),
  ];
}

const agentLine = (id: string, description: string, second: number, background: boolean): string =>
  JSON.stringify({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "assistant",
    uuid: "a-" + id,
    message: {
      content: [{ id, input: { description, prompt: "p", subagent_type: "Explore", run_in_background: background }, name: "Agent", type: "tool_use" }],
      role: "assistant",
      // A model other than the one /model sets, so the chips' Opus 5.5 is the command's.
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "tool_use",
    },
  });
const resultLine = (id: string, text: string, second: number): string =>
  JSON.stringify({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "user",
    uuid: "r-" + id,
    message: { content: [{ content: text, is_error: false, tool_use_id: id, type: "tool_result" }], role: "user" },
  });

function settingsOf(lines: readonly string[]) {
  const reader = new AgentSettingsReader("claude");
  let offset = 0;
  for (const line of lines) {
    reader.line(line, offset);
    offset += line.length + 1;
  }
  return reader.settings;
}

describe("a typed / command and a chip's hidden pick in the transcript", () => {
  const lines = [
    user("Check the banner", "u1", 0, typedFields),
    agentLine("toolu_run", "Read the banner", 1, false),
    // The user typed `/model opus` (typed as characters, then Return) ...
    ...command("model", "opus", "Set model to \u001b[1mOpus 5.5\u001b[22m", 2, typedFields),
    // ... and the Effort chip sent `/effort high` hidden (no promptSource on its lines).
    ...command("effort", "high", "Set effort level to high (this session only)", 3),
  ];

  it("never shows as the user's bubbles or as agents", () => {
    const { timeline } = timelineOf(lines);
    const rows = shown(timeline);
    expect(rows.filter((text) => text.startsWith("user:"))).toEqual(["user:Check the banner"]);
    for (const text of rows) {
      expect(text).not.toMatch(/\/model|\/effort|Set model|Set effort|command-name|local-command/);
    }
    // The one running subagent is the Agent call; the commands add none.
    expect(rows.filter((text) => text.startsWith("agents:"))).toEqual(["agents:Read the banner"]);
    expect(runningSubagents(timeline)).toBe(1);
  });

  it("still sets what the model chips read", () => {
    expect(settingsOf(lines)).toMatchObject({ modelLabel: "Opus 5.5", effort: "high" });
  });
});

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;
const onChatUpdate = (listener: Listener) => {
  chatListener = listener;
  return () => undefined;
};

function browser(): void {
  vi.stubGlobal("window", {
    herdrDesktop: { onChatUpdate, openChat: () => undefined, closeChat: () => undefined, setChatFollowing: () => undefined, copyText: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection: () => null,
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  });
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
}

function chatHost(): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "working" }],
    panes: [{ pane_id: "w1:p1", terminal_id: "term", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "claude", agent_status: "working", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "working", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: session } }],
  });
  return { id: "host", name: "host", kind: "ssh", address: "fixture", platform: null, state: "connected", error: null, fetchedAtMs: 0, topology };
}

const row = { paneID: "w1:p1", status: "working", name: "fixture", workspaceLabel: "app", isAgent: true, kind: "claude" } as unknown as SidebarRow;
const key = "host/w1:p1";
const named = (tree: unknown, name: string) =>
  elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
const mount = (element: { type: unknown; props: object }) => {
  const made = new HookHost(element.type as (props: object) => unknown, element.props);
  made.render();
  return made;
};

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  pendingMessages.clear();
  commandRows.clear();
  handoffStore.closePicker();
  vi.unstubAllGlobals();
});

function chatWith(lines: readonly string[]) {
  browser();
  const view = new HookHost(ChatView as (props: object) => unknown, { host: chatHost(), row, onShowTerminal: () => undefined });
  unmount = () => view.unmount();
  view.render();
  chatListener!({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf(lines).timeline });
  view.render();
  return view;
}

describe("the Chat view with the model chips' command row and the subagents' Working line", () => {
  it("shows the command row and '· 1 agent' together; the command is no agent", () => {
    // The clock 2m 10s after the user's message (the turn's start).
    vi.useFakeTimers({ now: Date.parse(stamp(0)) + 130_000, toFake: ["Date"] });
    try {
      commandRows.add(key, "/model opus");
      const view = chatWith([user("Check the banner", "u1", 0, typedFields), agentLine("toolu_run", "Read the banner", 1, false)]);
      const commandRow = elements(view.tree).find((e) => e.props["className"] === "cmd-row");
      expect(elements(commandRow).find((e) => e.props["className"] === "cmd")?.props["children"]).toBe("/model opus");
      const working = elements(view.tree).find((e) => e.props["className"] === "working-t")?.props["children"];
      expect(working).toBe("Working for 2m 10s · 1 agent");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a subagent's report: Send to…", () => {
  it("opens the picker with the report as a reply from this pane, and the pick carries the run the picker showed", async () => {
    const view = chatWith([user("Check the banner", "u1", 0, typedFields), agentLine("toolu_fg", "Read the banner", 1, false), resultLine("toolu_fg", "Banner.swift sets no lineLimit.", 13)]);
    const turn = mount(named(view.tree, "Turn")[0]! as { type: unknown; props: object });
    expect(named(view.tree, "Turn")[0]!.type).toBe(Turn);
    const group = named(turn.tree, "ItemRow").map(mount).flatMap((item) => named(item.tree, "SubagentsRow")).map(mount)[0]!;
    const line = named(group.tree, "SubagentLine").map(mount)[0]!;
    (elements(line.tree).find((e) => e.type === "button")!.props["onClick"] as () => void)();
    line.render();
    const report = named(line.tree, "ReplyText").map(mount)[0]!;
    const event = { stopPropagation: () => undefined, preventDefault: () => undefined, clientX: 10, clientY: 20 };
    (elements(report.tree).find((e) => e.props["onContextMenu"] !== undefined)!.props["onContextMenu"] as (e: unknown) => void)(event);
    view.render();
    const menu = named(view.tree, "ContextMenu")[0]!;
    const items = menu.props["items"] as { label: string; onSelect(): void }[];
    expect(items.map((item) => item.label)).toEqual(["Copy", "Send to…"]);
    items.find((item) => item.label === "Send to…")!.onSelect();
    const picked = handoffStore.picker()!;
    expect(picked.payload).toMatchObject({ text: "Banner.swift sets no lineLimit.", kind: { type: "reply" }, source: { hostId: "host", paneId: "w1:p1" } });

    // The target the picker lists, on a machine whose connection and agent run the main process published.
    const target: HostView = {
      id: "mini",
      name: "Mac mini",
      kind: "ssh",
      address: "fixture",
      platform: null,
      state: "connected",
      error: null,
      fetchedAtMs: 0,
      topology: paneTopology([{ id: "p-target", agent: "codex", session: "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b", terminal: "t2" }]),
      run: { connection: 3, arrivals: { "p-target": 7 } },
    };
    handoffStore.setHosts([chatHost(), target]);
    const targetRow = listRows(handoffList(handoffStore.macs(), null, [], "")).find((candidate) => candidate.paneId === "p-target")!;
    const bindings: SendBinding[] = [];
    await deliverHandoff(
      {
        store: handoffStore,
        drafts: new ComposerDrafts(),
        recents: new HandoffRecents(null),
        copy: vi.fn(),
        open: vi.fn(),
        send: async (_hostId: string, _paneId: string, _text: string, binding: SendBinding) => void bindings.push(binding),
      },
      picked.payload,
      targetRow,
      "sendNow",
    );
    expect(bindings).toEqual([expect.objectContaining({ terminalID: "t2", isAgent: true, kind: "codex", run: { connection: 3, arrival: 7 } })]);
  });
});
