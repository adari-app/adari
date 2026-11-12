// The demo's streaming Cursor reply (src/main/demo/demo-live.ts)
// and its captures (66, 67). The Mac mini's Cursor pane (harbor) is idle until
// the user's message reaches it; then it works (Thinking, the lead-in and its Read,
// which land in the store as their own message), its reply grows a few words a
// frame above the braille spinner as Cursor draws it, lands in the store once
// written, and the spinner goes with the pane done. The real reader
// (ChatLiveScreen), the real reads in main (LiveReads over the registry and
// ChatService) and the page's merge (LiveRows) make of it one growing row, then
// the store's own row in its place, the lead-in shown once.

import { afterEach, describe, expect, it } from "vitest";

import { LiveReads } from "../src/main/chat/live-reads";
import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { DemoBackend, type DemoClock } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import {
  DemoCursorLiveReply,
  demoCursorLiveLandsMs,
  demoCursorLiveLeadIn,
  demoCursorLivePane,
  demoCursorLiveReadMs,
  demoCursorLiveReply,
  demoCursorLiveReplyMs,
  demoCursorLiveScreen,
  demoCursorLiveThinkMs,
  demoCursorLiveWords,
  demoCursorLiveWordsPerFrame,
  demoLiveFrameMs,
} from "../src/main/demo/demo-live";
import { HostRegistry } from "../src/main/hosts";
import { sendBound } from "../src/main/herdr/send";
import { bindingOf } from "../src/shared/send-binding";
import { ChatLiveMerge, ChatLiveScreen } from "../src/shared/chat/live-screen";
import { emptyTimeline, makeTurn, userMessage, type ChatItem, type ChatTimeline } from "../src/shared/chat/model";
import type { ChatLiveEvent, ChatUpdateEvent } from "../src/shared/ipc-contract";
import { LiveRows } from "../src/renderer/chat/live-rows";
import { eventually } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";

const fixtures = bundledFixturesForTests();
const message = "Which tests cover the limiter's window reset?";

const agentTexts = (timeline: ChatTimeline): string[] =>
  timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : [])));

const user: ChatItem = { type: "user", value: userMessage("u", message, null) };
const text = (id: string, markdown: string): ChatItem => ({ type: "agentText", value: { id, markdown, time: null } });
const timeline = (items: ChatItem[], finished = false): ChatTimeline => ({ ...emptyTimeline, turns: [makeTurn("t", { items: [user, ...items], isFinished: finished })] });

describe("the demo Cursor pane's screen", () => {
  it("idle, Thinking, the lead-in with its tool running or done, and the turn over: no reply", () => {
    expect(ChatLiveScreen.block(demoCursorLiveScreen(null, "idle"), "cursor")).toBeNull();
    for (const stage of ["thinking", "reading", "read", "done"] as const) expect(ChatLiveScreen.block(demoCursorLiveScreen(message, stage, 0, 3), "cursor"), stage).toBeNull();
  });

  it("then the reply's words as Cursor draws them, a row that only grows; once whole, the store's Markdown ends it", () => {
    const working = timeline([text("lead", demoCursorLiveLeadIn)]);
    const merge = new ChatLiveMerge();
    const rows: string[] = [];
    for (let words = demoCursorLiveWordsPerFrame; words <= demoCursorLiveWords + demoCursorLiveWordsPerFrame; words += demoCursorLiveWordsPerFrame) {
      const block = ChatLiveScreen.block(demoCursorLiveScreen(message, "reply", Math.min(words, demoCursorLiveWords), 4), "cursor");
      expect(block, `${words} words`).not.toBeNull();
      expect(block!.drawing).toBe("cursor");
      expect(block!.finished).toBe(false);
      merge.update(block, working, true);
      rows.push(merge.row(working)!);
    }
    expect(rows[0]).toBe("Two tests in");
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]!.length, "the row only grows").toBeGreaterThanOrEqual(rows[i - 1]!.length);
    expect(rows.at(-1)).toBe(
      [
        "Two tests in RateLimiterTests cover the window reset, and both pass on the fixed limiter after this morning's change to the check.",
        "",
        "Window reset",
        "",
        "1. testResetsAfterWindow checks a full window frees up at its end.",
        "2. testCountsFromFirstRequest checks the window starts at the first request.",
        "",
        "swift test --filter RateLimiterTests",
      ].join("\n"),
    );
    const landed = timeline([text("lead", demoCursorLiveLeadIn), text("reply", demoCursorLiveReply)], true);
    expect(merge.row(landed), "the landed reply replaces the row").toBeNull();
  });
});

