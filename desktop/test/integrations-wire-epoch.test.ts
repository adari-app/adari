// Herdr's real `integration.install` reply carries its lines under
// `details.messages`, and a reply of any other shape is a plain failure line;
// a new command connection (epoch) reads the list again, with nothing kept
// from the last one. A real HostRegistry and HerdrClient over a fake Herdr
// (the request lines are what would go on the socket). No real Herdr, no
// socket, no network.

import { afterEach, describe, expect, it } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { decodeIntegrationInstallResult, decodeSessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { IntegrationService } from "../src/main/integrations";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import type { IntegrationBinding } from "../src/shared/integrations";
import type { HostView } from "../src/shared/ipc-contract";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

const topology = decodeSessionTopology({ version: "0.9.5", protocol: 22, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] });

const info = (target: string, state: string) => ({ target, label: target, command: target, available: true, state });

/** Herdr 0.9.5's reply to integration.install (its bundled schema: type, target, details.messages, all required). */
const installed = (target: string, messages: readonly string[]) => ({ type: "integration_install", target, details: { messages } });

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** One machine: a fake Herdr behind a real HerdrClient; `list` and `install` answer each request (a throw is Herdr's error). */
function machine(id = "mini") {
  const requests: { method: string; params: Record<string, unknown>; epoch: number }[] = [];
  let epoch = 1;
  let online = true;
  let list: () => unknown = () => ({ type: "integration_list", integrations: [info("codex", "not_installed")] });
  let install: (target: string) => unknown = (target) => installed(target, [`Installed the ${target} integration.`]);
  const client = new HerdrClient({
    roundTrip: async (line: string) => {
      const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      requests.push({ method: request.method, params: request.params, epoch });
      try {
        const result = await (request.method === "integration.list" ? list() : install(String(request.params["target"])));
        return JSON.stringify({ id: request.id, result });
      } catch (error) {
        return JSON.stringify({ id: request.id, error: { code: "server_error", message: (error as Error).message } });
      }
    },
    close: () => undefined,
  });
  const backend = {
    kind: "herdr-tui" as const,
    snapshot: () => (online ? Promise.resolve(topology) : Promise.reject(new Error("offline"))),
    connectionEpoch: () => epoch,
    integrations: () => client,
    close: () => undefined,
  };
  return {
    descriptor: { id, name: id === "mini" ? "Mac mini" : id, kind: "ssh" as const, address: `fixture@${id}`, platform: "macOS" },
    backend,
    lists: () => requests.filter((request) => request.method === "integration.list"),
    installs: () => requests.filter((request) => request.method === "integration.install"),
    setEpoch: (value: number) => (epoch = value),
    setOnline: (value: boolean) => (online = value),
    setList: (next: () => unknown) => (list = next),
    setInstall: (next: (target: string) => unknown) => (install = next),
  };
}

const registries: HostRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
});

async function connected(m = machine()) {
  let service: IntegrationService | null = null;
  const registry = new HostRegistry(() => service?.hostsChanged());
  registries.push(registry);
  service = new IntegrationService(registry);
  registry.add(m.descriptor, m.backend as never);
  await registry.refresh(m.descriptor.id);
  await flush();
  const host = (): HostView => registry.list().find((entry) => entry.id === m.descriptor.id)!;
  const binding = (): IntegrationBinding => ({ incarnation: host().incarnation!, connection: host().connection!, epoch: host().epoch ?? null });
  return { registry, service: service!, m, host, binding };
}

