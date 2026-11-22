// The notifications, the Dock badge and the menu bar item (src/main/needs-notifier.ts) with the recording port,
// never a real notification, menu bar item or Dock: transitions only, a machine's first sight and a reconnect quiet,
// nothing while the window has focus, the three switches, the count across machines, the menu's lines, and a click
// opening the right agent; a wait belonging to its machine's connection (an old notification or menu item never opens
// another agent); who started or stopped judged on the full list of who is waiting, never on the shown rows (an agent
// sliding into or out of the first 100 is no start or stop; a cut-off list announces nothing past it and repeats
// nothing). And the report the page builds from the sidebar's own Needs you rows
// (src/shared/needs-notify.ts needsYouReport), and the switches kept in a file.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { fileNotifySettings, memoryNotifySettings, NeedsNotifier, RecordedNotifyPort, testAnswerWaitMs } from "../src/main/needs-notifier";
import { buildDesktopSidebar, type DesktopRow, type SidebarHost } from "../src/shared/desktop-sidebar";
import {
  defaultNotifySettings,
  menuBarView,
  needsCountLine,
  needsNotification,
  maxReportRows,
  maxReportWaiting,
  needsYouReport,
  notifyTexts,
  shownText,
  testSentText,
  testUnsupportedText,
  type NeedsYouEntry,
  type NeedsYouReport,
} from "../src/shared/needs-notify";
import type { SidebarRow } from "../src/shared/sidebar-model";

function entry(hostId: string, paneId: string, more: Partial<NeedsYouEntry> = {}): NeedsYouEntry {
  return {
    hostId,
    paneId,
    name: `Claude ${paneId}`,
    pill: "Pending Approval",
    project: "web",
    machine: hostId === "mini" ? "Mac mini" : "build-box",
    summary: null,
    ...more,
  };
}

const live = (...machines: [string, string][]) => machines.map(([hostId, epoch]) => ({ hostId, epoch }));

/** A report: the rows shown, the machines answering; who is waiting (the rows by default) and the count (theirs by default). */
function report(rows: NeedsYouEntry[], machines: [string, string][], total?: number, waiting: NeedsYouEntry[] = rows): NeedsYouReport {
  return { rows, waiting: waiting.map((one) => [one.hostId, one.paneId]), total: total ?? waiting.length, live: live(...machines) };
}

/** As the page sends it: everyone waiting named, the first maxReportRows of them shown. */
function full(waiting: NeedsYouEntry[], machines: [string, string][]): NeedsYouReport {
  return report(waiting.slice(0, maxReportRows), machines, waiting.length, waiting);
}

const agents = (count: number, from = 0) => Array.from({ length: count }, (_, index) => entry("mini", `w1:p${from + index}`));

function setup(settings = defaultNotifySettings) {
  const port = new RecordedNotifyPort();
  const notifier = new NeedsNotifier(port, memoryNotifySettings(settings));
  notifier.start();
  return { port, notifier };
}

const a = entry("mini", "w1:p1");
const b = entry("mini", "w1:p2", { pill: "Awaiting Input", summary: "Which branch should I use?" });
const c = entry("box", "w2:p1");

