// A Mac Chat send with pictures must not say Sent while the message sits in
// Claude's box (the Mac twin of the iPhone's image send). A three-picture send
// can sit in Claude's box (`[Image #18] [Image #19] [Image #20]found this on X`)
// after Herdr's `agent.prompt` returns, so Sent needs a read after it, a chip
// match and, when due, one corrective Return.
//
// The same cases as the phone's (Tests/HerdrKitTests/ClaudeImage*Tests.swift,
// Tests/HerdrCompanionTests/CompanionImgSend*Tests.swift): Claude Code takes
// in each picture whose path the prompt carries and draws its chip first,
// then the text (its own layout), and a Return that lands before the last
// chip is lost. One Return goes only once the box shows exactly our text with
// a new chip for every picture, Claude idle, the run the one we sent to (and
// known), checked right before the key; Sent only on positive evidence; any
// other box is unconfirmed, the composer keeping the text and the pictures.
//
// They use sendBound and the composer's drafts. Fakes only: no SSH, no Herdr,
// no socket; the pane's clock is virtual.

import { describe, expect, it } from "vitest";

import { type ClaudeBoxSite } from "../src/main/herdr/claude-box";
import { guardTexts, sendBound, takerName, type SendSite } from "../src/main/herdr/send";
import { ComposerDrafts, draftKey, sendDraft } from "../src/renderer/components/composer-drafts";
import { pendingMessages, sendWithPending } from "../src/renderer/chat/chat-state";
import { claudeScreen } from "./support/claude-screens";
import { checkHerdrKeys } from "./support/herdr-keys";

const folder = "/Users/fixture/.adari-attachments-0123456789abcdef0123456789abcdef/";
const pictures = [
  `${folder}attachment-11111111-1111-1111-1111-111111111111.png`,
  `${folder}attachment-22222222-2222-2222-2222-222222222222.png`,
  `${folder}attachment-33333333-3333-3333-3333-333333333333.jpg`,
];
const caption = "found this on X";
/** What the composer sends (joinedMessage): the text, a space, then each picture's path. */
const sent = `${caption} ${pictures.join(" ")}`;
/** Claude's box once the three pictures are in (chips first, then the caption). */
const threePicturesBox = "[Image #18] [Image #19] [Image #20]found this on X";
/** Two of the three pictures in, no path left: the third is missing. */
const twoChips = `[Image #18] [Image #19]${caption}`;
/** Every picture in, the caption edited. */
const otherCaption = "[Image #18] [Image #19] [Image #20]a changed caption";
/** An earlier message's box: the same caption, three earlier chips. */
const earlier = `[Image #1] [Image #2] [Image #3]${caption}`;

const claudeBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: "s1" };
const unconfirmed = guardTexts.returnUnconfirmed(takerName("claude"));

/** What Claude's box shows at a read: its text, the working line, queued messages (or a raw screen). */
type Box = { readonly draft: string; readonly working?: boolean; readonly queued?: readonly string[] } | { readonly raw: string };

/** The image paths of `text` as the composer appends them (test-side; the product's own reader is under test). */
const pathsIn = (text: string): string[] => text.split(/\s+/).filter((word) => word.startsWith("/") && /\.(png|jpe?g|gif|webp)$/i.test(word));

/**
 * A Claude Code pane on a virtual clock (milliseconds): every wait moves it, every read costs `readCost` (or
 * `costOf(read)`). `draw` gives the box at each read; `takes` says whether a Return now submits it. Every write
 * is logged; `onRead[i]` and `onFresh[i]` run as read i (all reads counted) or fresh check i answers, so a test
 * can change the pane between a read and the next key.
 */
