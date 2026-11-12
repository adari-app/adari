// Typed model picks through main's real handlers (registerIpc) with fake hosts whose screens are the recorded
// frames in fixtures/livepick:
// - Grok Build: a listed id writes exactly `/model <id>` and its Return (typed, never pasted), once its box reads
//   empty; an unlisted id, an id with a space or a quote, and a pick for a kind that has none write nothing.
// - Cursor Agent: a plain family writes `/model <family>` and its Return; a family inside another's writes nothing;
//   the model line read after it is the answer, and the page says "Cursor chose …" when it names another family
//   (nothing retried).
// - OpenCode: IPC.openCodePick by its id only; main makes every key from the machine's list.
// The same guards for all: start screens, dialogs, the pane's binding, the send turn.

import { describe, expect, it, vi } from "vitest";

import type { CatalogModel } from "../src/shared/model-catalog";
import type { SendBinding } from "../src/shared/send-binding";
import { cursorTypedScreen, FakeOpenCode, frame, frameModels, type CursorListDraw } from "./support/livepick-frames";

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
const { parseCatalog } = await import("../src/shared/model-catalog");
const { demoModelLists } = await import("../src/main/demo/demo-model-lists");
const { notAtPromptText } = await import("../src/shared/send-binding");
const { startScreenTexts } = await import("../src/shared/prompt/start-screen");
const { AgentPicks, cursorChoseText, openCodeIdleText, pickStillGoingText } = await import("../src/renderer/components/agent-picks");
const { modelPickRequest } = await import("../src/renderer/components/AgentChips");
const { openCodePickTexts } = await import("../src/main/herdr/opencode-pick");
const { typedCommandChangedText, typedCommandLeftText, typedReadBackReads } = await import("../src/main/herdr/send");
const { cursorTypedRead, grokTypedRead } = await import("../src/shared/agent-settings");

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

type Kind = "grok" | "cursor" | "opencode";