describe("the needs-you notifications", () => {
  it("are quiet for what was already waiting when a machine is first seen (the app opening)", () => {
    const { port, notifier } = setup();
    notifier.update(report([a, b], [["mini", "1:1"]]));
    expect(port.notifications).toEqual([]);
    expect(port.badges.at(-1)).toBe(2);
    expect(port.menuBar?.items[0]).toEqual({ kind: "line", label: "2 agents need you" });
  });

  it("notify once when an agent starts needing you, close when it stops, and notify again when it starts again", () => {
    const { port, notifier } = setup();
    notifier.update(report([], [["mini", "1:1"]]));
    notifier.update(report([a], [["mini", "1:1"]]));
    expect(port.open()).toEqual([{ title: "Claude w1:p1", body: "Pending Approval · web · Mac mini", silent: false }]);
    // The same list again, or a list with another one added: still one for it.
    notifier.update(report([a], [["mini", "1:1"]]));
    notifier.update(report([a, b], [["mini", "1:1"]]));
    expect(port.notifications.map((record) => record.content.title)).toEqual(["Claude w1:p1", "Claude w1:p2"]);
    expect(port.notifications[1]!.content.body).toBe("Awaiting Input · web · Mac mini\nWhich branch should I use?");
    // a stops needing you: its notification closes, b's stays.
    notifier.update(report([b], [["mini", "1:1"]]));
    expect(port.open().map((content) => content.title)).toEqual(["Claude w1:p2"]);
    // a again: a new one.
    notifier.update(report([a, b], [["mini", "1:1"]]));
    expect(port.notifications.map((record) => record.content.title)).toEqual(["Claude w1:p1", "Claude w1:p2", "Claude w1:p1"]);
    expect(port.open().map((content) => content.title)).toEqual(["Claude w1:p2", "Claude w1:p1"]);
  });

  it("are quiet when a machine reconnects (a new connection) or comes back after it was not answering", () => {
    const { port, notifier } = setup();
    notifier.update(report([], [["mini", "1:1"], ["box", "1:2"]]));
    // The Mac mini on a new connection: what waits there now is quiet; build-box's new one notifies.
    notifier.update(report([a, c], [["mini", "1:3"], ["box", "1:2"]]));
    expect(port.notifications.map((record) => record.content.title)).toEqual(["Claude w2:p1"]);
    // build-box stops answering, then answers again on the same connection with a new one waiting: quiet.
    notifier.update(report([a, c], [["mini", "1:3"]]));
    notifier.update(report([a, c, entry("box", "w2:p2")], [["mini", "1:3"], ["box", "1:2"]]));
    expect(port.notifications).toHaveLength(1);
    // A machine added again (a new sidebar entry): quiet.
    notifier.update(report([a, c, entry("box", "w2:p2"), entry("box", "w2:p3")], [["mini", "1:3"], ["box", "2:2"]]));
    expect(port.notifications).toHaveLength(1);
    // And a row on a machine the report does not list as answering never notifies.
    notifier.update(report([a, c, entry("box", "w2:p2"), entry("box", "w2:p3"), entry("gone", "w9:p9")], [["mini", "1:3"], ["box", "2:2"]]));
    expect(port.notifications).toHaveLength(1);
    expect(port.badges.at(-1)).toBe(5);
  });

  it("are quiet while Adari's window is the focused window, and not shown later when it loses focus", () => {
    const { port, notifier } = setup();
    notifier.update(report([], [["mini", "1:1"]]));
    port.focused = true;
    notifier.update(report([a], [["mini", "1:1"]]));
    port.focused = false;
    notifier.update(report([a], [["mini", "1:1"]]));
    notifier.update(report([a, b], [["mini", "1:1"]]));
    expect(port.notifications.map((record) => record.content.title)).toEqual(["Claude w1:p2"]);
    // The window gets focus: the ones shown close (T3's rule); the count stays.
    notifier.focused();
    expect(port.open()).toEqual([]);
    expect(port.badges.at(-1)).toBe(2);
  });

  it("follow the three switches: Notify off shows none, Play a sound off is silent, the menu bar item goes at once", () => {
    const { port, notifier } = setup({ notify: false, sound: true, menuBar: true });
    notifier.update(report([], [["mini", "1:1"]]));
    notifier.update(report([a], [["mini", "1:1"]]));
    expect(port.notifications).toEqual([]);
    expect(port.badges.at(-1)).toBe(1);
    notifier.setSettings({ notify: true, sound: false });
    notifier.update(report([a, b], [["mini", "1:1"]]));
    expect(port.notifications.map((record) => record.content.silent)).toEqual([true]);
    expect(port.menuBar).not.toBeNull();
    notifier.setSettings({ menuBar: false });
    expect(port.menuBar).toBeNull();
    // Off, nothing comes back with a new list; on again, it shows the list as it is.
    notifier.update(report([b], [["mini", "1:1"]]));
    expect(port.menuBar).toBeNull();
    expect(notifier.settings()).toEqual({ notify: true, sound: false, menuBar: false });
    notifier.setSettings({ menuBar: true });
    expect(port.menuBar?.title).toBe("1");
  });

  it("can start with the menu bar item off: none is ever made", () => {
    const { port, notifier } = setup({ ...defaultNotifySettings, menuBar: false });
    notifier.update(report([a], [["mini", "1:1"]]));
    expect(port.menuBarSets).toBe(0);
  });

  it("badge the Dock with the count across machines, focused or not, none at zero", () => {
    const { port, notifier } = setup();
    expect(port.badges).toEqual([0]);
    port.focused = true;
    notifier.update(report([a, c], [["mini", "1:1"], ["box", "1:1"]]));
    expect(port.badges.at(-1)).toBe(2);
    // Rows past the report's cap still count.
    notifier.update(report([a, c], [["mini", "1:1"], ["box", "1:1"]], 140));
    expect(port.badges.at(-1)).toBe(140);
    notifier.update(report([], [["mini", "1:1"], ["box", "1:1"]]));
    expect(port.badges.at(-1)).toBe(0);
    expect(port.menuBar?.title).toBe("");
  });

  it("open the right agent from a notification's click and from the menu, and the menu's other items do what they say", () => {
    const { port, notifier } = setup();
    notifier.update(report([], [["box", "1:1"]]));
    notifier.update(report([c], [["box", "1:1"]]));
    port.notifications[0]!.click();
    expect(port.reveals).toEqual([{ hostId: "box", paneId: "w2:p1" }]);
    port.pick({ kind: "agent", hostId: "box", paneId: "w2:p1" });
    port.pick({ kind: "open" });
    port.pick({ kind: "settings" });
    port.pick({ kind: "quit" });
    expect(port.reveals).toEqual([{ hostId: "box", paneId: "w2:p1" }, { hostId: "box", paneId: "w2:p1" }, null]);
    expect(port.settingsOpened).toBe(1);
    expect(port.quits).toBe(1);
  });

  it("send a test notification (it has macOS ask the first time), or say the system cannot", async () => {
    const { port, notifier } = setup({ ...defaultNotifySettings, sound: false });
    expect(await notifier.test()).toBe(testSentText);
    expect(port.notifications.map((record) => record.content)).toEqual([
      { title: "Adari", body: "Notifications are on. Adari tells you here when an agent needs you.", silent: true },
    ]);
    port.notifications[0]!.click();
    expect(port.reveals).toEqual([null]);
    port.supported = false;
    expect(await notifier.test()).toBe(testUnsupportedText);
    expect(port.notifications).toHaveLength(1);
  });

  it("let go of everything on quit: notifications closed, no badge, no menu bar item, no more reports taken", () => {
    const { port, notifier } = setup();
    notifier.update(report([], [["mini", "1:1"]]));
    notifier.update(report([a], [["mini", "1:1"]]));
    notifier.stop();
    expect(port.open()).toEqual([]);
    expect(port.badges.at(-1)).toBe(0);
    expect(port.menuBar).toBeNull();
    notifier.update(report([a, b], [["mini", "1:1"]]));
    expect(port.notifications).toHaveLength(1);
    expect(port.menuBar).toBeNull();
  });
});

