// Settings › Chat › Start commands saves one kind's command
// into the machine's ~/.adari/agents.json (src/main/start-commands-write.ts).
// The reader's own checks (64 characters, one line, a plain command), the keys
// it does not edit kept as they are, a temporary file beside the real one then
// one rename over it, the file's mode kept (0600 for a new file, ~/.adari
// 0700), refused with a plain reason when the machine is not connected or a
// step fails (nothing half written). From then on the main process's start
// commands are the saved file: New agent types it, the Resume chip and a
// restart resume with it. The demo machines start with `claude`.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, chmodSync, writeFileSync, lstatSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

import { DemoBackend, demoStartCommands } from "../src/main/demo/demo-backend";
import { LocalSftp } from "../src/main/herdr/local";
import { MemoryStartCommandsFiles } from "../src/main/start-commands-memory";
import { sftpStartCommandsFiles } from "../src/main/start-commands-sftp";
import { inexactNumberIn, saveStartCommand, StartCommandSaveError, newStartCommandsMode } from "../src/main/start-commands-write";
import { saveStartCommandOf, startCommandsOf, cannotSaveText } from "../src/main/start-commands";
import { restartCommand } from "../src/shared/agent-restart";
import { resumeOffer, type PaneAgentMemory } from "../src/shared/pane-life";
import { commandFor, isEditableStartKind, parseStartCommands, startCommandSaveRefusal, typedStart, type AgentStartCommands } from "../src/shared/start-commands";
import { paneTopology } from "./support/pane-topology";
import { scratch } from "./support/this-mac-fake";

const home = "/Users/me";
const file = `${home}/.adari/agents.json`;
const fixed = () => "0123456789abcdef";
const temporary = `${home}/.adari/.agents.json.0123456789abcdef.adari-tmp`;

/** A machine with `~/.adari/agents.json` holding `text` (mode `mode`), or none. */
function machine(text: string | null = null, mode = 0o600, homePath = home): MemoryStartCommandsFiles {
  const files = new MemoryStartCommandsFiles(homePath);
  if (text !== null) {
    files.addFolder(`${homePath}/.adari`);
    files.addFile(`${homePath}/.adari/agents.json`, text, mode);
  }
  return files;
}

const writes = (files: MemoryStartCommandsFiles) => files.requests.filter((request) => /^(mkdir|writeNew|replace|remove) /.test(request));

describe("the command is checked as the reader checks it, before anything is asked of the machine", () => {
  it.each([
    ["x".repeat(65), "The command is longer than 64 characters."],
    ["claude\n--model opus", "The command has a line break."],
    ["claude x", "The command has a line break."],
    ["claude\u0007", "The command has a control character."],
    ["claude​", "The command has an invisible formatting character."],
    ["cl; rm x", "The command has “;”, not allowed in a plain command."],
    ["codex && echo hi", "The command has “&”, not allowed in a plain command."],
    ["claude $(id)", "The command has “$”, not allowed in a plain command."],
    ["claude  --model opus", "The command is not words separated by single spaces."],
    [" claude", "The command is not words separated by single spaces."],
    ["=claude", "The command has a word that starts with “=”."],
    ["   ", "The command is empty."],
  ])("%j is refused: %s", async (command, reason) => {
    expect(startCommandSaveRefusal(command)).toBe(reason);
    const files = machine('{"claude": "cl"}\n');
    await expect(saveStartCommand(files, "claude", command)).rejects.toThrow(new StartCommandSaveError(reason));
    expect(files.requests).toEqual([]);
    expect(files.text(file)).toBe('{"claude": "cl"}\n');
  });

  it("takes a plain command of up to 64 characters, ~/ paths and the characters the reader allows", () => {
    for (const command of ["claude", "cl", "claude --model opus", "~/bin/claude --dangerously-skip-permissions", "codex -c model=gpt-5.5", "a".repeat(64), "grok --profile=work,fast @team"]) {
      expect(startCommandSaveRefusal(command), command).toBeNull();
    }
    // Empty: the kind starts with its stock command again (its key is taken out).
    expect(startCommandSaveRefusal("")).toBeNull();
  });

  it("only the kinds Settings edits cross the main process's door", () => {
    expect(["claude", "codex", "grok", "cursor"].every(isEditableStartKind)).toBe(true);
    for (const kind of ["shell", "amp", "__proto__", "Claude", "", 3, null]) expect(isEditableStartKind(kind), String(kind)).toBe(false);
  });
});