describe("the demo Cursor pane's reply", () => {
  it("starts when the user's message reaches the pane (once), works, lands the lead-in with its Read, then the reply after demoCursorLiveLandsMs, then done", () => {
    let now = 1_000_000;
    const reply = new DemoCursorLiveReply(demoCursorLivePane, () => now);
    expect(reply.status()).toBeNull();
    expect(reply.landing("s", "/c")).toBeNull();
    reply.start(message);
    expect(reply.status()).toBe("working");
    expect(reply.statusSince()).toBe(1_000_000);
    expect(ChatLiveScreen.block(reply.screen(), "cursor"), "Thinking").toBeNull();
    expect(reply.landing("s", "/c")).toBeNull();
    now += demoCursorLiveThinkMs;
    expect(reply.screen()).toContain("    Reading Tests/HarborTests/RateLimiterTests.swift");
    expect(ChatLiveScreen.block(reply.screen(), "cursor")).toBeNull();
    now = 1_000_000 + demoCursorLiveReadMs;
    const read = reply.landing("s", "/c")!;
    expect(read.map((line) => JSON.parse(line).role)).toEqual(["assistant", "tool"]);
    expect(JSON.parse(read[0]!).content[0].text).toBe(demoCursorLiveLeadIn);
    expect(reply.landing("s", "/c"), "it lands once").toBeNull();
    expect(ChatLiveScreen.block(reply.screen(), "cursor")).toBeNull();
    now = 1_000_000 + demoCursorLiveReplyMs;
    expect(ChatLiveScreen.block(reply.screen(), "cursor")?.text).toBe("Two tests in");
    now += demoLiveFrameMs;
    expect(ChatLiveScreen.block(reply.screen(), "cursor")?.text).toBe("Two tests in RateLimiterTests cover the");
    reply.start("Another message");
    expect(reply.screen()).toContain(`  ${message}`);
    now = 1_000_000 + demoCursorLiveLandsMs - 1;
    expect(reply.status()).toBe("working");
    expect(reply.landing("s", "/c")).toBeNull();
    now += 1;
    expect(reply.status()).toBe("done");
    expect(reply.statusSince()).toBe(1_000_000 + demoCursorLiveLandsMs);
    const lines = reply.landing("s", "/c")!;
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ content: [{ text: demoCursorLiveReply, type: "text" }], role: "assistant" });
    expect(reply.landing("s", "/c"), "it lands once").toBeNull();
    expect(ChatLiveScreen.block(reply.screen(), "cursor")).toBeNull();
  });
});

