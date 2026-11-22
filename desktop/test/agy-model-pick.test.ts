// Antigravity CLI's model and level picked from Chat, through main's real handler (registerIpc), against a fake pane
// that behaves as the samples' model-switch-1.5.14.md says: with the box empty and idle, the text `/model <id>` and
// Return sets the model ("Model set to <label>" above the box) and the last row's right end changes to the new model
// and level; anything typed while a draft is in the box joins the draft. Its screens are the samples' idle screens
// (fixtures/agy-input). Exactly `/model <id>` typed and one Return, proved by the last row; nothing written over a
// draft, a command list, a question, a working turn or a failed read; a row that never changes: sent once, not
// confirmed. The same bytes as Tests/HerdrKitTests/AgyModelsTests.swift.

import { readFileSync } from "node:fs";
import path from "node:path";

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

const { registerIpc, agyConfirmReads } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");
const { agyBuiltIn, agySshSignInLine, parseCatalog } = await import("../src/shared/model-catalog");
const { notAtPromptText } = await import("../src/shared/send-binding");
const { typedCommandLeftText } = await import("../src/main/herdr/send");
const { agyRowId, liveModelPick, modelPickCommand } = await import("../src/shared/model-choices");

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
const fixture = (name: string): string => readFileSync(path.join(__dirname, "..", "fixtures", "agy", name), "utf8");
const idle = (name: string): string => readFileSync(path.join(__dirname, "fixtures", "agy-input", `${name}.txt`), "utf8");

function sampleList(): CatalogModel[] {
  const parsed = parseCatalog("agy", fixture("models-1.5.14.txt"));
  if (!parsed.ok) throw new Error(parsed.reason);
  return [...parsed.models];
}

const bindingOf = (): SendBinding => ({ terminalID: "term", isAgent: true, kind: "agy", session: "session", run: { connection: 1, arrival: 1 } });

/** A last row: its left part at the edge, its right end at the screen's right edge (the samples' 119 cells). */
function lastRow(left: string, right: string): string {
  return left + " ".repeat(Math.max(2, 119 - left.length - right.length)) + right;
}

interface Pane {
  readonly writes: unknown[][];
  readonly submitted: string[];
  catalog: CatalogModel[];
  /** The machine's list as main holds it (null: `catalog`, read); the built-in one over SSH. */
  list: { readonly models: readonly CatalogModel[]; readonly readAt: number | null; readonly error: string | null } | null;
  status: string;
  inputPending: boolean;
  /** What the box holds (the app's typing and the user's). */
  draft: string;
  /** The last row's right end: mode word (or none), model, level. */
  mode: string | null;
  model: string;
  level: string | null;
  /** The screen read instead of the drawn one while set (a question, a working turn). */
  shown: string | null;
  /** Reads fail. */
  failing: boolean;
  /** Return does not change the model (its row stays). */
  deaf: boolean;
  /** A row whose bracket is no level drawn as its whole label (no level word); else its bracket as the level. */
  drawsLabel: boolean;
  /** Text that joins whatever the app types (the user typing at the same time). */
  joins: string;
  /** Lines above the box ("Model set to …"). */
  readonly above: string[];
  reads: number;
  /** Runs at the Send's own read of the idle pane (send.ts's last read before the text). */
  sendReadHook: (() => void) | null;
  /** Each write (text, keys, a prompt) waits for this first while set. */
  writeGate: Promise<void> | null;
  pick(pick: unknown): Promise<unknown>;
  /** An ordinary Send from Chat, through the same handlers. */
  send(text: string): Promise<unknown>;
}

