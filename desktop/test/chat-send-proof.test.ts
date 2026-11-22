// What proves a send (the send rules 1 to 6), through the real send service (sendBound, its picture
// check, the receipt and the check the Send IPC answers with: sendWithReceipt, SendChecks), the page's bubble
// (sendWithPending, PendingMessages) and the composer store (sendDraft, composerDrafts), on a fake Claude pane
// with a virtual clock and a fake record (the session transcript's lines). No socket, no Herdr, no transcript on
// this machine.
//
// 1. For a Claude pane with a known session the proof is Claude Code's record; the screen only drives the
//    corrective Return and reads the queued hint.
// 2. Send empties the composer at the Return: the text and every picture chip.
// 3. Nothing proved: nothing comes back, nothing alarming; after the bound the bubble says Adari could not confirm
//    it, with Show the terminal and Put back (only on that press).
// 4. A failure before the write still restores at once, with its note.
// 5. Still in the box after the one corrective Return: the bubble says so, with Show the terminal; never put back.
// 6. The app never types a message again by itself.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaudeBoxSite } from "../src/main/herdr/claude-box";
import { SendChecks, sendBound, sendWithReceipt, type SendSite } from "../src/main/herdr/send";
import { APIError } from "../src/main/herdr/wire";
import type { QueueRecord } from "../src/shared/claude-queue-record";
import { claudeBoxTexts, sendProofBoundMs } from "../src/shared/claude-screen";
import { inBoxLabel, notConfirmedLabel, pendingLabel } from "../src/shared/chat/pending";
import { claudeScreen } from "./support/claude-screens";
import { queueLine, userLine } from "./support/claude-queue-screens";
import { claudeReply, claudeUser } from "./support/esc-queue-lines";
import { timelineOf } from "./support/chat-lines";
import { checkHerdrKeys } from "./support/herdr-keys";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { PendingBubble } = await import("../src/renderer/chat/ChatView");
const { composerDrafts, draftKey, sendDraft } = await import("../src/renderer/components/composer-drafts");
const { pendingMessages, sendWithPending } = await import("../src/renderer/chat/chat-state");
const { putTakenBack } = await import("../src/renderer/chat/take-back");