function listOf(kind: Kind): CatalogModel[] {
  const text = kind === "opencode" ? frame("opencode-models-verbose-first3") + glmVerbose : demoModelLists[kind];
  const parsed = parseCatalog(kind, text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return [...parsed.models];
}

/** GLM-5.3-Flash Free as `--verbose` prints it (no variants, as OpenCode 1.18.21 showed it). */
const glmVerbose = `opencode/glm-5.3-flash-free\n${JSON.stringify({ id: "glm-5.3-flash-free", providerID: "opencode", name: "GLM-5.3-Flash Free", options: { apiKey: "never-kept" }, variants: {} }, null, 2)}\n`;

const bindingOf = (kind: string): SendBinding => ({ terminalID: "term", isAgent: true, kind, session: "session", run: { connection: 1, arrival: 1 } });

interface Machine {
  /** Every write to the pane: ["text", text] or ["keys", keys]. */
  readonly writes: unknown[][];
  catalog: CatalogModel[];
  checks: number;
  status: string;
  inputPending: boolean;
  /** The pane's screen before the pick's Return, and after it. */
  before: string;
  after: string;
  /** How often Grok's files were read again. */
  grokFiles: number;
  /** What the agent's box holds (the app's typing and the user's), drawn into `before` until a Return. */
  draft: string;
  /** The user's Terminal input so far (PaneInputs' generation). */
  input: number;
  /**
   * The user's typing in the Terminal while the pick runs: at the read that finds the box empty
   * ("ready": `text` goes into the box first, that read still shows it empty), or at the read after the command was
   * typed ("readBack": `text` joins the command). Each bumps `input`.
   */
  race: { readonly at: "ready" | "readBack"; readonly text: string; readonly quiet?: boolean } | null;
  /** Every string a Return sent (the box's text when Return went). */
  readonly submitted: string[];
  /** Cursor's own list under a typed `/model <words>` (cursor-live-01): as Cursor draws it unless set. */
  cursorList: CursorListDraw;
  /**
   * The list main holds while a read of it is under way (`settled` answers it, loading); the
   * read's own (`catalog`) comes from `afterReading`. Null: no read under way.
   */
  heldWhileReading: CatalogModel[] | null;
  /** How often main waited for a read under way. */
  waitedForRead: number;
  /** A live frame shown verbatim once the app's typing is in the box (cursor-live-01, -03), until its Return. */
  typedFrame: string | null;
  /**
   * The agent still drawing what was typed: the screen of the `n`th read since the app's
   * typing went into the box (1 the first), until its Return. Null: drawn at once.
   */
  drawing: ((n: number, draft: string) => string) | null;
  /** Reads since the app's typing went into the box. */
  typedReads: number;
  /** The fake OpenCode the pane runs (its screen and keys), for an OpenCode machine. */
  readonly openCode: FakeOpenCode | null;
  modelPick(pick: unknown, binding?: unknown): Promise<unknown>;
  openCodePick(model: unknown, binding?: unknown): Promise<unknown>;
}

function machine(kind: Kind, options: { startScreen?: boolean } = {}): Machine {
  registered.handles.clear();
  const openCode = kind === "opencode" ? new FakeOpenCode(frameModels, "Beam Free OpenCode") : null;
  let returned = false;
  const m: Machine = {
    writes: [],
    catalog: listOf(kind),
    checks: 0,
    status: "idle",
    inputPending: false,
    before: kind === "grok" ? frame("grok-04-restored") : frame("cursor-05-after-esc"),
    after: kind === "grok" ? frame("grok-03-after-enter") : frame("cursor-06-model-words-enter"),
    grokFiles: 0,
    draft: "",
    input: 0,
    race: null,
    submitted: [],
    cursorList: {},
    heldWhileReading: null,
    waitedForRead: 0,
    typedFrame: null,
    drawing: null,
    typedReads: 0,
    openCode,
    modelPick: async () => undefined,
    openCodePick: async () => undefined,
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
    prompt: async (_paneId: string, text: string) => void m.writes.push(["prompt", text]),
    sendInput: async (_paneId: string, text: string, keys: readonly string[]) => void m.writes.push(["input", text, keys]),
    sendText: async (_paneId: string, text: string) => {
      m.writes.push(["text", text]);
      m.draft += text;
      openCode?.type(text);
    },
    agentKeys: async (_paneId: string, keys: readonly string[]) => {
      m.writes.push(["keys", keys]);
      if (keys.includes("Enter")) {
        m.submitted.push(m.draft);
        m.draft = "";
        returned = true;
      }
    },
    promptIO: () => ({
      paneRead: async () => {
        if (openCode !== null) return openCode.screen();
        if (returned) return m.after;
        if (m.draft !== "") m.typedReads += 1;
        if (m.drawing !== null && m.draft !== "") return m.drawing(m.typedReads, m.draft);
        if (m.typedFrame !== null && m.draft !== "") return m.typedFrame;
        // The user's typing: the read that finds the box empty still shows it so (it raced the read).
        if (m.race?.at === "ready" && m.draft === "") {
          const shown = withDraft(kind, m.before, "");
          m.draft = m.race.text;
          m.input += 1;
          return shown;
        }
        if (m.race?.at === "readBack" && m.draft !== "" && !m.draft.endsWith(m.race.text)) {
          m.draft += m.race.text;
          if (m.race.quiet !== true) m.input += 1;
        }
        return withDraft(kind, m.before, m.draft, m.cursorList);
      },
      paneSendKeys: async (_paneId: string, keys: readonly string[]) => {
        m.writes.push(["keys", keys]);
        openCode?.keys(keys);
      },
    }),
  };
  registerIpc({
    hosts: { backend: () => backend, pane, agent, run: () => ({ connection: 1, arrival: 1 }), fresh: async () => true, refresh: async () => undefined },
    chat: { grokFiles: async () => void (m.grokFiles += 1) },
    paneInputs: { generation: () => m.input },
    pickSettleMs: 0,
    modelCatalogs: {
      view: () => ({ agent: kind, models: m.catalog, readAt: 1, error: null, loading: false, none: null }),
      settled: async () => {
        m.checks += 1;
        if (m.heldWhileReading !== null) return { agent: kind, models: m.heldWhileReading, readAt: 1, error: null, loading: true, none: null };
        return { agent: kind, models: m.catalog, readAt: 1, error: null, loading: false, none: null };
      },
      afterReading: async () => {
        m.waitedForRead += 1;
        m.heldWhileReading = null;
        return { agent: kind, models: m.catalog, readAt: 2, error: null, loading: false, none: null };
      },
    },
    ...(options.startScreen === true ? { startScreens: { shows: () => true } } : {}),
  } as never);
  const pickNow = registered.handles.get(IPC.modelPick)!;
  const openNow = registered.handles.get(IPC.openCodePick)!;
  m.modelPick = (pick, binding = bindingOf(kind)) => pickNow(event, "mini", "pane", pick, binding) as Promise<unknown>;
  m.openCodePick = (model, binding = bindingOf(kind)) => openNow(event, "mini", "pane", model, binding) as Promise<unknown>;
  return m;
}

/**
 * The agent's box in `screen` holding `draft` (its frame's row redrawn; "" leaves the frame as it is): Grok's
 * `│ ❯ … │` row (grok-02 is the frame with `/model grok-4.6` typed), Cursor's `→ …` row (its placeholder in cursor-05).
 */
function withDraft(kind: Kind, screen: string, draft: string, list: CursorListDraw = {}): string {
  if (draft === "") return screen;
  if (kind === "grok") {
    return screen.replace(/\u{2502} \u{276F} [^\n]*\u{2502}/u, (row) => {
      const inner = row.length - 4;
      return `\u{2502} \u{276F} ${draft.padEnd(inner - 1)}\u{2502}`;
    });
  }
  // Cursor 2026.11.11 draws its own list under a typed `/model <words>` (cursor-live-01).
  return cursorTypedScreen(screen, draft, list);
}

/** A command typed as characters, then its Return as a key. */
const typed = (text: string): unknown[][] => [
  ["text", text],
  ["keys", ["Enter"]],
];

describe("Grok Build: /model <id> made in main", () => {
  it("a listed id writes exactly /model <id> and its Return (typed, not pasted); its files are read again", async () => {
    const grok = machine("grok");
    expect(grok.catalog.map((model) => model.id)).toContain("grok-4.6");
    await grok.modelPick({ agent: "grok", model: "grok-4.6", effort: null });
    expect(grok.writes).toEqual(typed("/model grok-4.6"));
    expect(grok.checks).toBe(1);
    expect(grok.grokFiles).toBe(1);
  });

  it("an unlisted id: refused, nothing written", async () => {
    const grok = machine("grok");
    await expect(grok.modelPick({ agent: "grok", model: "grok-9", effort: null })).rejects.toThrow("Not sent: that model is not in the agent's list on this machine.");
    expect(grok.writes).toEqual([]);
  });

  it("an id with a space or a quote, an effort with it, a kind with no live pick, another kind's pane: a bad request, the list never read", async () => {
    const grok = machine("grok");
    for (const pick of [
      { agent: "grok", model: "grok 4.6", effort: null },
      { agent: "grok", model: "grok-4.6'", effort: null },
      { agent: "grok", model: 'grok-4.6"', effort: null },
      { agent: "grok", model: "grok-4.6\r/quit", effort: null },
      { agent: "opencode", model: "opencode/beam-free", effort: null },
      { agent: "agy", model: "gemini-4", effort: null },
      { agent: "gemini", model: "gemini-4", effort: null },
    ]) {
      await expect(grok.modelPick(pick)).rejects.toThrow("bad request");
    }
    await expect(grok.modelPick({ agent: "cursor", model: "auto", effort: null })).rejects.toThrow("bad request");
    const open = machine("opencode");
    await expect(open.modelPick({ agent: "opencode", model: "opencode/beam-free", effort: null })).rejects.toThrow("bad request");
    expect(grok.writes).toEqual([]);
    expect(open.writes).toEqual([]);
    expect(grok.checks + open.checks).toBe(0);
    // Its effort is the Effort chip's, never sent with the model.
    await expect(grok.modelPick({ agent: "grok", model: "grok-4.6", effort: "high" })).rejects.toThrow("Not sent: that model's effort is not set with its model here.");
    expect(grok.writes).toEqual([]);
  });

  it("the same guards: a draft in Grok's box (grok-02), a start screen, a dialog, working: nothing written", async () => {
    const drafted = machine("grok");
    drafted.before = frame("grok-02-typed-model-id");
    await expect(drafted.modelPick({ agent: "grok", model: "grok-4.6", effort: null })).rejects.toThrow("Not sent: Grok's box has text in it. Send or clear it, then pick again.");
    const started = machine("grok", { startScreen: true });
    await expect(started.modelPick({ agent: "grok", model: "grok-4.6", effort: null })).rejects.toThrow(startScreenTexts.notSent);
    const asking = machine("grok");
    asking.inputPending = true;
    await expect(asking.modelPick({ agent: "grok", model: "grok-4.6", effort: null })).rejects.toThrow(notAtPromptText);
    const working = machine("grok");
    working.status = "working";
    await expect(working.modelPick({ agent: "grok", model: "grok-4.6", effort: null })).rejects.toThrow(notAtPromptText);
    const listOpen = machine("grok");
    // No Grok box on the screen (another screen stands in: a list over the box).
    listOpen.before = frame("cursor-02-list-open");
    await expect(listOpen.modelPick({ agent: "grok", model: "grok-4.6", effort: null })).rejects.toThrow("Not sent: Grok's box is not on its screen now (a dialog or a list). Check its terminal.");
    for (const m of [drafted, started, asking, working, listOpen]) expect(m.writes).toEqual([]);
  });
});

describe("Cursor Agent: /model <family> made in main", () => {
  it("a plain family writes /model <family> and its Return; the model line read after it is the answer (cursor-06)", async () => {
    const cursor = machine("cursor");
    const outcome = await cursor.modelPick({ agent: "cursor", model: "composer-2.5", effort: null });
    expect(cursor.writes).toEqual(typed("/model Composer 2.5"));
    expect(outcome).toEqual({ type: "cursor", modelLine: "Composer 2.5 Fast", footer: null });
  });

  it("a family inside another's writes nothing (Cursor would take Claude Opus 5.5: cursor-08)", async () => {
    const cursor = machine("cursor");
    expect(cursor.catalog.some((model) => model.id === "claude-opus-5-high")).toBe(true);
    await expect(cursor.modelPick({ agent: "cursor", model: "claude-opus-5-high", effort: null })).rejects.toThrow(
      "Not sent: Claude Opus 5 is chosen in Cursor's own list (its name is inside another family's).",
    );
    expect(cursor.writes).toEqual([]);
  });

  it("Cursor's list open, or its box holding text: nothing written", async () => {
    const open = machine("cursor");
    open.before = frame("cursor-02-list-open");
    await expect(open.modelPick({ agent: "cursor", model: "composer-2.5", effort: null })).rejects.toThrow("Not sent: Cursor's box is not on its screen now");
    expect(open.writes).toEqual([]);
  });

  it("the footer naming another family: the page says \"Cursor chose …\" and nothing is retried", async () => {
    const cursor = machine("cursor");
    cursor.after = frame("cursor-08-two-matches");
    const sent: unknown[] = [];
    const picks = new AgentPicks({
      send: async () => undefined,
      modelPick: (_hostId, _paneId, pick, binding) => {
        sent.push(pick);
        return cursor.modelPick(pick, binding) as never;
      },
      copy: () => undefined,
      now: () => 1,
    });
    const binding = bindingOf("cursor");
    const request = modelPickRequest("cursor", cursor.catalog, "grok-4.7-high", null)!;
    expect(request.label).toBe("Grok 4.7");
    picks.pick({ hostId: "mini", paneId: "pane", agent: "cursor", status: "idle", binding }, request);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cursor.writes).toEqual(typed("/model Grok 4.7"));
    expect(sent).toHaveLength(1);
    expect(picks.note("mini/pane")).toBe(cursorChoseText("Claude Opus 5.5 300K Medium"));
    expect(picks.note("mini/pane")).toBe("Cursor chose Claude Opus 5.5 300K Medium.");
    // The chip shows what the footer says, not the pick.
    expect(picks.chip("mini/pane", "model", binding).label).toBe("Claude Opus 5.5");
  });
});

