// How a Send settles around Codex's hook review screen and its bubble:
// - What clears a Send's write and its Return is the newest read of
//   the pane asked for, not the newest that answered: while a newer read is
//   out the Send waits; one that fails or shows the review takes no write and
//   no Return.
// - The hook-review bookkeeping settles in one pass with main.ts's
//   real callback order (integrations before start screens) through the real
//   HostRegistry, and with 65 review marks: no RangeError, one publish per real
//   change, the same 64 kept.
// - A transcript message settles a no-session bubble only when it is
//   timed strictly after the send; equal time keeps the acknowledgement.
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
import { IntegrationService, maxStartedAfter } from "../src/main/integrations";
import { StartScreenService } from "../src/main/start-screens";
import { hookReviewWhy, guardTexts } from "../src/main/herdr/send";
import { PaneReadGate } from "../src/shared/chat/live-reader";
import { PendingMessages, terminalOnlyLabel } from "../src/shared/chat/pending";
import { emptyTimeline, makeTurn, userMessage, type ChatUserMessage } from "../src/shared/chat/model";
import { startScreenTexts, type HostStartScreens } from "../src/shared/prompt/start-screen";
import { chatIntegrationLook } from "../src/renderer/components/integrations";
import { paneTopology } from "./support/pane-topology";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
};

/** Codex 0.167.0's hook review, word for word. */
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

const sessionId = "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type PaneSpec = Parameters<typeof paneTopology>[0][number];

const codexPanes = (count: number): PaneSpec[] => Array.from({ length: count }, (_, i) => ({ id: `w1:p${i + 1}`, agent: "codex", terminal: `term${i + 1}` }));

/**
 * A machine with the real services on a real HostRegistry. `order`: "main" is main.ts's callback order
 * (integrations.hostsChanged, then startScreens.hostsChanged); "screensFirst" the reverse.
 */
