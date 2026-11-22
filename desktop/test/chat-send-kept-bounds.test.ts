// A second review's cases, with the reviewer's failing probes taken in:
//
// 1. A named session is never proved by the screen: with a session named and no record reader (none made, or none
//    for that session) the check ends unknown, never taken. A pane with no session named keeps the screen's proof.
// 2. The kept list fits its file: copies count against drafts.json's whole-file bound and their own 640 KiB; room is
//    taken before the Return; the oldest copies move to Kept drafts while Kept has room; past that the Send is
//    refused before any key. No draft is dropped for a copy, and the store never writes a file its reader refuses.
// 3. A restored bubble is settled only by its own message: the copy carries its session and where that session's
//    transcript stood (its baseline's last item). An identical message before that, one with no time, or one in
//    another session never settles it nor releases its copy. A copy with no such item (80735fbe's format) loads as
//    it was and stays "could not confirm".
// 4. A receipt that comes after the transcript settled its bubble releases its copy and ends its check at once.
// 5. A new session turns every unproved kept bubble, still in the box included, "could not confirm".
//
// Through the real DraftStore (memory files), PendingMessages and the page's sendWithPending; main's send path
// (sendBound) with a fake pane. Fakes only: no socket, no transcript of this machine.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DraftStore, MemoryDraftFiles } from "../src/main/drafts";
import { SendChecks, sendBound, sendWithReceipt, type SendSite } from "../src/main/herdr/send";
import { attachSendKeeping, pendingMessages, sendWithPending } from "../src/renderer/chat/chat-state";
import { PendingMessages } from "../src/shared/chat/pending";
import type { QueueRecord } from "../src/shared/claude-queue-record";
import { keptByteLimit, maxDraftsBytes, unprovedByteLimit, type UnprovedSend } from "../src/shared/drafts";
import { claudeScreen } from "./support/claude-screens";
import { timelineOf } from "./support/chat-lines";
import { claudeReply, claudeUser } from "./support/esc-queue-lines";

const at = Date.parse("2026-11-20T06:00:00.000Z");
const plain = "/fake/attachment.png";
const registered = "/fake/.adari-attachments-0123/attachment-11111111-1111-1111-1111-111111111111.png";
const caption = "same caption";
const scope = { terminalID: "t1", session: "s1" };
const key = "h/p";
const entry = (paneId = "p", text = `${caption} ${registered}`, session: string | null = "s1") => ({ hostId: "h", paneId, text, terminalID: "t1", session });
const iso = (ms: number): string => new Date(ms).toISOString();
const user = (id: string, parent: string | null, text: string, time: string) => claudeUser(id, parent, text, time, { promptSource: "typed" });
/** The session's history before the Send: a message and its reply, the reply the last item (the anchor). */
const history = (text: string, time: number | null) => [user("u-old", null, text, time === null ? "" : iso(time)), claudeReply("a-old", "u-old", "ok", iso(at - 30_000))];
const tick = async (): Promise<void> => {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
};

let offs: (() => void)[] = [];
beforeEach(() => {
  pendingMessages.clear();
});
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  pendingMessages.clear();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------
// Fix 1: main's check, a pane whose Claude Code takes the keys and writes nothing, an unrelated frame going working.

const recordLine = (text: string, session = "s1") => JSON.stringify({ type: "user", sessionId: session, message: { role: "user", content: text } });

class Pane {
  clock = 0;
  status = "idle";
  lines: string[] = [];
  reads = 0;
  prompted = false;
  readonly record: QueueRecord = {
    end: async () => this.lines.length,
    since: async (from) => {
      this.reads += 1;
      return this.lines.slice(from);
    },
  };

