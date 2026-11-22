// One machine for New agent through the real main-process door: LiveHerdr's
// panes and agents, with what it lacks answered here (tab.create, pane.read, integration.list and
// integration.install), behind the real HerdrClient, HostRegistry, IntegrationService, LayoutService and registerIpc.
// Every request on the wire is logged in order with its params as sent (`log`), beside the page's progress
// (`progress`). A fake clock moves only by each request's fixed cost and by the start's own sleeps, so a step's
// milliseconds are known. Kept free of anything newer than 34da24eb's door, so the same runs could be recorded there.

import { HerdrClient } from "../../src/main/herdr/client";
import type { HerdrTransport } from "../../src/main/herdr/transport";
import { HostRegistry } from "../../src/main/hosts";
import { IntegrationService, memoryIntegrationSettings, type AutoInstallAlarm } from "../../src/main/integrations";
import { LayoutService, type LayoutOwner } from "../../src/main/layouts";
import { APP_ORIGIN } from "../../src/main/protocol";
import type { LayoutUpdateEvent } from "../../src/shared/ipc-contract";
import { paneBindingOf, type PaneBinding } from "../../src/shared/pane-binding";
import { LiveHerdr } from "./live-herdr";

type Json = Record<string, unknown>;

/** What each request costs on the fake clock, in milliseconds. */
export const requestCost: Readonly<Record<string, number>> = {
  "agent.list": 20,
  "tab.create": 30,
  "pane.split": 30,
  "agent.start": 40,
  "pane.send_input": 15,
  "pane.read": 10,
  "pane.layout": 5,
  "pane.close": 10,
  "session.snapshot": 25,
  "integration.list": 50,
  "integration.install": 500,
};
/** The start commands file's read. */
export const commandsCost = 12;

export type InstallMode = "ok" | "refuse" | "hold";

export interface WorldOptions {
  /** Each integration target's state as Herdr lists it ("current", "outdated", "not_installed"). */
  readonly integrations?: Readonly<Record<string, string>>;
  /** ~/.adari/agents.json (null: none). */
  readonly agentsJson?: Readonly<Record<string, string>> | null;
  readonly install?: InstallMode;
  /** agent.start's answer: Herdr's code to refuse it with (null: started). */
  readonly refuseStart?: string | null;
  /** What pane.read shows on a new pane (a shell's "not found" line, or nothing). */
  readonly paneText?: string;
  /** A typed command brings its agent up after this many agent.list looks (0: by the first). */
  readonly typedAfterLooks?: number;
  /** A typed command brings no agent at all. */
  readonly typedNeverStarts?: boolean;
}

export interface ProgressSeen {
  readonly at: number;
  readonly logIndex: number;
  readonly payload: Json;
}

