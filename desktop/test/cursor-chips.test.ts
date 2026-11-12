// A Cursor pane's Model and Effort
// chips and its context ring read off the footer Cursor draws under its box
// (`Grok 4.7 256K Medium`, ` Fast`, ` · 6.8%`), from the recorded screens
// (test/support/cursor-menu-fixtures.ts; the same screens and results as
// Tests/HerdrKitTests/CursorChipsTests.swift). Main reads the shown Cursor
// Chat's pane once on show and once when a turn ends (never on a timer while
// idle); while it works the live reads' screens carry it.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cursorEffortChip,
  cursorFooterSettings,
  cursorWindowTokens,
  effortLabel,
  parseCursorFooter,
  parseCursorFooterLine,
  readCursorScreen,
  type CursorFooter,
} from "../src/shared/agent-settings";
import { cursorMenuScreen, cursorMenuScreens } from "./support/cursor-menu-fixtures";
import { repoRoot } from "./support/swift-fixtures";

const footer = (model: string, window: string | null, effort: CursorFooter["effort"], fast = false, percent: number | null = null): CursorFooter => ({ model, window, effort, fast, percent });

/** What each recorded screen's footer reads (null: none on it). */
const footers: Record<string, CursorFooter | null> = {
  "model-00001": null,
  "model-00002": footer("Grok 4.7", "256K", "medium"),
  "model-00003": null,
  "model-00004": null,
  selector: null,
  "edit-parameters": null,
  "after-high-enter": null,
  "selector-after-high": null,
  "after-esc-1": null,
  "after-esc-2": footer("Grok 4.7", "256K", "high"),
  "after-medium": footer("Grok 4.7", "256K", "medium"),
  "after-fast-on": footer("Grok 4.7", "256K", "medium", true),
  "after-fast-off": footer("Grok 4.7", "256K", "medium"),
  "stream-00003": footer("Grok 4.7", "256K", "medium"),
  "stream-00019": footer("Grok 4.7", "256K", "medium", false, 6.8),
  "stream-00033": footer("Grok 4.7", "256K", "medium", false, 6.9),
};

describe("Cursor's footer", () => {
  it("every recorded screen is a fixture, the same in HerdrKit's tests", () => {
    expect(cursorMenuScreens.map((each) => each.name)).toEqual(Object.keys(footers));
    const swift = readFileSync(path.join(repoRoot, "Tests/HerdrKitTests/CursorMenuFixtures.swift"), "utf8");
    for (const each of cursorMenuScreens) {
      const escaped = [...each.screen]
        .map((c) => {
          if (c === "\\") return "\\\\";
          if (c === '"') return '\\"';
          if (c === "\n") return "\\n";
          const v = c.codePointAt(0)!;
          return v < 0x20 || v > 0x7e ? `\\u{${v.toString(16).toUpperCase()}}` : c;
        })
        .join("");
      expect(swift.includes(`Screen(name: "${each.name}"`) && swift.includes(`screen: "${escaped}")`), each.name).toBe(true);
    }
  });

  for (const [name, expected] of Object.entries(footers)) {
    it(`${name}: ${expected === null ? "no footer" : `${expected.model} ${expected.window} ${expected.effort}${expected.fast ? " Fast" : ""}${expected.percent === null ? "" : ` · ${expected.percent}%`}`}`, () => {
      expect(parseCursorFooter(cursorMenuScreen(name))).toEqual(expected);
    });
  }

  it("reads the box: empty (its placeholder) or a draft, working while ctrl+c to stop shows", () => {
    expect(readCursorScreen(cursorMenuScreen("model-00002"))).toMatchObject({ kind: "box", empty: true, working: false, draft: "" });
    expect(readCursorScreen(cursorMenuScreen("stream-00019"))).toMatchObject({ kind: "box", empty: true, working: true });
    expect(readCursorScreen(cursorMenuScreen("stream-00033"))).toMatchObject({ kind: "box", empty: true, working: false });
    const drafted = cursorMenuScreen("model-00002").replace("Plan, search, build anything", "fix the shed door");
    expect(readCursorScreen(drafted)).toMatchObject({ kind: "box", empty: false, draft: "fix the shed door" });
    expect(parseCursorFooter(drafted)).toEqual(footer("Grok 4.7", "256K", "medium"));
  });

  it("reads the lines it may show: Fast with a percent, other windows and levels; anything else is none", () => {
    expect(parseCursorFooterLine("  Grok 4.7 256K Medium Fast \u{B7} 6.8%")).toEqual(footer("Grok 4.7", "256K", "medium", true, 6.8));
    expect(parseCursorFooterLine("  Grok 4.7 500K Extra High")).toEqual(footer("Grok 4.7", "500K", "xhigh"));
    expect(parseCursorFooterLine("  Grok 4.7 256K Low \u{B7} 0%")).toEqual(footer("Grok 4.7", "256K", "low", false, 0));
    expect(parseCursorFooterLine("  Grok 4.6 High Fast")).toEqual(footer("Grok 4.6", null, "high", true));
    for (const line of ["  Grok 4.7 256K Turbo", "  Auto", "  Composer 2.5 Fast", "  /Users/demo/shed-plan", "Grok 4.7 256K Medium", "  Grok 4.7 256K Medium \u{B7} 140%", "  Grok 4.7  256K Medium"]) {
      expect(parseCursorFooterLine(line), line).toBeNull();
    }
  });

  it("gives the chips the model and the effort, and the ring the used share of the window", () => {
    expect(cursorWindowTokens("256K")).toBe(256_000);
    expect(cursorWindowTokens("1M")).toBe(1_000_000);
    expect(cursorWindowTokens(null)).toBeNull();
    expect(cursorFooterSettings(footers["stream-00019"]!)).toEqual({ model: "Grok 4.7", modelLabel: "Grok 4.7", effort: "medium", used: 17_408, window: 256_000 });
    expect(cursorFooterSettings(footers["model-00002"]!)).toEqual({ model: "Grok 4.7", modelLabel: "Grok 4.7", effort: "medium", used: null, window: 256_000 });
    expect(cursorEffortChip(footers["after-fast-on"]!)).toBe("Medium \u{B7} Fast");
    expect(cursorEffortChip(footer("Grok 4.7", "500K", "xhigh"))).toBe("Extra High");
  });
});

