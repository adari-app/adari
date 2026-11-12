// The main process's machine list: Add host checks, hosts.json, the registry
// (one machine failing keeps its last snapshot and never holds up another),
// and the command channel the capture flag drives the page with.

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AddHostRequest, HostView } from "../src/shared/ipc-contract";
import { RENDERER_READY } from "../src/shared/ipc-contract";
import { AppCommands } from "../src/main/capture";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import type { SessionTopology } from "../src/main/herdr/wire";
import { HostStore, validateAddHost } from "../src/main/host-store";
import { HostRegistry } from "../src/main/hosts";
import { topology } from "./support/sidebar-fixture";

const request: AddHostRequest = {
  name: "",
  host: " mac-mini.local ",
  port: 22,
  username: "robin",
  auth: "key",
  keyPath: "/keys/id_ed25519",
  herdrSession: "",
  secret: "",
};

describe("Add host", () => {
  it("trims, names the machine after its address and uses the default session", () => {
    const saved = validateAddHost(request, () => true);
    expect(saved).toMatchObject({
      name: "mac-mini.local",
      host: "mac-mini.local",
      port: 22,
      username: "robin",
      auth: "key",
      privateKeyPath: "/keys/id_ed25519",
      herdrSession: "default",
    });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("says what is wrong", () => {
    expect(() => validateAddHost({ ...request, host: "" }, () => true)).toThrow("Enter the machine's address.");
    expect(() => validateAddHost({ ...request, username: "a b" }, () => true)).toThrow("Enter the SSH user name.");
    expect(() => validateAddHost({ ...request, port: 0 }, () => true)).toThrow("The port is a number from 1 to 65535.");
    expect(() => validateAddHost({ ...request, port: 65_536 }, () => true)).toThrow("The port is a number from 1 to 65535.");
    expect(() => validateAddHost({ ...request, keyPath: " " }, () => true)).toThrow("Choose the private key file.");
    expect(() => validateAddHost(request, () => false)).toThrow("The key file is not there.");
    expect(() => validateAddHost({ ...request, herdrSession: "a/b" }, () => true)).toThrow(/session name/);
  });

  it("signs in with a password: no key file asked for or kept", () => {
    const saved = validateAddHost({ ...request, auth: "password", keyPath: "/ignored", secret: "pw" }, () => false);
    expect(saved).toMatchObject({ auth: "password", privateKeyPath: "" });
    expect(JSON.stringify(saved)).not.toContain("pw");
  });
});

describe("hosts.json", () => {
  it("round-trips the saved machines, readable by the user only", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "herdr-hosts-")), "hosts.json");
    const store = new HostStore(file);
    expect(store.load()).toEqual([]);
    const saved = validateAddHost(request, () => true);
    store.save([saved]);
    expect(store.load()).toEqual([saved]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

class FakeBackend implements HerdrHostBackend {
  readonly kind = "demo" as const;
  closed = false;
  constructor(public answer: () => Promise<SessionTopology>) {}
  snapshot(): Promise<SessionTopology> {
    return this.answer();
  }
  sendInput(): Promise<void> {
    return Promise.resolve();
  }
  prompt(): Promise<void> {
    return Promise.resolve();
  }
  sendText(): Promise<void> {
    return Promise.resolve();
  }
  agentKeys(): Promise<void> {
    return Promise.resolve();
  }
  transcripts(): null {
    return null;
  }
  openTerminal(): Promise<never> {
    return Promise.reject(new Error("no terminal"));
  }
  close(): void {
    this.closed = true;
  }
}

describe("HostRegistry", () => {
  const descriptor = (id: string) => ({ id, name: id, kind: "demo" as const, address: "demo", platform: "Linux" });

  it("lists machines in the order added, each answering on its own", async () => {
    const changes: HostView[][] = [];
    const registry = new HostRegistry((hosts) => changes.push(hosts), () => 42);
    let release: (topology: SessionTopology) => void = () => undefined;
    const slow = new FakeBackend(() => new Promise((resolve) => (release = resolve)));
    registry.add(descriptor("a"), slow);
    registry.add(descriptor("b"), new FakeBackend(() => Promise.resolve(topology())));
    await registry.refresh("b");
    expect(registry.list().map((host) => [host.id, host.state])).toEqual([
      ["a", "connecting"],
      ["b", "connected"],
    ]);
    release(topology());
    await registry.refresh("a");
    expect(registry.list().map((host) => host.state)).toEqual(["connected", "connected"]);
    expect(registry.list()[0]?.fetchedAtMs).toBe(42);
    expect(changes.length).toBeGreaterThanOrEqual(4);
    registry.close();
    expect(slow.closed).toBe(true);
  });

  it("keeps the last snapshot when a machine stops answering", async () => {
    const registry = new HostRegistry(() => undefined);
    const backend = new FakeBackend(() => Promise.resolve(topology()));
    registry.add(descriptor("a"), backend);
    await registry.refresh("a");
    backend.answer = () => Promise.reject(new Error("Could not connect"));
    await registry.refresh("a");
    const [host] = registry.list();
    expect(host?.state).toBe("offline");
    expect(host?.error).toBe("Could not connect");
    expect(host?.topology?.panes.length).toBeGreaterThan(0);
    expect(registry.pane("a", host?.topology?.panes[0]?.paneID ?? "")).not.toBeNull();
  });

  it("an edited machine keeps its place, reconnects on its new backend and closes the old one", async () => {
    const registry = new HostRegistry(() => undefined);
    const old = new FakeBackend(() => Promise.resolve(topology()));
    registry.add(descriptor("a"), old);
    registry.add(descriptor("b"), new FakeBackend(() => Promise.resolve(topology())));
    await registry.refresh("a");
    const next = new FakeBackend(() => Promise.reject(new Error("The Mac refused the password.")));
    registry.replace({ ...descriptor("a"), name: "renamed" }, next);
    expect(old.closed).toBe(true);
    expect(registry.list().map((host) => [host.id, host.name])).toEqual([
      ["a", "renamed"],
      ["b", "b"],
    ]);
    expect(registry.list()[0]?.topology).toBeNull();
    await registry.refresh("a");
    expect(registry.list()[0]).toMatchObject({ state: "offline", error: "The Mac refused the password." });
    expect(registry.backend("a")).toBe(next);
  });

  it("refuses a second machine with the same id", () => {
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor("a"), new FakeBackend(() => Promise.resolve(topology())));
    expect(() => registry.add(descriptor("a"), new FakeBackend(() => Promise.resolve(topology())))).toThrow();
  });
});

describe("AppCommands", () => {
  it("resolves on the page's answer, even one that came first", async () => {
    const commands = new AppCommands();
    commands.answered(RENDERER_READY);
    await commands.ready(100);
    const sent: unknown[] = [];
    const contents = { send: (_channel: string, command: unknown) => sent.push(command) };
    const shown = commands.send(contents as never, { type: "clear-selection" });
    commands.answered("command-1");
    await shown;
    expect(sent).toEqual([{ type: "clear-selection", id: "command-1" }]);
  });

  it("gives up when the page does not answer", async () => {
    await expect(new AppCommands().wait("never", 10)).rejects.toThrow("did not answer never within 10 ms");
  });
});
