// "While you were away" in the page (src/renderer/away/Away.tsx), ported from
// the Swift app's CompanionAwayViewTests: the screen's groups (Quiet folded), a
// card's lines, the machine lines, All caught up, Mark all seen, and "shown"
// said once per digest. Then the real App on the small hooks host: the View
// menu's While You Were Away opens the screen (the sidebar has no line for
// it), a card opens its pane in Chat, Escape and a pane leave it. Fixtures only.

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { buildAwayDigest, awayActivity, type AwayCard, type AwayDigest, type AwayMacInput, type AwayPane, type AwayViewState } from "../src/shared/away/digest";
import { sinceClock } from "../src/shared/away/text";
import type { HostView, MainTab } from "../src/shared/ipc-contract";
import type { ViewCommand } from "../src/shared/view-commands";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { AwayScreen, AwayCardView } = await import("../src/renderer/away/Away");
const { App } = await import("../src/renderer/App");
const { Sidebar } = await import("../src/renderer/components/Sidebar");
const { MainPane } = await import("../src/renderer/components/MainPane");
const { revealRequests } = await import("../src/renderer/search/reveal");

const date = (iso: string): number => Date.parse(iso) / 1000;
const now = date("2026-11-02T09:00:00.000Z");
const since = now - 3 * 3600;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function pane(id: string, name: string, status: AwayPane["status"], folder = "/srv/app"): AwayPane {
  return { paneID: id, name, kind: "claude", folder, status, statusSince: now - 600, session: null };
}

/** Studio (online) with four agents, one per group, and Laptop offline. */
function digest(): AwayDigest {
  const studio: AwayMacInput = {
    id: "studio",
    name: "Studio",
    since,
    state: { kind: "online" },
    panes: [
      { pane: pane("w1:p1", "api", "blocked"), transcript: { kind: "read", activity: awayActivity({ lastActivityAt: now - 3000 }) } },
      {
        pane: pane("w1:p2", "web", "done"),
        transcript: {
          kind: "read",
          activity: awayActivity({
            turnsFinished: 2,
            lastReply: { lines: ["## Done", "- fixed the login", "- added a test"], time: now - 1200 },
            files: ["/srv/app/src/login.ts", "/srv/app/test/login.test.ts", "/srv/app/a", "/srv/app/b", "/srv/app/c", "/srv/app/d"],
            lastTurnEndedAt: now - 1200,
            lastActivityAt: now - 1200,
            errorCount: 2,
            lastError: { text: "npm test exited 1", time: now - 1500 },
            firstNewItemID: "u7",
          }),
        },
      },
      { pane: pane("w1:p3", "docs", "working", "/srv/docs"), transcript: { kind: "read", activity: awayActivity({ lastActivityAt: now - 60 }) } },
      { pane: pane("w1:p4", "old", "idle", "/srv/old"), transcript: { kind: "noTranscript" } },
    ],
    git: { "/srv/app": { kind: "commits", commits: [{ hash: "4f9c2a7d1e3b5c6a8d0f2e4b6c8a0d2f4e6b8c0a", subject: "Fix the login", time: now - 900 }] } },
  };
  const laptop: AwayMacInput = { id: "laptop", name: "Laptop", since, state: { kind: "offline", since: now - 7200 }, panes: [], git: {} };
  return buildAwayDigest([studio, laptop], now);
}

const state = (value: AwayDigest | null, fields: Partial<AwayViewState> = {}): AwayViewState => ({ digest: value, building: false, seenAt: null, ...fields });
const texts = (tree: unknown): string[] =>
  elements(tree)
    .map((element) => element.props.children)
    .filter((children): children is string => typeof children === "string");
