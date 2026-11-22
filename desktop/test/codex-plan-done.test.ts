// Codex 0.171.0 marks its turn done before it draws
// "Implement this plan?" (chatwidget/turn_runtime.rs), and that list reports no blocking, so on the ordinary path
// Herdr says the pane is done or idle. Main's watcher (src/main/prompt/prompts.ts) reads a done or idle Codex pane as
// it reads a done or idle agy pane: on each new status, every 2.5 s for its first 10 s, and for as long as the plan
// list shows; it lists the pane only while the reading is that list (`codexPlan`), and the page shows the pane as
// needing you then (applyAgyQuestions). Nothing else on such a pane is a card, and no other kind's done or idle pane
// is read differently. Through the real HostRegistry, HerdrClient and PromptService on the fake Herdr.

import { describe, expect, it } from "vitest";

import { HostRegistry } from "../src/main/hosts";
import { agyDoneWindowMs, PromptService } from "../src/main/prompt/prompts";
import { stopBindingOf } from "../src/shared/agent-stop";
import { buildDesktopSidebar, type DesktopRow } from "../src/shared/desktop-sidebar";
import { NeedsCardStore } from "../src/renderer/chat/needs-card-store";
import { needsPillKinds } from "../src/shared/needs-pill";
import { needsYouReport } from "../src/shared/needs-notify";
import { readingMatch } from "../src/shared/prompt/matcher";
import { applyAgyQuestions, paneBlocked, type AnswerRequest } from "../src/shared/prompt/view";
import { CQ, L } from "./support/prompt-fixtures";
import { backend, clock, FakeHerdr, show, snapshot, type Json } from "./support/prompt-herdr";

/** Ticks at 0, 2.5, 5 and 7.5 s: the reads a done or idle pane with nothing to show gets. */
const windowReads = Math.ceil(agyDoneWindowMs / 2_500);