// MARK: - the chips in the box's row

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { decodeSessionTopology } = await import("../src/main/herdr/wire");
const { HookHost, elements } = await import("./support/fake-hooks");
const { AgentChips } = await import("../src/renderer/components/AgentChips");
const { ContextRing } = await import("../src/renderer/components/ContextRing");
const { agentPicks } = await import("../src/renderer/components/agent-picks");
type HostView = import("../src/shared/ipc-contract").HostView;
type SidebarRow = import("../src/shared/sidebar-model").SidebarRow;

function hostWith(agent: string | null, status = "idle", session: string | null = null): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, ...(agent === null ? {} : { agent }), agent_status: status, revision: 1 }],
    layouts: [],
    agents:
      agent === null
        ? []
        : [{ pane_id: "w1:p1", agent, agent_status: status, ...(session === null ? {} : { agent_session: { source: `herdr:${agent}`, agent, kind: "id", value: session } }) }],
  });
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology, run: { connection: 3, arrivals: { "w1:p1": 2 } } } as unknown as HostView;
}

const row = (kind: string, isAgent = true) => ({ paneID: "w1:p1", name: "Notes", workspaceLabel: "notes", kind, isAgent, status: "idle" }) as unknown as SidebarRow;
type Node = { type: unknown; props: Record<string, unknown> };

function chips(host: HostView, pane: SidebarRow) {
  const ui = new HookHost(AgentChips as (props: object) => unknown, { host, row: pane });
  ui.render();
  const all = (): Node[] => elements(ui.tree) as Node[];
  const button = (kind: "model" | "effort") => all().find((e) => e.props["className"] === "pick-b" && String(e.props["aria-label"]).startsWith(kind === "model" ? "Model" : "Effort"));
  const label = (kind: "model" | "effort") => {
    const found = button(kind);
    return found === undefined ? undefined : String(found.props["aria-label"]).replace(/^(Model|Effort): /, "");
  };
  return { ui, button, label };
}

function ring(host: HostView, pane: SidebarRow) {
  const ui = new HookHost(ContextRing as (props: object) => unknown, { host, row: pane });
  ui.render();
  const all = (): Node[] => elements(ui.tree) as Node[];
  return { ui, button: () => all().find((e) => String(e.props["className"] ?? "").includes("ctx-ring ")) };
}

const key = "mac-mini/w1:p1";
const cursorScope = { terminalID: "t-7", session: null };

