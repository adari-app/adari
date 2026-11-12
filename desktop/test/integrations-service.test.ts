// The main process's reads and installs of
// Herdr's agent integrations (src/main/integrations.ts) on a real HostRegistry,
// each machine a fake Herdr behind a real HerdrClient (the request lines are
// what would go on the socket). No real Herdr, no socket, no network.

import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { HerdrClient } from "../src/main/herdr/client";
import { decodeIntegrationInstallResult, decodeIntegrationListResult, decodeSessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { IntegrationService, shownItems } from "../src/main/integrations";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import { integrationMessageLines, integrationTargets, maxIntegrationLines, shownIntegrations, type IntegrationBinding } from "../src/shared/integrations";
import { chatReads } from "../src/shared/chat/kinds";
import { sessionRefFromAgentSession } from "../src/shared/chat/locator";
import type { HostView } from "../src/shared/ipc-contract";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const topology = decodeSessionTopology({ version: "0.9.5", protocol: 22, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] });

type Reply = { readonly result: unknown } | { readonly error: { readonly code: string; readonly message: string } };

interface FakeHerdr {
  /** integration.list's answer (default: the four the MacBook's clean home had, all not installed). */
  list: () => Reply;
  /** integration.install's answer for a target. */
  install: (target: string) => Reply;
}

const info = (target: string, state: string, available = true) => ({ target, label: target, command: target, available, state });

function machine(id: string, herdr: Partial<FakeHerdr> = {}) {
  const requests: { method: string; params: Record<string, unknown>; epoch: number }[] = [];
  const states = new Map<string, string>([
    ["claude", "not_installed"],
    ["codex", "not_installed"],
    ["cursor", "not_installed"],
    ["grok", "not_installed"],
    ["devin", "not_installed"],
  ]);
  const fake: FakeHerdr = {
    list: () => ({ result: { type: "integration_list", integrations: [...states].map(([target, state]) => info(target, state)) } }),
    install: (target) => {
      states.set(target, "current");
      return { result: { type: "integration_install", target, details: { messages: [`Installed the ${target} integration.`] } } };
    },
    ...herdr,
  };
  let epoch = 1;
  let online = true;
  const transport = {
    roundTrip(line: string): Promise<string> {
      const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      requests.push({ method: request.method, params: request.params, epoch });
      const reply = request.method === "integration.list" ? fake.list() : request.method === "integration.install" ? fake.install(String(request.params["target"])) : { error: { code: "unknown_method", message: "no such method" } };
      return Promise.resolve(JSON.stringify({ id: request.id, ...reply }));
    },
    close: () => undefined,
  };
  const client = new HerdrClient(transport);
  const backend = {
    kind: "herdr-tui" as const,
    snapshot: () => (online ? Promise.resolve(topology) : Promise.reject(new Error("offline"))),
    connectionEpoch: () => epoch,
    integrations: () => client,
    close: () => undefined,
  };
  return {
    descriptor: { id, name: id === "mini" ? "Mac mini" : id, kind: "ssh" as const, address: `dev@${id}`, platform: "macOS" },
    backend,
    requests,
    states,
    fake,
    lists: () => requests.filter((request) => request.method === "integration.list").length,
    installs: () => requests.filter((request) => request.method === "integration.install"),
    setOnline: (value: boolean) => {
      online = value;
    },
    setEpoch: (value: number) => {
      epoch = value;
    },
  };
}

function world() {
  let service: IntegrationService | null = null;
  const registry = new HostRegistry(() => service?.hostsChanged());
  service = new IntegrationService(registry);
  return { registry, service };
}

async function added(id = "mini", herdr: Partial<FakeHerdr> = {}) {
  const w = world();
  const m = machine(id, herdr);
  w.registry.add(m.descriptor, m.backend as never);
  await w.registry.refresh(id);
  await flush();
  const host = (): HostView => w.registry.list().find((entry) => entry.id === id)!;
  const binding = (): IntegrationBinding => ({ incarnation: host().incarnation!, connection: host().connection!, epoch: host().epoch ?? null });
  return { ...w, m, host, binding };
}

