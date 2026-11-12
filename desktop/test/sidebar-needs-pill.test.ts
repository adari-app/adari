// An agent that needs the user jumps out from the list on the left, following
// how T3 Code does it: an agent whose Herdr status is needs-you (blocked)
// stands out in its own row, as T3 Code's thread status pill (apps/web/src/components/Sidebar.logic.ts
// resolveThreadStatusPill): its dot turns T3's amber and a short pill reads
// "Pending Approval" (amber) when the Needs card's matcher reads an approval
// (an edit, a command, a file to create) or "Awaiting Input" (indigo) for a
// question or a kind not known. It is never collapsed under "Show N more" or
// a folded project, whose header shows the amber dot and the count. The pill
// and the color go the moment Herdr's status leaves needs-you. Working, idle
// and done rows are as they were. Light and dark both (the window is dark;
// the tokens carry both). The real Sidebar and App on the small hooks host.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { demoAskScreen } from "../src/main/demo/demo-prompts";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { buildDesktopSidebar, rowKey } from "../src/shared/desktop-sidebar";
import type { AppCommand, HostView } from "../src/shared/ipc-contract";
import { needsPill, needsPillColors, needsPillKind, needsPillKinds, needsPillLabel, type NeedsPillKind } from "../src/shared/needs-pill";
import { matchPrompt, readingForAgent, readingMatch, type PromptMatch, type PromptReading } from "../src/shared/prompt/matcher";
import type { PanePrompt } from "../src/shared/prompt/view";
import {
  buildSidebarModel,
  collapsedRowLimit,
  emptyFoldState,
  fold,
  type SidebarFoldState,
  type SidebarInput,
  type SidebarModel,
  type SidebarPane,
  type SidebarRow,
} from "../src/shared/sidebar-model";
import type { ViewCommand } from "../src/shared/view-commands";
import { HookHost, elements } from "./support/fake-hooks";
import { L, Launch } from "./support/prompt-fixtures";
import { input, setting } from "./support/sidebar-fixture";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { App } = await import("../src/renderer/App");
const { Sidebar } = await import("../src/renderer/components/Sidebar");

const styles = path.join(__dirname, "../src/renderer/styles");
const css = (name: string): string => readFileSync(path.join(styles, name), "utf8");

const model = (i: SidebarInput): SidebarModel => buildSidebarModel(i);
const section = (m: SidebarModel, label: string) => m.projects.find((s) => s.header.label === label);
const ids = (rows: readonly SidebarRow[] | undefined) => rows?.map((row) => row.paneID);

function match(text: string, kind: string | null = "claude"): PromptMatch {
  const found = readingMatch(readingForAgent(matchPrompt(text, "w1:p1"), kind));
  if (found === null) throw new Error("expected a match");
  return found;
}

/** The fixture's workspace wA (4 panes) with `extra` more idle agents. */
function workspaceA(extra: number, base: SidebarInput = input()): SidebarInput {
  const more: SidebarPane[] = Array.from({ length: extra }, (_, n) => ({
    paneID: `wA:x${n + 1}`,
    tabID: "wA:t6",
    workspaceID: "wA",
    agentKind: "claude",
    status: "idle",
  }));
  return { ...base, panes: [...base.panes, ...more] };
}

const withFold = (i: SidebarInput, state: SidebarFoldState): SidebarInput => ({ ...i, fold: state });

