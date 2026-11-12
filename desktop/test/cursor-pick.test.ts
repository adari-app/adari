// A Cursor pick drives Cursor's own
// menu by keys (src/main/herdr/send.ts driveCursorPick), reading the screen
// after every key: `/model`, Enter, the selector on the footer's model, Tab,
// Edit Parameters, the arrow moved row by row to the target, Enter, Esc, Esc,
// settled when the footer shows it. Any other screen backs out with Esc (no
// pick, a note). A fake pane (src/main/demo/demo-cursor-menu.ts) answers with
// the recorded screens; the same sequences and results as
// Tests/HerdrKitTests/CursorPickTests.swift.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DemoCursorMenu } from "../src/main/demo/demo-cursor-menu";
import { cursorPickTexts, driveCursorPick, pickCursorBound, type CursorMenuIO } from "../src/main/herdr/send";
import type { CursorFooter, CursorPick } from "../src/shared/agent-settings";
import { cursorMenuScreen } from "./support/cursor-menu-fixtures";

const head = cursorMenuScreen("model-00002").split("\n").slice(0, 10);
const folder = "/Users/demo/shed-plan";
const footer = (effort: CursorFooter["effort"], fast = false, window = "256K"): CursorFooter => ({ model: "Grok 4.7", window, effort, fast, percent: null });

describe("the fake pane draws Cursor's recorded screens", () => {
  it("the box, the list, the selector, Edit Parameters, a pick and the way back, byte for byte", () => {
    const menu = new DemoCursorMenu(head, folder);
    expect(menu.screen()).toBe(cursorMenuScreen("model-00002"));
    expect(menu.screen()).toBe(cursorMenuScreen("after-medium"));
    menu.type("/model");
    expect(menu.screen()).toBe(cursorMenuScreen("model-00003"));
    menu.keys(["Enter"]);
    expect(menu.screen()).toBe(cursorMenuScreen("model-00004"));
    expect(menu.screen()).toBe(cursorMenuScreen("selector"));
    menu.keys(["Tab"]);
    expect(menu.screen()).toBe(cursorMenuScreen("edit-parameters"));
    menu.keys(["Down", "Down", "Down", "Down", "Enter"]);
    expect(menu.screen()).toBe(cursorMenuScreen("after-high-enter"));
    menu.keys(["Escape"]);
    expect(menu.screen()).toBe(cursorMenuScreen("after-esc-1"));
    expect(menu.screen()).toBe(cursorMenuScreen("selector-after-high"));
    menu.keys(["Escape"]);
    expect(menu.screen()).toBe(cursorMenuScreen("after-esc-2"));
    expect(new DemoCursorMenu(head, folder, { fast: true }).screen()).toBe(cursorMenuScreen("after-fast-on"));
    expect(new DemoCursorMenu(head, folder, { fast: false }).screen()).toBe(cursorMenuScreen("after-fast-off"));
  });
});

/** The fake pane as the driver's IO; `glitch` may put another screen in a read's place (the 1st read is the first look). */
function pane(menu: DemoCursorMenu, glitch: (read: number, screen: string) => string = (_read, screen) => screen, check: (writes: number) => string | null = () => null) {
  const log: string[] = [];
  let reads = 0;
  const io: CursorMenuIO = {
    read: async () => {
      reads += 1;
      return glitch(reads, menu.screen());
    },
    type: async (text) => {
      log.push(`type ${text}`);
      menu.type(text);
    },
    keys: async (keys) => {
      log.push(keys.join(","));
      menu.keys(keys);
    },
    check: () => check(log.length),
  };
  return { io, log, reads: () => reads };
}

const run = (menu: DemoCursorMenu, pick: CursorPick, glitch?: (read: number, screen: string) => string) => {
  const p = pane(menu, glitch);
  return driveCursorPick(p.io, pick).then((outcome) => ({ ...outcome, log: p.log, reads: p.reads() }));
};

const down = (count: number): string[] => Array.from({ length: count }, () => "Down");