function pane(): Pane {
  registered.handles.clear();
  const p: Pane = {
    writes: [],
    submitted: [],
    catalog: sampleList(),
    list: null,
    status: "idle",
    inputPending: false,
    draft: "",
    mode: "auto",
    model: "Gemini 4 Hydrogen",
    level: "low",
    shown: null,
    failing: false,
    deaf: false,
    joins: "",
    drawsLabel: false,
    above: [],
    reads: 0,
    sendReadHook: null,
    writeGate: null,
    pick: async () => undefined,
    send: async () => undefined,
  };
  const gate = async (): Promise<void> => {
    if (p.writeGate !== null) await p.writeGate;
  };
  const screen = (): string => {
    if (p.failing) throw new Error("pane.read failed");
    if (p.shown !== null) return p.shown;
    // idle-after-reply.txt: the box `>` alone between two rules, "? for shortcuts" and the mode line under it.
    const rows = idle("idle-after-reply").replace(/\n+$/u, "").split("\n");
    const right = [p.mode, p.model, p.level].filter((part) => part !== null).join(" · ");
    rows[rows.length - 1] = lastRow(p.draft === "" ? "? for shortcuts" : "", right);
    if (p.draft !== "") {
      const [head, ...more] = p.draft.split("\n");
      rows.splice(rows.length - 3, 1, `> ${head}`, ...more.map((line) => `  ${line}`));
    }
    rows.splice(rows.length - 4, 0, ...p.above);
    return `${rows.join("\n")}\n`;
  };
  const enter = (): void => {
    p.submitted.push(p.draft);
    const typed = /^\/model (\S+)$/u.exec(p.draft);
    p.draft = "";
    if (typed === null) return;
    const row = p.catalog.find((model) => model.id === typed[1]);
    if (row === undefined) return;
    p.above.push("> /model", `  ⎿  Model set to ${row.label}`, "");
    if (p.deaf) return;
    const named = /^(.*\S)\s*\(([A-Za-z]+)\)$/u.exec(row.label);
    if (p.drawsLabel && named !== null && !["low", "medium", "high", "xhigh", "max"].includes(named[2]!.toLowerCase())) {
      p.model = row.label;
      p.level = null;
      return;
    }
    p.model = named === null ? row.label : named[1]!;
    p.level = named === null ? null : named[2]!.toLowerCase();
  };
  const paneInfo = () => ({ paneID: "pane", terminalID: "term", workspaceID: "w1", tabID: "t1", focused: false, revision: 1, agent: "agy", agentStatus: p.status });
  const agentInfo = () => ({
    paneID: "pane",
    terminalID: "term",
    agent: "agy",
    agentStatus: p.status,
    inputPending: p.inputPending,
    agentSession: { source: "herdr:agy", agent: "agy", kind: "id", value: "session" },
  });
  const backend = {
    prompt: async (_paneId: string, text: string) => {
      await gate();
      p.writes.push(["prompt", text]);
    },
    sendInput: async (_paneId: string, text: string, keys: readonly string[]) => {
      await gate();
      p.writes.push(["input", text, keys]);
    },
    sendText: async (_paneId: string, text: string) => {
      await gate();
      p.writes.push(["text", text]);
      p.draft += text + p.joins;
    },
    agentKeys: async (_paneId: string, keys: readonly string[]) => {
      await gate();
      p.writes.push(["keys", keys]);
      if (keys.includes("Enter")) enter();
    },
    promptIO: () => ({
      paneRead: async () => {
        p.reads += 1;
        return screen();
      },
      paneSendKeys: async (_paneId: string, keys: readonly string[]) => {
        p.writes.push(["keys", keys]);
        if (keys.includes("Enter")) enter();
      },
    }),
  };
  const view = () => ({ agent: "agy", models: p.list?.models ?? p.catalog, readAt: p.list === null ? 1 : p.list.readAt, error: p.list?.error ?? null, loading: false, none: null });
  registerIpc({
    hosts: { backend: () => backend, pane: paneInfo, agent: agentInfo, run: () => ({ connection: 1, arrival: 1 }), fresh: async () => true, refresh: async () => undefined },
    chat: { grokFiles: async () => undefined },
    paneInputs: { generation: () => 0 },
    // The Send's own read of an idle agy pane (the shared gate: agyInputClear) right before the text.
    prompts: {
      sendRead: async () => {
        p.sendReadHook?.();
        return screen();
      },
    },
    pickSettleMs: 0,
    modelCatalogs: { view, settled: async () => view(), afterReading: async () => view() },
  } as never);
  const pickNow = registered.handles.get(IPC.modelPick)!;
  p.pick = (pick) => pickNow(event, "mini", "pane", pick, bindingOf()) as Promise<unknown>;
  p.send = (text) => registered.handles.get(IPC.paneSend)!(event, "mini", "pane", text, bindingOf()) as Promise<unknown>;
  return p;
}