describe("integration.list, read once per machine and connection", () => {
  it("reads it once when the machine connects, not again on later snapshots of the same connection", async () => {
    const { registry, m, host } = await added();
    expect(m.lists()).toBe(1);
    for (let i = 0; i < 4; i += 1) await registry.refresh("mini");
    await flush();
    expect(m.lists()).toBe(1);
    expect(host().integrations?.items.map((item) => [item.target, item.state])).toEqual([
      ["claude", "not_installed"],
      ["codex", "not_installed"],
      ["cursor", "not_installed"],
      ["grok", "not_installed"],
    ]);
    registry.close();
  });

  it("reads it again on a new connection (the machine answered again after it stopped), and not before", async () => {
    const { registry, m, host } = await added();
    const first = host().connection;
    m.setOnline(false);
    await registry.refresh("mini");
    await flush();
    expect(host().integrations).toBeUndefined();
    expect(m.lists()).toBe(1);
    m.setOnline(true);
    await registry.refresh("mini");
    await flush();
    expect(host().connection).not.toBe(first);
    expect(m.lists()).toBe(2);
    expect(host().integrations?.connection).toBe(host().connection);
    registry.close();
  });

  it("Settings opening reads each machine that answered again", async () => {
    const { registry, service, m, host } = await added();
    m.states.set("codex", "current");
    await service.refresh();
    await flush();
    expect(m.lists()).toBe(2);
    expect(host().integrations?.items.find((item) => item.target === "codex")?.state).toBe("current");
    registry.close();
  });

  it("a machine whose Herdr does not answer it shows nothing and is never asked again on that connection", async () => {
    const { registry, service, m, host } = await added("mini", { list: () => ({ error: { code: "unknown_method", message: "integration.list is not a method" } }) });
    expect(m.lists()).toBe(1);
    expect(host().integrations).toBeUndefined();
    await service.refresh();
    for (let i = 0; i < 3; i += 1) await registry.refresh("mini");
    service.hostsChanged();
    await flush();
    expect(m.lists()).toBe(1);
    expect(host().integrations).toBeUndefined();
    // Nor is anything installed on it.
    const reply = await service.install("mini", "codex", { incarnation: host().incarnation!, connection: host().connection!, epoch: host().epoch ?? null });
    expect(reply.sent).toBe(false);
    expect(m.installs()).toEqual([]);
    registry.close();
  });

  it("a reply that does not decode is not answering it either", async () => {
    const { registry, service, m, host } = await added("mini", { list: () => ({ result: { type: "something_else" } }) });
    await service.refresh();
    await flush();
    expect(m.lists()).toBe(1);
    expect(host().integrations).toBeUndefined();
    registry.close();
  });

  it("herdr-core (no integration calls) is never asked and shows nothing", async () => {
    const w = world();
    const m = machine("core");
    const { integrations: _none, ...core } = m.backend;
    w.registry.add(m.descriptor, { ...core, kind: "herdr-core" } as never);
    await w.registry.refresh("core");
    await flush();
    await w.service.refresh();
    expect(m.requests).toEqual([]);
    expect(w.registry.list()[0]!.integrations).toBeUndefined();
    w.registry.close();
  });

  it("the registry shows a list only while the machine answers on the entry and connection it was read on", async () => {
    const { registry, host, m } = await added();
    const read = host().integrations!;
    registry.setIntegrations("mini", { ...read, connection: read.connection + 7 });
    expect(host().integrations).toBeUndefined();
    registry.setIntegrations("mini", read);
    expect(host().integrations).toEqual(read);
    m.setOnline(false);
    await registry.refresh("mini");
    expect(host().integrations).toBeUndefined();
    registry.close();
  });
});

