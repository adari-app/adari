// An agent CLI's update command and its Update (src/shared/
// agent-update.ts, main/herdr/agent-update.ts, the renderer's agent-update.tsx
// and Settings › Updates › Agent CLIs). The command is kept per machine in
// ~/.adari/agents.json as `<kind>.update` beside the start commands; Codex's
// own notice offers its command as a suggestion, never taken by itself; Claude
// Code has none. Update asks once, then one shell tab and one typed command
// with Return, exactly as written. Fakes only: no socket, no SSH.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

import { demoCodexUpdateScreen } from "../src/main/demo/demo-hosts";
import { MemoryStartCommandsFiles } from "../src/main/start-commands-memory";
import { saveStartCommand, StartCommandSaveError } from "../src/main/start-commands-write";
import { agentUpdateTexts, isAgentUpdateRequest, isUpdateCommandKind, updateCliName, updateKinds, updateTabLabel, updateWorkspace, type AgentUpdateStale } from "../src/shared/agent-update";
import { newAgentKinds } from "../src/shared/new-agent";
import type { HostView } from "../src/shared/ipc-contract";
import { APIError } from "../src/main/herdr/wire";
import { commandFor, parseStartCommands, typedStart, updateCommandFor, updateCommandSaveRefusal, type AgentStartCommands } from "../src/shared/start-commands";
import { UpdateWatch, readCodexUpdateCommand } from "../src/shared/update-mark";
import { HookHost, elements } from "./support/fake-hooks";
import { paneTopology } from "./support/pane-topology";
import { flush, loadSettings, mountSettings, settingsBridge, sshHost } from "./support/settings-page";

const { AgentUpdateButton } = await import("../src/renderer/components/agent-update");
const { escapeOwners, keyOwners } = await import("../src/renderer/components/escape-owners");
await loadSettings();

const home = "/Users/me";
const file = `${home}/.adari/agents.json`;