describe("a pick drives Cursor's menu, reading every screen", () => {
  it("Effort High: /model, Enter, Tab, the arrow down to High one row a read, Enter, Esc, Esc; the footer says High", async () => {
    const menu = new DemoCursorMenu(head, folder);
    const done = await run(menu, { kind: "effort", value: "high" });
    expect(done.log).toEqual(["type /model", "Enter", "Tab", ...down(4), "Enter", "Escape", "Escape"]);
    // Read again right before each Enter (13 reads, not 11).
    expect(done.reads).toBe(13);
    expect(done.result).toEqual({ type: "set", footer: footer("high") });
    expect(done.screen).toBe(cursorMenuScreen("after-esc-2"));
  });

  it("Context 500K, Fast on, Extra High from High", async () => {
    const menu = new DemoCursorMenu(head, folder);
    expect((await run(menu, { kind: "context", value: "500K" })).log).toEqual(["type /model", "Enter", "Tab", "Down", "Enter", "Escape", "Escape"]);
    expect(menu.footer()).toBe("  Grok 4.7 500K Medium");
    const fast = await run(menu, { kind: "fast", value: true });
    expect(fast.log).toEqual(["type /model", "Enter", "Tab", ...down(6), "Enter", "Escape", "Escape"]);
    expect(fast.result).toEqual({ type: "set", footer: footer("medium", true, "500K") });
    const high = new DemoCursorMenu(head, folder, { effort: "high" });
    expect((await run(high, { kind: "effort", value: "xhigh" })).result).toEqual({ type: "set", footer: footer("xhigh") });
  });

  it("what the footer already says: no key", async () => {
    const done = await run(new DemoCursorMenu(head, folder), { kind: "effort", value: "medium" });
    expect(done.log).toEqual([]);
    expect(done.result).toEqual({ type: "set", footer: footer("medium") });
  });

  it("the Model chip: /model and Enter open Cursor's selector, left open for the user", async () => {
    const menu = new DemoCursorMenu(head, folder);
    const done = await run(menu, { kind: "model" });
    expect(done.log).toEqual(["type /model", "Enter"]);
    expect(done.result).toEqual({ type: "opened" });
    expect(menu.state.stage).toBe("models");
  });
});

// Each step's screen is a menu this pick opened, recognized on a fresh read.
describe("an unexpected screen at any step backs out with Esc: no pick, a note", () => {
  const other = "  Something Cursor has not shown before";
  const steps: { name: string; read: number; screen: (shown: string) => string; log: string[]; effort: CursorFooter["effort"] }[] = [
    { name: "after /model (another command highlighted)", read: 2, screen: (s) => s.replace("   \u{2192} /model [filter]", "     /model [filter]").replace("     /model-usage", "   \u{2192} /model-usage"), log: ["type /model", "Escape", "Backspace,Backspace,Backspace,Backspace,Backspace,Backspace"], effort: "medium" },
    { name: "after Enter (the arrow on another model)", read: 4, screen: (s) => s.replace(" \u{2192}  Grok 4.7", "    Grok 4.7").replace("    Auto", " \u{2192}  Auto"), log: ["type /model", "Enter", "Escape"], effort: "medium" },
    { name: "after a Down (the arrow two rows on)", read: 6, screen: (s) => s.replace("  \u{2192} \u{25CF} 256K", "    \u{25CF} 256K").replace("    \u{25CB} Low", "  \u{2192} \u{25CB} Low"), log: ["type /model", "Enter", "Tab", "Down", "Escape", "Escape"], effort: "medium" },
    { name: "after Enter (High not chosen)", read: 11, screen: (s) => s.replace("\u{25CF} High \u{2713}", "\u{25CB} High").replace("\u{25CB} Medium", "\u{25CF} Medium \u{2713}"), log: ["type /model", "Enter", "Tab", ...down(4), "Enter", "Escape", "Escape"], effort: "high" },
  ];
  for (const step of steps) {
    it(step.name, async () => {
      const menu = new DemoCursorMenu(head, folder);
      const done = await run(menu, { kind: "effort", value: "high" }, (read, shown) => (read !== step.read ? shown : step.screen(shown)));
      expect(done.log).toEqual(step.log);
      expect(menu.state.stage).toBe("box");
      expect(menu.state.draft).toBe("");
      expect(menu.state.effort).toBe(step.effort);
      // The chip shows what the footer says, with the note: never a guess.
      expect(done.result).toEqual({ type: "refused", note: cursorPickTexts.unexpected, footer: footer(step.effort) });
    });
  }

  // A screen Cursor never drew (after Tab, after either Esc) is not its menu: no key after it.
  const unknown: { name: string; read: number; log: string[]; stage: string }[] = [
    { name: "after Tab (not Edit Parameters)", read: 5, log: ["type /model", "Enter", "Tab"], stage: "parameters" },
    { name: "after the first Esc (not the selector)", read: 12, log: ["type /model", "Enter", "Tab", ...down(4), "Enter", "Escape"], stage: "models" },
    { name: "after the second Esc (no footer)", read: 13, log: ["type /model", "Enter", "Tab", ...down(4), "Enter", "Escape", "Escape"], stage: "box" },
  ];
  for (const step of unknown) {
    it(`${step.name}: an unknown screen stops with no key after it`, async () => {
      const menu = new DemoCursorMenu(head, folder);
      const done = await run(menu, { kind: "effort", value: "high" }, (read, shown) => (read === step.read ? other : shown));
      expect(done.log).toEqual(step.log);
      expect(menu.state.stage).toBe(step.stage);
      expect(done.result).toEqual({ type: "refused", note: cursorPickTexts.elsewhere, footer: null });
    });
  }

  it("a box that holds the user's own text after backing out is left alone, with a note to check it", async () => {
    const menu = new DemoCursorMenu(head, folder);
    // Backed out from its own list (another command highlighted), not from an unknown screen.
    const ownList = (shown: string) => shown.replace("   \u{2192} /model [filter]", "     /model [filter]").replace("     /model-usage", "   \u{2192} /model-usage");
    const done = await run(menu, { kind: "effort", value: "high" }, (read, shown) => (read === 2 ? ownList(shown) : read === 3 ? shown.replace("\u{2192} /model\n", "\u{2192} /modelx\n") : shown));
    expect(done.log).toEqual(["type /model", "Escape"]);
    expect(done.result).toMatchObject({ type: "refused", note: cursorPickTexts.stuck });
  });
});