describe("the Cursor live row on the demo, through the real reads", () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const end of cleanup.splice(0)) end();
  });

  it("the user's message to the idle Cursor pane: it works, the row grows at Chat's end, then the store's row in its place, one row, the lead-in once", async () => {
    let skew = 0;
    const clock: DemoClock = { schedule: (run) => { const timer = setTimeout(run, 0); return () => clearTimeout(timer); } };
    const registry = new HostRegistry(() => undefined);
    for (const host of demoHosts(fixtures, Date.now())) registry.add(host.descriptor, new DemoBackend(host, fixtures, clock, () => Date.now() + skew));
    await registry.refreshAll();
    const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
    const updates: ChatUpdateEvent[] = [];
    const page: ChatOwner = { id: 1, send: (_channel, payload) => updates.push(payload), isDestroyed: () => false };
    const shown = () => updates.filter((update) => update.paneId === demoCursorLivePane).at(-1) ?? null;
    const rows = new LiveRows({ forPane: () => shown(), accepts: () => true, followed: () => true });
    const events: ChatLiveEvent[] = [];
    const reads = new LiveReads(registry, () => service.shown(), (_chat, event) => (events.push(event), rows.receive(event)), { intervalMs: 20 });
    service.onShownChange(() => reads.sync());
    const refresh = setInterval(() => void registry.refreshAll().then(() => service.refresh()), 10);
    cleanup = [() => clearInterval(refresh), () => reads.closeAll(), () => service.closeAll(), () => registry.close()];
    service.open(page, demoHostIds.macMini, demoCursorLivePane, "", 1);
    reads.sync();
    expect(reads.following, "idle: not read").toEqual([]);
    expect(await eventually(() => shown()?.caughtUp === true)).toBe(true);
    const row = (): string | null => rows.row(demoHostIds.macMini, demoCursorLivePane, shown()!.timeline);
    const leadIns = (): number => agentTexts(shown()!.timeline).filter((each) => each === demoCursorLiveLeadIn).length;

    // Sent as the app's Send does (ipc.ts paneSend): Cursor takes a paste, then its Return (not agent.prompt).
    const binding = bindingOf(registry.topology(demoHostIds.macMini), demoCursorLivePane, true);
    expect(binding.kind).toBe("cursor");
    await sendBound(
      {
        writer: registry.backend(demoHostIds.macMini)!,
        fresh: () => registry.fresh(demoHostIds.macMini),
        pane: () => registry.pane(demoHostIds.macMini, demoCursorLivePane),
        agent: () => registry.agent(demoHostIds.macMini, demoCursorLivePane),
        run: () => registry.run(demoHostIds.macMini, demoCursorLivePane),
      },
      demoCursorLivePane,
      message,
      binding,
    );
    expect(await eventually(() => reads.following.length === 1)).toBe(true);
    expect(reads.following).toEqual([`${demoHostIds.macMini} ${demoCursorLivePane}`]);
    expect(row(), "Thinking: no row").toBeNull();
    skew += demoCursorLiveReadMs;
    expect(await eventually(() => leadIns() === 1), "the lead-in lands as its own message").toBe(true);
    expect(row(), "the tool row: no row").toBeNull();
    skew += demoCursorLiveReplyMs - demoCursorLiveReadMs + 2 * demoLiveFrameMs;
    expect(await eventually(() => row() !== null)).toBe(true);
    const first = row()!;
    expect(first.startsWith("Two tests in")).toBe(true);
    skew += 4 * demoLiveFrameMs;
    expect(await eventually(() => (row()?.length ?? 0) > first.length)).toBe(true);
    expect(row()!.startsWith(first)).toBe(true);
    expect(leadIns(), "the lead-in once").toBe(1);

    skew += demoCursorLiveLandsMs;
    expect(await eventually(() => agentTexts(shown()!.timeline).includes(demoCursorLiveReply))).toBe(true);
    expect(await eventually(() => reads.following.length === 0), "done: the reads stop").toBe(true);
    expect(row(), "the store's row in its place").toBeNull();
    expect(leadIns(), "the lead-in once").toBe(1);
    expect(agentTexts(shown()!.timeline).filter((each) => each === demoCursorLiveReply)).toHaveLength(1);
    expect(events.some((event) => event.type === "block" && event.block !== null)).toBe(true);
    expect(events.every((event) => event.type !== "block" || event.block === null || event.block.drawing === "cursor")).toBe(true);
  });
});

describe("the Cursor live row's captures (main.ts takes them after manageCaptureSteps' 61)", () => {
  it("66 streaming and 67 landed, on the Mac mini's Cursor pane, each measured", async () => {
    const { cursorLiveCaptureSteps, manageCaptureSteps } = await import("../src/main/capture");
    expect(manageCaptureSteps(demoHostIds).at(-1)!.name).toBe("61-workspace-rename");
    const steps = cursorLiveCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual(["66-cursor-live-streaming", "67-cursor-live-landed"]);
    expect(steps[0]!.commands).toContainEqual({ type: "select-pane", hostId: demoHostIds.macMini, paneId: demoCursorLivePane });
    expect(steps.every((step) => step.measure?.includes("data-chat-live") === true)).toBe(true);
    expect(steps.every((step) => step.measure?.includes("Two tests in RateLimiterTests cover the window reset") === true)).toBe(true);
  });
});
