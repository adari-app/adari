// The Model chip's picker (src/renderer/components/AgentChips.tsx,
// ModelPicker.tsx), with the fake hooks: Cursor's list on another Mac read on This Mac shows with its quiet line under
// the read-only one; Claude Code's picker on a running pane says what a pick does. Nothing else in the picker changes.

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

const { AgentChips, chipPickerSpec, cursorFamilyRows, grokDefaultNote } = await import("../src/renderer/components/AgentChips");
const { agentPicks } = await import("../src/renderer/components/agent-picks");
const { modelCatalogStore } = await import("../src/renderer/components/model-catalog-store");
const { ModelPicker, pickerNotes } = await import("../src/renderer/components/ModelPicker");
const { borrowedLine, claudePickNote, isCatalogView, parseCatalog } = await import("../src/shared/model-catalog");
const { demoModelLists } = await import("../src/main/demo/demo-model-lists");

type Node = { type: unknown; props: Record<string, unknown> };
type Agent = "cursor" | "claude";

const line = borrowedLine("Mac mini");

function viewOf(agent: Agent, borrowed: string | null) {
  const parsed = parseCatalog(agent, demoModelLists[agent]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return { agent, models: parsed.models, readAt: 1, error: null, loading: false, none: null, ...(borrowed === null ? {} : { borrowed }) };
}

let catalog: ReturnType<typeof viewOf>;

beforeEach(() => {
  agentPicks.clear();
  modelCatalogStore.clear();
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    herdrDesktop: {
      sendToPane: async () => undefined,
      modelPick: async () => undefined,
      cursorPick: async () => ({ type: "opened" }),
      copyText: () => undefined,
      modelCatalog: async () => catalog,
    },
  });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function hostWith(agent: Agent): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent, agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent, agent_status: "idle" }],
  });
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology, run: { connection: 3, arrivals: { "w1:p1": 2 } } } as unknown as HostView;
}

/** The pane's chips, the Model chip opened, and its picker as it draws. */
async function openPicker(agent: Agent) {
  const row = { paneID: "w1:p1", name: "Notes", workspaceLabel: "notes", kind: agent, isAgent: true, status: "idle" } as unknown as SidebarRow;
  const ui = new HookHost(AgentChips as (props: object) => unknown, { host: hostWith(agent), row });
  ui.render();
  const all = (): Node[] => elements(ui.tree) as Node[];
  const chip = all().find((e) => e.props["className"] === "pick-b" && String(e.props["aria-label"]).startsWith("Model"))!;
  (chip.props["onClick"] as () => void)();
  ui.render();
  await flush();
  ui.render();
  const props = all().find((e) => e.type === ModelPicker)!.props;
  const shown = new HookHost(ModelPicker as (props: object) => unknown, props);
  shown.render();
  const lines = (): { className: unknown; text: unknown }[] =>
    (elements(shown.tree) as Node[]).filter((e) => String(e.props["className"]).startsWith("mp-line")).map((e) => ({ className: e.props["className"], text: e.props["children"] }));
  return { props, lines };
}

describe("Cursor's list on another Mac, read on This Mac", () => {
  it("the picker shows This Mac's list (as Cursor's families) with the quiet line", async () => {
    catalog = viewOf("cursor", line);
    expect(isCatalogView(catalog)).toBe(true);
    const p = await openPicker("cursor");
    // Cursor's running pane picks by family, its rows built from the list shown.
    expect((p.props["models"] as { id: string }[]).map((row) => row.id)).toEqual(cursorFamilyRows(catalog.models).map((row) => row.id));
    expect((p.props["models"] as unknown[]).length).toBeGreaterThan(0);
    expect(p.lines()).toEqual([{ className: "mp-line note", text: line }]);
  });

  it("a machine's own list: no such line", async () => {
    catalog = viewOf("cursor", null);
    const p = await openPicker("cursor");
    expect(p.lines()).toEqual([]);
  });

  it("a view that is not one main sends is refused (the line must be text)", () => {
    expect(isCatalogView({ ...viewOf("cursor", null), borrowed: 3 })).toBe(false);
    expect(isCatalogView({ ...viewOf("cursor", null), borrowed: null })).toBe(true);
  });
});

describe("Claude Code's Model menu says what a pick does", () => {
  it("one quiet line in Claude Code's picker on a running pane; its rows still pick", async () => {
    catalog = viewOf("claude", null);
    const p = await openPicker("claude");
    expect(p.props["note"]).toBe("Claude Code also makes this the default for new sessions on this Mac.");
    expect(p.lines()).toEqual([{ className: "mp-line note", text: claudePickNote }]);
    expect(p.props["readOnly"] ?? null).toBeNull();
  });

  it("Claude Code's and Grok's; Cursor's spec has none", () => {
    const binding = { terminalID: "t-7", isAgent: true, session: null, run: { connection: 3, arrival: 2 } };
    const cursor = chipPickerSpec({ hostId: "mac-mini", paneId: "w1:p1", agent: "cursor", status: "idle", binding: { ...binding, kind: "cursor" } } as never, "mac-mini/w1:p1", viewOf("cursor", null));
    expect(cursor.note).toBeNull();
    // Grok's line is the same kind of quiet line.
    const grok = chipPickerSpec({ hostId: "mac-mini", paneId: "w1:p1", agent: "grok", status: "idle", binding: { ...binding, kind: "grok" } } as never, "mac-mini/w1:p1", null);
    expect(grok.note).toBe(grokDefaultNote);
    const claude = chipPickerSpec({ hostId: "mac-mini", paneId: "w1:p1", agent: "claude", status: "idle", binding: { ...binding, kind: "claude" } } as never, "mac-mini/w1:p1", viewOf("claude", null));
    expect(claude.note).toBe(claudePickNote);
  });

  it("the lines' order: This Mac's line, then the pick's note", () => {
    expect(pickerNotes({ ...viewOf("claude", line) }, claudePickNote)).toEqual([line, claudePickNote]);
    expect(pickerNotes(null, null)).toEqual([]);
  });
});