describe("a wait belongs to its machine's connection", () => {
  it("the reviewer's case: A shown, its machine stops answering (A closed), comes back on a new connection with B at A's key; a click on A opens nothing", () => {
    const { port, notifier } = setup();
    notifier.update(report([], [["mini", "1:1"]]));
    notifier.update(report([a], [["mini", "1:1"]]));
    expect(port.open().map((content) => content.title)).toEqual(["Claude w1:p1"]);
    const clickA = port.notifications[0]!.click;
    // The Mac mini stops answering: its row stays in the sidebar's last-known list, A's notification closes.
    notifier.update(report([a], []));
    expect(port.open()).toEqual([]);
    // Back on another connection, another agent B sits at A's machine and pane id: quiet (a reconnect).
    notifier.update(report([entry("mini", "w1:p1", { name: "Codex" })], [["mini", "1:2"]]));
    expect(port.notifications).toHaveLength(1);
    clickA();
    expect(port.reveals).toEqual([null]);
  });

  it("a new connection straight away (no gap) or the machine removed closes what was shown for it, and its click opens nothing", () => {
    const { port, notifier } = setup();
    notifier.update(report([], [["mini", "1:1"], ["box", "1:1"]]));
    notifier.update(report([a, c], [["mini", "1:1"], ["box", "1:1"]]));
    expect(port.open()).toHaveLength(2);
    notifier.update(report([a, c], [["mini", "1:2"], ["box", "1:1"]]));
    expect(port.open().map((content) => content.title)).toEqual(["Claude w2:p1"]);
    notifier.update(report([a], [["mini", "1:2"]]));
    expect(port.open()).toEqual([]);
    port.notifications[0]!.click();
    port.notifications[1]!.click();
    expect(port.reveals).toEqual([null, null]);
  });

  it("a menu item kept open across the same change opens nothing; the menu made after it opens the agent there now", () => {
    const { port, notifier } = setup();
    notifier.update(report([a], [["mini", "1:1"]]));
    const oldMenu = port.menuPickers.at(-1)!;
    const sets = port.menuPickers.length;
    notifier.update(report([a], []));
    notifier.update(report([entry("mini", "w1:p1", { name: "Codex" })], [["mini", "1:2"]]));
    expect(port.menuPickers.length).toBeGreaterThan(sets);
    oldMenu({ kind: "agent", hostId: "mini", paneId: "w1:p1" });
    expect(port.reveals).toEqual([null]);
    port.pick({ kind: "agent", hostId: "mini", paneId: "w1:p1" });
    expect(port.reveals).toEqual([null, { hostId: "mini", paneId: "w1:p1" }]);
    // The same words on the same connection, but a new wait (it stopped, then started again): the old menu still opens nothing.
    const before = port.menuPickers.at(-1)!;
    notifier.update(report([], [["mini", "1:2"]]));
    notifier.update(report([entry("mini", "w1:p1", { name: "Codex" })], [["mini", "1:2"]]));
    before({ kind: "agent", hostId: "mini", paneId: "w1:p1" });
    expect(port.reveals.at(-1)).toBeNull();
    // Its other items keep working.
    oldMenu({ kind: "open" });
    expect(port.reveals.at(-1)).toBeNull();
    expect(port.reveals).toHaveLength(4);
  });

  it("the normal click still opens its agent, and so does one after the window took focus (the wait is the same)", () => {
    const { port, notifier } = setup();
    notifier.update(report([], [["mini", "1:1"]]));
    notifier.update(report([a, b], [["mini", "1:1"]]));
    port.notifications[1]!.click();
    expect(port.reveals).toEqual([{ hostId: "mini", paneId: "w1:p2" }]);
    notifier.focused();
    port.notifications[0]!.click();
    expect(port.reveals).toEqual([{ hostId: "mini", paneId: "w1:p2" }, { hostId: "mini", paneId: "w1:p1" }]);
    // A clicked notification is let go of; the other agent's wait is untouched.
    notifier.update(report([a], [["mini", "1:1"]]));
    expect(port.notifications).toHaveLength(2);
  });
});