describe("only the kinds Chat reads a Herdr session for", () => {
  it("are Herdr targets whose kind Chat reads and whose herdr:<target> session the locator follows; Devin and Qoder are not", () => {
    for (const { target, kind } of shownIntegrations) {
      expect(integrationTargets).toContain(target);
      expect(chatReads(kind), kind).toBe(true);
    }
    // Each shown target's session as its hook names it (an id, or a path for the path-named ones) is one the locator turns into a transcript.
    const valid: Record<string, { kind: string; value: string }> = {
      opencode: { kind: "id", value: "ses_0123456789abcdefABCDEF" },
      kilo: { kind: "id", value: "ses_0123456789abcdefABCDEF" },
      hermes: { kind: "id", value: "20260101_101010_abcdef" },
      mastracode: { kind: "id", value: "0123456789abcdef0123456789abcdef" },
      kimi: { kind: "id", value: "session_0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84" },
    };
    for (const { target } of shownIntegrations) {
      const session = valid[target] ?? { kind: "id", value: "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84" };
      const ref = sessionRefFromAgentSession({ source: `herdr:${target}`, agent: target, kind: session.kind, value: session.value } as never);
      expect(ref, `the locator follows herdr:${target}`).not.toBeNull();
    }
    const shown = shownIntegrations.map((entry) => entry.target);
    expect(shown).not.toContain("devin");
    expect(shown).not.toContain("qodercli");
    expect(shown.slice(0, 2)).toEqual(["claude", "codex"]);
  });

  it("the list keeps only those, in the agent table's order, and drops a state Herdr may add later", () => {
    const items = shownItems([
      info("grok", "outdated"),
      info("devin", "not_installed"),
      info("qodercli", "current"),
      info("codex", "current"),
      info("claude", "outdated"),
      info("pi", "half_installed"),
      info("antigravity_cli", "not_installed", false),
    ]);
    expect(items.map((item) => `${item.name}=${item.state}${item.available ? "" : " (not available)"}`)).toEqual([
      "Claude Code=outdated",
      "Codex=current",
      "Grok Build=outdated",
      "Antigravity CLI=not_installed (not available)",
    ]);
  });

  it("decodes the 0.9.5 result shapes (under `integrations`, or a bare array; the install's lines under details.messages)", () => {
    expect(decodeIntegrationListResult({ type: "integration_list", integrations: [info("codex", "current")] }, "$")).toEqual([info("codex", "current")]);
    expect(decodeIntegrationListResult([info("codex", "outdated")], "$")[0]!.state).toBe("outdated");
    expect(() => decodeIntegrationListResult({ type: "x" }, "$")).toThrow();
    expect(decodeIntegrationInstallResult({ type: "integration_install", target: "codex", details: { messages: ["a", "b"] } }, "$")).toEqual(["a", "b"]);
    // Messages outside `details` are not Herdr's shape: malformed, not a success with no lines.
    expect(() => decodeIntegrationInstallResult({ type: "integration_install", messages: ["a", "b"] }, "$")).toThrow();
    expect(() => decodeIntegrationInstallResult({ type: "ok" }, "$")).toThrow();
    expect(() => decodeIntegrationInstallResult(null, "$")).toThrow();
  });

  it("the client's lines are Herdr's methods with exactly { target }", () => {
    const client = new HerdrClient({ roundTrip: () => Promise.resolve(""), close: () => undefined });
    expect(JSON.parse(client.encodeRequest("integration.install", { target: "codex" }))).toMatchObject({ method: "integration.install", params: { target: "codex" } });
  });
});