describe("when a pick does not go", () => {
  it("Cursor working: nothing is typed (busy: held for its next turn)", async () => {
    const p = pane(new DemoCursorMenu(head, folder), () => cursorMenuScreen("stream-00019"));
    expect((await driveCursorPick(p.io, { kind: "effort", value: "high" })).result).toEqual({ type: "busy" });
    expect(p.log).toEqual([]);
  });

  it("the user's text in Cursor's box, a menu already open, no footer: nothing is typed", async () => {
    const drafted = new DemoCursorMenu(head, folder, { draft: "fix the shed door" });
    const p = pane(drafted);
    expect((await driveCursorPick(p.io, { kind: "effort", value: "high" })).result).toEqual({ type: "refused", note: cursorPickTexts.draft, footer: footer("medium") });
    for (const name of ["selector", "edit-parameters", "model-00001"]) {
      const q = pane(new DemoCursorMenu(head, folder), () => cursorMenuScreen(name));
      expect((await driveCursorPick(q.io, { kind: "effort", value: "high" })).result, name).toEqual({ type: "refused", note: cursorPickTexts.noFooter, footer: null });
      expect(q.log).toEqual([]);
    }
    expect(p.log).toEqual([]);
  });

  it("the pane changes on the way: no key after it, the note says why", async () => {
    const menu = new DemoCursorMenu(head, folder);
    const p = pane(menu, undefined, (writes) => (writes >= 3 ? "another program is in this pane now" : null));
    const done = await driveCursorPick(p.io, { kind: "effort", value: "high" });
    expect(p.log).toEqual(["type /model", "Enter", "Tab"]);
    expect(done.result).toEqual({ type: "refused", note: cursorPickTexts.stopped("another program is in this pane now"), footer: null });
  });
});

// MARK: - bound to the pane the user picked on (main)

type Pane = import("../src/main/herdr/wire").TopologyPaneInfo;
type Agent = import("../src/main/herdr/wire").AgentInfo;

