// The demo's streaming reply (src/main/demo/demo-live.ts) and
// its captures (53, 54). The Mac mini's working Claude pane shows no reply on
// its screen until the user's message reaches it; then the reply grows a few words a
// frame as Claude Code draws it, and lands in the transcript once written. The
// real reader (ChatLiveScreen), the real reads in main (LiveReads over the
// registry and ChatService) and the page's merge (LiveRows) make of it one
// growing row, then the transcript's own row in its place.

import { afterEach, describe, expect, it } from "vitest";

import { LiveReads } from "../src/main/chat/live-reads";
import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { DemoBackend, type DemoClock } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { DemoLiveReply, demoLiveFrameMs, demoLiveLandsMs, demoLivePane, demoLiveReply, demoLiveScreen, demoLiveWords } from "../src/main/demo/demo-live";
import { HostRegistry } from "../src/main/hosts";
import { ChatLiveMerge, ChatLiveScreen } from "../src/shared/chat/live-screen";
import type { ChatTimeline } from "../src/shared/chat/model";
import type { ChatLiveEvent, ChatUpdateEvent } from "../src/shared/ipc-contract";
import { LiveRows } from "../src/renderer/chat/live-rows";
import { eventually, whole } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";

const fixtures = bundledFixturesForTests();
const macMiniHost = () => demoHosts(fixtures, Date.now()).find((host) => host.descriptor.id === demoHostIds.macMini)!;

/** The pane's demo transcript as Chat reads it. */
async function transcriptOf(backend: DemoBackend): Promise<ChatTimeline> {
  const reader = backend.transcripts();
  const path = macMiniHost().transcripts.find((transcript) => transcript.paneID === demoLivePane)!.path;
  const size = await reader.size(path);
  return whole(new TextDecoder().decode(await reader.read(path, 0, size)));
}

const agentTexts = (timeline: ChatTimeline): string[] =>
  timeline.turns.at(-1)!.items.flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));

describe("the demo pane's screen", () => {
  it("before the user's message: a working Claude Code screen with no reply being written", () => {
    expect(ChatLiveScreen.block(demoLiveScreen(null, 0, 0))).toBeNull();
    expect(ChatLiveScreen.block(demoLiveScreen("Run the tests.", 0, 1))).toBeNull();
  });

  it("then the reply's words as they come, the reply whole at the end; the merge's row grows, and goes once the transcript has it", () => {
    const before = whole(macMiniHost().transcripts.find((transcript) => transcript.paneID === demoLivePane)!.lines.join("\n") + "\n");
    const merge = new ChatLiveMerge();
    const rows: string[] = [];
    for (let words = 4; words <= demoLiveWords + 4; words += 4) {
      const block = ChatLiveScreen.block(demoLiveScreen("Run the tests.", words, words / 4));
      expect(block, `${words} words`).not.toBeNull();
      expect(block!.finished).toBe(false);
      merge.update(block, before, true);
      rows.push(merge.row(before)!);
    }
    expect(rows[0]).toBe("The Return tests pass:");
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]!.length, "the row only grows").toBeGreaterThanOrEqual(rows[i - 1]!.length);
    expect(rows.at(-1)).toContain("- Return sends the message, Shift-Return adds a line");
    expect(rows.at(-1)).toContain("Next I'll run the whole Composer suite, then commit.");
    // Landed: the transcript's text ends the row.
    const landed: ChatTimeline = {
      ...before,
      turns: [
        ...before.turns.slice(0, -1),
        { ...before.turns.at(-1)!, items: [...before.turns.at(-1)!.items, { type: "agentText", value: { id: "landed", markdown: demoLiveReply, time: null } }] },
      ],
    };
    expect(merge.row(landed)).toBeNull();
  });
});