describe("Herdr's real integration.install reply", () => {
  it("decodes the lines under details.messages", () => {
    expect(decodeIntegrationInstallResult(installed("codex", ["Hooks written.", "Restart the agent."]), "$")).toEqual(["Hooks written.", "Restart the agent."]);
    expect(decodeIntegrationInstallResult(installed("codex", []), "$")).toEqual([]);
  });

  it("any other shape is malformed, never a silent success with no lines", () => {
    const shapes: unknown[] = [
      { type: "integration_install", messages: ["top-level lines are not Herdr's shape"] },
      { type: "integration_install", target: "codex" },
      { type: "integration_install", target: "codex", details: {} },
      { type: "integration_install", target: "codex", details: { messages: "one string" } },
      { type: "integration_install", target: "codex", details: { messages: ["ok", 7] } },
      { type: "integration_list", target: "codex", details: { messages: [] } },
      { details: { messages: [] } },
      [],
      null,
      undefined,
      "Installed",
    ];
    for (const shape of shapes) expect(() => decodeIntegrationInstallResult(shape, "$"), JSON.stringify(shape) ?? "undefined").toThrow();
  });

  it("round trip: a fake Herdr's real reply through HerdrClient and the service reaches the machine's outcome as bounded, redacted lines", async () => {
    const m = machine();
    // As Herdr does, its list says current once the install went (a list that still
    // said not installed after it would now, rightly, bring Install back and clear the outcome).
    let done = false;
    m.setInstall((target) => ((done = true), installed(target, ["Wrote the hook to ~/.codex/hooks.json for token sk-fixture-secret.", "<b>Restart</b> the agent.\u0007\nsecond", "x".repeat(400)])));
    m.setList(() => ({ type: "integration_list", integrations: [info("codex", done ? "current" : "not_installed")] }));
    let service: IntegrationService | null = null;
    const registry = new HostRegistry(() => service?.hostsChanged());
    registries.push(registry);
    service = new IntegrationService(registry, (text) => text.replaceAll("sk-fixture-secret", "[redacted]"));
    registry.add(m.descriptor, m.backend as never);
    await registry.refresh("mini");
    await flush();
    const host = registry.list()[0]!;
    const reply = await service.install("mini", "codex", { incarnation: host.incarnation!, connection: host.connection!, epoch: host.epoch ?? null });
    await flush();
    expect(m.installs()).toEqual([{ method: "integration.install", params: { target: "codex" }, epoch: 1 }]);
    const lines = ["Wrote the hook to ~/.codex/hooks.json for token [redacted].", "<b>Restart</b> the agent.", "second", `${"x".repeat(239)}\u2026`];
    expect(reply).toEqual({ sent: true, outcome: { phase: "installed", text: "Installed. Restart Codex so it uses it.", messages: lines, action: "install" } });
    expect(registry.list()[0]!.integrations?.outcomes["codex"]?.messages).toEqual(lines);
  });

  it("a success reply in another shape is a plain failure line (no path, no code), and the state is read again", async () => {
    const { service, m, host, binding } = await connected();
    m.setInstall(() => ({ type: "integration_install", messages: ["the old guess"] }));
    const reply = await service.install("mini", "codex", binding());
    await flush();
    expect(reply).toEqual({ sent: true, outcome: { phase: "failed", text: "Not installed: Herdr's reply could not be read.", messages: [], action: "install" } });
    expect(host().integrations?.outcomes["codex"]?.phase).toBe("failed");
    expect(m.lists()).toHaveLength(2);
  });

  it("a reply naming another target is malformed too", async () => {
    const { service, m, binding } = await connected();
    m.setInstall(() => installed("claude", ["Installed the claude integration."]));
    const reply = await service.install("mini", "codex", binding());
    expect(reply.sent && reply.outcome).toMatchObject({ phase: "failed", text: "Not installed: Herdr's reply could not be read.", messages: [] });
  });

  it("an Update's malformed reply says Not updated", async () => {
    const m = machine();
    m.setList(() => ({ type: "integration_list", integrations: [info("codex", "outdated")] }));
    m.setInstall(() => ({ ok: true }));
    const { service, binding } = await connected(m);
    const reply = await service.install("mini", "codex", binding());
    expect(reply.sent && reply.outcome.text).toBe("Not updated: Herdr's reply could not be read.");
  });

  it("the demo's Herdr answers in the real shape (captures show Herdr's lines)", async () => {
    const fixtures = bundledFixturesForTests();
    const demo = demoHosts(fixtures, Date.now()).find((each) => each.descriptor.id === demoHostIds.macMini)!;
    const backend = new DemoBackend(demo, fixtures);
    const restore = backend.setIntegration("codex", "not_installed");
    expect(await backend.integrations().integrationInstall("codex")).toEqual(["Installed the codex integration.", "Running codex agents pick it up when they start again."]);
    restore();
    backend.close();
  });
});

