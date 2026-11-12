// A `/compact` the user typed while Claude worked, held for the end of the turn, that does not go while their
// box already holds newer text, is a Kept draft of its own (main's DraftStore, the store a gone pane's draft goes
// to). It stays there through a Model pick, a ring Compact, another typed Compact and a reload, until the user puts
// it in the box or discards it; their newer text stays in the box; nothing is sent by itself. Into an empty box it
// goes back. With no room in Kept drafts it goes back into the box before the user's newer text.
// One whose Return may have reached the
// agent (main could not confirm it) is kept with a reason and a row saying it may have gone, never "not sent",
// through a reload and a fresh DraftStore; the page passes only a bounded outcome and main picks the reason.
// The page talks to main's real drafts IPC (drafts-ipc.ts) over a fake ipcMain. Every pane, Herdr input,
// transcript line and saved draft here is invented.

import { afterEach, describe, expect, it, vi } from "vitest";

import { sendBound, type SendSite } from "../src/main/herdr/send";
import { decodeSessionTopology, type AgentInfo, type TopologyPaneInfo } from "../src/main/herdr/wire";
import { DraftStore, MemoryDraftFiles } from "../src/main/drafts";
import type { SendBinding } from "../src/shared/send-binding";
import { compactKeptReason, compactUnsureReason, keptLimit, type DraftInput, type DraftsChangedEvent, type KeptDraft } from "../src/shared/drafts";
import { IPC } from "../src/shared/ipc-contract";

const registered = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => registered.ons.set(channel, listener),
  },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { registerDraftsIpc } = await import("../src/main/drafts-ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { agentPicks, compactBoxText, compactKeptText, compactOutcomeOf, compactQueuedText } = await import("../src/renderer/components/agent-picks");
const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
const { draftInput, draftPersistence } = await import("../src/renderer/components/draft-persistence");
const { keptLabel } = await import("../src/renderer/components/KeptDrafts");
const { commandRows } = await import("../src/renderer/chat/command-rows");
const { HookHost, find, elements } = await import("./support/fake-hooks");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
};

const key = "mac-a/p1";
const refused = "/compact preserve the release checklist";
const newer = "please investigate the layout";
const binding: SendBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: "session-1", run: { connection: 2, arrival: 1 } };
const ctx = (status: "working" | "done") => ({ hostId: "mac-a", paneId: "p1", agent: "claude" as const, status, binding });
const sender = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
const stranger = { senderFrame: { url: "https://example.invalid" }, sender: { id: 2 } };

type Status = "idle" | "done" | "working" | "blocked";

/** A fake Herdr pane with Claude in it: what was typed and each Return. */
function pane() {
  // returnLost: the Return never answers and is not seen; replyLost: the Return reaches Claude, its reply is lost.
  const state = { status: "working" as Status, freshFails: false, returnLost: false, replyLost: false, buffer: "" };
  const log: string[][] = [];
  const site = {
    fresh: async () => !state.freshFails,
    pane: () => ({ paneID: "p1", terminalID: "t1", agent: "claude", agentStatus: state.status }) as unknown as TopologyPaneInfo,
    agent: () => ({ paneID: "p1", agent: "claude", agentStatus: state.status, inputPending: false, agentSession: { value: "session-1" } }) as unknown as AgentInfo,
    run: () => ({ connection: 2, arrival: 1 }),
    writer: {
      prompt: async (_p: string, text: string) => void log.push(["prompt", text]),
      sendInput: async (_p: string, text: string) => void log.push(["input", text]),
      sendText: async (_p: string, text: string) => {
        log.push(["text", text]);
        state.buffer += text;
      },
      agentKeys: async () => {
        if (state.returnLost) throw new Error("the connection closed");
        log.push(["return", state.buffer]);
        state.buffer = "";
        if (state.replyLost) throw new Error("the connection closed after the Return went");
      },
    },
  } as unknown as SendSite;
  return { state, site, log };
}

