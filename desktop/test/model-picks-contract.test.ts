// The contracts of model picks, held commands, drafts and settings reads.
// All machines, Herdr input and SFTP are fake.

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentPicks, type PickContext, type PickRequest } from "../src/renderer/components/agent-picks";
import { sendBound, type SendSite } from "../src/main/herdr/send";
import type { SendBinding } from "../src/shared/send-binding";
import type { AgentInfo, TopologyPaneInfo } from "../src/main/herdr/wire";
import { mainPickBinding, namedPick, pickLine } from "./support/model-pick-line";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

afterEach(() => vi.unstubAllGlobals());

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

const binding: SendBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: "session-1", run: { connection: 2, arrival: 1 } };
const ctx = (status: PickContext["status"] = "idle", extra: Partial<PickContext> = {}): PickContext => ({
  hostId: "mac-a",
  paneId: "p1",
  agent: "claude",
  status,
  binding,
  ...extra,
});

/** A fake Herdr pane: its input buffer, the lines a Return submitted, the texts written. */
function site() {
  const state = {
    pane: { paneID: "p1", terminalID: "t1", agent: "claude", agentStatus: "idle" } as unknown as TopologyPaneInfo | null,
    agent: { paneID: "p1", agent: "claude", agentStatus: "idle", agentSession: { value: "session-1" } } as unknown as AgentInfo & { inputPending?: boolean },
    run: { connection: 2, arrival: 1 },
    buffer: "",
    submitted: [] as string[],
    writes: [] as string[],
  };
  const writer = {
    prompt: async () => undefined,
    sendInput: async () => undefined,
    sendText: async (_pane: string, text: string) => {
      state.writes.push(text);
      state.buffer += text;
    },
    agentKeys: async () => {
      state.submitted.push(state.buffer);
      state.buffer = "";
    },
  };
  const endpoint = {
    fresh: async () => true,
    pane: () => state.pane,
    agent: () => state.agent,
    run: () => state.run,
    writer,
  };
  return { state, endpoint: endpoint as typeof endpoint & SendSite };
}

const pick = (kind: PickRequest["kind"], value: string, label: string): PickRequest => ({ kind, value, label });
/** Claude's Model pick as the chip makes it (main makes its line). */
const opus = namedPick("model", { agent: "claude", model: "opus", effort: null }, "Opus");

describe("held commands never run together", () => {
  it("submits held Model, Effort and Compact as three standalone commands", async () => {
    const { state, endpoint } = site();
    const tasks: Promise<void>[] = [];
    const picks = new AgentPicks({
      send: (_h, p, t, b) => {
        const task = sendBound(endpoint, p, t, b);
        tasks.push(task);
        return task;
      },
      // A model pick goes to main, which types its own line through the same bound Send.
      modelPick: (_h, p, chosen, b) => {
        const task = sendBound(endpoint, p, pickLine(chosen), mainPickBinding(b));
        tasks.push(task);
        return task;
      },
      copy: () => undefined,
      now: () => 100,
    });
    picks.pick(ctx("working"), opus);
    picks.pick(ctx("working"), pick("effort", "high", "High"));
    picks.pick(ctx("working"), pick("compact", "compact", "Compact"));
    picks.sync("mac-a/p1", ctx("idle"));
    await Promise.all(tasks);
    await flush();
    expect(state.submitted).toEqual(["/model opus", "/effort high", "/compact"]);
  });

  it("a typed line waits for the pick before it, and each rechecks the pane when its turn comes", async () => {
    const { state, endpoint } = site();
    let releaseReturn!: () => void;
    const firstReturn = new Promise<void>((resolve) => (releaseReturn = resolve));
    const keys = endpoint.writer.agentKeys;
    let calls = 0;
    endpoint.writer.agentKeys = async () => {
      calls += 1;
      if (calls === 1) await firstReturn;
      await keys();
    };
    const first = sendBound(endpoint, "p1", "/effort low", binding);
    const second = sendBound(endpoint, "p1", "/model sonnet", binding);
    await flush();
    // The second has typed nothing while the first waits for its Return.
    expect(state.writes).toEqual(["/effort low"]);
    // Its turn comes after another program took the pane: refused, nothing typed.
    state.pane = { ...state.pane!, terminalID: "t2" };
    releaseReturn();
    await first;
    await expect(second).rejects.toThrow();
    expect(state.submitted).toEqual(["/effort low"]);
    expect(state.writes).toEqual(["/effort low"]);
  });

  it("a refused send does not hold up the next one", async () => {
    const { state, endpoint } = site();
    state.agent.inputPending = true;
    await expect(sendBound(endpoint, "p1", "/compact", binding)).rejects.toThrow();
    state.agent.inputPending = false;
    await sendBound(endpoint, "p1", "/compact", binding);
    expect(state.submitted).toEqual(["/compact"]);
  });
});

const json = (value: unknown): string => JSON.stringify(value);

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("fake-backend condition timed out");
}

