// src/renderer/components/AgentChips.tsx chipPickerSpec and chipRowRequest:
// Cursor's Model chip on a running pane lists its families, one row each, named as Cursor's own `/model` list names
// them (cursor-02: "Grok 4.7", "Claude Opus 5.5", "Auto"), the footer's family ticked. A row is a live pick: main types
// `/model <family name>` (cursor-06: Cursor switches at once). A family whose name is inside another's ("Claude Opus 5"
// in "Claude Opus 5.5": cursor-08) is never typed: its row opens Cursor's own list in the Terminal and its title says
// so. "Choose in the Terminal…" stays.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { AgentChips, chipPickerSpec, chipRowRequest } = await import("../src/renderer/components/AgentChips");
const { agentPicks } = await import("../src/renderer/components/agent-picks");
const { modelCatalogStore } = await import("../src/renderer/components/model-catalog-store");
const { ModelPicker } = await import("../src/renderer/components/ModelPicker");
const { parseCatalog } = await import("../src/shared/model-catalog");
const { demoModelLists } = await import("../src/main/demo/demo-model-lists");

type Node = { type: unknown; props: Record<string, unknown> };

/** Everything the page asked main for: a typed line, a model pick, a Cursor menu drive. */
let asked: unknown[][];

function cursorView() {
  const parsed = parseCatalog("cursor", demoModelLists.cursor);
  if (!parsed.ok) throw new Error(parsed.reason);
  return { agent: "cursor" as const, models: parsed.models, readAt: 1, error: null, loading: false, none: null };
}

beforeEach(() => {
  asked = [];
  agentPicks.clear();
  modelCatalogStore.clear();
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    herdrDesktop: {
      sendToPane: async (_hostId: string, paneId: string, text: string) => void asked.push(["send", paneId, text]),
      modelPick: async (_hostId: string, paneId: string, pick: unknown) => void asked.push(["modelPick", paneId, pick]),
      cursorPick: async (_hostId: string, paneId: string, pick: unknown) => {
        asked.push(["cursorPick", paneId, pick]);
        return { type: "opened" };
      },
      copyText: () => undefined,
      modelCatalog: async () => cursorView(),
    },
  });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function hostWith(status = "idle"): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "cursor", agent_status: status, revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "cursor", agent_status: status }],
  });
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology, run: { connection: 3, arrivals: { "w1:p1": 2 } } } as unknown as HostView;
}

const row = { paneID: "w1:p1", name: "Notes", workspaceLabel: "notes", kind: "cursor", isAgent: true, status: "idle" } as unknown as SidebarRow;
const key = "mac-mini/w1:p1";
const footer = { model: "Grok 4.7", window: "256K", effort: "medium" as const, fast: true, percent: null };

/** The Cursor pane's chips with its footer read, the Model chip open, and the picker it shows. */
async function openPicker() {
  agentPicks.receiveFooter(key, { scope: { terminalID: "t-7", session: null }, footer });
  const ui = new HookHost(AgentChips as (props: object) => unknown, { host: hostWith(), row });
  ui.render();
  const all = (): Node[] => elements(ui.tree) as Node[];
  const chip = all().find((e) => e.props["className"] === "pick-b" && String(e.props["aria-label"]).startsWith("Model"))!;
  expect(chip.props["aria-label"]).toBe("Model: Grok 4.7");
  (chip.props["onClick"] as () => void)();
  ui.render();
  await flush();
  ui.render();
  const props = all().find((e) => e.type === ModelPicker)!.props;
  // The picker as it draws (its rows, its line, its action).
  const shown = new HookHost(ModelPicker as (props: object) => unknown, props);
  shown.render();
  const drawn = (): Node[] => elements(shown.tree) as Node[];
  const keyDown = (name: string): void => {
    const root = drawn().find((e) => e.props["role"] === "dialog")!;
    (root.props["onKeyDown"] as (event: object) => void)({ key: name, preventDefault: () => undefined, stopPropagation: () => undefined });
    shown.render();
  };
  const type = (text: string): void => {
    (drawn().find((e) => e.type === "input")!.props["onChange"] as (event: object) => void)({ target: { value: text } });
    shown.render();
  };
  return { props, drawn, options: () => drawn().filter((e) => e.props["role"] === "option"), keyDown, type };
}

