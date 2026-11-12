// A fake Herdr for the needs card's main-process tests: the demo's
// FixtureTransport (session.snapshot, pane.read, pane.send_keys, agent.prompt
// answered from a snapshot the test changes and per-pane screens), the real
// HerdrClient and HostRegistry, and a clock the test moves.

import { FixtureTransport } from "../../src/main/demo/demo-backend";
import type { HerdrHostBackend } from "../../src/main/herdr/backend";
import { HerdrClient } from "../../src/main/herdr/client";
import { HostRegistry } from "../../src/main/hosts";
import { PromptService, type PromptClock } from "../../src/main/prompt/prompts";
import { stopBindingOf } from "../../src/shared/agent-stop";
import { readingMatch, type PromptMatch } from "../../src/shared/prompt/matcher";
import type { AnswerRequest, PanePrompt } from "../../src/shared/prompt/view";
import { F } from "./prompt-fixtures";

export type Json = Record<string, unknown>;

export function snapshot(): Json {
  return {
    version: "0.9.5",
    protocol: 22,
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    focused_pane_id: "w1:p1",
    workspaces: [{ workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 3, tab_count: 1, active_tab_id: "w1:t1", agent_status: "blocked" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 3, agent_status: "blocked" }],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term-1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent: "claude", agent_status: "blocked", revision: 1 },
      { pane_id: "w1:p2", terminal_id: "term-2", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "codex", agent_status: "working", revision: 1 },
      { pane_id: "w1:p3", terminal_id: "term-3", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "unknown", revision: 1 },
    ],
    layouts: [],
    agents: [
      { pane_id: "w1:p1", agent: "claude", agent_status: "blocked", status_since_unix_ms: 1_000, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" } },
      { pane_id: "w1:p2", agent: "codex", agent_status: "working", status_since_unix_ms: 2_000 },
    ],
  };
}

/** A fake Herdr: the demo's transport over a snapshot the test changes, a read that can fail, every request kept. */
export class FakeHerdr extends FixtureTransport {
  readFails = false;
  /** Runs right before a pane.send_keys is answered (a reconnect at the last moment). */
  beforeKeys: (() => void) | null = null;

  constructor(
    readonly json: Json,
    screens: Record<string, string[]>,
  ) {
    super(json, screens);
  }

  override roundTrip(line: string): Promise<string> {
    const method = (JSON.parse(line) as { method: string }).method;
    if (method === "pane.read" && this.readFails) {
      this.requests.push(line);
      return Promise.reject(new Error("the pane could not be read"));
    }
    if (method === "pane.send_keys") this.beforeKeys?.();
    return super.roundTrip(line);
  }

  sent(method: string): Json[] {
    return this.requests.map((line) => JSON.parse(line) as { method: string; params: Json }).filter((r) => r.method === method).map((r) => r.params);
  }

  agentEntry(pane: string): Json {
    return (this.json["agents"] as Json[]).find((agent) => agent["pane_id"] === pane)!;
  }

  paneEntry(pane: string): Json {
    return (this.json["panes"] as Json[]).find((entry) => entry["pane_id"] === pane)!;
  }
}

export function backend(herdr: FakeHerdr, epoch: { value: number }): HerdrHostBackend {
  const client = new HerdrClient(herdr);
  return {
    kind: "demo",
    snapshot: () => client.sessionTopology(),
    sendInput: (pane, text, keys) => client.sendInput(pane, text, keys),
    prompt: (pane, text) => client.prompt(pane, text),
    sendText: (pane, text) => client.sendText(pane, text),
    agentKeys: (pane, keys) => client.agentSendKeys(pane, keys),
    transcripts: () => null,
    promptIO: () => client,
    connectionEpoch: () => epoch.value,
    openTerminal: () => Promise.reject(new Error("no terminal")),
    close: () => undefined,
  };
}

export function clock(): PromptClock & { t: number } {
  const c = {
    t: 10_000,
    now: () => c.t,
    sleep: (ms: number) => {
      c.t += ms;
      return Promise.resolve();
    },
    every: () => () => undefined,
  };
  return c;
}

export async function setup(screen: string, more: string[] = []) {
  const herdr = new FakeHerdr(snapshot(), { "w1:p1": [screen, ...more], "w1:p2": [F.working] });
  const epoch = { value: 1 };
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, epoch));
  await registry.refreshAll();
  const pushed: PanePrompt[][] = [];
  const time = clock();
  const service = new PromptService(registry, (prompts) => pushed.push(prompts), time);
  await service.tick();
  const shown = (): PromptMatch => readingMatch(service.list().find((prompt) => prompt.paneId === "w1:p1")!.reading!)!;
  const request = (key: string, text?: string): AnswerRequest => ({
    hostId: "mac",
    paneId: "w1:p1",
    binding: stopBindingOf(registry.list()[0]!, "w1:p1", "Claude"),
    fingerprint: shown().fingerprint,
    episode: service.list().find((prompt) => prompt.paneId === "w1:p1")!.episode,
    key,
    ...(text === undefined ? {} : { text }),
  });
  return { herdr, epoch, registry, service, pushed, time, shown, request };
}

/** Shows `screens` in the pane from now on (the first now, a key moving to the next). */
export function show(herdr: FakeHerdr, pane: string, ...screens: string[]): void {
  (herdr as unknown as { screens: Map<string, string[]> }).screens.set(pane, screens);
}

/**
 * Runs `change` while the `at`-th pane.read
 * from now is held (its reply already taken from the old screen), then lets
 * the reply through.
 */
export function duringRead(herdr: FakeHerdr, change: () => unknown, at = 1): void {
  const real = herdr.roundTrip.bind(herdr);
  let reads = 0;
  herdr.roundTrip = async (line: string) => {
    const reply = real(line);
    if ((JSON.parse(line) as { method: string }).method === "pane.read" && ++reads === at) await change();
    return reply;
  };
}

/** The changes a held read spans: another terminal, session or kind, the agent at work, the pane closed. */
export function changeAgent(herdr: FakeHerdr, change: string): void {
  if (change === "terminal") herdr.paneEntry("w1:p1")["terminal_id"] = "replacement-terminal";
  if (change === "session") herdr.agentEntry("w1:p1")["agent_session"] = { source: "herdr:claude", agent: "claude", kind: "id", value: "replacement-session" };
  if (change === "kind") {
    herdr.agentEntry("w1:p1")["agent"] = "codex";
    herdr.paneEntry("w1:p1")["agent"] = "codex";
  }
  if (change === "unblocked") {
    herdr.agentEntry("w1:p1")["agent_status"] = "working";
    herdr.paneEntry("w1:p1")["agent_status"] = "working";
  }
  if (change === "closed") {
    herdr.json["panes"] = (herdr.json["panes"] as Json[]).filter((pane) => pane["pane_id"] !== "w1:p1");
    herdr.json["agents"] = (herdr.json["agents"] as Json[]).filter((agent) => agent["pane_id"] !== "w1:p1");
  }
}