function hostAt(status: string) {
  return {
    id: "mac-a",
    name: "Invented Mac",
    state: "connected",
    topology: decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [],
      tabs: [],
      layouts: [],
      panes: [{ pane_id: "p1", terminal_id: "t1", workspace_id: "w1", tab_id: "tab1", focused: false, agent: "claude", agent_status: status, revision: 1 }],
      agents: [{ pane_id: "p1", agent: "claude", agent_status: status, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "session-1" } }],
    }),
    run: { connection: 2, arrivals: { p1: 1 } },
  };
}

/** Main's drafts as the app runs them: a DraftStore in memory behind the real drafts IPC; the page attached to it. */
function mainDrafts(options: { keeps?: boolean; store?: DraftStore } = {}) {
  const store = options.store ?? new DraftStore(new MemoryDraftFiles(), { delayMs: 100_000 });
  registerDraftsIpc(store, {
    agentOf: () => "claude",
    hostLabel: () => "Invented Mac",
    notify: (event: DraftsChangedEvent) => draftPersistence.changed(event),
  });
  const bridge = {
    saveDraft: (hostId: string, paneId: string, input: DraftInput | null) => registered.ons.get(IPC.draftSave)!(sender, hostId, paneId, input),
    keptDraft: async (id: string, action: string) => registered.handles.get(IPC.draftKept)!(sender, id, action),
    ...(options.keeps === false
      ? {}
      : {
          keepDraft: async (hostId: string, paneId: string, text: string, outcome: unknown) =>
            registered.handles.get(IPC.draftKeep)!(sender, hostId, paneId, text, outcome),
        }),
  };
  draftPersistence.attach(bridge as never);
  return { store, bridge };
}

const mounted: { unmount(): void }[] = [];
afterEach(() => {
  for (const ui of mounted.splice(0)) ui.unmount();
  draftPersistence.detach();
  composerDrafts.clear();
  agentPicks.clear();
  commandRows.clear();
  vi.unstubAllGlobals();
});

/** Chat's real box for the pane while Claude works, its sends going through main's real checks to the fake pane. */
function composerOn() {
  composerDrafts.clear();
  agentPicks.clear();
  commandRows.clear();
  const machine = pane();
  const calls: string[] = [];
  vi.stubGlobal("window", {
    innerHeight: 900,
    herdrDesktop: {
      sendToPane: async (_h: string, p: string, text: string, b: SendBinding) => {
        calls.push(text);
        await sendBound(machine.site, p, text, b);
      },
      copyText: () => undefined,
      stopAgent: async () => null,
    },
  });
  const ui = new HookHost(Composer as (props: object) => unknown, {
    host: hostAt("working"),
    row: { paneID: "p1", kind: "claude", isAgent: true, status: "working", workspaceLabel: "fake" },
    stops: true,
  });
  mounted.push(ui);
  ui.render();
  const typeIn = (text: string): void => (find(ui.tree, "textarea")!.props["onChange"] as (event: unknown) => void)({ target: { value: text } });
  const send = async (text: string): Promise<void> => {
    typeIn(text);
    (find(ui.tree, "textarea")!.props["onKeyDown"] as (event: unknown) => void)({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => undefined,
    });
    await flush();
  };
  const turnEnds = async (): Promise<void> => {
    machine.state.status = "done";
    agentPicks.syncHosts([hostAt("done") as never]);
    await flush();
  };
  const note = (): string | null => {
    const line = elements(ui.tree).find((e) => e.props["className"] === "cmp-note-t");
    return line === undefined ? null : String(line.props["children"]);
  };
  return { machine, calls, ui, typeIn, send, turnEnds, note, box: () => composerDrafts.get(key) };
}

/** What main keeps for the machine: its Kept drafts' texts. */
const keptTexts = (store: DraftStore): string[] => store.state().kept.map((item) => item.text);

/** The user sends `/compact …` while Claude works, types newer words, and main's fresh check refuses it at the turn's end. */
async function refusedWithNewer() {
  const c = composerOn();
  const m = mainDrafts();
  await c.send(refused);
  expect(c.note()).toBe(compactQueuedText);
  c.typeIn(newer);
  c.machine.state.freshFails = true;
  await c.turnEnds();
  c.machine.state.freshFails = false;
  return { c, m };
}

