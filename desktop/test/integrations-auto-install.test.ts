// New agent installs Herdr's integration for the kind it starts, first.
// With Settings' switch on and the machine's list (read on this connection)
// saying the kind's integration is missing or old, New agent asks Herdr's
// `integration.install` through the existing install path before
// `agent.start`, waits a bounded time, says it in one line and starts the
// agent whatever came of it. Nothing else is installed. A real HostRegistry,
// IntegrationService and HerdrClient over a fake transport, the real
// registerIpc (Electron's ipcMain faked) and the real New agent with a fake
// Herdr. No real Herdr, no socket, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HerdrClient } from "../src/main/herdr/client";
import { HostRegistry } from "../src/main/hosts";
import { autoInstallWaitMs, fileIntegrationSettings, IntegrationService, memoryIntegrationSettings, type AutoInstallAlarm } from "../src/main/integrations";
import type { HostView } from "../src/shared/ipc-contract";
import { autoInstallTexts, decodeAutoInstall, integrationTexts } from "../src/shared/integrations";
import { paneTopology } from "./support/pane-topology";

const { chatIntegrationLook, chatUnreadIntegrationLine } = await import("../src/renderer/components/integrations");
const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

const info = (target: string, state: string, available = true) => ({ target, label: target, command: target, available, state });

/** A gate a test opens (a held reply). */
function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((done) => (open = done));
  return { wait, open };
}

type Install = "ok" | "refuse" | "fail" | "hold";

function machine(initial: Record<string, string>, options: { available?: boolean; integrations?: boolean } = {}) {
  const states = new Map(Object.entries(initial));
  /** Every request in order, Herdr's integration calls and New agent's, and when each install was answered. */
  const log: string[] = [];
  let epoch = 1;
  let install: Install = "ok";
  let held = gate();
  let listMode: "ok" | "error" | "hold" = "ok";
  let listHeld = gate();
  const transport = {
    async roundTrip(line: string): Promise<string> {
      const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      if (request.method === "integration.list") {
        log.push("integration.list");
        if (listMode === "error") return JSON.stringify({ id: request.id, error: { code: "unknown_method", message: "no such method" } });
        const snapshot = [...states].map(([target, state]) => info(target, state, options.available ?? true));
        if (listMode === "hold") await listHeld.wait;
        return JSON.stringify({ id: request.id, result: { type: "integration_list", integrations: snapshot } });
      }
      if (request.method === "integration.install") {
        const target = String(request.params["target"]);
        log.push(`integration.install ${target}`);
        if (install === "hold") await held.wait;
        if (install === "refuse") {
          log.push(`install answered ${target}`);
          return JSON.stringify({ id: request.id, error: { code: "integration_install_failed", message: "integration_install_failed: settings.json is not writable" } });
        }
        if (install === "fail") {
          log.push(`install failed ${target}`);
          throw new Error("the connection closed");
        }
        states.set(target, "current");
        log.push(`install answered ${target}`);
        return JSON.stringify({ id: request.id, result: { type: "integration_install", target, details: { messages: [`installed ${target} integration hook`] } } });
      }
      return JSON.stringify({ id: request.id, error: { code: "unknown_method", message: "no such method" } });
    },
    close: () => undefined,
  };
  const client = new HerdrClient(transport);
  let pane = 0;
  const herdr = {
    agentList: async () => (log.push("agent.list"), []),
    createTerminalTab: async (workspace: string) => {
      pane += 1;
      log.push("tab.create");
      return { tab: { tabID: `w1:tn${pane}`, workspaceID: workspace }, rootPane: { paneID: `w1:pn${pane}`, workspaceID: workspace } };
    },
    startAgent: async (name: string, kind: string, paneID: string) => (log.push(`agent.start ${kind}`), { paneID, name, agent: kind }),
    closePane: async () => undefined,
    sendInput: async () => undefined,
  };
  let onStartCommands: (() => Promise<void>) | null = null;
  const backend = {
    kind: "herdr-tui" as const,
    snapshot: () => Promise.resolve(paneTopology([{ id: "w1:p1" }])),
    connectionEpoch: () => epoch,
    ...(options.integrations === false ? {} : { integrations: () => client }),
    workspaceActions: () => herdr,
    readStartCommandsFile: async () => {
      await onStartCommands?.();
      return null;
    },
    close: () => undefined,
  };
  return {
    descriptor: { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "dev@mini", platform: "macOS" },
    backend,
    states,
    log,
    setInstall: (mode: Install) => {
      install = mode;
      held = gate();
    },
    release: () => held.open(),
    setList: (mode: "ok" | "error" | "hold") => {
      listMode = mode;
      listHeld = gate();
    },
    releaseList: () => listHeld.open(),
    setEpoch: (value: number) => {
      epoch = value;
    },
    whenStartCommandsRead: (hook: () => Promise<void>) => {
      onStartCommands = hook;
    },
  };
}

