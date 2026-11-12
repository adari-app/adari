// The Running strip right above the message box: one
// item per running shell, monitor and subagent (an icon per kind, its
// description on one line, the time it has run, ticking); nothing when
// nothing runs; a click opens a small panel with the command or the prompt
// (first lines) and a monitor's newest event; Esc or a click elsewhere closes
// it (escape-owners.ts); an item leaves when it ends. The twin of HerdrKit's
// CompanionChatRunningTests (the same fixtures).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runningWork, type ChatRunningWork } from "../src/shared/chat/model";
import { at, reply, timelineOf } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";
import { busyTurn, notice, queued, toolResult } from "./support/running-lines";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { RunningStripView } = await import("../src/renderer/chat/RunningStrip");
const { panelView, shownTimeline, stripItems, stripTitle } = await import("../src/renderer/chat/running-strip");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");

type Handler = (event: unknown) => void;
let listeners: { type: string; handler: Handler }[] = [];

beforeEach(() => {
  listeners = [];
  escapeOwners.reset();
  vi.stubGlobal("window", {
    addEventListener: (type: string, handler: Handler) => listeners.push({ type, handler }),
    removeEventListener: (type: string, handler: Handler) => {
      listeners = listeners.filter((entry) => !(entry.type === type && entry.handler === handler));
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const fire = (type: string, event: unknown): void => {
  for (const entry of listeners.slice()) if (entry.type === type) entry.handler(event);
};
const texts = (tree: unknown): string[] => elements(tree).flatMap((e) => (typeof e.props["children"] === "string" ? [e.props["children"] as string] : []));
const byClass = (tree: unknown, name: string) => elements(tree).filter((e) => typeof e.props["className"] === "string" && (e.props["className"] as string).split(" ").includes(name));

const busy = (): readonly ChatRunningWork[] => runningWork(timelineOf(busyTurn).timeline);

describe("the strip's items", () => {
  it("has one item per running shell, monitor and subagent, oldest first, each on one line with the time it has run", () => {
    const items = stripItems(busy(), at(62));
    expect(items.map((item) => [item.kind, item.title, item.elapsed])).toEqual([
      ["shell", "Start the dev server", "1m 0s"],
      ["monitor", "Watch the build for errors", "59s"],
      ["agent", "Check the phone layout", "58s"],
      ["agent", "Read the banner", "57s"],
    ]);
    expect(items.map((item) => item.kindLabel)).toEqual(["Background command", "Monitor", "Background agent", "Agent"]);
    // A description over more than one line shows its first.
    expect(stripTitle("Build it\nthen test it")).toBe("Build it");
  });

  it("is empty when nothing runs: the shell's notice ends it, the agents' ends end them", () => {
    const ended = [
      ...busyTurn,
      queued(notice({ task: "b7k2q9", toolUse: "toolu_sh", status: "completed", summary: 'Background command "Start the dev server" completed (exit code 0)' }), 20),
      queued(notice({ task: "m4x8", toolUse: "toolu_mon", status: "completed", summary: 'Monitor "Watch the build for errors" stream ended' }), 21),
      queued(notice({ task: "a1b2c3d4e5f60718", toolUse: "toolu_bga", status: "completed" }), 22),
      toolResult("toolu_fga", "Banner.swift sets no lineLimit.", { status: "completed" }, "r4", 23),
      reply("Done.", "a5", 24, true),
    ];
    expect(stripItems(runningWork(timelineOf(ended).timeline), at(30))).toEqual([]);
  });

  it("follows Herdr's status: a pane gone runs nothing, an idle one keeps its background work but not its foreground agent", () => {
    const { timeline } = timelineOf(busyTurn);
    expect(runningWork(shownTimeline(timeline, "absent"))).toEqual([]);
    expect(runningWork(shownTimeline(timeline, "idle")).map((work) => work.id)).toEqual(["toolu_sh", "toolu_mon", "toolu_bga"]);
    expect(runningWork(shownTimeline(timeline, "working")).length).toBe(4);
  });

  it("opens to the command's or prompt's first lines and a monitor's newest event", () => {
    const [shell, monitor, agent] = busy();
    expect(panelView(shell!)).toEqual({
      label: "Background command",
      title: "Start the dev server",
      heading: "Command",
      lines: ["npm run dev -- --port 5173", "sleep 1", "echo ready"],
      more: 0,
      event: null,
      step: null,
    });
    expect(panelView(monitor!).event).toBe("ERROR src/a.ts: missing semicolon");
    expect(panelView(agent!).heading).toBe("Prompt");
    expect(panelView(agent!).lines).toEqual(["Open the phone layout and check the chips row fits at 375 pt.", "Report any overflow."]);
    const long = { ...shell!, detail: Array.from({ length: 9 }, (_, n) => `line ${n + 1}`).join("\n") };
    expect(panelView(long).lines).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"]);
    expect(panelView(long).more).toBe(3);
  });
});

describe("the strip", () => {
  it("shows nothing when nothing runs", () => {
    const view = new HookHost(RunningStripView as (props: object) => unknown, { items: [], now: at(10) });
    view.render();
    expect(view.tree).toBe(null);
  });

  it("draws an item per running thing, its icon, title and time; the time ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(62) * 1_000);
    const view = new HookHost(RunningStripView as (props: object) => unknown, { items: busy() });
    view.render();
    const items = byClass(view.tree, "run-item");
    expect(items.length).toBe(4);
    expect(items.map((item) => item.props["data-kind"])).toEqual(["shell", "monitor", "agent", "agent"]);
    expect(texts(view.tree)).toContain("Start the dev server");
    expect(texts(view.tree)).toContain("1m 0s");
    // The strip scrolls sideways when its items do not fit (never wraps under the box).
    expect(byClass(view.tree, "run-items").length).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(texts(view.tree)).toContain("1m 1s");
  });

  it("opens a panel on a click; Esc closes it, and it holds Esc while open", () => {
    const view = new HookHost(RunningStripView as (props: object) => unknown, { items: busy(), now: at(62) });
    view.render();
    const monitorItem = byClass(view.tree, "run-item")[1]!;
    (monitorItem.props["onClick"] as () => void)();
    expect(byClass(view.tree, "run-panel").length).toBe(1);
    expect(texts(view.tree)).toContain("tail -f build.log | grep --line-buffered ERROR");
    expect(texts(view.tree)).toContain("ERROR src/a.ts: missing semicolon");
    expect(escapeOwners.any()).toBe(true);
    fire("keydown", { key: "Escape", preventDefault: () => undefined, stopPropagation: () => undefined });
    expect(byClass(view.tree, "run-panel").length).toBe(0);
  });

  it("closes the panel on a click elsewhere, and toggles it from its item", () => {
    const view = new HookHost(RunningStripView as (props: object) => unknown, { items: busy(), now: at(62) });
    view.render();
    const item = () => byClass(view.tree, "run-item")[0]!;
    (item().props["onClick"] as () => void)();
    expect(byClass(view.tree, "run-panel").length).toBe(1);
    fire("mousedown", { target: { nodeType: 1 } });
    expect(byClass(view.tree, "run-panel").length).toBe(0);
    (item().props["onClick"] as () => void)();
    (item().props["onClick"] as () => void)();
    expect(byClass(view.tree, "run-panel").length).toBe(0);
  });

  it("lets an item go when it ends, and its open panel with it", () => {
    const items = busy();
    const view = new HookHost(RunningStripView as (props: object) => unknown, { items, now: at(62) });
    view.render();
    (byClass(view.tree, "run-item")[0]!.props["onClick"] as () => void)();
    expect(byClass(view.tree, "run-panel").length).toBe(1);
    view.render({ items: items.slice(1), now: at(63) });
    expect(byClass(view.tree, "run-item").length).toBe(3);
    expect(byClass(view.tree, "run-panel").length).toBe(0);
    view.render({ items: [], now: at(64) });
    expect(view.tree).toBe(null);
  });
});
