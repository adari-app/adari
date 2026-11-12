// Codex panes with no session and Codex's hook review:
// - A no-session bubble settles into an adopted transcript message
//   only when it is provably this send (strictly after the send, in order); an
//   identical message just before it keeps the acknowledgement, and two
//   identical sends keep their own messages for take-back.
// - A Send to a Codex pane with no session reads its screen inside
//   its own turn (after the queue and the fresh snapshot) and checks the latest
//   read again right before the text and right before the Return: a read in
//   flight when the Send starts, one that finishes while it waits on its
//   snapshot, or one between its text and its Return: no write, no Return.
// - A pane that showed the hook review loses "Chat shows Codex's
//   replies after your first message." until its session is named.
// - Only the whole live menu matches.
// Fake Herdr, fake screens and transcripts only: no socket, no network.

import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { HerdrClient } from "../src/main/herdr/client";
import { HostRegistry } from "../src/main/hosts";
import { IntegrationService } from "../src/main/integrations";
import { StartScreenService } from "../src/main/start-screens";
import { hookReviewWhy, guardTexts } from "../src/main/herdr/send";
import { PaneReadGate } from "../src/shared/chat/live-reader";
import { PendingMessages, terminalOnlyLabel } from "../src/shared/chat/pending";
import { emptyTimeline, makeTurn, userMessage, type ChatUserMessage } from "../src/shared/chat/model";
import { applyStartScreens, readStartScreen, showsCodexHookReview, startScreenTexts } from "../src/shared/prompt/start-screen";
import { integrationTexts } from "../src/shared/integrations";
import { chatIntegrationLook } from "../src/renderer/components/integrations";
import { ComposerDrafts, sendDraft } from "../src/renderer/components/composer-drafts";
import { paneTopology } from "./support/pane-topology";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
};

/** Codex 0.167.0's hook review, word for word (as a clean home shows it). */
const hookReview = [
  "  Hooks need review",
  "  1 hook is new or changed.",
  "  Hooks can run outside the sandbox after you trust them.",
  "",
  "",
  "› 1. Review hooks",
  "  2. Trust all and continue",
  "  3. Continue without trusting (hooks won't run)",
  "",
  "  enter confirm · esc skip",
].join("\n");

/** Codex's own prompt (after a choice, or a pane that never asked). */
const codexPrompt = "› Ask Codex to do anything\n\n  gpt-5.5 high · ~/fixture";

// MARK: - Adoption never hides a send

describe("a no-session bubble settles only into a message that is provably this send", () => {
  const key = "mini/w1:p1";
  const scope = { terminalID: "term", session: null };
  const sentMs = 1_800_000_000_000;
  const sent = sentMs / 1_000;
  const timeline = (...messages: ChatUserMessage[]) => ({
    ...emptyTimeline,
    turns: [makeTurn("turn", { items: messages.map((value) => ({ type: "user" as const, value })), isFinished: true })],
  });
  /** A send with no session that Herdr took ("Sent to the terminal"), then the session named. */
  function sentToTerminal(text = "yes", atMs = sentMs) {
    const store = new PendingMessages();
    const id = store.add(key, text, atMs, scope);
    store.delivered(id);
    store.reconcile(new Map([[key, { terminalID: "term", session: "s-1" }]]), () => true);
    return { store, id };
  }

  it.each([0.001, 0.5, 1, 2])("an identical message %s s before the send is history: the bubble keeps its acknowledgement", (age) => {
    const { store } = sentToTerminal();
    store.observe(key, timeline(userMessage("history", "yes", sent - age)));
    expect(store.forPane(key)).toHaveLength(1);
    expect(store.forPane(key)[0]!.state).toBe("terminalOnly");
  });

  // Strictly after; a message at the send's own time is the next block's.
  it("a message after the send settles it: one bubble, no note", () => {
    for (const offset of [0.001, 0.1, 1]) {
      const { store } = sentToTerminal();
      store.observe(key, timeline(userMessage("new", "yes", sent + offset)));
      expect(store.forPane(key)).toHaveLength(0);
    }
  });

  it("history just before and the send's own message after: it settles into its own, the history stays a message", () => {
    const { store } = sentToTerminal();
    store.observe(key, timeline(userMessage("history", "yes", sent - 0.5), userMessage("mine", "yes", sent + 0.4)));
    expect(store.forPane(key)).toHaveLength(0);
    expect(store.takeBack(key, "yes")).toBe(true);
    expect([...store.takenBackFor(key)]).toEqual(["mine"]);
  });

  it("a machine whose clock is behind keeps the acknowledgement (never a wrong settle)", () => {
    const { store } = sentToTerminal();
    store.observe(key, timeline(userMessage("mine-on-a-slow-clock", "yes", sent - 10)));
    expect(store.forPane(key)[0]?.state).toBe("terminalOnly");
  });

  it("two identical sends match in order; a take-back of the second hides the second", () => {
    const { store } = sentToTerminal();
    store.delivered(store.add(key, "yes", sentMs + 1_000, scope));
    store.observe(key, timeline(userMessage("first-send", "yes", sent + 0.1), userMessage("second-send", "yes", sent + 1.1)));
    expect(store.forPane(key)).toHaveLength(0);
    expect(store.takeBack(key, "yes")).toBe(true);
    expect([...store.takenBackFor(key)]).toEqual(["second-send"]);
    expect(store.takeBack(key, "yes")).toBe(true);
    expect([...store.takenBackFor(key)]).toEqual(["second-send", "first-send"]);
  });

  it("a second identical send never settles into the first send's message or the history before it", () => {
    const { store } = sentToTerminal();
    const second = store.add(key, "yes", sentMs + 1_000, scope);
    store.delivered(second);
    store.observe(key, timeline(userMessage("history", "yes", sent - 1), userMessage("first-send", "yes", sent + 0.1)));
    expect(store.forPane(key).map((message) => message.id)).toEqual([second]);
    expect(store.forPane(key)[0]!.state).toBe("terminalOnly");
    expect(terminalOnlyLabel).toContain("Sent to the terminal");
  });
});