  site(reader: "none" | "notForSession" | "present", session: string | null): SendSite {
    return {
      writer: { prompt: async () => void (this.prompted = true), sendText: async () => undefined, sendInput: async () => undefined, agentKeys: async () => undefined },
      fresh: async () => true,
      pane: () => ({ paneID: "p", terminalID: "t1", agent: "claude", agentStatus: this.status }) as never,
      agent: () =>
        ({
          paneID: "p",
          terminalID: "t1",
          agent: "claude",
          agentStatus: this.status,
          ...(session === null ? {} : { agentSession: { source: "herdr:claude", kind: "id", value: session } }),
          turnEpoch: 7,
        }) as never,
      run: () => ({ connection: 1, arrival: 1 }),
      inputGeneration: () => 0,
      box: {
        site: {
          read: async () => claudeScreen({ working: this.status === "working" }),
          // The keys went into the box; Claude Code wrote nothing, and an unrelated turn starts (idle, then working).
          wait: async (ms) => {
            this.clock += ms;
            this.status = "working";
          },
          keys: async () => undefined,
          now: () => this.clock,
        },
        own: () => [],
        sent: () => undefined,
        due: () => false,
        machine: () => true,
        marks: () => 0,
        ...(reader === "none" ? {} : { record: () => (reader === "present" ? this.record : undefined) }),
      },
    };
  }

  async send(reader: "none" | "notForSession" | "present", session: string | null = "s1"): Promise<string | null> {
    const checks = new SendChecks();
    const text = `review caption ${registered}`;
    const receipt = await sendWithReceipt(checks, (follow) => sendBound({ ...this.site(reader, session), ...follow }, "p", text, { terminalID: "t1", isAgent: true, kind: "claude", session }));
    return checks.take(receipt.check!);
  }
}