describe("never hidden: not under Show N more, not under a folded project", () => {
  it("a folded project keeps the agent that needs you, and its header has the dot and the count", () => {
    const folded = fold.toggleWorkspace(emptyFoldState, "w2", "mac-mini");
    const m = model(setting(input({ fold: folded }), { "w2:p70": ["blocked", undefined] }));
    const secondProject = section(m, "Quartz");
    expect(secondProject?.header.isFolded).toBe(true);
    expect(secondProject?.header.needsYou).toBe(true);
    expect(secondProject?.header.needsYouCount).toBe(1);
    expect(secondProject?.header.paneCount).toBe(2);
    // Only the agent that needs you stays; its folded neighbour does not.
    expect(ids(secondProject?.rows)).toEqual(["w2:p70"]);
    expect(secondProject?.hiddenCount).toBe(0);
    expect(secondProject?.canShowLess).toBe(false);
    expect(section(m, "Atelier")?.header.needsYouCount).toBe(0);
    // Two that need you: both stay, the count says two.
    const two = model(setting(input({ fold: folded }), { "w2:p70": ["blocked", undefined], "w2:p1": ["blocked", undefined] }));
    expect(ids(section(two, "Quartz")?.rows)).toEqual(["w2:p1", "w2:p70"]);
    expect(section(two, "Quartz")?.header.needsYouCount).toBe(2);
    // Folded with nobody needing you: no rows, as before.
    expect(section(model(input({ fold: folded })), "Quartz")?.rows).toEqual([]);
  });

  it("an agent past the first five stays out of Show N more", () => {
    const seven = setting(workspaceA(3), { "wA:x3": ["blocked", undefined] });
    const collapsed = section(model(seven), "Starling");
    expect(ids(collapsed?.rows)).toEqual(["wA:p1", "wA:pJ", "wA:pM", "wA:pK", "wA:x1", "wA:x3"]);
    expect(collapsed?.hiddenCount).toBe(1);
    expect(collapsed?.canShowLess).toBe(false);
    expect(collapsed?.header.needsYouCount).toBe(1);
    // Show more shows them all; Show less leaves it in place.
    const expanded = section(model(withFold(seven, fold.toggleExpanded(emptyFoldState, "wA", "mac-mini"))), "Starling");
    expect(expanded?.rows).toHaveLength(7);
    expect(expanded?.canShowLess).toBe(true);
    // Six rows and the sixth needs you: nothing is left to hide, so no line at all.
    const six = setting(workspaceA(2), { "wA:x2": ["blocked", undefined] });
    const all = section(model(six), "Starling");
    expect(all?.rows).toHaveLength(6);
    expect(all?.hiddenCount).toBe(0);
    expect(all?.canShowLess).toBe(false);
    const sixExpanded = section(model(withFold(six, fold.toggleExpanded(emptyFoldState, "wA", "mac-mini"))), "Starling");
    expect(sixExpanded?.rows).toHaveLength(6);
    expect(sixExpanded?.canShowLess).toBe(false);
  });

  it("working and idle rows fold as before", () => {
    const working = setting(workspaceA(3), { "wA:x3": ["working", undefined] });
    const collapsed = section(model(working), "Starling");
    expect(ids(collapsed?.rows)).toEqual(["wA:p1", "wA:pJ", "wA:pM", "wA:pK", "wA:x1"]);
    expect(collapsed?.hiddenCount).toBe(2);
    expect(collapsed?.header.needsYouCount).toBe(0);
    expect(collapsedRowLimit).toBe(5);
    const folded = fold.toggleWorkspace(emptyFoldState, "wA", "mac-mini");
    expect(section(model(withFold(working, folded)), "Starling")?.rows).toEqual([]);
  });

  it("Priority puts it first, as it does today", () => {
    const m = model(setting(input({ fold: { ...emptyFoldState, mode: "priority" } }), { "w2:p70": ["blocked", undefined] }));
    expect(m.priority[0]?.kind).toBe("needsYou");
    expect(ids(m.priority[0]?.rows)).toEqual(["w2:p70"]);
  });
});