// MARK: - The live menu only

describe("only Codex's whole live menu matches", () => {
  it("the exact screen, its ANSI-coloured form and its curly quote match; the marker may be on any one choice", () => {
    expect(showsCodexHookReview(hookReview)).toBe(true);
    expect(readStartScreen(hookReview, "codex")).toBe("codexHookReview");
    const coloured = hookReview
      .split("\n")
      .map((row) => (row.trim() === "" ? row : `\u001b[1m\u001b[36m${row}\u001b[0m`))
      .join("\n");
    expect(showsCodexHookReview(coloured)).toBe(true);
    expect(showsCodexHookReview(`\u001b[32m${hookReview}\u001b[0m`)).toBe(true);
    expect(showsCodexHookReview(hookReview.replace("won't", "won’t"))).toBe(true);
    expect(showsCodexHookReview(hookReview.replace("› 1. Review hooks", "  1. Review hooks").replace("  2. Trust all", "› 2. Trust all"))).toBe(true);
    expect(showsCodexHookReview(`$ codex\n\n${hookReview}\n\n\n`)).toBe(true);
  });

  it("a quotation of the menu without the marker is ordinary output", () => {
    expect(showsCodexHookReview(`The old log records this menu:\n${hookReview.replace("› 1.", "  1.")}`)).toBe(false);
  });

  it("the two-choice near miss with Codex's trust words is not the menu", () => {
    const near = "Hooks need review\nHere are two phrases from the docs:\n1. Trust all and continue\n2. Continue without trusting this example";
    expect(showsCodexHookReview(near)).toBe(false);
    expect(showsCodexHookReview(`${near}\n\n  enter confirm · esc skip`)).toBe(false);
  });

  it("a partial menu, other labels, two markers, no footer, or text after the footer is not the menu", () => {
    const without = (row: string) => hookReview.replace(`${row}\n`, "");
    expect(showsCodexHookReview(without("› 1. Review hooks"))).toBe(false);
    expect(showsCodexHookReview(without("  2. Trust all and continue"))).toBe(false);
    expect(showsCodexHookReview(without("  3. Continue without trusting (hooks won't run)"))).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("Continue without trusting (hooks won't run)", "Continue without trusting this example"))).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("Review hooks", "Review the hooks"))).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("  2. Trust all", "› 2. Trust all"))).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("› 1.", "> 1."))).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("  enter confirm · esc skip", ""))).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("enter confirm · esc skip", "enter confirm · esc skip · tab more"))).toBe(false);
    expect(showsCodexHookReview(`${hookReview}\n› Ask Codex to do anything`)).toBe(false);
    expect(showsCodexHookReview(`${hookReview}\n$ `)).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("  Hooks need review", "  The docs say Hooks need review"))).toBe(false);
    expect(showsCodexHookReview(hookReview.split("\n").slice(1).join("\n"))).toBe(false);
    expect(showsCodexHookReview(hookReview.replace("› 1. Review hooks", "› 1. Review hooks\n  4. Something else"))).toBe(false);
  });
});

