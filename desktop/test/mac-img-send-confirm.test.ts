// Confirming a picture message sent to Claude Code, on a fake pane with synthetic paths and screens (no socket,
// network or attachment):
//
// 1. An empty idle box all along is not Sent: no frame showed the message and nothing attributable took it.
// 2. The baseline belongs to the run the prompt goes to: a run (or input) change between the baseline read
//    and the write drops it, so no chip of another run's counts as this prompt's.
// 3. The next Send never joins an unconfirmed picture message: our own chip message in Claude's box (this
//    run's history, `held` mine) is cleared and read empty first; `within` or other text is never cleared.
//    The reads after an Esc claim and clear such a message by the same rule.
// 4. Esc never restores a message the failed Send already put back in the composer.

import { describe, expect, it } from "vitest";

import { afterPrompt, afterStop, beforeSend, clearClaudeBox, type AfterPromptBinding, type ClaudeBoxSite } from "../src/main/herdr/claude-box";
import { guardTexts, sendBound, type SendSite } from "../src/main/herdr/send";
import { held, readClaudeScreenFacts, type BoxBefore } from "../src/shared/claude-screen";
import { ComposerDrafts, draftKey, sendDraft } from "../src/renderer/components/composer-drafts";
import { pendingMessages, sendWithPending } from "../src/renderer/chat/chat-state";
import { takeBackAfterStop } from "../src/renderer/chat/esc-back";
import { PendingMessages } from "../src/shared/chat/pending";
import { claudeScreen } from "./support/claude-screens";

const paths = ["/fixture/one.png", "/fixture/two.jpg", "/fixture/three.webp"];
const caption = "sample caption 🙂 (a+b)?";
const message = `${caption} ${paths.join(" ")}`;
const exact = `[Image #11] [Image #12] [Image #13]${caption}`;
const old = `[Image #1] [Image #2] [Image #3]${caption}`;
const empty: BoxBefore = { chips: new Set(), queued: false };
const expected = { terminalID: "t1", isAgent: true, kind: "claude", session: "session-1" };
const note = guardTexts.returnUnconfirmed("Claude Code");
const box = (draft = "", working = false, queued = false): string => claudeScreen({ draft, working, queued: queued ? ["this message"] : [] });
const result = (p: Promise<void>): Promise<string> => p.then(() => "sent", (e: Error) => e.message);
const binding = (changes: Partial<AfterPromptBinding> = {}): AfterPromptBinding => ({ idleBefore: true, before: empty, holds: () => true, mayPress: async () => true, ...changes });
const enters = (keys: readonly string[][]): number => keys.filter((k) => k.includes("Enter")).length;