describe("Cursor's Model chip on a running pane lists its families; a row picks", () => {
  it("one row per family as Cursor's list names it, no ids beside; the footer's family ticked; \"Choose in the Terminal…\" there", async () => {
    const p = await openPicker();
    expect(p.props["readOnly"]).toBeNull();
    expect(p.props["hideIds"]).toBe(true);
    const models = p.props["models"] as { id: string; label: string }[];
    const names = models.map((model) => model.label);
    expect(names[0]).toBe("Auto");
    expect(names).toContain("Grok 4.7");
    expect(names).toContain("Composer 2.5");
    expect(new Set(names).size).toBe(names.length);
    // The footer reads "Grok 4.7" (Medium, Fast): its family's row is the one ticked.
    expect(models.find((model) => model.id === p.props["current"])!.label).toBe("Grok 4.7");
    p.type("grok 4.7");
    const ticked = p.options().filter((e) => e.props["aria-selected"] === true);
    expect(ticked).toHaveLength(1);
    expect(ticked[0]!.props["aria-disabled"]).toBe(false);
    // No id at the row's right: Cursor's own name only.
    expect(elements(ticked[0]!.props["children"]).some((e) => (e as Node).props["className"] === "id")).toBe(false);
    const act = p.drawn().find((e) => e.props["className"] === "mp-act")!;
    expect(act.props["children"]).toBe("Choose in the Terminal\u{2026}");
  });

  it("a plain family's row is a model pick main types as /model <family>; the chip shows it meanwhile", async () => {
    const p = await openPicker();
    const models = p.props["models"] as { id: string; label: string }[];
    const composer = models.find((model) => model.label === "Composer 2.5")!;
    (p.props["onPick"] as (id: string | null) => void)(composer.id);
    await flush();
    expect(asked).toEqual([["modelPick", "w1:p1", { agent: "cursor", model: composer.id, effort: null }]]);
    expect(agentPicks.chip(key, "model", { terminalID: "t-7", isAgent: true, kind: "cursor", session: null, run: { connection: 3, arrival: 2 } }).label).toBe("Composer 2.5");
  });

  it("main's answer \"Composer 2.5 Fast\" (no footer reads): the chip and the row tick stay on Composer 2.5 past the wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      const answering = (window as unknown as { herdrDesktop: Record<string, unknown> }).herdrDesktop;
      answering["modelPick"] = async (_hostId: string, paneId: string, pick: unknown) => {
        asked.push(["modelPick", paneId, pick]);
        return { type: "cursor", modelLine: "Composer 2.5 Fast", footer: null };
      };
      const p = await openPicker();
      const models = p.props["models"] as { id: string; label: string }[];
      const composer = models.find((model) => model.label === "Composer 2.5")!;
      (p.props["onPick"] as (id: string | null) => void)(composer.id);
      await flush();
      const binding = { terminalID: "t-7", isAgent: true, kind: "cursor", session: null, run: { connection: 3, arrival: 2 } };
      const context = { hostId: "mac-mini", paneId: "w1:p1", agent: "cursor" as const, status: "idle", binding };
      for (const later of [10_001, 600_000]) {
        vi.setSystemTime(1_000_000 + later);
        expect(agentPicks.chip(key, "model", binding).label).toBe("Composer 2.5");
        const spec = chipPickerSpec(context as never, key, cursorView());
        expect(spec.models.find((model) => model.id === spec.current)!.label).toBe("Composer 2.5");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a family inside another's opens Cursor's own list in the Terminal, nothing typed; its title says why", async () => {
    const p = await openPicker();
    const models = p.props["models"] as { id: string; label: string; note?: string }[];
    const nestedFamily = models.find((model) => model.label === "Claude Opus 5")!;
    expect(nestedFamily.note).toBe("Opens Cursor's own list in the Terminal: typed, \u{201C}Claude Opus 5\u{201D} would pick Claude Opus 5.5.");
    p.type("claude opus 5");
    const row = p.options().find((e) => elements(e.props["children"]).some((c) => (c as Node).props["children"] === "Claude Opus 5"))!;
    expect(row.props["title"]).toBe(nestedFamily.note);
    (p.props["onPick"] as (id: string | null) => void)(nestedFamily.id);
    await flush();
    expect(asked).toEqual([["cursorPick", "w1:p1", { kind: "model" }]]);
  });

  it("\"Choose in the Terminal…\" opens Cursor's own /model list there (its menu driver), as before", async () => {
    const p = await openPicker();
    const act = p.drawn().find((e) => e.props["className"] === "mp-act")!;
    (act.props["onClick"] as () => void)();
    await flush();
    expect(asked).toEqual([["cursorPick", "w1:p1", { kind: "model" }]]);
  });

  it("chipPickerSpec and each row's request: families, no default row (Auto is one), the Terminal action", () => {
    agentPicks.receiveFooter(key, { scope: { terminalID: "t-7", session: null }, footer });
    const context = { hostId: "mac-mini", paneId: "w1:p1", agent: "cursor" as const, status: "idle", binding: { terminalID: "t-7", isAgent: true, kind: "cursor", session: null, run: { connection: 3, arrival: 2 } } };
    const view = cursorView();
    const spec = chipPickerSpec(context as never, key, view);
    expect(spec).toMatchObject({ agent: "cursor", readOnly: null, note: null, hideIds: true, action: "terminal-pick", defaultRow: null });
    const auto = spec.models.find((model) => model.label === "Auto")!;
    expect(chipRowRequest(spec, view, auto.id, null)).toMatchObject({ kind: "model", label: "Auto", command: "/model Auto" });
    const nestedFamily = spec.models.find((model) => model.label === "Claude Opus 5")!;
    expect(chipRowRequest(spec, view, nestedFamily.id, null)).toEqual({ kind: "model", value: "picker", label: "Choosing\u{2026}" });
    expect(chipRowRequest(spec, view, null, null)).toBeNull();
  });
});
