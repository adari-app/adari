// Offline checks of saved machines and their secrets where no other test
// covers the behaviour: a failed secret write, the hosts.json allowlist, an undecryptable
// password, the host channels' sender and shape checks, key/password
// separation, a changed host key over a raw error, and an edit closing the
// old backend's terminals and Chat reader. (host-commit, auth-pause,
// secret-redaction, secret-store and host-secrets cover the rest.)

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rename: "", handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync = (from: string, to: string): void => {
    if (state.rename !== "" && to.endsWith(state.rename)) throw new Error("synthetic rename failure");
    actual.renameSync(from, to);
  };
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(channel, handler),
    on: () => undefined,
  },
}));

const { SecretStore } = await import("../src/main/secret-store");
const { HostStore, SavedHosts } = await import("../src/main/host-store");
const { registerIpc } = await import("../src/main/ipc");
const { HostRegistry } = await import("../src/main/hosts");
const { HerdrTuiBackend } = await import("../src/main/herdr/backend");
const { SshTerminalSession, connectSsh, sshAuthOptions } = await import("../src/main/herdr/ssh");
const { MemoryPinStore, PinningHostKeyPolicy } = await import("../src/main/herdr/host-key-pinning");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");
const { fakeCipher } = await import("./support/fake-cipher");

afterEach(() => {
  state.rename = "";
});

const request = {
  name: "A",
  host: "a.invalid",
  port: 22,
  username: "synthetic",
  auth: "password" as const,
  keyPath: "",
  herdrSession: "default",
  secret: "SYNTHETIC-password-A",
};

function setup(cipher = fakeCipher()) {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-probe-"));
  const hostsFile = path.join(dir, "hosts.json");
  const secretsFile = path.join(dir, "host-secrets.json");
  const secrets = new SecretStore(secretsFile, cipher);
  const make = () => new SavedHosts(new HostStore(hostsFile), secrets, () => true);
  return { dir, hostsFile, secretsFile, secrets, make, book: make() };
}
const policy = () => new PinningHostKeyPolicy(new MemoryPinStore());

class FakeClient extends EventEmitter {
  config: Record<string, unknown> | null = null;
  ended = false;
  connect(config: Record<string, unknown>): this {
    this.config = config;
    return this;
  }
  end(): this {
    this.ended = true;
    return this;
  }
}

describe("secret storage", () => {
  it("a failed rename keeps the committed file and leaves only an encrypted 0600 temp, gone after the next write", () => {
    const s = setup();
    s.secrets.write("a", request.secret);
    const before = readFileSync(s.secretsFile, "utf8");
    state.rename = "host-secrets.json";
    expect(() => s.secrets.write("a", "SYNTHETIC-uncommitted")).toThrow("synthetic rename failure");
    state.rename = "";
    expect(readFileSync(s.secretsFile, "utf8")).toBe(before);
    const temp = `${s.secretsFile}.${process.pid}.tmp`;
    expect(statSync(temp).mode & 0o777).toBe(0o600);
    expect(readFileSync(temp, "utf8")).not.toContain("SYNTHETIC");
    s.secrets.write("b", "SYNTHETIC-next");
    expect(existsSync(temp)).toBe(false);
  });

  it("hosts.json keeps only its own fields even when a caller carries secrets", () => {
    const s = setup();
    const host = s.book.add(request);
    new HostStore(s.hostsFile).save([{ ...host, secret: request.secret, password: request.secret, passphrase: request.secret } as never]);
    expect(readFileSync(s.hostsFile, "utf8")).not.toContain("SYNTHETIC");
  });

  it("an undecryptable password asks to be entered again, without a client; entering it again works", async () => {
    const s = setup();
    const host = s.book.add(request);
    const cipher = fakeCipher();
    cipher.decryptString = () => {
      throw new Error("synthetic changed login");
    };
    const book = new SavedHosts(new HostStore(s.hostsFile), new SecretStore(s.secretsFile, cipher), () => true);
    expect(book.settings(host.id)?.secretSaved).toBe(true);
    const makeClient = vi.fn();
    await expect(connectSsh(book.connectConfig(host), policy(), 1000, { makeClient })).rejects.toThrow(/Enter it again in Edit machine/);
    expect(makeClient).not.toHaveBeenCalled();
    book.update({ ...request, id: host.id, secret: "SYNTHETIC-reentered" });
    expect(readFileSync(s.secretsFile, "utf8")).not.toContain("SYNTHETIC");
  });
});