describe("a Cursor pane's chips", () => {
  beforeEach(() => {
    agentPicks.clear();
    vi.stubGlobal("window", { herdrDesktop: { sendToPane: async () => undefined, copyText: () => undefined } });
  });

  it("show the agent's default for the model, and no Effort chip and no ring until its footer is read", () => {
    // The Model chip from the start ("Default"); Effort and the ring still wait for the footer.
    const c = chips(hostWith("cursor"), row("cursor"));
    expect(c.label("model")).toBe("Default");
    expect(c.button("effort")).toBeUndefined();
    expect(ring(hostWith("cursor"), row("cursor")).button()).toBeUndefined();
  });

  it("show the footer's model and effort, Fast beside it, and the ring its share of the window", () => {
    agentPicks.receiveFooter(key, { scope: cursorScope, footer: footers["stream-00019"]! });
    const c = chips(hostWith("cursor"), row("cursor"));
    expect(c.label("model")).toBe("Grok 4.7");
    expect(c.label("effort")).toBe("Medium");
    expect(String(ring(hostWith("cursor"), row("cursor")).button()!.props["aria-label"])).toBe("Context: 17.4k of 256k");
    agentPicks.receiveFooter(key, { scope: cursorScope, footer: footers["after-fast-on"]! });
    c.ui.render();
    expect(c.label("effort")).toBe("Medium \u{B7} Fast");
  });

  it("a footer that no longer reads takes its values away; one of another terminal is not this pane's", () => {
    agentPicks.receiveFooter(key, { scope: cursorScope, footer: footers["model-00002"]! });
    agentPicks.receiveFooter(key, { scope: cursorScope, footer: null });
    // The Model chip goes back to the agent's default; the Effort chip goes.
    expect(chips(hostWith("cursor"), row("cursor")).label("model")).toBe("Default");
    expect(chips(hostWith("cursor"), row("cursor")).button("effort")).toBeUndefined();
    agentPicks.receiveFooter(key, { scope: { terminalID: "t-other", session: null }, footer: footers["model-00002"]! });
    expect(chips(hostWith("cursor"), row("cursor")).label("model")).toBe("Default");
    expect(chips(hostWith("cursor"), row("cursor")).button("effort")).toBeUndefined();
  });

  it("a Claude or Codex pane: a footer for it changes nothing", () => {
    agentPicks.receiveFooter(key, { scope: { terminalID: "t-7", session: "s-1" }, footer: footers["model-00002"]! });
    agentPicks.receive(key, { model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: "high", scope: { terminalID: "t-7", session: "s-1" } }, null);
    const claude = chips(hostWith("claude", "idle", "s-1"), row("claude"));
    expect([claude.label("model"), claude.label("effort")]).toEqual(["Opus 5.5", "High"]);
    agentPicks.clear();
    agentPicks.receiveFooter(key, { scope: { terminalID: "t-7", session: "s-1" }, footer: footers["model-00002"]! });
    const codex = chips(hostWith("codex", "idle", "s-1"), row("codex"));
    expect([codex.label("model"), codex.label("effort")]).toEqual(["Default", "Default"]); // never a bare "Model"
  });
});

// MARK: - main's reads of the footer

const { LiveReads, idleFooterMs } = await import("../src/main/chat/live-reads");
const { AgentPicks: AgentPicksClass } = await import("../src/renderer/components/agent-picks");
const { HostRegistry } = await import("../src/main/hosts");
const { PaneReadGate } = await import("../src/shared/chat/live-reader");
const { backend, FakeHerdr, snapshot } = await import("./support/prompt-herdr");
type ShownChat = import("../src/main/chat/service").ShownChat;
type ChatOwner = import("../src/main/chat/service").ChatOwner;
type FooterEvent = import("../src/shared/ipc-contract").CursorFooterEvent;

/** The fake Herdr with w1:p3's screen as the test sets it. */
class CursorHerdr extends FakeHerdr {
  shown = "";

  override roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: unknown; method: string; params: Record<string, unknown> };
    if (request.method !== "pane.read" || request.params["pane_id"] !== "w1:p3") return super.roundTrip(line);
    this.requests.push(line);
    const read = { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1", source: "recent", format: "text", text: this.shown, revision: 1, truncated: false };
    return Promise.resolve(JSON.stringify({ id: request.id, result: { type: "pane_read", read } }));
  }
}

async function footerSetup(status = "idle") {
  const json = snapshot();
  const pane = (json["panes"] as Record<string, unknown>[])[2]!;
  pane["agent"] = "cursor";
  pane["agent_status"] = status;
  const herdr = new CursorHerdr(json, {});
  herdr.shown = cursorMenuScreen(status === "working" ? "stream-00019" : "model-00002");
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
  await registry.refreshAll();
  const footerEvents: FooterEvent[] = [];
  let chats: ShownChat[] = [];
  const owner: ChatOwner = { id: 1, send: () => undefined, isDestroyed: () => false };
  const live = new LiveReads(registry, () => chats, () => undefined, { gate: new PaneReadGate(), footer: (_chat, event) => footerEvents.push(event) });
  const show = (...panes: string[]): void => {
    chats = panes.map((paneId) => ({ owner, slot: "", follow: 1, hostId: "mac", paneId }));
    live.sync();
  };
  const snapshotNow = async (): Promise<void> => {
    await registry.refreshAll();
    live.sync();
  };
  const reads = (): unknown[] => herdr.sent("pane.read").filter((params) => params["pane_id"] === "w1:p3");
  return { herdr, live, show, snapshotNow, footerEvents, reads };
}