interface ChatEvent {
  readonly paneId: string;
  readonly state: { readonly status: string };
  readonly settings?: { model: string | null; used?: number | null; scope: { session: string | null }; limits?: { codexLimit?: number | null } | null };
}

/** A fake machine with two Codex panes (a, b), each its own rollout; a's session can be replaced by b's file. */
async function fakeChat() {
  const { ChatService } = await import("../src/main/chat/service");
  const paths = ["/Users/fixture/.codex/sessions/2026/11/03/a.jsonl", "/Users/fixture/.codex/sessions/2026/11/03/b.jsonl"];
  const files = new Map<string, string>();
  const body = (model: string, total: number) =>
    json({ type: "turn_context", payload: { model, effort: "high" } }) +
    "\n" +
    json({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: total }, model_context_window: 272_000 } } }) +
    "\n";
  files.set(paths[0]!, body("gpt-5.5", 11_111));
  files.set(paths[1]!, body("gpt-5.4", 22_222));
  files.set("/Users/fixture/.codex/config.toml", "model_auto_compact_token_limit = 200000\n");
  const reads: string[] = [];
  let connection = 1;
  let swapped = false;
  const reader = {
    locate: async (ref: { lookup: { path: string } }) => ref.lookup.path,
    size: async (path: string) => Buffer.byteLength(files.get(path) ?? ""),
    read: async (path: string, offset: number, max: number): Promise<Uint8Array> => {
      reads.push(path);
      return Buffer.from(files.get(path) ?? "").subarray(offset, offset + max);
    },
  };
  const pane = (id: string) => ({ paneID: id, terminalID: `t-${id}`, agent: "codex", agentStatus: "idle" });
  const agent = (id: string) => ({
    paneID: id,
    agent: "codex",
    agentSession: { source: "herdr:codex", agent: "codex", kind: "path", value: paths[id === "a" && !swapped ? 0 : 1] },
  });
  const backend = { transcripts: () => reader };
  const hosts = {
    backend: () => backend as never,
    pane: (_h: string, id: string) => pane(id) as never,
    agent: (_h: string, id: string) => agent(id) as never,
    connection: () => connection,
  };
  const service = new ChatService(hosts, "chat", { pollIntervalMs: 10 });
  const events: ChatEvent[] = [];
  const owner = { id: 1, isDestroyed: () => false, send: (_channel: string, event: unknown) => events.push(event as ChatEvent) };
  return {
    service,
    events,
    owner,
    reader,
    reads,
    files,
    paths,
    changeSession: () => {
      swapped = true;
    },
    reconnect: () => {
      connection += 1;
    },
  };
}