describe("a refused Compact with newer text in the box is a Kept draft", () => {
  it("the line is in Kept drafts, the user's newer text in the box, the note says where it is; nothing sent", async () => {
    const { c, m } = await refusedWithNewer();
    expect(c.machine.log).toEqual([]);
    expect(c.box().text).toBe(newer);
    expect(c.box().held).toBeNull();
    expect(c.box().keeping).toEqual([]);
    const item = m.store.state().kept[0]!;
    expect(item).toMatchObject({ hostId: "mac-a", hostLabel: "Invented Mac", paneId: "p1", agentName: "claude", text: refused, chips: [], reason: compactKeptReason });
    expect(m.store.state().kept).toHaveLength(1);
    // The pane's saved draft is the user's newer text only (the line is kept once, under Kept drafts).
    expect(m.store.state().drafts.map((draft) => draft.text)).toEqual([newer]);
    expect(c.note()).toMatch(/could not check/);
    expect(c.note()).toMatch(/ Your line is in Kept drafts\.$/);
    expect(agentPicks.noteKept(key)).toBe(true);
    // The box lists it: what it is, with Put in box (while the box is empty), Copy and Discard.
    c.ui.render();
    const row = elements(c.ui.tree).find((e) => e.props["className"] === "kept-row");
    expect(row).toBeDefined();
    expect(keptLabel(item)).toBe("A Compact for claude (pane p1) that was not sent");
    expect(draftPersistence.keptFor("mac-a").map((kept) => kept.text)).toEqual([refused]);
  });

  it.each([
    ["a Model pick", "model"],
    ["a ring Compact", "ring"],
    ["another typed Compact", "typed"],
  ])("after %s the line is still in Kept drafts and nothing of it is sent", async (_what, action) => {
    const { c, m } = await refusedWithNewer();
    if (action === "model") agentPicks.pick(ctx("working"), { kind: "model", value: "opus", label: "Opus" });
    else if (action === "ring") agentPicks.pick(ctx("working"), { kind: "compact", value: "compact", label: "Compact" });
    else await c.send("/compact preserve another plan");
    await flush();
    expect(keptTexts(m.store)).toEqual([refused]);
    expect(draftPersistence.keptFor("mac-a").map((item) => item.text)).toEqual([refused]);
    if (action === "typed") {
      // The user replaced their newer words with the new Compact themselves: it is held, the refused one is still kept.
      expect(c.box().held).toBe("/compact preserve another plan");
    } else {
      expect(c.box().text).toBe(newer);
    }
    // The one attempt main refused at the turn's end, never again.
    expect(c.calls).toEqual([refused]);
    // The turn ends: only what the user asked for after goes; the refused line never goes by itself.
    await c.turnEnds();
    const sent = c.machine.log.filter((entry) => entry[0] === "return").map((entry) => entry[1]);
    expect(sent).not.toContain(refused);
    expect(keptTexts(m.store)).toEqual([refused]);
    if (action !== "typed") expect(c.box().text).toBe(newer);
  });

  it("a reload through the real draft saver brings the line back under Kept drafts and the user's newer text into the box", async () => {
    const { c, m } = await refusedWithNewer();
    m.store.flush();
    const state = m.store.state();
    // The window reloads: the page starts afresh and loads what main kept.
    c.ui.unmount();
    mounted.splice(0);
    draftPersistence.detach();
    composerDrafts.clear();
    agentPicks.clear();
    const again = mainDrafts({ store: m.store });
    draftPersistence.restore(state);
    expect(composerDrafts.get(key).text).toBe(newer);
    expect(draftPersistence.keptFor("mac-a").map((item) => item.text)).toEqual([refused]);
    expect(keptTexts(again.store)).toEqual([refused]);
    agentPicks.syncHosts([hostAt("done") as never]);
    await flush();
    // The one attempt main refused at the turn's end, never again.
    expect(c.calls).toEqual([refused]);
    expect(c.machine.log).toEqual([]);
  });

  it("the main process's file keeps it: a new DraftStore reading the written file still has it", async () => {
    const files = new MemoryDraftFiles();
    const store = new DraftStore(files, { delayMs: 100_000 });
    const c = composerOn();
    mainDrafts({ store });
    await c.send(refused);
    c.typeIn(newer);
    c.machine.state.freshFails = true;
    await c.turnEnds();
    store.flush();
    const reread = new DraftStore(files);
    expect(reread.state().kept.map((item) => [item.text, item.reason])).toEqual([[refused, compactKeptReason]]);
    expect(reread.state().drafts.map((draft) => draft.text)).toEqual([newer]);
  });

  it("Put in box once the box is empty: it leaves Kept drafts only then", async () => {
    const { c, m } = await refusedWithNewer();
    const item = draftPersistence.keptFor("mac-a")[0]!;
    // Not over the user's newer text.
    expect(await draftPersistence.take(item, key)).toBe(false);
    expect(keptTexts(m.store)).toEqual([refused]);
    c.typeIn("");
    expect(await draftPersistence.take(item, key)).toBe(true);
    expect(c.box().text).toBe(refused);
    expect(keptTexts(m.store)).toEqual([]);
    // The one attempt main refused at the turn's end, never again.
    expect(c.calls).toEqual([refused]);
  });

  it("Discard removes it from Kept drafts; the user's newer text stays", async () => {
    const { c, m } = await refusedWithNewer();
    await draftPersistence.discard(draftPersistence.keptFor("mac-a")[0]!);
    expect(keptTexts(m.store)).toEqual([]);
    expect(draftPersistence.keptFor("mac-a")).toEqual([]);
    expect(c.box().text).toBe(newer);
  });

  it("into an empty box it still goes back into the box, not Kept drafts", async () => {
    const c = composerOn();
    const m = mainDrafts();
    await c.send(refused);
    c.machine.state.freshFails = true;
    await c.turnEnds();
    expect(c.box().text).toBe(refused);
    expect(keptTexts(m.store)).toEqual([]);
    expect(c.note()).toMatch(/could not check/);
    expect(c.note()).not.toMatch(/Kept drafts/);
  });

  it("a Return whose outcome is not known, with newer text: its own wording, the line under Kept drafts, never sent again by itself", async () => {
    const c = composerOn();
    const m = mainDrafts();
    await c.send("/compact keep the plan");
    c.typeIn(newer);
    c.machine.state.returnLost = true;
    await c.turnEnds();
    expect(c.note()).toMatch(/^Not set: Typed into .+, but the Mac did not confirm its Return\. Check the agent before sending again\. Your line is in Kept drafts\.$/);
    expect(keptTexts(m.store)).toEqual(["/compact keep the plan"]);
    expect(c.box().text).toBe(newer);
    agentPicks.syncHosts([hostAt("done") as never]);
    await flush();
    expect(c.calls).toEqual(["/compact keep the plan"]);
  });

  it("a ring Compact taking a held typed one's place: the typed line goes to Kept drafts while the box has newer text", async () => {
    const c = composerOn();
    const m = mainDrafts();
    await c.send(refused);
    c.typeIn(newer);
    agentPicks.pick(ctx("working"), { kind: "compact", value: "compact", label: "Compact" });
    await flush();
    expect(keptTexts(m.store)).toEqual([refused]);
    expect(agentPicks.note(key)).toBe(compactKeptText(null));
    await c.turnEnds();
    expect(c.machine.log.filter((entry) => entry[0] === "return").map((entry) => entry[1])).toEqual(["/compact"]);
    expect(c.box().text).toBe(newer);
  });

  it("with no room in Kept drafts, the line is back in the box before the user's newer text", async () => {
    const store = new DraftStore(new MemoryDraftFiles(), { delayMs: 100_000 });
    for (let i = 0; i < keptLimit; i += 1) store.keep("mac-a", "Invented Mac", `old${i}`, null, `old ${i}`, "Its pane is gone.");
    const c = composerOn();
    mainDrafts({ store });
    await c.send(refused);
    c.typeIn(newer);
    c.machine.state.freshFails = true;
    await c.turnEnds();
    expect(store.state().kept).toHaveLength(keptLimit);
    expect(keptTexts(store)).not.toContain(refused);
    expect(c.box().text).toBe(`${refused}\n${newer}`);
    expect(c.note()).toMatch(/ Your line is back in the box\.$/);
    // The one attempt main refused at the turn's end, never again.
    expect(c.calls).toEqual([refused]);
  });

  it("while main has not answered yet the saved draft still holds the line (at worst in both, never in neither)", async () => {
    const c = composerOn();
    const saves: (DraftInput | null)[] = [];
    let answer: ((item: KeptDraft | null) => void) | null = null;
    draftPersistence.attach({
      saveDraft: (_h: string, _p: string, input: DraftInput | null) => void saves.push(input),
      keptDraft: async () => null,
      keepDraft: () => new Promise<KeptDraft | null>((resolve) => (answer = resolve)),
    } as never);
    await c.send(refused);
    c.typeIn(newer);
    c.machine.state.freshFails = true;
    await c.turnEnds();
    expect(c.box().keeping).toEqual([refused]);
    expect(saves.at(-1)?.text).toBe(`${refused}\n${newer}`);
    expect(draftInput(c.box())?.text).toBe(`${refused}\n${newer}`);
    // A crash now: the saved draft brings both back as text in the box. Main answering instead: the draft lets it go.
    answer!({ id: "k1", hostId: "mac-a", hostLabel: "Invented Mac", paneId: "p1", agentName: "claude", text: refused, chips: [], reason: compactKeptReason, at: 1 });
    await flush();
    expect(c.box().keeping).toEqual([]);
    expect(saves.at(-1)?.text).toBe(newer);
    expect(draftPersistence.keptFor("mac-a").map((item) => item.text)).toEqual([refused]);
    expect(c.note()).toMatch(/ Your line is in Kept drafts\.$/);
  });

  it("an older bridge without Kept drafts for it: back in the box before the user's newer text", async () => {
    const c = composerOn();
    mainDrafts({ keeps: false });
    await c.send(refused);
    c.typeIn(newer);
    c.machine.state.freshFails = true;
    await c.turnEnds();
    expect(c.box().text).toBe(`${refused}\n${newer}`);
    expect(c.note()).toBe(compactBoxText(c.note()!.replace(/ Your line is back in the box\.$/, "")));
  });
});