const byClass = (tree: unknown, className: string) => elements(tree).filter((element) => element.props["className"] === className);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the away screen", () => {
  function screen(value: AwayViewState) {
    const calls: string[] = [];
    const view = new HookHost(AwayScreen as (props: object) => unknown, {
      state: value,
      now,
      onClose: () => calls.push("close"),
      onOpenCard: (card: AwayCard) => calls.push("open " + card.id),
      onMarkSeen: () => calls.push("seen"),
      onShown: () => calls.push("shown"),
    });
    view.render();
    return { view, calls };
  }

  it("groups the cards, Quiet folded until opened, with the machines' lines", () => {
    const { view, calls } = screen(state(digest()));
    expect(calls).toEqual(["shown"]);
    const groups = elements(view.tree).filter((element) => element.type === "section").map((element) => element.props["data-group"]);
    expect(groups).toEqual(["needsYou", "finished", "working", "quiet"]);
    const cards = () => elements(view.tree).filter((element) => element.type === AwayCardView).map((element) => (element.props["card"] as AwayCard).name);
    expect(cards()).toEqual(["api", "web", "docs"]);
    expect(byClass(view.tree, "away-mac").map((element) => element.props.children)).toEqual(["Laptop: offline since " + sinceClock(now - 7200, now)]);
    expect(texts(view.tree)).toContain("4 agents: 1 needs you, 1 finished, 1 commit");
    const quiet = elements(view.tree).find((element) => element.props["className"] === "away-group-h" && element.type === "button")!;
    (quiet.props["onClick"] as () => void)();
    expect(cards()).toEqual(["api", "web", "docs", "old"]);
  });

  it("a card shows its run, last reply, files, commits, error and note, and opens its pane", () => {
    const opened: string[] = [];
    const web = digest().cards.find((card) => card.name === "web")!;
    const tree = (AwayCardView as (props: object) => unknown)({ card: web, now, onOpen: (card: AwayCard) => opened.push(card.id) });
    const all = texts(tree);
    expect(all).toEqual(
      expect.arrayContaining([
        "web",
        "claude",
        "Studio · app",
        "15m ago",
        "2 turns finished · 6 files changed · 1 commit · 2 errors",
        "Done",
        "• fixed the login",
        "• added a test",
        "src/login.ts",
        "test/login.test.ts",
        "4f9c2a7",
        "Fix the login",
        "Last of 2 errors: npm test exited 1",
      ]),
    );
    expect(elements(tree).filter((element) => element.props["className"] === "f").length).toBe(5);
    (elements(tree)[0]!.props["onClick"] as () => void)();
    expect(opened).toEqual(["studio|w1:p2"]);
    const api = digest().cards.find((card) => card.name === "api")!;
    const waiting = (AwayCardView as (props: object) => unknown)({ card: api, now, onOpen: () => undefined });
    expect(texts(waiting)).toContain("Waiting 10m 0s");
    const old = digest().cards.find((card) => card.name === "old")!;
    expect(texts((AwayCardView as (props: object) => unknown)({ card: old, now, onOpen: () => undefined }))).toContain(
      "No transcript to read for this agent: its status only.",
    );
  });

  it("Mark all seen, then All caught up; reading and nothing yet", () => {
    const { view, calls } = screen(state(digest()));
    const mark = elements(view.tree).find((element) => element.props.children === "Mark all seen")!;
    expect(mark.props["disabled"]).toBe(false);
    (mark.props["onClick"] as () => void)();
    expect(calls).toEqual(["shown", "seen"]);

    const after = screen(state({ ...digest(), cards: [] }, { seenAt: now }));
    expect(texts(after.view.tree)).toEqual(expect.arrayContaining(["All caught up", "Marked as seen."]));
    expect(elements(after.view.tree).find((element) => element.props.children === "Mark all seen")!.props["disabled"]).toBe(true);

    const reading = screen(state(null, { building: true }));
    expect(texts(reading.view.tree)).toEqual(expect.arrayContaining(["Reading…", "Reading what your agents did…"]));
    expect(reading.calls).toEqual([]);
  });
});

