// HerdrKit's SidebarModelTests, ported: the same fixture (the user's 0.9.5
// server), the same expectations, through the TS port of SidebarModel.

import { describe, expect, it } from "vitest";

import {
  buildSidebarModel,
  collapsedRowLimit,
  emptyFoldState,
  fold,
  keepSeenDone,
  prioritySectionKinds,
  prioritySectionTitle,
  sidebarInputFromTopology,
  type SidebarInput,
  type SidebarModel,
  type SidebarPane,
} from "../src/shared/sidebar-model";
import { ago, input, nowUnixMs, setting, topology } from "./support/sidebar-fixture";

const model = (i: SidebarInput): SidebarModel => buildSidebarModel(i);
const section = (m: SidebarModel, label: string) => m.projects.find((s) => s.header.label === label);
const row = (m: SidebarModel, pane: string) => m.projects.flatMap((s) => s.rows).find((r) => r.paneID === pane);

describe("Projects", () => {
  it("is one section per workspace in Herdr's order", () => {
    const m = model(input());
    expect(m.mode).toBe("projects");
    expect(m.projects.map((s) => s.header.label)).toEqual([
      "notes",
      "Quartz",
      "Atelier",
      "Sundial",
      "herdr-companion",
      "Meterbox",
      "Inkwell",
      "Starling",
      "Bellhop",
      "Harbor",
      "Tidepool",
    ]);
    expect(m.projects.map((s) => s.header.paneCount)).toEqual([1, 2, 2, 1, 3, 1, 1, 4, 1, 1, 2]);
    expect(m.agentCount).toBe(18);
  });

  it("takes its order from numbers, not from input order", () => {
    const base = input();
    const m = model({ ...base, workspaces: [...base.workspaces].reverse(), tabs: [...base.tabs].reverse() });
    expect(m.projects[0]?.header.label).toBe("notes");
    expect(m.projects[m.projects.length - 1]?.header.label).toBe("Tidepool");
    expect(section(m, "Quartz")?.rows.map((r) => r.paneID)).toEqual(["w2:p1", "w2:p70"]);
  });

  it("puts rows in tab order, then pane order", () => {
    const m = model(input());
    expect(section(m, "Starling")?.rows.map((r) => r.paneID)).toEqual(["wA:p1", "wA:pJ", "wA:pM", "wA:pK"]);
    expect(section(m, "herdr-companion")?.rows.map((r) => r.paneID)).toEqual(["w7:p1", "w7:p1G", "w7:p1H"]);
    const base = input();
    const moon = base.panes.filter((p) => p.workspaceID === "wA");
    const rest = base.panes.filter((p) => p.workspaceID !== "wA");
    const interleaved = model({ ...base, panes: [...rest, moon[1]!, moon[0]!, moon[2]!, moon[3]!] });
    expect(section(interleaved, "Starling")?.rows.map((r) => r.paneID)).toEqual(["wA:p1", "wA:pJ", "wA:pM", "wA:pK"]);
  });

  it("flags a workspace needing you, also when folded", () => {
    const folded = fold.toggleWorkspace(emptyFoldState, "w2", "mac-mini");
    const m = model(setting(input({ fold: folded }), { "w2:p70": ["blocked", undefined] }));
    const quartz = section(m, "Quartz");
    expect(quartz?.header.needsYou).toBe(true);
    expect(quartz?.header.isFolded).toBe(true);
    // The agent that needs you is never folded away (its neighbour is); the header counts it.
    expect(quartz?.rows.map((r) => r.paneID)).toEqual(["w2:p70"]);
    expect(quartz?.header.needsYouCount).toBe(1);
    expect(quartz?.header.paneCount).toBe(2);
    expect(section(m, "Atelier")?.header.needsYou).toBe(false);
    const shell = model(setting(input(), { "w8:p1": ["blocked", undefined] }));
    expect(section(shell, "Meterbox")?.header.needsYou).toBe(false);
    expect(shell.priorityBadge).toBe(0);
  });

  it("shows an empty workspace with zero", () => {
    const base = input();
    const m = model({ ...base, workspaces: [...base.workspaces, { id: "wE", label: "Empty", number: 12 }] });
    expect(section(m, "Empty")?.header).toMatchObject({ isEmpty: true, paneCount: 0 });
    expect(section(m, "Empty")?.rows).toEqual([]);
    expect(section(m, "notes")?.header.isEmpty).toBe(false);
  });

  it("shows five rows and Show N more past five", () => {
    const base = input();
    const extra: SidebarPane[] = [1, 2, 3].map((n) => ({
      paneID: `wA:x${n}`,
      tabID: "wA:t6",
      workspaceID: "wA",
      agentKind: "claude",
      status: "idle",
    }));
    const seven = { ...base, panes: [...base.panes, ...extra] };
    const collapsed = section(model(seven), "Starling");
    expect(collapsed?.rows.map((r) => r.paneID)).toEqual(["wA:p1", "wA:pJ", "wA:pM", "wA:pK", "wA:x1"]);
    expect(collapsed?.hiddenCount).toBe(2);
    expect(collapsed?.canShowLess).toBe(false);
    expect(collapsed?.header.paneCount).toBe(7);
    const expanded = section(model({ ...seven, fold: fold.toggleExpanded(emptyFoldState, "wA", "mac-mini") }), "Starling");
    expect(expanded?.rows).toHaveLength(7);
    expect(expanded?.canShowLess).toBe(true);
    const five = section(model({ ...base, panes: [...base.panes, extra[0]!] }), "Starling");
    expect(five?.rows).toHaveLength(5);
    expect(five?.hiddenCount).toBe(0);
    expect(collapsedRowLimit).toBe(5);
  });
});