const typed = (text: string): unknown[][] => [
  ["text", text],
  ["keys", ["Enter"]],
];

describe("Antigravity CLI: /model <id> made in main from the machine's list", () => {
  it("a model: exactly `/model <id>` typed and one Return; the last row naming it proves it", async () => {
    const p = pane();
    const outcome = await p.pick({ agent: "agy", model: "gemini-3.8-flash-low", effort: null });
    expect(p.writes).toEqual(typed("/model gemini-3.8-flash-low"));
    expect(p.submitted).toEqual(["/model gemini-3.8-flash-low"]);
    expect(outcome).toEqual({ type: "agy", confirmed: true, row: { mode: "auto", model: "Gemini 3.8 Flash", level: "low" } });
  });

  it("Gemini 4 Neon's levels: each level is its own row's id, the same command", async () => {
    for (const [id, level] of [
      ["gemini-4-neon-high", "high"],
      ["gemini-4-neon-xhigh", "xhigh"],
      ["gemini-4-neon-medium", "medium"],
      ["gemini-4-neon-low", "low"],
    ] as const) {
      const p = pane();
      const outcome = await p.pick({ agent: "agy", model: id, effort: null });
      expect(p.writes).toEqual(typed(`/model ${id}`));
      expect(outcome).toMatchObject({ confirmed: true, row: { model: "Gemini 4 Neon", level } });
    }
  });

  it("a model with no level (Orchestrator (Neon)): proved by its whole label, drawn either way", async () => {
    // How agy 1.5.14 draws a row whose bracket is no level was not seen live: its bracket as a level word, or its label.
    const asLevel = pane();
    const one = await asLevel.pick({ agent: "agy", model: "gemini-pro-orchestrator-neon", effort: null });
    expect(asLevel.writes).toEqual(typed("/model gemini-pro-orchestrator-neon"));
    expect(one).toEqual({ type: "agy", confirmed: true, row: { mode: "auto", model: "Orchestrator", level: "neon" } });
    const asLabel = pane();
    asLabel.drawsLabel = true;
    const two = await asLabel.pick({ agent: "agy", model: "gemini-pro-orchestrator-neon", effort: null });
    expect(two).toEqual({ type: "agy", confirmed: true, row: { mode: "auto", model: "Orchestrator (Neon)", level: null } });
  });

  it("the other Orchestrator still on its last row: not confirmed", async () => {
    const p = pane();
    p.deaf = true;
    p.model = "Orchestrator";
    p.level = "neon";
    const outcome = await p.pick({ agent: "agy", model: "gemini-pro-orchestrator-g1-pro", effort: null });
    expect(p.writes).toEqual(typed("/model gemini-pro-orchestrator-g1-pro"));
    expect(outcome).toMatchObject({ confirmed: false });
  });

  it("the mode that asks (no mode word): the same pick, proved the same way", async () => {
    const p = pane();
    p.mode = null;
    const outcome = await p.pick({ agent: "agy", model: "gemini-4-argon-high", effort: null });
    expect(p.writes).toEqual(typed("/model gemini-4-argon-high"));
    expect(outcome).toEqual({ type: "agy", confirmed: true, row: { mode: "default", model: "Gemini 4 Argon", level: "high" } });
  });

  it("a row that never changes: sent once, not confirmed, nothing typed again or cleared", async () => {
    const p = pane();
    p.deaf = true;
    const outcome = await p.pick({ agent: "agy", model: "gemini-4-neon-high", effort: null });
    expect(p.writes).toEqual(typed("/model gemini-4-neon-high"));
    expect(outcome).toEqual({ type: "agy", confirmed: false, row: { mode: "auto", model: "Gemini 4 Hydrogen", level: "low" } });
    // At most agyConfirmReads reads after the Return.
    expect(agyConfirmReads).toBeGreaterThan(0);
  });

  it("an id not on the machine's list, an effort sent with it, a bad id: nothing written", async () => {
    const p = pane();
    await expect(p.pick({ agent: "agy", model: "gemini-9-ultra", effort: null })).rejects.toThrow("Not sent: that model is not in the agent's list on this machine.");
    await expect(p.pick({ agent: "agy", model: "gemini-4-neon-high", effort: "high" })).rejects.toThrow("Not sent:");
    await expect(p.pick({ agent: "agy", model: "gemini 4", effort: null })).rejects.toThrow("bad request");
    await expect(p.pick({ agent: "agy", model: "gemini-4-neon-high;x", effort: null })).rejects.toThrow("bad request");
    expect(p.writes).toEqual([]);
  });
});

