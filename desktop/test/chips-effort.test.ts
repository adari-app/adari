// The Model and Effort chips after a restart in the same pane, and with a line in
// the tail longer than the first window (or than the per-line bound). Fixture transcripts are hand-made in
// Claude Code's shapes; no real transcript is read. All machines and reads are fake.
//
// Why a look-back is needed: Chat's own reads alone do not always name the model. A cold first load reads the
// end's 512 KiB, then earlier only until it holds a screenful (4 turns). When the window holds that many turns
// and no assistant line (the user's messages after a picture longer than the window, say), nothing read names
// the model, and without a look-back the chip would wait for the next reply. A restart in the same pane is a
// cold load again whenever the kept feed went (the shelf let it go, or the window was closed meanwhile).

import { describe, expect, it } from "vitest";

import { AgentPicks } from "../src/renderer/components/agent-picks";
import { maxLineBytes } from "../src/shared/chat/follower";
import type { SendBinding } from "../src/shared/send-binding";

const json = (value: unknown): string => JSON.stringify(value);
const cwd = "/Users/fixture/proj";
const session = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
const path = `/Users/fixture/.claude/projects/-Users-fixture-proj/${session}.jsonl`;

let serial = 0;
const base = (type: string, extra: Record<string, unknown>): string =>
  json({ isSidechain: false, sessionId: session, cwd, timestamp: "2026-11-05T10:00:00.000Z", type, uuid: `${type}-${(serial += 1)}`, ...extra }) + "\n";
const typed = (text: string): string => base("user", { message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" } });
const reply = (text: string, effort = "xhigh"): string =>
  base("assistant", { effort, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], usage: { input_tokens: 10 } } });
/** A picture the user pasted: one user line of `bytes` of base64. */
const picture = (bytes: number): string =>
  base("user", { message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(bytes) } }] } });

/** About 3 MB of turns (2-6 KB lines), each answered. */
function history(turns = 600): string {
  let out = "";
  for (let i = 0; i < turns; i += 1) out += typed(`question ${i} ${"q".repeat(2_000)}`) + reply(`answer ${i} ${"a".repeat(3_000)}`);
  return out;
}

/** The user's messages after the picture, not answered yet (each its own turn). */
const unanswered = (count = 5): string => Array.from({ length: count }, (_, i) => typed(`and then ${i}`)).join("");

async function until(test: () => boolean, tries = 1_000): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (test()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return test();
}

interface Event {
  readonly paneId: string;
  readonly state: { readonly status: string };
  readonly settings?: { modelLabel: string | null; effort: string | null; scope: { terminalID: string; session: string | null } };
}

/** One Claude pane (p1, terminal t1) on a fake machine; its agent can exit and start again with the same session. */
async function machine(initial: string, shelf: { capacity?: number } = {}) {
  const { ChatService } = await import("../src/main/chat/service");
  let file = initial;
  let running = true;
  const reader = {
    locate: async () => path,
    size: async () => Buffer.byteLength(file),
    read: async (_path: string, offset: number, max: number): Promise<Uint8Array> => Buffer.from(file).subarray(offset, offset + max),
  };
  const backend = { transcripts: () => reader };
  const hosts = {
    backend: () => backend as never,
    pane: () => ({ paneID: "p1", terminalID: "t1", agent: running ? "claude" : "", agentStatus: "idle", cwd }) as never,
    agent: () =>
      (running ? { paneID: "p1", agent: "claude", agentStatus: "idle", cwd, agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: session } } : null) as never,
  };
  const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 }, {}, shelf);
  const events: Event[] = [];
  const owner = { id: 1, isDestroyed: () => false, send: (_channel: string, event: unknown) => events.push(event as Event) };
  return {
    service,
    events,
    owner,
    append: (text: string) => {
      file += text;
    },
    running: (on: boolean) => {
      running = on;
      service.refresh();
    },
    last: () => events.at(-1),
  };
}