describe("Rows", () => {
  it("are named by pane label, then tab label, then kind, then shell", () => {
    const m = model(input());
    expect(row(m, "w7:p1G")).toMatchObject({ name: "aurora-web-mac · opus", nameSource: "paneLabel" });
    expect(row(m, "w2:p1")).toMatchObject({ name: "Notes Fable", nameSource: "tabLabel" });
    expect(row(m, "w5:pH")).toMatchObject({ name: "2", kind: "codex" });
    const base = input();
    const bare = model({
      ...base,
      tabs: base.tabs.map((t) => ({ ...t, label: "  " })),
      panes: [...base.panes, { paneID: "w3:pS", tabID: "w3:t9", workspaceID: "w3", status: "indefinite" }],
    });
    expect(row(bare, "w2:p1")).toMatchObject({ name: "claude", nameSource: "agentKind" });
    expect(row(bare, "w3:pS")).toMatchObject({ name: "shell", nameSource: "shell" });
    expect(row(bare, "w3:p1")?.name).toBe("Workbench");
  });

  it("keeps a shell pane as a row with its kind", () => {
    const shell = row(model(input()), "w8:p1");
    expect(shell).toMatchObject({ isAgent: false, kind: "shell", name: "Notes", glyph: "shell", isDimmed: false });
    expect(shell?.prioritySection).toBeUndefined();
    expect(row(model(input({ shellKind: "zsh" })), "w8:p1")?.kind).toBe("zsh");
  });

  it("marks glyphs, activity, time and dimming", () => {
    const m = model(
      setting(input({ summaries: { "w2:p1": "Edit PaywallView.swift?", "w2:p70": "   " }, seen: ["w6:p1"] }), {
        "w2:p1": ["blocked", ago(1)],
        "w2:p70": ["blocked", ago(12)],
        "w3:p1": ["working", ago(4)],
        "w5:p1": ["done", ago(6)],
        "w6:p1": ["done", ago(18)],
        "w5:pH": ["idle", ago(180)],
        "w9:p1": ["idle", ago(5 * 60 * 24)],
        "wB:p1": ["indefinite", undefined],
        "wC:p1": ["unrecognised", undefined],
      }),
    );
    expect(row(m, "w2:p1")).toMatchObject({ glyph: "needsYou", activity: "Edit PaywallView.swift?", time: "1m" });
    expect(row(m, "w2:p70")?.activity).toBe("Quartz sync retry rollout");
    expect(row(m, "w3:p1")).toMatchObject({ glyph: "working", activity: "Notes status", time: "4m" });
    expect(row(m, "w5:p1")).toMatchObject({ glyph: "doneUnseen", isDimmed: false });
    expect(row(m, "w6:p1")).toMatchObject({ glyph: "idle", isDimmed: true });
    expect(row(m, "w5:pH")).toMatchObject({ glyph: "idle", isDimmed: true, time: "3h" });
    expect(row(m, "w9:p1")?.time).toBe("5d");
    expect(row(m, "wB:p1")).toMatchObject({ glyph: "unknown", isDimmed: false });
    expect(row(m, "wC:p1")?.glyph).toBe("unknown");
    expect(row(m, "wB:p1")?.time).toBeUndefined();
    expect(row(m, "w2:p1")).toMatchObject({ workspaceLabel: "Quartz", cwd: "/Users/demo/code/quartz" });
  });
});