describe("a new session never inherits the old one's values", () => {
  it("switching two panes on the same machine gives each its own values", async () => {
    const m = await fakeChat();
    try {
      m.service.open(m.owner, "mac-a", "a");
      await until(() => m.events.at(-1)?.settings?.used === 11_111);
      m.service.open(m.owner, "mac-a", "b");
      await until(() => m.events.at(-1)?.paneId === "b" && m.events.at(-1)?.state.status === "live");
      expect(m.events.at(-1)!.settings).toMatchObject({ model: "gpt-5.4", used: 22_222 });
    } finally {
      m.service.closeAll();
    }
  });

  it("ignores an old transcript read that finishes after a session change", async () => {
    const m = await fakeChat();
    m.files.set(m.paths[0]!, json({ type: "metadata", pad: "x".repeat(1000) }) + "\n" + m.files.get(m.paths[0]!));
    const original = m.reader.read;
    let release: (() => void) | null = null;
    let waiting = false;
    m.reader.read = async (path, offset, max) => {
      if (path === m.paths[0]) {
        waiting = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      return original(path, offset, max);
    };
    try {
      m.service.open(m.owner, "mac-a", "a");
      await until(() => waiting);
      m.changeSession();
      m.service.refresh();
      await until(() => m.events.at(-1)?.settings?.used === 22_222);
      release!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(m.events.at(-1)!.settings).toMatchObject({ model: "gpt-5.4", used: 22_222, scope: { session: m.paths[1] } });
    } finally {
      (release as (() => void) | null)?.();
      m.service.closeAll();
    }
  });

  it("Codex Effort then sends the new session's own model", async () => {
    const m = await fakeChat();
    const sent: string[] = [];
    const recorder = new AgentPicks({
      send: async (_h, _p, text) => void sent.push(text),
      modelPick: async (_h, _p, chosen) => void sent.push(pickLine(chosen)),
      copy: () => undefined,
      now: () => 0,
    });
    try {
      m.service.open(m.owner, "mac-a", "a");
      await until(() => m.events.at(-1)?.settings?.used === 11_111);
      m.changeSession();
      m.service.refresh();
      await until(() => m.events.at(-1)?.settings?.used === 22_222);
      const settings = m.events.at(-1)!.settings!;
      const codexBinding: SendBinding = { terminalID: "t-a", isAgent: true, kind: "codex", session: m.paths[1]! };
      recorder.receive("mac-a/a", settings as never, null);
      // Effort names the model the page has for this session (AgentChips.tsx chipMenu), the new one's.
      const model = recorder.effective("mac-a/a", codexBinding).model;
      expect(model).toBe("gpt-5.4");
      recorder.pick({ hostId: "mac-a", paneId: "a", agent: "codex", status: "idle", binding: codexBinding }, namedPick("effort", { agent: "codex", model: model!, effort: "low" }, "Low"));
      await flush();
      expect(sent).toEqual(["/model gpt-5.4 --reasoning=low"]);
    } finally {
      m.service.closeAll();
    }
  });
});

describe("typed / lines carry the run they were picked on", () => {
  async function typedThroughComposer(text: string): Promise<{ binding: SendBinding; text: string }> {
    const { Composer } = await import("../src/renderer/components/MainPane");
    const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
    const { decodeSessionTopology } = await import("../src/main/herdr/wire");
    const { HookHost, find } = await import("./support/fake-hooks");
    composerDrafts.clear();
    const sent: [string, string, string, SendBinding][] = [];
    vi.stubGlobal("window", {
      innerHeight: 900,
      herdrDesktop: { sendToPane: async (...args: [string, string, string, SendBinding]) => void sent.push(args), copyText: () => undefined },
    });
    const topology = decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [],
      tabs: [],
      layouts: [],
      panes: [{ pane_id: "p1", terminal_id: "t1", workspace_id: "w1", tab_id: "tab1", focused: false, agent: "claude", agent_status: "idle", revision: 1 }],
      agents: [{ pane_id: "p1", agent: "claude", agent_status: "idle", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "session-1" } }],
    });
    const host = { id: "mac-a", name: "fake", state: "connected", topology, run: { connection: 2, arrivals: { p1: 1 } } };
    const row = { paneID: "p1", kind: "claude", isAgent: true, status: "idle", workspaceLabel: "fixture" };
    const ui = new HookHost(Composer as (props: object) => unknown, { host, row });
    ui.render();
    try {
      (find(ui.tree, "textarea")!.props["onChange"] as (event: unknown) => void)({ target: { value: text } });
      (find(ui.tree, "textarea")!.props["onKeyDown"] as (event: unknown) => void)({
        key: "Enter",
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => undefined,
      });
      await flush();
    } finally {
      ui.unmount();
      composerDrafts.clear();
    }
    return { text: sent[0]![2], binding: sent[0]![3] };
  }

  it("includes the shown connection and run on a typed slash line", async () => {
    const { binding: sentBinding } = await typedThroughComposer("/compact");
    expect(sentBinding).toMatchObject({ run: binding.run });
  });

  it("the Composer's line is refused after a reconnect, and after a resumed session with the same id", async () => {
    const typed = await typedThroughComposer("/compact");
    const reconnect = site();
    reconnect.state.run = { connection: 3, arrival: 1 };
    await expect(sendBound(reconnect.endpoint, "p1", typed.text, typed.binding)).rejects.toThrow();
    const resumed = site();
    resumed.state.run = { connection: 2, arrival: 2 };
    await expect(sendBound(resumed.endpoint, "p1", typed.text, typed.binding)).rejects.toThrow();
    expect([...reconnect.state.writes, ...resumed.state.writes]).toEqual([]);
    const same = site();
    await sendBound(same.endpoint, "p1", typed.text, typed.binding);
    expect(same.state.submitted).toEqual(["/compact"]);
  });

  it("send.ts refuses a typed command bound without a run", async () => {
    const { state, endpoint } = site();
    const { run: _run, ...noRun } = binding;
    await expect(sendBound(endpoint, "p1", "/compact", noRun)).rejects.toThrow();
    expect(state.writes).toEqual([]);
  });
});

describe("Return never answers a dialog that appeared after typing", () => {
  it("does not press Return into a dialog appearing after typing", async () => {
    const { state, endpoint } = site();
    endpoint.writer.sendText = async (_p, text) => {
      state.writes.push(text);
      state.agent.inputPending = true;
    };
    await expect(sendBound(endpoint, "p1", "/compact", binding)).rejects.toThrow(/no Return was pressed\. Check the terminal/);
    expect(state.submitted).toEqual([]);
  });

  it("nor when only the pane shows it blocked", async () => {
    const { state, endpoint } = site();
    let returns = 0;
    endpoint.writer.agentKeys = async () => void (returns += 1);
    endpoint.writer.sendText = async (_p, text) => {
      state.writes.push(text);
      state.pane = { ...state.pane!, agentStatus: "blocked" } as TopologyPaneInfo;
    };
    await expect(sendBound(endpoint, "p1", "/effort high", binding)).rejects.toThrow(/no Return was pressed/);
    // Never retried: the next send for the pane does not press the old line's Return.
    state.pane = { ...state.pane!, agentStatus: "idle" } as TopologyPaneInfo;
    await flush();
    expect(returns).toBe(0);
  });
});