const folder = "/Users/fixture/.adari-attachments-0123456789abcdef0123456789abcdef/";
const pictures = [1, 2, 3, 4].map((n) => `${folder}attachment-${String(n).repeat(8)}-1111-1111-1111-111111111111.png`);
const caption = "found this on X";
/** What the composer sends with `count` pictures (joinedMessage): the text, a space, then each path. */
const message = (count: number): string => `${caption} ${pictures.slice(0, count).join(" ")}`;
/** Claude's box once `count` pictures are in: the chips first, then the caption. */
const chipsBox = (count: number): string => `${Array.from({ length: count }, (_, i) => `[Image #${i + 1}]`).join(" ")}${caption}`;
const expected = { terminalID: "t1", isAgent: true, kind: "claude", session: "s1" };
const host = "proof-host";
const key = draftKey(host, "p1");
const scope = { terminalID: "t1", session: "s1" };
/** Claude Code's record lines for the pane's session ("s1"): only a line of the send's own session counts. */
const ownQueueLine = (content: string): string => queueLine("enqueue", { content, sessionId: "s1" });
const ownUserLine = (text: string): string => JSON.stringify({ ...(JSON.parse(userLine(text)) as object), sessionId: "s1" });
/** The page's clock: the send at 10:00:00 (the transcript's times are near it). */
const pageNow = Date.parse("2026-11-20T10:00:00.000Z");

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function until(what: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !what(); i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(what()).toBe(true);
}

/**
 * A Claude Code pane on a virtual clock: the box drawn per read (`draft`, the working line by `status`), keys and
 * prompts logged, the record's lines each written at its time on the clock. `gate` holds the first wait after the
 * prompt (the check is still running), so a test sees the composer at the Return.
 */
class Pane {
  clock = 0;
  status: "idle" | "working" = "idle";
  draft = "";
  prompted = false;
  due = false;
  gate: Promise<void> | null = null;
  refuse: Error | null = null;
  /** A Return the box takes (it empties); false: the Return is lost and the box keeps it. */
  takesReturn = false;
  recordReads = 0;
  /** The session Herdr names for the pane (null: none named). */
  session: string | null = "s1";
  readonly prompts: string[] = [];
  readonly keys: string[][] = [];
  readonly lines: { readonly at: number; readonly line: string }[] = [];
  readonly recorded: string[] = [];
  readonly stuck: string[] = [];
  /** What Claude's box shows after a prompt of `text` (the typed text, chips, or nothing). */
  intake: (text: string) => string = () => "";

  private visible(): string[] {
    return this.lines.filter((entry) => entry.at <= this.clock).map((entry) => entry.line);
  }

  readonly record: QueueRecord = {
    end: async () => this.visible().length,
    since: async (from) => {
      this.recordReads += 1;
      return this.visible().slice(from);
    },
  };

  readonly screen: ClaudeBoxSite = {
    now: () => this.clock,
    wait: async (ms) => {
      if (this.gate !== null && this.prompted) {
        const gate = this.gate;
        this.gate = null;
        await gate;
      }
      this.clock += ms;
    },
    read: async () => claudeScreen({ draft: this.draft, working: this.status === "working" }),
    keys: async (keys) => {
      checkHerdrKeys(keys);
      this.keys.push([...keys]);
      if (keys.includes("ctrl+u")) this.draft = "";
      if (keys.includes("Enter") && this.takesReturn) {
        this.draft = "";
        this.status = "working";
      }
    },
  };

  readonly site: SendSite = {
    writer: {
      prompt: async (_pane, text) => {
        if (this.refuse !== null) throw this.refuse;
        this.prompted = true;
        this.prompts.push(text);
        this.draft = this.intake(text);
      },
      sendInput: async () => undefined,
      sendText: async () => undefined,
      agentKeys: async (_pane, keys) => void this.keys.push([...keys]),
    },
    fresh: async () => true,
    pane: () => ({ paneID: "p1", terminalID: "t1", agent: "claude", agentStatus: this.status }) as never,
    agent: () =>
      ({
        paneID: "p1",
        terminalID: "t1",
        agent: "claude",
        agentStatus: this.status,
        ...(this.session === null ? {} : { agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: this.session } }),
        turnEpoch: 7,
      }) as never,
    run: () => ({ connection: 1, arrival: 1 }),
    inputGeneration: () => 0,
    box: {
      site: this.screen,
      own: () => this.recorded,
      sent: (text) => void this.recorded.push(text),
      due: () => this.due,
      checked: () => {
        this.due = false;
      },
      failed: () => {
        this.due = true;
      },
      machine: () => true,
      marks: () => 0,
      // As main opens it (ipc.ts queueRecordOf): none for a pane with no session named.
      record: (session) => (session === null ? undefined : this.record),
      stuck: () => this.stuck,
      markStuck: (text) => void this.stuck.push(text),
    },
  };
}

const checks = new SendChecks();

/** The page's Send of the composer's draft, as MainPane makes it: the bridge's receipt, then the check by its id. */
function press(pane: Pane, wait: (ms: number) => Promise<void> = async () => undefined): Promise<void> {
  const bound = { ...expected, session: pane.session };
  const shown = { ...scope, session: pane.session };
  let going: Promise<void> | null = null;
  const bridge = (_h: string, p: string, text: string) => sendWithReceipt(checks, (follow) => sendBound({ ...pane.site, ...follow }, p, text, bound));
  const started = sendDraft(
    composerDrafts,
    (h, p, t) => (going = sendWithPending(bridge, h, p, t, true, shown, () => pageNow, false, { check: (id) => checks.take(id), wait })),
    host,
    "p1",
    null,
  );
  expect(started).toBe(true);
  return (going as unknown as Promise<void>).catch(() => undefined);
}

/** The composer holds the caption and `count` uploaded pictures. */
function compose(count: number): void {
  composerDrafts.restore(key, caption, pictures.slice(0, count).map((path, i) => ({ path, name: `Picture ${i + 1}`, image: true })), []);
}

const draftNow = () => {
  const draft = composerDrafts.get(key);
  return { text: draft.text, chips: draft.chips.length, error: draft.error ?? null };
};
const states = (): string[] => pendingMessages.forPane(key).map((bubble) => bubble.state);
const texts = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => {
    const children = element.props["children"];
    return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string");
  });
const buttons = (tree: unknown) => elements(tree).filter((element) => element.type === "button");

/** Chat follows the pane's live transcript: what it shows is each send's baseline. */
const earlier = [claudeUser("u-0", null, "earlier", "2026-11-20T09:59:00.000Z", { promptSource: "typed" }), claudeReply("a-0", "u-0", "ok", "2026-11-20T09:59:05.000Z")];