/** A fake pane: a virtual clock, the box drawn per read, hooks at fresh, read, key and prompt. */
class FakePane {
  clock = 0;
  prompted = false;
  reads = 0;
  postReads = 0;
  freshes = 0;
  input = 0;
  marks = 0;
  connection = 1;
  arrival = 1;
  epoch: number | null = 7;
  terminal = "t1";
  session: string | null = "session-1";
  kind = "claude";
  status = "idle";
  present = true;
  machine = true;
  due = false;
  before = box();
  readCost = 0;
  extraWait = 0;
  readonly keys: string[][] = [];
  readonly writes: string[] = [];
  readonly recorded: string[] = [];
  draw: (p: FakePane) => string = () => box(exact);
  freshHook: (p: FakePane) => void = () => undefined;
  readHook: (p: FakePane) => void = () => undefined;
  keyHook: (p: FakePane) => void = () => undefined;
  promptHook: (p: FakePane, text: string) => void = () => undefined;
  readonly screen: ClaudeBoxSite = {
    now: () => this.clock,
    wait: async (ms) => {
      this.clock += ms + this.extraWait;
      this.extraWait = 0;
    },
    read: async () => {
      this.reads++;
      this.clock += this.readCost;
      if (!this.prompted) return this.before;
      this.postReads++;
      this.readHook(this);
      return this.draw(this);
    },
    keys: async (keys) => {
      this.keys.push([...keys]);
      this.keyHook(this);
    },
  };
  readonly site: SendSite = {
    writer: {
      prompt: async (_pane, text) => {
        this.prompted = true;
        this.writes.push(text);
        this.promptHook(this, text);
      },
      sendInput: async (_pane, text) => void this.writes.push(text),
      sendText: async (_pane, text) => void this.writes.push(text),
      agentKeys: async (_pane, keys) => void this.keys.push([...keys]),
    },
    fresh: async () => {
      this.freshes++;
      this.freshHook(this);
      return true;
    },
    pane: () => (this.present ? ({ paneID: "p1", terminalID: this.terminal, agent: this.kind, agentStatus: this.status } as never) : null),
    agent: () =>
      ({
        paneID: "p1",
        terminalID: this.terminal,
        agent: this.kind,
        agentStatus: this.status,
        ...(this.session === null ? {} : { agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: this.session } }),
        ...(this.epoch === null ? {} : { turnEpoch: this.epoch }),
      }) as never,
    run: () => ({ connection: this.connection, arrival: this.arrival }),
    inputGeneration: () => this.input,
    box: {
      site: this.screen,
      own: () => this.recorded,
      sent: (text) => void this.recorded.push(text),
      due: () => this.due,
      checked: () => {
        this.due = false;
      },
      failed: () => {
        this.marks++;
        this.due = true;
      },
      machine: () => this.machine,
      marks: () => this.marks,
    },
  };
  send(text = message): Promise<string> {
    return result(sendBound(this.site, "p1", text, expected));
  }
}

/** A composer: caption and three newly uploaded picture chips, sent through sendDraft and sendWithPending as Chat does. */
async function composer(p: FakePane, host: string): Promise<{ drafts: ComposerDrafts; key: string; discarded: string[] }> {
  const key = draftKey(host, "p1");
  const discarded: string[] = [];
  let uploaded = 0;
  const drafts = new ComposerDrafts({
    transport: () => ({
      upload: async (_host, data) => ({ path: paths[uploaded++]!, byteCount: data.byteLength }),
      discard: async (_host, path) => void discarded.push(path),
    }),
  });
  drafts.edit(key, caption);
  drafts.attach(
    key,
    paths.map((path, i) => ({ name: `sample-${i}`, extension: path.split(".").at(-1)!, image: true, data: new Uint8Array([1, 2, 3]) })),
  );
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(drafts.get(key).chips.map((chip) => chip.state.kind)).toEqual(["uploaded", "uploaded", "uploaded"]);
  await again(p, drafts, host);
  return { drafts, key, discarded };
}

