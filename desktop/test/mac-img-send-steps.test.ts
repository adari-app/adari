// The parts of the Mac's picture-send check, each on its own (test/mac-img-send.test.ts
// covers them together through sendBound). Each is the twin of the phone's
// rule it ports: ClaudeScreenFacts.held / chipsFirst / settled(_:sent:before:)
// / chips / remnant / imagePaths, ClaudeBoxSteps.boxBefore / afterPrompt and
// their bounds (Tests/HerdrKitTests/ClaudeImage*Tests.swift), and the
// binding the corrective Return goes on. The last block drives the main
// process's Send IPC with a fake machine (no SSH, no Herdr, no socket).

const registered = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => void) => registered.ons.set(channel, listener),
  },
}));

import { describe, expect, it, vi } from "vitest";

import {
  afterPrompt,
  afterPromptGapMs,
  afterReturnMs,
  afterReturnReads,
  BoxKeysCalledOff,
  boxBefore,
  composerWrites,
  settleMs,
  settleReads,
  steadyNow,
  type AfterPromptBinding,
  type ClaudeBoxSite,
} from "../src/main/herdr/claude-box";
import { guardTexts, promptBinding, takerName, type SendSite } from "../src/main/herdr/send";
import { boxChips, held, imagePaths, remnant, settled, type BoxBefore } from "../src/shared/claude-screen";
import { IPC } from "../src/shared/ipc-contract";
import { claudeScreen } from "./support/claude-screens";
import { checkHerdrKeys } from "./support/herdr-keys";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { PaneInputs } = await import("../src/main/pane-inputs");

const folder = "/Users/fixture/.adari-attachments-0123456789abcdef0123456789abcdef/";
const pictures = [
  `${folder}attachment-11111111-1111-1111-1111-111111111111.png`,
  `${folder}attachment-22222222-2222-2222-2222-222222222222.png`,
  `${folder}attachment-33333333-3333-3333-3333-333333333333.jpg`,
];
const caption = "found this on X";
const sent = `${caption} ${pictures.join(" ")}`;
const threePicturesBox = "[Image #18] [Image #19] [Image #20]found this on X";
const earlier = `[Image #1] [Image #2] [Image #3]${caption}`;
const earlierChips: ReadonlySet<string> = new Set(["[Image#1]", "[Image#2]", "[Image#3]"]);
const empty: BoxBefore = { chips: new Set(), queued: false };

describe("Claude's box against the message (ClaudeScreenFacts.held, chipsFirst)", () => {
  const [a, b, c] = pictures as [string, string, string];
  it("reads a box with all three pictures as ours with every picture in, in Claude Code's layout or in place", () => {
    expect(held(threePicturesBox, sent)).toBe("mine");
    expect(held("[Image #18] [Image #19] [Image #20] found this on X", sent)).toBe("mine");
    expect(held(`[Image #18]found this on X ${b} ${c}`, sent)).toBe("mine");
    expect(held(sent, sent)).toBe("mine");
    expect(held(`found this on X [Image #1] ${b} ${c}`, sent)).toBe("mine");
    expect(held(`${a} found this on X`, `found this on X ${a}`)).toBe("mine");
    expect(held("[Image #18] [Image #19]\n[Image #20]found this\non X", sent)).toBe("mine");
  });

  it("text around ours is never ours alone; a picture missing or other words is not ours", () => {
    expect(held("[Image #18] [Image #19] [Image #20]run the tests againfound this on X", sent)).toBe("within");
    expect(held("[Image #17] [Image #18] [Image #19] [Image #20]found this on X", sent)).toBe("within");
    expect(held("[Image #18] [Image #19]found this on X", sent)).toBe("none");
    expect(held("[Image #18] [Image #19] [Image #20]found that on X", sent)).toBe("none");
    expect(held("found this on X", sent)).toBe("none");
    expect(held("found [Image #18] [Image #19] [Image #20]this on X", sent)).toBe("none");
    expect(held("", sent)).toBe("none");
  });

  it("matches regular-expression characters in the caption literally", () => {
    const odd = `why (a+b)*? [x] $1 ^ ${a}`;
    expect(held("[Image #4]why (a+b)*? [x] $1 ^", odd)).toBe("mine");
    expect(held("[Image #4]why (aab)*? [x] $1 ^", odd)).toBe("none");
  });

  it("finds the image paths a message carries (ClaudeScreenFacts.imagePaths)", () => {
    expect(imagePaths(sent)).toEqual(pictures);
    expect(imagePaths("see ~/shots/a.PNG and /tmp/b.webp /tmp/c.gif /tmp/d.jpeg")).toEqual(["~/shots/a.PNG", "/tmp/b.webp", "/tmp/c.gif", "/tmp/d.jpeg"]);
    expect(imagePaths(`notes ${folder}attachment-4.pdf ${folder}attachment-5.txt`)).toEqual([]);
    expect(imagePaths("relative/a.png /dir.png/file a.png")).toEqual([]);
    expect(imagePaths(caption)).toEqual([]);
  });
});

