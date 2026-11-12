// The desktop model where it meets the showcase, the terminal's selection copy
// and the bound Send to… from splits and tiles. The capture steps keep one number and one file each; the
// showcase's chips and ring read its own invented sessions (the same numbers
// for the same clock); a Send to… queued behind another Send on the same pane
// (the per-pane queue) is still checked against the run it was picked on.
// (The ring's screen read beside term-copy's selection copy is in
// merge-model-terminal.test.ts: it needs ghostty-web's engine.)

import { describe, expect, it, vi } from "vitest";

import { demoCaptureSteps } from "../src/main/capture";
import { ChatService } from "../src/main/chat/service";
import { DemoBackend, type DemoClock } from "../src/main/demo/demo-backend";
import { demoHostIds } from "../src/main/demo/demo-hosts";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { sendBound, type SendSite } from "../src/main/herdr/send";
import type { SessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { showcaseHosts, showcaseHostIds, showcaseHeroTab } from "../src/main/showcase/showcase-hosts";
import { contextView } from "../src/shared/context-meter";
import { HandoffRecents, handoffList, listRows, type HandoffPayload } from "../src/shared/handoff";
import { bindingOf, type SendBinding } from "../src/shared/send-binding";
import { ComposerDrafts } from "../src/renderer/components/composer-drafts";
import { HandoffStore, bindingOfPick, deliverHandoff } from "../src/renderer/handoff/handoff-state";
import { eventually } from "./support/chat-lines";
import { paneTopology } from "./support/pane-topology";

describe("the capture steps after the merge", () => {
  const steps = demoCaptureSteps(demoHostIds);
  const names = steps.map((step) => step.name);

  it("each has its own number and file, 01 to 40 in order (New workspace: 39, 40)", () => {
    expect(new Set(names).size).toBe(names.length);
    // runCaptures writes `${name}.png`.
    expect(new Set(names.map((name) => `${name}.png`)).size).toBe(names.length);
    const numbers = names.map((name) => Number(/^(\d{2})-/.exec(name)?.[1]));
    expect(numbers).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("term-copy's step is 36 after splits' 35; model's chips and card are 37 and 38", () => {
    // New workspace's 39 and 40 follow.
    expect(names.slice(34, 38)).toEqual(["35-new-agent-where", "36-terminal-copied", "37-model-effort-chips", "38-context-card"]);
    // Step 36 closes step 35's New agent dialog; step 37 has no dialog left to cancel.
    expect(steps[35]!.commands[0]).toEqual({ type: "click", selector: ".scrim" });
    expect(steps[36]!.commands.some((command) => command.type === "click" && command.selector.startsWith(".df"))).toBe(false);
    // Step 37 brings the chips' pane back in Chat after step 36's terminal on build-box.
    expect(steps[36]!.commands).toContainEqual({ type: "select-pane", hostId: demoHostIds.macMini, paneId: "w7:p1H" });
    expect(steps[36]!.commands).toContainEqual({ type: "set-tab", tab: "chat" });
  });
});

const start = 1_800_000_000_000;
const stillClock: DemoClock = { schedule: () => () => undefined };

interface Settings {
  model: string | null;
  modelLabel: string | null;
  effort: string | null;
  used: number | null;
  window: number | null;
  limits: never;
}

/** The chips' and the ring's values each showcase agent pane's chat carries, the clock held at `nowMs`. */
async function showcaseSettings(nowMs: number): Promise<Map<string, Settings>> {
  const now = () => nowMs;
  const registry = new HostRegistry(() => undefined, now);
  for (const host of showcaseHosts(start, now)) registry.add(host.descriptor, new DemoBackend(host, null, stillClock, now));
  await registry.refreshAll();
  const service = new ChatService(registry, "chat", { pollIntervalMs: 5 }, { now });
  const out = new Map<string, Settings>();
  let page = 0;
  for (const host of registry.list()) {
    for (const agent of host.topology!.agents) {
      const updates: { settings?: Settings }[] = [];
      page += 1;
      service.open({ id: page, send: (_channel: string, payload: never) => updates.push(payload), isDestroyed: () => false } as never, host.id, agent.paneID);
      await eventually(() => updates.some((update) => update.settings?.modelLabel != null));
      out.set(`${host.id}/${agent.paneID}/${agent.agent}`, updates.filter((update) => update.settings !== undefined).at(-1)!.settings!);
    }
  }
  service.closeAll();
  registry.close();
  return out;
}

describe("the showcase with the model chips and ring", () => {
  it("every agent's chips read its own model (Claude: Opus 5.5; Codex: gpt-5-codex at High, as its terminal shows)", async () => {
    const all = await showcaseSettings(start + 5 * 60_000);
    expect(all.size).toBeGreaterThan(8);
    for (const [key, settings] of all) {
      if (key.endsWith("/claude")) expect(settings).toMatchObject({ model: "claude-opus-5-5", modelLabel: "Opus 5.5" });
      else expect(settings).toMatchObject({ model: "gpt-5-codex", modelLabel: "gpt-5-codex", effort: "high" });
    }
  }, 30_000);

  it("the hero chat's ring: a share of the model's 1M window, the same for the same clock; a finished Codex turn's count of its window", async () => {
    const first = await showcaseSettings(start + 5 * 60_000);
    const again = await showcaseSettings(start + 5 * 60_000);
    expect([...again]).toEqual([...first]);
    const hero = first.get(`${showcaseHostIds.studio}/${showcaseHeroTab.chat}/claude`)!;
    const view = contextView({ agent: "claude", used: hero.used!, window: hero.window, model: hero.model, limits: hero.limits, screenRemaining: null });
    expect(view.source).toBe("the model's 1M window");
    expect(view.percent).toBeGreaterThan(15);
    expect(view.percent).toBeLessThan(30);
    const codexDone = [...first].find(([key, settings]) => key.endsWith("/codex") && settings.used !== null)![1];
    expect(codexDone.window).toBe(272_000);
    const codexView = contextView({ agent: "codex", used: codexDone.used!, window: codexDone.window, model: codexDone.model, limits: codexDone.limits, screenRemaining: null });
    expect(codexView.limit).not.toBeNull();
    expect(codexView.percent).toBeGreaterThan(0);
    expect(codexView.percent).toBeLessThan(100);
  }, 60_000);
});

// Send to… (from a tile as from the main pane) and the per-pane queue.
const session = "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b";
const withCodex = paneTopology([
  { id: "p-source", agent: "claude", session },
  { id: "p-target", agent: "codex", session, terminal: "t2" },
]);
const codexGone = paneTopology([{ id: "p-source", agent: "claude", session }, { id: "p-target", terminal: "t2" }]);

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

describe("a tile's Send to… behind another Send on the same pane", () => {
  it("waits its turn in the per-pane queue, then is still refused when the run it was picked on ended", async () => {
    const backend = new FakeBackend();
    const store = new HandoffStore();
    const registry = new HostRegistry((hosts) => store.setHosts(hosts));
    registry.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null }, backend as unknown as HerdrHostBackend);
    await registry.refresh("mini");
    const site = (during: () => Promise<void> = async () => undefined): SendSite => ({
      writer: backend,
      fresh: async () => {
        await during();
        return registry.fresh("mini");
      },
      pane: () => registry.pane("mini", "p-target"),
      agent: () => registry.agent("mini", "p-target"),
      run: () => registry.run("mini", "p-target"),
    });
    const picked = listRows(handoffList(store.macs(), null, [], "")).find((row) => row.paneId === "p-target")!;
    expect(bindingOfPick(picked).run).toEqual({ connection: 1, arrival: 1 });

    // A Send from the pane's own box (bound to the pane, not a run) goes first; while it waits, Codex exits and starts again.
    const plain: SendBinding = bindingOf(registry.topology("mini"), "p-target", true);
    const first = sendBound(
      site(async () => {
        backend.answer = codexGone;
        await registry.refresh("mini");
        backend.answer = withCodex;
      }),
      "p-target",
      "from the box",
      plain,
    );
    // Send to… now, picked before the restart, is queued behind it.
    const payload: HandoffPayload = {
      text: "fixture hand-off",
      kind: { type: "reply" },
      source: { hostId: "mini", paneId: "p-source", name: "claude", kind: "claude", workspace: "app", macName: "Mac mini" },
    };
    const deps = {
      store,
      drafts: new ComposerDrafts(),
      recents: new HandoffRecents(null),
      copy: vi.fn(),
      open: vi.fn(),
      send: (_hostId: string, paneId: string, text: string, binding: SendBinding) => sendBound(site(), paneId, text, binding),
    };
    const second = deliverHandoff(deps, payload, picked, "sendNow");
    await first;
    await second;
    expect(backend.writes).toEqual(["prompt p-target from the box"]);
    expect(deps.copy).toHaveBeenCalledOnce();
    expect(registry.run("mini", "p-target")).toEqual({ connection: 1, arrival: 2 });
    registry.close();
  });
});