describe("who is waiting is judged on the full list, not on the shown rows", () => {
  it("101 waiting at launch, then the first stops: the 101st slides into the shown rows quietly", () => {
    const { port, notifier } = setup();
    const all = agents(101);
    notifier.update(full(all, [["mini", "1:1"]]));
    notifier.update(full(all.slice(1), [["mini", "1:1"]]));
    expect(port.notifications).toEqual([]);
    expect(port.badges.at(-1)).toBe(100);
  });

  it("an agent pushed out of the shown rows and back is one notification for one wait (and is not closed meanwhile)", () => {
    const { port, notifier } = setup();
    notifier.update(full([], [["mini", "1:1"]]));
    const hundred = agents(100);
    notifier.update(full(hundred, [["mini", "1:1"]]));
    expect(port.notifications).toHaveLength(100);
    const newer = entry("mini", "w9:p9");
    notifier.update(full([newer, ...hundred], [["mini", "1:1"]]));
    expect(port.notifications).toHaveLength(101);
    expect(port.notifications[99]!.closed).toBe(false);
    notifier.update(full(hundred, [["mini", "1:1"]]));
    expect(port.notifications).toHaveLength(101);
    expect(port.notifications.filter((record) => record.content.title === "Claude w1:p99")).toHaveLength(1);
    expect(port.notifications[99]!.closed).toBe(false);
    expect(port.notifications[100]!.closed).toBe(true);
  });

  it("150 waiting: an entrant past the shown rows is quiet but counted; one at the top notifies once", () => {
    const { port, notifier } = setup();
    const waiting = agents(150);
    notifier.update(full(waiting, [["mini", "1:1"]]));
    const beyond = entry("mini", "w8:p8");
    notifier.update(full([...waiting, beyond], [["mini", "1:1"]]));
    expect(port.notifications).toEqual([]);
    expect(port.badges.at(-1)).toBe(151);
    expect(port.menuBar?.items[0]).toEqual({ kind: "line", label: "151 agents need you" });
    const top = entry("mini", "w7:p7");
    notifier.update(full([top, ...waiting, beyond], [["mini", "1:1"]]));
    notifier.update(full([top, ...waiting, beyond], [["mini", "1:1"]]));
    expect(port.notifications.map((record) => record.content.title)).toEqual(["Claude w7:p7"]);
    expect(port.badges.at(-1)).toBe(152);
    // The quiet one stays known: brought into the shown rows, it is still no start.
    notifier.update(full([beyond, top, ...waiting], [["mini", "1:1"]]));
    expect(port.notifications).toHaveLength(1);
  });

  it("a cut-off list: nothing past it or new after it is announced, nothing announced is closed or repeated for being past it", () => {
    const { port, notifier } = setup();
    notifier.update(report([], [["mini", "1:1"]]));
    // The list names a and b of 5 waiting: a and b started (the last list named everyone, and they were not on it).
    notifier.update(report([a, b], [["mini", "1:1"]], 5));
    expect(port.notifications.map((record) => record.content.title)).toEqual(["Claude w1:p1", "Claude w1:p2"]);
    // Cut again, b past it now and another one named: the new one is quiet (it may have waited past the last cut); b stays.
    const d = entry("mini", "w1:p4");
    notifier.update(report([d, a], [["mini", "1:1"]], 5));
    expect(port.notifications).toHaveLength(2);
    expect(port.open()).toHaveLength(2);
    // The whole list again: b is the same wait (not repeated), d is known (not announced late).
    notifier.update(report([a, b, d], [["mini", "1:1"]]));
    expect(port.notifications).toHaveLength(2);
    // b stops: now it closes.
    notifier.update(report([a, d], [["mini", "1:1"]]));
    expect(port.open().map((content) => content.title)).toEqual(["Claude w1:p1"]);
    expect(port.badges.at(-1)).toBe(2);
  });

  it("a cut-off list keeps a wait past it only while its connection lasts", () => {
    const { port, notifier } = setup();
    notifier.update(report([], [["mini", "1:1"]]));
    notifier.update(report([a, b], [["mini", "1:1"]]));
    notifier.update(report([a], [["mini", "1:2"]], 5));
    expect(port.open()).toEqual([]);
    port.notifications[1]!.click();
    expect(port.reveals).toEqual([null]);
  });
});

