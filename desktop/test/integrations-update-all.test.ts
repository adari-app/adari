// Settings' Update all (src/main/integrations.ts updateAll,
// src/renderer/components/integrations.tsx IntegrationsLine) through the real
// IntegrationService on a real HostRegistry, each machine a fake Herdr behind a
// real HerdrClient (the request lines are what would go on the socket), its
// installs held open until the test lets them end. No real Herdr, no socket,
// no network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import { HerdrClient } from "../src/main/herdr/client";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { IntegrationService, memoryIntegrationSettings } from "../src/main/integrations";
import { updateAllTargets, updateAllTexts, type IntegrationBinding, type IntegrationItem } from "../src/shared/integrations";
import type { HostView } from "../src/shared/ipc-contract";
import { HookHost, elements } from "./support/fake-hooks";

const { IntegrationsLine, integrationNotes } = await import("../src/renderer/components/integrations");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

const topology = decodeSessionTopology({ version: "0.9.5", protocol: 22, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] });

const info = (target: string, state: string, available = true) => ({ target, label: target, command: target, available, state });

/** A fake Herdr whose installs wait until the test ends each one (`finish`), so "one at a time" is seen. */
function machine(states: [string, string][], refuse: ReadonlySet<string> = new Set()) {
  const requests: { method: string; target?: string; epoch: number }[] = [];
  const held = new Map<string, Map<string, string>>([["s", new Map(states)]]);
  const live = held.get("s")!;
  let epoch = 1;
  let inFlight = 0;
  let mostInFlight = 0;
  const waiting: (() => void)[] = [];
  const transport = {
    roundTrip(line: string): Promise<string> {
      const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      const target = typeof request.params["target"] === "string" ? (request.params["target"] as string) : undefined;
      requests.push({ method: request.method, ...(target === undefined ? {} : { target }), epoch });
      if (request.method === "integration.list") {
        return Promise.resolve(JSON.stringify({ id: request.id, result: { type: "integration_list", integrations: [...live].map(([name, state]) => info(name, state)) } }));
      }
      if (request.method === "integration.install") {
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        return new Promise<string>((resolve) => {
          waiting.push(() => {
            inFlight -= 1;
            if (refuse.has(target!)) {
              resolve(JSON.stringify({ id: request.id, error: { code: "integration_failed", message: `could not write the ${target} hook` } }));
              return;
            }
            live.set(target!, "current");
            resolve(JSON.stringify({ id: request.id, result: { type: "integration_install", target, details: { messages: [`Updated the ${target} integration.`] } } }));
          });
        });
      }
      return Promise.resolve(JSON.stringify({ id: request.id, error: { code: "unknown_method", message: "no such method" } }));
    },
    close: () => undefined,
  };
  const client = new HerdrClient(transport);
  const backend = { kind: "herdr-tui" as const, snapshot: () => Promise.resolve(topology), connectionEpoch: () => epoch, integrations: () => client, close: () => undefined };
  return {
    descriptor: { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "dev@mini", platform: "macOS" },
    backend,
    requests,
    installs: () => requests.filter((request) => request.method === "integration.install").map((request) => request.target),
    lists: () => requests.filter((request) => request.method === "integration.list").length,
    /** Ends the oldest install still open. */
    finish: async () => {
      await flush();
      waiting.shift()?.();
      await flush();
    },
    open: () => waiting.length,
    mostInFlight: () => mostInFlight,
    setEpoch: (value: number) => {
      epoch = value;
    },
  };
}

async function added(states: [string, string][], refuse: ReadonlySet<string> = new Set()) {
  let service: IntegrationService | null = null;
  const registry = new HostRegistry(() => service?.hostsChanged());
  service = new IntegrationService(registry, (text) => text, memoryIntegrationSettings(true));
  const m = machine(states, refuse);
  registry.add(m.descriptor, m.backend as never);
  await registry.refresh("mini");
  await flush();
  const host = (): HostView => registry.list().find((entry) => entry.id === "mini")!;
  const binding = (): IntegrationBinding => ({ incarnation: host().incarnation!, connection: host().connection!, epoch: host().epoch ?? null });
  return { registry, service, m, host, binding };
}

const fourAgents: [string, string][] = [
  ["claude", "outdated"],
  ["codex", "outdated"],
  ["cursor", "not_installed"],
  ["grok", "outdated"],
];