describe("the pill's words: the Needs card's matcher decides", () => {
  it("reads an approval for an edit, a command and a file to create", () => {
    expect(needsPillKind(match(Launch.pairingPrompt))).toBe("approval");
    expect(needsPillKind(match(L.claude2_1_303Bash))).toBe("approval");
    expect(needsPillKind(match(L.claude2_1_303Write))).toBe("approval");
  });

  it("reads input for a question, and for a kind not known", () => {
    expect(needsPillKind(match(demoAskScreen))).toBe("input");
    expect(needsPillKind(null)).toBe("input");
    expect(needsPillKind(undefined)).toBe("input");
  });

  it("says T3's words", () => {
    expect(needsPillLabel.approval).toBe("Pending Approval");
    expect(needsPillLabel.input).toBe("Awaiting Input");
  });

  it("is only for a row Herdr says needs you, and goes when its status leaves", () => {
    const m = model(setting(input(), { "w2:p70": ["blocked", undefined], "w2:p1": ["working", undefined] }));
    const blocked = m.projects.flatMap((s) => s.rows).find((row) => row.paneID === "w2:p70")!;
    expect(needsPill(blocked, "approval")).toEqual({ kind: "approval", label: "Pending Approval" });
    expect(needsPill(blocked, "input")).toEqual({ kind: "input", label: "Awaiting Input" });
    expect(needsPill(blocked, undefined)).toEqual({ kind: "input", label: "Awaiting Input" });
    // Every other row: none, whatever the reading says.
    for (const row of m.projects.flatMap((s) => s.rows).filter((r) => r.glyph !== "needsYou")) {
      expect(needsPill(row, "approval"), row.paneID).toBeNull();
    }
    const after = model(setting(input(), { "w2:p70": ["working", undefined] }));
    const moved = after.projects.flatMap((s) => s.rows).find((row) => row.paneID === "w2:p70")!;
    expect(needsPill(moved, "approval")).toBeNull();
  });

  it("keys each blocked pane's kind by its row (a reading not matched is input)", () => {
    const prompt = (paneId: string, reading: PromptReading | null): PanePrompt => ({
      hostId: "host",
      paneId,
      episode: "e1",
      incarnation: 1,
      connection: 1,
      epoch: null,
      reading,
      quiet: false,
      cleared: false,
    });
    const kinds = needsPillKinds([
      prompt("w1:p1", { type: "matched", match: match(Launch.pairingPrompt) }),
      prompt("w1:p2", { type: "matched", match: match(demoAskScreen) }),
      prompt("w1:p3", { type: "unmatched", lines: ["?"] }),
      prompt("w1:p4", null),
    ]);
    expect(kinds.get(rowKey("host", "w1:p1"))).toBe("approval");
    expect(kinds.get(rowKey("host", "w1:p2"))).toBe("input");
    expect(kinds.get(rowKey("host", "w1:p3"))).toBe("input");
    expect(kinds.get(rowKey("host", "w1:p4"))).toBe("input");
  });
});

describe("the pill's colors, light and dark", () => {
  // Dark: Halo's approval and input (Adari's brand colors). Light: Tailwind v4's amber and indigo as T3 uses them
  // (text-amber-600, bg-amber-500; indigo the same), kept for a later light mode.
  const approval = "#f5cb45";
  const input = "#bba7ff";

  it("are Halo's in dark and T3's in light", () => {
    expect(needsPillColors.approval).toEqual({
      light: { text: "oklch(66.6% 0.179 58.318)", dot: "oklch(76.9% 0.188 70.08)" },
      dark: { text: approval, dot: approval },
    });
    expect(needsPillColors.input).toEqual({
      light: { text: "oklch(51.1% 0.262 276.966)", dot: "oklch(58.5% 0.233 277.117)" },
      dark: { text: input, dot: input },
    });
  });

  it("are the window's tokens, each light and dark", () => {
    const tokens = css("tokens.css");
    const token = (name: string, light: string, dark: string) => expect(tokens).toContain(`--${name}: light-dark(${light}, ${dark});`);
    token("approval", needsPillColors.approval.light.dot, needsPillColors.approval.dark.dot);
    token("approval-text", needsPillColors.approval.light.text, needsPillColors.approval.dark.text);
    token("input", needsPillColors.input.light.dot, needsPillColors.input.dark.dot);
    token("input-text", needsPillColors.input.light.text, needsPillColors.input.dark.text);
  });

  // In the Needs you group and Priority (.row.placed) a name kept at up to 45% that never shrank would push the pill
  // and the time of a long one (aurora-web-sidebar-session · claude-xhigh, Pending Approval, 23h) out of a 267 px
  // row. There it gives way with an ellipsis; the pill, the glyphs and the time stay whole.
  it("let a long name give way in the Needs you group and Priority, never the pill", () => {
    const app = css("app.css");
    const placed = app.indexOf(".row.placed .nm {");
    const needing = app.indexOf(".row.placed.ny .nm {");
    expect(placed).toBeGreaterThan(0);
    expect(needing, "after the placed rule, so it wins").toBeGreaterThan(placed);
    expect(app).toMatch(/\.row\.placed\.ny \.nm \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;/);
    expect(app).toMatch(/\.row \.pill \{[^}]*flex: none/);
    expect(app).toMatch(/\.row \.tm \{[^}]*flex: none/);
    expect(app).toMatch(/\.row \.st \{[^}]*flex: none/);
    expect(app).toMatch(/\.row \.kd \{[^}]*flex: none/);
  });

  it("color the row's dot, the pill and the folded header", () => {
    const app = css("app.css");
    expect(app).toMatch(/\.row \.g\.ny \{[^}]*background: var\(--approval\)/);
    expect(app).toMatch(/\.host-h \.ny \{[^}]*background: var\(--approval\)/);
    expect(app).toMatch(/\.row \.pill\.approval \{[^}]*color: var\(--approval-text\)/);
    expect(app).toMatch(/\.row \.pill\.approval i \{[^}]*background: var\(--approval\)/);
    expect(app).toMatch(/\.row \.pill\.input \{[^}]*color: var\(--input-text\)/);
    expect(app).toMatch(/\.row \.pill\.input i \{[^}]*background: var\(--input\)/);
    expect(app).toMatch(/\.ws-h \.ny \{[^}]*background: var\(--approval\)/);
    expect(app).toMatch(/\.ws-h \.nyn \{[^}]*color: var\(--approval-text\)/);
    // It fits the sidebar's width: the pill keeps its size, the title gives way first.
    expect(app).toMatch(/\.row \.pill \{[^}]*flex: none/);
    expect(app).toMatch(/\.row\.ny \.act \{[^}]*min-width: 0/);
    // At the 288px sidebar a long name and Pending Approval leave the title a few pixels: it goes, not cut to a letter.
    expect(app).toMatch(/\.row\.ny \.act, \.row\.ny \.ws2 \{[^}]*flex: 1 1 0;[^}]*container-type: inline-size/);
    expect(app).toMatch(/@container \(max-width: 4ch\) \{ \.row\.ny \.fit \{ display: none; \} \}/);
  });
});