describe("main reads a shown Cursor Chat's footer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // While idle, again every idleFooterMs (a change the user makes in its terminal starts no turn);
  // an unchanged footer sends nothing.
  it("once when the Chat shows, then every idleFooterMs while idle; the same footer sends nothing again", async () => {
    const { live, show, footerEvents, reads } = await footerSetup();
    show("w1:p3");
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toEqual([{ pane_id: "w1:p3", source: "recent", lines: 80, format: "text", strip_ansi: true }]);
    // The page's footer for the new identity is cleared first, each event with its connection and run.
    const scope = { terminalID: "term-3", session: null };
    const run = { connection: expect.any(Number), arrival: expect.any(Number) };
    expect(footerEvents).toEqual([
      { hostId: "mac", paneId: "w1:p3", scope, run, footer: null },
      { hostId: "mac", paneId: "w1:p3", scope, run, footer: footers["model-00002"] },
    ]);
    show("w1:p3");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toHaveLength(1 + Math.floor(60_000 / idleFooterMs));
    expect(footerEvents).toHaveLength(2);
    // Gone from screen: no more reads.
    show();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toHaveLength(1 + Math.floor(60_000 / idleFooterMs));
    live.closeAll();
  });

  // The cursor-live-04 recording: an idle pane whose Chat has never had a turn;
  // `/model Composer 2.5` and Return typed in its terminal leave "Composer 2.5 Fast" (no effort word) under its box.
  // Through the real reader: the model line reaches the page within idleFooterMs, and the chip follows it.
  it("an idle pane's model line changed in its terminal reaches the chip within idleFooterMs (cursor-live-04)", async () => {
    const { herdr, live, show, footerEvents, reads } = await footerSetup();
    show("w1:p3");
    await vi.advanceTimersByTimeAsync(0);
    expect(footerEvents.at(-1)?.footer).toEqual(footers["model-00002"]);
    herdr.shown = readFileSync(path.join(repoRoot, "desktop", "fixtures", "livepick", "cursor-live-04-composer-footer-idle.txt"), "utf8");
    await vi.advanceTimersByTimeAsync(idleFooterMs);
    const last = footerEvents.at(-1)!;
    expect(last).toMatchObject({ hostId: "mac", paneId: "w1:p3", footer: null, modelLine: "Composer 2.5 Fast" });
    const picks = new AgentPicksClass({ send: async () => undefined, now: () => 0, copy: () => undefined });
    picks.receiveFooter("mac/w1:p3", footerEvents.at(-2)!);
    picks.receiveFooter("mac/w1:p3", last);
    const binding = { terminalID: "term-3", isAgent: true, kind: "cursor", session: null, run: last.run } as never;
    expect(picks.chip("mac/w1:p3", "model", binding).label).toBe("Composer 2.5");
    expect(picks.chip("mac/w1:p3", "effort", binding).label).toBe(effortLabel(null));
    // Seen once: the same line read again sends nothing more.
    const count = footerEvents.length;
    await vi.advanceTimersByTimeAsync(idleFooterMs * 3);
    expect(footerEvents).toHaveLength(count);
    expect(reads().length).toBeGreaterThanOrEqual(5);
    live.closeAll();
  });

  it("while it works, from the live reads' own screens; once more when the turn ends", async () => {
    const { herdr, live, show, snapshotNow, footerEvents, reads } = await footerSetup("working");
    show("w1:p3");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(reads()).toHaveLength(2);
    expect(footerEvents.map((event) => event.footer)).toEqual([null, footers["stream-00019"]]);
    herdr.paneEntry("w1:p3")["agent_status"] = "done";
    herdr.shown = cursorMenuScreen("stream-00033");
    await snapshotNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toHaveLength(3);
    expect(footerEvents.map((event) => event.footer)).toEqual([null, footers["stream-00019"], footers["stream-00033"]]);
    // Idle again, its footer every idleFooterMs.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toHaveLength(3 + Math.floor(60_000 / idleFooterMs));
    live.closeAll();
  });

  it("not a Claude or Codex pane's, nor one not shown", async () => {
    const { live, show, footerEvents, herdr } = await footerSetup();
    show("w1:p1", "w1:p2");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(footerEvents).toEqual([]);
    expect(herdr.sent("pane.read").filter((params) => params["pane_id"] === "w1:p1")).toEqual([]);
    live.closeAll();
  });
});