describe("readiness bound to this prompt (settled with the baseline, chips, remnant)", () => {
  it("reads the chips every whitespace aside", () => {
    expect(boxChips(threePicturesBox)).toEqual(["[Image#18]", "[Image#19]", "[Image#20]"]);
    expect(boxChips(caption)).toEqual([]);
    expect(boxChips("[Image\n#7]x")).toEqual(["[Image#7]"]);
  });

  it("settled needs one new chip per picture and no path left", () => {
    expect(settled(threePicturesBox, sent, empty)).toBe(true);
    expect(settled(earlier, sent, { chips: earlierChips, queued: false })).toBe(false);
    expect(settled(`[Image #4] [Image #5] [Image #6]${caption}`, sent, { chips: earlierChips, queued: false })).toBe(true);
    expect(settled(`[Image #3] [Image #4] [Image #5]${caption}`, sent, { chips: new Set(["[Image#3]"]), queued: false })).toBe(false);
    expect(settled(sent, sent, empty)).toBe(false);
    expect(settled(`[Image #18]found this on X ${pictures[1]} ${pictures[2]}`, sent, empty)).toBe(false);
    expect(settled("[Image #18] [Image #19]found this on X", sent, empty)).toBe(false);
  });

  it("a remnant is a piece of a message with pictures, never the user's text alone", () => {
    expect(remnant(`[Image #18] [Image #19]${caption}`, sent)).toBe(true);
    expect(remnant("[Image #18]other text", sent)).toBe(true);
    expect(remnant(`other ${pictures[1]}`, sent)).toBe(true);
    expect(remnant(caption, sent)).toBe(true);
    expect(remnant("run the tests again", sent)).toBe(false);
    expect(remnant("", sent)).toBe(false);
  });
});

describe("the bounds (in milliseconds)", () => {
  it("12 reads per picture for 1 to 4, and 3 s per picture plus 3 s on the clock", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(settleReads)).toEqual([12, 12, 24, 36, 48, 48, 48]);
    expect([0, 1, 3, 4, 7].map(settleMs)).toEqual([6_000, 6_000, 12_000, 15_000, 15_000]);
    expect(afterPromptGapMs).toBe(250);
    expect(afterReturnReads).toBe(8);
    expect(afterReturnMs).toBe(5_000);
  });

  it("the default clock is the process's monotonic one", () => {
    const first = steadyNow();
    expect(steadyNow()).toBeGreaterThanOrEqual(first);
  });
});