export async function newAgentWorld(registerIpc: (deps: never) => void, handles: Map<string, (...args: unknown[]) => unknown>, channel: string, options: WorldOptions = {}) {
  const live = new LiveHerdr();
  live.addTab("w1:t1", ["w1:p1"]);
  let now = 1_000;
  const log: string[] = [];
  const progress: ProgressSeen[] = [];
  const states = new Map(Object.entries(options.integrations ?? {}));
  let install: InstallMode = options.install ?? "ok";
  let release: () => void = () => undefined;
  let held = new Promise<void>((done) => (release = done));
  let tabs = 0;
  const looksAfterTyping = new Map<string, number>();
  // A request held until the test lets it go (its method, or "(read agents.json)"), answered as usual then.
  const holds = new Map<string, { readonly until: Promise<void>; readonly go: () => void }>();
  const heldBy = async (what: string): Promise<void> => {
    const hold = holds.get(what);
    if (hold !== undefined) await hold.until;
  };
  const answer = (id: string, result: unknown): string => JSON.stringify({ id, result });
  const refuse = (id: string, code: string, message: string): string => JSON.stringify({ id, error: { code, message } });
  // The wire: every request logged as sent, the clock moved by its cost, then answered here or by LiveHerdr.
  const transport: HerdrTransport = {
    async roundTrip(line: string): Promise<string> {
      const request = JSON.parse(line) as { id: string; method: string; params?: Json };
      const params = request.params ?? {};
      log.push(`${request.method} ${JSON.stringify(params)}`);
      // The reply comes a few ticks later, its cost on the clock then (as a round trip would).
      await ticks();
      await heldBy(request.method);
      now += requestCost[request.method] ?? 1;
      switch (request.method) {
        case "tab.create": {
          tabs += 1;
          const tabId = `w1:tn${tabs}`;
          const paneId = `w1:pn${tabs}`;
          live.addTab(tabId, [paneId]);
          return answer(request.id, {
            type: "tab_created",
            tab: { tab_id: tabId, workspace_id: "w1", number: 1 + tabs, label: typeof params["label"] === "string" ? params["label"] : "", focused: false, pane_count: 1, agent_status: "unknown" },
            root_pane: { pane_id: paneId, terminal_id: `term-${paneId}`, workspace_id: "w1", tab_id: tabId, focused: false, agent_status: "unknown", revision: 1 },
          });
        }
        case "pane.read": {
          const paneId = String(params["pane_id"]);
          return answer(request.id, {
            type: "pane_read",
            read: { pane_id: paneId, workspace_id: "w1", tab_id: live.tabOf(paneId) ?? "w1:t1", source: "recent", format: "text", text: options.paneText ?? "you@mini app % ", revision: 1, truncated: false },
          });
        }
        case "integration.list":
          return answer(request.id, {
            type: "integration_list",
            integrations: [...states].map(([target, state]) => ({ target, label: target, command: target, available: true, state })),
          });
        case "integration.install": {
          const target = String(params["target"]);
          if (install === "hold") await held;
          if (install === "refuse") return refuse(request.id, "integration_install_failed", "integration_install_failed: settings.json is not writable");
          states.set(target, "current");
          return answer(request.id, { type: "integration_install", target, details: { messages: [`installed ${target} integration hook`] } });
        }
        case "agent.start":
          if (options.refuseStart !== undefined && options.refuseStart !== null) {
            log.push(`(refused ${options.refuseStart})`);
            return refuse(request.id, options.refuseStart, `${options.refuseStart}: the pane is gone`);
          }
          break;
        case "pane.send_input": {
          // The typed command brings its agent up after `typedAfterLooks` looks (the kind from agents.json's key).
          const paneId = String(params["pane_id"]);
          if (options.typedNeverStarts !== true) looksAfterTyping.set(paneId, options.typedAfterLooks ?? 0);
          return answer(request.id, { type: "ok" });
        }
        case "agent.list":
          for (const [paneId, left] of looksAfterTyping) {
            if (left > 0) {
              looksAfterTyping.set(paneId, left - 1);
              continue;
            }
            const pane = live.panes.get(paneId);
            if (pane !== undefined) {
              pane.agent = Object.keys(options.agentsJson ?? {})[0] ?? "claude";
              pane.session = `session-${paneId}`;
            }
            looksAfterTyping.delete(paneId);
          }
          break;
      }
      return live.roundTrip(line);
    },
    close: () => undefined,
  };
  const client = new HerdrClient(transport);
  const backend = {
    kind: "herdr-tui" as const,
    snapshot: async () => {
      log.push("session.snapshot {}");
      await ticks();
      now += requestCost["session.snapshot"]!;
      return live.topology();
    },
    connectionEpoch: () => 1,
    integrations: () => client,
    paneActions: () => client,
    workspaceActions: () => client,
    readStartCommandsFile: async () => {
      log.push("(read agents.json)");
      await ticks();
      await heldBy("(read agents.json)");
      now += commandsCost;
      return options.agentsJson === null || options.agentsJson === undefined ? null : new TextEncoder().encode(JSON.stringify(options.agentsJson));
    },
    close: () => undefined,
  };
  let service: IntegrationService | null = null;
  const registry = new HostRegistry(() => service?.hostsChanged());
  // The install's bound, rung by the test (a stalled install).
  const rings: (() => void)[] = [];
  const alarm: AutoInstallAlarm = () => {
    let ring: () => void = () => undefined;
    const rang = new Promise<void>((done) => (ring = done));
    rings.push(ring);
    return { rang, cancel: () => undefined };
  };
  service = new IntegrationService(registry, (text) => text, memoryIntegrationSettings(true), alarm);
  registry.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: "macOS" }, backend as never);
  await registry.refresh("mini");
  await flush();
  const layoutService = new LayoutService(registry, "layout");
  const layouts = {
    reread: (hostId: string) => {
      log.push(`(reread ${hostId})`);
      return layoutService.reread(hostId);
    },
    accept: (hostId: string, layout: Parameters<LayoutService["accept"]>[1]) => layoutService.accept(hostId, layout),
    watched: (owner: { readonly id: number }) => layoutService.watched(owner),
  };
  const updates: LayoutUpdateEvent[] = [];
  const page: LayoutOwner = {
    id: 10,
    send: (sent, payload) => {
      if (sent === channel) progress.push({ at: now, logIndex: log.length, payload: payload as unknown as Json });
      else updates.push(payload);
    },
    isDestroyed: () => false,
  };
  layoutService.watch(page, "mini", "w1:p1");
  for (let i = 0; i < 20 && updates.at(-1)?.layout == null; i += 1) await flush();
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  // A fresh world's log starts here: the connection's own reads are not New agent's.
  log.length = 0;
  return {
    live,
    log,
    progress,
    clock,
    rings,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    registry,
    service,
    layouts,
    page,
    setInstall: (mode: InstallMode) => {
      install = mode;
      held = new Promise<void>((done) => (release = done));
    },
    release: () => release(),
    /** Holds `what` (a method, or "(read agents.json)") until `unhold`. */
    hold: (what: string) => {
      let go: () => void = () => undefined;
      const until = new Promise<void>((done) => (go = done));
      holds.set(what, { until, go });
    },
    unhold: (what: string) => {
      holds.get(what)?.go();
      holds.delete(what);
    },
    /** The pane as the window shows it. */
    bind: (paneId: string): PaneBinding => paneBindingOf(registry.list()[0]!, updates.at(-1)?.layout ?? null, paneId)!,
    register: (more: Json = {}) => {
      handles.clear();
      registerIpc({ hosts: registry, integrations: service, layouts, chat: {}, terminals: {}, ghostty: {}, newAgentClock: clock, ...more } as never);
    },
    event: { sender: page, senderFrame: { url: `${APP_ORIGIN}/` } },
  };
}

/** A round trip's few ticks. */
const ticks = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 400; i += 1) await Promise.resolve();
};