// The machine's list could not be read over SSH (its sign-in is in the keychain): the chips' picks go
// from the built-in list exactly as from a read one.
describe("Antigravity CLI over its built-in list", () => {
  const builtIn = { models: agyBuiltIn, readAt: null, error: agySshSignInLine };

  it("the Model menu's pick: exactly `/model <id>` and one Return, confirmed from the last row", async () => {
    const p = pane();
    p.list = builtIn;
    const outcome = await p.pick({ agent: "agy", model: "gemini-4-neon-high", effort: null });
    expect(p.writes).toEqual(typed("/model gemini-4-neon-high"));
    expect(outcome).toEqual({ type: "agy", confirmed: true, row: { mode: "auto", model: "Gemini 4 Neon", level: "high" } });
  });

  it("the Effort menu's level: its own row's id from the built-in list, the same command", async () => {
    const p = pane();
    p.list = builtIn;
    const pick = liveModelPick("agy", agyBuiltIn, "gemini-4-neon-high", "xhigh");
    expect(pick).toEqual({ agent: "agy", model: "gemini-4-neon-xhigh", effort: null });
    const outcome = await p.pick(pick);
    expect(p.writes).toEqual(typed("/model gemini-4-neon-xhigh"));
    expect(outcome).toMatchObject({ confirmed: true, row: { model: "Gemini 4 Neon", level: "xhigh" } });
  });

  it("an id the built-in list holds that the CLI does not know: typed once, not confirmed, as with a read list", async () => {
    const p = pane();
    p.list = builtIn;
    // The machine's CLI lists no Gemini 4 Argon now (it does not take the id; its row stays).
    p.catalog = sampleList().filter((model) => !model.id.startsWith("gemini-4-argon"));
    const outcome = await p.pick({ agent: "agy", model: "gemini-4-argon-high", effort: null });
    expect(p.writes).toEqual(typed("/model gemini-4-argon-high"));
    expect(outcome).toEqual({ type: "agy", confirmed: false, row: { mode: "auto", model: "Gemini 4 Hydrogen", level: "low" } });
  });

  it("an id not on the built-in list: nothing written, said as with a read list", async () => {
    const p = pane();
    p.list = builtIn;
    await expect(p.pick({ agent: "agy", model: "gemini-9-ultra", effort: null })).rejects.toThrow("Not sent: that model is not in the agent's list on this machine.");
    expect(p.writes).toEqual([]);
  });
});

