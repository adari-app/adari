// The review's boundary cases for the Mac. The
// install's binding is the one New agent began with (an edit or a reconnect while
// the start commands are read sends no install anywhere); a successful install is
// not sent again when the list after it could not be read; the switch's file is
// private even over an old temporary file. A real HostRegistry,
// IntegrationService and HerdrClient over a fake transport, the real registerIpc
// (Electron's ipcMain faked) and the real New agent with a fake Herdr. No real
// Herdr, no socket, no network.

import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HerdrClient } from "../src/main/herdr/client";
import { HostRegistry } from "../src/main/hosts";
import { fileIntegrationSettings, IntegrationService, memoryIntegrationSettings, type AutoInstallAlarm } from "../src/main/integrations";
import type { HostView } from "../src/shared/ipc-contract";
import { paneTopology } from "./support/pane-topology";

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

type Install = "ok" | "refuse" | "fail" | "hold" | "malformed";

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
        log.push(`list-epoch ${epoch}`);
        if (listMode === "error") return JSON.stringify({ id: request.id, error: { code: "unknown_method", message: "no such method" } });
        const snapshot = [...states].map(([target, state]) => info(target, state, options.available ?? true));
        if (listMode === "hold") await listHeld.wait;
        return JSON.stringify({ id: request.id, result: { type: "integration_list", integrations: snapshot } });
      }
      if (request.method === "integration.install") {
        const target = String(request.params["target"]);
        log.push(`install-epoch ${epoch}`);
        log.push(`integration.install ${target}`);
        if (install === "hold") await held.wait;
        if (install === "malformed") return JSON.stringify({ id: request.id, result: { type: "integration_install", target, details: { messages: [null] } } });
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

async function world(initial: Record<string, string>, options: { available?: boolean; integrations?: boolean; switchOn?: boolean; list?: "ok" | "error" | "hold" } = {}) {
  let service: IntegrationService | null = null;
  const registry = new HostRegistry(() => service?.hostsChanged());
  const timer = testAlarm();
  service = new IntegrationService(registry, (text) => text, memoryIntegrationSettings(options.switchOn ?? true), timer.alarm);
  const m = machine(initial, options);
  if (options.list) m.setList(options.list);
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

describe("auto-install boundaries", () => {
  it("a reconnect and its new list while the start commands are read: no install on the new connection, and New agent refuses as today", async () => {
    const w = await world({ claude: "not_installed" });
    w.m.whenStartCommandsRead(async () => {
      w.m.setEpoch(2); await w.registry.refresh("mini"); await flush();
    });
    const error = await w.start("claude").catch(e => e.message);
    expect(error).toContain("reconnected since New agent began");
    expect(w.m.log.filter(x => x.startsWith("install-epoch"))).toEqual([]);
  });

  it("the machine edited while the start commands are read: no install on the old machine nor on the replacement", async () => {
    const w = await world({ claude: "not_installed" });
    const replacement = machine({ claude: "not_installed" });
    w.m.whenStartCommandsRead(async () => {
      w.registry.replace({ ...replacement.descriptor, address: "dev@other", name: "Other Mac" }, replacement.backend as never);
      await w.registry.refresh("mini"); await flush();
    });
    const error = await w.start("claude").catch(e => e.message);
    expect(error).toContain("edited or added again");
    expect(installs(w.m.log)).toEqual([]);
    expect(installs(replacement.log)).toEqual([]);
  });

  it("a successful install followed by a list that cannot be read: the next New agent of that kind sends no second install", async () => {
    const w = await world({ claude: "not_installed" }); w.m.setList("error");
    const first = await w.start("claude");
    expect(first.summary).toBe("Installed Herdr's Claude Code integration on Mac mini.");
    expect(w.host().integrations?.outcomes["claude"]?.phase).toBe("installed");
    await w.start("claude");
    expect(installs(w.m.log)).toEqual(["integration.install claude"]);
  });

  it("an old temporary settings file with mode 0644: the switch's file is still 0600 after a save", async () => {
    const folder = mkdtempSync(path.join(process.env["HERDR_TEST_SCRATCH"] ?? tmpdir(), "aui-settings-"));
    const file = path.join(folder, "integration-settings.json");
    writeFileSync(`${file}.tmp`, "old", { mode: 0o644 });
    fileIntegrationSettings(file).save(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
