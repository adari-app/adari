// Antigravity CLI's questions read while Herdr says the pane is `done` (agy 1.5.13 reports `done` while its create and
// edit questions show: create-file-ask-agent-get.json in the samples): main's watcher (src/main/prompt/prompts.ts)
// reads an agy pane that is done or idle, in its first 10 s and then for as long as one of agy's questions shows, and
// lists it only then; the page shows that pane as needing you (applyAgyQuestions: the sidebar's Needs you, Priority,
// the notification's report). Claude's done pane is never read this way; a Codex done pane is read the same way but
// only for its "Implement this plan?" list (test/codex-plan-done.test.ts). Through the real HostRegistry, HerdrClient
// and PromptService on the fake Herdr (test/support/prompt-herdr.ts).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HostRegistry } from "../src/main/hosts";
import { agyDoneWindowMs, PromptService } from "../src/main/prompt/prompts";
import { stopBindingOf } from "../src/shared/agent-stop";
import { buildDesktopSidebar, type DesktopRow } from "../src/shared/desktop-sidebar";
import { needsPillKinds } from "../src/shared/needs-pill";
import { needsYouReport } from "../src/shared/needs-notify";
import { readingMatch } from "../src/shared/prompt/matcher";
import { applyAgyQuestions, paneBlocked, type AnswerRequest } from "../src/shared/prompt/view";
import { L } from "./support/prompt-fixtures";
import { backend, clock, FakeHerdr, show, snapshot, type Json } from "./support/prompt-herdr";

const fixture = (name: string): string => readFileSync(path.join(__dirname, "fixtures/antigravity", name), "utf8");
const createAsk = fixture("create-file-ask.txt");
const editAsk = fixture("edit-file-ask.txt");
/** agy's idle screen as the samples' README draws it: a rule, `>` and the box, a rule, "? for shortcuts" and the mode line. */
const idle = ["● Edited 1 file (notes.txt) (ctrl+o to expand)", "", "─".repeat(120), "> ", "─".repeat(120), `? for shortcuts${" ".repeat(75)}auto · Gemini 4 Hydrogen · low`].join("\n");

/** Three done panes: agy (w1:p1, no session, as on a machine without Herdr's integration), Claude (w1:p2), Codex (w1:p3). */
function doneSnapshot(): Json {
  const json = snapshot();
  json["panes"] = [
    { pane_id: "w1:p1", terminal_id: "term-1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent: "agy", agent_status: "done", revision: 1 },
    { pane_id: "w1:p2", terminal_id: "term-2", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "done", revision: 1 },
    { pane_id: "w1:p3", terminal_id: "term-3", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "codex", agent_status: "done", revision: 1 },
  ];
  json["agents"] = [
    { pane_id: "w1:p1", agent: "agy", agent_status: "done", status_since_unix_ms: 1_000, completion_seq: 7085 },
    { pane_id: "w1:p2", agent: "claude", agent_status: "done", status_since_unix_ms: 1_000, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" } },
    { pane_id: "w1:p3", agent: "codex", agent_status: "done", status_since_unix_ms: 1_000 },
  ];
  return json;
}

async function setup(agyScreen: string) {
  // Claude's and Codex's panes show Claude's question: were it read as theirs, it would be a card.
  const herdr = new FakeHerdr(doneSnapshot(), { "w1:p1": [agyScreen], "w1:p2": [L.claude2_1_303Bash], "w1:p3": [L.claude2_1_303Bash] });
  const epoch = { value: 1 };
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, epoch));
  await registry.refreshAll();
  const time = clock();
  const service = new PromptService(registry, () => undefined, time);
  await service.tick();
  const reads = (pane: string) => herdr.sent("pane.read").filter((params) => params["pane_id"] === pane);
  const request = (key: string): AnswerRequest => {
    const prompt = service.list().find((each) => each.paneId === "w1:p1")!;
    return { hostId: "mac", paneId: "w1:p1", binding: stopBindingOf(registry.list()[0]!, "w1:p1", "Antigravity CLI"), fingerprint: readingMatch(prompt.reading)!.fingerprint, episode: prompt.episode, key };
  };
  /** What the page shows of w1:p1: the sidebar's Needs you list, Priority's Needs you section, the notification report's rows. */
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
      status: agent?.agentStatus,
      needsYou: ours(sidebar.needsYou),
      priority: sidebar.priority.filter((section) => section.kind === "needsYou").reduce((sum, section) => sum + ours(section.rows), 0),
      report: needsYouReport(sidebar.needsYou, hosts, needsPillKinds(prompts)).rows.map((row) => [row.paneId, row.pill]),
    };
  };
  return { herdr, epoch, registry, service, time, reads, request, page };
}