describe("the menu bar item's menu", () => {
  const tail = [{ kind: "separator" }, { kind: "open", label: "Open Adari" }, { kind: "settings", label: "Settings…" }, { kind: "quit", label: "Quit Adari" }];

  it("at zero says no agent needs you, with no count beside the mark", () => {
    const view = menuBarView(report([], []));
    expect(view.title).toBe("");
    expect(view.tooltip).toBe("Adari");
    expect(view.items).toEqual([{ kind: "line", label: "No agent needs you" }, ...tail]);
  });

  it("at one lists it: name, project, machine, the pill's words", () => {
    const view = menuBarView(report([b], [["mini", "1:1"]]));
    expect(view.title).toBe("1");
    expect(view.tooltip).toBe("Adari: 1 agent needs you");
    expect(view.items).toEqual([
      { kind: "line", label: "1 agent needs you" },
      { kind: "agent", label: "Claude w1:p2 · web · Mac mini · Awaiting Input", hostId: "mini", paneId: "w1:p2" },
      ...tail,
    ]);
  });

  it("at 25 lists the first 20 in the sidebar's order and says and 5 more", () => {
    const rows = Array.from({ length: 25 }, (_, index) => entry("mini", `w1:p${index + 1}`));
    const view = menuBarView(report(rows, [["mini", "1:1"]]));
    expect(view.title).toBe("25");
    expect(view.items[0]).toEqual({ kind: "line", label: "25 agents need you" });
    const agents = view.items.filter((item) => item.kind === "agent");
    expect(agents.map((item) => (item.kind === "agent" ? item.paneId : ""))).toEqual(rows.slice(0, 20).map((row) => row.paneId));
    expect(view.items[21]).toEqual({ kind: "line", label: "and 5 more" });
    expect(view.items.slice(22)).toEqual(tail);
    expect(needsCountLine(0)).toBe("No agent needs you");
  });
});