class ClaudePane {
  clock = 0;
  promptAt: number | null = null;
  submitted = false;
  reads = 0;
  readsAfterPrompt = 0;
  readCost = 0;
  costOf: ((read: number) => number) | null = null;
  /** Extra time a wait after the prompt takes (index: waits after the prompt), to cross a bound. */
  waitExtra: Record<number, number> = {};
  private waitsAfterPrompt = 0;
  status = "idle";
  epoch: number | null = 7;
  arrival = 1;
  connection = 3;
  terminalID = "t1";
  inputs = 0;
  marks = 0;
  failed = 0;
  freshCalls = 0;
  readonly prompts: string[] = [];
  readonly returns: number[] = [];
  readonly keyLog: string[][] = [];
  readonly writerKeys: string[][] = [];
  readonly pasted: string[] = [];
  readonly recorded: string[] = [];
  onRead: Record<number, (pane: ClaudePane) => void> = {};
  onFresh: Record<number, (pane: ClaudePane) => void> = {};
  takes: (pane: ClaudePane) => boolean = () => false;

  constructor(public draw: (pane: ClaudePane) => Box) {}

  /** Milliseconds since the prompt (-1 before it). */
  get since(): number {
    return this.promptAt === null ? -1 : this.clock - this.promptAt;
  }

  screen(): string {
    const box = this.draw(this);
    if ("raw" in box) return box.raw;
    return claudeScreen({ draft: box.draft, working: box.working ?? false, queued: box.queued ?? [] });
  }

  readonly box: ClaudeBoxSite & { now(): number } = {
    read: async () => {
      const index = this.reads;
      this.reads += 1;
      if (this.promptAt !== null) this.readsAfterPrompt += 1;
      this.clock += this.costOf?.(index) ?? this.readCost;
      this.onRead[index]?.(this);
      return this.screen();
    },
    keys: async (keys) => {
      checkHerdrKeys(keys);
      this.keyLog.push([...keys]);
      if (keys.includes("Enter")) {
        this.returns.push(this.since);
        if (this.takes(this)) this.submitted = true;
      }
    },
    wait: async (ms) => {
      this.clock += ms;
      if (this.promptAt !== null) {
        this.clock += this.waitExtra[this.waitsAfterPrompt] ?? 0;
        this.waitsAfterPrompt += 1;
      }
    },
    now: () => this.clock,
  };

  readonly site: SendSite = {
    writer: {
      prompt: async (_pane, text) => {
        this.prompts.push(text);
        this.promptAt = this.clock;
      },
      sendInput: async () => undefined,
      sendText: async (_pane, text) => void this.pasted.push(text),
      agentKeys: async (_pane, keys) => void this.writerKeys.push([...keys]),
    },
    fresh: async () => {
      const call = this.freshCalls;
      this.freshCalls += 1;
      this.onFresh[call]?.(this);
      return true;
    },
    pane: () => ({ paneID: "w1:p1", terminalID: this.terminalID, workspaceID: "w1", tabID: "w1:t1", focused: false, agent: this.kind, agentStatus: this.status, revision: 1 }) as never,
    agent: () =>
      ({
        paneID: "w1:p1",
        agent: this.kind,
        agentStatus: this.status,
        terminalID: this.terminalID,
        agentSession: { source: `herdr:${this.kind}`, agent: this.kind, kind: "id", value: "s1" },
        ...(this.epoch === null ? {} : { turnEpoch: this.epoch }),
      }) as never,
    run: () => ({ connection: this.connection, arrival: this.arrival }),
    inputGeneration: () => this.inputs,
    box: {
      site: this.box,
      own: () => [],
      sent: (text) => void this.recorded.push(text),
      marks: () => this.marks,
      // The relay's events are live and nothing marked the pane: no read before the send.
      due: () => false,
      checked: () => undefined,
      failed: () => {
        this.failed += 1;
        this.marks += 1;
      },
    },
  };

  kind = "claude";
}

/**
 * Claude Code taking in `text`'s pictures (the iPhone tests' Intake): picture k shows its chip at `shows[k]` ms after
 * the prompt (null: never, and none after it). Before the first, the box shows the message as typed (`asTyped`)
 * or nothing. `chipsFirst` (Claude Code's, as in the three-picture box): the chips first, from `[Image #18]`, then the text with
 * the paths still to come; `inPlace`: each chip where its path was. A Return once every chip shows submits it
 * (the box empties and Claude works); one before is lost, as Herdr's own after the prompt is.
 */