describe("the write: other keys kept, a temporary file then one rename, the mode kept", () => {
  it("a new file: ~/.adari made 0700, the file 0600, written beside it then renamed over its name", async () => {
    const files = new MemoryStartCommandsFiles(home);
    const saved = await saveStartCommand(files, "claude", "claude --model opus", { random: fixed });
    expect(files.text(file)).toBe('{\n  "claude": "claude --model opus"\n}\n');
    expect(files.modeOf(file)).toBe(0o600);
    expect(newStartCommandsMode).toBe(0o600);
    expect(files.modeOf(`${home}/.adari`)).toBe(0o700);
    expect(files.requests).toEqual([
      "home .",
      `lstat ${file}`,
      `lstat ${home}/.herdr-companion/agents.json`,
      `lstat ${home}/.adari`,
      `mkdir ${home}/.adari`,
      `writeNew ${temporary}`,
      `replace ${temporary} -> ${file}`,
    ]);
    expect(files.nodes.has(temporary)).toBe(false);
    expect(commandFor(saved, "claude")).toBe("claude --model opus");
  });

  it("keeps every key it does not edit as it is, in its place, and replaces the kind's own", async () => {
    const before = '{"codex": "codex --full-auto", "note": {"by": "me", "list": [1, 2.5, null]}, "claude": "cl", "grok": 5, "cursor": "cursor-agent"}';
    const files = machine(before);
    const saved = await saveStartCommand(files, "claude", "claude", { random: fixed });
    const after = JSON.parse(files.text(file)!) as Record<string, unknown>;
    expect(Object.keys(after)).toEqual(["codex", "note", "claude", "grok", "cursor"]);
    expect(after).toEqual({ codex: "codex --full-auto", note: { by: "me", list: [1, 2.5, null] }, claude: "claude", grok: 5, cursor: "cursor-agent" });
    // As the reader reads it: the note and Grok's 5 are still refused (neither ever was a command), the commands read.
    expect(saved.commands).toEqual({ codex: "codex --full-auto", claude: "claude", cursor: "cursor-agent" });
    expect(saved.refused).toEqual({ note: "its command is not text", grok: "its command is not text" });
  });

  it("a kind not in the file is added after the others; a key named __proto__ stays a key", async () => {
    const files = machine('{"__proto__": {"x": 1}, "claude": "cl"}');
    await saveStartCommand(files, "codex", "codex resume", { random: fixed });
    const text = files.text(file)!;
    expect(text).toBe('{\n  "__proto__": {\n    "x": 1\n  },\n  "claude": "cl",\n  "codex": "codex resume"\n}\n');
  });

  it("empty takes the kind's key out (its stock command again), the rest kept", async () => {
    const files = machine('{"claude": "cl", "codex": "codex2"}');
    const saved = await saveStartCommand(files, "claude", "", { random: fixed });
    expect(files.text(file)).toBe('{\n  "codex": "codex2"\n}\n');
    expect(commandFor(saved, "claude")).toBeNull();
    expect(typedStart(saved, "claude")).toEqual({ type: "herdr", notTyped: null });
    const only = machine('{"claude": "cl"}');
    await saveStartCommand(only, "claude", "", { random: fixed });
    expect(only.text(file)).toBe("{}\n");
  });

  it("keeps the file's mode (0644 stays 0644, 0640 stays 0640); never makes ~/.adari again", async () => {
    for (const mode of [0o644, 0o640, 0o600]) {
      const files = machine('{"claude": "cl"}', mode);
      await saveStartCommand(files, "claude", "claude", { random: fixed });
      expect(files.modeOf(file), mode.toString(8)).toBe(mode);
      expect(files.requests.some((request) => request.startsWith("mkdir"))).toBe(false);
    }
  });

  it("a symlinked file (dotfiles): the file it names is replaced, beside itself; the link stays a link", async () => {
    const files = new MemoryStartCommandsFiles(home);
    files.addFolder(`${home}/.adari`);
    files.addFolder(`${home}/dotfiles`, 0o755);
    files.addFile(`${home}/dotfiles/agents.json`, '{"claude": "cl", "x": true}', 0o644);
    files.addSymlink(file, `${home}/dotfiles/agents.json`);
    await saveStartCommand(files, "claude", "claude --model opus", { random: fixed });
    expect(files.nodes.get(file)?.kind).toBe("symlink");
    expect(JSON.parse(files.text(`${home}/dotfiles/agents.json`)!)).toEqual({ claude: "claude --model opus", x: true });
    expect(files.modeOf(`${home}/dotfiles/agents.json`)).toBe(0o644);
    expect(writes(files)).toEqual([
      `writeNew ${home}/dotfiles/.agents.json.0123456789abcdef.adari-tmp`,
      `replace ${home}/dotfiles/.agents.json.0123456789abcdef.adari-tmp -> ${home}/dotfiles/agents.json`,
    ]);
  });

  it("while only the file from before the rename is there, its keys stay in effect in the new one (the old file untouched)", async () => {
    const files = new MemoryStartCommandsFiles(home);
    files.addFolder(`${home}/.herdr-companion`);
    files.addFile(`${home}/.herdr-companion/agents.json`, '{"claude": "cl", "codex": "codex2"}', 0o644);
    await saveStartCommand(files, "grok", "grok --fast", { random: fixed });
    expect(JSON.parse(files.text(file)!)).toEqual({ claude: "cl", codex: "codex2", grok: "grok --fast" });
    expect(files.modeOf(file)).toBe(0o600);
    expect(files.text(`${home}/.herdr-companion/agents.json`)).toBe('{"claude": "cl", "codex": "codex2"}');
  });

  it("the temporary file's name: hidden, beside the real one, random (16 hex digits), never the real name", async () => {
    const files = new MemoryStartCommandsFiles(home);
    await saveStartCommand(files, "claude", "claude");
    const made = files.requests.find((request) => request.startsWith("writeNew "))!.slice("writeNew ".length);
    expect(made).toMatch(/^\/Users\/me\/\.adari\/\.agents\.json\.[0-9a-f]{16}\.adari-tmp$/u);
  });
});

