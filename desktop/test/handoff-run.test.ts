// Send to… (⌘Return) keeps the picked connection and run all the way to
// the main process: the host
// registry counts its own connections and each pane's agent runs (PaneLife in
// main) and publishes them with each machine; a pick carries the numbers the
// row showed; sendBound compares them on its fresh snapshot, right before it
// writes. A reconnect or an exit and start with the same terminal, kind and
// session while the send waits is refused, nothing written, the text copied.
// The fixtures are a fake backend and the real HostRegistry and sendBound.

import { describe, expect, it, vi } from "vitest";

import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { sendBound, type SendSite } from "../src/main/herdr/send";
import type { SessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { HandoffRecents, handoffList, listRows, type HandoffPayload } from "../src/shared/handoff";
import { isSendBinding, type SendBinding } from "../src/shared/send-binding";
import { ComposerDrafts } from "../src/renderer/components/composer-drafts";
import { HandoffStore, bindingOfPick, deliverHandoff } from "../src/renderer/handoff/handoff-state";
import { paneTopology } from "./support/pane-topology";

const session = "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b";
const withCodex = paneTopology([
  { id: "p-source", agent: "claude", session },
  { id: "p-target", agent: "codex", session, terminal: "t2" },
]);
const codexGone = paneTopology([{ id: "p-source", agent: "claude", session }, { id: "p-target", terminal: "t2" }]);

/** A machine whose answers the test sets (null: it does not answer). */
class FakeBackend {
  answer: SessionTopology | null = withCodex;
  readonly writes: string[] = [];
  snapshot(): Promise<SessionTopology> {
    return this.answer === null ? Promise.reject(new Error("offline")) : Promise.resolve(this.answer);
  }
  prompt(paneID: string, text: string): Promise<void> {
    this.writes.push(`prompt ${paneID} ${text}`);
    return Promise.resolve();
  }
  sendInput(): Promise<void> {
    return Promise.resolve();
  }
  sendText(): Promise<void> {
    return Promise.resolve();
  }
  agentKeys(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {}
}

async function machine() {
  const backend = new FakeBackend();
  const store = new HandoffStore();
  const registry = new HostRegistry((hosts) => store.setHosts(hosts));
  registry.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null }, backend as unknown as HerdrHostBackend);
  await registry.refresh("mini");
  return { backend, store, registry };
}

const site = (registry: HostRegistry, backend: FakeBackend, during: () => Promise<void> = async () => undefined): SendSite => ({
  writer: backend,
  fresh: async () => {
    await during();
    return registry.fresh("mini");
  },
  pane: () => registry.pane("mini", "p-target"),
  agent: () => registry.agent("mini", "p-target"),
  run: () => registry.run("mini", "p-target"),
});

const payload: HandoffPayload = {
  text: "fixture hand-off",
  kind: { type: "reply" },
  source: { hostId: "mini", paneId: "p-source", name: "claude", kind: "claude", workspace: "app", macName: "Mac mini" },
};
const targetOf = (store: HandoffStore) => listRows(handoffList(store.macs(), null, [], "")).find((row) => row.paneId === "p-target")!;

function deliveryDeps(store: HandoffStore, send: (hostId: string, paneId: string, text: string, binding: SendBinding) => Promise<void>) {
  return { store, drafts: new ComposerDrafts(), recents: new HandoffRecents(null), copy: vi.fn(), open: vi.fn(), send };
}

describe("the host registry's own connection and run counts", () => {
  it("each machine carries its connection generation and each pane's agent run", async () => {
    const { backend, registry } = await machine();
    expect(registry.list()[0]!.run).toEqual({ connection: 1, arrivals: { "p-source": 1, "p-target": 1 } });
    expect(registry.run("mini", "p-target")).toEqual({ connection: 1, arrival: 1 });
    backend.answer = codexGone;
    await registry.refresh("mini");
    backend.answer = withCodex;
    await registry.refresh("mini");
    expect(registry.run("mini", "p-target")).toEqual({ connection: 1, arrival: 2 });
    backend.answer = null;
    await registry.refresh("mini");
    expect(registry.run("mini", "p-target")).toBeNull();
    backend.answer = withCodex;
    await registry.refresh("mini");
    expect(registry.run("mini", "p-target")).toEqual({ connection: 2, arrival: 2 });
  });

  it("a pick's binding carries the numbers its row showed; the IPC check takes them", async () => {
    const { store } = await machine();
    const binding = bindingOfPick(targetOf(store));
    expect(binding).toEqual({ terminalID: "t2", isAgent: true, kind: "codex", session, run: { connection: 1, arrival: 1 } });
    expect(isSendBinding(binding)).toBe(true);
    expect(isSendBinding({ ...binding, run: { connection: -1, arrival: 1 } })).toBe(false);
    expect(isSendBinding({ ...binding, run: { connection: 1, arrival: 1.5 } })).toBe(false);
    expect(isSendBinding({ ...binding, run: "1:1" })).toBe(false);
  });
});