function intake(shows: readonly (number | null)[], options: { asTyped?: boolean; layout?: "chipsFirst" | "inPlace"; text?: string } = {}): ClaudePane {
  const text = options.text ?? sent;
  const paths = pathsIn(text);
  const shown = (at: number): number => {
    let count = 0;
    for (const show of shows) {
      if (show === null || show > at) break;
      count += 1;
    }
    return count;
  };
  const pane = new ClaudePane((p) => {
    if (p.promptAt === null) return { draft: "" };
    if (p.submitted) return { draft: "", working: true };
    const count = shown(p.since);
    if (count === 0) return { draft: options.asTyped === true ? text : "" };
    const chips = Array.from({ length: count }, (_, index) => `[Image #${18 + index}]`);
    const words = text.split(" ");
    if ((options.layout ?? "chipsFirst") === "chipsFirst") {
      const taken = new Set(paths.slice(0, count));
      return { draft: chips.join(" ") + words.filter((word) => !taken.has(word)).join(" ") };
    }
    let next = 0;
    return {
      draft: words
        .map((word) => {
          if (next >= count || !paths.includes(word)) return word;
          next += 1;
          return chips[next - 1]!;
        })
        .join(" "),
    };
  });
  pane.takes = (p) => shown(p.since) === shows.length && !shows.includes(null);
  return pane;
}

const outcome = (sending: Promise<void>): Promise<string> =>
  sending.then(
    () => "sent",
    (error: Error) => error.message,
  );

const send = (pane: ClaudePane, text = sent, binding = claudeBinding): Promise<string> => outcome(sendBound(pane.site, "w1:p1", text, binding));

// MARK: - Three pictures

describe("three pictures, Claude idle: one Return once every picture is in, then Sent", () => {
  it("chips first, the box empty while they go in: one Return after the third new chip, Sent", async () => {
    const pane = intake([500, 1_000, 1_500]);
    expect(await send(pane)).toBe("sent");
    expect(pane.prompts).toEqual([sent]);
    expect(pane.keyLog).toEqual([["Enter"]]);
    expect(pane.returns[0]).toBeGreaterThanOrEqual(1_500);
    expect(pane.submitted).toBe(true);
  });

  it("taken in slowly, the message as typed first: one Return only once the last chip shows, Sent", async () => {
    const pane = intake([750, 1_500, 2_250], { asTyped: true });
    expect(await send(pane)).toBe("sent");
    expect(pane.keyLog).toEqual([["Enter"]]);
    expect(pane.returns[0]).toBeGreaterThanOrEqual(2_250);
    expect(pane.submitted).toBe(true);
  });

  it("a first picture slower than a 3 s wait: the wait is sized for the pictures, one Return after the last chip", async () => {
    const pane = intake([3_250, 3_750, 4_250], { asTyped: true });
    expect(await send(pane)).toBe("sent");
    expect(pane.keyLog).toEqual([["Enter"]]);
    expect(pane.returns[0]).toBeGreaterThanOrEqual(4_250);
    expect(pane.submitted).toBe(true);
  });

  it("chips in place, two pictures: no Return while the second is still going in", async () => {
    const text = `${caption} ${pictures[0]} ${pictures[1]}`;
    const pane = intake([250, 2_000], { asTyped: true, layout: "inPlace", text });
    expect(await send(pane, text)).toBe("sent");
    expect(pane.keyLog).toEqual([["Enter"]]);
    expect(pane.returns[0]).toBeGreaterThanOrEqual(2_000);
  });

  it("new chips after an earlier chip set with the same caption: one Return on the new ones", async () => {
    const pane = new ClaudePane((p) => {
      if (p.submitted) return { draft: "", working: true };
      if (p.promptAt === null || p.readsAfterPrompt <= 4) return { draft: earlier };
      return { draft: `[Image #4] [Image #5] [Image #6]${caption}` };
    });
    pane.takes = () => true;
    expect(await send(pane)).toBe("sent");
    expect(pane.keyLog).toEqual([["Enter"]]);
    expect(pane.readsAfterPrompt).toBe(6);
  });
});

// MARK: - not Sent: no key, the message kept