const binding: SendBinding = { terminalID: "t1", isAgent: true, kind: "claude", session };

/** What the chips read for the pane from the service's last update (the renderer's own path). */
function chips(event: Event | undefined): { model: string; effort: string } {
  const picks = new AgentPicks({ send: async () => undefined, copy: () => undefined, now: () => 0 });
  picks.receive("mac/p1", (event?.settings ?? null) as never, null);
  return { model: picks.chip("mac/p1", "model", binding).label, effort: picks.chip("mac/p1", "effort", binding).label };
}

describe("the Model chip with a long line in the tail", () => {
  it("a picture longer than the first window, then a screenful of the user's messages: the model and effort still show", async () => {
    const m = await machine(history() + picture(1_200_000) + unanswered());
    try {
      m.service.open(m.owner, "mac", "p1");
      await until(() => m.last()?.state.status === "live" && m.last()?.settings?.modelLabel === "Opus 5.5");
      expect(m.last()?.state.status).toBe("live");
      expect(chips(m.last())).toEqual({ model: "Opus 5.5", effort: "Extra high" });
    } finally {
      m.service.closeAll();
    }
  });

  it("a line over the per-line bound in the tail: passed over, the model before it still shows", async () => {
    const m = await machine(history(300) + picture(maxLineBytes + 1_000_000) + unanswered());
    try {
      m.service.open(m.owner, "mac", "p1");
      await until(() => m.last()?.settings?.modelLabel === "Opus 5.5");
      expect(chips(m.last())).toEqual({ model: "Opus 5.5", effort: "Extra high" });
    } finally {
      m.service.closeAll();
    }
  });

  it("a new session with no reply yet: nothing to name, the chips say Default and Default", async () => {
    const m = await machine(unanswered(2));
    try {
      m.service.open(m.owner, "mac", "p1");
      await until(() => m.last()?.state.status === "live");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(chips(m.last())).toEqual({ model: "Default", effort: "Default" }); // The agent's default, never a bare "Model"
    } finally {
      m.service.closeAll();
    }
  });
});

describe("the Model chip after the agent starts again in the same pane", () => {
  it("the same session in the same terminal after an exit: the model and effort show again", async () => {
    // A shelf that keeps nothing: the feed the window let go is not there to take back (as when it was let go).
    const m = await machine(history(), { capacity: 0 });
    try {
      m.service.open(m.owner, "mac", "p1");
      await until(() => m.last()?.settings?.modelLabel === "Opus 5.5");
      expect(chips(m.last())).toEqual({ model: "Opus 5.5", effort: "Extra high" });
      // The user pastes a picture and sends a few lines, the agent exits, its shell shows, and it starts again
      // with `--resume <same session>` in the same terminal.
      m.append(picture(1_200_000) + unanswered(2));
      await new Promise((resolve) => setTimeout(resolve, 40));
      m.running(false);
      await until(() => m.last()?.state.status === "unavailable");
      m.append(unanswered(3));
      m.running(true);
      await until(() => m.last()?.state.status === "live" && m.last()?.settings?.modelLabel === "Opus 5.5");
      expect(m.last()?.settings?.scope).toEqual({ terminalID: "t1", session });
      expect(chips(m.last())).toEqual({ model: "Opus 5.5", effort: "Extra high" });
    } finally {
      m.service.closeAll();
    }
  });

  it("the kept feed taken back after the restart keeps its values", async () => {
    const m = await machine(history());
    try {
      m.service.open(m.owner, "mac", "p1");
      await until(() => m.last()?.settings?.modelLabel === "Opus 5.5");
      m.running(false);
      await until(() => m.last()?.state.status === "unavailable");
      m.append(picture(1_200_000) + unanswered());
      m.running(true);
      await until(() => m.last()?.state.status === "live" && m.last()?.settings?.modelLabel === "Opus 5.5");
      expect(chips(m.last())).toEqual({ model: "Opus 5.5", effort: "Extra high" });
    } finally {
      m.service.closeAll();
    }
  });
});