describe("the report the page sends", () => {
  const row = (paneID: string, name: string, activity: string | undefined): SidebarRow =>
    ({ paneID, tabID: "t", workspaceID: "w1", workspaceLabel: "api", name, nameSource: "kind", kind: "claude", isAgent: true, status: "blocked", activity, glyph: "needsYou", isDimmed: false }) as unknown as SidebarRow;
  const desktopRow = (hostId: string, hostName: string, value: SidebarRow): DesktopRow => ({ key: `${hostId}/${value.paneID}`, hostId, hostName, row: value });

  it("carries each row's shown texts and keys, the pill as the row shows it, and the machines answering now", () => {
    const long = "x".repeat(400);
    const made = needsYouReport(
      [
        desktopRow("mini", "Mac mini", row("w1:p1", "Claude Code", "Claude Code")),
        desktopRow("mini", "Mac mini", row("w1:p2", "Codex", "Run\nnpm test?")),
        desktopRow("box", "build-box", row("w2:p1", long, undefined)),
      ],
      [
        { id: "mini", state: "connected", topology: {}, connection: 4, incarnation: 1 },
        { id: "box", state: "connected", topology: {}, catchingUp: true, connection: 1 },
        { id: "gone", state: "offline", topology: {}, connection: 2 },
        { id: "new", state: "connected", topology: null },
      ],
      new Map([["mini/w1:p2", "approval" as const]]),
    );
    expect(made.rows[0]).toEqual({ hostId: "mini", paneId: "w1:p1", name: "Claude Code", pill: "Awaiting Input", project: "api", machine: "Mac mini", summary: null });
    expect(made.rows[1]).toMatchObject({ pill: "Pending Approval", summary: "Run npm test?" });
    expect(made.rows[2]!.name).toHaveLength(160);
    expect(made.rows[2]!.name.endsWith("…")).toBe(true);
    expect(made.total).toBe(3);
    expect(made.waiting).toEqual([["mini", "w1:p1"], ["mini", "w1:p2"], ["box", "w2:p1"]]);
    expect(made.live).toEqual([{ hostId: "mini", epoch: "1:4" }]);
    expect(shownText("  a\u0000b\tc  ")).toBe("a b c");
    const nameless = needsYouReport([desktopRow("mini", "Mac mini", row("w1:p9", "  ", "Allow?"))], [], new Map());
    expect(nameless.rows[0]).toMatchObject({ name: "Agent", summary: "Allow?" });
  });

  it("is the sidebar's own Needs you list (buildDesktopSidebar), in its order, at most 100 rows with the rest counted", () => {
    const panes = Array.from({ length: 105 }, (_, index) =>
      JSON.stringify({ pane_id: `w1:p${index}`, terminal_id: `t${index}`, workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "blocked", revision: 1 }),
    );
    const host: SidebarHost = {
      id: "mini",
      name: "Mac mini",
      platform: "macOS",
      state: "connected",
      error: null,
      topology: decodeSessionTopology(
        JSON.parse(
          '{"version":"0.9.5","protocol":22,' +
            '"workspaces":[{"workspace_id":"w1","number":1,"label":"api","focused":true,"pane_count":105,"tab_count":1,"active_tab_id":"w1:t1","agent_status":"blocked"}],' +
            '"tabs":[{"tab_id":"w1:t1","workspace_id":"w1","number":1,"label":"main","focused":true,"pane_count":105,"agent_status":"blocked"}],' +
            `"panes":[${panes.join(",")}],"layouts":[],"agents":[]}`,
        ),
      ),
    };
    const sidebar = buildDesktopSidebar([host], { nowUnixMs: Date.now() });
    const made = needsYouReport(sidebar.needsYou, [{ ...host, connection: 1 }], new Map());
    expect(made.total).toBe(105);
    expect(made.rows).toHaveLength(100);
    expect(made.rows.map((r) => r.paneId)).toEqual(sidebar.needsYou.slice(0, 100).map((r) => r.row.paneID));
    expect(made.waiting).toEqual(sidebar.needsYou.map((r) => [r.hostId, r.row.paneID]));
    expect(made.rows[0]).toMatchObject({ project: "api", machine: "Mac mini", pill: "Awaiting Input" });
  });

  it("names at most 2000 waiting agents, in the sidebar's order, and counts the rest", () => {
    const many = Array.from({ length: maxReportWaiting + 1 }, (_, index) => desktopRow("mini", "Mac mini", row(`w1:p${index}`, "Claude Code", undefined)));
    const made = needsYouReport(many, [], new Map());
    expect(made.total).toBe(2_001);
    expect(made.rows).toHaveLength(100);
    expect(made.waiting).toHaveLength(2_000);
    expect(made.waiting.at(-1)).toEqual(["mini", "w1:p1999"]);
  });

  it("notification text: name as title; pill, project, machine; then the line", () => {
    expect(needsNotification(entry("mini", "w1:p1", { project: "", summary: "Allow edit?" }), true)).toEqual({
      title: "Claude w1:p1",
      body: "Pending Approval · Mac mini\nAllow edit?",
      silent: false,
    });
  });
});

