// No bubble stays "Queued". A bubble
// settles when its text is contained in a later message of the user's (the interrupt
// line taken off; Claude's joined queue after an Esc, glued text from older
// builds, a message absorbed mid-turn); a bubble whose message came back to the
// box goes; the backstop turns a bubble that never shows "Not sent"
// 5 s after idle with no queue on Claude's screen, and a tap puts it back.

import { describe, expect, it } from "vitest";

import { notSentLabel, notSentWhileWorkingMs, pendingLabel, placePending, PendingBackstop, PendingMessages } from "../src/shared/chat/pending";
import { putBackInBox } from "../src/renderer/chat/esc-back";
import { json, session, shown, timelineOf } from "./support/chat-lines";
import { beforeGlued, claudeReply, claudeUser, escMs, escTimes, firstPending, gluedLines, gluedText, secondPending } from "./support/esc-queue-lines";

const key = "host/w1:p1";

describe("the glued fixture, as recorded", () => {
  it("leaves no bubble pending, shows the glued message once and not U1 (both sent before the transcript showed either)", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(beforeGlued.slice(0, 3)).timeline);
    store.delivered(store.add(key, firstPending, escMs(escTimes.u1) - 150));
    store.delivered(store.add(key, secondPending, escMs(escTimes.glued) - 150));
    const timeline = timelineOf(gluedLines).timeline;
    store.observe(key, timeline);
    expect(store.forPane(key)).toEqual([]);
    const users = shown(timeline).filter((row) => row.startsWith("user:"));
    expect(users).toEqual(["user:testing", `user:${gluedText}`]);
  });

  it("settles the first on U1 and the second inside the glued message, as the lines arrived", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(beforeGlued.slice(0, 3)).timeline);
    store.delivered(store.add(key, firstPending, escMs(escTimes.u1) - 150));
    store.observe(key, timelineOf(beforeGlued).timeline);
    expect(store.forPane(key)).toEqual([]);
    store.delivered(store.add(key, secondPending, escMs(escTimes.glued) - 150));
    store.observe(key, timelineOf(gluedLines).timeline);
    expect(store.forPane(key)).toEqual([]);
    // Never "Queued": nothing is left to label.
    expect(store.forPane(key).map((item) => pendingLabel(item, true, escMs(escTimes.glued)))).toEqual([]);
  });
});

/** A turn at work: the user's message and a tool call, then (`after`) what came. */
const working = [
  claudeUser("w1", "w0", "do the work", "2026-11-06T23:00:00.000Z", { promptSource: "typed" }),
  json({
    isSidechain: false,
    parentUuid: "w1",
    sessionId: session,
    timestamp: "2026-11-06T23:00:02.000Z",
    type: "assistant",
    uuid: "w-tool",
    message: { content: [{ id: "toolu_w", input: { command: "swift test" }, name: "Bash", type: "tool_use" }], id: "msg_w", role: "assistant", stop_reason: "tool_use", type: "message" },
  }),
];
const t0 = Date.parse("2026-11-06T23:00:00.000Z");

