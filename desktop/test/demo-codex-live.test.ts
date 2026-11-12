// The demo's streaming Codex reply (src/main/demo/demo-live.ts)
// and its captures (55, 56). The Mac mini's Codex pane is idle until the user's
// message reaches it; then it works (Working alone a moment), its reply grows a
// few words a frame above the box as Codex draws it (the link as "label
// (target)", two-space wraps), lands in the rollout once written, and the
// screen shows "Worked for" with the pane done. The real reader
// (ChatLiveScreen), the real reads in main (LiveReads over the registry and
// ChatService) and the page's merge (LiveRows) make of it one growing row,
// then the rollout's own row in its place.

import { afterEach, describe, expect, it } from "vitest";

import { LiveReads } from "../src/main/chat/live-reads";
import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { DemoBackend, type DemoClock } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import {
  DemoCodexLiveReply,
  demoCodexLivePane,
  demoCodexLiveLandsMs,
  demoCodexLiveReply,
  demoCodexLiveScreen,
  demoCodexLiveThinkMs,
  demoCodexLiveWords,
  demoCodexLiveWordsPerFrame,
  demoLiveFrameMs,
} from "../src/main/demo/demo-live";
import { HostRegistry } from "../src/main/hosts";
import { ChatLiveMerge, ChatLiveScreen } from "../src/shared/chat/live-screen";
import type { ChatTimeline } from "../src/shared/chat/model";
import type { ChatLiveEvent, ChatUpdateEvent } from "../src/shared/ipc-contract";
import { LiveRows } from "../src/renderer/chat/live-rows";
import { eventually } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";

const fixtures = bundledFixturesForTests();
const message = "Do this week's notes mention Qwen or DeepSeek?";

const agentTexts = (timeline: ChatTimeline): string[] =>
  timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : [])));

/** A timeline whose last turn holds `markdown` as its agent text. */
const landedIn = (markdown: string): ChatTimeline =>
  ({
    turns: [{ id: "t", userText: null, items: [{ type: "agentText", value: { id: "landed", markdown, time: null } }] }],
  }) as unknown as ChatTimeline;

const empty = { turns: [] } as unknown as ChatTimeline;

describe("the demo Codex pane's screen", () => {
  it("before the user's message, and while only Working (and its Tip) shows: no reply", () => {
    expect(ChatLiveScreen.block(demoCodexLiveScreen(null, 0, 0))).toBeNull();
    expect(ChatLiveScreen.block(demoCodexLiveScreen(message, 0, 1))).toBeNull();
  });

  it("then the reply's words as Codex draws them, a row that only grows; once whole, the rollout's Markdown ends it", () => {
    const merge = new ChatLiveMerge();
    const rows: string[] = [];
    for (let words = demoCodexLiveWordsPerFrame; words <= demoCodexLiveWords + demoCodexLiveWordsPerFrame; words += demoCodexLiveWordsPerFrame) {
      const block = ChatLiveScreen.block(demoCodexLiveScreen(message, Math.min(words, demoCodexLiveWords), 2));
      expect(block, `${words} words`).not.toBeNull();
      expect(block!.drawing).toBe("codex");
      expect(block!.finished).toBe(false);
      merge.update(block, empty, true);
      rows.push(merge.row(empty)!);
    }
    expect(rows[0]).toBe("This week's");
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]!.length, "the row only grows").toBeGreaterThanOrEqual(rows[i - 1]!.length);
    expect(rows.at(-1)).toBe(
      "This week's notes mention both: 2026-10-29 (notes/2026-10-29.md) prices Qwen 3.5 per million tokens, and 2026-10-31 (notes/2026-10-31.md) has the DeepSeek V4 eval with its numbers under Results. Neither note records a decision yet.",
    );
    expect(merge.row(landedIn(demoCodexLiveReply)), "the landed reply replaces the row").toBeNull();
  });

  it("landed: Worked for under the user's message, no reply block", () => {
    const screen = demoCodexLiveScreen(message, 0, 9, true);
    expect(screen).toContain("  Worked for 9s");
    expect(ChatLiveScreen.block(screen)).toBeNull();
  });
});

