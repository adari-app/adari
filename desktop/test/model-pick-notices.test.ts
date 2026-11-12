// The Model menu and chips on the page (and main's footer reads), with fixtures/livepick's live frames as
// the screens.
// - A model pick not sent says why in the Model menu (ModelPicker's `notice`), until the next pick or until a
//   menu that showed it closes; a row the menu shows either picks or says why not.
// - Cursor's chip reads a model line with no effort word ("Composer 2.5 Fast", "Auto") from any footer read,
//   whoever changed it; main's footer reads carry it (cursor-live-02).
// - The same footer read again after a pick back replaces the kept line; a footer read under another run
//   never removes it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import type { SendBinding } from "../src/shared/send-binding";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HookHost, elements } from "./support/fake-hooks";
import { frame } from "./support/livepick-frames";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { AgentChips, rowRefusedText, runningModel } = await import("../src/renderer/components/AgentChips");
const { AgentPicks, agentPicks } = await import("../src/renderer/components/agent-picks");
const { modelCatalogStore } = await import("../src/renderer/components/model-catalog-store");
const { ModelPicker } = await import("../src/renderer/components/ModelPicker");
const { parseCatalog } = await import("../src/shared/model-catalog");
const { demoModelLists } = await import("../src/main/demo/demo-model-lists");
const { cursorModelLineOf, parseCursorFooter, readCursorModelMatches, readCursorScreen } = await import("../src/shared/agent-settings");
const { grokRowOfScreenName, grokSwitchedNames } = await import("../src/shared/model-choices");

type Node = { type: unknown; props: Record<string, unknown> };

let asked: unknown[][];

function viewOf(agent: "grok" | "cursor") {
  const parsed = parseCatalog(agent, demoModelLists[agent]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return { agent, models: parsed.models, readAt: 1, error: null, loading: false, none: null };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function hostWith(kind: string): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: kind, agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: kind, agent_status: "idle" }],
  });
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology, run: { connection: 3, arrivals: { "w1:p1": 2 } } } as unknown as HostView;
}

const rowOf = (kind: string) => ({ paneID: "w1:p1", name: "Notes", workspaceLabel: "notes", kind, isAgent: true, status: "idle" }) as unknown as SidebarRow;
const key = "mac-mini/w1:p1";
const bindingOf = (kind: string): SendBinding => ({ terminalID: "t-7", isAgent: true, kind, session: null, run: { connection: 3, arrival: 2 } });