function site(menu: DemoCursorMenu, status = "idle", kind = "cursor") {
  const pane = { paneID: "w1:p3", terminalID: "term-3", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: kind, agentStatus: status, revision: 1 } as unknown as Pane;
  const agent = { paneID: "w1:p3", agent: kind, agentStatus: status } as unknown as Agent;
  const writes: string[] = [];
  return {
    writes,
    site: {
      writer: {
        sendText: async (_pane: string, text: string) => {
          writes.push(`type ${text}`);
          menu.type(text);
        },
      } as never,
      calls: {
        paneRead: async () => menu.screen(),
        paneSendKeys: async (_pane: string, keys: readonly string[]) => {
          writes.push(keys.join(","));
          menu.keys(keys);
        },
      },
      fresh: async () => true,
      pane: () => pane,
      agent: () => agent,
      run: () => ({ connection: 3, arrival: 2 }),
    },
  };
}

const binding = (kind = "cursor") => ({ terminalID: "term-3", isAgent: true, kind, session: null, run: { connection: 3, arrival: 2 } });

describe("a bound pick (main)", () => {
  it("goes in the pane's turn on a fresh snapshot of the same Cursor at its prompt", async () => {
    const menu = new DemoCursorMenu(head, folder);
    const { site: s, writes } = site(menu);
    const done = await pickCursorBound(s, "w1:p3", { kind: "effort", value: "high" }, binding());
    expect(done.result).toEqual({ type: "set", footer: footer("high") });
    expect(writes).toEqual(["type /model", "Enter", "Tab", ...down(4), "Enter", "Escape", "Escape"]);
  });

  it("a busy pane, another run, or a Claude or Codex binding: nothing is read or typed", async () => {
    const busy = site(new DemoCursorMenu(head, folder), "working");
    expect((await pickCursorBound(busy.site, "w1:p3", { kind: "effort", value: "high" }, binding())).result).toEqual({ type: "busy" });
    const restarted = site(new DemoCursorMenu(head, folder));
    expect((await pickCursorBound(restarted.site, "w1:p3", { kind: "effort", value: "high" }, { ...binding(), run: { connection: 3, arrival: 1 } })).result.type).toBe("refused");
    const claude = site(new DemoCursorMenu(head, folder), "idle", "claude");
    expect((await pickCursorBound(claude.site, "w1:p3", { kind: "effort", value: "high" }, binding("claude"))).result.type).toBe("refused");
    expect([...busy.writes, ...restarted.writes, ...claude.writes]).toEqual([]);
  });
});

// MARK: - the chips' picks (the page)

const { AgentPicks } = await import("../src/renderer/components/agent-picks");
type HostView = import("../src/shared/ipc-contract").HostView;
const { decodeSessionTopology } = await import("../src/main/herdr/wire");

function hostWith(status: string): HostView {
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

describe("the page's Cursor picks", () => {
  let calls: { pick: CursorPick; binding: unknown }[];
  let answer: () => Promise<import("../src/shared/ipc-contract").CursorPickResult>;
  let picks: InstanceType<typeof AgentPicks>;
  const key = "mac-mini/w1:p1";
  const scope = { terminalID: "t-7", session: null };

  beforeEach(() => {
    calls = [];
    answer = async () => ({ type: "set", footer: footer("high") });
    picks = new AgentPicks({
      send: async () => {
        throw new Error("a Cursor pick is never a command line");
      },
      cursorPick: async (_host, _pane, pick, binding) => {
        calls.push({ pick, binding });
        return answer();
      },
      copy: () => undefined,
      now: () => 0,
    });
    picks.receiveFooter(key, { scope, footer: footer("medium") });
  });

  const context = (status: string) => {
    const { pickContext } = picksModule;
    return pickContext(hostWith(status), "w1:p1")!;
  };

  it("goes at once at its prompt; the chip shows the pick, then the footer main read", async () => {
    picks.pick(context("idle"), { kind: "effort", value: "effort:high", label: "High" });
    expect(picks.chip(key, "effort", context("idle").binding)).toEqual({ label: "High", next: false });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ pick: { kind: "effort", value: "high" }, binding: { terminalID: "t-7", isAgent: true, kind: "cursor", session: null, run: { connection: 3, arrival: 2 }, atPromptOnly: true } });
    await vi.waitFor(() => expect(picks.cursorFooter(key, context("idle").binding)).toEqual(footer("high")));
    expect(picks.chip(key, "effort", context("idle").binding)).toEqual({ label: "High", next: false });
  });

  it("held while Cursor works (next turn), once when it is back; busy by then: held again", async () => {
    answer = async () => ({ type: "busy" });
    picks.pick(context("working"), { kind: "effort", value: "fast:on", label: "Medium \u{B7} Fast" });
    expect(picks.chip(key, "effort", context("working").binding)).toEqual({ label: "Medium \u{B7} Fast", next: true });
    expect(calls).toEqual([]);
    picks.syncHosts([hostWith("idle")]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(picks.chip(key, "effort", context("working").binding).next).toBe(true));
    expect(calls[0]!.pick).toEqual({ kind: "fast", value: true });
  });

  it("not set: the note, and the chip shows what the footer says", async () => {
    answer = async () => ({ type: "refused", note: cursorPickTexts.unexpected, footer: footer("medium") });
    picks.pick(context("idle"), { kind: "effort", value: "context:500K", label: "Medium" });
    await vi.waitFor(() => expect(picks.note(key)).toBe(cursorPickTexts.unexpected));
    expect(picks.chip(key, "effort", context("idle").binding)).toEqual({ label: "Medium", next: false });
  });
});