function machine(text: string | null): MemoryStartCommandsFiles {
  const files = new MemoryStartCommandsFiles(home);
  if (text !== null) {
    files.addFolder(`${home}/.adari`);
    files.addFile(file, text, 0o600);
  }
  return files;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("the update command: per machine, beside the start commands, in the same file", () => {
  it("is read from `<kind>.update`, apart from the start commands; an old file without one reads as none", () => {
    const read = parseStartCommands(bytes('{"claude": "cl", "codex": "codex", "codex.update": "codex-update"}'));
    expect(updateCommandFor(read, "codex")).toBe("codex-update");
    expect(read.commands).toEqual({ claude: "cl", codex: "codex" });
    expect(commandFor(read, "codex.update")).toBeNull();
    const old = parseStartCommands(bytes('{"claude": "cl"}'));
    expect(updateCommandFor(old, "codex")).toBeNull();
    expect(old).toEqual({ status: { type: "read" }, commands: { claude: "cl" }, refused: {} });
    expect(updateCommandFor(parseStartCommands(null), "codex")).toBeNull();
  });

  it("takes what a shell takes (quotes, spaces, a semicolon, an alias), on one line, up to 200 characters", () => {
    for (const command of ["codex-update", "npm install -g @openai/codex", `brew upgrade --cask codex; echo "done"`, "x".repeat(200)]) {
      expect(updateCommandSaveRefusal(command), command).toBeNull();
      expect(updateCommandFor(parseStartCommands(bytes(JSON.stringify({ "codex.update": command }))), "codex")).toBe(command);
    }
    expect(updateCommandSaveRefusal("x".repeat(201))).toBe("The command is longer than 200 characters.");
    expect(updateCommandSaveRefusal("npm i -g codex\nrm -rf x")).toBe("The command has a line break.");
    expect(updateCommandSaveRefusal("npm\u0007")).toBe("The command has a control character.");
    expect(updateCommandSaveRefusal("npm​ i")).toBe("The command has an invisible formatting character.");
    // A refused one is not used, and says why under its key.
    const refused = parseStartCommands(bytes(JSON.stringify({ "codex.update": "a\nb" })));
    expect(updateCommandFor(refused, "codex")).toBeNull();
    expect(refused.refused).toEqual({ "codex.update": "its command has a line break" });
  });

  it("is saved into that one key; every other key and value stays, in its place", async () => {
    const before = '{\n  "claude": "cl",\n  "opencode": "oc --fast",\n  "codex": "codex"\n}\n';
    const files = machine(before);
    const saved = await saveStartCommand(files, "codex.update", `npm i -g @openai/codex; echo "ok"`, { random: () => "0123456789abcdef" });
    const after = files.text(file)!;
    expect(after).toBe('{\n  "claude": "cl",\n  "opencode": "oc --fast",\n  "codex": "codex",\n  "codex.update": "npm i -g @openai/codex; echo \\"ok\\""\n}\n');
    expect(after.startsWith(before.slice(0, before.lastIndexOf("\n}")))).toBe(true);
    expect(updateCommandFor(saved, "codex")).toBe(`npm i -g @openai/codex; echo "ok"`);
    expect(saved.commands).toEqual({ claude: "cl", opencode: "oc --fast", codex: "codex" });
    // Cleared: only that key goes.
    await saveStartCommand(files, "codex.update", "", { random: () => "0123456789abcdef" });
    expect(files.text(file)).toBe(before);
    // Its own check, before anything is asked of the machine; a start command's check stays the stricter one.
    const quiet = machine(before);
    await expect(saveStartCommand(quiet, "codex.update", "a\nb")).rejects.toThrow(new StartCommandSaveError("The command has a line break."));
    await expect(saveStartCommand(quiet, "codex", "codex; x")).rejects.toThrow("not allowed in a plain command");
    expect(quiet.requests).toEqual([]);
  });

  it("Claude Code has no update command (it installs its own); Codex has one (so does every other started kind)", () => {
    expect(isUpdateCommandKind("codex")).toBe(true);
    expect(isUpdateCommandKind("claude")).toBe(false);
    expect(agentUpdateTexts.claude).toBe("Claude Code installs its own updates; it only needs the restart.");
  });
});

describe("Codex's printed command, offered as a suggestion only", () => {
  it("is read from its own notice (history cell, startup prompt); not from a reply, and not past the notice's rows", () => {
    expect(readCodexUpdateCommand(demoCodexUpdateScreen)).toBe("npm install -g @openai/codex");
    const prompt = ["  ✨ Update available! 0.167.0 -> 0.168.0", "", "  Release notes: https://github.com/openai/codex/releases/latest", "", "› 1. Update now (runs `brew upgrade --cask codex`)", "  2. Skip"].join("\n");
    expect(readCodexUpdateCommand(prompt)).toBe("brew upgrade --cask codex");
    expect(readCodexUpdateCommand("• Update available! 0.167.0 -> 0.168.0\n  Run npm i -g evil to update.")).toBeNull();
    expect(readCodexUpdateCommand("Run npm install -g @openai/codex to update.")).toBeNull();
    expect(readCodexUpdateCommand("✨ Update available! 0.167.0 -> 0.168.0\nSee https://github.com/openai/codex for installation options.")).toBeNull();
  });

  it("the watch keeps it with the marked pane's session and gives it per CLI; a new session drops it", () => {
    const watch = new UpdateWatch();
    const pane = { id: "w1:p1", kind: "codex", identity: "codex|t1|", settled: true, exited: false };
    watch.due([pane], 0, true);
    watch.observe("w1:p1", pane.identity, watch.token("w1:p1")!, demoCodexUpdateScreen, 1);
    expect(watch.suggestions()).toEqual({ codex: "npm install -g @openai/codex" });
    // The notice scrolled away: the mark and the suggestion stay for this session.
    watch.observe("w1:p1", pane.identity, watch.token("w1:p1")!, "› hi", 2);
    expect(watch.suggestions()).toEqual({ codex: "npm install -g @openai/codex" });
    watch.due([{ ...pane, identity: "codex|t2|" }], 400_000, true);
    expect(watch.suggestions()).toEqual({});
  });
});

// --- Update in the main process ---

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

/** registerIpc over one machine "Mac mini" (workspace w1) whose start-commands file is `files`. */
function main(files: MemoryStartCommandsFiles, options: { onRead?: () => void; create?: () => Promise<never> } = {}) {
  const calls: string[] = [];
  const link = { connection: 1 as number | null, epoch: 1, incarnation: 1 };
  const herdr = {
    agentList: async () => [],
    createTerminalTab: async (workspace: string, label: string | null, cwd: string | null) => {
      calls.push(`tab.create ${workspace} ${JSON.stringify(label)} ${JSON.stringify(cwd)}`);
      if (options.create !== undefined) return options.create();
      return { tab: { tabID: "w1:tU", workspaceID: workspace }, rootPane: { paneID: "w1:pU", workspaceID: workspace } };
    },
    startAgent: async () => {
      throw new Error("never");
    },
    closePane: async () => void calls.push("close"),
    sendInput: async (pane: string, text: string, keys: readonly string[]) => void calls.push(`send ${pane} ${JSON.stringify(text)} ${JSON.stringify(keys)}`),
  };
  const backend = {
    workspaceActions: () => herdr,
    readStartCommandsFile: async () => {
      calls.push("read agents.json");
      options.onRead?.();
      return files.nodes.has(file) ? files.read(file, 16_385) : null;
    },
    saveStartCommand: (kind: string, command: string) => saveStartCommand(files, kind, command),
  };
  const view = () => ({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null, state: "connected", error: null, fetchedAtMs: 0, topology: paneTopology([{ id: "w1:p1", agent: "codex" }]) });
  registered.handles.clear();
  registerIpc({
    hosts: {
      backend: (id: string) => (id === "mini" ? backend : null),
      list: () => [view()],
      refresh: async () => void calls.push("refresh"),
      connection: () => link.connection,
      connectionIdentity: () => ({ incarnation: link.incarnation, epoch: link.epoch }),
    },
  } as never);
  const invoke = (channel: string, ...args: unknown[]) => registered.handles.get(channel)!(event, ...args) as Promise<unknown>;
  return { calls, invoke, link, sent: () => calls.filter((line) => line.startsWith("tab.create") || line.startsWith("send")) };
}

/** The question's binding for the fixture machine (entry 1, connection 1, command connection 1). */
const bound = { incarnation: 1, connection: 1, epoch: 1 };

describe("Update: one shell tab and the command typed once, exactly as written", () => {
  const command = `brew upgrade --cask codex; echo "done  here"`;
  const saved = () => machine(`${JSON.stringify({ claude: "cl", "codex.update": command }, null, 2)}\n`);

  it("yes: one tab named Update Codex in the workspace, then the command and Return in one send", async () => {
    const m = main(saved());
    const made = await m.invoke(IPC.agentUpdateRun, "mini", { kind: "codex", command, workspaceId: "w1", binding: bound });
    expect(made).toEqual({ paneId: "w1:pU", tabId: "w1:tU" });
    expect(m.sent()).toEqual([`tab.create w1 "Update Codex" null`, `send w1:pU ${JSON.stringify(command)} ["Enter"]`]);
    expect(m.calls).not.toContain("close");
    expect(updateTabLabel("codex")).toBe("Update Codex");
  });

  it("the update command saved through its own door is the one Update types", async () => {
    const files = machine('{"claude": "cl"}\n');
    const m = main(files);
    const after = (await m.invoke(IPC.updateCommandSave, "mini", "codex", "codex-update")) as AgentStartCommands;
    expect(updateCommandFor(after, "codex")).toBe("codex-update");
    expect(files.text(file)).toBe('{\n  "claude": "cl",\n  "codex.update": "codex-update"\n}\n');
    await m.invoke(IPC.agentUpdateRun, "mini", { kind: "codex", command: "codex-update", workspaceId: "w1", binding: bound });
    expect(m.sent()).toEqual([`tab.create w1 "Update Codex" null`, `send w1:pU "codex-update" ["Enter"]`]);
    for (const args of [["mini", "claude", "x"], ["mini", "codex", 5], ["mini", "codex", "x".repeat(1_025)], ["mini", "codex", "x", "extra"]]) {
      await expect(m.invoke(IPC.updateCommandSave, ...args)).rejects.toThrow("bad request");
    }
  });

  it("a command other than the machine's saved one (changed since it showed), or none saved: nothing is sent", async () => {
    const m = main(saved());
    // Answered back with the command there now (the window asks again with it), or the plain words for none.
    const other = (await m.invoke(IPC.agentUpdateRun, "mini", { kind: "codex", command: "codex-update", workspaceId: "w1", binding: bound })) as AgentUpdateStale;
    expect(other.stale.command).toBe(command);
    expect(other.stale.note).toBeNull();
    const none = main(machine('{"claude": "cl"}'));
    const gone = (await none.invoke(IPC.agentUpdateRun, "mini", { kind: "codex", command: "codex-update", workspaceId: "w1", binding: bound })) as AgentUpdateStale;
    expect(gone.stale).toEqual({ command: null, note: agentUpdateTexts.gone("Codex", "Mac mini"), commands: expect.anything() });
    expect([...m.sent(), ...none.sent()]).toEqual([]);
  });

  it("a changed machine sends nothing (reconnected while the file was read)", async () => {
    let flip = (): void => undefined;
    const m = main(saved(), { onRead: () => flip() });
    flip = () => {
      m.link.connection = 2;
    };
    await expect(m.invoke(IPC.agentUpdateRun, "mini", { kind: "codex", command, workspaceId: "w1", binding: bound })).rejects.toThrow("Mac mini reconnected since Update was asked for. Nothing was sent.");
    expect(m.sent()).toEqual([]);
  });

  it("no workspace there: the shell path's own refusal, nothing sent; a request that is not one is refused", async () => {
    const m = main(saved());
    await expect(m.invoke(IPC.agentUpdateRun, "mini", { kind: "codex", command, workspaceId: "", binding: bound })).rejects.toThrow("That workspace is not on Mac mini now.");
    await expect(m.invoke(IPC.agentUpdateRun, "mini", { kind: "codex", command, workspaceId: "w9", binding: bound })).rejects.toThrow("That workspace is not on Mac mini now.");
    for (const request of [
      { kind: "claude", command: "x", workspaceId: "w1", binding: bound },
      { kind: "codex", command: "a\nb", workspaceId: "w1", binding: bound },
      { kind: "codex", command, workspaceId: "w1", binding: bound, extra: 1 },
      { kind: "codex", workspaceId: "w1", binding: bound },
      { kind: "codex", command, workspaceId: "w1" },
      { kind: "codex", command, workspaceId: "w1", binding: { incarnation: 1, connection: 1 } },
    ]) {
      expect(isAgentUpdateRequest(request)).toBe(false);
      await expect(m.invoke(IPC.agentUpdateRun, "mini", request)).rejects.toThrow("bad request");
    }
    await expect(m.invoke(IPC.agentUpdateRun, "mini", { kind: "codex", command, workspaceId: "w1", binding: bound }, "extra")).rejects.toThrow("bad request");
    expect(m.sent()).toEqual([]);
  });

  it("the tab goes in the first marked agent's workspace, else the one in view", () => {
    expect(updateWorkspace([{ workspaceId: "w2" }, { workspaceId: "w3" }], "w1")).toBe("w2");
    expect(updateWorkspace([], "w1")).toBe("w1");
    expect(updateWorkspace([], null)).toBeNull();
  });
});

// --- The window ---

describe("the Update button and its one confirmation", () => {
  beforeEach(() => {
    escapeOwners.reset();
    keyOwners.reset();
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
  });
  afterEach(() => vi.unstubAllGlobals());

  const command = `npm i -g @openai/codex; echo "ok"`;
  function button(bridge: Record<string, unknown>, opened: unknown[][] = []) {
    const view = new HookHost(AgentUpdateButton as (props: object) => unknown, {
      bridge,
      host: { id: "mini", name: "Mac mini" },
      kind: "codex",
      command,
      workspaceId: "w1",
      onOpened: (...args: unknown[]) => opened.push(args),
    });
    view.render();
    const find = (data: string) => elements(view.tree).find((element) => element.props[data] !== undefined);
    return { view, find };
  }

  it("a click asks with the exact command and the machine's name; Run sends one request and opens the tab", async () => {
    const calls: unknown[][] = [];
    const opened: unknown[][] = [];
    const b = button({ runAgentUpdate: (...args: unknown[]) => (calls.push(args), Promise.resolve({ paneId: "w1:pU", tabId: "w1:tU" })) }, opened);
    expect(b.find("data-agent-update-confirm")).toBeUndefined();
    (b.find("data-agent-update-button")!.props["onClick"] as (event: unknown) => void)({ stopPropagation: () => undefined });
    b.view.render();
    const dialog = b.find("data-agent-update-confirm")!;
    expect(dialog.props["aria-label"]).toBe(`Run \`${command}\` on Mac mini?`);
    expect(b.find("data-agent-update-command")!.props["children"]).toBe(command);
    expect(calls).toEqual([]);
    (b.find("data-agent-update-run")!.props["onClick"] as () => void)();
    await flush();
    expect(calls).toEqual([["mini", { kind: "codex", command, workspaceId: "w1", binding: { incarnation: 0, connection: 0, epoch: null } }]]);
    expect(opened).toEqual([["mini", "w1:pU"]]);
  });

  it("Cancel (or the scrim) sends nothing", async () => {
    const calls: unknown[][] = [];
    const b = button({ runAgentUpdate: (...args: unknown[]) => (calls.push(args), Promise.resolve({ paneId: "p", tabId: "t" })) });
    (b.find("data-agent-update-button")!.props["onClick"] as (event: unknown) => void)({ stopPropagation: () => undefined });
    b.view.render();
    (b.find("data-agent-update-cancel")!.props["onClick"] as () => void)();
    b.view.render();
    await flush();
    expect(b.find("data-agent-update-confirm")).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("a refusal is one line under the button", async () => {
    const b = button({ runAgentUpdate: () => Promise.reject(new Error("Error invoking remote method 'herdr:agent-update-run': Error: That workspace is not on Mac mini now.")) });
    (b.find("data-agent-update-button")!.props["onClick"] as (event: unknown) => void)({ stopPropagation: () => undefined });
    b.view.render();
    (b.find("data-agent-update-run")!.props["onClick"] as () => void)();
    await flush();
    b.view.render();
    expect(b.find("data-agent-update-note")!.props["children"]).toBe("That workspace is not on Mac mini now.");
  });
});

describe("Settings › Updates › Agent CLIs: the update command per machine", () => {
  beforeEach(() => {
    escapeOwners.reset();
    keyOwners.reset();
  });

  const box = (extra: Partial<HostView> = {}) => sshHost("box", "build-box", { topology: paneTopology([{ id: "w1:p1", agent: "codex" }]), ...extra });

  async function open(fileText: string | null, host: HostView, extraBridge: Record<string, unknown> = {}) {
    const { bridge } = settingsBridge();
    const all = { ...bridge, startCommands: () => Promise.resolve(parseStartCommands(fileText === null ? null : bytes(fileText))), ...extraBridge };
    const run = mountSettings("updates", { bridge: all, hosts: [host], extra: { updateReady: [{ hostId: "box", paneId: "w1:p1", name: "trendline", place: "app · build-box", kind: "codex", workspaceId: "w1" }] } });
    await flush();
    run.rerender({});
    return run;
  }

  it("Claude Code's group says it updates itself and has no field; Codex's has one per machine", async () => {
    const run = await open('{"claude": "cl"}', box());
    const claude = run.find((element) => element.props["data-update-kind"] === "claude")!;
    expect(elements(claude).some((element) => element.props["data-update-self"] === "claude")).toBe(true);
    expect(elements(claude).some((element) => element.props["data-update-command-input"] !== undefined)).toBe(false);
    expect(run.find((element) => element.props["data-update-command-input"] === "box/codex")).toBeDefined();
    run.view.unmount();
  });

  it("no command set: no Update button; set: Update with that exact command and the marked agent's workspace", async () => {
    const none = await open('{"claude": "cl"}', box());
    expect(none.part("AgentUpdateButton")).toBeUndefined();
    none.view.unmount();
    const set = await open('{"claude": "cl", "codex.update": "codex-update"}', box());
    const updateButton = set.part("AgentUpdateButton")!;
    expect(updateButton.props["command"]).toBe("codex-update");
    expect(updateButton.props["workspaceId"]).toBe("w1");
    expect(updateButton.props["kind"]).toBe("codex");
    set.view.unmount();
  });

  it("Codex's printed command is offered with Use this; nothing is saved until that click", async () => {
    const saves: unknown[][] = [];
    const saveUpdateCommand = (...args: unknown[]) => (saves.push(args), Promise.resolve(parseStartCommands(bytes('{"codex.update": "npm install -g @openai/codex"}'))));
    const run = await open('{"claude": "cl"}', box({ updateSuggestions: { codex: "npm install -g @openai/codex" } }), { saveUpdateCommand });
    const offer = run.find((element) => element.props["data-update-suggestion"] === "codex")!;
    expect(elements(offer).some((element) => element.props["children"] === "npm install -g @openai/codex")).toBe(true);
    // Shown, not filled in: the field is empty and nothing was asked.
    expect(run.find((element) => element.props["data-update-command-input"] === "box/codex")!.props["value"]).toBe("");
    for (let i = 0; i < 3; i += 1) await flush();
    expect(saves).toEqual([]);
    (elements(offer).find((element) => element.props["data-update-suggestion-take"] !== undefined)!.props["onClick"] as () => void)();
    await flush();
    expect(saves).toEqual([["box", "codex", "npm install -g @openai/codex"]]);
    run.view.unmount();
  });
});

// --- An update command for every kind the machine starts, not only Codex ---

describe("every kind New agent offers has the update command (never Shell, never Claude Code)", () => {
  beforeEach(() => {
    escapeOwners.reset();
    keyOwners.reset();
  });

  /** A machine with Codex marked on w1 and an unmarked Grok Build agent on w2. */
  function mixed(): HostView {
    const topology = paneTopology([
      { id: "w1:p1", agent: "codex" },
      { id: "w1:p2", agent: "grok" },
    ]);
    return sshHost("box", "build-box", {
      topology: { ...topology, agents: topology.agents.map((agent) => (agent.paneID === "w1:p2" ? { ...agent, workspaceID: "w2" } : agent)) },
    });
  }

  async function open(fileText: string, host: HostView) {
    const { bridge } = settingsBridge();
    const all = { ...bridge, startCommands: () => Promise.resolve(parseStartCommands(bytes(fileText))) };
    const run = mountSettings("updates", {
      bridge: all,
      hosts: [host],
      extra: { updateReady: [{ hostId: "box", paneId: "w1:p1", name: "trendline", place: "app · build-box", kind: "codex", workspaceId: "w1" }] },
    });
    await flush();
    run.rerender({});
    return run;
  }
  type Run = Awaited<ReturnType<typeof open>>;
  const others = (run: Run) => run.find((element) => element.props["data-update-others"] !== undefined)!;
  const otherRow = (run: Run, kind: string) => elements(others(run)).filter((element) => element.props["data-update-other"] === kind);
  const input = (run: Run, kind: string) => run.find((element) => element.props["data-update-command-input"] === `box/${kind}`);
  const text = (node: unknown): string => elements(node).map((element) => (typeof element.props["children"] === "string" ? element.props["children"] : "")).join(" ");
  const add = (run: Run, kind: string) => {
    (elements(otherRow(run, kind)[0]).find((element) => element.props["data-update-add"] === kind)!.props["onClick"] as () => void)();
    run.rerender({});
  };

  it("the door's kind-name check: New agent's kind word, not Shell, not Claude Code", () => {
    for (const kind of ["codex", "grok", "pi", "opencode", "aider", "my-agent_2", "x".repeat(32)]) expect(isUpdateCommandKind(kind)).toBe(true);
    for (const kind of ["shell", "claude", "Grok", "a.b", "grok.update", "", "1x", "-x", "x".repeat(33), "grok ", 5, null, undefined]) expect(isUpdateCommandKind(kind)).toBe(false);
  });

  it("the kinds listed: New agent's (extras from agents.json included), any kind with one saved, never Shell or Claude Code", () => {
    const commands = parseStartCommands(bytes('{"claude": "cl", "aider": "aider --x", "Bad Kind": "x", "zed.update": "zed-up", "claude.update": "no"}'));
    const kinds = updateKinds(commands);
    expect(kinds).toEqual([...newAgentKinds(commands).map((choice) => choice.kind).filter((kind) => kind !== "shell" && kind !== "claude"), "zed"]);
    for (const kind of ["codex", "grok", "pi", "aider", "zed"]) expect(kinds).toContain(kind);
    for (const kind of ["shell", "claude", "Bad Kind"]) expect(kinds).not.toContain(kind);
    expect(updateCliName("grok")).toBe("Grok Build");
    expect(updateCliName("pi")).toBe("Pi");
    expect(updateCliName("aider")).toBe("Aider");
    expect(updateTabLabel("grok")).toBe("Update Grok Build");
  });

  it("Grok Build's and Pi's rows with no mark: one line with Add update command under Other agents, no field, nothing about an update", async () => {
    const run = await open('{"claude": "cl"}', mixed());
    expect(run.all((element) => element.props["data-update-kind"] !== undefined).map((element) => element.props["data-update-kind"])).toEqual(["claude", "codex"]);
    expect(text(others(run))).toContain("Other agents");
    for (const [kind, name] of [["grok", "Grok Build"], ["pi", "Pi"]] as const) {
      const rows = otherRow(run, kind);
      expect(rows).toHaveLength(1);
      expect(text(rows[0])).toContain(name);
      expect(elements(rows[0]).find((element) => element.props["data-update-add"] === kind)!.props["children"]).toBe("Add update command");
      expect(input(run, kind)).toBeUndefined();
      expect(text(rows[0])).not.toMatch(/newer|available|ready|outdated/i);
    }
    expect(run.all((element) => element.props["data-update-other"] === "shell" || element.props["data-update-other"] === "claude")).toEqual([]);
    expect(input(run, "claude")).toBeUndefined();
    expect(run.part("AgentUpdateButton")).toBeUndefined();
    // Add update command opens the field (empty, nothing saved by the click).
    add(run, "grok");
    expect(input(run, "grok")!.props["value"]).toBe("");
    expect(input(run, "pi")).toBeUndefined();
    run.view.unmount();
  });

  it("a command saved for Grok Build and Pi shows in their fields with Update; Grok Build's tab goes to its unmarked agent's workspace", async () => {
    const run = await open('{"claude": "cl", "codex.update": "codex-update", "grok.update": "grok-update", "pi.update": "pi update --all"}', mixed());
    expect(input(run, "codex")!.props["value"]).toBe("codex-update");
    expect(input(run, "grok")!.props["value"]).toBe("grok-update");
    expect(input(run, "pi")!.props["value"]).toBe("pi update --all");
    const byKind = new Map(run.all((element) => element.type === AgentUpdateButton).map((button) => [button.props["kind"], button.props]));
    expect([...byKind.keys()].sort()).toEqual(["codex", "grok", "pi"]);
    expect(byKind.get("grok")!["command"]).toBe("grok-update");
    expect(byKind.get("grok")!["workspaceId"]).toBe("w2"); // its first agent on the machine, unmarked
    expect(byKind.get("codex")!["workspaceId"]).toBe("w1"); // the marked agent's
    expect(byKind.get("pi")!["workspaceId"]).toBeNull(); // no Pi agent and none in view
    expect(text(otherRow(run, "grok")[0])).not.toMatch(/newer|available|outdated/i);
    run.view.unmount();
  });

  it("an extra kind from agents.json gets the field", async () => {
    const run = await open('{"claude": "cl", "aider": "aider --model x"}', mixed());
    expect(text(otherRow(run, "aider")[0])).toContain("Aider");
    add(run, "aider");
    expect(input(run, "aider")).toBeDefined();
    run.view.unmount();
  });

  it("saved through the door for Grok Build and Pi, read back beside Codex's, every other key and value kept; an old reader ignores them", async () => {
    const seed = '{\n  "claude": "cl",\n  "opencode": "oc --fast",\n  "n": 1,\n  "codex.update": "codex-update"\n}\n';
    const files = machine(seed);
    const m = main(files);
    await m.invoke(IPC.updateCommandSave, "mini", "grok", `grok-update; echo "ok"`);
    const after = (await m.invoke(IPC.updateCommandSave, "mini", "pi", "pi update --all")) as AgentStartCommands;
    expect(files.text(file)).toBe('{\n  "claude": "cl",\n  "opencode": "oc --fast",\n  "n": 1,\n  "codex.update": "codex-update",\n  "grok.update": "grok-update; echo \\"ok\\"",\n  "pi.update": "pi update --all"\n}\n');
    expect(after.updates).toEqual({ codex: "codex-update", grok: `grok-update; echo "ok"`, pi: "pi update --all" });
    expect(parseStartCommands(bytes(files.text(file)!)).updates).toEqual(after.updates);
    // Empty takes Grok Build's away; the rest stays as it was.
    await m.invoke(IPC.updateCommandSave, "mini", "grok", "");
    expect(files.text(file)).toBe('{\n  "claude": "cl",\n  "opencode": "oc --fast",\n  "n": 1,\n  "codex.update": "codex-update",\n  "pi.update": "pi update --all"\n}\n');
    // An extra kind passes the same door.
    await m.invoke(IPC.updateCommandSave, "mini", "aider", "aider-up");
    expect(updateCommandFor(parseStartCommands(bytes(files.text(file)!)), "aider")).toBe("aider-up");
    // An old reader ignores the new keys: no start types them and New agent lists no kind for them.
    const commands = parseStartCommands(bytes('{"grok": "grok --fast", "grok.update": "grok-update", "pi.update": "pi-up", "aider.update": "a-up"}'));
    expect(commandFor(commands, "grok")).toBe("grok --fast");
    expect(commandFor(commands, "grok.update")).toBeNull();
    expect(typedStart(commands, "grok")).toEqual({ type: "typed", command: "grok --fast" });
    expect(typedStart(commands, "pi")).not.toEqual(expect.objectContaining({ command: "pi-up" }));
    expect(newAgentKinds(commands).map((choice) => choice.kind).filter((kind) => kind.includes("."))).toEqual([]);
    expect(newAgentKinds(commands).map((choice) => choice.kind)).not.toContain("aider");
  });

  it("Shell, Claude Code and an unknown or malformed kind are refused at the door, nothing written or sent; Grok Build passes it", async () => {
    const seed = '{"claude": "cl"}\n';
    const files = machine(seed);
    const m = main(files);
    for (const kind of ["shell", "claude", "Grok", "grok.update", "a.b", "", "x".repeat(33), "../x", 5, null]) {
      await expect(m.invoke(IPC.updateCommandSave, "mini", kind, "x")).rejects.toThrow("bad request");
      await expect(m.invoke(IPC.agentUpdateRun, "mini", { kind, command: "x", workspaceId: "w1", binding: bound })).rejects.toThrow("bad request");
    }
    expect(files.text(file)).toBe(seed);
    expect(m.sent()).toEqual([]);
    // The same door takes any other kind New agent offers.
    await m.invoke(IPC.updateCommandSave, "mini", "grok", "grok-update");
    expect(files.text(file)).toBe('{\n  "claude": "cl",\n  "grok.update": "grok-update"\n}\n');
  });

  it("Update for Grok Build: its button asks once; one tab named Update Grok Build and its command typed once, exactly", async () => {
    const command = `grok-update --yes "now" 'x'; echo done`;
    const m = main(machine(`${JSON.stringify({ claude: "cl", "codex.update": "codex-update", "grok.update": command }, null, 2)}\n`));
    const made = await m.invoke(IPC.agentUpdateRun, "mini", { kind: "grok", command, workspaceId: "w1", binding: bound });
    expect(made).toEqual({ paneId: "w1:pU", tabId: "w1:tU" });
    expect(m.sent()).toEqual([`tab.create w1 "Update Grok Build" null`, `send w1:pU ${JSON.stringify(command)} ["Enter"]`]);
    // Pi has none saved there: nothing is sent.
    expect(((await m.invoke(IPC.agentUpdateRun, "mini", { kind: "pi", command: "pi-up", workspaceId: "w1", binding: bound })) as AgentUpdateStale).stale.note).toBe(agentUpdateTexts.gone("Pi", "Mac mini"));
    expect(m.sent()).toHaveLength(2);
    // Its button asks once with the exact command and the machine's name, then sends one request.
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    try {
      const calls: unknown[][] = [];
      const view = new HookHost(AgentUpdateButton as (props: object) => unknown, {
        bridge: { runAgentUpdate: (...args: unknown[]) => (calls.push(args), Promise.resolve({ paneId: "w2:pU", tabId: "w2:tU" })) },
        host: { id: "mini", name: "Mac mini" },
        kind: "grok",
        command: "grok-update",
        workspaceId: "w2",
        onOpened: () => undefined,
      });
      view.render();
      const find = (data: string) => elements(view.tree).find((element) => element.props[data] !== undefined);
      (find("data-agent-update-button")!.props["onClick"] as (event: unknown) => void)({ stopPropagation: () => undefined });
      view.render();
      expect(find("data-agent-update-confirm")!.props["aria-label"]).toBe("Run `grok-update` on Mac mini?");
      (find("data-agent-update-run")!.props["onClick"] as () => void)();
      await flush();
      expect(calls).toEqual([["mini", { kind: "grok", command: "grok-update", workspaceId: "w2", binding: { incarnation: 0, connection: 0, epoch: null } }]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// --- The yes runs only what the question showed, on the machine it showed ---

describe("Run carries the question; the file is read afresh; nothing else is sent", () => {
  const command = `codex-update --yes "now"; echo done`;
  const file1 = () => machine(`${JSON.stringify({ claude: "cl", "codex.update": command }, null, 2)}\n`);
  const question = (extra: Partial<{ command: string; binding: typeof bound }> = {}) => ({ kind: "codex", command, workspaceId: "w1", binding: bound, ...extra });

  it("an unchanged question: one fresh read, then one tab creation, then the command and Return once, in that order", async () => {
    const m = main(file1());
    await m.invoke(IPC.startCommands, "mini"); // the connection's cached read, before the question
    const before = m.calls.length;
    const made = await m.invoke(IPC.agentUpdateRun, "mini", question());
    expect(made).toEqual({ paneId: "w1:pU", tabId: "w1:tU" });
    expect(m.calls.slice(before)).toEqual(["read agents.json", `tab.create w1 "Update Codex" null`, `send w1:pU ${JSON.stringify(command)} ["Enter"]`, "refresh"]);
  });

  for (const [name, change, words] of [
    ["a reconnect", (link: { connection: number | null }) => void (link.connection = 2), "Mac mini changed since this question showed"],
    ["an edited machine entry", (link: { incarnation: number }) => void (link.incarnation = 2), "Mac mini changed since this question showed"],
    ["a changed command connection", (link: { epoch: number }) => void (link.epoch = 2), "Mac mini changed since this question showed"],
  ] as const) {
    it(`${name} between the question and Run: nothing read, nothing sent, one line that the machine changed`, async () => {
      const m = main(file1());
      (change as (link: typeof m.link) => void)(m.link);
      await expect(m.invoke(IPC.agentUpdateRun, "mini", question())).rejects.toThrow(words);
      expect(m.calls).toEqual([]);
    });
  }

  it("the file's command changed after the question (the cached read still has the old one): nothing sent; asked again with the one there now", async () => {
    const files = file1();
    const m = main(files);
    await m.invoke(IPC.startCommands, "mini"); // cached: the old line
    files.addFile(file, `${JSON.stringify({ claude: "cl", "codex.update": "new-line" }, null, 2)}\n`, 0o600);
    const answer = (await m.invoke(IPC.agentUpdateRun, "mini", question())) as AgentUpdateStale;
    expect(answer.stale.command).toBe("new-line");
    expect(answer.stale.note).toBeNull();
    expect(updateCommandFor(answer.stale.commands!, "codex")).toBe("new-line");
    expect(m.sent()).toEqual([]);
    // The window keeps the read: the cache now says the new line too.
    expect(updateCommandFor((await m.invoke(IPC.startCommands, "mini")) as AgentStartCommands, "codex")).toBe("new-line");
    // The question again with the new line, then yes: that line, once.
    await m.invoke(IPC.agentUpdateRun, "mini", question({ command: "new-line" }));
    expect(m.sent()).toEqual([`tab.create w1 "Update Codex" null`, `send w1:pU "new-line" ["Enter"]`]);
  });

  it("removed, refused or unreadable after the question: nothing sent, the plain words", async () => {
    const gone = machine('{"claude": "cl"}\n');
    const m1 = main(gone);
    expect(((await m1.invoke(IPC.agentUpdateRun, "mini", question())) as AgentUpdateStale).stale.note).toBe(agentUpdateTexts.gone("Codex", "Mac mini"));
    const bad = machine('{"codex.update": "a\\nb"}\n');
    const m2 = main(bad);
    expect(((await m2.invoke(IPC.agentUpdateRun, "mini", question())) as AgentUpdateStale).stale).toEqual({
      command: null,
      note: agentUpdateTexts.refusedNow("Codex", "Mac mini", "its command has a line break"),
      commands: expect.anything(),
    });
    const m3 = main(file1(), {
      onRead: () => {
        throw new Error("the folder channel closed");
      },
    });
    expect(((await m3.invoke(IPC.agentUpdateRun, "mini", question())) as AgentUpdateStale).stale).toEqual({
      command: null,
      note: agentUpdateTexts.unreadable("Mac mini", "the folder channel closed"),
      commands: null,
    });
    expect([...m1.sent(), ...m2.sent(), ...m3.sent()]).toEqual([]);
  });

  it("a tab creation with no reply in time says a tab may have opened, refreshes once and never asks again; Herdr's refusal keeps its words", async () => {
    const late = main(file1(), { create: () => Promise.reject(new Error("Request timed out after 10 seconds")) });
    await expect(late.invoke(IPC.agentUpdateRun, "mini", question())).rejects.toThrow(
      agentUpdateTexts.mayHaveOpened("Codex", "Mac mini", "Request timed out after 10 seconds"),
    );
    expect(late.calls).toEqual(["read agents.json", `tab.create w1 "Update Codex" null`, "refresh"]);
    const refused = main(file1(), { create: () => Promise.reject(new APIError("workspace_not_found", "no such workspace")) });
    await expect(refused.invoke(IPC.agentUpdateRun, "mini", question())).rejects.toThrow("workspace_not_found: no such workspace");
    expect(refused.calls).toEqual(["read agents.json", `tab.create w1 "Update Codex" null`]);
  });
});

describe("the window's question is the one Run sends", () => {
  beforeEach(() => {
    escapeOwners.reset();
    keyOwners.reset();
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
  });
  afterEach(() => vi.unstubAllGlobals());

  function button(bridge: Record<string, unknown>, host: Record<string, unknown>, props: Record<string, unknown> = {}) {
    let now: object = { bridge, host, kind: "codex", command: "old-line", workspaceId: "w1", onOpened: () => undefined, ...props };
    const view = new HookHost(AgentUpdateButton as (props: object) => unknown, now);
    view.render();
    /** The row's props as they are by then (the rest kept). */
    const change = (extra: Record<string, unknown>) => {
      now = { ...now, ...extra };
      view.render(now);
      view.render();
    };
    const find = (data: string) => elements(view.tree).find((element) => element.props[data] !== undefined);
    const click = (data: string) => {
      (find(data)!.props["onClick"] as (event: unknown) => void)({ stopPropagation: () => undefined });
      view.render();
    };
    return { view, find, click, change };
  }
  const shown = { id: "mini", name: "Mac mini", incarnation: 3, connection: 4, epoch: 5 };

  it("the machine changes while the question is open: it closes with one line and nothing is asked of the main process", async () => {
    const calls: unknown[][] = [];
    const b = button({ runAgentUpdate: (...args: unknown[]) => (calls.push(args), Promise.resolve({ paneId: "p", tabId: "t" })) }, shown);
    b.click("data-agent-update-button");
    expect(b.find("data-agent-update-confirm")).toBeDefined();
    b.change({ host: { ...shown, connection: 6 } });
    expect(b.find("data-agent-update-confirm")).toBeUndefined();
    expect(b.find("data-agent-update-note")!.props["children"]).toBe(agentUpdateTexts.machineChanged("Mac mini"));
    await flush();
    expect(calls).toEqual([]);
  });

  it("Run sends what the question showed (command, workspace, binding), not what the row says by then", async () => {
    const calls: unknown[][] = [];
    const b = button({ runAgentUpdate: (...args: unknown[]) => (calls.push(args), Promise.resolve({ paneId: "p", tabId: "t" })) }, shown);
    b.click("data-agent-update-button");
    b.change({ command: "edited-line", workspaceId: "w2" });
    expect(b.find("data-agent-update-command")!.props["children"]).toBe("old-line");
    b.click("data-agent-update-run");
    await flush();
    expect(calls).toEqual([["mini", { kind: "codex", command: "old-line", workspaceId: "w1", binding: { incarnation: 3, connection: 4, epoch: 5 } }]]);
  });

  it("the file holds another command: the question opens again with it and says so; yes sends that one", async () => {
    const calls: unknown[][] = [];
    const kept: unknown[][] = [];
    const answers = [
      { stale: { command: "new-line", note: null, commands: parseStartCommands(bytes('{"codex.update": "new-line"}')) } },
      { paneId: "p", tabId: "t" },
    ];
    const b = button({ runAgentUpdate: (...args: unknown[]) => (calls.push(args), Promise.resolve(answers.shift())) }, shown, {
      onCommands: (...args: unknown[]) => kept.push(args),
    });
    b.click("data-agent-update-button");
    b.click("data-agent-update-run");
    await flush();
    b.view.render();
    expect(b.find("data-agent-update-command")!.props["children"]).toBe("new-line");
    expect(b.find("data-agent-update-again")!.props["children"]).toBe(agentUpdateTexts.askedAgain("Mac mini"));
    expect(b.find("data-agent-update-confirm")!.props["aria-label"]).toBe("Run `new-line` on Mac mini?");
    expect(kept.map((args) => args[0])).toEqual(["mini"]);
    b.click("data-agent-update-run");
    await flush();
    expect(calls.map((args) => (args[1] as { command: string }).command)).toEqual(["old-line", "new-line"]);
  });
});