// One machine: an agent that needs you (w1:p1) and one working (w1:p2) in "app".
function machine(statuses: { p1: string; p2: string } = { p1: "blocked", p2: "working" }): HostView {
  return {
    id: "host",
    name: "Mac mini",
    kind: "ssh",
    address: "fixture",
    platform: null,
    state: "connected",
    error: null,
    fetchedAtMs: 0,
    topology: decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: statuses.p1 }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 2, agent_status: statuses.p1 }],
      panes: [
        { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/srv/app", agent: "claude", agent_status: statuses.p1, revision: 1, label: "api" },
        { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/srv/app", agent: "claude", agent_status: statuses.p2, revision: 1, label: "web" },
      ],
      layouts: [],
      agents: [
        { pane_id: "w1:p1", agent: "claude", agent_status: statuses.p1 },
        { pane_id: "w1:p2", agent: "claude", agent_status: statuses.p2 },
      ],
    }),
  };
}

const none = (): void => undefined;

function sidebarView(
  host: HostView,
  pills: ReadonlyMap<string, NeedsPillKind>,
  state: SidebarFoldState = emptyFoldState,
  foldedHosts: ReadonlySet<string> = new Set<string>(),
) {
  const sidebar = buildDesktopSidebar([host], { nowUnixMs: Date.parse("2026-11-05T20:00:00.000Z"), fold: state });
  const view = new HookHost(Sidebar as (props: object) => unknown, {
    sidebar,
    selectedKey: null,
    search: null,
    demo: false,
    foldedHosts,
    needsPills: pills,
    onSelect: none,
    onRowMenu: none,
    onToggleHost: none,
    onHostMenu: none,
    onRetryHost: none,
    onMode: none,
    onToggleWorkspace: none,
    onToggleExpanded: none,
    onToggleSection: none,
    onSearch: none,
    onAddHost: none,
    onNewAgent: none,
    onWorkspaceMenu: none,
  });
  view.render();
  return view;
}

type Element = ReturnType<typeof elements>[number];

/** The host renders one component; the sidebar's rows are pure ones, drawn here by calling them. */
const pure = new Set(["Row", "DesktopRowView", "Glyph", "NeedsPill"]);
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== "object" || node === null || !("type" in node) || !("props" in node)) return node;
  const element = node as { type: unknown; props: Record<string, unknown> };
  if (typeof element.type === "function" && pure.has(element.type.name)) {
    return expand((element.type as (props: Record<string, unknown>) => unknown)(element.props));
  }
  return { ...element, props: { ...element.props, children: expand(element.props["children"]) } };
}

const hasClass = (element: Element, name: string): boolean =>
  typeof element.props["className"] === "string" && (element.props["className"] as string).split(" ").includes(name);

const text = (tree: unknown): string =>
  elements(tree)
    .flatMap((element) => [element.props["children"]].flat())
    .filter((child): child is string | number => typeof child === "string" || typeof child === "number")
    .join(" ");