const picksModule = await import("../src/renderer/components/agent-picks");

// MARK: - the demo's Cursor pane (wC:p1) takes a pick

describe("the demo's Cursor pane", () => {
  it("draws its turn, its footer from its menu; a High pick goes key by key and the footer says it", async () => {
    const { DemoBackend } = await import("../src/main/demo/demo-backend");
    const { demoHostIds, demoHosts } = await import("../src/main/demo/demo-hosts");
    const { demoCursorLiveScreen } = await import("../src/main/demo/demo-live");
    const { bundledFixturesForTests } = await import("./support/demo-fixtures");
    const fixtures = bundledFixturesForTests();
    const host = demoHosts(fixtures, Date.now()).find((each) => each.descriptor.id === demoHostIds.macMini)!;
    const backend = new DemoBackend(host, fixtures);
    expect(await backend.paneText("wC:p1", 80)).toBe(demoCursorLiveScreen(null, "idle"));
    const calls = backend.promptIO();
    const pane = { paneID: "wC:p1", terminalID: "t", workspaceID: "wC", tabID: "wC:t1", focused: false, agent: "cursor", agentStatus: "idle", revision: 1 } as unknown as Pane;
    const done = await pickCursorBound(
      {
        writer: backend as never,
        calls,
        fresh: async () => true,
        pane: () => pane,
        agent: () => ({ paneID: "wC:p1", agent: "cursor", agentStatus: "idle" }) as unknown as Agent,
        run: () => ({ connection: 1, arrival: 1 }),
      },
      "wC:p1",
      { kind: "effort", value: "high" },
      { terminalID: "t", isAgent: true, kind: "cursor", session: null, run: { connection: 1, arrival: 1 } },
    );
    expect(done.result).toEqual({ type: "set", footer: { model: "Grok 4.7", window: "256K", effort: "high", fast: false, percent: 4.2 } });
    expect(await backend.paneText("wC:p1", 80)).toBe(demoCursorLiveScreen(null, "idle").replace("Grok 4.7 256K Medium", "Grok 4.7 256K High"));
    backend.close();
  });
});

describe("the captures", () => {
  it("68-70 on the demo's Cursor pane: the chips, the Effort menu, High picked", async () => {
    const { cursorChipsCaptureSteps } = await import("../src/main/capture");
    const { demoHostIds } = await import("../src/main/demo/demo-hosts");
    const steps = cursorChipsCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual(["68-cursor-chips", "69-cursor-effort-menu", "70-cursor-effort-high"]);
    expect(steps[0]!.commands).toContainEqual({ type: "select-pane", hostId: demoHostIds.macMini, paneId: "wC:p1" });
    expect(steps[1]!.commands).toEqual([{ type: "click", selector: ".cmp-bar .chip.pick.effort .pick-b" }]);
    expect(steps[2]!.commands).toEqual([{ type: "click", selector: ".chip-menu button[role=menuitemradio]:nth-of-type(3)" }]);
  });
});