describe("an agy pane Herdr says is done", () => {
  it("showing create-file-ask: read, listed as its question, and needing you in the sidebar, Priority and the notification", async () => {
    const { service, reads, page } = await setup(createAsk);
    expect(reads("w1:p1")).toEqual([{ pane_id: "w1:p1", source: "recent", lines: 40, format: "text", strip_ansi: true }]);
    const prompts = service.list();
    expect(prompts.map((prompt) => [prompt.paneId, prompt.whileNotBlocked, readingMatch(prompt.reading)?.question])).toEqual([["w1:p1", true, "Allow creation of this file?"]]);
    expect(page()).toEqual({ blocked: true, status: "done", needsYou: 1, priority: 1, report: [["w1:p1", "Pending Approval"]] });
  });

  it("at its idle screen: read in its first 10 s only, never listed, never needing you", async () => {
    const { service, time, reads, page } = await setup(idle);
    for (let at = 0; at < 8; at += 1) {
      time.t += 2_500;
      await service.tick();
    }
    // Ticks at 0, 2.5, 5 and 7.5 s read it; from 10 s on, nothing.
    expect(reads("w1:p1")).toHaveLength(Math.ceil(agyDoneWindowMs / 2_500));
    expect(service.list()).toEqual([]);
    expect(page()).toMatchObject({ blocked: false, status: "done", needsYou: 0, priority: 0, report: [] });
  });

  it("a question that shows later in the window is found; one that shows while it is read stays read every tick until it goes", async () => {
    const { herdr, service, time, reads } = await setup(idle);
    time.t += 2_500;
    show(herdr, "w1:p1", editAsk);
    await service.tick();
    expect(readingMatch(service.list()[0]?.reading)?.question).toBe("Accept this file edit?");
    for (let at = 0; at < 6; at += 1) {
      time.t += 2_500;
      await service.tick();
    }
    expect(reads("w1:p1")).toHaveLength(8);
    show(herdr, "w1:p1", idle);
    time.t += 2_500;
    await service.tick();
    expect(service.list()).toEqual([]);
    const before = reads("w1:p1").length;
    time.t += 2_500;
    await service.tick();
    expect(reads("w1:p1")).toHaveLength(before);
  });

  it("Claude's done pane is never read; Codex's is read only for its plan list (its first 10 s here), and neither is listed", async () => {
    const { service, time, reads } = await setup(createAsk);
    for (let at = 0; at < 8; at += 1) {
      time.t += 2_500;
      await service.tick();
    }
    expect(reads("w1:p2")).toEqual([]);
    // Codex draws "Implement this plan?" after it marks its turn done
    // (test/codex-plan-done.test.ts), so a done Codex pane is read in its first 10 s; Claude's question on it is no card.
    expect(reads("w1:p3")).toHaveLength(Math.ceil(agyDoneWindowMs / 2_500));
    expect(service.list().map((prompt) => prompt.paneId)).toEqual(["w1:p1"]);
  });

  it("never while working: an agy pane at work is not read", async () => {
    const { herdr, registry, service, time, reads } = await setup(createAsk);
    herdr.agentEntry("w1:p1")["agent_status"] = "working";
    herdr.paneEntry("w1:p1")["agent_status"] = "working";
    await registry.refreshAll();
    const before = reads("w1:p1").length;
    time.t += 2_500;
    await service.tick();
    expect(reads("w1:p1")).toHaveLength(before);
    expect(service.list()).toEqual([]);
  });

  it("an answer sends the digit while the pane is still done and the question the same; at work, nothing goes", async () => {
    const sent = await setup(createAsk);
    expect(await sent.service.answer(sent.request("2"))).toEqual({ type: "sent", label: "No, deny creation" });
    expect(sent.herdr.sent("pane.send_keys")).toEqual([{ pane_id: "w1:p1", keys: ["2"] }]);

    const busy = await setup(createAsk);
    const asked = busy.request("1");
    busy.herdr.agentEntry("w1:p1")["agent_status"] = "working";
    busy.herdr.paneEntry("w1:p1")["agent_status"] = "working";
    await busy.registry.refreshAll();
    expect((await busy.service.answer(asked)).type).toBe("refused");
    expect(busy.herdr.sent("pane.send_keys")).toEqual([]);
  });
});

// Herdr's two records must agree.
describe("either record says working, or names another kind: no done read, no needing you", () => {
  it("the pane's record says working while the agent's still says done: not read", async () => {
    const { herdr, registry, service, time, reads } = await setup(idle);
    const before = reads("w1:p1").length;
    herdr.paneEntry("w1:p1")["agent_status"] = "working";
    await registry.refreshAll();
    time.t += 2_500;
    await service.tick();
    expect(reads("w1:p1")).toHaveLength(before);
  });

  it("the agent's record says working while the pane's says done: not read", async () => {
    const { herdr, registry, service, time, reads } = await setup(idle);
    const before = reads("w1:p1").length;
    herdr.agentEntry("w1:p1")["agent_status"] = "working";
    await registry.refreshAll();
    time.t += 2_500;
    await service.tick();
    expect(reads("w1:p1")).toHaveLength(before);
  });

  it("a question showing, then the pane's record says working: the card goes and the pane no longer needs you", async () => {
    const { herdr, registry, service, time, page } = await setup(createAsk);
    expect(page().needsYou).toBe(1);
    herdr.paneEntry("w1:p1")["agent_status"] = "working";
    await registry.refreshAll();
    time.t += 2_500;
    await service.tick();
    expect(service.list()).toEqual([]);
    expect(page()).toMatchObject({ blocked: false, needsYou: 0, priority: 0, report: [] });
  });

  it("the two records name different kinds: not read", async () => {
    for (const record of ["pane", "agent"] as const) {
      const json = doneSnapshot();
      const entry = (json[record === "pane" ? "panes" : "agents"] as Json[]).find((each) => each["pane_id"] === "w1:p1")!;
      entry["agent"] = "claude";
      const herdr = new FakeHerdr(json, { "w1:p1": [createAsk] });
      const registry = new HostRegistry(() => undefined);
      registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
      await registry.refreshAll();
      const service = new PromptService(registry, () => undefined, clock());
      await service.tick();
      expect(herdr.sent("pane.read").filter((params) => params["pane_id"] === "w1:p1")).toEqual([]);
    }
  });
});
