// A kept landing row never outlives its identity. The reads stop with `keeping` only when the
// pane's terminal, agent session, machine entry (incarnation and epoch),
// connection and agent are still the ones the reads began with; and while the
// row waits for its text to land, a change of any of them (or the Chat
// closing or moving) ends it at once: no text of a previous terminal,
// session or connection shows in the Chat that replaced it. The cases run
// the main process's LiveReads on a fake machine, its events into the page's
// LiveRows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveReads, type LiveHosts } from "../src/main/chat/live-reads";
import type { ChatOwner, ShownChat } from "../src/main/chat/service";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import type { AgentInfo, TopologyPaneInfo } from "../src/main/herdr/wire";
import { PaneReadGate } from "../src/shared/chat/live-reader";
import { emptyTimeline } from "../src/shared/chat/model";
import type { ChatLiveEvent } from "../src/shared/ipc-contract";
import { liveLandingMs, LiveRows } from "../src/renderer/chat/live-rows";

const writing = (text: string): string =>
  ["\u{276F} go on", "", `\u{23FA} ${text}`, "", "\u{2722} Working\u{2026} (12s)", "", "\u{2500}".repeat(64), "\u{276F}", "\u{2500}".repeat(64)].join("\n");

const page: ChatOwner = { id: 9, send: () => undefined, isDestroyed: () => false };

type Change = "terminal" | "session" | "machine" | "epoch" | "connection" | "agent" | "stopped" | "working" | "closed" | "pane";

/** One machine, one pane, one Chat on screen; its reads held until let go. */
function fake() {
  const pane = { paneID: "p", terminalID: "term", agent: "claude", agentStatus: "working" } as unknown as TopologyPaneInfo & { terminalID: string; agentStatus: string; agent: string };
  const agent = { agent: "claude", agentStatus: "working", agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "s" } } as unknown as AgentInfo & {
    agent: string;
    agentStatus: string;
    agentSession: { value: string; agent: string; source: string };
  };
  const identity = { incarnation: 1, epoch: 1 };
  let connection: number | null = 1;
  let shown: ShownChat[] = [{ owner: page, slot: "tile", follow: 1, hostId: "mac", paneId: "p" }];
  const events: ChatLiveEvent[] = [];
  const held: ((screen: string) => void)[] = [];
  const read = vi.fn(() => new Promise<string>((resolve) => held.push(resolve)));
  const hosts: LiveHosts = {
    pane: () => pane,
    agent: () => agent,
    connection: () => connection,
    connectionIdentity: () => ({ ...identity }),
    backend: () => ({ promptIO: () => ({ paneRead: read }) }) as unknown as HerdrHostBackend,
  };
  const live = new LiveReads(hosts, () => shown, (_chat, event) => events.push(event), { gate: new PaneReadGate() });
  const rows = new LiveRows({ forPane: () => ({ hostId: "mac", paneId: "p", state: { status: "live" }, timeline: emptyTimeline, caughtUp: true }), accepts: () => true, followed: () => true });
  let seen = 0;
  return {
    live,
    events,
    held,
    /** The page takes the events sent since it last looked. */
    deliver(): void {
      for (const event of events.slice(seen)) rows.receive(event);
      seen = events.length;
    },
    row: (): string | null => rows.row("mac", "p", emptyTimeline),
    change(what: Change): void {
      if (what === "terminal") pane.terminalID = "term2";
      if (what === "session") agent.agentSession = { ...agent.agentSession, value: "s2" };
      if (what === "machine") identity.incarnation += 1;
      if (what === "epoch") identity.epoch += 1;
      if (what === "connection") connection = 2;
      if (what === "agent") {
        pane.agent = "codex";
        agent.agent = "codex";
        agent.agentSession = { source: "herdr:codex", agent: "codex", kind: "id", value: "s" };
      }
      if (what === "stopped") {
        pane.agentStatus = "done";
        agent.agentStatus = "done";
      }
      if (what === "working") {
        pane.agentStatus = "working";
        agent.agentStatus = "working";
      }
      if (what === "closed") shown = [];
      if (what === "pane") shown = [{ ...shown[0]!, paneId: "other" }];
    },
  };
}