/** The tree's rows (`button.row` with data-row), by key. */
function rows(tree: unknown): Map<string, Element[]> {
  const out = new Map<string, Element[]>();
  for (const element of elements(tree)) {
    const key = element.props["data-row"];
    if (element.type === "button" && typeof key === "string") out.set(key, [...(out.get(key) ?? []), element]);
  }
  return out;
}

const pillsIn = (row: Element): Element[] => elements(row).filter((element) => hasClass(element, "pill"));

describe("the row in the sidebar", () => {
  it("shows Pending Approval with the amber dot on an approval, and leaves the working row as it was", () => {
    const view = sidebarView(machine(), new Map([[rowKey("host", "w1:p1"), "approval" as const]]));
    const all = rows(expand(view.tree));
    // The row in its project and in the Needs you group at the top: the same pill.
    const blocked = all.get(rowKey("host", "w1:p1"))!;
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    for (const row of blocked) {
      const [pill] = pillsIn(row);
      expect(pill, "a pill").toBeDefined();
      expect(hasClass(pill!, "approval")).toBe(true);
      expect(text(pill)).toBe("Pending Approval");
      expect(elements(pill).some((element) => element.type === "i")).toBe(true);
      expect(elements(row).some((element) => hasClass(element, "g") && hasClass(element, "ny"))).toBe(true);
      // Name and title stay; beside the pill the title (or, in the Needs you group, the place) is in its own box,
      // which goes rather than show a letter when the row is short of room (app.css's container query).
      expect(text(row)).toContain("api");
      const title = elements(row).find((element) => hasClass(element, "act") || hasClass(element, "ws2"))!;
      expect(elements(title.props["children"]).some((element) => element.type === "span" && hasClass(element, "fit"))).toBe(true);
    }
    const working = all.get(rowKey("host", "w1:p2"))!;
    expect(working).toHaveLength(1);
    expect(pillsIn(working[0]!)).toEqual([]);
    // The working row's title as it was: the text itself in its .act.
    const act = elements(working[0]).find((element) => hasClass(element, "act"))!;
    expect(elements(act.props["children"])).toEqual([]);
    expect(elements(working[0]).some((element) => hasClass(element, "g") && hasClass(element, "work"))).toBe(true);
    expect(text(working[0])).toContain("web");
    view.unmount();
  });

  it("shows Awaiting Input for a question and when the kind is not known", () => {
    for (const pills of [new Map([[rowKey("host", "w1:p1"), "input" as const]]), new Map<string, NeedsPillKind>()]) {
      const view = sidebarView(machine(), pills);
      for (const row of rows(expand(view.tree)).get(rowKey("host", "w1:p1"))!) {
        const [pill] = pillsIn(row);
        expect(hasClass(pill!, "input")).toBe(true);
        expect(text(pill)).toBe("Awaiting Input");
      }
      view.unmount();
    }
  });

  it("drops the pill and the color the moment Herdr's status leaves needs-you", () => {
    const view = sidebarView(machine({ p1: "working", p2: "working" }), new Map([[rowKey("host", "w1:p1"), "approval" as const]]));
    for (const [, entries] of rows(expand(view.tree))) {
      for (const row of entries) {
        expect(pillsIn(row)).toEqual([]);
        expect(hasClass(row, "ny")).toBe(false);
      }
    }
    view.unmount();
  });

  it("keeps the row under a folded project, whose header shows the amber dot and the count", () => {
    const folded = fold.toggleWorkspace(emptyFoldState, "w1", "host");
    const view = sidebarView(machine(), new Map([[rowKey("host", "w1:p1"), "approval" as const]]), folded);
    const header = elements(expand(view.tree)).find((element) => element.type === "button" && hasClass(element, "ws-h"))!;
    expect(elements(header).some((element) => element.type === "i" && hasClass(element, "ny"))).toBe(true);
    const count = elements(header).find((element) => hasClass(element, "nyn"));
    expect(count, "the folded header's count").toBeDefined();
    expect(text(count)).toBe("1");
    // The row that needs you is still listed under it (and in the Needs you group); the working one is folded away.
    const listed = rows(expand(view.tree));
    expect(listed.get(rowKey("host", "w1:p2"))).toBeUndefined();
    expect(listed.get(rowKey("host", "w1:p1"))!.length).toBeGreaterThanOrEqual(2);
    view.unmount();
  });

  // With the machine folded and the Needs you group folded (both persist), no row would be left for the agent that
  // needs the user, only the machine's amber dot. A folded machine keeps its needing rows under its header,
  // each with its pill and its project, as a folded project does; the rest stays folded.
  it("keeps the row under a folded machine, even with the Needs you group folded too", () => {
    const groupFolded = fold.toggleSection(emptyFoldState, "needsYou");
    for (const state of [groupFolded, emptyFoldState]) {
      const view = sidebarView(machine(), new Map([[rowKey("host", "w1:p1"), "approval" as const]]), state, new Set(["host"]));
      const tree = expand(view.tree);
      const listed = rows(tree);
      const kept = elements(tree).find((element) => hasClass(element, "host-ny"));
      expect(kept, "the folded machine's rows that need you").toBeDefined();
      const [row, ...more] = rows(kept).get(rowKey("host", "w1:p1")) ?? [];
      expect(row, "the agent that needs you, under its machine").toBeDefined();
      expect(more).toEqual([]);
      const [pill] = pillsIn(row!);
      expect(text(pill)).toBe("Pending Approval");
      expect(hasClass(row!, "placed")).toBe(true);
      expect(text(row)).toContain("app");
      // Its working neighbour and the project headers stay folded away.
      expect(listed.get(rowKey("host", "w1:p2"))).toBeUndefined();
      expect(elements(tree).some((element) => hasClass(element, "ws-h"))).toBe(false);
      // With the group open the row is listed there too (as with an open machine).
      expect(listed.get(rowKey("host", "w1:p1"))!.length).toBe(state === groupFolded ? 1 : 2);
      view.unmount();
    }
  });

  it("leaves a folded machine with nobody needing you as it was", () => {
    const view = sidebarView(machine({ p1: "working", p2: "idle" }), new Map(), emptyFoldState, new Set(["host"]));
    const tree = expand(view.tree);
    expect(rows(tree).size).toBe(0);
    expect(elements(tree).some((element) => hasClass(element, "host-ny"))).toBe(false);
    view.unmount();
  });
});

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