describe("Install, on the user's click only", () => {
  it("sends one integration.install with the right target on the connection the window showed, then reads the state again", async () => {
    const { registry, service, m, host, binding } = await added();
    expect(m.installs()).toEqual([]);
    const reply = await service.install("mini", "codex", binding());
    await flush();
    expect(m.installs()).toEqual([{ method: "integration.install", params: { target: "codex" }, epoch: 1 }]);
    expect(reply).toEqual({ sent: true, outcome: { phase: "installed", text: "Installed. Restart Codex so it uses it.", messages: ["Installed the codex integration."], action: "install" } });
    expect(m.lists()).toBe(2);
    expect(host().integrations?.items.find((item) => item.target === "codex")?.state).toBe("current");
    expect(host().integrations?.outcomes["codex"]?.phase).toBe("installed");
    registry.close();
  });

  it("a second click while one runs gets the first one's answer (one request)", async () => {
    let release: (() => void) | null = null;
    const { registry, m, host } = await added();
    const w = world();
    w.registry.close();
    const service = new IntegrationService({
      list: () => registry.list(),
      backend: (id) => {
        const backend = registry.backend(id);
        if (backend === null) return null;
        const client = backend.integrations!();
        return {
          integrations: () => ({
            integrationList: () => client.integrationList(),
            integrationInstall: async (target: string) => {
              await new Promise<void>((resolve) => (release = resolve));
              return client.integrationInstall(target);
            },
          }),
        };
      },
      connectionIdentity: (id) => registry.connectionIdentity(id),
      connection: (id) => registry.connection(id),
      name: (id) => registry.name(id),
      setIntegrations: (id, value) => registry.setIntegrations(id, value),
    });
    service.hostsChanged();
    await flush();
    const binding = { incarnation: host().incarnation!, connection: host().connection!, epoch: host().epoch ?? null };
    const first = service.install("mini", "codex", binding);
    const second = service.install("mini", "codex", binding);
    await flush();
    expect(host().integrations?.outcomes["codex"]?.phase).toBe("installing");
    release!();
    expect(await second).toEqual(await first);
    expect(m.installs()).toHaveLength(1);
    registry.close();
  });

  it("refuses with a note and sends nothing for a machine removed since", async () => {
    const { registry, service, m, binding } = await added();
    const shown = binding();
    registry.remove("mini");
    const reply = await service.install("mini", "codex", shown);
    expect(reply).toEqual({ sent: false, note: "Not installed: that machine is no longer listed. Nothing was sent." });
    expect(m.installs()).toEqual([]);
    registry.close();
  });

  it("refuses for a machine reconnected since (a new connection number), and for a new command connection (epoch)", async () => {
    const { registry, service, m, binding } = await added();
    const shown = binding();
    m.setOnline(false);
    await registry.refresh("mini");
    m.setOnline(true);
    await registry.refresh("mini");
    await flush();
    expect(await service.install("mini", "codex", shown)).toEqual({ sent: false, note: "Not installed: the connection to Mac mini changed since this showed. Nothing was sent." });
    const now = binding();
    m.setEpoch(2);
    expect(await service.install("mini", "codex", now)).toEqual({ sent: false, note: "Not installed: the connection to Mac mini changed since this showed. Nothing was sent." });
    expect(m.installs()).toEqual([]);
    registry.close();
  });

  it("refuses an offline machine, another entry (an edit), and a target Herdr does not list as missing or old", async () => {
    const { registry, service, m, binding } = await added();
    const shown = binding();
    expect(await service.install("mini", "codex", { ...shown, incarnation: shown.incarnation + 1 })).toMatchObject({ sent: false });
    m.states.set("grok", "current");
    await service.refresh();
    expect(await service.install("mini", "grok", binding())).toEqual({ sent: false, note: "Not installed: Herdr on Mac mini does not list this integration as missing now. Nothing was sent." });
    m.setOnline(false);
    await registry.refresh("mini");
    expect(await service.install("mini", "codex", shown)).toEqual({ sent: false, note: "Not installed: Mac mini is offline. Nothing was sent." });
    expect(m.installs()).toEqual([]);
    registry.close();
  });

  it("Update is the same call for an outdated one", async () => {
    const { registry, service, m, binding } = await added();
    m.states.set("claude", "outdated");
    await service.refresh();
    const reply = await service.install("mini", "claude", binding());
    expect(m.installs().map((request) => request.params)).toEqual([{ target: "claude" }]);
    expect(reply).toMatchObject({ sent: true, outcome: { phase: "installed", action: "update", text: "Installed. Restart Claude Code so it uses it." } });
    registry.close();
  });

  it("a failure shows Herdr's message without its code", async () => {
    const { registry, service, host, binding } = await added("mini", { install: () => ({ error: { code: "integration_install_failed", message: "could not write the hooks file: permission denied" } }) });
    const reply = await service.install("mini", "codex", binding());
    expect(reply).toEqual({ sent: true, outcome: { phase: "failed", text: "Not installed: could not write the hooks file: permission denied", messages: [], action: "install" } });
    expect(JSON.stringify(host().integrations)).not.toContain("integration_install_failed");
    registry.close();
  });

  it("a failure whose message starts with a code has the code taken off too", async () => {
    const { registry, service, binding } = await added("mini", { install: () => ({ error: { code: "io_error", message: "io_error: disk full" } }) });
    const reply = await service.install("mini", "codex", binding());
    expect(reply.sent && reply.outcome.text).toBe("Not installed: disk full");
    registry.close();
  });

  it("Herdr's messages come back as bounded plain lines", async () => {
    const long = "x".repeat(500);
    const { registry, service, binding } = await added("mini", {
      install: (target) => ({ result: { type: "integration_install", target, details: { messages: ["<b>bold</b>\nsecond line\u0007", long, ...Array.from({ length: 12 }, (_, i) => `line ${i}`)] } } }),
    });
    const reply = await service.install("mini", "codex", binding());
    const lines = reply.sent ? reply.outcome.messages : [];
    expect(lines[0]).toBe("<b>bold</b>");
    expect(lines[1]).toBe("second line");
    expect(lines[2]!.length).toBe(240);
    expect(lines).toHaveLength(maxIntegrationLines);
    expect(lines.at(-1)).toBe("(8 more lines not shown)");
    expect(integrationMessageLines([42, null, "  ", "ok"])).toEqual(["ok"]);
    registry.close();
  });

  it("the page's request is checked: a target that is not shown or a malformed binding is a bad request", async () => {
    const { registerIpc } = await import("../src/main/ipc");
    const { IPC } = await import("../src/shared/ipc-contract");
    const { APP_ORIGIN } = await import("../src/main/protocol");
    const calls: unknown[][] = [];
    registerIpc({
      hosts: { list: () => [] },
      integrations: { install: (...args: unknown[]) => (calls.push(args), Promise.resolve({ sent: false, note: "n" })), refresh: () => Promise.resolve() },
    } as never);
    const handler = registered.handles.get(IPC.integrationInstall)!;
    const event = { senderFrame: { url: `${APP_ORIGIN}/index.html` }, sender: { getURL: () => `${APP_ORIGIN}/index.html` } };
    const good = { incarnation: 1, connection: 1, epoch: 0 };
    await expect(handler(event, "mini", "devin", good)).rejects.toThrow();
    await expect(handler(event, "mini", "codex", { incarnation: -1, connection: 1, epoch: 0 })).rejects.toThrow();
    await expect(handler(event, "mini", "codex", good)).resolves.toEqual({ sent: false, note: "n" });
    expect(calls).toEqual([["mini", "codex", good]]);
  });
});