describe("main's side of it (drafts-ipc.ts, DraftStore.keep)", () => {
  it("keeps a well-formed line with main's own reason and the pane's agent; refuses anything else and any other sender", async () => {
    const store = new DraftStore(new MemoryDraftFiles());
    const notified: DraftsChangedEvent[] = [];
    registerDraftsIpc(store, { agentOf: () => "claude", notify: (event) => notified.push(event) });
    const keep = registered.handles.get(IPC.draftKeep)!;
    const item = keep(sender, "mac-a", "p1", refused, "refused") as KeptDraft;
    expect(item).toMatchObject({ hostId: "mac-a", hostLabel: "mac-a", paneId: "p1", agentName: "claude", text: refused, reason: compactKeptReason });
    expect(notified.at(-1)!.state.kept.map((kept) => kept.id)).toEqual([item.id]);
    expect(notified.at(-1)!.gone).toEqual([]);
    expect(() => keep(sender, "mac-a", "", refused)).toThrow("bad request");
    expect(() => keep(sender, "mac-a", "p1", "")).toThrow("bad request");
    expect(() => keep(sender, "mac-a", "p1", 5)).toThrow("bad request");
    expect(() => keep(stranger, "mac-a", "p1", "not ours", "refused")).toThrow();
    expect(store.state().kept).toHaveLength(1);
    expect(store.takeKept(item.id)?.text).toBe(refused);
  });

  it("is bounded as every Kept draft: 50 items, then none (null)", () => {
    const store = new DraftStore(new MemoryDraftFiles());
    for (let i = 0; i < keptLimit; i += 1) expect(store.keep("mac-a", "m", `p${i}`, null, `line ${i}`, compactKeptReason)).not.toBeNull();
    expect(store.keep("mac-a", "m", "p99", null, "one more", compactKeptReason)).toBeNull();
    expect(store.state().kept).toHaveLength(keptLimit);
  });
});