describe("Update all: the machine's out-of-date integrations, one after the other, through the install path", () => {
  it("three out of date and one missing: three installs in Settings' order, one at a time, the missing one untouched, the list read at the end", async () => {
    const { registry, service, m, host, binding } = await added(fourAgents);
    expect(updateAllTargets(host().integrations!.items)).toEqual(["claude", "codex", "grok"]);
    const listsBefore = m.lists();
    const all = service.updateAll("mini", binding());
    await flush();
    expect(host().integrations?.updatingAll).toBe(true);
    expect(m.installs()).toEqual(["claude"]);
    expect(host().integrations?.outcomes["claude"]?.phase).toBe("installing");
    await m.finish();
    expect(m.installs()).toEqual(["claude", "codex"]);
    await m.finish();
    expect(m.installs()).toEqual(["claude", "codex", "grok"]);
    await m.finish();
    const reply = await all;
    expect(m.mostInFlight()).toBe(1);
    expect(m.installs()).not.toContain("cursor");
    expect(reply.note).toBeNull();
    expect(reply.results.map((result) => [result.target, result.reply.sent])).toEqual([
      ["claude", true],
      ["codex", true],
      ["grok", true],
    ]);
    // Each install's own list read, then one more at the end.
    expect(m.lists()).toBe(listsBefore + 4);
    expect(host().integrations?.updatingAll).toBeUndefined();
    expect(host().integrations?.items.map((item) => `${item.target}=${item.state}`)).toEqual(["claude=current", "codex=current", "cursor=not_installed", "grok=current"]);
    for (const target of ["claude", "codex", "grok"]) expect(host().integrations?.outcomes[target]?.text).toMatch(/^Installed\. Restart /);
    expect(host().integrations?.outcomes["cursor"]).toBeUndefined();
    registry.close();
  });

  it("one refused: the others still go, and each row keeps its own words", async () => {
    const { registry, service, m, host, binding } = await added(fourAgents, new Set(["codex"]));
    const all = service.updateAll("mini", binding());
    for (let i = 0; i < 3; i += 1) await m.finish();
    const reply = await all;
    expect(m.installs()).toEqual(["claude", "codex", "grok"]);
    expect(reply.results.map((result) => result.target)).toEqual(["claude", "codex", "grok"]);
    const outcomes = host().integrations!.outcomes;
    expect(outcomes["claude"]?.phase).toBe("installed");
    expect(outcomes["codex"]).toMatchObject({ phase: "failed", text: "Not updated: could not write the codex hook", action: "update" });
    expect(outcomes["grok"]?.phase).toBe("installed");
    expect(host().integrations?.items.find((item) => item.target === "codex")?.state).toBe("outdated");
    registry.close();
  });

  it("a reconnect in the middle: nothing more is sent after it", async () => {
    const { registry, service, m, binding } = await added(fourAgents);
    const all = service.updateAll("mini", binding());
    await flush();
    expect(m.installs()).toEqual(["claude"]);
    // A new command connection while the first install runs.
    m.setEpoch(2);
    await m.finish();
    const reply = await all;
    expect(m.installs()).toEqual(["claude"]);
    expect(m.requests.filter((request) => request.method === "integration.install" && request.epoch === 2)).toEqual([]);
    expect(reply.results.at(-1)?.reply).toEqual({ sent: false, note: "Not installed: the connection to Mac mini changed since this showed. Nothing was sent." });
    // A click bound to the old connection sends nothing at all.
    await registry.refresh("mini");
    await flush();
    const before = m.requests.length;
    const stale = await service.updateAll("mini", { incarnation: 1, connection: 1, epoch: 1 });
    expect(stale.results).toEqual([]);
    expect(stale.note).toMatch(/Nothing was sent\.$/);
    expect(m.requests.slice(before).filter((request) => request.method === "integration.install")).toEqual([]);
    registry.close();
  });

  it("a click while New agent's install of the same target runs: no second install, it waits on that one", async () => {
    const { registry, service, m, binding } = await added([["codex", "outdated"]]);
    const start = service.beforeStart("mini", "codex", binding());
    await flush();
    expect(m.installs()).toEqual(["codex"]);
    const all = service.updateAll("mini", binding());
    await flush();
    expect(m.installs()).toEqual(["codex"]);
    await m.finish();
    const reply = await all;
    await start;
    expect(m.installs()).toEqual(["codex"]);
    expect(reply.results.map((result) => [result.target, result.reply.sent])).toEqual([["codex", true]]);
    registry.close();
  });

  it("a second click while one runs gets the first one's answer (no second round of installs)", async () => {
    const { registry, service, m, binding } = await added([["claude", "outdated"], ["codex", "outdated"]]);
    const first = service.updateAll("mini", binding());
    const second = service.updateAll("mini", binding());
    expect(second).toBe(first);
    await m.finish();
    await m.finish();
    await first;
    expect(m.installs()).toEqual(["claude", "codex"]);
    registry.close();
  });

  it("nothing out of date (or only missing ones): nothing is sent", async () => {
    const { registry, service, m, host, binding } = await added([["claude", "current"], ["cursor", "not_installed"]]);
    expect(updateAllTargets(host().integrations!.items)).toEqual([]);
    const reply = await service.updateAll("mini", binding());
    expect(reply.results).toEqual([]);
    expect(m.installs()).toEqual([]);
    registry.close();
  });
});