describe("refused with a plain reason, the file as it was", () => {
  it.each([
    ["[1, 2]", "is not a JSON object"],
    ["not json", "is not a JSON object"],
    ["null", "is not a JSON object"],
    ['"claude"', "is not a JSON object"],
  ])("a file that is %j: not rewritten (%s)", async (text, words) => {
    const files = machine(text);
    await expect(saveStartCommand(files, "claude", "claude")).rejects.toThrow(`~/.adari/agents.json ${words} such as {"claude": "cl"}, so Adari does not rewrite it. Fix it on the machine first.`);
    expect(writes(files)).toEqual([]);
    expect(files.text(file)).toBe(text);
  });

  it("a file that is not UTF-8, or larger than 16 KB: not rewritten", async () => {
    const bad = machine(null);
    bad.addFolder(`${home}/.adari`);
    bad.addFile(file, new Uint8Array([0x7b, 0xff, 0x7d]));
    await expect(saveStartCommand(bad, "claude", "claude")).rejects.toThrow("is not a JSON object");
    const big = machine(`{"note": "${"x".repeat(16 * 1_024)}"}`);
    await expect(saveStartCommand(big, "claude", "claude")).rejects.toThrow("~/.adari/agents.json is larger than 16 KB, so Adari does not rewrite it. Change it on the machine.");
    expect([...writes(bad), ...writes(big)]).toEqual([]);
  });

  it("a folder where the file is, or a file where ~/.adari is: refused", async () => {
    const folder = new MemoryStartCommandsFiles(home);
    folder.addFolder(`${home}/.adari`);
    folder.addFolder(file);
    await expect(saveStartCommand(folder, "claude", "claude")).rejects.toThrow("~/.adari/agents.json is not a file, so Adari does not replace it.");
    const blocked = new MemoryStartCommandsFiles(home);
    blocked.addFile(`${home}/.adari`, "x");
    await expect(saveStartCommand(blocked, "claude", "claude")).rejects.toThrow("~/.adari on the machine is not a folder, so the file is not saved.");
    expect([...writes(folder), ...writes(blocked)]).toEqual([]);
  });

  it("the new file not taken (a full disk): refused, the temporary file taken away, the old file as it was", async () => {
    const files = machine('{"claude": "cl"}', 0o644);
    files.fail("writeNew", new Error("Failure: no space left"));
    await expect(saveStartCommand(files, "claude", "claude", { random: fixed })).rejects.toThrow("The machine did not take the new file: Failure: no space left");
    expect(files.text(file)).toBe('{"claude": "cl"}');
    expect(files.nodes.has(temporary)).toBe(false);
    expect(writes(files)).toEqual([`writeNew ${temporary}`, `remove ${temporary}`]);
  });

  it("the rename refused: the temporary file taken away, the old file as it was", async () => {
    const files = machine('{"claude": "cl"}');
    files.fail("replace", new Error("Permission denied"));
    await expect(saveStartCommand(files, "claude", "claude", { random: fixed })).rejects.toThrow("The machine did not put the new file in place: Permission denied");
    expect(files.text(file)).toBe('{"claude": "cl"}');
    expect(files.nodes.has(temporary)).toBe(false);
    expect(writes(files)).toEqual([`writeNew ${temporary}`, `replace ${temporary} -> ${file}`, `remove ${temporary}`]);
  });

  it("the machine not answering the read: refused (the reason), nothing written", async () => {
    const files = machine('{"claude": "cl"}');
    files.fail("read", new Error("Connection lost"));
    await expect(saveStartCommand(files, "claude", "claude")).rejects.toThrow("Connection lost");
    expect(writes(files)).toEqual([]);
  });
});