describe("the demo's Herdr (captures only, never a real connection)", () => {
  it("answers integration.list and integration.install, and the service reads and installs on it", async () => {
    const fixtures = bundledFixturesForTests();
    const demo = demoHosts(fixtures, Date.now()).find((each) => each.descriptor.id === demoHostIds.macMini)!;
    const backend = new DemoBackend(demo, fixtures);
    const w = world();
    w.registry.add(demo.descriptor, backend);
    await w.registry.refresh(demo.descriptor.id);
    await flush();
    const host = () => w.registry.list().find((entry) => entry.id === demo.descriptor.id)!;
    expect(host().integrations?.items.filter((item) => item.available).map((item) => `${item.target}=${item.state}`)).toEqual(["claude=current", "codex=current", "cursor=current", "grok=current"]);
    const restore = backend.setIntegration("codex", "not_installed");
    w.service.forgetForCapture(demo.descriptor.id);
    await flush();
    expect(host().integrations?.items.find((item) => item.target === "codex")?.state).toBe("not_installed");
    const reply = await w.service.install(demo.descriptor.id, "codex", { incarnation: host().incarnation!, connection: host().connection!, epoch: host().epoch ?? null });
    expect(reply.sent).toBe(true);
    expect(backend.transport.installs).toEqual(["codex"]);
    expect(host().integrations?.items.find((item) => item.target === "codex")?.state).toBe("current");
    restore();
    w.registry.close();
  });
});