/** A pane whose box at each read is `draw(read, returns)` (null: the read fails), on a virtual clock. */
function pane(draw: (read: number, returns: number) => string | null, cost: (read: number) => number = () => 0) {
  const state = { clock: 0, reads: 0, keys: [] as string[][] };
  const site: ClaudeBoxSite = {
    read: async () => {
      const index = state.reads;
      state.reads += 1;
      state.clock += cost(index);
      const screen = draw(index, state.keys.length);
      if (screen === null) throw new Error("read failed");
      return screen;
    },
    keys: async (keys) => {
      checkHerdrKeys(keys);
      state.keys.push([...keys]);
    },
    wait: async (ms) => void (state.clock += ms),
    now: () => state.clock,
  };
  return { state, site };
}

const bound = (overrides: Partial<AfterPromptBinding> = {}): AfterPromptBinding => ({
  idleBefore: true,
  before: empty,
  holds: () => true,
  mayPress: async () => true,
  ...overrides,
});

describe("the box before the write and the reads after (ClaudeBoxSteps.boxBefore, afterPrompt)", () => {
  it("reads the box before the write fresh: its chips and queued hint; a failed read or no box gives none", async () => {
    expect(await boxBefore(pane(() => claudeScreen({ draft: "[Image #7] other text" })).site)).toEqual({ chips: new Set(["[Image#7]"]), queued: false });
    expect(await boxBefore(pane(() => claudeScreen({ working: true, queued: ["an earlier one"] })).site)).toEqual({ chips: new Set(), queued: true });
    expect(await boxBefore(pane(() => claudeScreen()).site)).toEqual(empty);
    expect(await boxBefore(pane(() => null).site)).toBeNull();
    expect(await boxBefore(pane(() => "Do you want to proceed?\n\u{276F} 1. Yes\n  2. No").site)).toBeNull();
  });

  it("with no box read before the write, the settled box gets no Return", async () => {
    const p = pane(() => claudeScreen({ draft: threePicturesBox }));
    expect(await afterPrompt(p.site, sent, bound({ before: null }))).toBe("stillInBox");
    expect(p.state.keys).toEqual([]);
  });

  it("the run not known (mayPress false, or its check failing): no Return", async () => {
    const no = pane(() => claudeScreen({ draft: threePicturesBox }));
    expect(await afterPrompt(no.site, sent, bound({ mayPress: async () => false }))).toBe("stillInBox");
    expect(no.state.keys).toEqual([]);
    const failing = pane(() => claudeScreen({ draft: threePicturesBox }));
    expect(await afterPrompt(failing.site, sent, bound({ mayPress: () => Promise.reject(new Error("no snapshot")) }))).toBe("stillInBox");
    expect(failing.state.keys).toEqual([]);
  });

  it("a Return the site's own last check refuses never went: still in the box, no reads after", async () => {
    const p = pane(() => claudeScreen({ draft: threePicturesBox }));
    const site: ClaudeBoxSite = { ...p.site, keys: () => Promise.reject(new BoxKeysCalledOff()) };
    expect(await afterPrompt(site, sent, bound())).toBe("stillInBox");
    expect(p.state.reads).toBe(1);
  });

  it("a Return that threw otherwise may have gone: the reads after it say (the box emptied: taken)", async () => {
    const p = pane((read) => claudeScreen({ draft: read === 0 ? threePicturesBox : "" }));
    const site: ClaudeBoxSite = { ...p.site, keys: () => Promise.reject(new Error("channel closed")) };
    expect(await afterPrompt(site, sent, bound())).toBe("taken");
  });

  it("a read that fails or shows no box says nothing: unknown before ours was seen, still in the box after", async () => {
    const never = pane(() => null);
    expect(await afterPrompt(never.site, sent, bound())).toBe("unknown");
    const seen = pane((read) => (read === 0 ? claudeScreen({ draft: sent }) : "Do you want to proceed?\n\u{276F} 1. Yes"));
    expect(await afterPrompt(seen.site, sent, bound())).toBe("stillInBox");
    expect(seen.state.keys).toEqual([]);
  });

  it("the binding failing after a read: no key, the reads stop, and that read says nothing", async () => {
    const p = pane(() => claudeScreen({ draft: threePicturesBox }));
    expect(await afterPrompt(p.site, sent, bound({ holds: () => p.state.reads < 1 }))).toBe("unknown");
    expect(p.state.keys).toEqual([]);
    expect(p.state.reads).toBe(1);
  });

  it("the first wait crossing the bound: no frame read, unknown (never Sent on the empty start)", async () => {
    const p = pane(() => claudeScreen());
    const site: ClaudeBoxSite = { ...p.site, wait: async (ms) => void (p.state.clock += ms + 20_000) };
    expect(await afterPrompt(site, sent, bound())).toBe("unknown");
    expect(p.state.reads).toBe(0);
  });

  it("the first wait after the Return crossing its bound: no read, still in the box", async () => {
    const p = pane(() => claudeScreen({ draft: threePicturesBox }));
    let waits = 0;
    const site: ClaudeBoxSite = {
      ...p.site,
      wait: async (ms) => {
        waits += 1;
        p.state.clock += ms + (waits === 2 ? afterReturnMs + 100 : 0);
      },
    };
    expect(await afterPrompt(site, sent, bound())).toBe("stillInBox");
    expect(p.state.keys).toEqual([["Enter"]]);
    expect(p.state.reads).toBe(1);
  });

  it("a site with no clock of its own runs on the steady one", async () => {
    const p = pane((read) => claudeScreen({ draft: read === 0 ? threePicturesBox : "" }));
    const noClock: ClaudeBoxSite = { read: p.site.read, keys: p.site.keys, wait: async () => undefined };
    expect(await afterPrompt(noClock, sent, bound())).toBe("taken");
    expect(p.state.keys).toEqual([["Enter"]]);
  });
});

