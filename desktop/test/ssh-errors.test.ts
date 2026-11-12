// What a failed connection says, in words: a wrong password is "The Mac
// refused the password", an address that cannot be found or reached says so,
// a key that needs its passphrase says so, and a changed host key is
// refused (host-key-pinning.ts). A first key is asked
// about (NewHostKeyError), never pinned by the connection. ssh2's Client is faked.

import { EventEmitter } from "node:events";

import type { ConnectConfig } from "ssh2";
import { describe, expect, it } from "vitest";

import { AuthenticationFailedError, ConnectFailedError, ConnectTimedOutError, HostUnreachableError } from "../src/main/herdr/errors";
import { HostKeyRejectedError, MemoryPinStore, NewHostKeyError, PinningHostKeyPolicy, sshHostKeyFingerprintSHA256 } from "../src/main/herdr/host-key-pinning";
import { connectSsh, type SshHostConfig } from "../src/main/herdr/ssh";

const base = { host: "mac-mini.local", port: 22, username: "robin", herdrSession: "default" };
const withPassword: SshHostConfig = { ...base, auth: "password", privateKeyPath: "", secret: () => "wrong" };
const withKey: SshHostConfig = { ...base, auth: "key", privateKeyPath: "/keys/id", secret: () => null };
const readKey = (): Buffer => Buffer.from("key");

class FakeClient extends EventEmitter {
  config: ConnectConfig | null = null;
  constructor(private readonly throwOnConnect: Error | null = null) {
    super();
  }
  connect(config: ConnectConfig): this {
    this.config = config;
    if (this.throwOnConnect !== null) throw this.throwOnConnect;
    return this;
  }
  end(): this {
    return this;
  }
}

function fails(config: SshHostConfig, error: Error & { level?: string; code?: string }, policy = new PinningHostKeyPolicy(new MemoryPinStore())) {
  const client = new FakeClient();
  const pending = connectSsh(config, policy, 5_000, { makeClient: () => client as never, readKey });
  client.emit("error", error);
  return pending;
}

/** The verifier connectSsh gave ssh2 (it checks the raw key and answers synchronously). */
function verifier(client: FakeClient): (key: Buffer) => boolean {
  return client.config?.hostVerifier as unknown as (key: Buffer) => boolean;
}

function socketError(code: string): Error & { level: string; code: string } {
  return Object.assign(new Error(`connect ${code} 10.0.0.9:22`), { level: "client-socket", code });
}

describe("connection errors in words", () => {
  it("a refused password: The Mac refused the password", async () => {
    const error = Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
    const failure = fails(withPassword, error);
    await expect(failure).rejects.toBeInstanceOf(AuthenticationFailedError);
    await expect(failure).rejects.toThrow("The Mac refused the password. Check it in Edit machine.");
  });

  it("a refused key keeps its words", async () => {
    const error = Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
    await expect(fails(withKey, error)).rejects.toThrow("authentication to mac-mini.local failed. Check the key");
  });

  it("an address that cannot be found, or a machine that cannot be reached, says so", async () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
      const failure = fails(withPassword, socketError(code));
      await expect(failure).rejects.toBeInstanceOf(HostUnreachableError);
      await expect(failure).rejects.toThrow("Can't find mac-mini.local on the network. Check the address.");
    }
    for (const code of ["EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ETIMEDOUT"]) {
      await expect(fails(withPassword, socketError(code))).rejects.toThrow(
        "Can't reach mac-mini.local. It may be offline, or on a network this computer cannot see.",
      );
    }
    const refused = fails(withPassword, socketError("ECONNREFUSED"));
    await expect(refused).rejects.toThrow("mac-mini.local refused the connection on port 22. Is Remote Login (SSH) on there?");
    // Still a connect failure: a send knows nothing was written.
    await expect(refused).rejects.toBeInstanceOf(ConnectFailedError);
  });

  it("a timeout keeps its words; another socket error is named by its code only", async () => {
    await expect(fails(withPassword, Object.assign(new Error("Timed out"), { level: "client-timeout" }))).rejects.toBeInstanceOf(ConnectTimedOutError);
    await expect(fails(withPassword, socketError("EPIPE"))).rejects.toThrow("couldn't connect to mac-mini.local: the network connection failed (EPIPE)");
  });

  it("a key that needs its passphrase, or got the wrong one, says so", async () => {
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const missing = new FakeClient(new Error("Cannot parse privateKey: Encrypted private OpenSSH key detected, but no passphrase given"));
    await expect(connectSsh(withKey, policy, 5_000, { makeClient: () => missing as never, readKey })).rejects.toThrow(
      "couldn't connect to mac-mini.local: the key file needs its passphrase. Enter it in Edit machine.",
    );
    const wrong = new FakeClient(new Error("Cannot parse privateKey: Failed to decrypt private key. Bad passphrase?"));
    await expect(connectSsh({ ...withKey, secret: () => "nope" }, policy, 5_000, { makeClient: () => wrong as never, readKey })).rejects.toThrow(
      "couldn't connect to mac-mini.local: the key file's passphrase is wrong. Check it in Edit machine.",
    );
  });

  it("a first key is asked about: refused in the key exchange as a new key, nothing pinned", async () => {
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const client = new FakeClient();
    const pending = connectSsh(withPassword, policy, 5_000, { makeClient: () => client as never, readKey });
    expect(verifier(client)(Buffer.from("host key A"))).toBe(false);
    client.emit("error", Object.assign(new Error("Host denied (verification failed)"), { level: "client-ssh" }));
    await expect(pending).rejects.toBeInstanceOf(NewHostKeyError);
    await expect(pending).rejects.toThrow(/has not trusted .*nothing was sent/);
    expect(policy.pinnedFingerprint("mac-mini.local", 22)).toBeUndefined();
  });

  it("a changed host key is refused, with a password too", async () => {
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const first = new FakeClient();
    void connectSsh(withPassword, policy, 5_000, { makeClient: () => first as never, readKey });
    expect(policy.trustNewKey("mac-mini.local", 22, sshHostKeyFingerprintSHA256(Buffer.from("host key A")))).toBe("trust");
    expect(verifier(first)(Buffer.from("host key A"))).toBe(true);
    first.emit("ready");
    const second = new FakeClient();
    const pending = connectSsh(withPassword, policy, 5_000, { makeClient: () => second as never, readKey });
    expect(verifier(second)(Buffer.from("host key B"))).toBe(false);
    second.emit("error", Object.assign(new Error("Handshake failed: signature verification failed"), { level: "client-ssh" }));
    await expect(pending).rejects.toBeInstanceOf(HostKeyRejectedError);
    await expect(pending).rejects.toThrow(/changed .*refusing to connect/);
  });
});