describe("a box that is not exactly ours: no key, unconfirmed", () => {
  it("an earlier chip set with the same caption and count: never the Return, read to the end", async () => {
    const pane = new ClaudePane(() => ({ draft: earlier }));
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
    expect(pane.readsAfterPrompt).toBe(36);
    expect(pane.failed).toBe(1);
  });

  it("a picture missing from the first read (two chips for three): no key, unconfirmed", async () => {
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : twoChips }));
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("seen as typed, then a picture missing: no key, unconfirmed", async () => {
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : p.readsAfterPrompt <= 1 ? sent : twoChips }));
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("seen as typed, then every chip with a changed caption: no key, unconfirmed", async () => {
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : p.readsAfterPrompt <= 1 ? sent : otherCaption }));
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("the user's typing alone in the box, Claude idle throughout: no key, unconfirmed", async () => {
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : "run the tests again" }));
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("the user's typing joined to ours: no key, unconfirmed", async () => {
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : `[Image #18] [Image #19] [Image #20]run the tests again${caption}` }));
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("the third picture never goes in: no Return, unconfirmed", async () => {
    const pane = intake([500, 1_000, null], { asTyped: true });
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
    expect(pane.submitted).toBe(false);
  });

  it("an edit after the Return (the chips with another caption): one Return, never a second, unconfirmed", async () => {
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : p.returns.length === 0 ? threePicturesBox : otherCaption }));
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([["Enter"]]);
  });

  it("the Return lost (the box still ours after it): one Return, never a second, unconfirmed", async () => {
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : threePicturesBox }));
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([["Enter"]]);
    expect(pane.recorded).toEqual([sent]);
  });
});

// MARK: - the run and the pane, bound