/** One Codex pane (w1:p1) Herdr says is `status`, and no other pane. */
function codexSnapshot(status: "done" | "idle"): Json {
  const json = snapshot();
  json["panes"] = [{ pane_id: "w1:p1", terminal_id: "term-1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent: "codex", agent_status: status, revision: 1 }];
  json["agents"] = [{ pane_id: "w1:p1", agent: "codex", agent_status: status, status_since_unix_ms: 1_000, agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "c-1" } }];
  return json;
}

async function setup(status: "done" | "idle", screens: string[]) {
  const herdr = new FakeHerdr(codexSnapshot(status), { "w1:p1": screens });
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
  await registry.refreshAll();
  const time = clock();
  const service = new PromptService(registry, () => undefined, time);
  await service.tick();
  const reads = (pane = "w1:p1") => herdr.sent("pane.read").filter((params) => params["pane_id"] === pane).length;
  const keys = () => herdr.sent("pane.send_keys").map((params) => params["keys"]);
  const request = (key: string): AnswerRequest => {
    const prompt = service.list().find((each) => each.paneId === "w1:p1")!;
    return { hostId: "mac", paneId: "w1:p1", binding: stopBindingOf(registry.list()[0]!, "w1:p1", "Codex"), fingerprint: readingMatch(prompt.reading)!.fingerprint, episode: prompt.episode, key };
  };
  const ticks = async (count: number) => {
    for (let at = 0; at < count; at += 1) {
      time.t += 2_500;
      await service.tick();
    }
  };
  /** What the page shows of w1:p1: the sidebar's Needs you list, Priority's Needs you section, the report's pill. */
  const page = () => {
    const prompts = service.list();
    const hosts = applyAgyQuestions(registry.list(), prompts);
    const sidebar = buildDesktopSidebar(hosts, { nowUnixMs: time.t });
    const ours = (rows: readonly DesktopRow[]) => rows.filter((each) => each.row.paneID === "w1:p1").length;
    const topology = hosts[0]!.topology!;
    const pane = topology.panes.find((each) => each.paneID === "w1:p1")!;
    const agent = topology.agents.find((each) => each.paneID === "w1:p1") ?? null;
    return {
      blocked: paneBlocked(pane, agent),
      needsYou: ours(sidebar.needsYou),
      priority: sidebar.priority.filter((section) => section.kind === "needsYou").reduce((sum, section) => sum + ours(section.rows), 0),
      report: needsYouReport(sidebar.needsYou, hosts, needsPillKinds(prompts)).rows.map((row) => [row.paneId, row.pill]),
    };
  };
  return { herdr, registry, service, time, reads, keys, request, ticks, page };
}

/** A new turn ends: Herdr says working, then done again with a later status time (a new block). */
async function newTurn(context: Awaited<ReturnType<typeof setup>>, status: "done" | "idle", since: number) {
  for (const entry of [context.herdr.agentEntry("w1:p1"), context.herdr.paneEntry("w1:p1")]) entry["agent_status"] = "working";
  await context.registry.refreshAll();
  await context.service.tick();
  for (const entry of [context.herdr.agentEntry("w1:p1"), context.herdr.paneEntry("w1:p1")]) entry["agent_status"] = status;
  context.herdr.agentEntry("w1:p1")["status_since_unix_ms"] = since;
  await context.registry.refreshAll();
  await context.service.tick();
}

describe.each(["done", "idle"] as const)("a Codex pane Herdr says is %s", (status) => {
  it("showing the recorded plan list: one card, Awaiting Input in the sidebar, Priority and the report", async () => {
    const { service, page } = await setup(status, [CQ.afterAll]);
    expect(service.list().map((prompt) => [prompt.paneId, prompt.whileNotBlocked, readingMatch(prompt.reading)?.kind, readingMatch(prompt.reading)?.question])).toEqual([
      ["w1:p1", true, "codexPlan", "Implement this plan?"],
    ]);
    expect(page()).toEqual({ blocked: true, needsYou: 1, priority: 1, report: [["w1:p1", "Awaiting Input"]] });
  });

  it("the answer: one digit after a matching fresh read, proved by the list going", async () => {
    const context = await setup(status, [CQ.afterAll, CQ.planAfterImplement]);
    expect(await context.service.answer(context.request("1"))).toEqual({ type: "sent", label: "Yes, implement this plan" });
    expect(context.keys()).toEqual([["1"]]);
  });

  it("the list changed before the key (the permissions list): nothing sent, the refusal recorded", async () => {
    const context = await setup(status, [CQ.afterAll]);
    const asked = context.request("2");
    show(context.herdr, "w1:p1", CQ.permissionsList);
    expect((await context.service.answer(asked)).type).toBe("changed");
    expect(context.keys()).toEqual([]);
    expect(context.service.refusals.list()).toHaveLength(1);
  });

  it("the list gone without an answer: the card goes and the pane no longer needs you; nothing reads the unchanged block after", async () => {
    const context = await setup(status, [CQ.afterAll]);
    await context.ticks(5);
    expect(context.service.list()).toHaveLength(1);
    show(context.herdr, "w1:p1", CQ.planAfterStay);
    await context.ticks(1);
    expect(context.service.list()).toEqual([]);
    expect(context.page()).toEqual({ blocked: false, needsYou: 0, priority: 0, report: [] });
    const before = context.reads();
    await context.ticks(3);
    expect(context.reads()).toBe(before);
  });

  it("the same plan list again after a later turn is a new card, answerable again", async () => {
    const context = await setup(status, [CQ.afterAll, CQ.planAfterStay]);
    const first = context.service.list()[0]!.episode;
    expect(await context.service.answer(context.request("3"))).toEqual({ type: "sent", label: "No, stay in Plan mode" });
    show(context.herdr, "w1:p1", CQ.afterAll, CQ.planAfterImplement);
    await newTurn(context, status, 9_000);
    const again = context.service.list();
    expect(again.map((prompt) => readingMatch(prompt.reading)?.kind)).toEqual(["codexPlan"]);
    expect(again[0]!.episode).not.toBe(first);
    expect(await context.service.answer(context.request("1"))).toEqual({ type: "sent", label: "Yes, implement this plan" });
    expect(context.keys()).toEqual([["3"], ["1"]]);
  });

  it("showing no plan list, the permissions list, or the question frame's text: read in its first 10 s only, never a card", async () => {
    for (const screen of [CQ.after, CQ.planAfterStay, CQ.permissionsList, CQ.q1of2, CQ.confirm, L.claude2_1_303Bash]) {
      const context = await setup(status, [screen]);
      await context.ticks(8);
      expect(context.reads()).toBe(windowReads);
      expect(context.service.list()).toEqual([]);
      expect(context.page()).toEqual({ blocked: false, needsYou: 0, priority: 0, report: [] });
    }
  });

  it("the Chat card's store shows the machines again when the list comes and when it goes (the page's Needs you follows)", async () => {
    const context = await setup(status, [CQ.afterAll]);
    const store = new NeedsCardStore();
    let shown = 0;
    store.onCleared(() => (shown += 1));
    store.receive(context.service.list());
    expect(shown).toBe(1);
    store.receive(context.service.list());
    expect(shown).toBe(1);
    show(context.herdr, "w1:p1", CQ.planAfterStay);
    await context.ticks(1);
    store.receive(context.service.list());
    expect(shown).toBe(2);
  });

  it("at work: not read", async () => {
    const context = await setup(status, [CQ.afterAll]);
    for (const entry of [context.herdr.agentEntry("w1:p1"), context.herdr.paneEntry("w1:p1")]) entry["agent_status"] = "working";
    await context.registry.refreshAll();
    const before = context.reads();
    await context.ticks(3);
    expect(context.reads()).toBe(before);
    expect(context.service.list()).toEqual([]);
  });
});

describe("a done or idle pane of every other kind is read as before", () => {
  it("Claude, Grok, Cursor, a shell: never read; agy: its first 10 s (its idle screen); each showing the plan list's rows", async () => {
    for (const status of ["done", "idle"] as const) {
      const json = snapshot();
      const kinds: [string, string | undefined][] = [["w1:p1", "claude"], ["w1:p2", "grok"], ["w1:p3", "cursor"], ["w1:p4", undefined], ["w1:p5", "agy"]];
      json["panes"] = kinds.map(([pane, kind], index) => ({ pane_id: pane, terminal_id: `term-${index}`, workspace_id: "w1", tab_id: "w1:t1", focused: index === 0, ...(kind === undefined ? {} : { agent: kind }), agent_status: kind === undefined ? "unknown" : status, revision: 1 }));
      json["agents"] = kinds.flatMap(([pane, kind]) => (kind === undefined ? [] : [{ pane_id: pane, agent: kind, agent_status: status, status_since_unix_ms: 1_000 }]));
      const herdr = new FakeHerdr(json, Object.fromEntries(kinds.map(([pane]) => [pane, [CQ.afterAll]])));
      const registry = new HostRegistry(() => undefined);
      registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
      await registry.refreshAll();
      const time = clock();
      const service = new PromptService(registry, () => undefined, time);
      await service.tick();
      for (let at = 0; at < 8; at += 1) {
        time.t += 2_500;
        await service.tick();
      }
      const reads = (pane: string) => herdr.sent("pane.read").filter((params) => params["pane_id"] === pane).length;
      expect(kinds.map(([pane]) => reads(pane))).toEqual([0, 0, 0, 0, windowReads]);
      expect(service.list()).toEqual([]);
    }
  });
});