describe("the window gives the sidebar each blocked pane's reading", () => {
  it("follows main's readings: an edit is an approval, then a question is input", async () => {
    let push: (prompts: readonly PanePrompt[]) => void = () => undefined;
    const prompt = (reading: PromptReading): PanePrompt => ({
      hostId: "host",
      paneId: "w1:p1",
      episode: "e1",
      incarnation: 1,
      connection: 1,
      epoch: null,
      reading,
      quiet: false,
      cleared: false,
    });
    vi.stubGlobal("window", {
      herdrDesktop: {
        appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
        listHosts: async () => [machine()],
        onHostsChanged: () => () => undefined,
        onAppCommand: (_listener: (c: AppCommand) => void) => () => undefined,
        onViewCommand: (_listener: (c: ViewCommand) => void) => () => undefined,
        listPrompts: async () => [prompt({ type: "matched", match: match(Launch.pairingPrompt) })],
        onPromptsChanged: (listener: (prompts: readonly PanePrompt[]) => void) => {
          push = listener;
          return () => undefined;
        },
        answerPrompt: async () => ({ ok: true }),
        ghosttyInfo: async () => ({ shown: false }),
        appCommandDone: () => undefined,
        awayState: async () => ({ building: false, digest: null, seenAt: null }),
        onAwayUpdate: () => () => undefined,
        searchConversations: () => undefined,
        onSearchUpdate: () => () => undefined,
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      sessionStorage: { getItem: () => null, setItem: () => undefined },
    });
    vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() }, querySelector: () => null });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      callback(0);
      return 0;
    });
    const app = new HookHost(App as (props: object) => unknown, {});
    app.render();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    cleanup = () => app.unmount();
    const pills = (): ReadonlyMap<string, NeedsPillKind> => {
      const sidebar = elements(app.tree).find((element) => typeof element.type === "function" && (element.type as { name: string }).name === "Sidebar")!;
      return sidebar.props["needsPills"] as ReadonlyMap<string, NeedsPillKind>;
    };
    expect(pills().get(rowKey("host", "w1:p1"))).toBe("approval");
    push([prompt({ type: "matched", match: match(demoAskScreen) })]);
    app.render();
    expect(pills().get(rowKey("host", "w1:p1"))).toBe("input");
    push([]);
    app.render();
    expect(pills().get(rowKey("host", "w1:p1"))).toBeUndefined();
  });
});