// The look-back never holds up Chat. It starts once the first load
// is done (loaded() resolved), beside the follow: a reply written while its read is out shows at the poll's
// cadence; one chunk, then on only while no model is known, within 24 MiB and its time budget.
describe("the look-back beside the follow", () => {
  interface Held {
    readonly offset: number;
    release(): void;
  }

  /** A feed on a fake transcript, through the chips' tap and hook as the service makes them. */
  async function feedOn(initial: string, options: { lookBackMs?: number; delayMs?: number } = {}) {
    const { ChatFeed, standardColdLoad, TranscriptNotFoundError } = await import("../src/shared/chat/feed");
    const { AgentSettingsReader, tapReader } = await import("../src/shared/agent-settings");
    let file = initial;
    const firstWindow = Math.max(0, Buffer.byteLength(initial) - standardColdLoad.window);
    const reads: { offset: number; max: number; at: number; afterLoad: boolean }[] = [];
    const held: Held[] = [];
    let hold = false;
    let loadedAt: number | null = null;
    let gone = false;
    const base = {
      locate: async () => path,
      size: async () => {
        if (gone) throw new TranscriptNotFoundError(path);
        return Buffer.byteLength(file);
      },
      read: async (_path: string, offset: number, max: number): Promise<Uint8Array> => {
        reads.push({ offset, max, at: Date.now(), afterLoad: loadedAt !== null });
        if (options.delayMs !== undefined && offset < firstWindow) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        // The bytes as they were when asked for (a replacement meanwhile does not change them).
        const bytes = Buffer.from(file).subarray(offset, offset + max);
        if (hold && offset < firstWindow) await new Promise<void>((resolve) => held.push({ offset, release: resolve }));
        return bytes;
      },
    };
    const settings = new AgentSettingsReader("claude");
    // What reaches the settings, as the service's handle publishes it: the tap's changes and the
    // look-back hook's, and the hook's lines with when they came.
    let changes = 0;
    const lines: { offset: number; at: number }[] = [];
    const tapped = tapReader(base, settings, () => {
      changes += 1;
    });
    const lookBack = {
      wants: () => settings.settings.modelLabel === null,
      line: (text: string, offset: number) => {
        lines.push({ offset, at: Date.now() });
        if (settings.line(text, offset)) changes += 1;
      },
    };
    const feed = new ChatFeed(tapped, {
      pollIntervalMs: 5,
      cold: standardColdLoad,
      lookBack,
      ...(options.lookBackMs === undefined ? {} : { lookBackMs: options.lookBackMs }),
    });
    const order: string[] = [];
    return {
      feed,
      settings,
      reads,
      held,
      order,
      firstWindow,
      /** Reads from before the first window: the look-back's (these files need no screenful read earlier). */
      lookBackReads: () => reads.filter((read) => read.offset < firstWindow),
      hold: (on: boolean) => {
        hold = on;
      },
      append: (text: string) => {
        file += text;
      },
      replace: (text: string) => {
        file = text;
      },
      /** The file is gone: the next size poll ends the follow (notFound). */
      remove: () => {
        gone = true;
      },
      changes: () => changes,
      lines,
      start: () => {
        feed.start({ format: "claude" } as never);
        void feed.loaded().then(() => {
          loadedAt = Date.now();
          order.push("loaded");
        });
      },
    };
  }

  const lastText = (feed: { timeline: { turns: readonly { items: readonly { type: string; value?: unknown }[] }[] } }): string | null => {
    const item = feed.timeline.turns.at(-1)?.items.at(-1);
    return item?.type === "agentText" ? (item.value as { markdown: string }).markdown : null;
  };

  /** Only the user's lines, about 30 MB: nothing names a model anywhere. */
  function noModel(): string {
    let out = "";
    while (out.length < 30 * 1_024 * 1_024) out += typed(`nothing named here ${"n".repeat(4_000)}`);
    return out;
  }

  it("loaded() resolves before the look-back's first read, and the 1.2 MB-line shape still fills the chip", async () => {
    const m = await feedOn(history() + picture(1_200_000) + unanswered());
    m.start();
    expect(await until(() => m.settings.settings.modelLabel === "Opus 5.5")).toBe(true);
    const first = m.lookBackReads()[0];
    expect(first?.afterLoad, JSON.stringify(m.reads.slice(0, 4))).toBe(true);
    expect(m.order).toEqual(["loaded"]);
    expect(m.settings.settings.effort).toBe("xhigh");
    m.feed.stop();
  });

  it("a reply written while the look-back's read is held shows at the poll's cadence; a live model ends the look-back", async () => {
    const m = await feedOn(history() + picture(1_200_000) + unanswered());
    m.hold(true);
    m.start();
    expect(await until(() => m.held.length === 1)).toBe(true);
    const written = Date.now();
    m.append(reply("Written while the look-back reads."));
    const shown = await until(() => lastText(m.feed) === "Written while the look-back reads.");
    expect(shown, "the reply shows while the look-back's read is held").toBe(true);
    expect(Date.now() - written).toBeLessThan(1_000);
    expect(m.settings.settings.modelLabel).toBe("Opus 5.5");
    // Its answer comes after a live line named the model: dropped, and no further read.
    m.held[0]!.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(m.lookBackReads()).toHaveLength(1);
    m.feed.stop();
  });

  it("a transcript that names no model: the look-back reads at most 24 MiB, and stops at its time budget", async () => {
    const { lookBackBytes } = await import("../src/shared/chat/feed");
    const m = await feedOn(noModel());
    m.start();
    await until(() => m.order.length === 1);
    let count = -1;
    await until(() => {
      const now = m.lookBackReads().length;
      if (now === count) return true;
      count = now;
      return false;
    }, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bytes = m.lookBackReads().reduce((sum, read) => sum + read.max, 0);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(lookBackBytes);
    expect(m.settings.settings.modelLabel).toBeNull();
    m.feed.stop();

    // Slow reads (80 ms each) and a 100 ms budget: a read or two, not the 24 MiB's twelve; a hard
    // deadline, no line of an answer that came after the 100 ms reaches the settings.
    const slow = await feedOn(noModel(), { lookBackMs: 100, delayMs: 80 });
    slow.start();
    await until(() => slow.order.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(slow.lookBackReads().length).toBeGreaterThan(0);
    expect(slow.lookBackReads().length).toBeLessThanOrEqual(2);
    const started = slow.lookBackReads()[0]!.at;
    expect(slow.lines.length, "the first answer, in time").toBeGreaterThan(0);
    expect(Math.max(...slow.lines.map((line) => line.at)) - started).toBeLessThanOrEqual(100 + 2);
    // The first window's live polls went on meanwhile.
    expect(slow.reads.filter((read) => read.offset >= slow.firstWindow).length).toBeGreaterThan(0);
    slow.feed.stop();
  }, 30_000);

  it("a pause holds the look-back; the resume reads on", async () => {
    // The user's 3 MB of lines before the picture: the look-back's first chunk names no model.
    let typedLines = "";
    while (typedLines.length < 3 * 1_024 * 1_024) typedLines += typed(`more typing ${"h".repeat(4_000)}`);
    const m = await feedOn(history(300) + typedLines + picture(1_200_000) + unanswered());
    m.hold(true);
    m.start();
    expect(await until(() => m.held.length === 1)).toBe(true);
    m.feed.pause();
    m.hold(false);
    m.held[0]!.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(m.lookBackReads()).toHaveLength(1);
    expect(m.settings.settings.modelLabel).toBeNull();
    m.feed.resume();
    expect(await until(() => m.settings.settings.modelLabel === "Opus 5.5")).toBe(true);
    m.feed.stop();
  });
});

// A look-back answer that is no longer wanted never
// reaches the settings; a follow that ends retires
// its look-back; the time budget is a hard ceiling on active time, a pause during a read stopping its clock.
describe("the look-back's answer, its end and its clock", () => {
  async function feedOn(initial: string, options: { lookBackMs?: number } = {}) {
    const { ChatFeed, standardColdLoad, TranscriptNotFoundError } = await import("../src/shared/chat/feed");
    const { AgentSettingsReader, tapReader } = await import("../src/shared/agent-settings");
    let file = initial;
    const firstWindow = Math.max(0, Buffer.byteLength(initial) - standardColdLoad.window);
    const reads: { offset: number; max: number }[] = [];
    const held: (() => void)[] = [];
    let hold = false;
    let gone = false;
    const base = {
      locate: async () => path,
      size: async () => {
        if (gone) throw new TranscriptNotFoundError(path);
        return Buffer.byteLength(file);
      },
      read: async (_path: string, offset: number, max: number): Promise<Uint8Array> => {
        const bytes = Buffer.from(file).subarray(offset, offset + max);
        if (offset < firstWindow) {
          reads.push({ offset, max });
          if (hold) await new Promise<void>((resolve) => held.push(resolve));
        }
        return bytes;
      },
    };
    const settings = new AgentSettingsReader("claude");
    let changes = 0;
    let lines = 0;
    const tapped = tapReader(base, settings, () => {
      changes += 1;
    });
    const lookBack = {
      wants: () => settings.settings.modelLabel === null,
      line: (text: string, offset: number) => {
        lines += 1;
        if (settings.line(text, offset)) changes += 1;
      },
    };
    const feed = new ChatFeed(tapped, {
      pollIntervalMs: 5,
      cold: standardColdLoad,
      lookBack,
      ...(options.lookBackMs === undefined ? {} : { lookBackMs: options.lookBackMs }),
    });
    return {
      feed,
      settings,
      /** The look-back's reads (from before the first window: these files need no screenful read earlier). */
      reads,
      held,
      /** Holds the look-back's next read only. */
      holdOne: async () => {
        hold = true;
        feed.start({ format: "claude" } as never);
        const ok = await until(() => held.length === 1, 5_000);
        hold = false;
        return ok;
      },
      release: () => {
        for (const resolve of held.splice(0)) resolve();
      },
      append: (text: string) => {
        file += text;
      },
      replace: (text: string) => {
        file = text;
      },
      remove: () => {
        gone = true;
      },
      changes: () => changes,
      lines: () => lines,
    };
  }

  const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Every field the chips and the ring read. */
  const fields = (s: { settings: object }): Record<string, unknown> => ({ ...s.settings });
  const shape = () => history() + picture(1_200_000) + unanswered();
  const userText = (feed: { timeline: { turns: readonly { items: readonly { type: string; value?: unknown }[] }[] } }): string | null => {
    const item = feed.timeline.turns.at(-1)?.items.find((entry) => entry.type === "user");
    return item === undefined ? null : (item.value as { text: string }).text;
  };
  /** Claude Code's /model result, as it writes it. */
  const modelCommand = (name: string): string =>
    base("user", { message: { role: "user", content: `<local-command-stdout>Set model to ${name}</local-command-stdout>` } });
  /** A live assistant line naming a model, with no effort and no usage. */
  const bareReply = (model: string): string => base("assistant", { message: { role: "assistant", model, content: [{ type: "text", text: "bare" }] } });

  it("a held answer released after a live /model line changes no settings field and publishes nothing", async () => {
    const m = await feedOn(shape());
    expect(await m.holdOne()).toBe(true);
    m.append(modelCommand("Sonnet"));
    expect(await until(() => m.settings.settings.modelLabel === "Sonnet")).toBe(true);
    const before = fields(m.settings);
    const changes = m.changes();
    m.release();
    await nap(100);
    expect(fields(m.settings)).toEqual(before);
    expect(m.settings.settings.effort).toBeNull();
    expect(m.settings.settings.used).toBeNull();
    expect(m.changes()).toBe(changes);
    expect(m.lines()).toBe(0);
    expect(m.reads).toHaveLength(1);
    m.feed.stop();
  });

  it("a held answer released after a live assistant line naming a model, no effort or usage, changes nothing", async () => {
    const m = await feedOn(shape());
    expect(await m.holdOne()).toBe(true);
    m.append(bareReply("claude-sonnet-5-5"));
    expect(await until(() => m.settings.settings.modelLabel === "Sonnet 5.5")).toBe(true);
    const before = fields(m.settings);
    const changes = m.changes();
    m.release();
    await nap(100);
    expect(fields(m.settings)).toEqual(before);
    expect(m.settings.settings.effort).toBeNull();
    expect(m.settings.settings.used).toBeNull();
    expect(m.settings.settings.window).toBe(before["window"]);
    expect(m.changes()).toBe(changes);
    expect(m.reads).toHaveLength(1);
    m.feed.stop();
  });

  it("a held answer released after the transcript was replaced changes nothing", async () => {
    const m = await feedOn(shape());
    expect(await m.holdOne()).toBe(true);
    m.replace(typed("replacement"));
    expect(await until(() => userText(m.feed) === "replacement")).toBe(true);
    await nap(20);
    const before = fields(m.settings);
    expect(before["modelLabel"]).toBeNull();
    const changes = m.changes();
    m.release();
    await nap(100);
    expect(fields(m.settings)).toEqual(before);
    expect(m.changes()).toBe(changes);
    expect(m.lines()).toBe(0);
    m.feed.stop();
  });

  it("a follow that ends (its file gone) retires its look-back: no further read, no settings change", async () => {
    let typedLines = "";
    while (typedLines.length < 8 * 1_024 * 1_024) typedLines += typed(`nothing named here ${"n".repeat(4_000)}`);
    const m = await feedOn(typedLines);
    expect(await m.holdOne()).toBe(true);
    m.remove();
    expect(await until(() => m.feed.state.status === "unavailable")).toBe(true);
    expect(m.feed.state).toEqual({ status: "unavailable", reason: "notFound" });
    expect(m.feed.timeline.turns).toHaveLength(0);
    const reads = m.reads.length;
    const before = fields(m.settings);
    const changes = m.changes();
    m.release();
    await nap(200);
    expect(m.reads.length).toBe(reads);
    expect(fields(m.settings)).toEqual(before);
    expect(m.changes()).toBe(changes);
    expect(m.lines()).toBe(0);
    m.feed.stop();
  });

  it("a 100 ms allowance and a read held 250 ms: its answer sets nothing", async () => {
    const m = await feedOn(shape(), { lookBackMs: 100 });
    expect(await m.holdOne()).toBe(true);
    await nap(250);
    m.release();
    await nap(100);
    expect(m.settings.settings.modelLabel).toBeNull();
    expect(m.settings.settings.effort).toBeNull();
    expect(m.lines()).toBe(0);
    expect(m.reads).toHaveLength(1);
    m.feed.stop();
  });

  it("a 300 ms allowance, a pause during the held read for 600 ms: the resume reads on and finds a model chunks back", async () => {
    let typedLines = "";
    while (typedLines.length < 3 * 1_024 * 1_024) typedLines += typed(`more typing ${"h".repeat(4_000)}`);
    const m = await feedOn(history(300) + typedLines + picture(1_200_000) + unanswered(), { lookBackMs: 300 });
    expect(await m.holdOne()).toBe(true);
    m.feed.pause();
    await nap(600);
    m.release();
    await nap(100);
    expect(m.settings.settings.modelLabel).toBeNull();
    m.feed.resume();
    expect(await until(() => m.settings.settings.modelLabel === "Opus 5.5", 2_000)).toBe(true);
    expect(m.reads.length).toBeGreaterThan(1);
    m.feed.stop();
  });
});