/** The pane's draft sent once more (the next Send). */
async function again(p: FakePane, drafts: ComposerDrafts, host: string): Promise<void> {
  let done: Promise<void> | undefined;
  expect(
    sendDraft(
      drafts,
      (h, pane, text) => {
        done = sendWithPending((_h, pp, tt) => sendBound(p.site, pp, tt, expected), h, pane, text, true);
        return done;
      },
      host,
      "p1",
    ),
  ).toBe(true);
  await done!.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// MARK: - An empty idle box

describe("an empty idle box all along is not Sent", () => {
  it("a no-op successful prompt and empty idle box must retain the real composer draft", async () => {
    const p = new FakePane();
    p.draw = () => box();
    const { drafts, key } = await composer(p, "host-no-op");
    expect(p.keys).toEqual([]);
    expect(p.writes).toEqual([message]);
    // A successful agent.prompt is only a reply; no read showed the text typed or taken.
    expect(drafts.get(key).text).toBe(caption);
    expect(drafts.get(key).chips).toHaveLength(3);
    expect(drafts.get(key).error).toBe(note);
  });

  it("intake slower than the read window must not be Sent before the first chip appears", async () => {
    const p = new FakePane();
    p.draw = (q) => box(q.clock >= 9_250 ? exact : "");
    expect(await p.send()).toBe(note);
    expect(p.keys).toEqual([]);
    p.clock = 9_250;
    expect(readClaudeScreenFacts(await p.screen.read()).draft).toBe(exact);
  });

  it("afterPrompt alone: never seen, the box empty and Claude idle throughout: unknown, no key", async () => {
    const p = new FakePane();
    p.prompted = true;
    p.draw = () => box();
    expect(await afterPrompt(p.screen, message, binding())).toBe("unknown");
    expect(p.keys).toEqual([]);
  });

  it("the unconfirmed send marks the box due, so the next Send reads it first", async () => {
    const p = new FakePane();
    p.draw = () => box();
    expect(await p.send()).toBe(note);
    expect(p.due).toBe(true);
  });

  // The three positive cases stay Sent.
  it("seen, then the box empty with Claude idle: Sent, no extra key", async () => {
    const p = new FakePane();
    p.draw = (q) => box(q.postReads === 1 ? message : "");
    expect(await p.send()).toBe("sent");
    expect(p.keys).toEqual([]);
  });

  it("this prompt's new queued hint: Sent; a hint there before the write: not", async () => {
    const p = new FakePane();
    p.status = "working";
    p.draw = () => box("", true, true);
    expect(await p.send()).toBe("sent");
    const oldHint = new FakePane();
    oldHint.status = "working";
    oldHint.before = box("", true, true);
    oldHint.draw = () => oldHint.before;
    expect(await oldHint.send()).toBe(note);
    expect(oldHint.keys).toEqual([]);
  });

  it("Claude idle before, then working with the box empty: Sent", async () => {
    const p = new FakePane();
    p.draw = () => box("", true);
    expect(await p.send()).toBe("sent");
    expect(p.keys).toEqual([]);
  });

  it("chips that show late: one Return once the new chips show, Sent once the box empties", async () => {
    const p = new FakePane();
    p.draw = (q) => box(q.postReads < 3 ? "" : q.keys.length === 0 ? exact : "");
    expect(await p.send()).toBe("sent");
    expect(p.keys).toEqual([["Enter"]]);
  });
});

// MARK: - The baseline's run

describe("the baseline belongs to the run the prompt is sent to", () => {
  it("a run change between baseline and write must not make the new runs earlier chips look new", async () => {
    const p = new FakePane();
    p.before = box(old);
    // The fresh snapshot before the write finds another run of the same session in the same terminal.
    p.freshHook = (q) => {
      if (!q.prompted) q.epoch = 8;
    };
    p.draw = (q) => (q.keys.length === 0 ? box(exact) : box("", true));
    expect(await p.send()).toBe(note);
    expect(p.keys).toEqual([]);
    expect(p.writes).toEqual([message]);
  });

  const changes: [string, (p: FakePane) => void][] = [
    ["the run's turn_epoch", (p) => void (p.epoch = 8)],
    ["the run's turn_epoch disappearing", (p) => void (p.epoch = null)],
    ["the connection", (p) => void p.connection++],
    ["the agent's arrival", (p) => void p.arrival++],
    ["Terminal input", (p) => void p.input++],
    ["a box mark (Stop, Esc, a pick)", (p) => void p.marks++],
  ];
  for (const [what, change] of changes) {
    it(`${what} changed between the baseline read and the write: the baseline is dropped, the prompt goes, no Return`, async () => {
      const p = new FakePane();
      p.freshHook = (q) => {
        if (!q.prompted) change(q);
      };
      // Chips new against an empty baseline: with the baseline kept a Return would go.
      p.draw = (q) => box(q.keys.length === 0 ? exact : "");
      expect(await p.send()).toBe(note);
      expect(p.writes).toEqual([message]);
      expect(p.keys).toEqual([]);
    });
  }

  it("the same run from the baseline read to the write: the baseline holds and the one Return goes", async () => {
    const p = new FakePane();
    p.before = box(old);
    p.draw = (q) => box(q.keys.length === 0 ? exact : "");
    expect(await p.send()).toBe("sent");
    expect(p.keys).toEqual([["Enter"]]);
  });

  it("a run already changed when the baseline was read (the snapshot shows it before and after): that run's own chips are the baseline", async () => {
    const p = new FakePane();
    p.epoch = 8;
    p.before = box(old);
    // The same old chips after the write are not new: no Return.
    p.draw = () => box(old);
    expect(await p.send()).toBe(note);
    expect(p.keys).toEqual([]);
  });
});

// MARK: - An unconfirmed picture message

/** A box site over a list of screens (the last repeats); keys recorded, `onKeys` may change what it draws next. */
function screens(frames: string[], onKeys: (keys: readonly string[]) => void = () => undefined) {
  const keys: string[][] = [];
  let at = 0;
  const site: ClaudeBoxSite = {
    read: async () => frames[Math.min(at++, frames.length - 1)]!,
    keys: async (k) => {
      keys.push([...k]);
      onKeys(k);
    },
    wait: async () => undefined,
  };
  return { site, keys };
}

describe("the next Send never joins an unconfirmed picture message", () => {
  it("must not submit a duplicate joined to the old unconfirmed chip message", async () => {
    const p = new FakePane();
    let submitted: string | null = null;
    let draft = exact;
    p.draw = () => box(draft, submitted !== null);
    const first = await composer(p, "host-retry-taken");
    expect(first.drafts.get(first.key).text).toBe(caption);
    expect(p.keys).toEqual([["Enter"]]);
    // Claude's chip message survives the first and the corrective Return; the next Send's Return is taken.
    p.keyHook = (q) => {
      if (q.keys.at(-1)?.includes("ctrl+u")) draft = "";
    };
    p.promptHook = (_q, text) => {
      draft += text;
      submitted = draft;
      draft = "";
    };
    await again(p, first.drafts, "host-retry-taken");
    expect(submitted === null || submitted === message).toBe(true);
    expect(submitted === message || first.drafts.get(first.key).text === caption).toBe(true);
    expect(enters(p.keys)).toBe(1);
  });

  it("the retry clears the chip message first, proves the box empty, then prompts: Sent once, the draft empty", async () => {
    const p = new FakePane();
    let draft = exact;
    p.draw = () => box(draft, draft === "" && p.writes.length > 1);
    const first = await composer(p, "host-retry-order");
    p.keyHook = (q) => {
      if (q.keys.at(-1)?.includes("ctrl+u")) draft = "";
    };
    p.promptHook = () => void (draft = "");
    await again(p, first.drafts, "host-retry-order");
    expect(p.keys).toEqual([["Enter"], ["ctrl+u", "Backspace"]]);
    expect(p.writes).toEqual([message, message]);
    expect(first.drafts.get(first.key).text).toBe("");
    expect(first.drafts.get(first.key).chips).toHaveLength(0);
    expect(first.drafts.get(first.key).error).toBeNull();
  });

  it("a chip message that will not clear refuses the next Send: no prompt, the draft and pictures kept", async () => {
    const p = new FakePane();
    p.draw = () => box(exact);
    const first = await composer(p, "host-retry-stuck");
    await again(p, first.drafts, "host-retry-stuck");
    expect(p.writes).toEqual([message]);
    // One clear, then once more while the box still holds exactly our message; no Return.
    expect(p.keys).toEqual([["Enter"], ["ctrl+u", "Backspace"], ["ctrl+u", "Backspace"]]);
    expect(first.drafts.get(first.key).text).toBe(caption);
    expect(first.drafts.get(first.key).chips).toHaveLength(3);
    expect(first.drafts.get(first.key).error).toBe("Not sent: Claude Code's box still has text. Open Terminal to clear it.");
  });

  for (const [layout, draft] of [
    ["chips first", exact],
    ["chips first, a path still going in", `[Image #11] [Image #12]${caption}${paths[2]}`],
    ["in place", `${caption} [Image #11] [Image #12] [Image #13]`],
    ["raw paths", message],
  ] as const) {
    it(`beforeSend clears our own message, ${layout}, and reads the box empty`, async () => {
      const { site, keys } = screens([box(draft), box()]);
      expect(await beforeSend(site, [message])).toEqual({ type: "go", cleared: message });
      expect(keys).toEqual([["ctrl+u", "Backspace"]]);
    });
  }

  for (const [what, draft] of [
    ["the user's typing joined to it (within)", `own typing${exact}`],
    ["another caption", "[Image #11] [Image #12] [Image #13]own words"],
    ["a picture missing", `[Image #11] [Image #12]${caption}`],
    ["the user's text alone", "please check another task"],
  ] as const) {
    it(`beforeSend never clears ${what}`, async () => {
      const { site, keys } = screens([box(draft)]);
      expect(await beforeSend(site, [message])).toEqual({ type: "go", cleared: null });
      expect(keys).toEqual([]);
    });
  }

  it("a chip message sent to another run is not ours: not cleared", async () => {
    const { site, keys } = screens([box(exact)]);
    expect(await beforeSend(site, [])).toEqual({ type: "go", cleared: null });
    expect(keys).toEqual([]);
  });

  it("clearClaudeBox's second attempt goes while the box still holds our chip message, never once it holds other text", async () => {
    const twice = screens([box(exact), box()]);
    expect(await clearClaudeBox(twice.site, exact, message)).toBe(true);
    expect(twice.keys).toHaveLength(2);
    const other = screens([box(`own typing${exact}`)]);
    expect(await clearClaudeBox(other.site, exact, message)).toBe(false);
    expect(other.keys).toHaveLength(1);
  });

  it("after an Esc our chip message back in the box is claimed once and cleared; a second Esc's reads find nothing", async () => {
    const recorded = [message];
    let draft = exact;
    const site: ClaudeBoxSite = {
      read: async () => box(draft),
      keys: async (k) => void (k.includes("ctrl+u") && (draft = "")),
      wait: async () => undefined,
    };
    const claims = {
      last: () => recorded.at(-1) ?? null,
      claim: (text: string) => {
        const i = recorded.lastIndexOf(text);
        if (i < 0) return false;
        recorded.splice(i, 1);
        return true;
      },
    };
    expect(await afterStop(site, claims)).toEqual({ cancelled: message, cleared: true });
    expect(recorded).toEqual([]);
    draft = exact;
    expect(await afterStop(site, claims)).toEqual({ cancelled: null, cleared: false });
    expect(draft).toBe(exact);
  });

  it("after an Esc the user's typing joined to our chip message is left alone and the send stays ours", async () => {
    const recorded = [message];
    const { site, keys } = screens([box(`own typing${exact}`)]);
    const claims = { last: () => recorded.at(-1) ?? null, claim: () => recorded.splice(0, 1).length === 1 };
    expect(await afterStop(site, claims)).toEqual({ cancelled: null, cleared: false });
    expect(keys).toEqual([]);
    expect(recorded).toEqual([message]);
  });

  it("text-only sends match by the same rule (held mine is sameBoxText)", async () => {
    for (const [draft, sent, cleared] of [
      ["hello  world", "hello world", true],
      ["hello world!", "hello world", false],
      ["", "hello", false],
    ] as const) {
      const { site } = screens([box(draft), box()]);
      const went = await beforeSend(site, [sent]);
      expect(went.type === "go" && went.cleared === sent).toBe(cleared);
    }
    expect(held("[Image #1]hello", "hello")).toBe("within");
  });
});

// MARK: - Esc after a failed Send

/** A composer's drafts as the take-back sees them: the text and the uploaded chips' paths. */
function page(text: string, chipPaths: readonly string[] = []) {
  const state = { text, notes: [] as string[] };
  const pending = new PendingMessages();
  const drafts = {
    get: () => ({ text: state.text, chips: chipPaths.map((path) => ({ state: { kind: "uploaded" as const, path } })) }),
    edit: (_key: string, next: string) => void (state.text = next),
  };
  const deps = { drafts, pending, landing: () => undefined, note: (_key: string, t: string) => void state.notes.push(t) };
  return { state, deps };
}

describe("Esc never restores a message the failed Send already put back", () => {
  it("must not prepend an already restored message to its caption and picture chips", async () => {
    const p = new FakePane();
    p.status = "working";
    p.draw = () => box(message, true);
    const { drafts, key } = await composer(p, "host-esc-restored");
    expect(drafts.get(key).text).toBe(caption);
    expect(drafts.get(key).chips).toHaveLength(3);
    expect(p.recorded).toEqual([message]);
    expect(p.keys).toEqual([]);
    // The fake Esc ends the earlier working turn; the box keeps our raw prompt, every binding unchanged.
    let draft = message;
    p.draw = () => box(draft);
    p.keyHook = (q) => {
      if (q.keys.at(-1)?.includes("ctrl+u")) draft = "";
    };
    const found = await afterStop(p.screen, {
      last: () => p.recorded.at(-1) ?? null,
      claim: (text) => {
        const i = p.recorded.lastIndexOf(text);
        if (i < 0) return false;
        p.recorded.splice(i, 1);
        return true;
      },
    });
    expect(found).toEqual({ cancelled: message, cleared: true });
    const deps = { drafts, pending: pendingMessages, landing: () => undefined, note: () => undefined };
    expect(takeBackAfterStop(deps, key, found)).toBe(true);
    expect(drafts.get(key).text).toBe(caption);
    expect(drafts.get(key).chips).toHaveLength(3);
    expect(p.recorded).toEqual([]);
    expect(takeBackAfterStop(deps, key, found)).toBe(false);
  });

  it("a restored draft followed by new typing: not put back again, the user's typing kept", () => {
    const { state, deps } = page(`${caption}\nand one more thing`, paths);
    expect(takeBackAfterStop(deps, "k", { cancelled: message, cleared: true })).toBe(true);
    expect(state.text).toBe(`${caption}\nand one more thing`);
  });

  // The user's typing on the same line as the restored caption.
  for (const suffix of ["\nand one more thing", " and one more thing"]) {
    it(`Esc after restored draft plus typing ${JSON.stringify(suffix)} must not duplicate it`, async () => {
      const p = new FakePane();
      p.status = "working";
      p.draw = () => box(message, true);
      const { drafts, key } = await composer(p, `host-typed-${suffix.startsWith("\n") ? "newline" : "inline"}`);
      drafts.edit(key, caption + suffix);
      const ids = drafts.get(key).chips.map((chip) => chip.id);
      let heldDraft = exact;
      p.draw = () => box(heldDraft);
      p.keyHook = (q) => {
        if (q.keys.at(-1)?.includes("ctrl+u")) heldDraft = "";
      };
      const claims = {
        last: () => p.recorded.at(-1) ?? null,
        claim: (text: string) => {
          const i = p.recorded.lastIndexOf(text);
          if (i < 0) return false;
          p.recorded.splice(i, 1);
          return true;
        },
      };
      const found = await afterStop(p.screen, claims);
      expect(found).toEqual({ cancelled: message, cleared: true });
      const deps = { drafts, pending: pendingMessages, landing: () => undefined, note: () => undefined };
      expect(takeBackAfterStop(deps, key, found)).toBe(true);
      expect(drafts.get(key).text).toBe(caption + suffix);
      expect(drafts.get(key).chips.map((chip) => chip.id)).toEqual(ids);
      expect(p.recorded).toEqual([]);
      expect(takeBackAfterStop(deps, key, found)).toBe(false);
      expect(await afterStop(p.screen, claims)).toEqual({ cancelled: null, cleared: false });
      expect(p.keys).toEqual([["ctrl+u", "Backspace"]]);
    });
  }

  it("same-line typing with a picture added since: not put back, the new chip stays out of the match", () => {
    const { state, deps } = page(`${caption} and one more thing`, [...paths, "/fixture/four.png"]);
    takeBackAfterStop(deps, "k", { cancelled: message, cleared: true });
    expect(state.text).toBe(`${caption} and one more thing`);
  });

  it("same-line typing after a pictures-only message (no caption): not put back, the user's typing kept", () => {
    const { state, deps } = page("and one more thing", paths);
    takeBackAfterStop(deps, "k", { cancelled: paths.join(" "), cleared: true });
    expect(state.text).toBe("and one more thing");
  });

  it("same-line typing, Claude's box would not empty: not put back, the note still shows", () => {
    const { state, deps } = page(`${caption} and one more thing`, paths);
    expect(takeBackAfterStop(deps, "k", { cancelled: message, cleared: false })).toBe(true);
    expect(state.text).toBe(`${caption} and one more thing`);
    expect(state.notes).toEqual(["Claude Code's box still has text. Open Terminal to clear it."]);
  });

  it("same-line typing with one picture removed: not the whole message, so it comes back", () => {
    const { state, deps } = page(`${caption} and one more thing`, paths.slice(0, 2));
    takeBackAfterStop(deps, "k", { cancelled: message, cleared: true });
    expect(state.text).toBe(`${message}\n${caption} and one more thing`);
  });

  it("the caption itself changed: not the original caption, so it comes back", () => {
    const { state, deps } = page("sample caption, edited", paths);
    takeBackAfterStop(deps, "k", { cancelled: message, cleared: true });
    expect(state.text).toBe(`${message}\nsample caption, edited`);
  });

  it("a picture path typed into the caption is not a chip: the same-line rule does not apply", () => {
    const inline = `see ${paths[0]} ${paths.slice(1).join(" ")}`;
    const { state, deps } = page(`see ${paths[0]} and more`, paths.slice(1));
    takeBackAfterStop(deps, "k", { cancelled: inline, cleared: true });
    expect(state.text).toBe(`${inline}\nsee ${paths[0]} and more`);
  });

  it("already in the composer and Claude's box would not empty: the note still shows", () => {
    const { state, deps } = page(caption, paths);
    expect(takeBackAfterStop(deps, "k", { cancelled: message, cleared: false })).toBe(true);
    expect(state.text).toBe(caption);
    expect(state.notes).toEqual(["Claude Code's box still has text. Open Terminal to clear it."]);
  });

  it("a picture added after the restore stays out of the match: not put back again", () => {
    const { state, deps } = page(caption, [...paths, "/fixture/four.png"]);
    takeBackAfterStop(deps, "k", { cancelled: message, cleared: true });
    expect(state.text).toBe(caption);
  });

  it("the composer holding only the user's own typing: the message comes back first", () => {
    const { state, deps } = page("unrelated", []);
    takeBackAfterStop(deps, "k", { cancelled: message, cleared: true });
    expect(state.text).toBe(`${message}\nunrelated`);
  });

  it("the same caption but one picture removed: not the whole message, so it comes back", () => {
    const { state, deps } = page(caption, paths.slice(0, 2));
    takeBackAfterStop(deps, "k", { cancelled: message, cleared: true });
    expect(state.text).toBe(`${message}\n${caption}`);
  });

  it("a text-only message is never taken as already there (the user may have typed it again)", () => {
    const { state, deps } = page("test", []);
    takeBackAfterStop(deps, "k", { cancelled: "test", cleared: true });
    expect(state.text).toBe("test\ntest");
  });

  it("a message whose paths are in the composer's text (no chips): already there", () => {
    const { state, deps } = page(message, []);
    takeBackAfterStop(deps, "k", { cancelled: message, cleared: true });
    expect(state.text).toBe(message);
  });
});