describe("the demo Codex pane's reply", () => {
  it("starts when the user's message reaches the pane (once), works, grows, lands in the rollout after demoCodexLiveLandsMs, then done", () => {
    let now = 1_000_000;
    const reply = new DemoCodexLiveReply(demoCodexLivePane, () => now);
    expect(reply.status()).toBeNull();
    expect(reply.landing("s", "/c")).toBeNull();
    reply.start(message);
    expect(reply.status()).toBe("working");
    expect(reply.statusSince()).toBe(1_000_000);
    expect(ChatLiveScreen.block(reply.screen()), "Working alone").toBeNull();
    now += demoCodexLiveThinkMs + demoLiveFrameMs;
    expect(ChatLiveScreen.block(reply.screen())?.text).toBe("This week's");
    now += demoLiveFrameMs;
    expect(ChatLiveScreen.block(reply.screen())?.text).toBe("This week's notes mention");
    reply.start("Another message");
    expect(reply.screen()).toContain(`\u{203A} ${message}`);
    now = 1_000_000 + demoCodexLiveLandsMs - 1;
    expect(reply.status()).toBe("working");
    expect(reply.landing("s", "/c")).toBeNull();
    now += 1;
    expect(reply.status()).toBe("done");
    expect(reply.statusSince()).toBe(1_000_000 + demoCodexLiveLandsMs);
    const lines = reply.landing("s", "/c")!;
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["response_item", "event_msg"]);
    expect(JSON.parse(lines[0]!).payload.content[0].text).toBe(demoCodexLiveReply);
    expect(JSON.parse(lines[1]!).payload.type).toBe("task_complete");
    expect(reply.landing("s", "/c"), "it lands once").toBeNull();
    expect(ChatLiveScreen.block(reply.screen())).toBeNull();
  });
});

describe("the Codex live row on the demo, through the real reads", () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const end of cleanup.splice(0)) end();
  });

  it("the user's message to the idle Codex pane: it works, the row grows at Chat's end, then the rollout's row in its place, one row", async () => {
    let skew = 0;
    const clock: DemoClock = { schedule: (run) => { const timer = setTimeout(run, 0); return () => clearTimeout(timer); } };
    const registry = new HostRegistry(() => undefined);
    for (const host of demoHosts(fixtures, Date.now())) registry.add(host.descriptor, new DemoBackend(host, fixtures, clock, () => Date.now() + skew));
    await registry.refreshAll();
    const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
    const updates: ChatUpdateEvent[] = [];
    const page: ChatOwner = { id: 1, send: (_channel, payload) => updates.push(payload), isDestroyed: () => false };
    const shown = () => updates.filter((update) => update.paneId === demoCodexLivePane).at(-1) ?? null;
    const rows = new LiveRows({ forPane: () => shown(), accepts: () => true, followed: () => true });
    const events: ChatLiveEvent[] = [];
    const reads = new LiveReads(registry, () => service.shown(), (_chat, event) => (events.push(event), rows.receive(event)), { intervalMs: 20 });
    service.onShownChange(() => reads.sync());
    // As main does: each new snapshot looks at the Chats again (ChatService.refresh), and the reads with them.
    const refresh = setInterval(() => void registry.refreshAll().then(() => service.refresh()), 10);
    cleanup = [() => clearInterval(refresh), () => reads.closeAll(), () => service.closeAll(), () => registry.close()];
    service.open(page, demoHostIds.macMini, demoCodexLivePane, "", 1);
    reads.sync();
    expect(reads.following, "idle: not read").toEqual([]);
    expect(await eventually(() => shown()?.caughtUp === true)).toBe(true);
    const row = (): string | null => rows.row(demoHostIds.macMini, demoCodexLivePane, shown()!.timeline);

    await registry.backend(demoHostIds.macMini)!.prompt(demoCodexLivePane, message);
    expect(await eventually(() => reads.following.length === 1)).toBe(true);
    expect(reads.following).toEqual([`${demoHostIds.macMini} ${demoCodexLivePane}`]);
    expect(row(), "Working alone: no row").toBeNull();
    skew += demoCodexLiveThinkMs + 2 * demoLiveFrameMs;
    expect(await eventually(() => row() !== null)).toBe(true);
    const first = row()!;
    skew += 4 * demoLiveFrameMs;
    expect(await eventually(() => (row()?.length ?? 0) > first.length)).toBe(true);
    expect(row()!.startsWith(first)).toBe(true);

    skew += demoCodexLiveLandsMs;
    expect(await eventually(() => agentTexts(shown()!.timeline).includes(demoCodexLiveReply))).toBe(true);
    expect(await eventually(() => reads.following.length === 0), "done: the reads stop").toBe(true);
    expect(row(), "the rollout's row in its place").toBeNull();
    expect(events.some((event) => event.type === "block")).toBe(true);
    expect(events.every((event) => event.type !== "block" || (event.block === null || event.block.drawing === "codex"))).toBe(true);
  });
});

describe("the Codex live row's captures (main.ts takes them after liveRowCaptureSteps' 54)", () => {
  it("55 streaming and 56 landed, on the Mac mini's Codex pane, each measured", async () => {
    const { codexLiveCaptureSteps, liveRowCaptureSteps } = await import("../src/main/capture");
    expect(liveRowCaptureSteps(demoHostIds).at(-1)!.name).toBe("54-live-row-landed");
    const steps = codexLiveCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual(["55-codex-live-streaming", "56-codex-live-landed"]);
    expect(steps[0]!.commands).toContainEqual({ type: "select-pane", hostId: demoHostIds.macMini, paneId: demoCodexLivePane });
    expect(steps.every((step) => step.measure?.includes("data-chat-live") === true)).toBe(true);
  });
});