describe("Priority", () => {
  it("has sections, counts and newest first", () => {
    const m = model(
      setting(input({ seen: ["wD:p1"] }), {
        "w2:p1": ["blocked", ago(1)],
        "w5:p1": ["blocked", ago(6)],
        "w3:p1": ["working", ago(4)],
        "w2:p70": ["working", ago(12)],
        "w7:p1G": ["working", ago(6)],
        "w7:p1H": ["working", ago(9)],
        "w6:p1": ["done", ago(18)],
        "w7:p1": ["done", ago(2)],
        "wD:p1": ["done", ago(30)],
        "wB:p1": ["indefinite", undefined],
      }),
    );
    expect(m.priority.map((s) => s.kind)).toEqual(["needsYou", "working", "done", "idle"]);
    expect(m.priority.map((s) => s.count)).toEqual([2, 4, 2, 10]);
    expect(m.priority[0]?.rows.map((r) => r.paneID)).toEqual(["w2:p1", "w5:p1"]);
    expect(m.priority[1]?.rows.map((r) => r.paneID)).toEqual(["w3:p1", "w7:p1G", "w7:p1H", "w2:p70"]);
    expect(m.priority[2]?.rows.map((r) => r.paneID)).toEqual(["w7:p1", "w6:p1"]);
    expect(m.priority[3]?.rows.map((r) => r.paneID)).toEqual([
      "wD:p1",
      "w5:pH",
      "w9:p1",
      "wA:p1",
      "wA:pJ",
      "wA:pM",
      "wA:pK",
      "wB:p1",
      "wC:p1",
      "wD:pK",
    ]);
    expect(m.priority.flatMap((s) => s.rows).some((r) => r.paneID === "w8:p1")).toBe(false);
    expect(m.priority[0]?.rows.map((r) => r.workspaceLabel)).toEqual(["Quartz", "Atelier"]);
    expect(m.priorityBadge).toBe(2);
    expect(prioritySectionKinds.map(prioritySectionTitle)).toEqual(["Needs you", "Working", "Done", "Idle"]);
  });

  it("leaves empty sections out, and sections fold", () => {
    const plain = model(input());
    expect(plain.priority.map((s) => s.kind)).toEqual(["working", "done", "idle"]);
    expect(plain.priority.map((s) => s.count)).toEqual([2, 5, 11]);
    const folded = model(input({ fold: fold.toggleSection({ ...emptyFoldState, mode: "priority" }, "idle") }));
    expect(folded.mode).toBe("priority");
    expect(folded.priority.find((s) => s.kind === "idle")).toMatchObject({ isFolded: true, count: 11, rows: [] });
    expect(folded.priority.find((s) => s.kind === "done")?.rows).toHaveLength(5);
  });

  it("keeps a pane of an unlisted workspace", () => {
    const base = input();
    const m = model({
      ...base,
      panes: [...base.panes, { paneID: "wZ:p1", tabID: "wZ:t1", workspaceID: "wZ", agentKind: "claude", status: "blocked" }],
    });
    expect(row(m, "wZ:p1")).toBeUndefined();
    expect(m.priority[0]?.rows.map((r) => r.paneID)).toEqual(["wZ:p1"]);
    expect(m.priority[0]?.rows[0]?.workspaceLabel).toBe("wZ");
    expect(m.priorityBadge).toBe(1);
  });
});