async function world(panes: PaneSpec[] = codexPanes(1), order: "main" | "screensFirst" = "main") {
  let now = 10_000;
  let topology = paneTopology(panes);
  const screens = new Map(panes.map((pane) => [pane.id, codexPrompt]));
  const calls: unknown[][] = [];
  /** Held reads: each read while holding waits for its own answer. */
  let holding = false;
  const held: ReturnType<typeof deferred<string>>[] = [];
  let textGate: Promise<void> | null = null;
  const client = new HerdrClient({
    async roundTrip(line: string) {
      const request = JSON.parse(line) as { id: number; method: string };
      calls.push([request.method]);
      return JSON.stringify({
        id: request.id,
        result: { type: "integration_list", integrations: [{ target: "codex", label: "Codex", command: "codex", state: "current", available: true }] },
      });
    },
    close() {},
  });
  const backend = {
    kind: "herdr-tui",
    snapshot: async () => topology,
    connectionEpoch: () => 1,
    integrations: () => client,
    paneText: async (paneId: string, lines: number) => {
      calls.push(["pane.read", paneId, lines]);
      if (holding) {
        const read = deferred<string>();
        held.push(read);
        return read.promise;
      }
      return screens.get(paneId) ?? "";
    },
    prompt: async (paneId: string, text: string) => {
      calls.push(["prompt", paneId, text]);
    },
    sendText: async (paneId: string, text: string) => {
      calls.push(["text", paneId, text]);
      if (textGate !== null) await textGate;
    },
    agentKeys: async (paneId: string, keys: readonly string[]) => {
      calls.push(["keys", paneId, keys]);
    },
    close() {},
  };
  let service: StartScreenService | null = null;
  let integrations: IntegrationService | null = null;
  const hosts = new HostRegistry(() => {
    if (order === "main") {
      integrations?.hostsChanged();
      service?.hostsChanged();
    } else {
      service?.hostsChanged();
      integrations?.hostsChanged();
    }
  });
  // Every publish of the machine's integrations (the tests count them).
  let publishes = 0;
  const setIntegrations = hosts.setIntegrations.bind(hosts);
  hosts.setIntegrations = (id, value) => {
    publishes += 1;
    if (publishes > 1_000) throw new Error("fixture: endless publishing");
    setIntegrations(id, value);
  };
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
    held,
    publishes: () => publishes,
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
    setTopology: (next: PaneSpec[]) => {
      topology = paneTopology(next);
    },
    hold: (value: boolean) => {
      holding = value;
    },
    /** The next text writes wait until the returned function is called. */
    holdText: () => {
      const gate = deferred<void>();
      textGate = gate.promise;
      return () => {
        textGate = null;
        gate.resolve();
      };
    },
    reads: () => calls.filter((call) => call[0] === "pane.read"),
    writes: () => calls.filter((call) => ["prompt", "text", "keys"].includes(call[0] as string)),
    keys: () => calls.filter((call) => call[0] === "keys"),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Chat's Send through main's real IPC handler, bound as the page saw the pane; its outcome as words. */
function send(w: World, text: string, paneId = "w1:p1"): Promise<string> {
  registerIpc({ hosts: w.hosts, startScreens: w.service } as never);
  const pane = w.host().topology!.panes.find((candidate) => candidate.paneID === paneId)!;
  const binding = { terminalID: pane.terminalID, isAgent: true, kind: "codex", session: null, run: w.hosts.run("mini", paneId) };
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
  return (registered.handles.get(IPC.paneSend)!(event, "mini", paneId, text, binding) as Promise<void>).then(
    () => "sent",
    (error: Error) => error.message,
  );
}

const hookScreens = (w: World, count: number): HostStartScreens => {
  const host = w.host();
  return {
    incarnation: host.incarnation!,
    connection: host.connection!,
    epoch: host.epoch ?? null,
    panes: Array.from({ length: count }, (_, i) => ({ paneId: `w1:p${i + 1}`, terminalID: `term${i + 1}`, kind: "codexHookReview" as const })),
  };
};

// MARK: - A newer read out or failed blocks the write and the Return

describe("the newest read asked for decides, not the newest that answered", () => {
  it("the review appears while the command's text write waits and a newer watch read is out: no Return until it answers, then none", async () => {
    const w = await world();
    const releaseText = w.holdText();
    const sending = send(w, "/status");
    await flush();
    expect(w.writes()).toEqual([["text", "w1:p1", "/status"]]);
    // The screen turns to the review; the watch's next read goes out and does not answer yet.
    w.screens.set("w1:p1", hookReview);
    w.hold(true);
    await w.tick();
    expect(w.held).toHaveLength(1);
    const reads = w.reads().length;
    releaseText();
    await flush();
    // The older clear answer (the Send's own read) is no permission while the newer read is out.
    expect(w.keys()).toEqual([]);
    w.held[0]!.resolve(hookReview);
    expect(await sending).toBe(guardTexts.noReturn("codex", hookReviewWhy));
    expect(w.keys()).toEqual([]);
    // The Send read nothing more itself.
    expect(w.reads().length).toBe(reads);
  });

  it("the same with the newer watch read failing: no Return", async () => {
    const w = await world();
    const releaseText = w.holdText();
    const sending = send(w, "/status");
    await flush();
    w.hold(true);
    await w.tick();
    expect(w.held).toHaveLength(1);
    w.held[0]!.reject(new Error("fixture read failed"));
    await flush();
    releaseText();
    expect(await sending).toBe(guardTexts.noReturn("codex", hookReviewWhy));
    expect(w.keys()).toEqual([]);
  });

  it("the same with the newer watch read failing while the text write still waits: no Return", async () => {
    const w = await world();
    const releaseText = w.holdText();
    const sending = send(w, "/status");
    await flush();
    w.hold(true);
    await w.tick();
    releaseText();
    await flush();
    expect(w.keys()).toEqual([]);
    w.held[0]!.reject(new Error("fixture read failed"));
    expect(await sending).toBe(guardTexts.noReturn("codex", hookReviewWhy));
    expect(w.keys()).toEqual([]);
  });

  it("a newer watch read that answers the ordinary prompt lets the Return go (waited for, not refused)", async () => {
    const w = await world();
    const releaseText = w.holdText();
    const sending = send(w, "/status");
    await flush();
    w.hold(true);
    await w.tick();
    releaseText();
    await flush();
    expect(w.keys()).toEqual([]);
    w.held[0]!.resolve(codexPrompt);
    expect(await sending).toBe("sent");
    expect(w.keys()).toEqual([["keys", "w1:p1", ["Enter"]]]);
  });

  it("a watch read queued behind the Send's own read is waited for before the write: the review there, nothing written", async () => {
    const w = await world();
    w.hold(true);
    const sending = send(w, "hello");
    await flush();
    expect(w.held).toHaveLength(1);
    // The watch's tick asks for a newer read; the shared gate queues it behind the Send's.
    await w.tick();
    w.held[0]!.resolve(codexPrompt);
    await flush();
    expect(w.held).toHaveLength(2);
    expect(w.writes()).toEqual([]);
    w.held[1]!.resolve(hookReview);
    expect(await sending).toBe(startScreenTexts.notSent);
    expect(w.writes()).toEqual([]);
  });

  it("the same newer read failing: nothing written, the Not sent note", async () => {
    const w = await world();
    w.hold(true);
    const sending = send(w, "hello");
    await flush();
    await w.tick();
    w.held[0]!.resolve(codexPrompt);
    await flush();
    w.held[1]!.reject(new Error("fixture read failed"));
    expect(await sending).toBe(startScreenTexts.notSent);
    expect(w.writes()).toEqual([]);
  });

  it("the same newer read showing the ordinary prompt: the Send goes", async () => {
    const w = await world();
    w.hold(true);
    const sending = send(w, "hello");
    await flush();
    await w.tick();
    w.held[0]!.resolve(codexPrompt);
    await flush();
    w.held[1]!.resolve(codexPrompt);
    expect(await sending).toBe("sent");
    expect(w.writes()).toEqual([["prompt", "w1:p1", "hello"]]);
  });
});

// MARK: - The hook-review bookkeeping settles in one pass

describe("hook-review bookkeeping is idempotent with main.ts's callback order", () => {
  it("a reviewed pane getting its session with the production callback order: no RangeError, the started-after mark back, one publish", async () => {
    const w = await world();
    w.integrations.agentStarted(w.integrations.startToken("mini", "codex")!, "w1:p1", "codex");
    w.screens.set("w1:p1", hookReview);
    await w.tick();
    expect(w.host().integrations?.hookReviewed).toEqual({ codex: ["w1:p1"] });
    expect(w.host().integrations?.startedAfter).toBeUndefined();
    w.screens.set("w1:p1", codexPrompt);
    // The session appears while StartScreenService still holds its review mark (it hears of it second).
    w.setTopology([{ id: "w1:p1", agent: "codex", terminal: "term1", session: sessionId }]);
    const before = w.publishes();
    await expect(w.hosts.refresh("mini")).resolves.toBeUndefined();
    await flush();
    expect(w.publishes() - before).toBe(1);
    expect(w.host().integrations?.hookReviewed).toBeUndefined();
    expect(w.host().integrations?.startedAfter).toEqual({ codex: ["w1:p1"] });
    expect(w.host().startScreens).toBeUndefined();
    expect(chatIntegrationLook(w.host(), "codex", sessionId, false, "w1:p1")?.line ?? null).not.toContain("Continue without trusting");
  });

  it("a stale screen mark for a pane with a named session, another terminal or another kind adds nothing and publishes nothing", async () => {
    const w = await world([
      { id: "w1:p1", agent: "codex", terminal: "term1", session: sessionId },
      { id: "w1:p2", agent: "codex", terminal: "replacement" },
      { id: "w1:p3", agent: "claude", terminal: "term3" },
    ]);
    const before = w.publishes();
    expect(() => w.hosts.setStartScreens("mini", hookScreens(w, 3))).not.toThrow();
    expect(w.publishes() - before).toBe(0);
    expect(w.host().integrations?.hookReviewed).toBeUndefined();
  });

  it("65 review marks: no RangeError, the first 64 kept, one publish, and none on the same screens again", async () => {
    const w = await world(codexPanes(65));
    const token = w.integrations.startToken("mini", "codex")!;
    w.integrations.agentStarted(token, "w1:p65", "codex");
    expect(w.host().integrations?.startedAfter).toEqual({ codex: ["w1:p65"] });
    const before = w.publishes();
    expect(() => w.hosts.setStartScreens("mini", hookScreens(w, 65))).not.toThrow();
    expect(w.publishes() - before).toBe(1);
    const kept = w.host().integrations?.hookReviewed?.codex ?? [];
    expect(kept).toHaveLength(maxStartedAfter);
    expect(kept).toEqual(Array.from({ length: 64 }, (_, i) => `w1:p${i + 1}`));
    // The 65th showed the review too: it loses the promise even though it is not kept.
    expect(w.host().integrations?.startedAfter).toBeUndefined();
    // The same screens again (and another pass of the machines): no evict and re-add, nothing published.
    const again = w.publishes();
    w.hosts.setStartScreens("mini", { ...hookScreens(w, 65) });
    w.integrations.hostsChanged();
    expect(w.publishes() - again).toBe(0);
    expect(w.host().integrations?.hookReviewed?.codex).toEqual(kept);
  });

  it("the reverse order settles the same way", async () => {
    const w = await world(codexPanes(1), "screensFirst");
    w.integrations.agentStarted(w.integrations.startToken("mini", "codex")!, "w1:p1", "codex");
    w.screens.set("w1:p1", hookReview);
    await w.tick();
    w.screens.set("w1:p1", codexPrompt);
    await w.setPanes([{ id: "w1:p1", agent: "codex", terminal: "term1", session: sessionId }]);
    expect(w.host().integrations?.hookReviewed).toBeUndefined();
    expect(w.host().integrations?.startedAfter).toEqual({ codex: ["w1:p1"] });
  });

  it("a reviewed pane whose terminal was replaced goes with no mark back", async () => {
    const w = await world();
    w.integrations.agentStarted(w.integrations.startToken("mini", "codex")!, "w1:p1", "codex");
    w.screens.set("w1:p1", hookReview);
    await w.tick();
    await w.setPanes([{ id: "w1:p1", agent: "codex", terminal: "replacement", session: sessionId }]);
    expect(w.host().integrations?.hookReviewed).toBeUndefined();
    expect(w.host().integrations?.startedAfter).toBeUndefined();
  });
});

// MARK: - Equal time is no proof

describe("a message timed at the send's own time never settles its bubble", () => {
  const key = "mini/w1:p1";
  const scope = { terminalID: "term1", session: null };
  const sentMs = 1_800_000_000_000;
  const sent = sentMs / 1_000;
  const timeline = (...messages: ChatUserMessage[]) => ({
    ...emptyTimeline,
    turns: [makeTurn("turn", { items: messages.map((value) => ({ type: "user" as const, value })), isFinished: true })],
  });
  function sentToTerminal() {
    const store = new PendingMessages();
    const id = store.add(key, "yes", sentMs, scope);
    store.delivered(id);
    store.reconcile(new Map([[key, { terminalID: "term1", session: "s-1" }]]), () => true);
    return { store, id };
  }

  it("equal-time history alone: the bubble stays with its acknowledgement", () => {
    const { store, id } = sentToTerminal();
    store.observe(key, timeline(userMessage("historical-yes", "yes", sent)));
    expect(store.forPane(key).map((bubble) => bubble.id)).toEqual([id]);
    expect(store.forPane(key)[0]!.state).toBe("terminalOnly");
    expect(terminalOnlyLabel).toContain("Sent to the terminal");
  });

  it("equal-time history and the real message at T + 0.1 s: it settles into the real one; take-back hides the real one", () => {
    const { store } = sentToTerminal();
    store.observe(key, timeline(userMessage("historical-yes", "yes", sent), userMessage("actual-send", "yes", sent + 0.1)));
    expect(store.forPane(key)).toEqual([]);
    expect(store.takeBack(key, "yes")).toBe(true);
    expect([...store.takenBackFor(key)]).toEqual(["actual-send"]);
  });

  it("a real message just after (1 ms) still settles; one before stays", () => {
    const after = sentToTerminal();
    after.store.observe(key, timeline(userMessage("actual-send", "yes", sent + 0.001)));
    expect(after.store.forPane(key)).toEqual([]);
    const before = sentToTerminal();
    before.store.observe(key, timeline(userMessage("actual-send", "yes", sent - 0.001)));
    expect(before.store.forPane(key)[0]?.state).toBe("terminalOnly");
  });
});