describe("Update all's door in the main process", () => {
  it("takes a machine id and a binding only; refusals are redacted as the install's are", async () => {
    const { registerIpc } = await import("../src/main/ipc");
    const { IPC } = await import("../src/shared/ipc-contract");
    const { APP_ORIGIN } = await import("../src/main/protocol");
    const calls: unknown[][] = [];
    registerIpc({
      hosts: { list: () => [] },
      integrations: {
        install: () => Promise.resolve({ sent: false, note: "n" }),
        refresh: () => Promise.resolve(),
        updateAll: (...args: unknown[]) => (calls.push(args), Promise.resolve({ results: [{ target: "codex", reply: { sent: false, note: "refused" } }], note: null })),
      },
    } as never);
    const handler = registered.handles.get(IPC.integrationUpdateAll)!;
    const event = { senderFrame: { url: `${APP_ORIGIN}/index.html` }, sender: { getURL: () => `${APP_ORIGIN}/index.html` } };
    const good = { incarnation: 1, connection: 1, epoch: 0 };
    await expect(handler(event, "mini", { incarnation: -1, connection: 1, epoch: 0 })).rejects.toThrow("bad request");
    await expect(handler(event, "mini", good, "extra")).rejects.toThrow("bad request");
    await expect(handler(event, "mini", good)).resolves.toEqual({ results: [{ target: "codex", reply: { sent: false, note: "refused" } }], note: null });
    expect(calls).toEqual([["mini", good]]);
  });
});

describe("Settings › Machines: Update all above the rows", () => {
  beforeEach(() => {
    integrationNotes.reset();
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
  });
  afterEach(() => vi.unstubAllGlobals());

  const item = (target: string, name: string, state: IntegrationItem["state"], available = true): IntegrationItem => ({ target, kind: target, name, state, available });
  const mini = (items: IntegrationItem[], updatingAll = false): HostView =>
    ({
      id: "mini",
      name: "Mac mini",
      kind: "ssh",
      address: "dev@mini",
      platform: "macOS",
      state: "connected",
      error: null,
      topology: null,
      fetchedAtMs: 0,
      incarnation: 2,
      connection: 4,
      epoch: 7,
      integrations: { incarnation: 2, connection: 4, epoch: 7, items, outcomes: {}, ...(updatingAll ? { updatingAll: true as const } : {}) },
    }) as HostView;
  const three = [item("claude", "Claude Code", "outdated"), item("codex", "Codex", "outdated"), item("cursor", "Cursor Agent", "not_installed"), item("grok", "Grok Build", "outdated"), item("pi", "Pi", "outdated", false)];
  const render = (host: HostView, bridge: Record<string, unknown>): HookHost<object> => {
    const view = new HookHost<object>(IntegrationsLine as (props: object) => unknown, { host, bridge });
    view.render();
    return view;
  };
  const allButton = (view: HookHost<object>) => elements(view.tree).find((element) => element.props["data-integrations-update-all"] !== undefined);

  it("shows Update all (3) for three shown out-of-date rows (a missing one and one Herdr does not find are not counted)", () => {
    const view = render(mini(three), {});
    expect(allButton(view)?.props["children"]).toBe(updateAllTexts.button(3));
    expect(allButton(view)?.props["children"]).toBe("Update all (3)");
    expect(allButton(view)?.props["disabled"]).toBe(false);
  });

  it("no button with nothing out of date, or only missing ones", () => {
    expect(allButton(render(mini([item("claude", "Claude Code", "current"), item("cursor", "Cursor Agent", "not_installed")]), {}))).toBeUndefined();
  });

  it("a click asks once, bound to the machine as shown; each refusal is its own row's note; greyed while it runs", async () => {
    const calls: unknown[][] = [];
    const bridge = {
      updateAllIntegrations: (...args: unknown[]) => (
        calls.push(args),
        Promise.resolve({ results: [{ target: "claude", reply: { sent: true, outcome: {} } }, { target: "codex", reply: { sent: false, note: "Not installed: Herdr on Mac mini does not list this integration as missing now. Nothing was sent." } }], note: null })
      ),
    };
    const view = render(mini(three), bridge);
    (allButton(view)!.props["onClick"] as () => void)();
    (allButton(view)!.props["onClick"] as () => void)();
    await flush();
    expect(calls).toEqual([["mini", { incarnation: 2, connection: 4, epoch: 7 }]]);
    expect(integrationNotes.note("mini", "codex")).toMatch(/^Not installed: Herdr on Mac mini/);
    expect(integrationNotes.note("mini", "claude")).toBeNull();
    expect(allButton(render(mini(three, true), bridge))?.props["disabled"]).toBe(true);
  });
});