describe("Antigravity CLI: nothing written unless a fresh read shows the box empty and idle", () => {
  const pick = { agent: "agy", model: "gemini-4-neon-high", effort: null };

  it("a draft in the box (idle-typed, idle-two-lines, the drawn draft): nothing written", async () => {
    for (const name of ["idle-typed", "idle-two-lines"]) {
      const p = pane();
      p.shown = idle(name);
      await expect(p.pick(pick)).rejects.toThrow("Not sent: Antigravity CLI's box has text in it. Send or clear it, then pick again.");
      expect(p.writes).toEqual([]);
    }
    const drawn = pane();
    drawn.draft = "half a thought";
    await expect(drawn.pick(pick)).rejects.toThrow("Not sent: Antigravity CLI's box has text in it. Send or clear it, then pick again.");
    expect(drawn.writes).toEqual([]);
    expect(drawn.draft).toBe("half a thought");
  });

  it("a working turn (esc to cancel on its last row), a command list, a question, a failed read: nothing written", async () => {
    const working = pane();
    working.shown = idle("working");
    const list = pane();
    // `/` typed by the user: its command list under the box, "esc to cancel" on the last row (model-switch-1.5.14.md).
    const rows = idle("idle-after-reply").replace(/\n+$/u, "").split("\n");
    rows.splice(rows.length - 3, 1, "> /");
    rows.splice(rows.length - 1, 1, "> /add-dir  Add a directory to the workspace", "↓ 46 more", "↑/↓ Navigate · enter Select · tab Complete", lastRow("esc to cancel", "auto · Gemini 4 Hydrogen · low"));
    list.shown = rows.join("\n");
    const question = pane();
    question.shown = readFileSync(path.join(__dirname, "fixtures", "antigravity", "create-file-ask.txt"), "utf8");
    const failed = pane();
    failed.failing = true;
    await expect(working.pick(pick)).rejects.toThrow("Not sent: Antigravity CLI's box is not on its screen now (a dialog or a list). Check its terminal.");
    await expect(list.pick(pick)).rejects.toThrow("Not sent: Antigravity CLI's box is not on its screen now (a dialog or a list). Check its terminal.");
    await expect(question.pick(pick)).rejects.toThrow("Not sent: Antigravity CLI's box is not on its screen now (a dialog or a list). Check its terminal.");
    await expect(failed.pick(pick)).rejects.toThrow("Not sent: the pane did not answer. Check its terminal.");
    for (const p of [working, list, question, failed]) expect(p.writes).toEqual([]);
  });

  it("Herdr saying it works or waits on a question: nothing written", async () => {
    const working = pane();
    working.status = "working";
    const asking = pane();
    asking.inputPending = true;
    // Held for the next turn or refused: either way nothing goes now.
    await expect(asking.pick(pick)).rejects.toThrow(notAtPromptText);
    await working.pick(pick).catch(() => undefined);
    expect(working.writes).toEqual([]);
    expect(asking.writes).toEqual([]);
  });

  it("a draft that comes between the pick's own read and the send's last read: nothing written at all", async () => {
    const p = pane();
    // The pick's ready read saw the box empty; the person types before the send's own read right before the text.
    p.sendReadHook = () => {
      p.draft = "a person's draft";
    };
    await expect(p.pick(pick)).rejects.toThrow("Not sent: Antigravity CLI's box has text in it. Send or clear it, then pick again.");
    expect(p.writes).toEqual([]);
    expect(p.draft).toBe("a person's draft");
    expect(p.submitted).toEqual([]);
  });

  it("an ordinary Send still goes with the box empty, and the send's own read is unchanged for it", async () => {
    const p = pane();
    await p.send("hello there");
    expect(p.writes.length).toBeGreaterThan(0);
    expect(JSON.stringify(p.writes)).toContain("hello there");
  });

  it("the box not showing exactly the command before Return (the user's text joined to it): no Return, the line says it is still in the box", async () => {
    const p = pane();
    p.joins = " and more";
    await expect(p.pick(pick)).rejects.toThrow(typedCommandLeftText("Antigravity CLI", "/model gemini-4-neon-high", false));
    expect(p.writes).toEqual([["text", "/model gemini-4-neon-high"]]);
    expect(p.submitted).toEqual([]);
  });
});

