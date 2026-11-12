// The user's sent message as a pending bubble until the transcript has it
// (src/shared/chat/pending.ts), then the real one stays, never twice.

import { describe, expect, it } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { matchText, notSentWhileWorkingMs, pendingLabel, PendingMessages, pendingScopes, userMessages } from "../src/shared/chat/pending";
import { at, queued, reply, result, shown, stamp, timelineOf, tool, upload, user } from "./support/chat-lines";
import { tonight, tonightText } from "./support/pasted-tonight";

const key = "host/w1:p1";
/** Milliseconds for `stamp(second)` (the transcript's clock). */
const ms = (second: number): number => at(second) * 1_000;

const base = [user("Run the scroll tests", "u1", 0), tool("toolu_1", "swift test", "a1", 2)];
const scope = { terminalID: "t1", session: "s-1" };

describe("pending bubbles", () => {
  it("shows a sent message at once and drops it when the transcript has it, once", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    const id = store.add(key, "also check the iPad layout", ms(10));
    expect(store.forPane(key).map((item) => item.text)).toEqual(["also check the iPad layout"]);
    expect(pendingLabel(store.forPane(key)[0]!, true, ms(11))).toBe("Queued");
    store.delivered(id);
    expect(pendingLabel(store.forPane(key)[0]!, false, ms(11))).toBe("Sent");
    store.observe(key, timelineOf([...base, queued("also check the iPad layout", "q1", "s1", 12)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("says Sending… until Herdr takes it, Queued while the agent works", () => {
    const store = new PendingMessages();
    store.add(key, "go on", ms(0));
    const item = store.forPane(key)[0]!;
    // A normal message at once (no label); "Sending…" once still unconfirmed after 1.5 s.
    expect(pendingLabel(item, false, ms(1))).toBe("");
    expect(pendingLabel(item, false, ms(2))).toBe("Sending…");
    expect(pendingLabel(item, true, ms(1))).toBe("Queued");
    // No late label of its own; after 10 minutes the backstop turns it "Not sent".
    expect(pendingLabel(item, true, ms(0) + notSentWhileWorkingMs)).toBe("Queued");
  });

  it("never takes a message the chat already showed, nor one long before the send", () => {
    const store = new PendingMessages();
    const shown = timelineOf([user("go on", "u1", 0), reply("Going on.", "a1", 1, true)]).timeline;
    store.observe(key, shown);
    store.add(key, "go on", ms(600));
    store.observe(key, shown);
    expect(store.forPane(key).length).toBe(1);
    // Load earlier brings an older "go on": too old to be this send.
    store.observe(key, timelineOf([user("go on", "u0", 0), user("go on", "u1", 1), reply("Going on.", "a1", 2, true)]).timeline);
    expect(store.forPane(key).length).toBe(1);
    store.observe(key, timelineOf([user("go on", "u1", 0), reply("Going on.", "a1", 1, true), user("go on", "u2", 601)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("keeps two sends of the same words as two bubbles, each matched to its own message", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    store.add(key, "yes", ms(5));
    store.add(key, "yes", ms(6));
    expect(store.forPane(key).length).toBe(2);
    store.observe(key, timelineOf([...base, queued("yes", "q1", "s1", 7)]).timeline);
    expect(store.forPane(key).length).toBe(1);
    store.observe(key, timelineOf([...base, queued("yes", "q1", "s1", 7)]).timeline);
    expect(store.forPane(key).length).toBe(1);
    store.observe(key, timelineOf([...base, queued("yes", "q1", "s1", 7), queued("yes", "q2", "s2", 8)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("matches the text the transcript shows: pasted tags, uploads and line endings", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    store.add(key, `fix the header\r\nplease ${upload}`, ms(5));
    store.observe(key, timelineOf([...base, user(`<pasted_content id="a">fix the header\nplease</pasted_content> ${upload}`, "u2", 6)]).timeline);
    expect(store.forPane(key)).toEqual([]);
    expect(matchText(`a  b\r\n c ${upload}`)).toBe("a b c");
  });

  // The attachments count too.
  it("does not take a message with fewer images for two pending: two images pending, the transcript shows one", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    store.add(key, "the two screens [Image #1] [Image #2]", ms(5));
    const one = user("the two screens [Image #1]", "u2", 6);
    store.observe(key, timelineOf([...base, one]).timeline);
    expect(store.forPane(key).map((item) => item.text)).toEqual(["the two screens [Image #1] [Image #2]"]);
    store.observe(key, timelineOf([...base, one, user("the two screens [Image #1] [Image #2]", "u3", 7)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("matches known paths with their counts, and an image with no path only for the same count", () => {
    const other = upload.replace("attachment-3333", "attachment-4444");
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    store.add(key, `this one ${upload}`, ms(5));
    // Another file, the same file twice, or no file: not the user's message.
    const wrong = [user(`this one ${other}`, "u2", 6), user(`this one ${upload} ${upload}`, "u3", 7), user("this one", "u4", 8)];
    store.observe(key, timelineOf([...base, ...wrong]).timeline);
    expect(store.forPane(key)).toHaveLength(1);
    // The same count, the image inline (its path not written): the user's.
    const inline = queued(
      [
        { type: "text", text: "this one" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      ],
      "q1",
      "src-1",
      9,
    );
    store.observe(key, timelineOf([...base, ...wrong, inline]).timeline);
    expect(store.forPane(key)).toEqual([]);

    // Nothing attached never takes a message with an image.
    store.add(key, "plain words", ms(20));
    store.observe(key, timelineOf([...base, ...wrong, inline, user("plain words [Image #1]", "u5", 21)]).timeline);
    expect(store.forPane(key)).toHaveLength(1);
    store.observe(key, timelineOf([...base, ...wrong, inline, user("plain words [Image #1]", "u5", 21), user("plain words", "u6", 22)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("drops a failed send and keeps other panes' bubbles apart", () => {
    const store = new PendingMessages();
    const id = store.add(key, "one", ms(0));
    store.add("host/w2:p1", "two", ms(0));
    store.failed(id);
    expect(store.forPane(key)).toEqual([]);
    expect(store.forPane("host/w2:p1").map((item) => item.text)).toEqual(["two"]);
    store.observe(key, timelineOf([user("two", "u9", 1)]).timeline);
    expect(store.forPane("host/w2:p1").length).toBe(1);
  });

  it("survives pane switching and drops the bubbles of a pane that is gone", () => {
    const store = new PendingMessages();
    store.add(key, "one", ms(0));
    store.add("host/w2:p1", "two", ms(0));
    const covers = () => true;
    store.reconcile(new Map([[key, scope], ["host/w2:p1", scope]]), covers);
    expect(store.keys().sort()).toEqual([key, "host/w2:p1"].sort());
    store.reconcile(new Map([[key, scope]]), covers);
    expect(store.keys()).toEqual([key]);
  });

  it("gives the same array until something changes (for useSyncExternalStore)", () => {
    const store = new PendingMessages();
    store.add(key, "one", ms(0));
    expect(store.forPane(key)).toBe(store.forPane(key));
    let calls = 0;
    store.subscribe(() => (calls += 1));
    store.observe(key, timelineOf([user("other", "u1", 1)]).timeline);
    expect(calls).toBe(0);
    store.observe(key, timelineOf([user("one", "u2", 1)]).timeline);
    expect(calls).toBe(1);
  });

  it("lists the user's messages in order", () => {
    expect(userMessages(timelineOf([user("a", "u1", 0), reply("b", "a1", 1, true), user("c", "u2", 2)]).timeline).map((m) => m.text)).toEqual(["a", "c"]);
    expect(stamp(0)).toBe("2026-11-02T05:00:00.000Z");
  });

  // A baseline at send time. A send made while Chat
  // does not hold the pane's live transcript counts only messages after the
  // first live timeline delivered after it, never the initial history.
  it("never takes an identical message from the initial history of a chat opened after the send", () => {
    const store = new PendingMessages();
    store.add(key, "yes", ms(100));
    store.observe(key, timelineOf([user("yes", "old", 95)]).timeline);
    expect(store.forPane(key)).toHaveLength(1);
    store.observe(key, timelineOf([user("yes", "old", 95), user("yes", "new", 101)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("takes no baseline from a loading chat, nor from a chat that stopped following the pane", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    store.unfollow(key);
    store.add(key, "go", ms(100));
    // A loading update (empty) is not the first live timeline.
    store.observe(key, timelineOf([]).timeline, false);
    store.observe(key, timelineOf([...base, user("go", "u-old", 99)]).timeline);
    expect(store.forPane(key)).toHaveLength(1);
    store.observe(key, timelineOf([...base, user("go", "u-old", 99), user("go", "u-new", 101)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("takes no message placed before the send's baseline, even with no time on it", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    store.add(key, "go", ms(100));
    // Load earlier puts an older "go" above what was shown: not this send.
    store.observe(key, timelineOf([user("go", "u-earlier", 0, { timestamp: null }), ...base]).timeline);
    expect(store.forPane(key)).toHaveLength(1);
    store.observe(key, timelineOf([...base, user("go", "u-new", 101)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  // Both sides normalised by the same visible-text rules.
  it("matches a literal pasted_content message to its unwrapped transcript copy", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    const text = '<pasted_content id="a">hello</pasted_content>';
    store.add(key, text, ms(100));
    const timeline = timelineOf([...base, user(text, "new", 101)]).timeline;
    expect(timeline.turns.at(-1)!.items[0]).toMatchObject({ type: "user", value: { text: "hello" } });
    store.observe(key, timeline);
    expect(store.forPane(key)).toEqual([]);
    expect(matchText(text)).toBe("hello");
  });

  // The transcript closes the paste with its id
  // (Claude Code 2.1.316): the bubble clears once, also with an image.
  it("clears a send whose transcript line closes the paste with its id", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    store.add(key, tonightText, ms(10));
    const timeline = timelineOf([...base, queued(tonight, "q1", "s1", 11)]).timeline;
    expect(userMessages(timeline).filter((message) => message.text === tonightText)).toHaveLength(1);
    store.observe(key, timeline);
    expect(store.forPane(key)).toEqual([]);
    const idle = [user("Fix the header", "u1", 0), reply("Done.", "a1", 3, true)];
    store.observe(key, timelineOf(idle).timeline);
    store.add(key, tonightText, ms(20));
    store.observe(key, timelineOf([...idle, user(tonight, "u2", 21)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("clears an id-closed paste with an image, one image for one", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    store.add(key, `${tonightText} ${upload}`, ms(10));
    store.add(key, `${tonightText} ${upload} ${upload}`, ms(10));
    const wrapped = `<pasted_content id="713e">\n${tonightText} ${upload}\n</pasted_content id="713e">`;
    store.observe(key, timelineOf([...base, queued(wrapped, "q1", "s1", 11)]).timeline);
    expect(store.forPane(key).map((item) => item.text)).toEqual([`${tonightText} ${upload} ${upload}`]);
  });

  // The user line can start with blank lines before the paste.
  it("drops the blank lines before the paste and clears the Sent bubble", () => {
    const store = new PendingMessages();
    const idle = [user("Fix the header", "u1", 0), reply("Done.", "a1", 3, true)];
    store.observe(key, timelineOf(idle).timeline);
    store.add(key, tonightText, ms(10));
    const timeline = timelineOf([...idle, user(`\n\n${tonight}`, "u2", 11)]).timeline;
    expect(shown(timeline)).toEqual(["user:Fix the header", "agent:Done.", `user:${tonightText}`]);
    store.observe(key, timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("shows a message taken in mid-turn and its own user line once, in one turn", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    store.add(key, tonightText, ms(30));
    const timeline = timelineOf([
      ...base,
      queued(tonight, "q1", null, 90),
      result("toolu_1", "passed", "r1", 90),
      user(`\n\n${tonight}`, "u2", 200),
      reply("Answered.", "a2", 200, true),
    ]).timeline;
    expect(shown(timeline)).toEqual(["user:Run the scroll tests", "tool:swift test", `user:${tonightText}`, "agent:Answered."]);
    expect(timeline.turns).toHaveLength(1);
    store.observe(key, timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  // Bubbles belong to the pane's terminal and agent session.
  it("drops the bubbles of an old session with a quiet line, keeps them when the session is first learned", () => {
    const store = new PendingMessages();
    const covers = (candidate: string) => candidate.startsWith("host/");
    store.add(key, "one", ms(0), { terminalID: "t1", session: null });
    store.add(key, "two", ms(0), { terminalID: "t1", session: null });
    store.reconcile(new Map([[key, { terminalID: "t1", session: "s-1" }]]), covers);
    expect(store.forPane(key)).toHaveLength(2);
    expect(store.droppedFor(key)).toBe(0);
    store.reconcile(new Map([[key, { terminalID: "t1", session: "s-2" }]]), covers);
    expect(store.forPane(key)).toEqual([]);
    expect(store.droppedFor(key)).toBe(2);
    store.add(key, "three", ms(1), { terminalID: "t1", session: "s-2" });
    expect(store.droppedFor(key)).toBe(0);
    store.reconcile(new Map([[key, { terminalID: "t9", session: "s-2" }]]), covers);
    expect(store.forPane(key)).toEqual([]);
    expect(store.droppedFor(key)).toBe(1);
  });

  it("keeps the bubbles of a machine whose snapshot is not known, and forgets a pane that is gone", () => {
    const store = new PendingMessages();
    store.add("other/w1:p1", "kept", ms(0), scope);
    store.add(key, "gone", ms(0), scope);
    store.reconcile(new Map(), (candidate) => candidate.startsWith("host/"));
    expect(store.keys()).toEqual(["other/w1:p1"]);
    expect(store.droppedFor(key)).toBe(0);
  });

  it("reads each agent pane's terminal and session from the machines' snapshots", () => {
    const topology = decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [],
      tabs: [],
      panes: [
        { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "idle", revision: 1 },
        { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "unknown", revision: 1 },
      ],
      layouts: [],
      agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" } }],
    });
    const { scopes, covers } = pendingScopes([
      { id: "host", topology },
      { id: "far", topology: null },
    ]);
    expect([...scopes]).toEqual([["host/w1:p1", { terminalID: "t1", session: "s-1" }]]);
    expect(covers("host/w1:p2")).toBe(true);
    expect(covers("far/w1:p1")).toBe(false);
  });

  it("still keeps two identical sends as two bubbles under a baseline", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(base).timeline);
    store.add(key, "yes", ms(5), scope);
    store.add(key, "yes", ms(6), scope);
    store.observe(key, timelineOf([...base, user("yes", "y1", 7)]).timeline);
    expect(store.forPane(key)).toHaveLength(1);
    store.observe(key, timelineOf([...base, user("yes", "y1", 7), user("yes", "y2", 8)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  // What Chat showed of one session is no baseline for a send
  // to the next. The followed timeline goes when the pane's update leaves the
  // live state, and when a snapshot shows another terminal or session (also
  // with no bubble yet); a send in that gap takes the next live timeline.
  describe("the followed baseline across a session change", () => {
    const s1 = { terminalID: "t1", session: "s1" };
    const s2 = { terminalID: "t1", session: "s2" };

    it("takes no baseline from the previous session while the replacement loads", () => {
      const store = new PendingMessages();
      store.observe(key, timelineOf([user("old session", "old-anchor", 0)]).timeline);
      store.reconcile(new Map([[key, s2]]), () => true);
      store.observe(key, timelineOf([]).timeline, false);
      store.add(key, "yes", ms(100), s2);
      store.observe(key, timelineOf([user("yes", "initial-history-s2", 95)]).timeline);
      expect(store.forPane(key)).toHaveLength(1);
      store.observe(key, timelineOf([user("yes", "initial-history-s2", 95), user("yes", "sent", 101)]).timeline);
      expect(store.forPane(key)).toEqual([]);
    });

    it("drops it when a snapshot shows a new session, with no bubble and no loading update between", () => {
      const store = new PendingMessages();
      store.reconcile(new Map([[key, s1]]), () => true);
      store.observe(key, timelineOf([user("old session", "old-anchor", 0)]).timeline);
      store.reconcile(new Map([[key, s2]]), () => true);
      store.add(key, "yes", ms(100), s2);
      store.observe(key, timelineOf([user("yes", "initial-history-s2", 95)]).timeline);
      expect(store.forPane(key)).toHaveLength(1);
    });

    it("drops it for a new terminal, and for a known session the snapshot no longer names", () => {
      for (const next of [
        { terminalID: "t2", session: "s1" },
        { terminalID: "t1", session: null },
      ]) {
        const store = new PendingMessages();
        store.reconcile(new Map([[key, s1]]), () => true);
        store.observe(key, timelineOf([user("old session", "old-anchor", 0)]).timeline);
        store.reconcile(new Map([[key, next]]), () => true);
        store.add(key, "yes", ms(100), next);
        store.observe(key, timelineOf([user("yes", "initial-history", 95)]).timeline);
        expect(store.forPane(key), JSON.stringify(next)).toHaveLength(1);
      }
    });

    it("keeps it when the session is first learned, the same session, or another pane loads", () => {
      const store = new PendingMessages();
      store.reconcile(new Map([[key, { terminalID: "t1", session: null }]]), () => true);
      store.observe(key, timelineOf(base).timeline);
      store.reconcile(new Map([[key, s1]]), () => true);
      store.reconcile(new Map([[key, s1]]), () => true);
      store.observe("host/w2:p1", timelineOf([]).timeline, false);
      store.add(key, "yes", ms(100), s1);
      // The baseline is what Chat showed at the send, so the next live timeline's new message is the match.
      store.observe(key, timelineOf([...base, user("yes", "sent", 101)]).timeline);
      expect(store.forPane(key)).toEqual([]);
    });
  });
});