beforeEach(() => {
  pendingMessages.clear();
  composerDrafts.clear();
  pendingMessages.observe(key, timelineOf(earlier).timeline);
});

describe("the screenshot's case: a picture message while Claude works, the screen never proves it, the record does 8 s later", () => {
  it("the composer is empty from the Return on, no note, the record settles the bubble, and the transcript's message takes its place", async () => {
    const pane = new Pane();
    pane.status = "working";
    // Claude queues it: the box empty, the working line of the turn already running, no queued hint drawn.
    pane.lines.push({ at: 8_000, line: ownQueueLine(message(1)) });
    const gate = deferred();
    pane.gate = gate.promise;
    compose(1);
    await press(pane);
    // The keys and the Return went: the composer is empty while the check still runs.
    expect(pane.prompts).toEqual([message(1)]);
    expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
    expect(states()).toEqual(["sending"]);
    gate.resolve();
    await until(() => states()[0] === "sent");
    expect(pane.clock).toBeGreaterThanOrEqual(8_000);
    expect(pendingLabel(pendingMessages.forPane(key)[0]!, true, pageNow)).toBe("Queued");
    // No "did not confirm" line, nothing put back, no corrective Return, no second copy.
    expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
    expect(pane.keys).toEqual([]);
    expect(pane.prompts).toHaveLength(1);
    // Claude takes it as its next prompt: the transcript has it, and the bubble settles into it.
    pendingMessages.observe(key, timelineOf([...earlier, claudeUser("u-1", "a-0", message(1), "2026-11-20T10:00:20.000Z", { promptSource: "typed" })]).timeline);
    expect(pendingMessages.forPane(key)).toEqual([]);
  });

  it("the record's word comes before the screen's end: taken at once, no corrective Return", async () => {
    const pane = new Pane();
    pane.lines.push({ at: 1_000, line: ownUserLine(message(1)) });
    compose(1);
    await press(pane);
    await until(() => states()[0] === "sent");
    expect(pane.keys).toEqual([]);
    expect(pane.clock).toBeLessThan(3_000);
    // The record is read no more often than once a second beside the screen.
    expect(pane.recordReads).toBeLessThanOrEqual(Math.ceil(pane.clock / 1_000) + 1);
  });
});

describe("no record ever: after the bound the bubble says so, with its two actions", () => {
  it("sending until the bound, then one plain line, Show the terminal and Put back; nothing restored until Put back is pressed", async () => {
    const pane = new Pane();
    compose(3);
    const waits: number[] = [];
    const bound = deferred();
    await press(pane, (ms) => {
      waits.push(ms);
      return bound.promise;
    });
    expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
    // The page's bound runs from the receipt; main read the record to the bound (on its clock) and it never showed
    // the message.
    await until(() => waits.length === 1);
    expect(waits).toEqual([sendProofBoundMs]);
    await until(() => pane.clock >= sendProofBoundMs - 1_000);
    expect(states()).toEqual(["sending"]);
    expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
    bound.resolve();
    await until(() => states()[0] === "unconfirmed");
    let shown = 0;
    const bubble = pendingMessages.forPane(key)[0]!;
    const ui = new HookHost(PendingBubble as (props: object) => unknown, { message: bubble, working: false, now: pageNow, onMenu: () => undefined, onShowTerminal: () => void shown++ });
    ui.render();
    expect(texts(ui.tree)).toContain(notConfirmedLabel);
    expect(buttons(ui.tree).map((button) => button.props["children"])).toEqual(["Show the terminal", "Put back", "Dismiss"]);
    (buttons(ui.tree)[0]!.props["onClick"] as () => void)();
    expect(shown).toBe(1);
    expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
    // Put back: the person's own act: the text and the three pictures, as chips.
    (buttons(ui.tree)[1]!.props["onClick"] as () => void)();
    expect(draftNow()).toEqual({ text: caption, chips: 3, error: null });
    expect(composerDrafts.get(key).chips.map((chip) => (chip.state.kind === "uploaded" ? chip.state.path : null))).toEqual(pictures.slice(0, 3));
    expect(pendingMessages.forPane(key)).toEqual([]);
    // Never typed again by the app.
    expect(pane.prompts).toHaveLength(1);
  });

  it("the transcript shows it after the bound: the bubble settles all the same", async () => {
    const pane = new Pane();
    compose(1);
    await press(pane);
    await until(() => states()[0] === "unconfirmed");
    pendingMessages.observe(key, timelineOf([...earlier, claudeUser("u-1", "a-0", message(1), "2026-11-20T10:00:40.000Z", { promptSource: "typed" })]).timeline);
    expect(pendingMessages.forPane(key)).toEqual([]);
  });
});