describe("Search", () => {
  const panes = (query: string) => model(input({ search: query })).projects.flatMap((s) => s.rows).map((r) => r.paneID);

  it("matches name, workspace, activity and kind, ignoring case", () => {
    expect(panes("notes fable")).toEqual(["w2:p1"]);
    expect(panes("QUARTZ")).toEqual(["w2:p1", "w2:p70"]);
    expect(panes("qwen")).toEqual(["w5:pH"]);
    expect(panes("CODEX")).toEqual(["w5:pH", "wA:pM"]);
    expect(panes("shell")).toEqual(["w8:p1"]);
    expect(panes("zzz-nothing")).toEqual([]);
    const blocked = setting(input({ search: "paywallview", summaries: { "w5:p1": "Edit PaywallView.swift?" } }), {
      "w5:p1": ["blocked", undefined],
    });
    expect(model(blocked).projects.flatMap((s) => s.rows).map((r) => r.paneID)).toEqual(["w5:p1"]);
  });

  it("ignores accents", () => {
    expect(panes("QÜÄRTZ")).toEqual(["w2:p1", "w2:p70"]);
  });

  it("keeps only workspaces with matches and ignores folds", () => {
    const base = input({ fold: fold.toggleWorkspace(emptyFoldState, "wA", "mac-mini"), search: "lumen" });
    const m = model({ ...base, workspaces: [...base.workspaces, { id: "wE", label: "lumen-empty", number: 12 }] });
    expect(m.isSearching).toBe(true);
    expect(m.projects.map((s) => s.header.label)).toEqual(["Starling"]);
    expect(m.projects[0]?.header.isFolded).toBe(false);
    expect(m.projects[0]?.rows.map((r) => r.paneID)).toEqual(["wA:p1", "wA:pJ", "wA:pM", "wA:pK"]);
    const blocked = model(setting(input({ search: "harbor" }), { "w2:p1": ["blocked", undefined] }));
    expect(blocked.priority.flatMap((s) => s.rows).map((r) => r.paneID)).toEqual(["wC:p1"]);
    expect(blocked.priorityBadge).toBe(1);
    expect(model(input({ search: "   " })).isSearching).toBe(false);
    expect(model(input({ search: "   " })).projects).toHaveLength(11);
  });

  it("shows every match past five and in folded Priority sections", () => {
    const m = model(input({ search: "claude", fold: fold.toggleSection(emptyFoldState, "idle") }));
    expect(m.priority.find((s) => s.kind === "idle")?.isFolded).toBe(false);
    expect(m.priority.find((s) => s.kind === "idle")?.rows).toHaveLength(9);
    expect(m.projects.every((s) => s.hiddenCount === 0)).toBe(true);
  });
});

describe("Fold state", () => {
  it("toggling twice clears the entry, and another machine's fold changes nothing", () => {
    let toggled = fold.toggleWorkspace(emptyFoldState, "w2", "mac-mini");
    toggled = fold.toggleWorkspace(toggled, "w2", "mac-mini");
    toggled = fold.toggleSection(fold.toggleSection(toggled, "idle"), "idle");
    expect(toggled).toEqual(emptyFoldState);
    let other = fold.toggleWorkspace(emptyFoldState, "w2", "studio");
    other = fold.toggleWorkspace(other, "gone", "mac-mini");
    expect(model(input({ fold: other })).projects).toEqual(model(input()).projects);
  });

  it("decodes leniently", () => {
    const decoded = fold.decode(
      JSON.parse('{"mode":"timeline","foldedWorkspaces":{"mac-mini":["w2"]},"foldedPrioritySections":["idle","archived"],"futureKey":1}'),
    );
    expect(decoded.mode).toBe("projects");
    expect(decoded.foldedPrioritySections).toEqual(["idle"]);
    expect(fold.isFoldedWorkspace(decoded, "w2", "mac-mini")).toBe(true);
    expect(decoded.expandedWorkspaces).toEqual({});
    expect(fold.decode({})).toEqual(emptyFoldState);
    expect(fold.decode(JSON.parse('{"mode":3,"foldedWorkspaces":[1]}'))).toEqual(emptyFoldState);
  });
});

describe("From a session snapshot", () => {
  it("raises menu input to blocked and reads status-since", () => {
    const since = ago(7);
    const agents =
      '[{"pane_id":"w2:p70","agent":"claude","agent_status":"idle","input_pending":true},' +
      `{"pane_id":"w3:p1","agent":"claude","agent_status":"done","status_since_unix_ms":${since}},` +
      `{"pane_id":"w9:p1","agent":"claude","agent_status":"idle","last_completed_turn":{"completed_unix_ms":${ago(125)}}}]`;
    const i = sidebarInputFromTopology(topology(agents), { macID: "mac-mini", nowUnixMs });
    const m = model(i);
    expect(row(m, "w2:p70")?.glyph).toBe("needsYou");
    expect(m.priorityBadge).toBe(1);
    expect(row(m, "w3:p1")?.time).toBe("7m");
    expect(row(m, "w9:p1")?.time).toBe("2h");
    expect(row(m, "w5:p1")?.time).toBeUndefined();
    expect(i.panes.find((p) => p.paneID === "w8:p1")?.agentKind).toBeUndefined();
    expect(i.panes.find((p) => p.paneID === "w2:p1")?.cwd).toBe("/Users/demo/code/quartz");
  });

  it("keeps seen-done only for panes still done", () => {
    const panes = setting(input(), { "w6:p1": ["working", undefined] }).panes;
    expect([...keepSeenDone(new Set(["w3:p1", "w6:p1", "gone"]), panes)]).toEqual(["w3:p1"]);
  });
});
