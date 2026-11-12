// A live model pick is its own request to
// main (src/main/ipc.ts IPC.modelPick), never a finished command. Through main's real handlers (registerIpc) with
// fake hosts: main checks the model against the machine's list and the agent's id pattern, the effort against that
// model's levels, makes the line itself (model-choices.ts modelPickCommand), and sends it as a pick (at the prompt
// only, never into a start screen or a dialog, while the pane is as the user saw it) through the bound Send. A refusal
// writes nothing. A held pick is checked again when it goes. Free-text Send (IPC.paneSend) is not checked against the list.

import { describe, expect, it, vi } from "vitest";

import type { CatalogModel } from "../src/shared/model-catalog";
import type { SendBinding } from "../src/shared/send-binding";

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
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { registerIpc, pickBinding } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");
const { parseCatalog } = await import("../src/shared/model-catalog");
const { demoModelLists } = await import("../src/main/demo/demo-model-lists");
const { notAtPromptText } = await import("../src/shared/send-binding");
const { startScreenTexts } = await import("../src/shared/prompt/start-screen");
const { AgentPicks } = await import("../src/renderer/components/agent-picks");
const { modelPickRequest } = await import("../src/renderer/components/AgentChips");

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

function listOf(agent: "claude" | "codex" | "cursor"): CatalogModel[] {
  const parsed = parseCatalog(agent, demoModelLists[agent]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return [...parsed.models];
}

const bindingOf = (kind: string): SendBinding => ({ terminalID: "term", isAgent: true, kind, session: "session", run: { connection: 1, arrival: 1 } });
const codex = bindingOf("codex");
const picked = { ...codex, atPromptOnly: true };

interface Machine {
  /** Every write to the pane: [route, paneId, text, keys]. */
  readonly writes: unknown[][];
  /** The agent's list on the machine, as main's catalog holds it now (a test may change it). */
  catalog: CatalogModel[];
  /** How often main read the list. */
  checks: number;
  status: string;
  inputPending: boolean;
  modelPick(pick: unknown, binding?: unknown, ...rest: unknown[]): Promise<void>;
  paneSend(text: string, binding?: unknown): Promise<void>;
}

/** Main's handlers over one fake machine with one agent pane ("pane", running `kind`). */
function machine(kind: "codex" | "claude" | "cursor" = "codex", options: { startScreen?: boolean } = {}): Machine {
  registered.handles.clear();
  // This machine's own handlers, kept when it is made (a later machine() registers its own).
  let pickHandler: (...args: unknown[]) => Promise<void> = async () => undefined;
  let sendHandler: (...args: unknown[]) => Promise<void> = async () => undefined;
  const m: Machine = {
    writes: [],
    catalog: listOf(kind),
    checks: 0,
    status: "idle",
    inputPending: false,
    modelPick: (pick, binding = codex, ...rest) => pickHandler(pick, binding, ...rest),
    paneSend: (text, binding = picked) => sendHandler(text, binding),
  };
  const pane = () => ({ paneID: "pane", terminalID: "term", workspaceID: "w1", tabID: "t1", focused: false, revision: 1, agent: kind, agentStatus: m.status });
  const agent = () => ({
    paneID: "pane",
    terminalID: "term",
    agent: kind,
    agentStatus: m.status,
    inputPending: m.inputPending,
    agentSession: { source: `herdr:${kind}`, agent: kind, kind: "id", value: "session" },
  });
  const backend = {
    prompt: async (paneId: string, text: string) => void m.writes.push(["prompt", paneId, text]),
    sendInput: async (paneId: string, text: string, keys: readonly string[]) => void m.writes.push(["input", paneId, text, keys]),
    sendText: async (paneId: string, text: string) => void m.writes.push(["text", paneId, text]),
    agentKeys: async (paneId: string, keys: readonly string[]) => void m.writes.push(["keys", paneId, keys]),
  };
  registerIpc({
    hosts: { backend: () => backend, pane, agent, run: () => ({ connection: 1, arrival: 1 }), fresh: async () => true, refresh: async () => undefined },
    modelCatalogs: {
      view: () => ({ agent: kind, models: m.catalog, readAt: 1, error: null, loading: false, none: null }),
      settled: async () => {
        m.checks += 1;
        return { agent: kind, models: m.catalog, readAt: 1, error: null, loading: false, none: null };
      },
    },
    ...(options.startScreen === true ? { startScreens: { shows: () => true } } : {}),
  } as never);
  const pickNow = registered.handles.get(IPC.modelPick)!;
  const sendNow = registered.handles.get(IPC.paneSend)!;
  pickHandler = (...args) => pickNow(event, "mini", "pane", ...args) as Promise<void>;
  sendHandler = (...args) => sendNow(event, "mini", "pane", ...args) as Promise<void>;
  return m;
}

/** A command line as the bound Send types it (send.ts: its characters, then its Return as a key). */
const typed = (text: string): unknown[][] => [
  ["text", "pane", text],
  ["keys", "pane", ["Enter"]],
];

describe("a listed pick: main makes the line and types it", () => {
  it("Codex: /model <slug> --reasoning=<level>, the level one of that model's own", async () => {
    const m = machine();
    await m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" });
    expect(m.writes).toEqual(typed("/model gpt-6-luna --reasoning=high"));
    expect(m.checks).toBe(1);
  });

  it("Codex with no effort named: the model's own default (gpt-6-luna: medium)", async () => {
    const m = machine();
    await m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: null });
    expect(m.writes).toEqual(typed("/model gpt-6-luna --reasoning=medium"));
  });

  it("Claude Code: /model <value> from its own list (and its default)", async () => {
    const claude = machine("claude");
    await claude.modelPick({ agent: "claude", model: "sonnet", effort: null }, bindingOf("claude"));
    await claude.modelPick({ agent: "claude", model: "default", effort: null }, bindingOf("claude"));
    expect(claude.writes).toEqual([...typed("/model sonnet"), ...typed("/model default")]);
  });
});