/** A timer the test rings. */
function testAlarm() {
  const rings: { ms: number; ring(): void }[] = [];
  const alarm: AutoInstallAlarm = (ms) => {
    const g = gate();
    rings.push({ ms, ring: g.open });
    return { rang: g.wait, cancel: () => undefined };
  };
  return { alarm, rings };
}

async function world(initial: Record<string, string>, options: { available?: boolean; integrations?: boolean; switchOn?: boolean } = {}) {
  let service: IntegrationService | null = null;
  const registry = new HostRegistry(() => service?.hostsChanged());
  const timer = testAlarm();
  service = new IntegrationService(registry, (text) => text, memoryIntegrationSettings(options.switchOn ?? true), timer.alarm);
  const m = machine(initial, options);
  registry.add(m.descriptor, m.backend as never);
  await registry.refresh("mini");
  await flush();
  registered.handles.clear();
  registerIpc({ hosts: registry, integrations: service } as never);
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
  const start = (kind: string) => registered.handles.get(IPC.newAgent)!(event, "mini", { workspaceId: "w1", folder: null, kind }) as Promise<{ paneId: string; summary: string | null }>;
  const host = (): HostView => registry.list().find((entry) => entry.id === "mini")!;
  return { registry, service: service!, m, host, start, timer, event };
}

const installs = (log: readonly string[]): string[] => log.filter((line) => line.startsWith("integration.install"));