describe("the queued case", () => {
  it("two queued, then Esc: Claude runs them as one prompt after the interrupt line; both bubbles settle, none stays Queued", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(working).timeline);
    store.delivered(store.add(key, "queued one", t0 + 5_000));
    store.delivered(store.add(key, "queued two", t0 + 6_000));
    const joined = claudeUser("Q", "w-tool", [{ type: "text", text: "[Request interrupted by user]\nqueued one\nqueued two" }], "2026-11-06T23:00:09.000Z", { promptSource: "queued", origin: { kind: "human" }, turnOrigin: "human" });
    const timeline = timelineOf([...working, joined]).timeline;
    expect(shown(timeline)).toEqual(["user:do the work", "tool:swift test", "notice:Interrupted", "user:queued one\nqueued two"]);
    store.observe(key, timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("keeps two sends of the same words apart", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(working).timeline);
    store.add(key, "yes", t0 + 5_000);
    store.add(key, "yes", t0 + 6_000);
    store.observe(key, timelineOf([...working, claudeReply("a-y", "w-tool", "ok", "2026-11-06T23:00:07.000Z"), claudeUser("Y", "a-y", "yes", "2026-11-06T23:00:08.000Z")]).timeline);
    expect(store.forPane(key).length).toBe(1);
  });

  it("never settles on other words around its text: \"yes\" stays for \"yes please\"", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(working).timeline);
    store.delivered(store.add(key, "yes", t0 + 5_000));
    store.observe(key, timelineOf([...working, claudeReply("a-y", "w-tool", "ok", "2026-11-06T23:00:07.000Z"), claudeUser("Y", "a-y", "yes please", "2026-11-06T23:00:08.000Z")]).timeline);
    expect(store.forPane(key).map((item) => item.text)).toEqual(["yes"]);
  });

  it("alone, the second bubble does not cover the glued message unless the first went to the pane", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(beforeGlued.slice(0, 3)).timeline);
    store.delivered(store.add(key, secondPending, escMs(escTimes.glued) - 150));
    store.observe(key, timelineOf(gluedLines).timeline);
    expect(store.forPane(key).map((item) => item.text)).toEqual([secondPending]);
  });
});

describe("the backstop", () => {
  function clock() {
    const timers: { run: () => void; ms: number; live: boolean }[] = [];
    return {
      timers,
      schedule: (run: () => void, ms: number) => {
        const timer = { run, ms, live: true };
        timers.push(timer);
        return timer;
      },
      cancel: (timer: unknown) => void ((timer as { live: boolean }).live = false),
      fire: async () => {
        const timer = timers.find((candidate) => candidate.live);
        if (timer === undefined) return false;
        timer.live = false;
        timer.run();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return true;
      },
    };
  }

  it("turns a bubble whose text never appears Not sent 5 s after idle with no queue on screen; a tap puts it back in the box", async () => {
    const store = new PendingMessages();
    const time = clock();
    const backstop = new PendingBackstop(store, time.schedule, time.cancel, () => t0 + 60_000);
    const id = store.add(key, "this never shows", t0);
    store.delivered(id);
    let reads = 0;
    // Working: the 10 minutes after it went.
    backstop.watch(key, "working", async () => false);
    expect(time.timers.map((timer) => timer.ms)).toEqual([notSentWhileWorkingMs - 60_000]);
    backstop.watch(key, "idle", async () => {
      reads += 1;
      return false;
    });
    expect(time.timers.filter((timer) => timer.live).map((timer) => timer.ms)).toEqual([5_000]);
    expect(await time.fire()).toBe(true);
    expect(reads).toBe(1);
    const bubble = store.forPane(key)[0]!;
    expect(bubble.state).toBe("notSent");
    // Never "Queued" again, working or not.
    expect(pendingLabel(bubble, true, t0 + 10_000)).toBe(notSentLabel);
    expect(notSentLabel.startsWith("Not sent")).toBe(true);
    // One tap: its text back in the box (first, then the user's text), the bubble gone.
    const texts = new Map<string, string>([[key, "draft"]]);
    const text = store.takeNotSent(bubble.id)!;
    putBackInBox({ get: (k) => ({ text: texts.get(k) ?? "" }), edit: (k, t) => void texts.set(k, t) }, () => undefined, key, text);
    expect(texts.get(key)).toBe("this never shows\ndraft");
    expect(store.forPane(key)).toEqual([]);
  });

  it("waits while Claude's screen still shows queued messages; working again, the 10-minute timer takes over", async () => {
    const store = new PendingMessages();
    const time = clock();
    const backstop = new PendingBackstop(store, time.schedule, time.cancel, () => t0 + 1_000);
    store.delivered(store.add(key, "waiting", t0));
    backstop.watch(key, "done", async () => true);
    await time.fire();
    expect(store.forPane(key)[0]!.state).toBe("sent");
    expect(time.timers.filter((timer) => timer.live).map((timer) => timer.ms)).toEqual([5_000]);
    backstop.watch(key, "working", async () => true);
    expect(time.timers.filter((timer) => timer.live).map((timer) => timer.ms)).toEqual([notSentWhileWorkingMs - 1_000]);
    expect(store.forPane(key)[0]!.state).toBe("sent");
  });

  it("working 10 minutes, a waiting bubble turns Not sent (never \"Not seen in the transcript yet\")", async () => {
    const store = new PendingMessages();
    const time = clock();
    const backstop = new PendingBackstop(store, time.schedule, time.cancel, () => t0 + notSentWhileWorkingMs);
    store.delivered(store.add(key, "stuck", t0));
    backstop.watch(key, "working", async () => null);
    expect(await time.fire()).toBe(true);
    const bubble = store.forPane(key)[0]!;
    expect(bubble.state).toBe("notSent");
    expect(pendingLabel(bubble, true, t0 + notSentWhileWorkingMs)).toBe(notSentLabel);
  });

  it("a bubble turned Not sent still settles when the transcript shows it late", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(working).timeline);
    store.delivered(store.add(key, "late one", t0 + 5_000));
    store.markNotSent(key);
    store.observe(key, timelineOf([...working, claudeUser("L", "w-tool", "late one", "2026-11-06T23:00:30.000Z")]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });
});