describe("the host channels", () => {
  const trusted = { senderFrame: { url: `${APP_ORIGIN}/` }, sender: {} };
  function boundary(book: InstanceType<typeof SavedHosts>) {
    state.handlers.clear();
    registerIpc({
      info: { passwordStorage: book.passwordsAvailable() } as never,
      hosts: { list: () => [], refreshAll: async () => [] } as never,
      terminals: {} as never,
      chat: {} as never,
      changes: {} as never,
      // The split view's shown layouts.
      layouts: {} as never,
      ghostty: {} as never,
      copyText: () => undefined,
      uploadAttachment: () => Promise.reject(new Error("not in this test")),
      clipboardFiles: async () => ({ files: [], refused: [], excess: [], failures: [] }),
      addHost: (r) => (book.add(r), []),
      updateHost: (r) => (book.update(r), []),
      removeHost: (id) => (book.remove(id), []),
      hostSettings: (id) => book.settings(id),
      retryHost: async () => [],
      trustHostKey: async () => [],
      cancelHostKey: async () => [],
      pickKeyFile: async () => null,
      commandDone: () => undefined,
    });
    return (channel: string, value?: unknown, event: unknown = trusted) => state.handlers.get(channel)!(event, value);
  }

  it("check the sender and the request on every host channel", () => {
    const invoke = boundary(setup().book);
    for (const channel of [IPC.hostsAdd, IPC.hostsUpdate, IPC.hostsSettings, IPC.hostsRemove, IPC.hostsRetry]) {
      expect(() => invoke(channel, request, { ...trusted, senderFrame: { url: "https://untrusted.invalid/" } })).toThrow("untrusted sender");
      expect(() => invoke(channel, undefined)).toThrow("bad request");
    }
  });

  it("an unknown id changes nothing; settings never carry a secret", () => {
    const s = setup();
    const a = s.book.add(request);
    const b = s.book.add({ ...request, host: "b.invalid", secret: "SYNTHETIC-B" });
    const invoke = boundary(s.book);
    const before = readFileSync(s.secretsFile, "utf8");
    expect(() => invoke(IPC.hostsUpdate, { ...request, id: "unknown" })).toThrow("no longer saved");
    expect(invoke(IPC.hostsSettings, "unknown")).toBeNull();
    expect(() => invoke(IPC.hostsSettings, { id: b.id, secret: true })).toThrow("bad request");
    for (const host of [a, b]) {
      const settings = invoke(IPC.hostsSettings, host.id) as Record<string, unknown>;
      expect(settings["secretSaved"]).toBe(true);
      expect(JSON.stringify(settings)).not.toContain("SYNTHETIC");
    }
    expect(readFileSync(s.secretsFile, "utf8")).toBe(before);
  });
});

describe("SSH", () => {
  it("a password never reads a key or offers an agent; a key never offers a password", () => {
    const s = setup();
    const readKey = vi.fn();
    const password = sshAuthOptions(s.book.connectConfig(s.book.add(request)), readKey);
    expect(readKey).not.toHaveBeenCalled();
    expect(password.connect.privateKey).toBeUndefined();
    expect(password.connect.agent).toBeUndefined();
    const keyHost = s.book.add({ ...request, auth: "key", keyPath: "/synthetic/key", secret: "SYNTHETIC-key-phrase" });
    const key = sshAuthOptions(s.book.connectConfig(keyHost), () => Buffer.from("synthetic-key"));
    expect(key.connect.password).toBeUndefined();
    expect(key.connect.passphrase).toBe("SYNTHETIC-key-phrase");
  });

  it("a changed host key is refused in today's words, over a raw error holding the password", async () => {
    const p = policy();
    // A first key is pinned only by a Trust (evaluate only reads).
    p.trustNewKey("a.invalid", 22, "known-pin");
    const client = new FakeClient();
    const pending = connectSsh({ ...request, privateKeyPath: "", secret: () => request.secret }, p, 1000, { makeClient: () => client as never });
    expect((client.config!["hostVerifier"] as (key: Buffer) => boolean)(Buffer.from("changed"))).toBe(false);
    client.emit("error", new Error(request.secret));
    await expect(pending).rejects.toThrow(/changed.*refusing/);
    await expect(pending).rejects.not.toThrow(request.secret);
  });

  it("an edit closes the old backend's terminals and Chat reader", async () => {
    const backend = new HerdrTuiBackend({ ...request, privateKeyPath: "", secret: () => request.secret }, policy());
    const terminalClosed = vi.fn();
    (backend as unknown as { terminals: Set<unknown> }).terminals.add({ close: terminalClosed });
    const reader = backend.transcripts()!;
    const readerClosed = vi.spyOn(reader as unknown as { close: () => void }, "close");
    vi.spyOn(backend, "snapshot").mockResolvedValue({ panes: [], agents: [], workspaces: [], tabs: [] } as never);
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "a", name: "A", kind: "ssh", address: "a.invalid", platform: null }, backend);
    await registry.refresh("a");
    const next = { snapshot: async () => ({ panes: [], agents: [], workspaces: [], tabs: [] }), close: () => undefined } as never;
    registry.replace({ id: "a", name: "B", kind: "ssh", address: "b.invalid", platform: null }, next);
    expect(terminalClosed).toHaveBeenCalledOnce();
    expect(readerClosed).toHaveBeenCalledOnce();
    await expect(reader.size("/synthetic/transcript")).rejects.toThrow("reader is closed");
    registry.close();
  });

  it("closing a terminal still connecting ends the client that arrives late", async () => {
    let complete!: (client: unknown) => void;
    const client = new FakeClient();
    const terminal = new SshTerminalSession(
      { ...request, privateKeyPath: "", secret: () => request.secret },
      policy(),
      { kind: "terminal", terminalID: "t1" },
      { cols: 80, rows: 24 },
      { data: () => undefined, exit: () => undefined },
      () => new Promise((resolve) => (complete = resolve)) as never,
    );
    const pending = terminal.start();
    terminal.close();
    complete(client);
    await pending;
    expect(client.ended).toBe(true);
  });
});
