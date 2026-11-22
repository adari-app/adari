// For a Claude pane whose session is named, only Claude
// Code's record settles a picture message, and the proof belongs to this send. Through the real send service
// (sendBound with its picture check and the record watch after it, sendWithReceipt, SendChecks) on a fake Claude pane
// with a virtual clock and a fake record whose end is its length (a line written before the end's read is not past it).
//
// - The screen (an empty box with a working line, a new queued hint, our text gone, an empty box after the corrective
//   Return) settles nothing: with the screen alone the record is read on to the bound and the answer is unknown.
// - The record's end is read after every wait of the staging, right before the write; only a line of this session
//   counts; the pane's binding is asked again after each record read; one count (30) and one deadline (the bound)
//   cover the check and the watch; the watch ends when the page ends the check, the pane closes or the connection
//   changes. No key and no screen read is added to the watch.
// - A bubble the record proved stays sent through an empty or unreadable idle screen (the backstop never takes it).
// - The no-session pane keeps the screen as its only proof.

import { beforeEach, describe, expect, it } from "vitest";

import type { ClaudeBoxSite } from "../src/main/herdr/claude-box";
import { recordWatchReads, SendChecks, sendBound, sendWithReceipt, type SendSite } from "../src/main/herdr/send";
import { recordShows, type QueueRecord } from "../src/shared/claude-queue-record";
import { sendProofBoundMs } from "../src/shared/claude-screen";
import { PendingBackstop, PendingMessages } from "../src/shared/chat/pending";
import type { SendCheck } from "../src/shared/ipc-contract";
import { pendingMessages, sendWithPending } from "../src/renderer/chat/chat-state";
import { claudeScreen } from "./support/claude-screens";
import { queueLine } from "./support/claude-queue-screens";
import { claudeReply, claudeUser } from "./support/esc-queue-lines";
import { timelineOf } from "./support/chat-lines";

const picture = "/fake/attachment-11111111-1111-1111-1111-111111111111.png";
const text = `record caption ${picture}`;
const binding = { terminalID: "t1", isAgent: true, kind: "claude", session: "s1" };
const scope = { terminalID: "t1", session: "s1" };
/** The record's lines: your prompt, or Claude's enqueue of it, for `session`. */
const userLine = (content: string, session = "s1"): string => JSON.stringify({ type: "user", sessionId: session, message: { role: "user", content } });
const enqueueLine = (content: string, session = "s1"): string => queueLine("enqueue", { content, sessionId: session });
const tick = async (): Promise<void> => {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
};

/**
 * A Claude pane on a virtual clock (`clock`, moved by the check's waits). The record's end is its length now; each
 * `since` read is logged with the clock at its start. `onWait` and `onRead` change the pane meanwhile.
 */
class Pane {
  clock = 0;
  session = "s1";
  connection = 1;
  exists = true;
  machine = true;
  status: "idle" | "working" = "working";
  draft = "";
  prompted = false;
  readonly reads: number[] = [];
  readonly keys: string[][] = [];
  readonly screens: number[] = [];
  readonly prompts: string[] = [];
  readonly sent: string[] = [];
  lines: string[] = [];
  onWait: () => void = () => undefined;
  onRead: () => void = () => undefined;
  onFresh: () => void = () => undefined;
  /** What the box shows after the prompt. */
  intake: () => string = () => "";
  /** A corrective Return the box takes (it empties). */
  takesReturn = false;
  /** Claude draws its queued hint once the prompt went. */
  queuedAfterPrompt = false;

  readonly record: QueueRecord = {
    end: async () => this.lines.length,
    since: async (from) => {
      this.reads.push(this.clock);
      this.onRead();
      return this.lines.slice(from);
    },
  };

  readonly screen: ClaudeBoxSite = {
    now: () => this.clock,
    wait: async (ms) => {
      this.clock += ms;
      this.onWait();
    },
    read: async () => {
      this.screens.push(this.clock);
      return claudeScreen({ draft: this.draft, working: this.status === "working", queued: this.prompted && this.queuedAfterPrompt ? ["record caption"] : [] });
    },
    keys: async (keys) => {
      this.keys.push([...keys]);
      if (keys.includes("Enter") && this.takesReturn) this.draft = "";
    },
  };

  site(): SendSite {
    return {
      writer: {
        prompt: async (_p, sent) => {
          this.prompted = true;
          this.prompts.push(sent);
          this.draft = this.intake();
        },
        sendInput: async () => undefined,
        sendText: async () => undefined,
        agentKeys: async () => undefined,
      },
      fresh: async () => {
        this.onFresh();
        return true;
      },
      pane: () => (this.exists ? ({ paneID: "p1", terminalID: "t1", agent: "claude", agentStatus: this.status } as never) : null),
      agent: () =>
        ({
          paneID: "p1",
          terminalID: "t1",
          agent: "claude",
          agentStatus: this.status,
          agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: this.session },
          turnEpoch: 7,
        }) as never,
      run: () => ({ connection: this.connection, arrival: 1 }),
      inputGeneration: () => 0,
      box: {
        site: this.screen,
        own: () => this.sent,
        sent: (sent) => void this.sent.push(sent),
        due: () => false,
        machine: () => this.machine,
        marks: () => 0,
        record: () => this.record,
      },
    };
  }

  /** The Send through the IPC's receipt; the check's outcome. */
  async send(checks = new SendChecks()): Promise<SendCheck | null> {
    const receipt = await sendWithReceipt(checks, (follow) => sendBound({ ...this.site(), ...follow }, "p1", text, binding));
    return receipt.check === null ? null : checks.take(receipt.check);
  }
}