describe("a named session is never proved by the screen (1)", () => {
  it("a session named and no record reader: unknown at the bound, never taken (the reviewer's probe)", async () => {
    expect(await new Pane().send("none")).toBe("unknown");
  });

  it("a session named whose record cannot be used (the reader gives none for it): unknown, never taken", async () => {
    expect(await new Pane().send("notForSession")).toBe("unknown");
  });

  it("with the reader, the same screen and no line: unknown; a line of this send in its session: taken", async () => {
    expect(await new Pane().send("present")).toBe("unknown");
    const pane = new Pane();
    const reading = pane.send("present");
    // Claude Code's record shows the message once the keys went.
    const added = (async () => {
      while (!pane.prompted) await Promise.resolve();
      pane.lines.push(recordLine(`review caption ${registered}`));
    })();
    await added;
    expect(await reading).toBe("taken");
  });

  it("no session named: the screen's proof stays exactly as before (taken)", async () => {
    expect(await new Pane().send("none", null)).toBe("taken");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fix 2: the kept list fits its file.

/** The Send IPC's order for a picture message: room before the first key, the copy kept at the Return. */
function sendKept(store: DraftStore, kept: ReturnType<typeof entry>): string | "refused" {
  const reservation = store.reserveUnproved(kept);
  if (reservation === null) return "refused";
  return store.keepUnproved(kept, reservation) ?? "lost";
}

describe("the kept list fits its file (2)", () => {
  it("24 messages of 90,000 bytes with a picture, 8 in each of 3 panes: every one kept, moved to Kept drafts, or refused before any key; the file loads; the draft stays", () => {
    const files = new MemoryDraftFiles();
    const logs: string[] = [];
    const store = new DraftStore(files, { now: () => at, log: (line) => logs.push(line) });
    store.put("h", "other", { text: "keep this draft", chips: [], lost: [] }, "claude");
    store.flush();
    const texts = Array.from({ length: 24 }, (_, n) => `${n} ${"x".repeat(90_000)} ${registered}`);
    const answers = texts.map((text, n) => sendKept(store, entry(`p${Math.floor(n / 8)}`, text)));
    store.flush();
    expect(answers).not.toContain("lost");
    expect(Buffer.byteLength(files.text!)).toBeLessThanOrEqual(maxDraftsBytes);
    // A quit and a start: the same reader loads the file (nothing moved aside), every copy and Kept draft in it.
    const restartLogs: string[] = [];
    const started = new DraftStore(files, { now: () => at + 1_000, log: (line) => restartLogs.push(line) });
    expect(restartLogs.filter((line) => line.includes("damaged"))).toEqual([]);
    const state = started.state();
    expect(state.drafts.map((draft) => draft.text)).toEqual(["keep this draft"]);
    const asCopy = new Set((state.unproved ?? []).map((one) => one.text));
    const asKept = new Set(state.kept.map((one) => `${one.text} ${one.chips.map((chip) => chip.path).join(" ")}`));
    const refused = texts.filter((_, n) => answers[n] === "refused");
    for (const text of texts) expect([asCopy.has(text), asKept.has(text), refused.includes(text)].filter(Boolean)).toHaveLength(1);
    // The numbers: 7 copies fill the list's 640 KiB, the 2 oldest moved to Kept drafts (its 256 KiB), 15 refused.
    expect([asCopy.size, asKept.size, refused.length]).toEqual([7, 2, 15]);
    expect(state.kept.every((one) => one.chips.length === 1 && one.chips[0]!.path === registered)).toBe(true);
    expect(JSON.stringify(state.unproved).length).toBeLessThanOrEqual(unprovedByteLimit);
    expect(JSON.stringify(state.kept).length).toBeLessThanOrEqual(keptByteLimit);
    // Every refusal was before its Return (no copy was lost after one), each logged.
    expect(logs.filter((line) => line.includes("refused before any key"))).toHaveLength(15);
  });

  it("the reviewer's probe, copies kept with no room taken first: never a file the reader refuses, no draft dropped", () => {
    const files = new MemoryDraftFiles();
    const store = new DraftStore(files, { now: () => at });
    store.put("h", "other", { text: "keep this draft", chips: [], lost: [] }, "claude");
    const ids = Array.from({ length: 24 }, (_, n) => store.keepUnproved(entry(`p${Math.floor(n / 8)}`, `${"x".repeat(90_000)} ${registered}`)));
    store.flush();
    expect(Buffer.byteLength(files.text!)).toBeLessThanOrEqual(maxDraftsBytes);
    expect(ids.filter((id) => id === null)).toHaveLength(15);
    const started = new DraftStore(files, { now: () => at + 1_000 });
    expect(started.state().unproved).toHaveLength(7);
    expect(started.state().kept).toHaveLength(2);
    expect(started.state().drafts[0]?.text).toBe("keep this draft");
  });

  it("the drafts fill the file: the Send is refused before any key, no draft is dropped and nothing moves", () => {
    const files = new MemoryDraftFiles();
    const store = new DraftStore(files, { now: () => at });
    for (let n = 0; n < 20; n += 1) store.put("h", `d${n}`, { text: "d".repeat(100_000), chips: [], lost: [] }, "claude");
    store.flush();
    const before = files.text;
    expect(store.reserveUnproved(entry("p", `${"y".repeat(95_000)} ${registered}`))).toBeNull();
    expect(store.state().drafts).toHaveLength(20);
    expect(store.state().kept).toEqual([]);
    store.flush();
    expect(files.text).toBe(before);
    // A short one still fits beside them.
    expect(sendKept(store, entry())).not.toBe("refused");
  });

  it("room taken counts until it is kept or given back", () => {
    const store = new DraftStore(new MemoryDraftFiles(), { now: () => at });
    const big = entry("p", `${"z".repeat(330_000)} ${registered}`);
    const first = store.reserveUnproved(big);
    expect(first).not.toBeNull();
    // Two of these do not fit the list's 640 KiB with nothing to move: the second is refused while the first holds.
    expect(store.reserveUnproved(big)).toBeNull();
    store.releaseReservation(first!);
    const second = store.reserveUnproved(big);
    expect(second).not.toBeNull();
    expect(store.keepUnproved(big, second)).not.toBeNull();
  });

  it("the room taken by a draft since: the copy is not kept (logged), the file stays within its bound, the drafts stay", () => {
    const files = new MemoryDraftFiles();
    const logs: string[] = [];
    const store = new DraftStore(files, { now: () => at, log: (line) => logs.push(line) });
    for (let n = 0; n < 20; n += 1) store.put("h", `d${n}`, { text: "d".repeat(100_000), chips: [], lost: [] }, "claude");
    const message = entry("p", `${"y".repeat(60_000)} ${registered}`);
    const reservation = store.reserveUnproved(message);
    expect(reservation).not.toBeNull();
    // A draft saved meanwhile (its own bound does not count room taken, and drops no draft for it).
    store.put("h", "late", { text: "l".repeat(50_000), chips: [], lost: [] }, "claude");
    expect(store.keepUnproved(message, reservation)).toBeNull();
    store.flush();
    expect(Buffer.byteLength(files.text!)).toBeLessThanOrEqual(maxDraftsBytes);
    expect(store.state().drafts).toHaveLength(21);
    expect(store.state().unproved).toBeUndefined();
    expect(logs.some((line) => line.includes("was not kept"))).toBe(true);
  });

  it("the largest message a Send takes (100,000 bytes, each one escaped six times over) is kept on its own", () => {
    const files = new MemoryDraftFiles();
    const store = new DraftStore(files, { now: () => at });
    const text = `${"\u0001".repeat(100_000)} ${registered}`;
    expect(sendKept(store, entry("p", text))).not.toBe("refused");
    store.flush();
    expect(new DraftStore(files, { now: () => at }).state().unproved![0]!.text).toBe(text);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fix 3: a restored bubble is settled only by its own message.

/** A copy as drafts.json holds it, in 80735fbe's format (no history) unless `anchor` is given. */
const copy = (path: string, outcome: UnprovedSend["outcome"] = "unknown", anchor?: string | null): UnprovedSend => ({
  ...entry("p", `${caption} ${path}`),
  id: "kept-1",
  sentAt: at,
  outcome,
  ...(anchor === undefined ? {} : { history: { anchor } }),
});

/** The store with `kept` restored after a reload past its bound, the pane's snapshot naming `session`. */
function restored(kept: UnprovedSend, session = "s1"): { store: PendingMessages; released: string[] } {
  const store = new PendingMessages();
  const released: string[] = [];
  store.onReleased((item) => {
    if (item.kept !== undefined) released.push(item.kept);
  });
  store.restore([kept], at + 40_000);
  store.reconcile(new Map([[key, { ...scope, session }]]), () => true);
  return { store, released };
}

describe("a restored bubble is settled only by its own message (3)", () => {
  for (const [name, path] of [
    ["plain", plain],
    ["registered", registered],
  ] as const) {
    describe(`a ${name} picture path`, () => {
      const text = `${caption} ${path}`;

      it("no history kept: the identical message 60 s before the Send never settles it nor releases its copy (the reviewer's probe)", () => {
        const { store, released } = restored(copy(path));
        store.observe(key, timelineOf(history(text, at - 60_000)).timeline);
        expect(store.forPane(key).map((item) => item.state)).toEqual(["unconfirmed"]);
        expect(released).toEqual([]);
      });

      it("no history kept: an identical message with no time never settles it", () => {
        const { store, released } = restored(copy(path));
        const timeline = timelineOf(history(text, null)).timeline;
        expect(timeline.turns.flatMap((turn) => turn.items).find((item) => item.type === "user")!.value.time).toBeNull();
        store.observe(key, timeline);
        expect(store.forPane(key).map((item) => item.state)).toEqual(["unconfirmed"]);
        expect(released).toEqual([]);
      });

      it("a new session's identical message, after the Send, never proves the old session's restored send (the reviewer's probe)", () => {
        for (const anchor of [undefined, "a-old"] as const) {
          const { store, released } = restored(copy(path, "unknown", anchor), "s2");
          store.observe(key, timelineOf([user("u-new", null, text, iso(at + 10_000))]).timeline);
          const [bubble] = store.forPane(key);
          expect(bubble?.state).toBe("unconfirmed");
          // Its destination stays the session it went to.
          expect(bubble?.scope).toEqual(scope);
          expect(released).toEqual([]);
        }
      });

      it("with its history: the identical message before where the transcript stood, timed or not, never settles it", () => {
        for (const time of [at - 60_000, at, at + 5_000, null]) {
          const { store, released } = restored(copy(path, "unknown", "a-old"));
          store.observe(key, timelineOf(history(text, time)).timeline);
          expect(store.forPane(key)).toHaveLength(1);
          expect(released).toEqual([]);
        }
      });

      it("with its history: its own message, after where the transcript stood, in its own session, settles it and releases its copy", () => {
        const { store, released } = restored(copy(path, "unknown", "a-old"));
        store.observe(key, timelineOf([...history(text, at - 60_000), user("u-1", "a-old", text, iso(at + 1_000))]).timeline);
        expect(store.forPane(key)).toEqual([]);
        expect(released).toEqual(["kept-1"]);
      });

      it("with its history, a timeline that no longer holds that item (another file shown) never settles it", () => {
        const { store, released } = restored(copy(path, "unknown", "a-old"));
        store.observe(key, timelineOf([user("u-1", null, text, iso(at + 1_000))]).timeline);
        expect(store.forPane(key)).toHaveLength(1);
        expect(released).toEqual([]);
      });
    });
  }

  it("a copy in 80735fbe's format loads as it was and is could not confirm, with Put back giving its text and pictures", () => {
    const files = new MemoryDraftFiles();
    const old = copy(registered, "checking");
    files.text = JSON.stringify({ version: 1, drafts: [], kept: [], unproved: [old] });
    const loaded = new DraftStore(files, { now: () => at + 40_000 }).state().unproved!;
    expect(loaded).toEqual([old]);
    const { store, released } = restored(loaded[0]!);
    // Its own message is in the transcript now, but nothing tells it from history: it stays for the person.
    store.observe(key, timelineOf([...history("earlier", at - 60_000), user("u-1", "a-old", old.text, iso(at + 1_000))]).timeline);
    expect(store.forPane(key).map((item) => item.state)).toEqual(["unconfirmed"]);
    expect(released).toEqual([]);
    expect(store.takeNotSent(store.forPane(key)[0]!.id)).toBe(old.text);
    expect(released).toEqual(["kept-1"]);
  });

  it("one the record proved, with no history kept: it settles into its own session's message (its copy can lose nothing)", () => {
    const { store, released } = restored(copy(registered, "taken"));
    expect(store.forPane(key).map((item) => item.state)).toEqual(["sent"]);
    store.observe(key, timelineOf([user("u-new", null, `${caption} ${registered}`, iso(at + 1_000))]).timeline);
    expect(store.forPane(key)).toEqual([]);
    expect(released).toEqual(["kept-1"]);
    // Its session changed: the record proved it went to the old one, so the change ends it as on 80735fbe (only an
    // unproved one becomes could not confirm); no message of the new session is taken for it.
    const other = restored(copy(registered, "taken"), "s2");
    expect(other.store.forPane(key)).toEqual([]);
    expect(other.released).toEqual(["kept-1"]);
  });

  it("a restored bubble waits for the pane's snapshot: a timeline before its session is known settles nothing", () => {
    const store = new PendingMessages();
    store.restore([copy(registered, "unknown", "a-old")], at + 40_000);
    store.observe(key, timelineOf([...history("earlier", at - 60_000), user("u-1", "a-old", `${caption} ${registered}`, iso(at + 1_000))]).timeline);
    expect(store.forPane(key)).toHaveLength(1);
  });

  it("the live bubble tells main where the transcript stood, once, and main keeps it through a quit and a start", async () => {
    const files = new MemoryDraftFiles();
    const drafts = new DraftStore(files, { now: () => at });
    const told: [string, string | null][] = [];
    offs.push(
      attachSendKeeping({
        unprovedRelease: async (id) => void drafts.releaseUnproved(id),
        sendCheckEnd: async () => undefined,
        unprovedHistory: async (id, anchor) => {
          told.push([id, anchor]);
          drafts.unprovedHistory(id, { anchor });
        },
      }),
    );
    pendingMessages.reconcile(new Map([[key, scope]]), () => true);
    pendingMessages.observe(key, timelineOf(history("earlier", at - 60_000)).timeline);
    const text = `${caption} ${registered}`;
    await sendWithPending(async () => ({ check: "check-1", kept: drafts.keepUnproved(entry("p", text))! }), "h", "p", text, true, scope, () => at, false, {
      check: () => new Promise(() => undefined),
      wait: () => new Promise(() => undefined),
    });
    await tick();
    pendingMessages.observe(key, timelineOf(history("earlier", at - 60_000)).timeline);
    await tick();
    const id = drafts.state().unproved![0]!.id;
    expect(told).toEqual([[id, "a-old"]]);
    expect(drafts.unprovedHistory(id, { anchor: "other" })).toBe(false);
    drafts.flush();
    expect(new DraftStore(files, { now: () => at }).state().unproved![0]!.history).toEqual({ anchor: "a-old" });
  });

  it("a copy whose history on disk is malformed is skipped, the others load", () => {
    const files = new MemoryDraftFiles();
    const good = copy(registered, "unknown", "a-old");
    files.text = JSON.stringify({ version: 1, drafts: [], kept: [], unproved: [{ ...good, id: "kept-0", history: { anchor: 5 } }, good] });
    expect(new DraftStore(files, { now: () => at }).state().unproved).toEqual([good]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fix 4: a receipt after its bubble settled.

describe("a receipt that comes after its bubble settled retires its ids (4)", () => {
  it("the transcript settles the bubble before the receipt: its copy is released and its check ended at once (the reviewer's probe)", async () => {
    const drafts = new DraftStore(new MemoryDraftFiles(), { now: () => at });
    const ended: string[] = [];
    offs.push(attachSendKeeping({ unprovedRelease: async (id) => void drafts.releaseUnproved(id), sendCheckEnd: async (id) => void ended.push(id) }));
    const earlier = [user("u0", null, "earlier", iso(at - 60_000)), claudeReply("a0", "u0", "ok", iso(at - 50_000))];
    pendingMessages.observe(key, timelineOf(earlier).timeline);
    const text = `${caption} ${registered}`;
    await sendWithPending(
      async () => {
        const kept = drafts.keepUnproved(entry("p", text))!;
        pendingMessages.observe(key, timelineOf([...earlier, user("u1", "a0", text, iso(at + 1_000))]).timeline);
        return { check: "check-1", kept };
      },
      "h",
      "p",
      text,
      true,
      scope,
      () => at,
      false,
      { check: () => new Promise(() => undefined), wait: () => new Promise(() => undefined) },
    );
    await tick();
    expect(pendingMessages.forPane(key)).toEqual([]);
    expect(drafts.state().unproved).toBeUndefined();
    expect(ended).toEqual(["check-1"]);
  });

  it("a bubble gone another way before its receipt (Claude Code put its text back) is left as today: nothing released by the receipt", async () => {
    const drafts = new DraftStore(new MemoryDraftFiles(), { now: () => at });
    const ended: string[] = [];
    offs.push(attachSendKeeping({ unprovedRelease: async (id) => void drafts.releaseUnproved(id), sendCheckEnd: async (id) => void ended.push(id) }));
    const text = `${caption} ${registered}`;
    await sendWithPending(
      async () => {
        const kept = drafts.keepUnproved(entry("p", text))!;
        pendingMessages.takeBack(key, text);
        return { check: "check-1", kept };
      },
      "h",
      "p",
      text,
      true,
      scope,
      () => at,
      false,
      { check: () => new Promise(() => undefined), wait: () => new Promise(() => undefined) },
    );
    await tick();
    expect(pendingMessages.forPane(key)).toEqual([]);
    expect(drafts.state().unproved).toHaveLength(1);
    expect(ended).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fix 5: a session change turns every unproved kept bubble could not confirm.

describe("after a session change no bubble says the text is still in the box (5)", () => {
  it("a restored still-in-the-box bubble becomes could not confirm in the new session (the reviewer's probe)", () => {
    const store = new PendingMessages();
    store.restore([copy(registered, "stillInBox")], at + 1_000);
    expect(store.forPane(key).map((item) => item.state)).toEqual(["inBox"]);
    store.reconcile(new Map([[key, { ...scope, session: "s2" }]]), () => true);
    expect(store.forPane(key).map((item) => item.state)).toEqual(["unconfirmed"]);
  });

  it("a live one too, sending or in the box: could not confirm, its destination kept, Put back gives its text; no churn after", () => {
    const store = new PendingMessages();
    const released: string[] = [];
    store.onReleased((item) => {
      if (item.kept !== undefined) released.push(item.kept);
    });
    store.reconcile(new Map([[key, scope]]), () => true);
    const text = `${caption} ${registered}`;
    const inBox = store.add(key, text, at, scope);
    store.typed(inBox, { check: "check-1", kept: "kept-1" });
    store.checked(inBox, "stillInBox");
    const sending = store.add(key, `${caption} two ${registered}`, at, scope);
    store.typed(sending, { check: "check-2", kept: "kept-2" });
    expect(store.forPane(key).map((item) => item.state)).toEqual(["inBox", "sending"]);
    let changes = 0;
    store.subscribe(() => (changes += 1));
    store.reconcile(new Map([[key, { ...scope, session: "s2" }]]), () => true);
    expect(store.forPane(key).map((item) => [item.state, item.scope])).toEqual([
      ["unconfirmed", scope],
      ["unconfirmed", scope],
    ]);
    const after = changes;
    store.reconcile(new Map([[key, { ...scope, session: "s2" }]]), () => true);
    expect(changes).toBe(after);
    expect(store.takeNotSent(inBox)).toBe(text);
    expect(released).toEqual(["kept-1"]);
  });
});