describe("the demo pane's reply", () => {
  it("starts when the user's message reaches the pane (once), grows a frame at a time, lands in the transcript after demoLiveLandsMs", () => {
    let now = 1_000_000;
    const reply = new DemoLiveReply(demoLivePane, () => now);
    expect(ChatLiveScreen.block(reply.screen())).toBeNull();
    expect(reply.landing("s", "/c")).toBeNull();
    reply.start("Run the tests.");
    now += demoLiveFrameMs;
    expect(ChatLiveScreen.block(reply.screen())?.text).toBe("The Return tests pass:");
    reply.start("Another message");
    expect(reply.screen()).toContain("\u{276F} Run the tests.");
    now += demoLiveLandsMs - demoLiveFrameMs - 1;
    expect(reply.landing("s", "/c")).toBeNull();
    now += 1;
    const lines = reply.landing("s", "/c")!;
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).message.content[0].text).toBe(demoLiveReply);
    expect(reply.landing("s", "/c"), "it lands once").toBeNull();
  });

  it("on the demo machine: pane.read shows it, the transcript gets it; other panes' screens are as they were", async () => {
    let skew = 0;
    const clock: DemoClock = { schedule: (run) => { const timer = setTimeout(run, 0); return () => clearTimeout(timer); } };
    const backend = new DemoBackend(macMiniHost(), fixtures, clock, () => Date.now() + skew);
    const io = backend.promptIO();
    expect(ChatLiveScreen.block(await io.paneRead(demoLivePane, 80))).toBeNull();
    expect(await io.paneRead("w7:p1", 80)).toBe("");
    await backend.prompt(demoLivePane, "Run the Return tests once more and tell me where they stand.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    skew += 3 * demoLiveFrameMs;
    expect(ChatLiveScreen.block(await io.paneRead(demoLivePane, 80))?.text).toMatch(/^The Return tests pass: 14 of 14, the iPad layout's included\.\s+With$/);
    expect(agentTexts(await transcriptOf(backend))).not.toContain(demoLiveReply);
    skew += demoLiveLandsMs;
    expect(agentTexts(await transcriptOf(backend))).toContain(demoLiveReply);
    backend.close();
  });
});

describe("the live row on the demo, through the real reads", () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const end of cleanup.splice(0)) end();
  });

  it("the user's message to the working pane: the row grows at Chat's end, then the transcript's row in its place, one row", async () => {
    let skew = 0;
    const clock: DemoClock = { schedule: (run) => { const timer = setTimeout(run, 0); return () => clearTimeout(timer); } };
    const registry = new HostRegistry(() => undefined);
    for (const host of demoHosts(fixtures, Date.now())) registry.add(host.descriptor, new DemoBackend(host, fixtures, clock, () => Date.now() + skew));
    await registry.refreshAll();
    const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
    const updates: ChatUpdateEvent[] = [];
    const page: ChatOwner = { id: 1, send: (_channel, payload) => updates.push(payload), isDestroyed: () => false };
    const shown = () => updates.filter((update) => update.paneId === demoLivePane).at(-1) ?? null;
    const rows = new LiveRows({ forPane: () => shown(), accepts: () => true, followed: () => true });
    const events: ChatLiveEvent[] = [];
    const reads = new LiveReads(registry, () => service.shown(), (_chat, event) => (events.push(event), rows.receive(event)), { intervalMs: 20 });
    service.onShownChange(() => reads.sync());
    cleanup = [() => reads.closeAll(), () => service.closeAll(), () => registry.close()];
    service.open(page, demoHostIds.macMini, demoLivePane, "", 1);
    reads.sync();
    expect(reads.following).toEqual([`${demoHostIds.macMini} ${demoLivePane}`]);
    expect(await eventually(() => shown()?.caughtUp === true)).toBe(true);
    const row = (): string | null => rows.row(demoHostIds.macMini, demoLivePane, shown()!.timeline);
    expect(await eventually(() => events.length >= 2)).toBe(true);
    expect(row(), "no reply on screen yet").toBeNull();

    await registry.backend(demoHostIds.macMini)!.prompt(demoLivePane, "Run the Return tests once more and tell me where they stand.");
    skew += 2 * demoLiveFrameMs;
    expect(await eventually(() => row() !== null)).toBe(true);
    const first = row()!;
    skew += 4 * demoLiveFrameMs;
    expect(await eventually(() => (row()?.length ?? 0) > first.length)).toBe(true);
    expect(row()!.startsWith(first)).toBe(true);

    skew += demoLiveLandsMs;
    expect(await eventually(() => agentTexts(shown()!.timeline).includes(demoLiveReply))).toBe(true);
    expect(row(), "the transcript's row in its place").toBeNull();
    expect(events.every((event) => event.type === "block" && event.follow === 1)).toBe(true);
  });
});

describe("the live row's captures (main.ts takes them after needsCardCaptureSteps' 50)", () => {
  it("53 streaming and 54 landed, each measured; 51 and 52 belong to other captures", async () => {
    const { liveRowCaptureSteps, needsCardCaptureSteps } = await import("../src/main/capture");
    expect(needsCardCaptureSteps(demoHostIds).at(-1)!.name).toBe("50-needs-card-gone-sidebar");
    const steps = liveRowCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual(["53-live-row-streaming", "54-live-row-landed"]);
    expect(steps[0]!.commands).toContainEqual({ type: "select-pane", hostId: demoHostIds.macMini, paneId: demoLivePane });
    expect(steps.every((step) => step.measure?.includes("data-chat-live") === true)).toBe(true);
  });
});