describe("Send now: the main process checks the picked connection and run before it writes", () => {
  it("the same run on the same connection: written once", async () => {
    const { backend, store, registry } = await machine();
    const deps = deliveryDeps(store, (_hostId, paneId, text, binding) => sendBound(site(registry, backend), paneId, text, binding));
    await deliverHandoff(deps, payload, targetOf(store), "sendNow");
    expect(backend.writes).toHaveLength(1);
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it("the agent exited and started again (same terminal, kind and session) while the send waited: nothing written, the text copied", async () => {
    const { backend, store, registry } = await machine();
    const picked = targetOf(store);
    const deps = deliveryDeps(store, (_hostId, paneId, text, binding) =>
      sendBound(
        site(registry, backend, async () => {
          backend.answer = codexGone;
          await registry.refresh("mini");
          backend.answer = withCodex;
        }),
        paneId,
        text,
        binding,
      ),
    );
    await deliverHandoff(deps, payload, picked, "sendNow");
    expect(backend.writes).toEqual([]);
    expect(deps.copy).toHaveBeenCalledOnce();
    expect(deps.drafts.get("mini/p-target").text).toBe("");
    expect(store.toast()).toMatchObject({
      text: "Not sent to codex in app. Codex in this pane is not the one you picked (it started again or the machine reconnected). The text is copied.",
      target: null,
    });
  });

  it("the machine reconnected while the send waited: nothing written, the text copied", async () => {
    const { backend, store, registry } = await machine();
    const picked = targetOf(store);
    const deps = deliveryDeps(store, (_hostId, paneId, text, binding) =>
      sendBound(
        site(registry, backend, async () => {
          backend.answer = null;
          await registry.refresh("mini");
          backend.answer = withCodex;
        }),
        paneId,
        text,
        binding,
      ),
    );
    await deliverHandoff(deps, payload, picked, "sendNow");
    expect(backend.writes).toEqual([]);
    expect(deps.copy).toHaveBeenCalledOnce();
  });

  it("a binding with a run on a site that cannot tell its run now: refused", async () => {
    const { backend, store, registry } = await machine();
    const binding = bindingOfPick(targetOf(store));
    const { run: _run, ...blind } = site(registry, backend);
    await expect(sendBound(blind, "p-target", "fixture", binding)).rejects.toThrow(/not the one you picked/);
    expect(backend.writes).toEqual([]);
  });
});

// MARK: - a stale refusal at the final gate lands nowhere

import { guardTexts } from "../src/main/herdr/send";

describe("a refusal because the pane changed copies the text and lands it in no box", () => {
  const staleNotes = [
    guardTexts.exited("codex"),
    guardTexts.paneGone,
    guardTexts.otherProgram,
    guardTexts.changedAgent,
    guardTexts.agentStarted,
    "Error invoking remote method 'herdr:pane-send': Error: codex exited; not sent",
  ];

  it.each(staleNotes)("main says %j: copied, nothing in the box, no Open", async (note) => {
    const { store } = await machine();
    const deps = deliveryDeps(store, () => Promise.reject(new Error(note)));
    await deliverHandoff(deps, payload, targetOf(store), "sendNow");
    expect(deps.copy).toHaveBeenCalledWith(expect.stringContaining("fixture hand-off"));
    expect(deps.drafts.get("mini/p-target").text).toBe("");
    expect(store.toast()?.target).toBeNull();
    expect(store.toast()?.text).toMatch(/The text is copied\.$/);
  });

  it("the page sees the pane changed by the time an ordinary refusal comes back (Codex became a shell): copied, not in the shell's box", async () => {
    const { backend, store, registry } = await machine();
    const deps = deliveryDeps(store, async () => {
      backend.answer = codexGone;
      await registry.refresh("mini");
      throw new Error(guardTexts.uncheckedPane);
    });
    await deliverHandoff(deps, payload, targetOf(store), "sendNow");
    expect(deps.copy).toHaveBeenCalledOnce();
    expect(deps.drafts.get("mini/p-target").text).toBe("");
    expect(store.toast()?.target).toBeNull();
  });

  it("an ordinary refusal on the pane as picked still keeps the text in its box (with Open)", async () => {
    const { store } = await machine();
    const deps = deliveryDeps(store, () => Promise.reject(new Error(guardTexts.unchecked("codex"))));
    await deliverHandoff(deps, payload, targetOf(store), "sendNow");
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.drafts.get("mini/p-target").text).toContain("fixture hand-off");
    expect(store.toast()?.target).not.toBeNull();
  });

  it("an unanswered write is never put in a box, whatever the pane shows", async () => {
    const { store } = await machine();
    const deps = deliveryDeps(store, () => Promise.reject(new Error("The Mac did not answer; the message may have been sent.")));
    await deliverHandoff(deps, payload, targetOf(store), "sendNow");
    expect(deps.drafts.get("mini/p-target").text).toBe("");
    expect(deps.copy).not.toHaveBeenCalled();
  });
});

// MARK: - a hand-off send always carries a run

describe("a hand-off's Send always carries the run its row showed", () => {
  it("a machine view without the main process's counts: the binding carries the row's own, and a site that cannot tell its run refuses", async () => {
    const store = new HandoffStore();
    const view = { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "fixture", platform: null, state: "connected" as const, error: null, fetchedAtMs: 0, topology: withCodex };
    store.setHosts([view]);
    const binding = bindingOfPick(targetOf(store));
    expect(binding.run).toEqual({ connection: 1, arrival: 1 });
    const backend = new FakeBackend();
    const blind: SendSite = { writer: backend, fresh: async () => true, pane: () => withCodex.panes[1]!, agent: () => withCodex.agents[1]! };
    const deps = deliveryDeps(store, (_hostId, paneId, text, b) => sendBound(blind, paneId, text, b));
    await deliverHandoff(deps, payload, targetOf(store), "sendNow");
    expect(backend.writes).toEqual([]);
    expect(deps.copy).toHaveBeenCalledOnce();
    expect(deps.drafts.get("mini/p-target").text).toBe("");
  });
});