describe("only the record settles a picture message for a named session (fix 2)", () => {
  it("an accepted prompt that wrote nothing while another activity turns the pane working: unknown at the bound, never taken", async () => {
    const pane = new Pane();
    pane.status = "idle";
    pane.onWait = () => {
      pane.status = "working";
    };
    expect(await pane.send()).toBe("unknown");
    // Read on to the bound, never past it.
    expect(pane.clock).toBeGreaterThanOrEqual(sendProofBoundMs - 1_000);
    expect(pane.reads.every((at) => at < sendProofBoundMs)).toBe(true);
    expect(pane.keys).toEqual([]);
  });

  it("the screen's other words settle nothing: a new queued hint, our text seen then gone, an empty box after the corrective Return", async () => {
    // A queued hint not there before the write.
    const hinted = new Pane();
    hinted.queuedAfterPrompt = true;
    expect(await hinted.send()).toBe("unknown");
    // Our text in the box, then gone while Claude works.
    const seen = new Pane();
    seen.intake = () => `[Image #1]record caption`;
    seen.onWait = () => {
      if (seen.clock >= 1_000) seen.draft = "";
    };
    expect(await seen.send()).toBe("unknown");
    // Idle: every picture in, the corrective Return, the box empties.
    const returned = new Pane();
    returned.status = "idle";
    returned.intake = () => `[Image #1]record caption`;
    returned.takesReturn = true;
    expect(await returned.send()).toBe("unknown");
    // The one Return still went, exactly as before (the screen still gates it).
    expect(returned.keys).toEqual([["Enter"]]);
    // The same three with the record's line: taken.
    for (const make of [() => seen, () => returned]) {
      const pane = new Pane();
      pane.status = make().status;
      pane.intake = make().intake;
      pane.takesReturn = make().takesReturn;
      pane.onWait = () => {
        if (pane.clock >= 2_000 && pane.lines.length === 0) pane.lines.push(userLine(text));
      };
      expect(await pane.send()).toBe("taken");
    }
  });

  it("the record's line settles it however the screen looks", async () => {
    const pane = new Pane();
    pane.onWait = () => {
      if (pane.clock >= 8_000 && pane.lines.length === 0) pane.lines.push(enqueueLine(text));
    };
    expect(await pane.send()).toBe("taken");
  });

  it("a bubble the record proved stays sent through an empty or an unreadable idle screen", async () => {
    for (const onScreen of [false, null] as const) {
      const store = new PendingMessages();
      const timers: (() => void)[] = [];
      const backstop = new PendingBackstop(store, (run) => timers.push(run), () => undefined);
      const id = store.add("h/p", text, 0, scope);
      store.typed(id, { check: "check-1", kept: null });
      store.checked(id, "taken");
      let screenReads = 0;
      backstop.watch("h/p", "idle", async () => {
        screenReads += 1;
        return onScreen;
      });
      for (const run of timers.splice(0)) run();
      await tick();
      store.markNotSent("h/p");
      expect(store.forPane("h/p").map((item) => [item.state, item.proved])).toEqual([["sent", true]]);
      expect(screenReads).toBe(0);
    }
  });

  it("the no-session pane keeps the screen as its only proof", async () => {
    const pane = new Pane();
    pane.status = "idle";
    pane.intake = () => `[Image #1]record caption`;
    pane.takesReturn = true;
    const checks = new SendChecks();
    const site = pane.site();
    const receipt = await sendWithReceipt(checks, (follow) =>
      sendBound({ ...site, ...follow, agent: () => ({ paneID: "p1", terminalID: "t1", agent: "claude", agentStatus: pane.status, turnEpoch: 7 }) as never }, "p1", text, { ...binding, session: null }),
    );
    expect(await checks.take(receipt.check!)).toBe("taken");
    expect(pane.reads).toEqual([]);
  });
});