// A fake SFTP server (stat/open follow symlinks; realpath resolves them and "." is the login home); no network.
class Sftp {
  files = new Map<string, Buffer>();
  links = new Map<string, string>();
  opens: string[] = [];
  home = "/Users/fixture";
  resolve(path: string): string {
    for (const [link, to] of this.links) if (path === link || path.startsWith(link + "/")) return to + path.slice(link.length);
    return path;
  }
  stat(path: string, cb: (error: Error | null, stats: { size: number }) => void): void {
    const bytes = this.files.get(this.resolve(path));
    cb(bytes ? null : Object.assign(new Error("missing"), { code: 2 }), { size: bytes?.length ?? 0 });
  }
  realpath(path: string, cb: (error: Error | null, real?: string) => void): void {
    if (path === ".") return cb(null, this.home);
    const real = this.resolve(path);
    if (!this.files.has(real)) return cb(Object.assign(new Error("missing"), { code: 2 }));
    cb(null, real);
  }
  open(path: string, _flags: string, cb: (error: Error | null, handle: Buffer) => void): void {
    this.opens.push(path);
    const real = this.resolve(path);
    cb(this.files.has(real) ? null : Object.assign(new Error("missing"), { code: 2 }), Buffer.from(real));
  }
  read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, cb: (error: Error | null, n: number) => void): void {
    const bytes = this.files.get(handle.toString())!.subarray(position, position + length);
    bytes.copy(buffer, offset);
    cb(null, bytes.length);
  }
  close(_handle: unknown, cb: () => void): void {
    cb();
  }
}

async function fakeSftp() {
  const { EventEmitter } = await import("node:events");
  const { SshTranscriptReader } = await import("../src/main/chat/ssh-reader");
  const server = new Sftp();
  class Client extends EventEmitter {
    sftp(cb: (error: Error | null, sftp: Sftp) => void): void {
      cb(null, server);
    }
    end(): void {
      this.emit("end");
    }
    exec(): never {
      throw new Error("no remote commands allowed in these tests");
    }
  }
  const reader = new SshTranscriptReader(
    { host: "fake.invalid", port: 22, username: "fixture", privateKeyPath: "/fake-key", herdrSession: "fixture" } as never,
    {} as never,
    { connect: async () => new Client() as never },
  );
  return { server, reader };
}

const transcript = "/Users/fixture/.claude/projects/fixture/session-1.jsonl";