describe("the binding the Return goes on (promptBinding)", () => {
  function sendSite() {
    const now = { epoch: 7 as number | null, arrival: 1, inputs: 0, marks: 0, terminalID: "t1" };
    const writer = { prompt: async () => undefined, sendInput: async () => undefined, sendText: async () => undefined, agentKeys: async () => undefined };
    const site: SendSite = {
      writer,
      fresh: async () => true,
      pane: () => ({ paneID: "w1:p1", terminalID: now.terminalID, agent: "claude", agentStatus: "idle" }) as never,
      agent: () => ({ paneID: "w1:p1", agent: "claude", agentStatus: "idle", terminalID: now.terminalID, ...(now.epoch === null ? {} : { turnEpoch: now.epoch }) }) as never,
      run: () => ({ connection: 3, arrival: now.arrival }),
      inputGeneration: () => now.inputs,
      box: { site: pane(() => claudeScreen()).site, own: () => [], sent: () => undefined, marks: () => now.marks },
    };
    return { now, site, writer };
  }
  const binding = { terminalID: "t1", isAgent: true, kind: "claude", session: null };

  it("holds while nothing changed; the run known only with a turn_epoch, the same now", () => {
    const s = sendSite();
    const b = promptBinding(s.site, binding, s.site.box!, "w1:p1");
    expect(b.holds()).toBe(true);
    expect(b.known()).toBe(true);
    s.now.epoch = 8;
    expect(b.holds()).toBe(false);
    expect(b.known()).toBe(false);
    const none = sendSite();
    none.now.epoch = null;
    const unknown = promptBinding(none.site, binding, none.site.box!, "w1:p1");
    expect(unknown.holds()).toBe(true);
    expect(unknown.known()).toBe(false);
  });

  it("Terminal input, a box mark, another agent or another composer write calls it off; its own Return does not", () => {
    for (const change of [
      (s: ReturnType<typeof sendSite>) => void (s.now.inputs += 1),
      (s: ReturnType<typeof sendSite>) => void (s.now.marks += 1),
      (s: ReturnType<typeof sendSite>) => void (s.now.arrival = 2),
      (s: ReturnType<typeof sendSite>) => void (s.now.terminalID = "t2"),
      (s: ReturnType<typeof sendSite>) => composerWrites.wrote(s.writer, "w1:p1"),
    ]) {
      const s = sendSite();
      const b = promptBinding(s.site, binding, s.site.box!, "w1:p1");
      change(s);
      expect(b.holds()).toBe(false);
    }
    const s = sendSite();
    const b = promptBinding(s.site, binding, s.site.box!, "w1:p1");
    const before = composerWrites.count(s.writer, "w1:p1");
    b.wrote();
    expect(composerWrites.count(s.writer, "w1:p1")).toBe(before + 1);
    expect(b.holds()).toBe(true);
  });
});