describe("a failure before the write still restores at once (rule 4)", () => {
  it("Herdr refused the prompt: the text and the pictures back with the note, no bubble", async () => {
    const pane = new Pane();
    pane.refuse = new APIError("pane_not_found", "no such pane");
    compose(3);
    await press(pane);
    const now = draftNow();
    expect(now.text).toBe(caption);
    expect(now.chips).toBe(3);
    expect(now.error).toMatch(/^Not sent: /);
    expect(pendingMessages.forPane(key)).toEqual([]);
    expect(pane.prompts).toEqual([]);
  });
});

describe("still in the box after the corrective Return (rule 5)", () => {
  it("the bubble says so with Show the terminal, nothing is put back, another message is refused while it is there, and the same words sent again replace it", async () => {
    const pane = new Pane();
    pane.intake = () => chipsBox(1);
    compose(1);
    await press(pane);
    await until(() => states()[0] === "inBox");
    // One corrective Return went; the box still holds it.
    expect(pane.keys.filter((keys) => keys.includes("Enter"))).toHaveLength(1);
    expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
    const ui = new HookHost(PendingBubble as (props: object) => unknown, { message: pendingMessages.forPane(key)[0]!, working: false, now: pageNow, onMenu: () => undefined, onShowTerminal: () => undefined });
    ui.render();
    expect(texts(ui.tree)).toContain(inBoxLabel);
    expect(buttons(ui.tree).map((button) => button.props["children"])).toEqual(["Show the terminal", "Dismiss"]);
    // Another message would join it in Claude's box: refused with a plain line, kept in the composer.
    composerDrafts.edit(key, "something else");
    await press(pane);
    expect(draftNow()).toEqual({ text: "something else", chips: 0, error: claudeBoxTexts.stuckNotSent });
    expect(pane.prompts).toEqual([message(1)]);
    expect(pane.draft).toBe(chipsBox(1));
    // The person sends the same words again (their own act): the copy in the box is cleared first, then it goes.
    composerDrafts.edit(key, "");
    putTakenBack(composerDrafts, () => undefined, key, [message(1)]);
    pane.takesReturn = true;
    await press(pane);
    expect(pane.prompts).toEqual([message(1), message(1)]);
    expect(pane.keys.findIndex((keys) => keys.includes("ctrl+u"))).toBeGreaterThan(0);
  });
});

describe("the chips leave at the Return (rule 2)", () => {
  for (const count of [1, 3, 4]) {
    it(`${count} picture${count === 1 ? "" : "s"}: the composer is empty while the check still runs`, async () => {
      const pane = new Pane();
      pane.intake = () => chipsBox(count);
      pane.takesReturn = true;
      // Claude Code's record shows it once the corrective Return went (the screen alone settles nothing).
      pane.lines.push({ at: 4_000, line: ownUserLine(message(count)) });
      const gate = deferred();
      pane.gate = gate.promise;
      compose(count);
      expect(draftNow().chips).toBe(count);
      await press(pane);
      expect(pane.prompts).toEqual([message(count)]);
      expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
      expect(states()).toEqual(["sending"]);
      gate.resolve();
      await until(() => states()[0] === "sent");
      expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
    });
  }
});

describe("a Claude pane with no session named: the same check after the Return, no record (rule 7, rules 2, 3 and 5 are its own)", () => {
  // No session, so no transcript Chat follows.
  beforeEach(() => pendingMessages.unfollow(key));

  it("the composer empties at the Return; the screen never proves it: no record is read, nothing comes back, the bubble says so after the bound", async () => {
    const pane = new Pane();
    pane.session = null;
    compose(1);
    const waits: number[] = [];
    await press(pane, async (ms) => void waits.push(ms));
    expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
    await until(() => states()[0] === "unconfirmed");
    expect(pane.recordReads).toBe(0);
    expect(waits).toHaveLength(1);
    expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
    expect(pane.prompts).toHaveLength(1);
  });

  it("the screen proves it: Sent to the terminal, as for any send with no session", async () => {
    const pane = new Pane();
    pane.session = null;
    pane.intake = () => chipsBox(1);
    pane.takesReturn = true;
    compose(1);
    await press(pane);
    await until(() => states()[0] === "terminalOnly");
    expect(draftNow()).toEqual({ text: "", chips: 0, error: null });
  });
});