beforeEach(() => {
  asked = [];
  agentPicks.clear();
  modelCatalogStore.clear();
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    herdrDesktop: {
      sendToPane: async () => undefined,
      modelPick: async (_hostId: string, paneId: string, pick: unknown) => {
        asked.push(["modelPick", paneId, pick]);
        throw new Error("Error invoking remote method 'herdr:model-pick': Error: Not sent: Grok's box has text in it. Send or clear it, then pick again.");
      },
      copyText: () => undefined,
      modelCatalog: async (_hostId: string, agent: "grok" | "cursor") => viewOf(agent),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

/** The pane's chips, its Model chip opened, and the picker's props as drawn. */
async function chips(kind: "grok" | "cursor") {
  const ui = new HookHost(AgentChips as (props: object) => unknown, { host: hostWith(kind), row: rowOf(kind) });
  ui.render();
  const all = (): Node[] => elements(ui.tree) as Node[];
  const toggle = async (): Promise<void> => {
    const chip = all().find((e) => e.props["className"] === "pick-b" && String(e.props["aria-label"]).startsWith("Model"))!;
    (chip.props["onClick"] as () => void)();
    ui.render();
    await flush();
    ui.render();
  };
  const picker = (): Record<string, unknown> | null => all().find((e) => e.type === ModelPicker)?.props ?? null;
  return { ui, toggle, picker };
}

describe("the Model menu says why a pick was not sent", () => {
  it("Grok: refused in main; the menu reopened shows the line; it goes when that menu closes; the pick's own line is set again by the next refusal", async () => {
    const c = await chips("grok");
    await c.toggle();
    expect(c.picker()!["notice"]).toBeNull();
    (c.picker()!["onPick"] as (id: string | null) => void)("grok-4.6");
    // The row's click closes the menu first (ModelPicker's choose), then picks.
    await c.toggle();
    await flush();
    c.ui.render();
    expect(asked).toHaveLength(1);
    const line = "Not set: Grok's box has text in it. Send or clear it, then pick again.";
    expect(agentPicks.modelNotSent(key, bindingOf("grok"))).toBe(line);
    // Reopened: the line is there, drawn over the rows.
    await c.toggle();
    expect(c.picker()!["notice"]).toBe(line);
    const drawn = new HookHost(ModelPicker as (props: object) => unknown, c.picker()!);
    drawn.render();
    const status = (elements(drawn.tree) as Node[]).find((e) => e.props["role"] === "status")!;
    expect(status.props["className"]).toBe("mp-line notsent");
    expect(status.props["children"]).toBe(line);
    // Closed: gone; opened again: none.
    await c.toggle();
    expect(agentPicks.modelNotSent(key, bindingOf("grok"))).toBeNull();
    await c.toggle();
    expect(c.picker()!["notice"]).toBeNull();
  });

  it("a line set while the menu is open stays for its next opening; the next model pick takes it away", () => {
    const picks = new AgentPicks({ send: async () => undefined, openCodePick: async () => ({ type: "refused", note: "Not set: x." }), copy: () => undefined, now: () => 1 });
    const context = { hostId: "mac-mini", paneId: "w1:p1", agent: "opencode" as const, status: "working" as const, binding: bindingOf("opencode") };
    picks.modelMenuOpened(key);
    picks.pick(context, { kind: "model", value: "opencode/beam-free", label: "Beam Free", openCodeModel: "opencode/beam-free" });
    expect(picks.modelNotSent(key, context.binding)).toBe("Not set: OpenCode's model can be picked when OpenCode is idle.");
    picks.modelMenuClosed(key);
    expect(picks.modelNotSent(key, context.binding)).not.toBeNull();
    picks.modelMenuOpened(key);
    picks.pick({ ...context, status: "idle" }, { kind: "model", value: "x", label: "x" });
    expect(picks.modelNotSent(key, context.binding)).toBe("Not set: that is not one of the menu's choices.");
    // Another terminal in the pane: not its line.
    expect(picks.modelNotSent(key, { ...context.binding, terminalID: "t-8" })).toBeNull();
    // An Effort pick leaves the Model menu's line alone.
    picks.pick({ ...context, agent: "claude", status: "idle", binding: bindingOf("claude") }, { kind: "effort", value: "nope", label: "Nope" });
    expect(picks.modelNotSent(key, context.binding)).toBe("Not set: that is not one of the menu's choices.");
  });

  it("a row the menu shows that makes no pick here says why (never silent)", async () => {
    const c = await chips("grok");
    await c.toggle();
    // A row whose id the list checked does not take (a row from a list read before).
    (c.picker()!["onPick"] as (id: string | null) => void)("grok-9");
    expect(asked).toEqual([]);
    expect(agentPicks.modelNotSent(key, bindingOf("grok"))).toBe(rowRefusedText("grok", viewOf("grok")));
    expect(rowRefusedText("opencode", null)).toBe("Not set: OpenCode's list on this machine is still being read. Pick again once it shows.");
  });
});

describe("the row tick and chips read Grok's kept pick", () => {
  it("runningModel and the chips: the kept pick, whatever Grok's files say", async () => {
    (window as unknown as { herdrDesktop: Record<string, unknown> }).herdrDesktop["modelPick"] = async () => ({ type: "grok", confirmed: true, shown: "Grok 4.7 Fast", said: "Grok 4.7 Fast", effort: "low" });
    const binding = bindingOf("grok");
    agentPicks.receive(key, { scope: { terminalID: "t-7", session: null }, model: "grok-4.6", modelLabel: "Grok 4.6", effort: "low" } as never, null);
    const context = { hostId: "mac-mini", paneId: "w1:p1", agent: "grok" as const, status: "idle" as const, binding };
    const models = viewOf("grok").models;
    const request = (await import("../src/renderer/components/AgentChips")).modelPickRequest("grok", models, "grok-4.7-build-fast", null)!;
    agentPicks.pick(context, request);
    await flush();
    expect(runningModel(context, key, models)).toEqual({ id: "grok-4.7-build-fast", label: "Grok 4.7 Build Fast" });
    expect(agentPicks.chip(key, "model", binding).label).toBe("Grok 4.7 Build Fast");
    expect(agentPicks.chip(key, "effort", binding).label).toBe("Low");
  });
});

describe("Cursor's chip reads a model line with no effort word, whoever changed it", () => {
  const scope = { terminalID: "t-7", session: null };
  const run = { connection: 3, arrival: 2 };
  const grok47 = { model: "Grok 4.7", window: "256K", effort: "medium" as const, fast: false, percent: null };

  it("footers \"Composer 2.5 Fast\" and \"Auto\" arriving without an app pick update the chip; a footer that reads replaces them", () => {
    const picks = new AgentPicks({ send: async () => undefined, copy: () => undefined, now: () => 1 });
    const binding = bindingOf("cursor");
    picks.receiveFooter(key, { scope, run, footer: grok47 });
    expect([picks.chip(key, "model", binding).label, picks.chip(key, "effort", binding).label]).toEqual(["Grok 4.7", "Medium"]);
    // cursor-live-02: Return pressed by hand in its terminal: "Composer 2.5 Fast", no effort word.
    const screen = frame("cursor-live-02-after-enter");
    expect(parseCursorFooter(screen)).toBeNull();
    expect(cursorModelLineOf(screen)).toBe("Composer 2.5 Fast");
    picks.receiveFooter(key, { scope, run, footer: null, modelLine: cursorModelLineOf(screen) });
    expect([picks.chip(key, "model", binding).label, picks.chip(key, "effort", binding).label]).toEqual(["Composer 2.5", "Default"]);
    picks.receiveFooter(key, { scope, run, footer: null, modelLine: "Auto" });
    expect(picks.chip(key, "model", binding).label).toBe("Auto");
    expect(picks.cursorFooter(key, binding)).toBeNull();
    picks.receiveFooter(key, { scope, run, footer: grok47 });
    expect(picks.chip(key, "model", binding).label).toBe("Grok 4.7");
  });

  it("the same footer read again after a pick back (no null between) replaces the kept line", () => {
    const picks = new AgentPicks({ send: async () => undefined, copy: () => undefined, now: () => 1 });
    const binding = bindingOf("cursor");
    picks.receiveFooter(key, { scope, run, footer: grok47 });
    // A pick to Composer 2.5: main's answer is its line (no footer reads), kept; the footer held is still Grok 4.7's.
    (picks as unknown as { cursorLines: Map<string, unknown> }).cursorLines.set(key, { scope, run, line: "Composer 2.5 Fast", family: "Composer 2.5" });
    expect(picks.chip(key, "model", binding).label).toBe("Composer 2.5");
    // The pick back to Grok 4.7 answers the same footer as the one held: it still replaces the line.
    picks.receiveFooter(key, { scope, run, footer: grok47 });
    expect(picks.cursorModelLine(key, binding)).toBeNull();
    expect(picks.chip(key, "model", binding).label).toBe("Grok 4.7");
  });

  it("a footer read under another run never removes this run's kept line", () => {
    const picks = new AgentPicks({ send: async () => undefined, copy: () => undefined, now: () => 1 });
    const binding = bindingOf("cursor");
    picks.receiveFooter(key, { scope, run, footer: null, modelLine: "Composer 2.5 Fast" });
    picks.receiveFooter(key, { scope, run: { connection: 3, arrival: 1 }, footer: grok47 });
    expect(picks.cursorModelLine(key, binding)).toEqual({ line: "Composer 2.5 Fast", family: "Composer 2.5" });
    expect(picks.chip(key, "model", binding).label).toBe("Composer 2.5");
  });
});

describe("the live frames as the readers see them", () => {
  it("Cursor's own list under a typed /model (cursor-live-01, -03); the after-Return line (cursor-live-02)", () => {
    expect(readCursorModelMatches(frame("cursor-live-01-typed-not-sent"))).toEqual({ draft: "/model Composer 2.5", query: "Composer 2.5", marked: "Composer 2.5" });
    expect(readCursorModelMatches(frame("cursor-live-03-typed-grok47"))).toEqual({ draft: "/model Grok 4.7", query: "Grok 4.7", marked: "Grok 4.7" });
    // That screen is not the box: the screen reader reads it as "other".
    expect(readCursorScreen(frame("cursor-live-01-typed-not-sent")).kind).toBe("other");
    expect(readCursorModelMatches(frame("cursor-live-02-after-enter"))).toBeNull();
    expect(readCursorModelMatches(frame("cursor-02-list-open"))).toBeNull();
  });

  it("Grok's names on screen to its list's rows (grok-live-01: \"Grok 4.7 Fast\" is grok-4.7-build-fast)", () => {
    const models = viewOf("grok").models;
    expect(models.find((model) => model.id === "grok-4.7-build-fast")!.label).toBe("Grok 4.7 Build Fast");
    expect(grokRowOfScreenName(models, "Grok 4.7 Fast")).toBe("grok-4.7-build-fast");
    expect(grokRowOfScreenName(models, "Grok 4.7")).toBe("grok-4.7");
    expect(grokRowOfScreenName(models, "Grok 4.6")).toBe("grok-4.6");
    expect(grokRowOfScreenName(models, "Grok 4.7 Turbo")).toBeNull();
    expect(grokRowOfScreenName(models, "Grok 5")).toBeNull();
    expect(grokSwitchedNames(frame("grok-live-01-footer-47-fast"))).toEqual([
      { name: "Grok 4.6", effort: "low" },
      { name: "Grok 4.7 Fast", effort: "low" },
    ]);
  });
});

// MARK: - main's footer reads carry the model line and Grok's border's name

const { LiveReads } = await import("../src/main/chat/live-reads");
const { HostRegistry } = await import("../src/main/hosts");
const { PaneReadGate } = await import("../src/shared/chat/live-reader");
const { backend, FakeHerdr, snapshot } = await import("./support/prompt-herdr");
type ShownChat = import("../src/main/chat/service").ShownChat;
type ChatOwner = import("../src/main/chat/service").ChatOwner;

class ScreenHerdr extends FakeHerdr {
  shown = "";

  override roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: unknown; method: string; params: Record<string, unknown> };
    if (request.method !== "pane.read" || request.params["pane_id"] !== "w1:p3") return super.roundTrip(line);
    this.requests.push(line);
    const read = { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1", source: "recent", format: "text", text: this.shown, revision: 1, truncated: false };
    return Promise.resolve(JSON.stringify({ id: request.id, result: { type: "pane_read", read } }));
  }
}

describe("main's footer reads (LiveReads)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const [kind, shown] of [
    ["cursor", "cursor-live-02-after-enter"],
    ["grok", "grok-live-01-footer-47-fast"],
  ] as const) {
    it(`${kind}: the shown Chat's read carries ${kind === "cursor" ? "the model line with no effort word" : "the border's model name"} (${shown})`, async () => {
      const json = snapshot();
      const pane = (json["panes"] as Record<string, unknown>[])[2]!;
      pane["agent"] = kind;
      pane["agent_status"] = "idle";
      const herdr = new ScreenHerdr(json, {});
      herdr.shown = frame(shown);
      const registry = new HostRegistry(() => undefined);
      registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
      await registry.refreshAll();
      const events: Record<string, unknown>[] = [];
      const owner: ChatOwner = { id: 1, send: () => undefined, isDestroyed: () => false };
      const chats: ShownChat[] = [{ owner, slot: "", follow: 1, hostId: "mac", paneId: "w1:p3" }];
      const live = new LiveReads(registry, () => chats, () => undefined, {
        gate: new PaneReadGate(),
        footer: (_chat, event) => events.push(event as never),
        mode: (_chat, event) => events.push(event as never),
      });
      live.sync();
      await vi.advanceTimersByTimeAsync(0);
      const last = events.at(-1)!;
      if (kind === "cursor") expect(last).toMatchObject({ footer: null, modelLine: "Composer 2.5 Fast" });
      else expect(last).toMatchObject({ agent: "grok", mode: "alwaysApprove", borderModel: "Grok 4.7 Fast" });
      live.closeAll();
    });
  }
});