describe("over This Mac's SFTP, real files (the same calls a machine's sftp-server answers)", () => {
  it("a new file is 0600 in a new 0700 ~/.adari, and no temporary file is left", async () => {
    const root = mkdtempSync(path.join(scratch, "start-write-"));
    const sftp = new LocalSftp(root);
    const saved = await saveStartCommand(sftpStartCommandsFiles(sftp as never), "claude", "claude --model opus");
    expect(readFileSync(path.join(root, ".adari/agents.json"), "utf8")).toBe('{\n  "claude": "claude --model opus"\n}\n');
    expect(statSync(path.join(root, ".adari/agents.json")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(root, ".adari")).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.join(root, ".adari"))).toEqual(["agents.json"]);
    expect(commandFor(saved, "claude")).toBe("claude --model opus");
  });

  it("an existing 0644 file keeps its mode and its other keys; it is a new file (renamed over), never written in place", async () => {
    const root = mkdtempSync(path.join(scratch, "start-write-"));
    mkdirSync(path.join(root, ".adari"), { mode: 0o755 });
    const real = path.join(root, ".adari/agents.json");
    writeFileSync(real, '{"codex": "codex --full-auto", "claude": "cl"}\n');
    chmodSync(real, 0o644);
    const before = statSync(real).ino;
    await saveStartCommand(sftpStartCommandsFiles(new LocalSftp(root) as never), "claude", "claude");
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ codex: "codex --full-auto", claude: "claude" });
    expect(statSync(real).mode & 0o777).toBe(0o644);
    expect(statSync(real).ino).not.toBe(before);
    expect(readdirSync(path.join(root, ".adari"))).toEqual(["agents.json"]);
  });

  it("a symlinked file: the target replaced, the link kept", async () => {
    const root = mkdtempSync(path.join(scratch, "start-write-"));
    mkdirSync(path.join(root, ".adari"));
    mkdirSync(path.join(root, "dotfiles"));
    writeFileSync(path.join(root, "dotfiles/agents.json"), '{"claude": "cl"}');
    symlinkSync(path.join(root, "dotfiles/agents.json"), path.join(root, ".adari/agents.json"));
    await saveStartCommand(sftpStartCommandsFiles(new LocalSftp(root) as never), "codex", "codex2");
    expect(lstatSync(path.join(root, ".adari/agents.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, "dotfiles/agents.json"), "utf8"))).toEqual({ claude: "cl", codex: "codex2" });
    expect(readdirSync(path.join(root, "dotfiles"))).toEqual(["agents.json"]);
  });

  it("a folder it may not write in: refused, the old file as it was, nothing left beside it", async () => {
    const root = mkdtempSync(path.join(scratch, "start-write-"));
    mkdirSync(path.join(root, ".adari"));
    writeFileSync(path.join(root, ".adari/agents.json"), '{"claude": "cl"}');
    chmodSync(path.join(root, ".adari"), 0o500);
    try {
      await expect(saveStartCommand(sftpStartCommandsFiles(new LocalSftp(root) as never), "claude", "claude")).rejects.toThrow(/^The machine did not take the new file: /u);
      expect(readFileSync(path.join(root, ".adari/agents.json"), "utf8")).toBe('{"claude": "cl"}');
      expect(readdirSync(path.join(root, ".adari"))).toEqual(["agents.json"]);
    } finally {
      chmodSync(path.join(root, ".adari"), 0o700);
    }
  });
});

describe("the demo machines", () => {
  const demo = () => new DemoBackend({ descriptor: { id: "d", name: "d", kind: "demo", address: "demo", platform: null }, snapshot: {}, transcripts: [] }, { heavy: "", idle: "", bashDialog: "" } as never);

  it("start with claude (not cl), and Settings saves into their own file like a real machine's", async () => {
    expect(demoStartCommands).toBe('{\n  "claude": "claude"\n}\n');
    const backend = demo();
    expect((await startCommandsOf(backend)).commands).toEqual({ claude: "claude" });
    await saveStartCommandOf(backend, "codex", "codex --full-auto");
    expect(parseStartCommands(await backend.readStartCommandsFile()).commands).toEqual({ claude: "claude", codex: "codex --full-auto" });
    backend.close();
  });
});

// --- The main process's door and what uses the saved value ---

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

/** registerIpc over one machine whose start commands live in `files`; `state` as its view says. */
function main(files: MemoryStartCommandsFiles, state: { value: "connected" | "offline" } = { value: "connected" }) {
  const calls: string[] = [];
  let reads = 0;
  const herdr = {
    agentList: async () => (calls.push("agent.list"), [{ paneID: "w1:pn1", name: "claude-2", agent: "claude" }]),
    createTerminalTab: async (workspace: string) => {
      calls.push(`tab.create ${workspace}`);
      return { tab: { tabID: "w1:tn1", workspaceID: workspace }, rootPane: { paneID: "w1:pn1", workspaceID: workspace } };
    },
    startAgent: async (name: string, kind: string, pane: string) => (calls.push(`agent.start ${kind}`), { paneID: pane, name, agent: kind }),
    closePane: async () => undefined,
    sendInput: async (pane: string, text: string) => void calls.push(`send ${pane} ${JSON.stringify(text)}`),
  };
  const backend = {
    workspaceActions: () => herdr,
    readStartCommandsFile: async () => {
      reads += 1;
      return files.nodes.has(`${files.homePath}/.adari/agents.json`) ? files.read(`${files.homePath}/.adari/agents.json`, 16_385) : null;
    },
    saveStartCommand: (kind: string, command: string) => saveStartCommand(files, kind, command),
  };
  const view = () => ({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null, state: state.value, error: null, fetchedAtMs: 0, topology: paneTopology([{ id: "w1:p1" }]) });
  registered.handles.clear();
  registerIpc({
    hosts: {
      backend: (id: string) => (id === "mini" ? backend : null),
      list: () => [view()],
      refresh: async () => undefined,
      connection: () => (state.value === "connected" ? 1 : null),
      connectionIdentity: () => ({ incarnation: 1, epoch: 1 }),
    },
  } as never);
  const invoke = (channel: string, ...args: unknown[]) => registered.handles.get(channel)!(event, ...args) as Promise<unknown>;
  return { calls, reads: () => reads, invoke, backend };
}

const session = "0f2c9a6e-1d2b-4c3d-9e8f-aabbccddeeff";
const exited = (kind: string): PaneAgentMemory => ({ kind, title: kind, terminalID: "t1", session: { source: `herdr:${kind}`, agent: kind, kind: "id", value: session } }) as PaneAgentMemory;

describe("the save at the main process's door", () => {
  it("refused when the machine is not connected (nothing asked of it), or the request is not one", async () => {
    const files = machine('{"claude": "cl"}');
    const state = { value: "offline" as "connected" | "offline" };
    const m = main(files, state);
    await expect(m.invoke(IPC.startCommandSave, "mini", "claude", "claude")).rejects.toThrow("Mac mini is not connected.");
    expect(files.requests).toEqual([]);
    state.value = "connected";
    for (const args of [
      ["mini", "shell", "bash"],
      ["mini", "claude", 5],
      ["mini", "claude", "x".repeat(1_025)],
      ["mini", "claude", "claude", "extra"],
      ["", "claude", "claude"],
      [7, "claude", "claude"],
    ]) {
      await expect(m.invoke(IPC.startCommandSave, ...args), JSON.stringify(args).slice(0, 40)).rejects.toThrow("bad request");
    }
    await expect(m.invoke(IPC.startCommandSave, "gone", "claude", "claude")).rejects.toThrow("That machine is no longer listed.");
    expect(files.requests).toEqual([]);
  });

  it("refused with the write's reason when it fails; the start commands stay as they were read", async () => {
    const files = machine('{"claude": "cl"}');
    const m = main(files);
    expect(commandFor((await m.invoke(IPC.startCommands, "mini")) as AgentStartCommands, "claude")).toBe("cl");
    files.fail("replace", new Error("Permission denied"));
    await expect(m.invoke(IPC.startCommandSave, "mini", "claude", "claude --model opus")).rejects.toThrow("The machine did not put the new file in place: Permission denied");
    expect(commandFor((await m.invoke(IPC.startCommands, "mini")) as AgentStartCommands, "claude")).toBe("cl");
    await expect(m.invoke(IPC.startCommandSave, "mini", "claude", "cl; rm x")).rejects.toThrow("The command has “;”, not allowed in a plain command.");
  });

  it("a machine that cannot save says so", async () => {
    await expect(saveStartCommandOf({ readStartCommandsFile: async () => null }, "claude", "claude")).rejects.toThrow(cannotSaveText);
  });

  it("saved: the start commands are the new file from then on, without reading it again; New agent types it", async () => {
    const files = machine('{"claude": "cl"}');
    const m = main(files);
    expect(commandFor((await m.invoke(IPC.startCommands, "mini")) as AgentStartCommands, "claude")).toBe("cl");
    expect(m.reads()).toBe(1);
    const saved = (await m.invoke(IPC.startCommandSave, "mini", "claude", "claude --model opus")) as AgentStartCommands;
    expect(commandFor(saved, "claude")).toBe("claude --model opus");
    expect(commandFor((await m.invoke(IPC.startCommands, "mini")) as AgentStartCommands, "claude")).toBe("claude --model opus");
    expect(m.reads()).toBe(1);
    await m.invoke(IPC.newAgent, "mini", { workspaceId: "w1", folder: null, kind: "claude" });
    expect(m.calls.filter((line) => line.startsWith("send "))).toEqual(['send w1:pn1 "claude --model opus"']);
  });

  it("saved: the Resume chip and a restart resume with the new command (Claude, Codex, Grok, Cursor)", async () => {
    const files = machine('{"claude": "cl"}');
    const m = main(files);
    for (const [kind, command] of [
      ["claude", "claude --model opus"],
      ["codex", "codex -c model=gpt-5.5"],
      ["grok", "grok --fast"],
      ["cursor", "cursor-agent --model gpt-5"],
    ] as const) {
      await m.invoke(IPC.startCommandSave, "mini", kind, command);
    }
    const commands = (await m.invoke(IPC.startCommands, "mini")) as AgentStartCommands;
    expect(resumeOffer(exited("claude"), commands)?.command).toBe(`claude --model opus --resume ${session}`);
    expect(resumeOffer(exited("codex"), commands)?.command).toBe(`codex -c model=gpt-5.5 resume ${session} --no-daemon`);
    expect(resumeOffer(exited("grok"), commands)?.command).toBe(`grok --fast --resume ${session}`);
    expect(resumeOffer(exited("cursor"), commands)?.command).toBe(`cursor-agent --model gpt-5 --resume ${session}`);
    expect(restartCommand("claude", exited("claude").session, commands)).toBe(`claude --model opus --resume ${session}`);
    expect(restartCommand("codex", exited("codex").session, commands)).toBe(`codex -c model=gpt-5.5 resume ${session} --no-daemon`);
    // Cleared again: the stock command.
    await m.invoke(IPC.startCommandSave, "mini", "claude", "");
    const cleared = (await m.invoke(IPC.startCommands, "mini")) as AgentStartCommands;
    expect(resumeOffer(exited("claude"), cleared)?.command).toBe(`claude --resume ${session}`);
    expect(restartCommand("claude", exited("claude").session, cleared)).toBe(`claude --resume ${session}`);
  });

  it("two saves at once on one machine run one after the other, and both keys are kept", async () => {
    const files = machine("{}");
    const m = main(files);
    await Promise.all([m.invoke(IPC.startCommandSave, "mini", "claude", "cl"), m.invoke(IPC.startCommandSave, "mini", "codex", "codex2")]);
    expect(JSON.parse(files.text(file)!)).toEqual({ claude: "cl", codex: "codex2" });
    expect((await m.invoke(IPC.startCommands, "mini")) as AgentStartCommands).toMatchObject({ commands: { claude: "cl", codex: "codex2" } });
  });
});

describe("a save that waited behind another asks again, right before it writes", () => {
  /** The door with a machine that can be removed, put offline or edited while a save waits; Claude's save held. */
  function held() {
    const files = machine("{}");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = {
      saveStartCommand: async (kind: string, command: string) => {
        if (kind === "claude") await gate;
        return saveStartCommand(files, kind, command, { random: fixed });
      },
    };
    const machineNow = { listed: true, state: "connected", backend: backend as object };
    registered.handles.clear();
    registerIpc({
      hosts: {
        backend: (id: string) => (id === "mini" && machineNow.listed ? machineNow.backend : null),
        list: () => (machineNow.listed ? [{ id: "mini", name: "Mac mini", state: machineNow.state }] : []),
        refresh: async () => undefined,
      },
    } as never);
    const save = (kind: string, command: string) => registered.handles.get(IPC.startCommandSave)!(event, "mini", kind, command) as Promise<AgentStartCommands>;
    return { files, release, machineNow, save };
  }

  const settle = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };

  it.each([
    ["removed", (m: { listed: boolean }) => void (m.listed = false), "That machine is no longer listed."],
    ["put offline", (m: { state: string }) => void (m.state = "offline"), "Mac mini is not connected."],
    ["edited (a new backend in its place)", (m: { backend: object }) => void (m.backend = {}), "That machine was edited before the save started. Nothing was saved."],
  ] as const)("the machine %s while the save waits: refused, nothing of it written", async (_what, change, words) => {
    const h = held();
    const first = h.save("claude", "cl");
    const queued = h.save("codex", "cx").then(
      () => "saved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await settle();
    change(h.machineNow as never);
    h.release();
    await first;
    expect(await queued).toBe(words);
    expect(JSON.parse(h.files.text(file)!)).toEqual({ claude: "cl" });
  });

  it("still listed, the same machine and connected: the waiting save runs after the first, both kept", async () => {
    const h = held();
    const first = h.save("claude", "cl");
    const queued = h.save("codex", "cx");
    await settle();
    h.release();
    await first;
    await expect(queued).resolves.toMatchObject({ commands: { claude: "cl", codex: "cx" } });
  });
});

describe("the old file in use is never hidden behind an incomplete new one", () => {
  const legacy = `${home}/.herdr-companion/agents.json`;
  const original = '{"claude": "cl", "codex": "cx", "grok": "gg"}';
  function old(text: string | Uint8Array = original) {
    const files = new MemoryStartCommandsFiles(home);
    files.addFolder(`${home}/.herdr-companion`);
    files.addFile(legacy, text, 0o644);
    return files;
  }
  const refusal = (why: string) =>
    `~/.herdr-companion/agents.json, the old file in use while ~/.adari/agents.json is absent, ${why}, so a new file would drop its commands. Nothing was saved: fix the old file on the machine first.`;

  it.each(["lstat", "read"])("its %s failing (Permission denied): refused, both files as they were", async (step) => {
    const files = old();
    files.fail(`${step} ${legacy}`, new Error("Permission denied"));
    await expect(saveStartCommand(files, "claude", "claude", { random: fixed })).rejects.toThrow(refusal("could not be read (Permission denied)"));
    expect(writes(files)).toEqual([]);
    expect(files.text(file)).toBeNull();
    expect(files.text(legacy)).toBe(original);
  });

  it("a link to it that does not lead to a file it can read: refused", async () => {
    const files = new MemoryStartCommandsFiles(home);
    files.addFolder(`${home}/.herdr-companion`);
    files.addSymlink(legacy, `${home}/nowhere.json`);
    await expect(saveStartCommand(files, "claude", "claude", { random: fixed })).rejects.toThrow(/^~\/\.herdr-companion\/agents\.json, the old file in use while ~\/\.adari\/agents\.json is absent, could not be read \(/u);
    expect(writes(files)).toEqual([]);
  });

  it.each([
    ["not a JSON object", "[1, 2]", "is not a JSON object"],
    ["not UTF-8", new Uint8Array([0x7b, 0xff, 0x7d]), "is not a JSON object"],
    ["larger than 16 KB", `{"note": "${"x".repeat(16 * 1_024)}"}`, "is larger than 16 KB"],
    ["holding a number it cannot write back", '{"claude": "cl", "note": 9007199254740993}', "holds the number 9007199254740993, which Adari cannot write back exactly"],
  ] as const)("one that is %s: refused, both files as they were", async (_what, text, why) => {
    const files = old(text);
    await expect(saveStartCommand(files, "claude", "claude", { random: fixed })).rejects.toThrow(refusal(why));
    expect(writes(files)).toEqual([]);
    expect(files.text(file)).toBeNull();
  });

  it("a folder where it is: refused", async () => {
    const files = new MemoryStartCommandsFiles(home);
    files.addFolder(`${home}/.herdr-companion`);
    files.addFolder(legacy);
    await expect(saveStartCommand(files, "claude", "claude", { random: fixed })).rejects.toThrow(refusal("is not a file"));
    expect(writes(files)).toEqual([]);
  });

  it("none there (no such file): the new file is made with the edited kind only", async () => {
    const files = new MemoryStartCommandsFiles(home);
    await saveStartCommand(files, "claude", "claude", { random: fixed });
    expect(JSON.parse(files.text(file)!)).toEqual({ claude: "claude" });
  });
});

describe("a value it does not edit is never changed", () => {
  it.each(["9007199254740993", "1e400", "-1e400", "1e-400", "-0", "123456789012345678901234567890"])(
    "a file holding the number %s: refused before ~/.adari or a temporary file is made, the file as it was",
    async (number) => {
      const text = `{"note": ${number}, "claude": "old"}`;
      const files = machine(text, 0o640);
      await expect(saveStartCommand(files, "claude", "claude", { random: fixed })).rejects.toThrow(
        `~/.adari/agents.json holds the number ${number}, which Adari cannot write back exactly, so it does not rewrite the file. Change it on the machine.`,
      );
      expect(writes(files)).toEqual([]);
      expect(files.text(file)).toBe(text);
      // Nested, too.
      const nested = machine(`{"note": {"list": [1, ${number}]}}`);
      await expect(saveStartCommand(nested, "claude", "claude")).rejects.toThrow("cannot write back exactly");
      expect(writes(nested)).toEqual([]);
    },
  );

  it("numbers JSON gives back as the same value are kept, written as JSON writes them", async () => {
    for (const text of ['{"a": 1}', '{"a": 1.0}', '{"a": 1e2}', '{"a": 1E+2}', '{"a": 100e-2}', '{"a": 0.1}', '{"a": -1.5e-7}', '{"a": 0}', '{"a": 9007199254740991}', '{"a": 0.30000000000000004}', '{"a": [1, 2, 3.25]}']) {
      expect(inexactNumberIn(text), text).toBeNull();
    }
    // In a string, digits are text: never numbers.
    for (const text of ['{"a": "9007199254740993"}', '{"a": "\\"1e400"}', '{"a\\\\": "-0", "b": 1}']) expect(inexactNumberIn(text), text).toBeNull();
    const files = machine('{"note": 1.0, "big": 1e2, "claude": "old"}');
    await saveStartCommand(files, "claude", "claude", { random: fixed });
    expect(files.text(file)).toBe('{\n  "note": 1,\n  "big": 100,\n  "claude": "claude"\n}\n');
  });
});