describe("the stale bubble", () => {
  const later = [
    claudeUser("L1", "U3", "now look at the sidebar", "2026-11-06T23:16:00.000Z", { promptSource: "typed" }),
    claudeReply("a-L1", "L1", "Looking.", "2026-11-06T23:16:30.000Z"),
    claudeUser("L2", "a-L1", "and the footer", "2026-11-06T23:44:00.000Z", { promptSource: "typed" }),
    claudeReply("a-L2", "L2", "Done.", "2026-11-06T23:44:30.000Z"),
  ];

  it("A: the glued fixture, the agent idle, 11 minutes after the send: no bubble, no late label", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(beforeGlued.slice(0, 3)).timeline);
    store.delivered(store.add(key, firstPending, escMs(escTimes.u1) - 150));
    store.observe(key, timelineOf(beforeGlued).timeline);
    store.delivered(store.add(key, secondPending, escMs(escTimes.glued) - 150));
    store.observe(key, timelineOf(gluedLines).timeline);
    const elevenMinutesOn = escMs(escTimes.glued) + 11 * 60_000;
    expect(store.forPane(key).map((item) => pendingLabel(item, false, elevenMinutesOn))).toEqual([]);
  });

  it("B: newer messages and replies: no bubble at the bottom; one made not to match shows Not sent between the 22:35 message and the 23:16 one", () => {
    const timeline = timelineOf([...gluedLines, ...later]).timeline;
    const store = new PendingMessages();
    store.observe(key, timelineOf(beforeGlued.slice(0, 3)).timeline);
    store.delivered(store.add(key, firstPending, escMs(escTimes.u1) - 150));
    store.delivered(store.add(key, secondPending, escMs(escTimes.glued) - 150));
    store.observe(key, timeline);
    expect(store.forPane(key)).toEqual([]);

    const other = new PendingMessages();
    other.observe(key, timelineOf(beforeGlued.slice(0, 3)).timeline);
    other.delivered(other.add(key, "a text nothing matches", escMs(escTimes.glued) - 150));
    other.observe(key, timeline);
    other.markNotSent(key);
    const places = placePending(other.forPane(key), timeline);
    expect(places.waiting).toEqual([]);
    const openers = timeline.turns.map((turn) => (turn.items[0]?.type === "user" ? turn.items[0].value.text : "?"));
    expect(openers).toEqual(["testing", gluedText, "now look at the sidebar", "and the footer"]);
    // Before turn 1: after the 22:35 message's turn, before the newer ones, not at the end.
    expect([...places.placed.keys()]).toEqual([1]);
    expect(places.placed.get(1)!.map((item) => item.text)).toEqual(["a text nothing matches"]);
  });
});