describe("the Return goes only to the run the prompt went to, checked right before the key", () => {
  it("Terminal input during the wait: no key, unconfirmed", async () => {
    const pane = intake([500, 1_000, 1_500]);
    pane.onRead = { 2: (p) => void (p.inputs += 1) };
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("an Esc during the wait (a box mark): no key, unconfirmed", async () => {
    const pane = intake([500, 1_000, 1_500]);
    pane.onRead = { 3: (p) => void (p.marks += 1) };
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("a new run behind the pane during the wait (turn_epoch): no key, unconfirmed", async () => {
    const pane = intake([500, 1_000, 1_500]);
    pane.onRead = { 2: (p) => void (p.epoch = 8) };
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("another agent in the pane during the wait (its arrival): no key, unconfirmed", async () => {
    const pane = intake([500, 1_000, 1_500]);
    pane.onRead = { 4: (p) => void (p.arrival = 2) };
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("no run id for the pane (no turn_epoch): the settled box gets no key, unconfirmed", async () => {
    const pane = intake([500, 1_000, 1_500]);
    pane.epoch = null;
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
    expect(pane.submitted).toBe(false);
  });

  it("a new run shown by the fresh check right before the key: no key, unconfirmed", async () => {
    const pane = intake([500, 1_000, 1_500]);
    // Fresh check 0 is the Send's own before its write; 1 is the one right before the Return.
    pane.onFresh = { 1: (p) => void (p.epoch = 8) };
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("Terminal input landing during that last check: no key, unconfirmed", async () => {
    const pane = intake([500, 1_000, 1_500]);
    pane.onFresh = { 1: (p) => void (p.inputs += 1) };
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });
});

// MARK: - what says Sent

describe("Sent only on positive evidence", () => {
  it("Claude going from idle to working with the box empty: Sent, no key", async () => {
    const pane = new ClaudePane((p) => (p.promptAt === null ? { draft: "" } : { draft: "", working: true }));
    expect(await send(pane)).toBe("sent");
    expect(pane.keyLog).toEqual([]);
  });

  it("this prompt's queued hint (not there before the write), Claude working before: Sent, no key", async () => {
    const pane = new ClaudePane((p) => (p.promptAt === null ? { draft: "", working: true } : { draft: "", working: true, queued: [threePicturesBox] }));
    pane.status = "working";
    expect(await send(pane)).toBe("sent");
    expect(pane.keyLog).toEqual([]);
  });

  it("a queued hint already there before the write is not this prompt's: unconfirmed, no key", async () => {
    const pane = new ClaudePane(() => ({ draft: "", working: true, queued: ["an earlier one"] }));
    pane.status = "working";
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("Claude working before, only that turn's working line after: unconfirmed, no key", async () => {
    const pane = new ClaudePane(() => ({ draft: "", working: true }));
    pane.status = "working";
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
  });

  it("the box emptied by the one Return: Sent", async () => {
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null || p.returns.length > 0 ? "" : threePicturesBox }));
    expect(await send(pane)).toBe("sent");
    expect(pane.keyLog).toEqual([["Enter"]]);
  });
});

// MARK: - on a clock

describe("the wait ends on the clock, so Sending… ends", () => {
  it("slow reads (2 s each) and a box that never settles: no read past 12 s, no Return, unconfirmed", async () => {
    const pane = intake([500, 1_000, null], { asTyped: true });
    pane.readCost = 2_000;
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([]);
    // Reads start 0.25, 2.5, 4.75, 7, 9.25 and 11.5 s after the prompt; the next wait would start past 12 s.
    expect(pane.readsAfterPrompt).toBe(6);
    expect(pane.since).toBeLessThanOrEqual(12_000 + 2_000);
  });

  it("slow reads still get the Return once every picture is in, then Sent", async () => {
    const pane = intake([500, 1_000, 2_000]);
    pane.readCost = 1_000;
    expect(await send(pane)).toBe("sent");
    expect(pane.keyLog).toEqual([["Enter"]]);
  });

  it("the first wait crossing the bound: no read after it, no key, unconfirmed", async () => {
    const pane = intake([500, 1_000, 1_500]);
    pane.waitExtra = { 0: 12_100 };
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.readsAfterPrompt).toBe(0);
    expect(pane.keyLog).toEqual([]);
  });

  it("a later wait crossing the bound: no read after it", async () => {
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : sent }));
    pane.costOf = (read) => (read >= 1 && read <= 2 ? 5_700 : 0);
    expect(await send(pane)).toBe(unconfirmed);
    expect(pane.readsAfterPrompt).toBe(2);
    expect(pane.keyLog).toEqual([]);
  });

  it("after the Return the reads end on the clock too (5 s): still in the box, unconfirmed", async () => {
    const text = `${caption} ${pictures[0]}`;
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : `[Image #1]${caption}` }));
    pane.costOf = (read) => (read === 0 ? 0 : 2_200);
    expect(await send(pane, text)).toBe(unconfirmed);
    expect(pane.keyLog).toEqual([["Enter"]]);
    expect(pane.readsAfterPrompt).toBe(3);
  });
});

// MARK: - unchanged

describe("text-only sends and other agents are as before", () => {
  it("a text-only send to Claude: no read, one prompt, Sent", async () => {
    const pane = new ClaudePane(() => ({ draft: "" }));
    expect(await send(pane, caption)).toBe("sent");
    expect(pane.reads).toBe(0);
    expect(pane.prompts).toEqual([caption]);
    expect(pane.keyLog).toEqual([]);
  });

  it("a text-only send to Claude with its box due: the one read before, then the prompt, nothing after", async () => {
    const pane = new ClaudePane(() => ({ draft: "" }));
    pane.site.box = { ...pane.site.box!, due: () => true };
    expect(await send(pane, caption)).toBe("sent");
    expect(pane.reads).toBe(1);
    expect(pane.readsAfterPrompt).toBe(0);
  });

  it("a send with pictures to Codex: one prompt, no read, no key, Sent", async () => {
    const pane = new ClaudePane(() => ({ draft: "" }));
    pane.kind = "codex";
    expect(await send(pane, sent, { ...claudeBinding, kind: "codex" })).toBe("sent");
    expect(pane.prompts).toEqual([sent]);
    expect(pane.reads).toBe(0);
    expect(pane.keyLog).toEqual([]);
  });

  it("a send with pictures to Grok or Cursor: its paste and one Return as before, no read", async () => {
    for (const kind of ["grok", "cursor"]) {
      const pane = new ClaudePane(() => ({ draft: "" }));
      pane.kind = kind;
      expect(await send(pane, sent, { ...claudeBinding, kind })).toBe("sent");
      expect(pane.pasted).toEqual([`\u001b[200~${sent}\u001b[201~`]);
      expect(pane.writerKeys).toEqual([["Enter"]]);
      expect(pane.reads).toBe(0);
      expect(pane.keyLog).toEqual([]);
    }
  });
});

// MARK: - the composer

const restoredPictures = pictures.map((path, index) => ({ path, name: `Picture ${index + 1}`, image: true }));

/** Sends the pane's draft through sendBound (the composer's own path), and waits for the result to land. */
async function sendFromComposer(pane: ClaudePane, drafts: ComposerDrafts, host: string): Promise<void> {
  let going: Promise<void> | null = null;
  const started = sendDraft(
    drafts,
    (h, p, t) => (going = sendWithPending((_hh, pp, tt) => sendBound(pane.site, pp, tt, claudeBinding), h, p, t, true)),
    host,
    "w1:p1",
    null,
  );
  expect(started).toBe(true);
  expect(going).not.toBeNull();
  await (going as unknown as Promise<void>).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the composer: its pictures go only when the send is Sent", () => {
  // Each test its own machine, so Chat's bubbles of one never show in another's pane.
  const key = (host: string): string => draftKey(host, "w1:p1");

  it("three pictures taken in: Sent, the draft and its three pictures go, Chat's bubble is delivered", async () => {
    const drafts = new ComposerDrafts();
    drafts.restore(key("sent-mini"), caption, restoredPictures, []);
    const pane = intake([500, 1_000, 1_500]);
    await sendFromComposer(pane, drafts, "sent-mini");
    expect(pane.prompts).toEqual([sent]);
    expect(pane.keyLog).toEqual([["Enter"]]);
    expect(drafts.get(key("sent-mini")).text).toBe("");
    expect(drafts.get(key("sent-mini")).chips).toEqual([]);
    expect(drafts.get(key("sent-mini")).error ?? null).toBeNull();
  });

  it("a picture missing: unconfirmed, the text and all three pictures kept with the note, the bubble taken back", async () => {
    const drafts = new ComposerDrafts();
    drafts.restore(key("missing-mini"), caption, restoredPictures, []);
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : twoChips }));
    await sendFromComposer(pane, drafts, "missing-mini");
    expect(pane.keyLog).toEqual([]);
    expect(drafts.get(key("missing-mini")).text).toBe(caption);
    expect(drafts.get(key("missing-mini")).chips.map((chip) => (chip.state.kind === "uploaded" ? chip.state.path : null))).toEqual(pictures);
    expect(drafts.get(key("missing-mini")).error).toBe(unconfirmed);
    expect(drafts.get(key("missing-mini")).sending).toBe(false);
    expect(pendingMessages.forPane(key("missing-mini"))).toEqual([]);
  });

  it("an edit after the Return: one Return, then the text and the pictures kept", async () => {
    const drafts = new ComposerDrafts();
    drafts.restore(key("edit-mini"), caption, restoredPictures, []);
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : p.returns.length === 0 ? threePicturesBox : otherCaption }));
    await sendFromComposer(pane, drafts, "edit-mini");
    expect(pane.keyLog).toEqual([["Enter"]]);
    expect(drafts.get(key("edit-mini")).text).toBe(caption);
    expect(drafts.get(key("edit-mini")).chips).toHaveLength(3);
    expect(drafts.get(key("edit-mini")).error).toBe(unconfirmed);
  });

  it("the user's typing alone in Claude's box: the text and the pictures kept", async () => {
    const drafts = new ComposerDrafts();
    drafts.restore(key("typing-mini"), caption, restoredPictures, []);
    const pane = new ClaudePane((p) => ({ draft: p.promptAt === null ? "" : "run the tests again" }));
    await sendFromComposer(pane, drafts, "typing-mini");
    expect(pane.keyLog).toEqual([]);
    expect(drafts.get(key("typing-mini")).text).toBe(caption);
    expect(drafts.get(key("typing-mini")).chips).toHaveLength(3);
  });
});