describe("Antigravity CLI: the pick's command and its proof (shared)", () => {
  const models = sampleList();

  it("the command is `/model <id>` for a listed row only; never an effort", () => {
    expect(modelPickCommand({ agent: "agy", model: "gemini-4-neon-xhigh", effort: null }, models)).toEqual({ ok: true, command: "/model gemini-4-neon-xhigh" });
    expect(modelPickCommand({ agent: "agy", model: "gemini-4-neon", effort: null }, models).ok).toBe(false);
    expect(modelPickCommand({ agent: "agy", model: "gemini-4-neon-high", effort: "high" }, models).ok).toBe(false);
  });

  it("a family picked keeps the level it runs at when it has it, its first listed level otherwise", () => {
    // Running Gemini 4 Hydrogen at low; Gemini 4 Neon picked: Neon's low row.
    expect(liveModelPick("agy", models, "gemini-4-neon-high", "low")).toEqual({ agent: "agy", model: "gemini-4-neon-low", effort: null });
    // Running a level Argon does not have (xhigh): Argon's first listed level (medium).
    expect(liveModelPick("agy", models, "gemini-4-argon-medium", "xhigh")).toEqual({ agent: "agy", model: "gemini-4-argon-medium", effort: null });
    // A model with no levels.
    expect(liveModelPick("agy", models, "gemini-pro-orchestrator-neon", "low")).toEqual({ agent: "agy", model: "gemini-pro-orchestrator-neon", effort: null });
    expect(agyRowId(models, "gemini-4-neon-high", "max")).toBeNull();
  });
});

describe("Antigravity CLI: a Send and a pick on one pane never interleave", () => {
  const pick = { agent: "agy", model: "gemini-4-neon-high", effort: null };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("a Send while the pick's text write is held: the pick's text and its Return first, then the message", async () => {
    const p = pane();
    let release!: () => void;
    p.writeGate = new Promise((resolve) => (release = resolve));
    const picked = p.pick(pick);
    await settle();
    const sent = p.send("hello there");
    await settle();
    // Nothing written yet: the pick's text waits on the gate, the Send waits for the pane's turn.
    expect(p.writes).toEqual([]);
    p.writeGate = null;
    release();
    await picked;
    await sent;
    const order = p.writes.map((write) => JSON.stringify(write));
    const message = order.findIndex((write) => write.includes("hello there"));
    expect(order.slice(0, 2)).toEqual([JSON.stringify(["text", "/model gemini-4-neon-high"]), JSON.stringify(["keys", ["Enter"]])]);
    expect(message).toBeGreaterThanOrEqual(2);
    expect(p.submitted[0]).toBe("/model gemini-4-neon-high");
  });

  it("a pick while a Send's write is held: the message first, the pick's text and its Return after it", async () => {
    const p = pane();
    let release!: () => void;
    p.writeGate = new Promise((resolve) => (release = resolve));
    const sent = p.send("hello there");
    await settle();
    const picked = p.pick(pick).catch((error: unknown) => error);
    await settle();
    expect(p.writes).toEqual([]);
    p.writeGate = null;
    release();
    await sent;
    await picked;
    const order = p.writes.map((write) => JSON.stringify(write));
    const message = order.findIndex((write) => write.includes("hello there"));
    const command = order.indexOf(JSON.stringify(["text", "/model gemini-4-neon-high"]));
    expect(message).toBe(0);
    expect(command).toBeGreaterThan(message);
    expect(order[command + 1]).toBe(JSON.stringify(["keys", ["Enter"]]));
  });
});