describe("the switches, kept in a file", () => {
  const scratch = process.env["HERDR_TEST_SCRATCH"] || os.tmpdir();

  it("are all on by default, keep a change, and read a broken file as the defaults", () => {
    const dir = mkdtempSync(path.join(scratch, "notify-settings-"));
    const file = path.join(dir, "notify-settings.json");
    const first = fileNotifySettings(file);
    expect(first.load()).toEqual({ notify: true, sound: true, menuBar: true });
    first.save({ notify: true, sound: false, menuBar: false });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ notify: true, sound: false, menuBar: false });
    expect(fileNotifySettings(file).load()).toEqual({ notify: true, sound: false, menuBar: false });
    writeFileSync(file, "{not json");
    expect(fileNotifySettings(file).load()).toEqual(defaultNotifySettings);
    writeFileSync(file, JSON.stringify({ notify: "no", sound: 0, menuBar: false }));
    expect(fileNotifySettings(file).load()).toEqual({ notify: true, sound: true, menuBar: false });
  });

  it("a setting the notifier changes is saved", () => {
    const store = memoryNotifySettings();
    const notifier = new NeedsNotifier(new RecordedNotifyPort(), store);
    notifier.setSettings({ sound: false });
    expect(store.load()).toEqual({ notify: true, sound: false, menuBar: true });
  });
});