// A Cursor family's row is a pick (main types `/model <family name>`: livepick-main.test.ts). A pick naming
// another kind than the pane's is a bad request.
describe("a model pick on a Cursor pane", () => {
  it("a Claude Code or Codex pick on a Cursor pane is refused too (the binding's kind is not the pick's agent)", async () => {
    const cursor = machine("cursor");
    await expect(cursor.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" }, bindingOf("cursor"))).rejects.toThrow("bad request");
    await expect(cursor.modelPick({ agent: "claude", model: "sonnet", effort: null }, bindingOf("cursor"))).rejects.toThrow("bad request");
    expect(cursor.writes).toEqual([]);
  });

  it("Codex's and Claude Code's listed picks still write exactly their fixed commands", async () => {
    const codexPane = machine("codex");
    await codexPane.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" });
    expect(codexPane.writes).toEqual(typed("/model gpt-6-luna --reasoning=high"));
    const claude = machine("claude");
    await claude.modelPick({ agent: "claude", model: "sonnet", effort: null }, bindingOf("claude"));
    expect(claude.writes).toEqual(typed("/model sonnet"));
  });

  it("free-text Send of the same words is unchanged: written as typed, the list never read", async () => {
    const m = machine();
    await m.paneSend("/model gpt-6-luna --reasoning=high");
    expect(m.writes).toEqual(typed("/model gpt-6-luna --reasoning=high"));
    // Words the user types themselves are theirs; Send never checks them against a list.
    await m.paneSend("/model unlisted-model --reasoning=madeup");
    expect(m.writes.slice(2)).toEqual(typed("/model unlisted-model --reasoning=madeup"));
    expect(m.checks).toBe(0);
  });
});

describe("refused, nothing written", () => {
  it("a model not in the machine's list (the pattern fits)", async () => {
    const m = machine();
    await expect(m.modelPick({ agent: "codex", model: "unlisted-model", effort: "high" })).rejects.toThrow(
      "Not sent: that model is not in the agent's list on this machine.",
    );
    expect(m.writes).toEqual([]);
  });

  it("a model or effort failing the agent's pattern, a finished command, another agent's pane, or more arguments: a bad request, the list never read", async () => {
    const m = machine();
    for (const pick of [
      { agent: "codex", model: "gpt-6-luna; touch x", effort: "high" },
      { agent: "codex", model: "gpt-6-luna --reasoning=ultra", effort: null },
      { agent: "codex", model: "gpt-6-luna", effort: "high\r/quit" },
      { agent: "codex", model: "gpt-6-luna", effort: "high", command: "/model unlisted-model --reasoning=madeup" },
      { agent: "grok", model: "grok-4", effort: null },
      "/model gpt-6-luna --reasoning=high",
    ]) {
      await expect(m.modelPick(pick)).rejects.toThrow("bad request");
    }
    await expect(m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" }, bindingOf("claude"))).rejects.toThrow("bad request");
    await expect(m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" }, { ...codex, isAgent: false })).rejects.toThrow("bad request");
    await expect(m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" }, codex, "extra")).rejects.toThrow("bad request");
    expect(m.writes).toEqual([]);
    expect(m.checks).toBe(0);
  });

  it("an effort the model does not take (gpt-6-luna has no Ultra; a made-up one)", async () => {
    const m = machine();
    await expect(m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "ultra" })).rejects.toThrow("Not sent: that model does not take that effort.");
    await expect(m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "madeup" })).rejects.toThrow("Not sent: that model does not take that effort.");
    // Claude Code's and Cursor's levels never go with the model line.
    const claude = machine("claude");
    await expect(claude.modelPick({ agent: "claude", model: "sonnet", effort: "high" }, bindingOf("claude"))).rejects.toThrow(
      "Not sent: that model's effort is not set with its model here.",
    );
    expect(m.writes).toEqual([]);
    expect(claude.writes).toEqual([]);
  });

  it("a pick whose binding leaves out the at-prompt guard (or asks to queue): main adds it, so a working pane takes none", async () => {
    const m = machine();
    m.status = "working";
    await expect(m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" }, codex)).rejects.toThrow(notAtPromptText);
    await expect(m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" }, { ...codex, queuesWhileWorking: true })).rejects.toThrow(notAtPromptText);
    const claude = machine("claude");
    claude.status = "working";
    await expect(claude.modelPick({ agent: "claude", model: "sonnet", effort: null }, { ...bindingOf("claude"), queuesWhileWorking: true })).rejects.toThrow(notAtPromptText);
    expect(m.writes).toEqual([]);
    expect(claude.writes).toEqual([]);
    expect(pickBinding({ ...codex, queuesWhileWorking: true })).toEqual({ ...codex, atPromptOnly: true });
    // The same words as free text with that binding go as typed (the user's own line, typed while it works).
    await m.paneSend("/model gpt-6-luna --reasoning=high", codex);
    expect(m.writes).toEqual(typed("/model gpt-6-luna --reasoning=high"));
  });

  it("a pane showing Codex's start question (its hook review)", async () => {
    const m = machine("codex", { startScreen: true });
    await expect(m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" })).rejects.toThrow(startScreenTexts.notSent);
    expect(m.writes).toEqual([]);
  });

  it("a pane showing a dialog (the pane blocked, or the agent's menu pending): not at its prompt", async () => {
    const m = machine();
    m.status = "blocked";
    await expect(m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" })).rejects.toThrow(notAtPromptText);
    m.status = "idle";
    m.inputPending = true;
    await expect(m.modelPick({ agent: "codex", model: "gpt-6-luna", effort: "high" })).rejects.toThrow(notAtPromptText);
    expect(m.writes).toEqual([]);
  });
});

describe("a held pick is checked again by main when it goes", () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };
  const key = "mini/pane";
  const context = (status: "idle" | "working") => ({ hostId: "mini", paneId: "pane", agent: "codex" as const, status, binding: codex });

  /** The page's AgentPicks over main's real handlers. */
  function wired(m: Machine) {
    const notes: string[] = [];
    const picks = new AgentPicks({
      send: (_hostId, _paneId, text, binding) => m.paneSend(text, binding),
      modelPick: (_hostId, _paneId, pick, binding) => m.modelPick(pick, binding),
      copy: (text) => void notes.push(`copied ${text}`),
      now: () => 1,
    });
    picks.receive(key, { model: "gpt-6.1-sol", modelLabel: "gpt-6.1-sol", effort: "high", scope: { terminalID: "term", session: "session" } }, "t1");
    return { picks, notes };
  }

  it("its model gone from the list before it went: refused when it goes, nothing written, the chip says why", async () => {
    const m = machine();
    const { picks } = wired(m);
    m.status = "working";
    picks.pick(context("working"), modelPickRequest("codex", m.catalog, "gpt-6-luna", "high")!);
    await flush();
    expect(m.checks).toBe(0);
    expect(picks.chip(key, "model", codex)).toMatchObject({ label: "gpt-6-luna", next: true });
    // The machine's list read again without it (an update, or another login), then the turn ends.
    m.catalog = m.catalog.filter((model) => model.id !== "gpt-6-luna");
    m.status = "idle";
    picks.sync(key, context("idle"));
    await flush();
    expect(m.checks).toBe(1);
    expect(m.writes).toEqual([]);
    expect(picks.note(key)).toBe("Not set: that model is not in the agent's list on this machine.");
    expect(picks.chip(key, "model", codex).label).toBe("gpt-6.1-sol");
  });

  it("the page thought it idle but main finds it working: held again (main's at-prompt check), sent once at its prompt", async () => {
    const m = machine();
    const { picks } = wired(m);
    m.status = "working";
    picks.pick(context("idle"), modelPickRequest("codex", m.catalog, "gpt-6-luna", "high")!);
    await flush();
    expect(m.writes).toEqual([]);
    expect(picks.chip(key, "model", codex)).toMatchObject({ label: "gpt-6-luna", next: true });
    m.status = "idle";
    picks.sync(key, context("idle"));
    await flush();
    expect(m.writes).toEqual(typed("/model gpt-6-luna --reasoning=high"));
    expect(m.checks).toBe(2);
  });
});