describe("settings reads stay inside home", () => {
  it.each([
    ["malformed transcript", "/Users/fixture/random.jsonl", "/Users/fixture/proj", "/Users/fixture/proj/.claude/settings.json"],
    ["dot-dot", "/Users/fixture/.claude/../../outside/projects/p/s.jsonl", null, "/Users/fixture/.claude/../../outside/settings.json"],
    ["outside home", "/srv/other/projects/p/s.jsonl", "/srv/other/proj", "/srv/other/settings.json"],
    ["very deep", "/Users/fixture/" + "a/".repeat(200) + "projects/p/s.jsonl", null, "/Users/fixture/" + "a/".repeat(200) + "settings.json"],
    ["project outside home", transcript, "/etc/other", "/etc/other/.claude/settings.json"],
  ])("refuses %s before opening settings", async (_name, path, cwd, settings) => {
    const { ContextSettings } = await import("../src/main/chat/context-settings");
    const { server, reader } = await fakeSftp();
    server.files.set(settings, Buffer.from(json({ autoCompactWindow: 400_000 })));
    server.files.set("/etc/other/.claude/settings.json", Buffer.from(json({ autoCompactWindow: 400_000 })));
    try {
      await new ContextSettings().load(reader, "fake#1", "claude", path, cwd);
      expect(server.opens).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it("refuses a symlinked config folder", async () => {
    const { ContextSettings } = await import("../src/main/chat/context-settings");
    const { server, reader } = await fakeSftp();
    server.links.set("/Users/fixture/.claude", "/outside");
    server.files.set("/outside/settings.json", Buffer.from(json({ autoCompactWindow: 400_000 })));
    try {
      const limits = await new ContextSettings().load(reader, "fake#1", "claude", transcript, null);
      expect(server.opens).toEqual([]);
      expect(limits.claude?.autoCompactWindow).toBeUndefined();
    } finally {
      reader.close();
    }
  });

  it("rejects an unshaped Codex rollout path", async () => {
    const { ContextSettings } = await import("../src/main/chat/context-settings");
    const { server, reader } = await fakeSftp();
    server.files.set("/srv/other/config.toml", Buffer.from("model_auto_compact_token_limit = 400000\n"));
    server.files.set("/Users/fixture/.codex/config.toml", Buffer.from("model_auto_compact_token_limit = 400000\n"));
    try {
      await new ContextSettings().load(reader, "fake#1", "codex", "/srv/other/sessions/arbitrary.jsonl", null);
      await new ContextSettings().load(reader, "fake#1", "codex", "/Users/fixture/.codex/sessions/arbitrary.jsonl", null);
      expect(server.opens).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it("keeps only named values and skips damaged, huge and missing files (a well-shaped pane inside home)", async () => {
    const { ContextSettings } = await import("../src/main/chat/context-settings");
    const { server, reader } = await fakeSftp();
    server.files.set(
      "/Users/fixture/.claude/settings.json",
      Buffer.from(json({ autoCompactWindow: 400_000, secret: "SENTINEL", env: { ANTHROPIC_API_KEY: "SENTINEL", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" } })),
    );
    server.files.set("/Users/fixture/proj/.claude/settings.json", Buffer.alloc(65_537, 32));
    server.files.set("/Users/fixture/proj/.claude/settings.local.json", Buffer.from("{damaged"));
    try {
      const result = await new ContextSettings().load(reader, "fake#1", "claude", transcript, "/Users/fixture/proj");
      expect(result).toEqual({
        claude: { autoCompactWindow: 400_000, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" }, from: { autoCompactWindow: "user", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "user" } },
      });
      expect(server.opens).not.toContain("/Users/fixture/proj/.claude/settings.json");
      expect(json(result)).not.toContain("SENTINEL");
      const codex = await new ContextSettings().load(reader, "fake#1", "codex", "/Users/fixture/.codex/sessions/2026/11/03/rollout-a.jsonl", null);
      expect(codex).toEqual({ codexLimit: null });
    } finally {
      reader.close();
    }
  });
});

describe("Put in box never loses a kept draft", () => {
  async function setup(keptDraft: (store: import("../src/main/drafts").DraftStore, id: string, action: string) => Promise<unknown>) {
    const { DraftStore, MemoryDraftFiles } = await import("../src/main/drafts");
    const { ComposerDrafts } = await import("../src/renderer/components/composer-drafts");
    const { DraftPersistence } = await import("../src/renderer/components/draft-persistence");
    const store = new DraftStore(new MemoryDraftFiles());
    store.put("mac-a", "gone", { text: "kept original", chips: [], lost: [] }, null);
    store.hostAnswered("mac-a", "fake", new Set());
    const drafts = new ComposerDrafts();
    const persistence = new DraftPersistence(drafts);
    persistence.attach({
      saveDraft: (h: string, p: string, d: never) => store.put(h, p, d, null),
      keptDraft: (id: string, action: string) => keptDraft(store, id, action),
    } as never);
    persistence.restore(store.state());
    return { store, drafts, persistence, item: persistence.keptFor("mac-a")[0]! };
  }

  it("does not lose a Kept draft when the box changes during the move: the box has it before Kept lets it go", async () => {
    let release!: () => void;
    const { store, drafts, persistence, item } = await setup(async (s, id, action) => {
      await new Promise<void>((resolve) => (release = resolve));
      if (action === "discard") s.discardKept(id);
      return null;
    });
    const pending = persistence.take(item, "mac-a/p1");
    // The user types meanwhile: the box already holds the kept text.
    drafts.edit("mac-a/p1", `${drafts.get("mac-a/p1").text} typed meanwhile`);
    release();
    await pending;
    expect(drafts.get("mac-a/p1").text).toBe("kept original typed meanwhile");
    // Kept let it go only after the box took it; it is a saved draft of this pane now.
    expect(store.state().kept).toEqual([]);
    expect(store.state().drafts.map((d) => [d.paneId, d.text])).toEqual([["p1", "kept original typed meanwhile"]]);
    persistence.detach();
  });

  it("a refused or interrupted move keeps it under Kept drafts", async () => {
    const calls: string[] = [];
    const busy = await setup(async (_s, _id, action) => void calls.push(action));
    busy.drafts.edit("mac-a/p1", "not empty");
    await busy.persistence.take(busy.item, "mac-a/p1");
    expect(calls).toEqual([]);
    expect(busy.store.state().kept.map((k) => k.text)).toEqual(["kept original"]);
    busy.persistence.detach();
    const broken = await setup(async () => {
      throw new Error("the main process did not answer");
    });
    await broken.persistence.take(broken.item, "mac-a/p1");
    expect(broken.store.state().kept.map((k) => k.text)).toEqual(["kept original"]);
    expect(broken.persistence.keptFor("mac-a").map((k) => k.text)).toEqual(["kept original"]);
    broken.persistence.detach();
  });
});

describe("a saved drafts.json always loads, and the bounds cover the whole file", () => {
  const input = (text: string) => ({ text, chips: [], lost: [] });
  const draft = { hostId: "mac-a", paneId: "p1", text: "x", chips: [], lost: [], savedAt: 0 };
  const keptItem = { id: "k1", hostId: "mac-a", hostLabel: "fake", paneId: "gone", agentName: null, text: "x", chips: [], reason: "gone", at: 0 };

  it("bounds the whole serialized file, including Kept drafts", async () => {
    const { DraftStore, MemoryDraftFiles } = await import("../src/main/drafts");
    const { maxDraftsBytes } = await import("../src/shared/drafts");
    const files = new MemoryDraftFiles();
    const store = new DraftStore(files);
    for (let i = 0; i < 2; i += 1) store.put("mac-a", `gone-${i}`, input("k".repeat(100_000)), null);
    store.hostAnswered("mac-a", "fake", new Set());
    for (let i = 0; i < 22; i += 1) store.put("mac-a", `live-${i}`, input("x".repeat(100_000)), null);
    store.flush();
    expect(Buffer.byteLength(files.text!)).toBeLessThanOrEqual(maxDraftsBytes);
    // The oldest went first; Kept and the newest stay.
    expect(store.state().kept).toHaveLength(2);
    expect(store.state().drafts.at(-1)!.paneId).toBe("live-21");
    expect(store.state().drafts.some((d) => d.paneId === "live-0")).toBe(false);
  });

  it.each(["draft count", "per-draft bytes", "kept count"])("applies %s limits on load", async (which) => {
    const { DraftStore, MemoryDraftFiles } = await import("../src/main/drafts");
    const { keptLimit, maxDraftTextBytes, maxSavedDrafts } = await import("../src/shared/drafts");
    const files = new MemoryDraftFiles();
    files.text = json({
      version: 1,
      drafts:
        which === "draft count"
          ? Array.from({ length: 201 }, (_, i) => ({ ...draft, paneId: `p${i}`, savedAt: i }))
          : [{ ...draft, text: which === "per-draft bytes" ? "x".repeat(100_001) : "x" }],
      kept: which === "kept count" ? Array.from({ length: 51 }, (_, i) => ({ ...keptItem, id: `k${i}` })) : [],
    });
    const state = new DraftStore(files).state();
    if (which === "draft count") {
      expect(state.drafts.length).toBeLessThanOrEqual(maxSavedDrafts);
      // The least recently saved went.
      expect(state.drafts.some((d) => d.paneId === "p0")).toBe(false);
    }
    if (which === "per-draft bytes") expect(Buffer.byteLength(state.drafts[0]?.text ?? "")).toBeLessThanOrEqual(maxDraftTextBytes);
    if (which === "kept count") expect(state.kept.length).toBeLessThanOrEqual(keptLimit);
  });

  it("can reload a state produced from a valid IPC input with lost chips", async () => {
    const { DraftStore, MemoryDraftFiles } = await import("../src/main/drafts");
    const { isDraftInput } = await import("../src/shared/drafts");
    const files = new MemoryDraftFiles();
    const sent = {
      text: "original",
      lost: Array.from({ length: 64 }, (_, i) => `lost${i}`),
      chips: Array.from({ length: 64 }, (_, i) => ({ path: `/remote/${i}`, name: `f${i}`, image: false })),
    };
    expect(isDraftInput(sent)).toBe(true);
    const store = new DraftStore(files);
    store.put("mac-a", "p1", sent, null);
    store.flush();
    const again = new DraftStore(files);
    expect(again.damaged).toBeNull();
    expect(again.state().drafts).toHaveLength(1);
  });

  it("a bad entry is skipped, never the whole file", async () => {
    const { DraftStore, MemoryDraftFiles } = await import("../src/main/drafts");
    const files = new MemoryDraftFiles();
    files.text = json({ version: 1, drafts: [{ ...draft, paneId: "good" }, { ...draft, paneId: "", text: 5 }], kept: [keptItem, { id: 7 }] });
    const store = new DraftStore(files);
    expect(store.damaged).toBeNull();
    expect(store.state().drafts.map((d) => d.paneId)).toEqual(["good"]);
    expect(store.state().kept.map((k) => k.id)).toEqual(["k1"]);
  });

  it("reads at most the bound before parsing: a larger file is moved aside unparsed", async () => {
    const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DraftStore, fileDrafts } = await import("../src/main/drafts");
    const dir = mkdtempSync(join(tmpdir(), "herdr-model-"));
    const file = join(dir, "drafts.json");
    writeFileSync(file, json({ version: 1, drafts: [], kept: [], pad: "x".repeat(5 * 1_024 * 1_024) }));
    const parse = vi.spyOn(JSON, "parse");
    const store = new DraftStore(fileDrafts(file));
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(store.damaged).not.toBeNull();
    expect(existsSync(store.damaged!)).toBe(true);
    expect(store.state()).toEqual({ drafts: [], kept: [] });
  });
});

describe("a failed save stays dirty", () => {
  it("retries an unsuccessful save at quit", async () => {
    const { DraftStore } = await import("../src/main/drafts");
    let attempts = 0;
    let written: string | null = null;
    const store = new DraftStore({
      read: () => null,
      moveAside: () => null,
      write: (text) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient IO failure");
        written = text;
      },
    });
    store.put("mac-a", "p1", { text: "must survive", chips: [], lost: [] }, null);
    store.flush();
    store.flush();
    expect(attempts).toBe(2);
    expect(written).toContain("must survive");
    // Clean now: nothing more to write.
    store.flush();
    expect(attempts).toBe(2);
  });

  it("a failed timed write is tried again by its next deadline", async () => {
    vi.useFakeTimers();
    try {
      const { DraftStore } = await import("../src/main/drafts");
      let attempts = 0;
      const store = new DraftStore({
        read: () => null,
        moveAside: () => null,
        write: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("disk full");
        },
      });
      store.put("mac-a", "p1", { text: "x", chips: [], lost: [] }, null);
      vi.advanceTimersByTime(500);
      expect(attempts).toBe(1);
      vi.advanceTimersByTime(5_000);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Load earlier never drops a live settings line", () => {
  const assistant = (total: number): string =>
    json({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: total } } }) + "\n";

  it("does not discard the first live line after an earlier-history read", async () => {
    const { AgentSettingsReader, tapReader } = await import("../src/shared/agent-settings");
    let file = " ".repeat(1000) + "\n" + assistant(100);
    const base = {
      locate: async () => "/fake.jsonl",
      size: async () => Buffer.byteLength(file),
      read: async (_p: string, offset: number, max: number): Promise<Uint8Array> => Buffer.from(file).subarray(offset, offset + max),
    };
    const settings = new AgentSettingsReader("claude");
    const tapped = tapReader(base, settings, () => undefined);
    await tapped.size("/fake.jsonl");
    await tapped.read("/fake.jsonl", 1000, Buffer.byteLength(file) - 1000);
    expect(settings.settings.used).toBe(100);
    await tapped.read("/fake.jsonl", 0, 1001);
    const offset = Buffer.byteLength(file);
    file += assistant(200);
    await tapped.size("/fake.jsonl");
    await tapped.read("/fake.jsonl", offset, Buffer.byteLength(file) - offset);
    expect(settings.settings.used).toBe(200);
  });

  it("a live line split across polls still joins after a history read in between", async () => {
    const { AgentSettingsReader, tapReader } = await import("../src/shared/agent-settings");
    const older = assistant(50);
    let file = older + assistant(100);
    const base = {
      locate: async () => "/fake.jsonl",
      size: async () => Buffer.byteLength(file),
      read: async (_p: string, offset: number, max: number): Promise<Uint8Array> => Buffer.from(file).subarray(offset, offset + max),
    };
    const settings = new AgentSettingsReader("claude");
    const tapped = tapReader(base, settings, () => undefined);
    const start = Buffer.byteLength(older);
    await tapped.read("/fake.jsonl", start, Buffer.byteLength(file) - start);
    const next = assistant(300);
    const half = Math.floor(next.length / 2);
    let end = Buffer.byteLength(file);
    file += next;
    await tapped.read("/fake.jsonl", end, half);
    end += half;
    // Load earlier, between the two halves.
    await tapped.read("/fake.jsonl", 0, start);
    await tapped.read("/fake.jsonl", end, Buffer.byteLength(file) - end);
    expect(settings.settings.used).toBe(300);
  });
});

describe("the ring's screen warning belongs to its run", () => {
  const low = "Context low (8% remaining)";
  const shown: SendBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: "old", run: { connection: 2, arrival: 1 } };

  it("does not carry a screen warning into a compaction that occurred while the ring was unmounted", async () => {
    const { ContextScreens } = await import("../src/renderer/components/context-screens");
    const screens = new ContextScreens();
    screens.report("mac-a/p1", low, shown, { compactedAt: null, usedAt: 10 });
    expect(screens.remaining("mac-a/p1", shown, { compactedAt: 500, usedAt: 500 })).toBeNull();
    expect(screens.remaining("mac-a/p1", shown, { compactedAt: null, usedAt: 10 })).toBe(8);
  });

  it("fresh transcript numbers win over an older screen reading; no baseline, no warning", async () => {
    const { ContextScreens } = await import("../src/renderer/components/context-screens");
    const screens = new ContextScreens();
    screens.report("mac-a/p1", low, shown, { compactedAt: null, usedAt: 10 });
    expect(screens.remaining("mac-a/p1", shown, { compactedAt: null, usedAt: 900 })).toBeNull();
    screens.report("mac-a/p2", low, shown, null);
    expect(screens.remaining("mac-a/p2", shown, { compactedAt: null, usedAt: null })).toBeNull();
  });

  it("clears the screen override when a new run replaces the same pane", async () => {
    const { ContextRing } = await import("../src/renderer/components/ContextRing");
    const { contextScreens } = await import("../src/renderer/components/context-screens");
    const { agentPicks } = await import("../src/renderer/components/agent-picks");
    const { HookHost, find } = await import("./support/fake-hooks");
    contextScreens.clear();
    agentPicks.clear();
    const scope = (session: string) => ({ terminalID: "t1", session });
    const host = (session: string, arrival: number) => ({
      id: "mac-a",
      state: "connected",
      topology: {
        panes: [{ paneID: "p1", terminalID: "t1", agent: "claude", agentStatus: "idle" }],
        agents: [{ paneID: "p1", agent: "claude", agentSession: { value: session } }],
      },
      run: { connection: 2, arrivals: { p1: arrival } },
    });
    const row = { paneID: "p1", isAgent: true };
    agentPicks.receive("mac-a/p1", { model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: "high", used: 920_000, usedAt: 10, compactedAt: null, scope: scope("old") }, null);
    contextScreens.report("mac-a/p1", low, shown, { compactedAt: null, usedAt: 10 });
    const ui = new HookHost(ContextRing as (props: object) => unknown, { host: host("old", 1), row });
    ui.render();
    try {
      expect(String(find(ui.tree, "button")!.props["aria-label"])).toContain("the pane's screen");
      agentPicks.receive("mac-a/p1", { model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: "low", used: 100, usedAt: 10, compactedAt: null, scope: scope("new") }, null);
      ui.render({ host: host("new", 2), row });
      expect(String(find(ui.tree, "button")!.props["aria-label"])).not.toContain("the pane's screen");
    } finally {
      ui.unmount();
      contextScreens.clear();
      agentPicks.clear();
    }
  });
});

// Queued hidden commands and Kept entries.

describe("a queued hidden command never goes into a pane that has become Working", () => {
  it("rechecks Working before typing the next queued hidden command", async () => {
    const { state, endpoint } = site();
    const keys = endpoint.writer.agentKeys;
    const tasks: Promise<void>[] = [];
    endpoint.writer.agentKeys = async () => {
      await keys();
      (state.agent as { agentStatus: string }).agentStatus = "working";
      state.pane = { ...state.pane!, agentStatus: "working" } as TopologyPaneInfo;
    };
    const picks = new AgentPicks({
      send: (_h, p, t, b) => {
        const task = sendBound(endpoint, p, t, b);
        tasks.push(task);
        return task;
      },
      // A model pick goes to main, which types its own line through the same bound Send.
      modelPick: (_h, p, chosen, b) => {
        const task = sendBound(endpoint, p, pickLine(chosen), mainPickBinding(b));
        tasks.push(task);
        return task;
      },
      copy: () => undefined,
      now: () => 0,
    });
    picks.pick(ctx("working"), pick("compact", "compact", "Compact"));
    picks.pick(ctx("working"), opus);
    picks.sync("mac-a/p1", ctx("idle"));
    await Promise.allSettled(tasks);
    await flush();
    expect(state.submitted).toEqual(["/compact"]);
    expect(state.writes).toEqual(["/compact"]);
    // Model is held again for the next turn (no note), and goes once at the next idle.
    expect(picks.chip("mac-a/p1", "model", binding)).toEqual({ label: "Opus", next: true });
    expect(picks.note("mac-a/p1")).toBeNull();
    (state.agent as { agentStatus: string }).agentStatus = "idle";
    state.pane = { ...state.pane!, agentStatus: "idle" } as TopologyPaneInfo;
    endpoint.writer.agentKeys = keys;
    picks.sync("mac-a/p1", ctx("idle"));
    picks.sync("mac-a/p1", ctx("idle"));
    await Promise.allSettled(tasks);
    await flush();
    expect(state.submitted).toEqual(["/compact", "/model opus"]);
  });

  it("a dialog at its turn holds it too; a / line the user types keeps today's route", async () => {
    const { state, endpoint } = site();
    state.pane = { ...state.pane!, agentStatus: "blocked" } as TopologyPaneInfo;
    await expect(sendBound(endpoint, "p1", "/compact", { ...binding, atPromptOnly: true })).rejects.toThrow();
    expect(state.writes).toEqual([]);
    const working = site();
    working.state.pane = { ...working.state.pane!, agentStatus: "working" } as TopologyPaneInfo;
    (working.state.agent as { agentStatus: string }).agentStatus = "working";
    await sendBound(working.endpoint, "p1", "/compact", binding);
    expect(working.state.submitted).toEqual(["/compact"]);
  });
});

describe("Kept entries load with the same per-entry bounds as active drafts", () => {
  it.each(["text", "chips"])("a Kept entry loaded from disk obeys its per-entry %s bound", async (which) => {
    const { DraftStore, MemoryDraftFiles } = await import("../src/main/drafts");
    const { maxDraftTextBytes, maxDraftChips } = await import("../src/shared/drafts");
    const files = new MemoryDraftFiles();
    const item = {
      id: "k1",
      hostId: "mac-a",
      hostLabel: "fake",
      paneId: "gone",
      agentName: null,
      text: which === "text" ? "x".repeat(100_001) : "x",
      chips: which === "chips" ? Array.from({ length: 11 }, (_, i) => ({ path: `/remote/${i}`, name: `f${i}`, image: false })) : [],
      reason: "gone",
      at: 0,
    };
    files.text = json({ version: 1, drafts: [], kept: [item, { ...item, id: "k2", text: "fine", chips: [] }] });
    const store = new DraftStore(files);
    const kept = store.state().kept;
    expect(kept.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(Buffer.byteLength(kept[0]!.text)).toBeLessThanOrEqual(maxDraftTextBytes);
    expect(kept[0]!.chips.length).toBeLessThanOrEqual(maxDraftChips);
    expect(kept[1]!.text).toBe("fine");
  });
});
