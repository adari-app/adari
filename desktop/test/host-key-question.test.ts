// The answer to a Mac's new
// host key. Trust pins exactly the key the page showed (its SHA256: form) and
// asks the Mac again; a different key on that reconnect gets the changed-key
// refusal. Cancel stores nothing and sends nothing, and the machine waits for
// Try again. Over real SSH: ssh2's Server in this process on one end of a
// duplex pair, the app's ssh2 Client on the other (test/support/in-process-ssh.ts).
// The IPC handlers are checked for what they let through: a machine's id, the
// question's id and, for Trust, a SHA256: fingerprint.

import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({ mac: null as null | { socket(): Duplex } }));
const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));

vi.mock("ssh2", async (importOriginal) => {
  // ssh2 is CommonJS: its exports are the module's default.
  const loaded = await importOriginal<typeof import("ssh2") & { default?: typeof import("ssh2") }>();
  const real = loaded.default ?? loaded;
  // The app's own Client, with its connection's socket the in-process Mac's (never a TCP connect).
  class Client extends real.Client {
    override connect(config: import("ssh2").ConnectConfig): this {
      if (wire.mac === null) throw new Error("this test has no in-process Mac");
      return super.connect({ ...config, sock: wire.mac.socket() });
    }
  }
  const mocked = { ...real, Client };
  return { ...mocked, default: mocked };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { HerdrTuiBackend } from "../src/main/herdr/backend";
import {
  MemoryPinStore,
  NewHostKeyError,
  PinStorageError,
  PinningHostKeyPolicy,
  openSSHFingerprint,
  openSSHFingerprintOfPin,
  sshHostKeyFingerprintSHA256,
} from "../src/main/herdr/host-key-pinning";
import type { SshHostConfig } from "../src/main/herdr/ssh";
import { HostRegistry } from "../src/main/hosts";
import { IPC } from "../src/shared/ipc-contract";
import { InProcessMac, makeHostKey } from "./support/in-process-ssh";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");

const host = "mac.invalid";
const withPassword: SshHostConfig = {
  host,
  port: 22,
  username: "fixture-user",
  herdrSession: "default",
  auth: "password",
  privateKeyPath: "",
  secret: () => "fixture-password",
};
const descriptor = { id: "mini", name: "Mac mini", kind: "ssh" as const, address: `fixture-user@${host}:22`, platform: null };

afterEach(() => {
  wire.mac = null;
});

/** A registry with one machine whose first snapshot ended at its new key. */
async function asked(mac = new InProcessMac(), policy = new PinningHostKeyPolicy(new MemoryPinStore())) {
  wire.mac = mac;
  const registry = new HostRegistry(() => undefined);
  registry.add(descriptor, new HerdrTuiBackend(withPassword, policy));
  await registry.refresh("mini");
  const question = registry.list()[0]?.hostKey;
  if (question === undefined) throw new Error("no question");
  const pin = (key: NewHostKeyError) => policy.trustNewKey(key.host, key.port, key.fingerprint);
  return { mac, policy, registry, question, pin };
}

describe("Trust and connect", () => {
  it("pins exactly the fingerprint shown, then signs in and reads the snapshot", async () => {
    const { mac, policy, registry, question, pin } = await asked();
    expect(mac.seen.passwords).toEqual([]);

    await registry.trustHostKey("mini", question.id, question.fingerprint, pin);

    const pinned = policy.pinnedFingerprint(host, 22);
    expect(pinned).toBe(sshHostKeyFingerprintSHA256(mac.hostKey.wire));
    expect(openSSHFingerprintOfPin(pinned!)).toBe(question.fingerprint);
    const [view] = registry.list();
    expect(view?.state).toBe("connected");
    expect(view?.hostKey).toBeUndefined();
    expect(view?.error).toBeNull();
    expect(mac.seen.passwords).toEqual(["fixture-password"]);
    expect(mac.seen.execs.length).toBeGreaterThan(0);
    registry.close();
  });

  it("a different key on the reconnect gets the changed-key refusal, before any sign-in", async () => {
    const { mac, policy, registry, question, pin } = await asked();
    const first = mac.hostKey;
    mac.presentKey(makeHostKey());

    await registry.trustHostKey("mini", question.id, question.fingerprint, pin);

    expect(policy.pinnedFingerprint(host, 22)).toBe(sshHostKeyFingerprintSHA256(first.wire));
    const [view] = registry.list();
    expect(view?.state).toBe("offline");
    expect(view?.hostKey).toBeUndefined();
    expect(view?.error).toContain("changed");
    expect(view?.error).toContain(openSSHFingerprint(mac.hostKey.wire));
    expect(mac.seen.authentications).toEqual([]);
    expect(mac.seen.passwords).toEqual([]);
    registry.close();
  });

  it("a fingerprint that is not the one asked about stores nothing and keeps the question", async () => {
    const { mac, policy, registry, question, pin } = await asked();
    await registry.trustHostKey("mini", question.id, openSSHFingerprint(makeHostKey().wire), pin);
    expect(policy.pinnedFingerprint(host, 22)).toBeUndefined();
    expect(registry.list()[0]?.hostKey).toEqual(question);
    expect(mac.seen.connections).toBe(1);
    registry.close();
  });

  it("another pin got there first, or the pins cannot be saved: nothing stored, nothing sent", async () => {
    for (const refuse of [() => "reject" as const, (): "trust" => { throw new PinStorageError("known_hosts.json", "disk full"); }]) {
      const { mac, policy, registry, question } = await asked();
      await registry.trustHostKey("mini", question.id, question.fingerprint, refuse);
      expect(policy.pinnedFingerprint(host, 22)).toBeUndefined();
      const [view] = registry.list();
      expect(view?.hostKey).toBeUndefined();
      expect(view?.hostKeyDeclined).toBe(true);
      expect(view?.error).toContain("not saved");
      expect(mac.seen.connections).toBe(1);
      expect(mac.seen.passwords).toEqual([]);
      registry.close();
    }
  });
});

describe("Cancel", () => {
  it("stores nothing, sends nothing, and the machine waits for Try again, which asks again", async () => {
    const { mac, policy, registry, question } = await asked();

    registry.cancelHostKey("mini", question.id);

    expect(policy.pinnedFingerprint(host, 22)).toBeUndefined();
    let [view] = registry.list();
    expect(view?.hostKey).toBeUndefined();
    expect(view?.hostKeyDeclined).toBe(true);
    expect(view?.error).toBe("Not connected: this Mac's host key was not trusted. Nothing was sent or saved.");
    await registry.refreshAll();
    await registry.refresh("mini");
    expect(mac.seen.connections).toBe(1);

    await registry.retry("mini");
    [view] = registry.list();
    expect(mac.seen.connections).toBe(2);
    expect(mac.seen.authentications).toEqual([]);
    expect(view?.hostKeyDeclined).not.toBe(true);
    expect(view?.hostKey?.fingerprint).toBe(openSSHFingerprint(mac.hostKey.wire));
    registry.close();
  });
});

describe("the IPC handlers", () => {
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
  const fingerprint = openSSHFingerprint(makeHostKey().wire);
  const questionId = "5f0c2a8e-3b1d-4c6f-9a2e-7d4b1c0e8f21";

  function handlers() {
    const calls: unknown[][] = [];
    registerIpc({
      trustHostKey: async (...args: unknown[]) => {
        calls.push(["trust", ...args]);
        return [];
      },
      cancelHostKey: async (...args: unknown[]) => {
        calls.push(["cancel", ...args]);
        return [];
      },
    } as never);
    const trust = registered.handles.get(IPC.hostsTrustKey);
    const cancel = registered.handles.get(IPC.hostsCancelKey);
    if (trust === undefined || cancel === undefined) throw new Error("no host-key handlers");
    return { calls, trust, cancel };
  }

  it("pass a machine's id, the question's id and a SHA256: fingerprint through", async () => {
    const { calls, trust, cancel } = handlers();
    await trust(event, "mini", questionId, fingerprint);
    await cancel(event, "mini", questionId);
    expect(calls).toEqual([
      ["trust", "mini", questionId, fingerprint],
      ["cancel", "mini", questionId],
    ]);
  });

  it("refuse anything else", async () => {
    const { calls, trust, cancel } = handlers();
    for (const [id, asked, shown] of [
      ["mini", questionId, "1d028f1be68b2ab7cae3872e4fe04541688bfb2a9e5c72e5a86d758e128439ac"],
      ["mini", questionId, "SHA256:short"],
      ["mini", questionId, 42],
      ["", questionId, fingerprint],
      [{}, questionId, fingerprint],
      // The old two-argument Trust (no question), and question ids that are not one.
      ["mini", fingerprint, undefined],
      ["mini", undefined, fingerprint],
      ["mini", "", fingerprint],
      ["mini", "not-a-question", fingerprint],
      ["mini", questionId.toUpperCase(), fingerprint],
      ["mini", 7, fingerprint],
    ] as const) {
      await expect(Promise.resolve().then(() => trust(event, id, asked, shown))).rejects.toThrow("bad request");
    }
    for (const [id, asked] of [
      [7, questionId],
      ["mini", undefined],
      ["mini", "not-a-question"],
      ["mini", fingerprint],
    ] as const) {
      await expect(Promise.resolve().then(() => cancel(event, id, asked))).rejects.toThrow("bad request");
    }
    expect(calls).toEqual([]);
  });
});