describe("a Compact whose Return may have gone is kept saying so", () => {
  /** The user sends `/compact …` while Claude works, types newer words; at the turn's end its Return reaches Claude and the reply is lost. */
  async function unconfirmedWithNewer(store?: DraftStore) {
    const c = composerOn();
    const m = mainDrafts(store === undefined ? {} : { store });
    await c.send(refused);
    expect(c.note()).toBe(compactQueuedText);
    c.typeIn(newer);
    c.machine.state.replyLost = true;
    await c.turnEnds();
    c.machine.state.replyLost = false;
    return { c, m };
  }
  const returns = (c: ReturnType<typeof composerOn>): string[] => c.machine.log.filter((entry) => entry[0] === "return").map((entry) => entry[1]!);
  const mayHaveGone = "A Compact for claude (pane p1) that may have gone: check the agent before sending it again";

  it("a Return received but its reply lost, then a reload and a fresh DraftStore: the item and row say it may have gone, never not sent", async () => {
    const files = new MemoryDraftFiles();
    const store = new DraftStore(files, { delayMs: 100_000 });
    const { c } = await unconfirmedWithNewer(store);
    // Claude got the Return once; the note now says the outcome is not known.
    expect(returns(c)).toEqual([refused]);
    expect(c.note()).toMatch(/did not confirm its Return\. Check the agent before sending again\. Your line is in Kept drafts\.$/);
    expect(c.box().text).toBe(newer);
    // The window reloads through the real draft IPC: the note is gone, the row is what is left.
    store.flush();
    const state = store.state();
    c.ui.unmount();
    mounted.splice(0);
    draftPersistence.detach();
    composerDrafts.clear();
    agentPicks.clear();
    mainDrafts({ store });
    draftPersistence.restore(state);
    expect(composerDrafts.get(key).text).toBe(newer);
    const shown = draftPersistence.keptFor("mac-a");
    expect(shown.map((item) => item.text)).toEqual([refused]);
    expect(keptLabel(shown[0]!)).toBe(mayHaveGone);
    // A fresh DraftStore reading what main wrote.
    const reopened = new DraftStore(files);
    const item = reopened.state().kept[0]!;
    expect(reopened.state().kept).toHaveLength(1);
    expect(item).toMatchObject({ hostId: "mac-a", paneId: "p1", agentName: "claude", text: refused, reason: compactUnsureReason });
    expect(item.reason).not.toBe(compactKeptReason);
    expect(keptLabel(item)).toBe(mayHaveGone);
    expect(keptLabel(item)).not.toMatch(/not sent/);
    // Nothing goes again by itself.
    agentPicks.syncHosts([hostAt("done") as never]);
    await flush();
    expect(returns(c)).toEqual([refused]);
    expect(c.calls).toEqual([refused]);
  });

  it("another pick does not change what the row says; nothing is re-sent", async () => {
    const { c, m } = await unconfirmedWithNewer();
    agentPicks.pick(ctx("working"), { kind: "model", value: "opus", label: "Opus" });
    await flush();
    expect(m.store.state().kept.map((item) => [item.text, item.reason])).toEqual([[refused, compactUnsureReason]]);
    expect(keptLabel(draftPersistence.keptFor("mac-a")[0]!)).toBe(mayHaveGone);
    await c.turnEnds();
    expect(returns(c).filter((text) => text === refused)).toEqual([refused]);
  });

  it("a Compact refused before any key went still says not sent, through a fresh DraftStore", async () => {
    const files = new MemoryDraftFiles();
    const store = new DraftStore(files, { delayMs: 100_000 });
    const c = composerOn();
    mainDrafts({ store });
    await c.send(refused);
    c.typeIn(newer);
    c.machine.state.freshFails = true;
    await c.turnEnds();
    expect(c.machine.log).toEqual([]);
    store.flush();
    const item = new DraftStore(files).state().kept[0]!;
    expect(item.reason).toBe(compactKeptReason);
    expect(keptLabel(item)).toBe("A Compact for claude (pane p1) that was not sent");
  });

  it("an outcome value main does not know never makes a not sent item", () => {
    const store = new DraftStore(new MemoryDraftFiles());
    registerDraftsIpc(store, { agentOf: () => "claude", notify: () => undefined });
    const keep = registered.handles.get(IPC.draftKeep)!;
    const odd: unknown[] = [undefined, null, "", "Refused", "refused ", "sent", "not sent", 0, 1, true, {}, ["refused"], { toString: () => "refused" }];
    for (const outcome of odd) {
      const item = keep(sender, "mac-a", "p1", refused, outcome) as KeptDraft;
      expect(item.reason, String(outcome)).toBe(compactUnsureReason);
      expect(keptLabel(item), String(outcome)).toBe(mayHaveGone);
    }
    // A reason of the page's own is never taken: the fifth argument is only ever read as an outcome.
    const authored = keep(sender, "mac-a", "p1", refused, "Compact not sent.") as KeptDraft;
    expect(authored.reason).toBe(compactUnsureReason);
    expect(store.state().kept.every((item) => item.reason === compactUnsureReason)).toBe(true);
  });

  it("the page reads main's note: only its refusals before any key went are refused", () => {
    expect(compactOutcomeOf(new Error("Not sent: the app could not check that Claude Code is still in its pane. The text is kept."))).toBe("refused");
    expect(compactOutcomeOf(new Error("Not run: an agent started in this pane. The text is kept."))).toBe("refused");
    expect(compactOutcomeOf(new Error("Not sent: the pane is gone"))).toBe("refused");
    expect(compactOutcomeOf(new Error("claude exited; not sent"))).toBe("refused");
    expect(compactOutcomeOf(new Error("Error invoking remote method 'herdr:send': Error: Not sent: the pane is gone"))).toBe("refused");
    expect(compactOutcomeOf(new Error("Typed into Claude Code, but the Mac did not confirm its Return. Check the agent before sending again."))).toBe("unknown");
    expect(compactOutcomeOf(new Error("Typed into Claude Code, but Herdr did not take its Return. Check the terminal before sending again."))).toBe("unknown");
    expect(compactOutcomeOf(new Error("Sent, but the Mac did not confirm it. Check the agent before sending again."))).toBe("unknown");
    expect(compactOutcomeOf(new Error("something else"))).toBe("unknown");
    expect(compactOutcomeOf("Not sent: a string, not main's Error")).toBe("unknown");
    expect(compactOutcomeOf(undefined)).toBe("unknown");
  });

  it("with no room in Kept drafts, back in the box; the note keeps the uncertain wording", async () => {
    const store = new DraftStore(new MemoryDraftFiles(), { delayMs: 100_000 });
    for (let i = 0; i < keptLimit; i += 1) store.keep("mac-a", "Invented Mac", `old${i}`, null, `old ${i}`, "Its pane is gone.");
    const { c } = await unconfirmedWithNewer(store);
    expect(keptTexts(store)).not.toContain(refused);
    expect(c.box().text).toBe(`${refused}\n${newer}`);
    expect(c.note()).toMatch(/Check the agent before sending again\. Your line is back in the box\.$/);
    expect(c.note()).not.toMatch(/not sent/i);
    expect(compactBoxText(null, "unknown")).toBe("Compact may have gone. Check the agent before sending it again. Your line is back in the box.");
    expect(compactKeptText(null, "unknown")).toBe("Compact may have gone: your line is in Kept drafts. Check the agent before sending it again.");
    expect(returns(c)).toEqual([refused]);
  });
});