beforeEach(() => {
  registered.handles.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("New agent installs the kind's integration first", () => {
  it("missing: installed, then started; the install's reply comes before agent.start; the one line says it; the pane counts as started after it", async () => {
    const w = await world({ codex: "not_installed" });
    const result = await w.start("codex");
    const log = w.m.log;
    expect(installs(log)).toEqual(["integration.install codex"]);
    expect(log.indexOf("install answered codex")).toBeLessThan(log.indexOf("agent.start codex"));
    expect(log.indexOf("integration.install codex")).toBeLessThan(log.indexOf("agent.list"));
    expect(result.summary).toBe("Installed Herdr's Codex integration on Mac mini.");
    expect(w.host().integrations?.startedAfter?.["codex"]).toEqual([result.paneId]);
    // Chat's line for it is the first-message one, not the restart steps.
    const look = chatIntegrationLook(w.host(), "codex", null, false, result.paneId);
    expect(look?.line).toBe(integrationTexts.firstMessage("Codex"));
  });

  it("outdated: updated, then started, the line says Updated", async () => {
    const w = await world({ claude: "outdated" });
    const result = await w.start("claude");
    expect(installs(w.m.log)).toEqual(["integration.install claude"]);
    expect(w.m.log.indexOf("install answered claude")).toBeLessThan(w.m.log.indexOf("agent.start claude"));
    expect(result.summary).toBe("Updated Herdr's Claude Code integration on Mac mini.");
  });

  it("Antigravity CLI listed available: false is still installed (available is not a reason to skip)", async () => {
    const w = await world({ antigravity_cli: "not_installed" }, { available: false });
    const result = await w.start("agy");
    expect(installs(w.m.log)).toEqual(["integration.install antigravity_cli"]);
    expect(result.summary).toBe("Installed Herdr's Antigravity CLI integration on Mac mini.");
  });

  it("current: no install call, no line", async () => {
    const w = await world({ codex: "current" });
    const result = await w.start("codex");
    expect(installs(w.m.log)).toEqual([]);
    expect(result.summary).toBeNull();
    expect(w.m.log).toContain("agent.start codex");
  });

  it("the switch off: no install call, the agent starts as today, Install stays in Chat", async () => {
    const w = await world({ codex: "not_installed" }, { switchOn: false });
    const result = await w.start("codex");
    expect(installs(w.m.log)).toEqual([]);
    expect(result.summary).toBeNull();
    expect(w.m.log).toContain("agent.start codex");
    expect(chatIntegrationLook(w.host(), "codex", null, false, result.paneId)?.button?.label).toBe("Install");
  });

  it("the list not read on this connection (Herdr did not answer it): the agent starts, no install call", async () => {
    let service: IntegrationService | null = null;
    const registry = new HostRegistry(() => service?.hostsChanged());
    service = new IntegrationService(registry, (text) => text, memoryIntegrationSettings(true), testAlarm().alarm);
    const m = machine({ codex: "not_installed" });
    m.setList("error");
    registry.add(m.descriptor, m.backend as never);
    await registry.refresh("mini");
    await flush();
    registerIpc({ hosts: registry, integrations: service } as never);
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    const result = (await registered.handles.get(IPC.newAgent)!(event, "mini", { workspaceId: "w1", folder: null, kind: "codex" })) as { summary: string | null };
    expect(installs(m.log)).toEqual([]);
    expect(result.summary).toBeNull();
    expect(m.log).toContain("agent.start codex");
  });

  it("the list still being read: the agent starts, no install call", async () => {
    let service: IntegrationService | null = null;
    const registry = new HostRegistry(() => service?.hostsChanged());
    service = new IntegrationService(registry, (text) => text, memoryIntegrationSettings(true), testAlarm().alarm);
    const m = machine({ codex: "not_installed" });
    m.setList("hold");
    registry.add(m.descriptor, m.backend as never);
    await registry.refresh("mini");
    await flush();
    registerIpc({ hosts: registry, integrations: service } as never);
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    await registered.handles.get(IPC.newAgent)!(event, "mini", { workspaceId: "w1", folder: null, kind: "codex" });
    expect(installs(m.log)).toEqual([]);
    expect(m.log).toContain("agent.start codex");
    m.releaseList();
  });

  it("Herdr refuses: the agent starts, the line carries Herdr's words, Chat keeps the cause and Install", async () => {
    const w = await world({ codex: "not_installed" });
    w.m.setInstall("refuse");
    const result = await w.start("codex");
    expect(installs(w.m.log)).toEqual(["integration.install codex"]);
    expect(w.m.log).toContain("agent.start codex");
    expect(result.summary).toBe("Not installed: settings.json is not writable");
    const look = chatIntegrationLook(w.host(), "codex", null, false, result.paneId);
    expect(look?.line).toBe(integrationTexts.cause("Codex", "Mac mini", "not_installed"));
    expect(look?.button).toEqual({ label: "Install", disabled: false });
    expect(w.host().integrations?.startedAfter).toBeUndefined();
  });

  it("the install fails (no reply): the agent starts, the line is the failure in words", async () => {
    const w = await world({ codex: "outdated" });
    w.m.setInstall("fail");
    const result = await w.start("codex");
    expect(w.m.log).toContain("agent.start codex");
    expect(result.summary).toBe("Not updated: the connection closed");
    expect(chatIntegrationLook(w.host(), "codex", null, false, result.paneId)?.button?.label).toBe("Update");
  });

  it("Herdr stalls past the bound: the agent starts, the line says New agent did not wait, Chat keeps the note and its button", async () => {
    const w = await world({ codex: "not_installed" });
    w.m.setInstall("hold");
    const run = w.start("codex");
    await flush();
    expect(installs(w.m.log)).toEqual(["integration.install codex"]);
    expect(w.m.log).not.toContain("agent.start codex");
    expect(w.timer.rings.map((ring) => ring.ms)).toEqual([autoInstallWaitMs]);
    expect(autoInstallWaitMs).toBe(35_000);
    w.timer.rings[0]!.ring();
    const result = await run;
    expect(w.m.log).toContain("agent.start codex");
    expect(result.summary).toBe(autoInstallTexts.stalled("Codex", "install", 35));
    expect(result.summary).toBe("Not installed yet: Herdr had not finished installing its Codex integration after 35 seconds, so New agent did not wait for it.");
    const look = chatIntegrationLook(w.host(), "codex", null, false, result.paneId);
    expect(look?.line).toBe(integrationTexts.cause("Codex", "Mac mini", "not_installed"));
    expect(look?.button?.label).toBe("Install");
    w.m.release();
    await flush();
  });

  it("two New agents of one kind at once: one install, both start after it", async () => {
    const w = await world({ codex: "not_installed" });
    w.m.setInstall("hold");
    const first = w.start("codex");
    const second = w.start("codex");
    await flush();
    expect(installs(w.m.log)).toEqual(["integration.install codex"]);
    expect(w.m.log.filter((line) => line === "agent.start codex")).toEqual([]);
    w.m.release();
    const [a, b] = await Promise.all([first, second]);
    expect(installs(w.m.log)).toEqual(["integration.install codex"]);
    expect(w.m.log.filter((line) => line === "agent.start codex")).toHaveLength(2);
    expect(w.m.log.indexOf("install answered codex")).toBeLessThan(w.m.log.indexOf("agent.start codex"));
    expect(a.summary).toBe("Installed Herdr's Codex integration on Mac mini.");
    expect(b.summary).toBe("Installed Herdr's Codex integration on Mac mini.");
  });

  it("a reconnect between the list and the install: nothing sent on the new connection, and the start follows today's rule (refused, nothing made)", async () => {
    const w = await world({ codex: "not_installed" });
    w.m.whenStartCommandsRead(async () => {
      w.m.setEpoch(2);
    });
    await expect(w.start("codex")).rejects.toThrow("Mac mini reconnected since New agent began. Nothing was made.");
    expect(installs(w.m.log)).toEqual([]);
    expect(w.m.log).not.toContain("agent.start codex");
  });

  it("a reconnect whose new list is not read yet: no install on it, the agent starts as today", async () => {
    const w = await world({ codex: "not_installed" });
    w.m.setList("hold");
    w.m.setEpoch(2);
    await w.registry.refresh("mini");
    await flush();
    const result = await w.start("codex");
    expect(installs(w.m.log)).toEqual([]);
    expect(result.summary).toBeNull();
    expect(w.m.log).toContain("agent.start codex");
    w.m.releaseList();
    await flush();
  });

  it("herdr-core (no integration calls): never asked, the agent starts", async () => {
    const w = await world({ codex: "not_installed" }, { integrations: false });
    const result = await w.start("codex");
    expect(w.m.log.filter((line) => line.startsWith("integration."))).toEqual([]);
    expect(result.summary).toBeNull();
    expect(w.m.log).toContain("agent.start codex");
  });

  it("nowhere else: no install for a shell, for a kind with no shown integration, or for another kind than the one started", async () => {
    const w = await world({ codex: "not_installed", claude: "not_installed", devin: "not_installed" });
    await w.start("shell");
    await w.start("devin");
    await w.start("claude");
    expect(installs(w.m.log)).toEqual(["integration.install claude"]);
  });

  it("no install at connect: the read alone sends none", async () => {
    const w = await world({ codex: "not_installed", claude: "outdated" });
    await w.service.refresh();
    expect(installs(w.m.log)).toEqual([]);
  });
});

describe("Settings' switch", () => {
  it("kept in its own file beside the notification switches; missing or unreadable: on", () => {
    const folder = mkdtempSync(path.join(process.env["HERDR_TEST_SCRATCH"] ?? tmpdir(), "auto-install-"));
    const file = path.join(folder, "integration-settings.json");
    expect(fileIntegrationSettings(file).load()).toBe(true);
    fileIntegrationSettings(file).save(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ autoInstall: false });
    expect(fileIntegrationSettings(file).load()).toBe(false);
    writeFileSync(file, "not json");
    expect(fileIntegrationSettings(file).load()).toBe(true);
    expect(decodeAutoInstall({ autoInstall: "no" })).toBe(true);
    expect(decodeAutoInstall([false])).toBe(true);
  });

  it("read and set over IPC (one boolean, anything else refused); off stops the next New agent's install", async () => {
    const w = await world({ codex: "not_installed" });
    const read = registered.handles.get(IPC.integrationAutoInstall)!;
    const set = registered.handles.get(IPC.integrationAutoInstallSet)!;
    expect(read(w.event)).toBe(true);
    expect(() => set(w.event, "off")).toThrow("bad request");
    expect(() => set(w.event, false, 1)).toThrow("bad request");
    expect(set(w.event, false)).toBe(false);
    expect(read(w.event)).toBe(false);
    await w.start("codex");
    expect(installs(w.m.log)).toEqual([]);
    expect(set(w.event, true)).toBe(true);
    await w.start("codex");
    expect(installs(w.m.log)).toEqual(["integration.install codex"]);
  });

  it("the words: one switch title and one line saying what it does (no em dash)", () => {
    expect(autoInstallTexts.title).toBe("Install Herdr's integrations when I start an agent");
    expect(autoInstallTexts.help).toContain("small hook file");
    for (const text of [autoInstallTexts.title, autoInstallTexts.help, autoInstallTexts.unread("Mac mini"), autoInstallTexts.stalled("Codex", "update", 35)]) {
      expect(text.includes("—")).toBe(false);
    }
  });
});

describe("Chat when the list was not read on this connection", () => {
  it("Herdr did not answer: the machine is marked not read; Chat adds the sentence for a shown kind only; Retry asks again and the list then shows", async () => {
    let service: IntegrationService | null = null;
    const registry = new HostRegistry(() => service?.hostsChanged());
    service = new IntegrationService(registry, (text) => text, memoryIntegrationSettings(true), testAlarm().alarm);
    const m = machine({ codex: "not_installed" });
    m.setList("error");
    registry.add(m.descriptor, m.backend as never);
    await registry.refresh("mini");
    await flush();
    registerIpc({ hosts: registry, integrations: service } as never);
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    const host = (): HostView => registry.list().find((entry) => entry.id === "mini")!;
    expect(host().integrations).toBeUndefined();
    const unread = host().integrationsUnread;
    expect(unread).toEqual({ incarnation: host().incarnation, connection: host().connection, epoch: host().epoch });
    expect(chatUnreadIntegrationLine(host(), "codex")).toBe("Adari could not read Herdr's integrations on Mac mini, so it cannot tell whether this agent's integration is installed.");
    expect(chatUnreadIntegrationLine(host(), "devin")).toBeNull();
    expect(chatUnreadIntegrationLine(host(), null)).toBeNull();
    const lists = m.log.filter((line) => line === "integration.list").length;
    // A stale binding sends nothing; a bad one is refused.
    const retry = registered.handles.get(IPC.integrationsRetry)!;
    await expect(Promise.resolve().then(() => retry(event, "mini", { incarnation: 99, connection: 1, epoch: 1 }))).resolves.toBeUndefined();
    expect(m.log.filter((line) => line === "integration.list")).toHaveLength(lists);
    await expect(Promise.resolve().then(() => retry(event, "mini", "x"))).rejects.toThrow("bad request");
    m.setList("ok");
    await retry(event, "mini", unread);
    await flush();
    expect(m.log.filter((line) => line === "integration.list")).toHaveLength(lists + 1);
    expect(host().integrationsUnread).toBeUndefined();
    expect(host().integrations?.items.map((item) => item.target)).toEqual(["codex"]);
    expect(chatUnreadIntegrationLine(host(), "codex")).toBeNull();
    expect(chatIntegrationLook(host(), "codex", null)?.button?.label).toBe("Install");
  });

  it("a read list, a machine with no integration calls, or one offline: no sentence", async () => {
    const w = await world({ codex: "not_installed" });
    expect(w.host().integrationsUnread).toBeUndefined();
    expect(chatUnreadIntegrationLine(w.host(), "codex")).toBeNull();
    const core = await world({ codex: "not_installed" }, { integrations: false });
    expect(core.host().integrationsUnread).toBeUndefined();
    expect(chatUnreadIntegrationLine(core.host(), "codex")).toBeNull();
    const shown = { ...w.host(), integrations: undefined, integrationsUnread: { incarnation: 1, connection: 1, epoch: 1 } } as HostView;
    expect(chatUnreadIntegrationLine(shown, "codex")).not.toBeNull();
    expect(chatUnreadIntegrationLine({ ...shown, state: "offline" }, "codex")).toBeNull();
  });
});