describe("what became of the last notification (macOS shows it, or does not)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A notifier on a port whose notifications wait for an answer, with a clock that moves by hand. */
  function held() {
    const port = new RecordedNotifyPort();
    port.outcome = null;
    let clock = 1_000;
    const notifier = new NeedsNotifier(port, memoryNotifySettings(), () => clock);
    notifier.start();
    notifier.update(report([], [["mini", "1:1"]]));
    return { port, notifier, tick: (ms: number) => (clock += ms) };
  }

  it("nothing is known before a notification is answered, nor from a system that does not say", async () => {
    const { port, notifier } = held();
    expect(notifier.delivery()).toBeNull();
    notifier.update(report([a], [["mini", "1:1"]]));
    expect(notifier.delivery()).toBeNull();
    port.notifications[0]!.answer("unknown");
    expect(notifier.delivery()).toBeNull();
    port.outcome = "unknown";
    expect(await notifier.test()).toBe(testSentText);
    expect(notifier.delivery()).toBeNull();
  });

  it("an agent's notification that fails marks it failed, with the time; a later one that shows clears it", () => {
    const { port, notifier, tick } = held();
    notifier.update(report([a], [["mini", "1:1"]]));
    port.notifications[0]!.answer("failed");
    expect(notifier.delivery()).toEqual({ outcome: "failed", at: 1_000 });
    tick(5_000);
    notifier.update(report([a, b], [["mini", "1:1"]]));
    expect(notifier.delivery()).toEqual({ outcome: "failed", at: 1_000 });
    port.notifications[1]!.answer("shown");
    expect(notifier.delivery()).toEqual({ outcome: "shown", at: 6_000 });
    // Only the first answer of a notification counts (the port answers once).
    port.notifications[1]!.answer("failed");
    expect(notifier.delivery()).toEqual({ outcome: "shown", at: 6_000 });
  });

  it("a failure changes nothing else: no retry, the badge and the menu bar item as before, the click still opens the agent, close still closes", () => {
    const { port, notifier } = held();
    notifier.update(report([a], [["mini", "1:1"]]));
    port.notifications[0]!.answer("failed");
    expect(port.notifications).toHaveLength(1);
    expect(port.badges.at(-1)).toBe(1);
    expect(port.menuBar?.items[0]).toEqual({ kind: "line", label: "1 agent needs you" });
    port.notifications[0]!.click();
    expect(port.reveals).toEqual([{ hostId: "mini", paneId: "w1:p1" }]);
    notifier.update(report([b], [["mini", "1:1"]]));
    expect(port.notifications).toHaveLength(2);
    port.notifications[1]!.answer("failed");
    notifier.update(report([], [["mini", "1:1"]]));
    expect(port.notifications[1]!.closed).toBe(true);
    expect(port.badges.at(-1)).toBe(0);
    expect(port.notifications).toHaveLength(2);
  });

  it("the test button's answer: Sent. when it shows, the off line when it fails; one notification each, never sent again", async () => {
    const { port, notifier } = held();
    const failing = notifier.test();
    expect(port.notifications).toHaveLength(1);
    port.notifications[0]!.answer("failed");
    expect(await failing).toBe(notifyTexts.offLine);
    expect(notifier.delivery()?.outcome).toBe("failed");
    const showing = notifier.test();
    port.notifications[1]!.answer("shown");
    expect(await showing).toBe(testSentText);
    expect(notifier.delivery()?.outcome).toBe("shown");
    expect(port.notifications).toHaveLength(2);
    expect(port.notifications.map((record) => record.content.title)).toEqual(["Adari", "Adari"]);
  });

  it("the test button says Sent. as before when no answer comes in time (nothing retried)", async () => {
    vi.useFakeTimers();
    const { port, notifier } = held();
    let said: string | null = null;
    void notifier.test().then((text) => (said = text));
    await vi.advanceTimersByTimeAsync(testAnswerWaitMs - 1);
    expect(said).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(said).toBe(testSentText);
    expect(notifier.delivery()).toBeNull();
    // A late answer is still kept; the test is not sent again.
    port.notifications[0]!.answer("failed");
    expect(notifier.delivery()?.outcome).toBe("failed");
    expect(port.notifications).toHaveLength(1);
  });

  it("Open Notification Settings goes to the port (which opens the one fixed address)", () => {
    const { port, notifier } = held();
    notifier.openSystemSettings();
    expect(port.systemSettingsOpened).toBe(1);
  });
});