/** A row on the page from the first read. */
async function showing(text: string) {
  const f = fake();
  f.live.sync();
  f.held.shift()!(writing(text));
  await vi.advanceTimersByTimeAsync(0);
  f.deliver();
  expect(f.row()).toBe(text);
  return f;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a kept landing row never outlives its identity", () => {
  it.each(["terminal", "session", "machine", "epoch", "connection", "agent"] as const)("%s replaced while the pane stops working: not kept, the old row gone at once", async (what) => {
    const f = await showing("Reply from the old session");
    f.change(what);
    f.change("stopped");
    f.live.sync();
    expect(f.events.at(-1)).toMatchObject({ type: "stop", keeping: false });
    f.deliver();
    expect(f.row()).toBeNull();
    f.live.closeAll();
  });

  it.each(["terminal", "session", "machine", "epoch", "connection", "agent", "closed", "pane"] as const)(
    "%s changing during a keeping stop's landing wait ends the row at once",
    async (what) => {
      const f = await showing("Old terminal reply");
      f.change("stopped");
      f.live.sync();
      expect(f.events.at(-1)).toMatchObject({ type: "stop", keeping: true });
      f.deliver();
      expect(f.row(), "only the work ended: the row waits for its text").toBe("Old terminal reply");
      await vi.advanceTimersByTimeAsync(liveLandingMs / 2);
      f.change(what);
      f.live.sync();
      expect(f.events.at(-1)).toMatchObject({ type: "stop", keeping: false, follow: 1 });
      f.deliver();
      expect(f.row(), "the old text never shows in the replacement").toBeNull();
      f.live.closeAll();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("only the work ended: the row is kept, a later sync with nothing changed keeps it, and the wait ends on its own", async () => {
    const f = await showing("The feed reads on");
    f.change("stopped");
    f.live.sync();
    f.deliver();
    const stops = f.events.length;
    f.live.sync();
    expect(f.events).toHaveLength(stops);
    expect(f.row()).toBe("The feed reads on");
    await vi.advanceTimersByTimeAsync(liveLandingMs);
    expect(f.row()).toBeNull();
    // Main holds the identity while the Chat stays shown (no clock of its own); a change long after
    // the wait still sends the stop that would end a row, and nothing shows.
    await vi.advanceTimersByTimeAsync(10_000);
    f.change("terminal");
    f.live.sync();
    expect(f.events.slice(stops)).toEqual([{ type: "stop", hostId: "mac", paneId: "p", follow: 1, keeping: false }]);
    f.deliver();
    expect(f.row()).toBeNull();
    // Released: a second sync sends nothing more.
    f.live.sync();
    expect(f.events).toHaveLength(stops + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("working again with the same identity during the wait: reads go on, no extra stop", async () => {
    const f = await showing("The feed reads on");
    f.change("stopped");
    f.live.sync();
    f.deliver();
    f.change("working");
    const before = f.events.length;
    f.live.sync();
    expect(f.live.following).toEqual(["mac p"]);
    expect(f.events.slice(before)).toEqual([]);
    f.held.shift()!(writing("The feed reads on and on"));
    await vi.advanceTimersByTimeAsync(0);
    f.deliver();
    expect(f.row()).toBe("The feed reads on and on");
    // And a change now is the follow's own stop, not the old wait's.
    f.change("terminal");
    f.live.sync();
    expect(f.events.filter((event) => event.type === "stop").map((event) => event.type === "stop" && event.keeping)).toEqual([true, false]);
    f.live.closeAll();
  });
});

// The page starts its 2 s wait when the stop reaches it, which may
// be late (a busy renderer); main's fence lives as long as that row can: while the Chat stays shown, until a new
// follow, an identity change or the Chat leaving.
describe("the identity fence lives as long as the page's landing row can", () => {
  const identities = ["terminal", "session", "machine", "epoch", "connection", "agent"] as const;

  /** A row shown, the work ended (a keeping stop) and the stop reaching the page `delay` ms later. */
  async function landing(delay: number) {
    const f = await showing("Old terminal reply");
    f.change("stopped");
    f.live.sync();
    expect(f.events.at(-1)).toMatchObject({ type: "stop", keeping: true });
    await vi.advanceTimersByTimeAsync(delay);
    f.deliver();
    expect(f.row()).toBe("Old terminal reply");
    return f;
  }

  it.each(identities)("a stop delayed 600 ms still fences a later %s replacement (main 2,501 ms, the page's row 99 ms from its end)", async (what) => {
    const f = await landing(600);
    await vi.advanceTimersByTimeAsync(1_901);
    expect(f.row()).toBe("Old terminal reply");
    f.change(what);
    f.live.sync();
    expect(f.events.at(-1)).toMatchObject({ type: "stop", keeping: false, follow: 1 });
    f.deliver();
    expect(f.row(), "the replacement Chat never keeps the old terminal's text").toBeNull();
    f.live.closeAll();
  });

  it.each(identities)("controls: %s changing at 1,999 ms (the page's last instant) and at main's 2,499 ms ends the row", async (what) => {
    const prompt = await landing(0);
    await vi.advanceTimersByTimeAsync(liveLandingMs - 1);
    expect(prompt.row()).toBe("Old terminal reply");
    prompt.change(what);
    prompt.live.sync();
    prompt.deliver();
    expect(prompt.row()).toBeNull();
    prompt.live.closeAll();
    const late = await landing(500);
    await vi.advanceTimersByTimeAsync(liveLandingMs - 1);
    expect(late.row()).toBe("Old terminal reply");
    late.change(what);
    late.live.sync();
    expect(late.events.at(-1)).toMatchObject({ type: "stop", keeping: false });
    late.deliver();
    expect(late.row()).toBeNull();
    late.live.closeAll();
  });

  it("the ordinary landing still shows its text for its 2 s from when the page has the stop, however late", async () => {
    const f = await landing(600);
    await vi.advanceTimersByTimeAsync(liveLandingMs - 1);
    expect(f.row()).toBe("Old terminal reply");
    await vi.advanceTimersByTimeAsync(1);
    expect(f.row()).toBeNull();
    f.live.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("one record per shown Chat, let go when the Chat leaves: a replacement after it sends nothing", async () => {
    const f = await landing(0);
    f.change("closed");
    f.live.sync();
    const after = f.events.length;
    f.change("terminal");
    f.live.sync();
    expect(f.events).toHaveLength(after);
    expect(vi.getTimerCount(), "main keeps no clock for it").toBe(1);
    await vi.advanceTimersByTimeAsync(liveLandingMs);
    expect(vi.getTimerCount()).toBe(0);
  });
});