function topology() {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "done" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "done" }],
    panes: [{ pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/srv/app", agent: "claude", agent_status: "done", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p2", agent: "claude", agent_status: "done" }],
  });
}

describe("the away screen in the App", () => {
  async function app() {
    let onAway: ((state: AwayViewState) => void) | null = null;
    let onView: ((command: ViewCommand) => void) | null = null;
    const keys: ((event: { key: string }) => void)[] = [];
    const sent: string[] = [];
    const host: HostView = { id: "studio", name: "Studio", kind: "ssh", address: "me@studio:22", platform: "macOS", state: "connected", error: null, topology: topology(), fetchedAtMs: 0 };
    vi.stubGlobal("window", {
      herdrDesktop: {
        appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
        listHosts: async () => [host],
        onHostsChanged: () => () => undefined,
        onAppCommand: () => () => undefined,
        onViewCommand: (listener: (command: ViewCommand) => void) => {
          onView = listener;
          return () => undefined;
        },
        ghosttyInfo: async () => ({ shown: false }),
        appCommandDone: () => undefined,
        awayState: async () => state(null, { building: true }),
        onAwayUpdate: (listener: (state: AwayViewState) => void) => {
          onAway = listener;
          return () => undefined;
        },
        awayShown: () => sent.push("shown"),
        awayMarkSeen: () => sent.push("seen"),
      },
      addEventListener: (type: string, listener: (event: { key: string }) => void) => {
        if (type === "keydown") keys.push(listener);
      },
      removeEventListener: (type: string, listener: (event: { key: string }) => void) => {
        const index = keys.indexOf(listener);
        if (type === "keydown" && index >= 0) keys.splice(index, 1);
      },
    });
    vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() } });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      callback(0);
      return 0;
    });
    const ui = new HookHost(App as (props: object) => unknown, {});
    ui.render();
    await flush();
    const find = (type: unknown) => elements(ui.tree).find((element) => element.type === type);
    // The View menu's While You Were Away (the sidebar has no line for it).
    const open = () => onView!("open-away");
    return { ui, find, open, sent, keys, away: (value: AwayViewState) => onAway!(value) };
  }

  it("the View menu opens the screen; a card opens its pane in Chat; Escape and a pane leave it", async () => {
    const a = await app();
    expect(elements(a.find(Sidebar)!.props["top"]).some((element) => element.props["className"] === "away-line")).toBe(false);
    a.open();
    expect((a.find(AwayScreen)!.props["state"] as AwayViewState).building).toBe(true);
    a.away(state(digest()));
    expect((a.find(AwayScreen)!.props["state"] as AwayViewState).digest?.cards.length).toBe(4);
    (a.find(AwayScreen)!.props["onShown"] as () => void)();
    expect(a.sent).toEqual(["shown"]);

    const screenProps = a.find(AwayScreen)!.props;
    expect(screenProps["now"]).toBeGreaterThan(0);
    (screenProps["onMarkSeen"] as () => void)();
    expect(a.sent).toEqual(["shown", "seen"]);

    const web = digest().cards.find((card) => card.name === "web")!;
    (screenProps["onOpenCard"] as (card: AwayCard) => void)(web);
    expect(a.find(AwayScreen)).toBeUndefined();
    const main = a.find(MainPane)!.props;
    expect([(main["row"] as { paneID: string }).paneID, main["tab"] as MainTab]).toEqual(["w1:p2", "chat"]);
    // At the first message after the user left.
    expect(revealRequests.peek("studio", "w1:p2")).toMatchObject({ messageId: "u7" });

    a.open();
    expect(a.find(AwayScreen)).toBeDefined();
    for (const key of a.keys.slice()) key({ key: "Escape" });
    expect(a.find(AwayScreen)).toBeUndefined();

    a.open();
    (a.find(Sidebar)!.props["onSelect"] as (h: string, p: string) => void)("studio", "w1:p2");
    expect(a.find(AwayScreen)).toBeUndefined();
    a.ui.unmount();
  });
});