// MARK: - a machine with the real services on a real HostRegistry

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

type PaneSpec = Parameters<typeof paneTopology>[0][number];

async function world(panes: PaneSpec[] = [{ id: "w1:p1", agent: "codex", terminal: "term1" }], listed = "current") {
  let now = 10_000;
  let topology = paneTopology(panes);
  const screens = new Map(panes.map((pane) => [pane.id, codexPrompt]));
  const calls: unknown[][] = [];
  let heldRead: ReturnType<typeof deferred<string>> | null = null;
  let heldSnapshot: ReturnType<typeof deferred<void>> | null = null;
  let failRead = false;
  let afterText: (() => void) | null = null;
  const client = new HerdrClient({
    async roundTrip(line: string) {
      const request = JSON.parse(line) as { id: number; method: string };
      calls.push([request.method]);
      return JSON.stringify({
        id: request.id,
        result: { type: "integration_list", integrations: [{ target: "codex", label: "Codex", command: "codex", state: listed, available: true }] },
      });
    },
    close() {},
  });
  const backend = {
    kind: "herdr-tui",
    snapshot: async () => {
      if (heldSnapshot !== null) await heldSnapshot.promise;
      return topology;
    },
    connectionEpoch: () => 1,
    integrations: () => client,
    paneText: async (paneId: string, lines: number) => {
      calls.push(["pane.read", paneId, lines]);
      if (failRead) throw new Error("read failed");
      if (heldRead !== null) return heldRead.promise;
      return screens.get(paneId) ?? "";
    },
    prompt: async (paneId: string, text: string) => {
      calls.push(["prompt", paneId, text]);
    },
    sendText: async (paneId: string, text: string) => {
      calls.push(["text", paneId, text]);
      afterText?.();
    },
    sendInput: async (paneId: string, text: string, keys: readonly string[]) => {
      calls.push(["input", paneId, text, keys]);
    },
    agentKeys: async (paneId: string, keys: readonly string[]) => {
      calls.push(["keys", paneId, keys]);
    },
    close() {},
  };
  let service: StartScreenService | null = null;
  let integrations: IntegrationService | null = null;
  const hosts = new HostRegistry(() => {
    service?.hostsChanged();
    integrations?.hostsChanged();
  });
  service = new StartScreenService(hosts, { now: () => now, every: () => () => undefined }, new PaneReadGate());
  integrations = new IntegrationService(hosts);
  hosts.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null }, backend as never);
  await hosts.refresh("mini");
  await flush();
  const host = () => hosts.list()[0]!;
  return {
    hosts,
    service,
    integrations,
    host,
    screens,
    calls,
    /** The clock moves on and the watch's timer ticks. */
    tick: async (ms = 2_500) => {
      now += ms;
      service!.hostsChanged();
      await flush();
    },
    setPanes: async (next: PaneSpec[]) => {
      topology = paneTopology(next);
      await hosts.refresh("mini");
      await flush();
    },
    holdRead: () => {
      const held = deferred<string>();
      heldRead = held;
      return (text: string) => {
        heldRead = null;
        held.resolve(text);
      };
    },
    holdSnapshot: () => {
      const held = deferred<void>();
      heldSnapshot = held;
      return () => {
        heldSnapshot = null;
        held.resolve();
      };
    },
    failReads: (value: boolean) => {
      failRead = value;
    },
    onText: (run: () => void) => {
      afterText = run;
    },
    reads: () => calls.filter((call) => call[0] === "pane.read"),
    writes: () => calls.filter((call) => ["prompt", "text", "input", "keys"].includes(call[0] as string)),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Chat's Send through main's real IPC handler, bound as the page saw the pane. */
function send(w: World, text: string, paneId = "w1:p1"): Promise<void> {
  registerIpc({ hosts: w.hosts, startScreens: w.service } as never);
  const pane = w.host().topology!.panes.find((candidate) => candidate.paneID === paneId)!;
  const binding = { terminalID: pane.terminalID, isAgent: true, kind: "codex", session: null, run: w.hosts.run("mini", paneId) };
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
  return registered.handles.get(IPC.paneSend)!(event, "mini", paneId, text, binding) as Promise<void>;
}

// MARK: - No Return into the hook review

describe("the Send checks the hook review inside its own turn", () => {
  it("a hook-screen read in flight when the Send starts: no write, no Return, the note, the draft kept", async () => {
    const w = await world();
    const release = w.holdRead();
    w.screens.set("w1:p1", hookReview);
    await w.tick();
    expect(w.service.shows("mini", "w1:p1")).toBe(false);
    const drafts = new ComposerDrafts({ transport: () => null });
    drafts.edit("mini/w1:p1", "/status");
    expect(sendDraft(drafts, (hostId, paneId, text) => send(w, text, paneId), "mini", "w1:p1")).toBe(true);
    await flush();
    release(hookReview);
    await flush();
    await flush();
    expect(w.writes()).toEqual([]);
    expect(drafts.get("mini/w1:p1").text).toBe("/status");
    expect(drafts.get("mini/w1:p1").error).toBe(startScreenTexts.notSent);
    expect(startScreenTexts.notSent).toBe("Not sent: Codex is asking whether to trust Herdr's hook in its terminal. The text is kept.");
  });

  it("a read that finishes while the Send waits on its snapshot: no write, no Return", async () => {
    const w = await world();
    const release = w.holdSnapshot();
    const sending = send(w, "/status");
    await flush();
    w.screens.set("w1:p1", hookReview);
    await w.tick();
    expect(w.service.shows("mini", "w1:p1")).toBe(true);
    release();
    await expect(sending).rejects.toThrow(startScreenTexts.notSent);
    expect(w.writes()).toEqual([]);
  });

  it("the screen turning to the review only for the Send's own read (the watch saw none): no write", async () => {
    const w = await world();
    const release = w.holdSnapshot();
    const sending = send(w, "hello");
    await flush();
    w.screens.set("w1:p1", hookReview);
    release();
    await expect(sending).rejects.toThrow(startScreenTexts.notSent);
    expect(w.writes()).toEqual([]);
    // The Send's read marks the pane as needing you at once.
    expect(w.host().startScreens?.panes.map((pane) => pane.paneId)).toEqual(["w1:p1"]);
  });

  it("a read that fails refuses the Send (nothing written)", async () => {
    const w = await world();
    w.failReads(true);
    await expect(send(w, "hello")).rejects.toThrow(startScreenTexts.notSent);
    expect(w.writes()).toEqual([]);
  });

  it("the review read between the command's text and its Return: no Return", async () => {
    const w = await world();
    let release: (() => void) | null = null;
    // The Send's snapshot after its text is held, so a read can answer before its Return.
    w.onText(() => {
      release = w.holdSnapshot();
    });
    const sending = send(w, "/status");
    await flush();
    expect(w.writes()).toEqual([["text", "w1:p1", "/status"]]);
    // A read after the text shows the review (as if the text had gone into it): the Return must not go.
    w.screens.set("w1:p1", hookReview);
    await w.tick();
    expect(w.service.shows("mini", "w1:p1")).toBe(true);
    release!();
    await expect(sending).rejects.toThrow(guardTexts.noReturn("codex", hookReviewWhy));
    expect(w.writes().filter((call) => call[0] === "keys")).toEqual([]);
  });

  it("a normal screen: the Send goes after its own read; a pane with a session is not read for it", async () => {
    const w = await world();
    const before = w.reads().length;
    await send(w, "hello");
    expect(w.reads().length).toBe(before + 1);
    expect(w.writes()).toEqual([["prompt", "w1:p1", "hello"]]);

    const named = await world([{ id: "w1:p1", agent: "codex", terminal: "term1", session: "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84" }]);
    registerIpc({ hosts: named.hosts, startScreens: named.service } as never);
    const pane = named.host().topology!.panes[0]!;
    const binding = { terminalID: pane.terminalID, isAgent: true, kind: "codex", session: "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84", run: named.hosts.run("mini", "w1:p1") };
    await registered.handles.get(IPC.paneSend)!({ senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } }, "mini", "w1:p1", "hello", binding);
    expect(named.reads()).toEqual([]);
    expect(named.writes()).toEqual([["prompt", "w1:p1", "hello"]]);
  });
});