describe("a new command connection reads the list again", () => {
  it("an epoch change with no offline snapshot between reads it again, on the same logical connection", async () => {
    const { registry, m, host } = await connected();
    const connection = host().connection;
    expect(m.lists()).toHaveLength(1);
    m.setEpoch(2);
    m.setList(() => ({ type: "integration_list", integrations: [info("codex", "outdated")] }));
    await registry.refresh("mini");
    await flush();
    expect(host().epoch).toBe(2);
    expect(host().connection).toBe(connection);
    expect(m.lists().map((request) => request.epoch)).toEqual([1, 2]);
    expect(host().integrations?.items[0]?.state).toBe("outdated");
    expect(host().integrations?.epoch).toBe(2);
    // Later snapshots on epoch 2 do not read it again.
    await registry.refresh("mini");
    await flush();
    expect(m.lists()).toHaveLength(2);
  });

  it("a list Herdr did not answer is asked again on the new command connection (and Install shows)", async () => {
    const m = machine();
    m.setList(() => {
      throw new Error("timed out");
    });
    const { registry, service, host } = await connected(m);
    expect(host().integrations).toBeUndefined();
    await service.refresh();
    expect(m.lists()).toHaveLength(1);
    m.setEpoch(2);
    m.setList(() => ({ type: "integration_list", integrations: [info("codex", "not_installed")] }));
    await registry.refresh("mini");
    await flush();
    expect(m.lists()).toHaveLength(2);
    expect(host().integrations?.items.map((item) => item.state)).toEqual(["not_installed"]);
  });

  it("outcomes from the last command connection are not kept", async () => {
    const { registry, service, m, host, binding } = await connected();
    m.setInstall(() => {
      throw new Error("could not write the hooks file");
    });
    await service.install("mini", "codex", binding());
    await flush();
    expect(host().integrations?.outcomes["codex"]?.phase).toBe("failed");
    m.setEpoch(2);
    await registry.refresh("mini");
    await flush();
    expect(host().integrations?.outcomes).toEqual({});
    expect(host().integrations?.items[0]?.state).toBe("not_installed");
  });

  it("a late list reply from the previous command connection is dropped", async () => {
    const m = machine();
    const first = held<unknown>();
    m.setList(() => first.promise);
    const { registry, host } = await connected(m);
    m.setEpoch(2);
    m.setList(() => ({ type: "integration_list", integrations: [info("codex", "outdated")] }));
    await registry.refresh("mini");
    await flush();
    expect(host().integrations?.items[0]?.state).toBe("outdated");
    first.resolve({ type: "integration_list", integrations: [info("codex", "not_installed")] });
    await flush();
    expect(host().integrations?.items[0]?.state).toBe("outdated");
    expect(host().integrations?.epoch).toBe(2);
  });

  it("a list read on the previous command connection is not shown once a snapshot comes on the new one", async () => {
    const { registry, host } = await connected();
    const read = host().integrations!;
    expect(read.epoch).toBe(1);
    registry.setIntegrations("mini", { ...read, epoch: 7 });
    expect(host().integrations).toBeUndefined();
    registry.setIntegrations("mini", read);
    expect(host().integrations).toEqual(read);
  });

  it("the install binding check stays: a click bound to the old command connection sends nothing", async () => {
    const { service, m, binding } = await connected();
    const old = binding();
    m.setEpoch(2);
    expect(await service.install("mini", "codex", old)).toEqual({ sent: false, note: "Not installed: the connection to Mac mini changed since this showed. Nothing was sent." });
    expect(m.installs()).toEqual([]);
  });

  it("an explicit offline and reconnect still reads it again", async () => {
    const { registry, m, host } = await connected();
    m.setOnline(false);
    await registry.refresh("mini");
    m.setOnline(true);
    m.setEpoch(2);
    await registry.refresh("mini");
    await flush();
    expect(m.lists()).toHaveLength(2);
    expect(host().integrations?.items).toHaveLength(1);
  });
});