describe("OpenCode: its id only; main drives its list", () => {
  it("a listed model with its display name: OpenCode's own keys, made in main; set when the footer names it", async () => {
    const open = machine("opencode");
    const result = await open.openCodePick("opencode/glm-5.3-flash-free");
    expect(result).toEqual({ type: "set", model: "opencode/glm-5.3-flash-free", label: "GLM-5.3-Flash Free" });
    expect(open.openCode!.keyLog()).toEqual(["type:/models", "Enter", "type:GLM-5.3-Flash Free", "Enter"]);
    expect(JSON.stringify(open.catalog)).not.toContain("never-kept");
  });

  it("refused with nothing written: working, a question pending, a start screen, an unlisted id, a bad id, another kind's pane", async () => {
    const working = machine("opencode");
    working.status = "working";
    expect(await working.openCodePick("opencode/glm-5.3-flash-free")).toEqual({ type: "refused", note: openCodePickTexts.notIdle });
    const asking = machine("opencode");
    asking.inputPending = true;
    expect(await asking.openCodePick("opencode/glm-5.3-flash-free")).toEqual({ type: "refused", note: openCodePickTexts.notIdle });
    const started = machine("opencode", { startScreen: true });
    expect(await started.openCodePick("opencode/glm-5.3-flash-free")).toEqual({ type: "refused", note: startScreenTexts.notSent });
    const unlisted = machine("opencode");
    expect(await unlisted.openCodePick("opencode/not-there")).toEqual({ type: "refused", note: "Not set: that model is not in OpenCode's list on this machine." });
    const bad = machine("opencode");
    await expect(bad.openCodePick("opencode/glm 5")).rejects.toThrow("bad request");
    await expect(bad.openCodePick({ id: "opencode/glm-5.3-flash-free" })).rejects.toThrow("bad request");
    await expect(bad.openCodePick("opencode/glm-5.3-flash-free", bindingOf("cursor"))).rejects.toThrow("bad request");
    for (const m of [working, asking, started, unlisted, bad]) expect(m.openCode!.writes).toEqual([]);
  });

  it("a list read without display names (an older OpenCode): refused, pick it in OpenCode's own list", async () => {
    const open = machine("opencode");
    const plain = parseCatalog("opencode", "opencode/glm-5.3-flash-free\n");
    open.catalog = plain.ok ? [...plain.models] : [];
    expect(await open.openCodePick("opencode/glm-5.3-flash-free")).toEqual({
      type: "refused",
      note: "Not set: OpenCode's list on this machine gives no display name for it, so pick it in OpenCode's own list.",
    });
    expect(open.openCode!.writes).toEqual([]);
  });

  it("the page: only the id goes; refused while OpenCode works (not held); the chip shows the footer's model after", async () => {
    const open = machine("opencode");
    const asked: unknown[] = [];
    const picks = new AgentPicks({
      send: async () => undefined,
      openCodePick: (_hostId, _paneId, model, binding) => {
        asked.push(model);
        return open.openCodePick(model, binding) as never;
      },
      copy: () => undefined,
      now: () => 1,
    });
    const binding = bindingOf("opencode");
    const request = modelPickRequest("opencode", open.catalog, "opencode/glm-5.3-flash-free", null)!;
    expect(request).toEqual({ kind: "model", value: "opencode/glm-5.3-flash-free", label: "GLM-5.3-Flash Free", openCodeModel: "opencode/glm-5.3-flash-free" });
    picks.pick({ hostId: "mini", paneId: "pane", agent: "opencode", status: "working", binding }, request);
    expect(asked).toEqual([]);
    expect(picks.note("mini/pane")).toBe("Not set: OpenCode's model can be picked when OpenCode is idle.");
    picks.pick({ hostId: "mini", paneId: "pane", agent: "opencode", status: "idle", binding }, request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual(["opencode/glm-5.3-flash-free"]);
    expect(picks.note("mini/pane")).toBeNull();
    expect(picks.chip("mini/pane", "model", binding).label).toBe("GLM-5.3-Flash Free");
    expect(picks.openCodeModel("mini/pane", binding)).toEqual({ model: "opencode/glm-5.3-flash-free", label: "GLM-5.3-Flash Free" });
    // Another run in the pane: it goes.
    picks.sync("mini/pane", { hostId: "mini", paneId: "pane", agent: "opencode", status: "idle", binding: { ...binding, run: { connection: 1, arrival: 2 } } });
    expect(picks.openCodeModel("mini/pane", binding)).toBeNull();
  });
});

// The user's typing in the Terminal while a typed pick runs never joins it.
describe("a typed Grok or Cursor pick and the user's typing in the Terminal", () => {
  const cases = [
    { kind: "grok" as const, model: "grok-4.6", command: "/model grok-4.6" },
    { kind: "cursor" as const, model: "composer-2.5", command: "/model Composer 2.5" },
  ];

  for (const { kind, model, command } of cases) {
    it(`${kind}: typing after the box read empty (safety case): nothing written, no Return, the user's text left alone`, async () => {
      const m = machine(kind);
      m.race = { at: "ready", text: "Please explain the failing tests " };
      await expect(m.modelPick({ agent: kind, model, effort: null })).rejects.toThrow(typedCommandChangedText);
      expect(m.writes).toEqual([]);
      expect(m.submitted).toEqual([]);
      expect(m.draft).toBe("Please explain the failing tests ");
    });

    it(`${kind}: typing after the command went in: the box read back is not exactly it, so no Return; nothing taken back`, async () => {
      const m = machine(kind);
      m.race = { at: "readBack", text: " and explain the tests" };
      await expect(m.modelPick({ agent: kind, model, effort: null })).rejects.toThrow(typedCommandLeftText(kind === "grok" ? "Grok" : "Cursor", command, true));
      expect(m.writes).toEqual([["text", command]]);
      expect(m.submitted).toEqual([]);
      expect(m.draft).toBe(`${command} and explain the tests`);
    });

    it(`${kind}: the box read back holding more than the command (no Terminal input counted here): no Return`, async () => {
      const m = machine(kind);
      // Text joined to the command that no Terminal input of this app's counted (another client's, a late redraw).
      m.race = { at: "readBack", text: " x", quiet: true };
      await expect(m.modelPick({ agent: kind, model, effort: null })).rejects.toThrow(typedCommandLeftText(kind === "grok" ? "Grok" : "Cursor", command, false));
      expect(m.input).toBe(0);
      expect(m.writes).toEqual([["text", command]]);
      expect(m.submitted).toEqual([]);
    });

    it(`${kind}: the box read back failing: no Return`, async () => {
      const m = machine(kind);
      let reads = 0;
      const draw = m.before;
      Object.defineProperty(m, "before", {
        get: () => {
          reads += 1;
          if (reads > 1) throw new Error("the pane did not answer");
          return draw;
        },
        configurable: true,
      });
      await expect(m.modelPick({ agent: kind, model, effort: null })).rejects.toThrow(typedCommandLeftText(kind === "grok" ? "Grok" : "Cursor", command, false));
      expect(m.writes).toEqual([["text", command]]);
    });

    it(`${kind}: the agent working by the read-back (Herdr's word): no Return`, async () => {
      const m = machine(kind);
      let reads = 0;
      const draw = m.before;
      Object.defineProperty(m, "before", {
        get: () => {
          reads += 1;
          if (reads > 1) m.status = "working";
          return draw;
        },
        configurable: true,
      });
      await expect(m.modelPick({ agent: kind, model, effort: null })).rejects.toThrow();
      expect(m.writes).toEqual([["text", command]]);
      expect(m.submitted).toEqual([]);
    });
  }
});

// Cursor's model line with no effort word is kept for the pane run.
describe("Cursor's chip keeps a confirmed model with no effort word", () => {
  function cursorPage(m: Machine) {
    let now = 1;
    const picks = new AgentPicks({
      send: async () => undefined,
      modelPick: (_hostId, _paneId, pick, binding) => m.modelPick(pick, binding) as never,
      copy: () => undefined,
      now: () => now,
    });
    const binding = bindingOf("cursor");
    // Grok 4.7's footer read before the pick (the demo's Cursor pane).
    picks.receiveFooter("mini/pane", {
      scope: { terminalID: "term", session: "session" },
      run: binding.run,
      footer: { model: "Grok 4.7", window: "256K", effort: "medium", fast: false, percent: null } as never,
    });
    return { picks, binding, at: (ms: number) => void (now = 1 + ms) };
  }

  for (const { id, after, label, line } of [
    { id: "composer-2.5", after: "cursor-06-model-words-enter", label: "Composer 2.5", line: "Composer 2.5 Fast" },
    { id: "auto", after: "cursor-11-restore-auto", label: "Auto", line: "Auto" },
  ]) {
    it(`Grok 4.7 to ${label}: the chip reads ${label} after 10 s and after 10 minutes; effort unknown; the old footer no longer counts`, async () => {
      const m = machine("cursor");
      m.after = frame(after);
      const { picks, binding, at } = cursorPage(m);
      expect(picks.chip("mini/pane", "model", binding).label).toBe("Grok 4.7");
      picks.pick({ hostId: "mini", paneId: "pane", agent: "cursor", status: "idle", binding }, modelPickRequest("cursor", m.catalog, id, null)!);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(m.submitted).toEqual([`/model ${label}`]);
      expect(picks.note("mini/pane")).toBeNull();
      expect(picks.cursorModelLine("mini/pane", binding)).toEqual({ line, family: label });
      for (const ms of [10_001, 600_000]) {
        at(ms);
        expect(picks.chip("mini/pane", "model", binding).label).toBe(label);
        expect(picks.chip("mini/pane", "effort", binding).label).toBe("Default");
        expect(picks.cursorFooter("mini/pane", binding)).toBeNull();
      }
    });
  }

  it("a footer that reads, read after it, replaces the line; another run drops it", async () => {
    const m = machine("cursor");
    const { picks, binding, at } = cursorPage(m);
    picks.pick({ hostId: "mini", paneId: "pane", agent: "cursor", status: "idle", binding }, modelPickRequest("cursor", m.catalog, "composer-2.5", null)!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    at(10_001);
    expect(picks.chip("mini/pane", "model", binding).label).toBe("Composer 2.5");
    // The live reader publishing null (the line does not read as a footer) changes nothing.
    picks.receiveFooter("mini/pane", { scope: { terminalID: "term", session: "session" }, run: binding.run, footer: null });
    expect(picks.chip("mini/pane", "model", binding).label).toBe("Composer 2.5");
    picks.receiveFooter("mini/pane", {
      scope: { terminalID: "term", session: "session" },
      run: binding.run,
      footer: { model: "Claude Opus 5.5", window: "300K", effort: "medium", fast: false, percent: null } as never,
    });
    expect(picks.cursorModelLine("mini/pane", binding)).toBeNull();
    expect(picks.chip("mini/pane", "model", binding).label).toBe("Claude Opus 5.5");
    // Another pane run: the line kept for the last one goes.
    const again = machine("cursor");
    const second = cursorPage(again);
    second.picks.pick({ hostId: "mini", paneId: "pane", agent: "cursor", status: "idle", binding }, modelPickRequest("cursor", again.catalog, "composer-2.5", null)!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    second.picks.sync("mini/pane", { hostId: "mini", paneId: "pane", agent: "cursor", status: "idle", binding });
    expect(second.picks.cursorModelLine("mini/pane", binding)).not.toBeNull();
    const next = { ...binding, run: { connection: 1, arrival: 2 } };
    second.picks.sync("mini/pane", { hostId: "mini", paneId: "pane", agent: "cursor", status: "idle", binding: next });
    expect(second.picks.cursorModelLine("mini/pane", binding)).toBeNull();
    expect(second.picks.cursorModelLine("mini/pane", next)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Live frames (fixtures/livepick/*-live-*): Cursor Agent 2026.11.11 with `/model <family>` typed and its own list
// drawn under it; Grok Build 1.0.77 after a second pick.

/** The page wired to the machine (or the one `m()` names now) through its real handlers, its clock settable. */
function page(m: Machine | (() => Machine)) {
  let now = 1;
  const current = typeof m === "function" ? m : () => m;
  const picks = new AgentPicks({
    send: async () => undefined,
    modelPick: (_hostId, _paneId, pick, binding) => current().modelPick(pick, binding) as never,
    openCodePick: (_hostId, _paneId, model, binding) => current().openCodePick(model, binding) as never,
    copy: () => undefined,
    now: () => now,
  });
  return { picks, at: (ms: number) => void (now = 1 + ms) };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
const ctx = (kind: Kind, status = "idle", binding = bindingOf(kind)) => ({ hostId: "mini", paneId: "pane", agent: kind, status, binding }) as never;
const left = (name: string, command: string, moved = false): string => typedCommandLeftText(name, command, moved);

describe("Cursor's read-back accepts its own list under the typed command (live frames)", () => {
  it("cursor-live-01: the box holding the command, Models matching \"Composer 2.5\", Composer 2.5 marked: exactly one Return; cursor-live-02's line is the answer", async () => {
    const m = machine("cursor");
    m.typedFrame = frame("cursor-live-01-typed-not-sent");
    m.after = frame("cursor-live-02-after-enter");
    const outcome = await m.modelPick({ agent: "cursor", model: "composer-2.5", effort: null });
    expect(m.writes).toEqual(typed("/model Composer 2.5"));
    expect(m.submitted).toEqual(["/model Composer 2.5"]);
    expect(outcome).toEqual({ type: "cursor", modelLine: "Composer 2.5 Fast", footer: null });
  });

  it("cursor-live-03: /model Grok 4.7 with Grok 4.7 marked (its remembered 256K Medium not compared): exactly one Return", async () => {
    const m = machine("cursor");
    m.typedFrame = frame("cursor-live-03-typed-grok47");
    await m.modelPick({ agent: "cursor", model: "grok-4.7-high", effort: null });
    expect(m.writes).toEqual(typed("/model Grok 4.7"));
    expect(m.submitted).toEqual(["/model Grok 4.7"]);
  });

  const live = frame("cursor-live-01-typed-not-sent");
  const refused = [
    { name: "a marked row naming another family", screen: live.replace("\u{2192}  Composer 2.5            ", "\u{2192}  Composer 2              ") },
    { name: "a header naming other words", screen: live.replace('Models matching "Composer 2.5"', 'Models matching "Composer 2"  ') },
    { name: "a draft joined to the command", screen: live.replace("  \u{2192} /model Composer 2.5", "  \u{2192} /model Composer 2.5 and explain the tests") },
    { name: "a screen without the list (the box row and the footer)", screen: cursorTypedScreen(frame("cursor-05-after-esc"), "/model Composer 2.5", { none: true }) },
    { name: "a second row marked", screen: live.replace(" Edit prompt", " \u{2192}  Composer 2               Fast (Tab to modify)\n\n Edit prompt") },
    { name: "Cursor still working", screen: live.replace("  \u{2192} /model Composer 2.5", "  \u{2192} /model Composer 2.5   ctrl+c to stop") },
  ];
  for (const { name, screen } of refused) {
    it(`${name}: no Return; the Model menu's line says the command is still in Cursor's box`, async () => {
      expect(screen).not.toBe(live);
      const m = machine("cursor");
      m.typedFrame = screen;
      const { picks } = page(m);
      const binding = bindingOf("cursor");
      picks.pick(ctx("cursor"), modelPickRequest("cursor", m.catalog, "composer-2.5", null)!);
      await settle();
      expect(m.writes).toEqual([["text", "/model Composer 2.5"]]);
      expect(m.submitted).toEqual([]);
      const line = picks.modelNotSent("mini/pane", binding);
      expect(line).toBe(`Not set: ${left("Cursor", "/model Composer 2.5").replace(/^Not sent: /, "").replace(/\.$/, "")}.`);
      expect(line).toContain("/model Composer 2.5 is still in Cursor's box in its terminal");
      expect(picks.note("mini/pane")).toBe(line);
      // Through main's handler directly: the same refusal.
      const again = machine("cursor");
      again.typedFrame = screen;
      await expect(again.modelPick({ agent: "cursor", model: "composer-2.5", effort: null })).rejects.toThrow(left("Cursor", "/model Composer 2.5"));
    });
  }
});

describe("a pick not sent says why in the Model menu (Grok, Cursor, OpenCode)", () => {
  it("Grok: a draft in its box (grok-02), the box read back holding more than the command, a model the list does not name", async () => {
    const drafted = machine("grok");
    drafted.before = frame("grok-02-typed-model-id");
    const one = page(drafted);
    one.picks.pick(ctx("grok"), modelPickRequest("grok", drafted.catalog, "grok-4.6", null)!);
    await settle();
    expect(drafted.writes).toEqual([]);
    expect(one.picks.modelNotSent("mini/pane", bindingOf("grok"))).toBe("Not set: Grok's box has text in it. Send or clear it, then pick again.");

    const joined = machine("grok");
    joined.race = { at: "readBack", text: " x", quiet: true };
    const two = page(joined);
    two.picks.pick(ctx("grok"), modelPickRequest("grok", joined.catalog, "grok-4.6", null)!);
    await settle();
    expect(joined.submitted).toEqual([]);
    expect(two.picks.modelNotSent("mini/pane", bindingOf("grok"))).toContain("/model grok-4.6 is still in Grok's box in its terminal");

    const unlisted = machine("grok");
    const three = page(unlisted);
    const request = { kind: "model", value: "grok-9", label: "Grok 9", modelPick: { agent: "grok", model: "grok-9", effort: null }, command: "/model grok-9", expect: { ids: ["grok-9"], labels: ["Grok 9"] } };
    three.picks.pick(ctx("grok"), request as never);
    await settle();
    expect(unlisted.writes).toEqual([]);
    expect(three.picks.modelNotSent("mini/pane", bindingOf("grok"))).toBe("Not set: that model is not in the agent's list on this machine.");
  });

  it("Cursor: a draft in its box; the same pick again while one is on its way", async () => {
    const drafted = machine("cursor");
    drafted.draft = "please look at the tests";
    const one = page(drafted);
    one.picks.pick(ctx("cursor"), modelPickRequest("cursor", drafted.catalog, "composer-2.5", null)!);
    await settle();
    expect(drafted.writes).toEqual([]);
    expect(one.picks.modelNotSent("mini/pane", bindingOf("cursor"))).toBe("Not set: Cursor's box has text in it. Send or clear it, then pick again.");

    const slow = machine("cursor");
    let release: () => void = () => undefined;
    const picks = new AgentPicks({
      send: async () => undefined,
      modelPick: () => new Promise((resolve) => (release = () => resolve(undefined))) as never,
      copy: () => undefined,
      now: () => 1,
    });
    const request = modelPickRequest("cursor", slow.catalog, "composer-2.5", null)!;
    picks.pick(ctx("cursor"), request);
    picks.pick(ctx("cursor"), request);
    expect(picks.modelNotSent("mini/pane", bindingOf("cursor"))).toBe(pickStillGoingText);
    release();
  });

  it("Grok and Cursor: a row of a list still being read is checked again once the read ends, and picks", async () => {
    for (const [kind, model, command] of [
      ["grok", "grok-4.6", "/model grok-4.6"],
      ["cursor", "composer-2.5", "/model Composer 2.5"],
    ] as const) {
      const m = machine(kind);
      m.heldWhileReading = [];
      if (kind === "cursor") m.typedFrame = frame("cursor-live-01-typed-not-sent");
      await m.modelPick({ agent: kind, model, effort: null });
      expect(m.waitedForRead).toBe(1);
      expect(m.submitted).toEqual([command]);
    }
  });

  it("OpenCode: not idle on the page, working in main, a draft in its box: each says why, nothing written", async () => {
    const page1 = machine("opencode");
    const one = page(page1);
    const request = modelPickRequest("opencode", page1.catalog, "opencode/glm-5.3-flash-free", null)!;
    one.picks.pick(ctx("opencode", "working"), request);
    expect(one.picks.modelNotSent("mini/pane", bindingOf("opencode"))).toBe(openCodeIdleText);

    const working = machine("opencode");
    working.status = "working";
    const two = page(working);
    two.picks.pick(ctx("opencode"), request);
    await settle();
    expect(two.picks.modelNotSent("mini/pane", bindingOf("opencode"))).toBe(openCodePickTexts.notIdle);

    const drafted = machine("opencode");
    drafted.openCode!.view = { kind: "prompt", draft: "hello" };
    const three = page(drafted);
    three.picks.pick(ctx("opencode"), request);
    await settle();
    expect(three.picks.modelNotSent("mini/pane", bindingOf("opencode"))).toBe(openCodePickTexts.draft);
    for (const m of [page1, working, drafted]) expect(m.openCode!.writes).toEqual([]);
  });

  it("OpenCode, the live case: a row clicked while the list is still being read (the list held has no display names) picks once the read ends", async () => {
    const open = machine("opencode");
    const plain = parseCatalog("opencode", "opencode/beam-free\nopencode/glm-5.3-flash-free\n");
    open.heldWhileReading = plain.ok ? [...plain.models] : [];
    const { picks } = page(open);
    picks.pick(ctx("opencode"), modelPickRequest("opencode", open.catalog, "opencode/glm-5.3-flash-free", null)!);
    await settle();
    expect(open.waitedForRead).toBe(1);
    expect(open.openCode!.keyLog()).toEqual(["type:/models", "Enter", "type:GLM-5.3-Flash Free", "Enter"]);
    expect(picks.modelNotSent("mini/pane", bindingOf("opencode"))).toBeNull();
    expect(picks.chip("mini/pane", "model", bindingOf("opencode")).label).toBe("GLM-5.3-Flash Free");
  });

  it("OpenCode: the list read ends without the row: its line says so, nothing written; the same row again while one is on its way says so too", async () => {
    const open = machine("opencode");
    open.heldWhileReading = [];
    open.catalog = open.catalog.filter((model) => model.id !== "opencode/glm-5.3-flash-free");
    const { picks } = page(open);
    const request = { kind: "model", value: "opencode/glm-5.3-flash-free", label: "GLM-5.3-Flash Free", openCodeModel: "opencode/glm-5.3-flash-free" } as const;
    picks.pick(ctx("opencode"), request);
    await settle();
    expect(open.waitedForRead).toBe(1);
    expect(open.openCode!.writes).toEqual([]);
    expect(picks.modelNotSent("mini/pane", bindingOf("opencode"))).toBe("Not set: that model is not in OpenCode's list on this machine.");

    let release: () => void = () => undefined;
    const slow = new AgentPicks({
      send: async () => undefined,
      openCodePick: () => new Promise((resolve) => (release = () => resolve({ type: "refused", note: "Not set: x." }))) as never,
      copy: () => undefined,
      now: () => 1,
    });
    slow.pick(ctx("opencode"), request);
    expect(slow.modelNotSent("mini/pane", bindingOf("opencode"))).toBeNull();
    slow.pick(ctx("opencode"), request);
    expect(slow.modelNotSent("mini/pane", bindingOf("opencode"))).toBe(pickStillGoingText);
    release();
    await settle();
    expect(slow.modelNotSent("mini/pane", bindingOf("opencode"))).toBe("Not set: x.");
  });
});

describe("Grok's chip keeps the pick its screen confirmed", () => {
  const grokFiles = (model: string, effort: string) => ({ scope: { terminalID: "term", session: "session" }, model, modelLabel: `Grok ${model.slice(5)}`, effort, window: 256_000 });

  it("pick Grok 4.6 (grok-03 confirms): chip and tick at 15 s and 10 min; a late file value does not replace it; a second pick back to Grok 4.7 Build Fast (grok-live-01) replaces it; a new run drops it", async () => {
    let m = machine("grok");
    const { picks, at } = page(() => m);
    const binding = bindingOf("grok");
    // Grok's files before: Grok 4.7 high.
    picks.receive("mini/pane", grokFiles("grok-4.7", "high") as never, null);
    expect(picks.chip("mini/pane", "model", binding).label).toBe("Grok 4.7");
    picks.pick(ctx("grok"), modelPickRequest("grok", m.catalog, "grok-4.6", null)!);
    await settle();
    expect(m.submitted).toEqual(["/model grok-4.6"]);
    expect(picks.grokKeptPick("mini/pane", binding)).toEqual({ model: "grok-4.6", label: "Grok 4.6", effort: "low", shown: "Grok 4.6" });
    for (const ms of [15_000, 600_000]) {
      at(ms);
      picks.sync("mini/pane", ctx("grok"));
      expect(picks.chip("mini/pane", "model", binding).label).toBe("Grok 4.6");
      expect(picks.chip("mini/pane", "effort", binding).label).toBe("Low");
      expect(picks.settings("mini/pane", binding).model).toBe("grok-4.6");
    }
    // Grok's files read late, still the model before the pick: the kept pick stands.
    picks.receive("mini/pane", grokFiles("grok-4.7", "high") as never, null);
    expect(picks.chip("mini/pane", "model", binding).label).toBe("Grok 4.6");

    // The second pick, back to Grok 4.7 Build Fast: Grok says "Switched to Grok 4.7 Fast (low effort)" and its
    // border "Grok 4.7 Fast (low)" (grok-live-01); the list's row is "Grok 4.7 Build Fast".
    const back = machine("grok");
    back.before = frame("grok-03-after-enter");
    back.after = frame("grok-live-01-footer-47-fast");
    expect(await back.modelPick({ agent: "grok", model: "grok-4.7-build-fast", effort: null })).toEqual({ type: "grok", confirmed: true, shown: "Grok 4.7 Fast", said: "Grok 4.7 Fast", effort: "low" });
    // The page's own second pick (the pane's screen now grok-03's, as after the first).
    m = machine("grok");
    m.before = frame("grok-03-after-enter");
    m.after = frame("grok-live-01-footer-47-fast");
    picks.pick(ctx("grok"), modelPickRequest("grok", m.catalog, "grok-4.7-build-fast", null)!);
    await settle();
    expect(m.submitted).toEqual(["/model grok-4.7-build-fast"]);
    expect(picks.chip("mini/pane", "model", binding).label).toBe("Grok 4.7 Build Fast");
    expect(picks.chip("mini/pane", "effort", binding).label).toBe("Low");
    // The files then say the earlier pick (read late, as live: "Grok 4.6", "Low"): never over the newer kept pick.
    picks.receive("mini/pane", grokFiles("grok-4.6", "low") as never, null);
    at(615_000);
    picks.sync("mini/pane", ctx("grok"));
    expect(picks.chip("mini/pane", "model", binding).label).toBe("Grok 4.7 Build Fast");
    expect(picks.settings("mini/pane", binding).model).toBe("grok-4.7-build-fast");
    // A new run in the pane: it goes, and the files' values show again.
    const next = { ...binding, run: { connection: 1, arrival: 2 } };
    picks.sync("mini/pane", ctx("grok", "idle", next));
    expect(picks.grokKeptPick("mini/pane", next)).toBeNull();
    expect(picks.grokKeptPick("mini/pane", binding)).toBeNull();
    expect(picks.chip("mini/pane", "model", next).label).toBe("Grok 4.6");
  });

  it("a border naming another model (read later) drops it; the same name keeps it; another run's border changes nothing", async () => {
    const m = machine("grok");
    const { picks } = page(m);
    const binding = bindingOf("grok");
    picks.pick(ctx("grok"), modelPickRequest("grok", m.catalog, "grok-4.6", null)!);
    await settle();
    const scope = { terminalID: "term", session: "session" };
    picks.receiveMode("mini/pane", { scope, run: binding.run, agent: "grok", mode: "alwaysApprove", borderModel: "Grok 4.6" });
    expect(picks.grokKeptPick("mini/pane", binding)).not.toBeNull();
    picks.receiveMode("mini/pane", { scope, run: { connection: 1, arrival: 9 }, agent: "grok", mode: "alwaysApprove", borderModel: "Grok 4.5" });
    expect(picks.grokKeptPick("mini/pane", binding)).not.toBeNull();
    picks.receiveMode("mini/pane", { scope, run: binding.run, agent: "grok", mode: "alwaysApprove", borderModel: "Grok 4.7 Fast" });
    expect(picks.grokKeptPick("mini/pane", binding)).toBeNull();
  });

  it("the screen not confirming (its border still another row's, no new Switched line): nothing kept, the pick's usual wait", async () => {
    const m = machine("grok");
    m.after = frame("grok-04-restored");
    const outcome = await m.modelPick({ agent: "grok", model: "grok-4.6", effort: null });
    expect(outcome).toEqual({ type: "grok", confirmed: false, shown: "Grok 4.7 Fast", said: null, effort: "low" });
  });
});

// A read 0.01 s after the write can show neither the text in Cursor's box
// nor its list; both show from 0.16 s on. The read-back reads again while the screen is plainly on its way, at most
// typedReadBackReads reads, every check before each read.
describe("the read-back waits for the agent's screen to settle before Return", () => {
  const live = frame("cursor-live-01-typed-not-sent");
  const command = "/model Composer 2.5";
  const noList = (draft: string): string => cursorTypedScreen(frame("cursor-05-after-esc"), draft, { none: true });
  const pick = { agent: "cursor", model: "composer-2.5", effort: null };

  it("the screens one read can catch: drawn (cursor-live-01) shows; the empty box, a beginning of the command, the command with no list yet are on their way; anything else differs", () => {
    expect(cursorTypedRead(live, command, "Composer 2.5")).toBe("shows");
    expect(cursorTypedRead(frame("cursor-05-after-esc"), command, "Composer 2.5")).toBe("settling");
    expect(cursorTypedRead(noList("/model Comp"), command, "Composer 2.5")).toBe("settling");
    expect(cursorTypedRead(noList(command), command, "Composer 2.5")).toBe("settling");
    expect(cursorTypedRead(live.replace(`\u{2192} ${command}`, `\u{2192} ${command} and more`), command, "Composer 2.5")).toBe("differs");
    expect(cursorTypedRead(live.replace("\u{2192}  Composer 2.5            ", "\u{2192}  Composer 2              "), command, "Composer 2.5")).toBe("differs");
    expect(cursorTypedRead(live.replace('Models matching "Composer 2.5"', 'Models matching "Composer 2"  '), command, "Composer 2.5")).toBe("differs");
    expect(cursorTypedRead(noList("/model Composer 2.5x"), command, "Composer 2.5")).toBe("differs");
    expect(cursorTypedRead(noList("hello"), command, "Composer 2.5")).toBe("differs");
    expect(cursorTypedRead(frame("cursor-live-02-after-enter"), command, "Composer 2.5")).toBe("settling");
    expect(grokTypedRead(frame("grok-02-typed-model-id"), "/model grok-4.6")).toBe("shows");
    expect(grokTypedRead(frame("grok-04-restored"), "/model grok-4.6")).toBe("settling");
    expect(grokTypedRead(frame("grok-02-typed-model-id"), "/model grok-4.5")).toBe("differs");
  });

  it("the command after one read, its list after three: exactly one Return, at the fourth read", async () => {
    const m = machine("cursor");
    m.drawing = (n, draft) => (n === 1 ? m.before : n < 4 ? noList(draft) : live);
    await m.modelPick(pick);
    expect(m.writes).toEqual(typed(command));
    expect(m.submitted).toEqual([command]);
    expect(m.typedReads).toBe(4);
  });

  it("the box catching up character by character, then its list: exactly one Return", async () => {
    const m = machine("cursor");
    m.drawing = (n, draft) => (n <= 3 ? noList(draft.slice(0, 4 * n)) : live);
    await m.modelPick(pick);
    expect(m.submitted).toEqual([command]);
  });

  it("a screen that never shows the list: no Return after typedReadBackReads reads; the Model menu's line says the command is still in Cursor's box", async () => {
    const m = machine("cursor");
    m.drawing = (_n, draft) => noList(draft);
    await expect(m.modelPick(pick)).rejects.toThrow(left("Cursor", command));
    expect(m.submitted).toEqual([]);
    expect(m.writes).toEqual([["text", command]]);
    expect(m.typedReads).toBe(typedReadBackReads);
    const shown = machine("cursor");
    shown.drawing = (_n, draft) => noList(draft);
    const { picks } = page(shown);
    picks.pick(ctx("cursor"), modelPickRequest("cursor", shown.catalog, "composer-2.5", null)!);
    await settle();
    await settle();
    expect(shown.submitted).toEqual([]);
    expect(picks.modelNotSent("mini/pane", bindingOf("cursor"))).toContain(`${command} is still in Cursor's box in its terminal`);
  });

  it("text typed in the terminal during the wait: no Return, at once; the line says the terminal's text changed", async () => {
    const m = machine("cursor");
    m.drawing = (n, draft) => {
      if (n === 2) {
        m.input += 1;
        m.draft += " and more";
      }
      return n === 1 ? m.before : noList(m.draft.slice(0, draft.length));
    };
    await expect(m.modelPick(pick)).rejects.toThrow(left("Cursor", command, true));
    expect(m.submitted).toEqual([]);
    expect(m.typedReads).toBe(2);
  });

  it("another family marked, or the user's text joined to the command, during the wait: no Return, at once", async () => {
    for (const screen of [
      live.replace("\u{2192}  Composer 2.5            ", "\u{2192}  Composer 2              "),
      live.replace(`\u{2192} ${command}`, `\u{2192} ${command} and more`),
    ]) {
      const m = machine("cursor");
      m.drawing = (n) => (n === 1 ? m.before : screen);
      await expect(m.modelPick(pick)).rejects.toThrow(left("Cursor", command));
      expect(m.submitted).toEqual([]);
      expect(m.typedReads).toBe(2);
    }
  });

  it("a dialog during the wait (Herdr says blocked): no Return, at once", async () => {
    const m = machine("cursor");
    m.drawing = (n) => {
      if (n === 1) m.status = "blocked";
      return m.before;
    };
    await expect(m.modelPick(pick)).rejects.toThrow(/Return/);
    expect(m.submitted).toEqual([]);
    expect(m.typedReads).toBe(1);
  });

  it("Grok's read-back (one read before this pass) waits the same way: its box empty at the first read, then the command: one Return", async () => {
    const m = machine("grok");
    m.drawing = (n, draft) => (n === 1 ? m.before : withDraft("grok", m.before, draft));
    await m.modelPick({ agent: "grok", model: "grok-4.6", effort: null });
    expect(m.submitted).toEqual(["/model grok-4.6"]);
    expect(m.typedReads).toBe(2);
    const never = machine("grok");
    never.drawing = () => never.before;
    await expect(never.modelPick({ agent: "grok", model: "grok-4.6", effort: null })).rejects.toThrow(left("Grok", "/model grok-4.6"));
    expect(never.submitted).toEqual([]);
    expect(never.typedReads).toBe(typedReadBackReads);
  });
});

// Main confirms a Grok pick from its new "Switched to …"
// line alone when no border reads (shown null). The first border read after it names the pick (recorded, kept) or
// another model (the pick retires).
describe("a Grok pick confirmed without a border retires on a later different border", () => {
  const scope = { terminalID: "term", session: "session" };
  /** grok-03 with its border's model words drawn over (no border reads), its "Switched to Grok 4.6 (low effort)" kept. */
  const lineOnly = frame("grok-03-after-enter").replace(/\u{2500} Grok 4\.6 \(low\) \u{B7} always-approve \u{2500}\u{256F}/u, (border) => `${"\u{2500}".repeat(border.length - 1)}\u{256F}`);

  it("main: the line alone confirms it, with no border and the line's name", async () => {
    expect(lineOnly).not.toContain("Grok 4.6 (low)");
    const m = machine("grok");
    m.after = lineOnly;
    expect(await m.modelPick({ agent: "grok", model: "grok-4.6", effort: null })).toEqual({ type: "grok", confirmed: true, shown: null, said: "Grok 4.6", effort: "low" });
  });

  async function lineConfirmed() {
    const m = machine("grok");
    m.after = lineOnly;
    const { picks } = page(m);
    const binding = bindingOf("grok");
    picks.receive("mini/pane", { scope, model: "grok-4.7", modelLabel: "Grok 4.7", effort: "high", window: 256_000 } as never, null);
    picks.pick(ctx("grok"), modelPickRequest("grok", m.catalog, "grok-4.6", null)!);
    await settle();
    expect(m.submitted).toEqual(["/model grok-4.6"]);
    expect(picks.grokKeptPick("mini/pane", binding)).toEqual({ model: "grok-4.6", label: "Grok 4.6", effort: "low", shown: null });
    return { picks, binding };
  }

  it("followed by a border naming it: kept, that border recorded; a later border naming another model then retires it", async () => {
    const { picks, binding } = await lineConfirmed();
    picks.receiveMode("mini/pane", { scope, run: binding.run, agent: "grok", mode: "alwaysApprove", borderModel: "Grok 4.6" });
    expect(picks.grokKeptPick("mini/pane", binding)).toEqual({ model: "grok-4.6", label: "Grok 4.6", effort: "low", shown: "Grok 4.6" });
    expect(picks.chip("mini/pane", "model", binding).label).toBe("Grok 4.6");
    picks.receiveMode("mini/pane", { scope, run: binding.run, agent: "grok", mode: "alwaysApprove", borderModel: "Grok 4.7" });
    expect(picks.grokKeptPick("mini/pane", binding)).toBeNull();
  });

  it("followed by a border for another listed model: retired, the chip follows (Grok's files name that model)", async () => {
    const { picks, binding } = await lineConfirmed();
    picks.receiveMode("mini/pane", { scope, run: binding.run, agent: "grok", mode: "alwaysApprove", borderModel: "Grok 4.7 Fast" });
    expect(picks.grokKeptPick("mini/pane", binding)).toBeNull();
    picks.receive("mini/pane", { scope, model: "grok-4.7-build-fast", modelLabel: "Grok 4.7 Build Fast", effort: "low", window: 256_000 } as never, null);
    expect(picks.chip("mini/pane", "model", binding).label).toBe("Grok 4.7 Build Fast");
    expect(picks.settings("mini/pane", binding).model).toBe("grok-4.7-build-fast");
  });

  it("another run's border changes nothing; the control: a pick confirmed with its border recorded retires on another border", async () => {
    const { picks, binding } = await lineConfirmed();
    picks.receiveMode("mini/pane", { scope, run: { connection: 1, arrival: 9 }, agent: "grok", mode: "alwaysApprove", borderModel: "Grok 4.5" });
    expect(picks.grokKeptPick("mini/pane", binding)?.shown).toBeNull();
    const m = machine("grok");
    const { picks: bordered } = page(m);
    bordered.pick(ctx("grok"), modelPickRequest("grok", m.catalog, "grok-4.6", null)!);
    await settle();
    expect(bordered.grokKeptPick("mini/pane", binding)?.shown).toBe("Grok 4.6");
    bordered.receiveMode("mini/pane", { scope, run: binding.run, agent: "grok", mode: "alwaysApprove", borderModel: "Grok 4.7 Fast" });
    expect(bordered.grokKeptPick("mini/pane", binding)).toBeNull();
  });
});

// Chat for Grok Build, Cursor Agent and OpenCode is Early
// (kinds.ts chatSupportedKinds is Claude Code and Codex). Only the badge and the early line follow that list: a row of
// each one's Model menu still writes its command through main's real handler.
describe("the three Early kinds' Model picks are still accepted in main", () => {
  it("Grok Build, Cursor Agent and OpenCode are early, and a row for each still writes its command", async () => {
    const { chatEarly, chatSupport } = await import("../src/shared/chat/kinds");
    for (const kind of ["grok", "cursor", "opencode"]) {
      expect(chatEarly(kind), kind).toBe(true);
      expect(chatSupport(kind), kind).toBe("early");
    }
    const grok = machine("grok");
    await grok.modelPick({ agent: "grok", model: "grok-4.6", effort: null });
    expect(grok.writes).toEqual(typed("/model grok-4.6"));
    const cursor = machine("cursor");
    expect(await cursor.modelPick({ agent: "cursor", model: "composer-2.5", effort: null })).toEqual({ type: "cursor", modelLine: "Composer 2.5 Fast", footer: null });
    expect(cursor.writes).toEqual(typed("/model Composer 2.5"));
    const open = machine("opencode");
    expect(await open.openCodePick("opencode/glm-5.3-flash-free")).toEqual({ type: "set", model: "opencode/glm-5.3-flash-free", label: "GLM-5.3-Flash Free" });
    expect(open.openCode!.keyLog()).toEqual(["type:/models", "Enter", "type:GLM-5.3-Flash Free", "Enter"]);
  });
});