// MARK: - the main process's Send IPC, with a fake machine

const binding = { terminalID: "t1", isAgent: true, kind: "claude", session: "s1" };

/** One machine through the IPC: its box's screen per read (`draw`), every write logged; real 250 ms waits. */
function mac(draw: (read: number, prompted: boolean, returns: number) => string, epoch: number | null = 7) {
  const log: unknown[][] = [];
  let reads = 0;
  let prompted = false;
  let returns = 0;
  const backend = {
    promptIO: () => ({
      paneRead: async () => {
        const index = reads;
        reads += 1;
        log.push(["read"]);
        return draw(index, prompted, returns);
      },
      paneSendKeys: async () => undefined,
    }),
    prompt: async (_pane: string, text: string) => {
      prompted = true;
      log.push(["prompt", text]);
    },
    agentKeys: async (_pane: string, keys: readonly string[]) => {
      checkHerdrKeys(keys);
      if (keys.includes("Enter")) returns += 1;
      log.push(["keys", [...keys]]);
    },
    sendText: async () => undefined,
    sendInput: async () => undefined,
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => ({ paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "idle", revision: 1 }),
    agent: () => ({
      paneID: "w1:p1",
      agent: "claude",
      agentStatus: "idle",
      terminalID: "t1",
      agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "s1" },
      ...(epoch === null ? {} : { turnEpoch: epoch }),
    }),
    run: () => ({ connection: 3, arrival: 1 }),
    fresh: async () => true,
    refresh: async () => undefined,
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
  };
  registerIpc({ hosts, paneInputs: new PaneInputs() } as never);
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1, isDestroyed: () => false, send: () => undefined } };
  return {
    log,
    send: (text: string) =>
      (registered.handles.get(IPC.paneSend)!(event, "mini", "w1:p1", text, binding) as Promise<void>).then(
        () => "sent",
        (error: Error) => error.message,
      ),
  };
}

describe("the Send IPC: a picture send to Claude reads its box after the prompt", () => {
  it("the box before, the prompt, the pictures in: one Return through Herdr's agent keys, Sent", async () => {
    const m = mac((read, prompted, returns) => claudeScreen({ draft: !prompted || returns > 0 ? "" : read < 3 ? "" : threePicturesBox, working: returns > 0 }));
    expect(await m.send(sent)).toBe("sent");
    expect(m.log).toEqual([["read"], ["read"], ["prompt", sent], ["read"], ["read"], ["keys", ["Enter"]], ["read"]]);
  });

  it("no turn_epoch for the pane: no Return, unconfirmed", async () => {
    const m = mac((_read, prompted) => claudeScreen({ draft: prompted ? threePicturesBox : "" }), null);
    expect(await m.send(sent)).toBe(guardTexts.returnUnconfirmed(takerName("claude")));
    expect(m.log.filter((entry) => entry[0] === "keys")).toEqual([]);
  });

  it("a text-only send: the box read before it (due), the prompt, nothing after", async () => {
    const m = mac(() => claudeScreen());
    expect(await m.send(caption)).toBe("sent");
    expect(m.log).toEqual([["read"], ["prompt", caption]]);
  });
});
