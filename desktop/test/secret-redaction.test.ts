// An SSH error's own text never carries a secret to
// the screen. A disconnect or other sign-in failure ssh2 reports with the
// server's words gets fixed words; and at the main process's boundary every
// error text (HostView.error, an IPC rejection, sync or async) has the saved
// passwords and passphrases taken out.

import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConnectConfig } from "ssh2";
import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const { registerIpc } = await import("../src/main/ipc");
const { HostStore, SavedHosts } = await import("../src/main/host-store");
const { SecretStore } = await import("../src/main/secret-store");
const { HostRegistry } = await import("../src/main/hosts");
const { connectSsh } = await import("../src/main/herdr/ssh");
const { MemoryPinStore, PinningHostKeyPolicy } = await import("../src/main/herdr/host-key-pinning");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");
const { fakeCipher } = await import("./support/fake-cipher");

const password = "SYNTHETIC-password-A";
const passphrase = "SYNTHETIC-key-phrase";

class FakeClient extends EventEmitter {
  config: ConnectConfig | null = null;
  constructor(private readonly onConnect: (() => void) | null = null) {
    super();
  }
  connect(config: ConnectConfig): this {
    this.config = config;
    this.onConnect?.();
    return this;
  }
  end(): this {
    return this;
  }
}

function book() {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-redact-"));
  const saved = new SavedHosts(new HostStore(path.join(dir, "hosts.json")), new SecretStore(path.join(dir, "s.json"), fakeCipher()), () => true);
  const a = saved.add({ name: "A", host: "a.invalid", port: 22, username: "robin", auth: "password", keyPath: "", herdrSession: "default", secret: password });
  const k = saved.add({ name: "K", host: "k.invalid", port: 22, username: "robin", auth: "key", keyPath: "/keys/id", herdrSession: "default", secret: passphrase });
  return { saved, a, k };
}

const descriptor = { id: "a", name: "A", kind: "ssh" as const, address: "a.invalid", platform: null };

describe("fixed words for an unknown sign-in failure", () => {
  it("a server's disconnect text holding the password never reaches HostView.error", async () => {
    const { saved, a } = book();
    const client = new FakeClient();
    const pending = connectSsh(saved.connectConfig(a), new PinningHostKeyPolicy(new MemoryPinStore()), 1_000, { makeClient: () => client as never });
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor, { snapshot: () => pending, close: () => undefined } as never);
    client.emit("error", Object.assign(new Error(`server disconnect: refused ${password}`), { level: "client-ssh" }));
    await registry.refresh("a");
    expect(registry.list()[0]?.error).toBe("The connection to a.invalid was closed during sign-in.");
    registry.close();
  });

  it("a key error ssh2 throws while connecting has the passphrase taken out", async () => {
    const { saved, k } = book();
    const client = new FakeClient(() => {
      throw new Error(`synthetic parse failed ${passphrase}`);
    });
    const failure = connectSsh(saved.connectConfig(k), new PinningHostKeyPolicy(new MemoryPinStore()), 1_000, {
      makeClient: () => client as never,
      readKey: () => Buffer.from("key"),
    });
    await expect(failure).rejects.toThrow("couldn't connect to k.invalid: synthetic parse failed •••");
  });
});

describe("the main process's boundary", () => {
  it("SavedHosts.redact takes every saved secret out of a text", () => {
    const { saved } = book();
    expect(saved.redact(`a ${password} b ${passphrase} ${password}`)).toBe("a ••• b ••• •••");
    expect(saved.redact("nothing secret")).toBe("nothing secret");
  });

  it("the registry stores a backend's error text with the secrets taken out", async () => {
    const { saved } = book();
    const registry = new HostRegistry(() => undefined, Date.now, (text) => saved.redact(text));
    registry.add(descriptor, { snapshot: () => Promise.reject(new Error(`odd failure ${password}`)), close: () => undefined } as never);
    await registry.refresh("a");
    expect(registry.list()[0]?.error).toBe("odd failure •••");
    registry.close();
  });

  it("an IPC rejection, sync or async, never carries a secret", async () => {
    const { saved } = book();
    registered.handles.clear();
    registerIpc({
      info: {} as never,
      hosts: { list: () => [], refreshAll: async () => [] } as never,
      terminals: { open: async () => Promise.reject(new Error(`attach failed ${passphrase}`)) } as never,
      chat: {} as never,
      // Changes' reads go through the same redaction.
      changes: { agent: async () => Promise.reject(new Error(`git failed ${password}`)) } as never,
      // The split view's shown layouts.
      layouts: {} as never,
      ghostty: {} as never,
      copyText: () => undefined,
      // The upload channel goes through the same redaction.
      uploadAttachment: async () => Promise.reject(new Error(`upload failed ${passphrase}`)),
      clipboardFiles: async () => ({ files: [], refused: [], excess: [], failures: [] }),
      addHost: () => {
        throw new Error(`add failed ${password}`);
      },
      updateHost: () => [],
      removeHost: () => [],
      hostSettings: () => null,
      retryHost: async () => [],
      trustHostKey: async () => [],
      cancelHostKey: async () => [],
      pickKeyFile: async () => null,
      commandDone: () => undefined,
      redact: (text: string) => saved.redact(text),
    });
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    const add = registered.handles.get(IPC.hostsAdd)!;
    const request = { name: "", host: "x", port: 22, username: "u", auth: "password", keyPath: "", herdrSession: "", secret: "pw" };
    const sync = (async () => add(event, request))();
    await expect(sync).rejects.toThrow("add failed •••");
    await expect(sync).rejects.not.toThrow(password);
    const open = registered.handles.get(IPC.terminalOpen)!;
    const async = (async () => open(event, { hostId: "a", paneId: "p", cols: 80, rows: 24 }))();
    await expect(async).rejects.toThrow("attach failed •••");
    const upload = registered.handles.get(IPC.attachmentUpload)!;
    const uploaded = (async () => upload(event, "a", new Uint8Array([1, 2, 3]), "png"))();
    await expect(uploaded).rejects.toThrow("upload failed •••");
    await expect(uploaded).rejects.not.toThrow(passphrase);
    const changes = registered.handles.get(IPC.changesAgent)!;
    const read = (async () => changes(event, "a", "p"))();
    await expect(read).rejects.toThrow("git failed •••");
    await expect(read).rejects.not.toThrow(password);
  });
});