// MARK: - No promise after declining trust

describe("a pane that showed the hook review gets no first-message promise until its session is named", () => {
  const firstMessage = "Chat shows Codex's replies after your first message.";
  const hookOff =
    "If you chose Continue without trusting, Codex's hook is off: quit Codex in its terminal, then start it again with New agent and choose Trust all and continue.";

  it("Continue without trusting (option 3): the review goes, Chat gives the conservative line, never the promise", async () => {
    const w = await world();
    w.integrations.agentStarted(w.integrations.startToken("mini", "codex")!, "w1:p1", "codex");
    expect(chatIntegrationLook(w.host(), "codex", null, false, "w1:p1")?.line).toBe(firstMessage);
    w.screens.set("w1:p1", hookReview);
    await w.tick();
    expect(applyStartScreens([w.host()])[0]!.topology!.panes[0]!.agentStatus).toBe("blocked");
    // The user chose option 3 in the terminal: Codex's ordinary prompt, its hooks off, no session ever named.
    w.screens.set("w1:p1", codexPrompt);
    await w.tick();
    expect(w.host().startScreens).toBeUndefined();
    const look = chatIntegrationLook(w.host(), "codex", null, false, "w1:p1");
    expect(look?.line).toBe(hookOff);
    expect(look?.line).not.toContain("after your first message");
    expect(look?.button).toBeNull();
    expect(integrationTexts.hookOff("Codex")).toBe(hookOff);
    expect(hookOff.includes("—")).toBe(false);
    // A first message that ran (working, then idle) with no session named: still no promise.
    await w.setPanes([{ id: "w1:p1", agent: "codex", terminal: "term1" }]);
    await w.tick(60_000);
    expect(chatIntegrationLook(w.host(), "codex", null, false, "w1:p1")?.line).toBe(hookOff);
    // Nothing was ever written to the pane.
    expect(w.writes()).toEqual([]);
  });

  it("clearing the screen is not trust; the session named is: then the started-after mark comes back", async () => {
    const w = await world();
    w.integrations.agentStarted(w.integrations.startToken("mini", "codex")!, "w1:p1", "codex");
    w.screens.set("w1:p1", hookReview);
    await w.tick();
    w.screens.set("w1:p1", "");
    await w.tick();
    expect(w.host().integrations?.startedAfter).toBeUndefined();
    expect(w.host().integrations?.hookReviewed).toEqual({ codex: ["w1:p1"] });
    await w.setPanes([{ id: "w1:p1", agent: "codex", terminal: "term1", session: "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84" }]);
    expect(w.host().integrations?.hookReviewed).toBeUndefined();
    expect(w.host().integrations?.startedAfter).toEqual({ codex: ["w1:p1"] });
  });

  it("New agent marking a pane that already showed the review does not bring the promise back; another pane keeps it", async () => {
    const w = await world([
      { id: "w1:p1", agent: "codex", terminal: "term1" },
      { id: "w1:p2", agent: "codex", terminal: "term2" },
    ]);
    w.screens.set("w1:p1", hookReview);
    await w.tick();
    const token = w.integrations.startToken("mini", "codex")!;
    w.integrations.agentStarted(token, "w1:p1", "codex");
    w.integrations.agentStarted(token, "w1:p2", "codex");
    expect(chatIntegrationLook(w.host(), "codex", null, false, "w1:p1")?.line).toBe(hookOff);
    expect(chatIntegrationLook(w.host(), "codex", null, false, "w1:p2")?.line).toBe(firstMessage);
  });

  it("a reviewed pane that goes (or runs another agent) gets no mark back", async () => {
    const w = await world();
    w.integrations.agentStarted(w.integrations.startToken("mini", "codex")!, "w1:p1", "codex");
    w.screens.set("w1:p1", hookReview);
    await w.tick();
    await w.setPanes([{ id: "w1:p1", agent: "claude", terminal: "term1" }]);
    expect(w.host().integrations?.hookReviewed).toBeUndefined();
    expect(w.host().integrations?.startedAfter).toBeUndefined();
  });
});