describe("the proof belongs to this send (fix 3)", () => {
  it("a line of the same words written before the write (during the last fresh snapshot) is not this send's", async () => {
    const pane = new Pane();
    pane.onFresh = () => {
      if (!pane.prompted) pane.lines.push(userLine(text));
    };
    expect(await pane.send()).toBe("unknown");
  });

  it("the session changed during the record read: never taken from the old session, and the reads end", async () => {
    const pane = new Pane();
    pane.lines = [];
    pane.onWait = () => {
      if (pane.clock >= 1_000 && pane.lines.length === 0) pane.lines.push(userLine(text));
    };
    pane.onRead = () => {
      if (pane.lines.length > 0) pane.session = "s2";
    };
    expect(await pane.send()).toBe("unknown");
    expect(pane.reads).toHaveLength(pane.reads.filter((at) => at < 1_500).length);
  });

  it("the reviewer's positive controls still hold for this session's lines (the matching itself is unchanged)", () => {
    for (const sent of ["same words", "first\n\nsecond", " first\nsecond\n", "trailing  ", 'quotes " and \\ and 🐈', picture]) {
      expect(recordShows([enqueueLine(sent)], sent, "s1")).toBe("queued");
      expect(recordShows([userLine(sent)], sent, "s1")).toBe("taken");
      expect(recordShows([userLine(`prefix ${sent} suffix`)], sent, "s1")).toBeNull();
    }
    expect(recordShows([userLine("[Image #42]")], picture, "s1")).toBe("taken");
  });

  it("another session's line is no proof", async () => {
    const pane = new Pane();
    pane.onWait = () => {
      if (pane.clock >= 1_000 && pane.lines.length === 0) pane.lines.push(userLine(text, "s2"), enqueueLine(text, "s2"));
    };
    expect(await pane.send()).toBe("unknown");
    expect(recordShows([enqueueLine(text, "different-session")], text, "s1")).toBeNull();
    expect(recordShows([enqueueLine(text, "s1")], text, "s1")).toBe("queued");
    expect(recordShows([JSON.stringify({ type: "user", message: { role: "user", content: text } })], text, "s1")).toBeNull();
  });

  it("the watch ends when the pane closes or the connection changes: no record read after", async () => {
    for (const change of [(pane: Pane) => (pane.exists = false), (pane: Pane) => (pane.connection = 2), (pane: Pane) => (pane.machine = false)]) {
      const pane = new Pane();
      pane.onWait = () => {
        if (pane.clock >= 2_000) change(pane);
      };
      expect(await pane.send()).toBe("unknown");
      expect(pane.reads.filter((at) => at >= 2_000)).toEqual([]);
    }
  });

  it("one count and one deadline for the check and the watch: at most 30 reads, none at or past the bound, no key, no screen read in the watch", async () => {
    const pane = new Pane();
    expect(await pane.send()).toBe("unknown");
    expect(recordWatchReads).toBe(30);
    expect(pane.reads.length).toBeLessThanOrEqual(30);
    expect(pane.reads.every((at) => at < sendProofBoundMs)).toBe(true);
    expect(pane.keys).toEqual([]);
    // The screen is read only in the check's first phase (its settle reads end well before the bound).
    expect(Math.max(...pane.screens)).toBeLessThan(sendProofBoundMs / 2);
  });

  it("an early binding change (the reviewer's case): the reads end with it, never more than 30 in all", async () => {
    for (const change of [(pane: Pane) => (pane.machine = false), (pane: Pane) => (pane.session = "s2"), (pane: Pane) => (pane.connection = 2)]) {
      const pane = new Pane();
      let changedAt: number | null = null;
      // The first wait after the write.
      pane.onWait = () => {
        if (pane.prompted && changedAt === null) {
          changedAt = pane.clock;
          change(pane);
        }
      };
      expect(await pane.send()).toBe("unknown");
      expect(changedAt).not.toBeNull();
      expect(pane.reads.length).toBeLessThanOrEqual(30);
      expect(pane.reads.filter((at) => at > changedAt!)).toEqual([]);
    }
  });

  it("the page settling the bubble ends main's watch: no record read after the settlement", async () => {
    pendingMessages.clear();
    const earlier = [claudeUser("u0", null, "earlier", "2026-11-20T09:00:00Z", { promptSource: "typed" }), claudeReply("a0", "u0", "ok", "2026-11-20T09:00:01Z")];
    pendingMessages.observe("h/p", timelineOf(earlier).timeline);
    const checks = new SendChecks();
    const off = pendingMessages.onReleased((item) => {
      if (item.check !== undefined) checks.end(item.check);
    });
    const pane = new Pane();
    let settledAt: number | null = null;
    pane.onWait = () => {
      if (pane.clock >= 4_000 && settledAt === null) {
        settledAt = pane.clock;
        pendingMessages.observe("h/p", timelineOf([...earlier, claudeUser("u1", "a0", text, "2026-11-20T09:00:03Z", { promptSource: "typed" })]).timeline);
      }
    };
    const site = pane.site();
    await sendWithPending(
      (_h, _p, t) => sendWithReceipt(checks, (follow) => sendBound({ ...site, ...follow }, "p1", t, binding)),
      "h",
      "p",
      text,
      true,
      scope,
      () => Date.parse("2026-11-20T09:00:02Z"),
      false,
      { check: (id) => checks.take(id), wait: () => new Promise(() => undefined) },
    );
    for (let i = 0; i < 50 && pane.clock < sendProofBoundMs && (settledAt === null || pane.reads.at(-1)! < settledAt); i += 1) await tick();
    await tick();
    off();
    expect(settledAt).not.toBeNull();
    expect(pendingMessages.forPane("h/p")).toEqual([]);
    expect(pane.reads.filter((at) => at > settledAt!)).toEqual([]);
  });
});

beforeEach(() => pendingMessages.clear());
