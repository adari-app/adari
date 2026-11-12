// The ssh2 connection each sign-in method builds, with ssh2's Client faked:
// a password goes as `password` and answers a keyboard-interactive prompt
// (once); a key file goes as `privateKey` with its passphrase when one is
// saved. Never an agent; no key read in password mode.

import { EventEmitter } from "node:events";

import type { ConnectConfig } from "ssh2";
import { describe, expect, it } from "vitest";

import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { connectSsh, sshAuthOptions, type SshHostConfig } from "../src/main/herdr/ssh";

const policy = new PinningHostKeyPolicy(new MemoryPinStore());
const base = { host: "mac-mini.local", port: 22, username: "robin", herdrSession: "default" };
const withPassword: SshHostConfig = { ...base, auth: "password", privateKeyPath: "", secret: () => "hunter2" };
const withKey: SshHostConfig = { ...base, auth: "key", privateKeyPath: "/keys/id_ed25519", secret: () => null };
const keyBytes = Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n");
const readKey = (path: string): Buffer => {
  if (path !== "/keys/id_ed25519") throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  return keyBytes;
};

/** An ssh2 Client stand-in: records the connect config; the test plays the server. */
class FakeClient extends EventEmitter {
  config: ConnectConfig | null = null;
  ended = false;
  connect(config: ConnectConfig): this {
    this.config = config;
    return this;
  }
  end(): this {
    this.ended = true;
    return this;
  }
}

function connect(config: SshHostConfig) {
  const client = new FakeClient();
  const pending = connectSsh(config, policy, 5_000, { makeClient: () => client as never, readKey });
  return { client, pending };
}

describe("sshAuthOptions", () => {
  it("password: the password, keyboard-interactive allowed, no key, no agent", () => {
    const options = sshAuthOptions(withPassword, readKey);
    expect(options.connect).toEqual({ password: "hunter2", tryKeyboard: true, agent: undefined });
    expect(options.keyboardPassword).toBe("hunter2");
  });

  it("key file: the key's bytes, its passphrase when saved, no keyboard-interactive", () => {
    expect(sshAuthOptions(withKey, readKey).connect).toEqual({ privateKey: keyBytes, tryKeyboard: false, agent: undefined });
    const locked = sshAuthOptions({ ...withKey, secret: () => "phrase" }, readKey);
    expect(locked.connect).toEqual({ privateKey: keyBytes, passphrase: "phrase", tryKeyboard: false, agent: undefined });
    expect(locked.keyboardPassword).toBeNull();
  });

  it("a machine saved before passwords (no method) signs in with its key file", () => {
    const { auth: _auth, secret: _secret, ...old } = withKey;
    expect(sshAuthOptions(old, readKey).connect).toMatchObject({ privateKey: keyBytes, tryKeyboard: false });
  });

  it("says what is missing: a saved password, a readable key file", () => {
    expect(() => sshAuthOptions({ ...withPassword, secret: () => null }, readKey)).toThrow(/No password is saved for this machine/);
    expect(() => sshAuthOptions({ ...withPassword, secret: undefined }, readKey)).toThrow(/No password is saved/);
    expect(() => sshAuthOptions({ ...withKey, privateKeyPath: "/keys/gone" }, readKey)).toThrow(/cannot read the key file/);
  });
});

describe("connectSsh", () => {
  it("connects with the password and answers keyboard-interactive with it, once", async () => {
    const { client, pending } = connect(withPassword);
    expect(client.config).toMatchObject({ host: "mac-mini.local", port: 22, username: "robin", password: "hunter2", tryKeyboard: true });
    expect(client.config?.privateKey).toBeUndefined();
    const answers: string[][] = [];
    client.emit("keyboard-interactive", "", "", "", [{ prompt: "Password:", echo: false }], (a: string[]) => answers.push(a));
    client.emit("keyboard-interactive", "", "", "", [{ prompt: "Password:", echo: false }], (a: string[]) => answers.push(a));
    expect(answers).toEqual([["hunter2"], []]);
    client.emit("ready");
    await expect(pending).resolves.toBe(client);
  });

  it("answers only the hidden prompts, and an instructions-only round with nothing", () => {
    const { client } = connect(withPassword);
    const answers: string[][] = [];
    client.emit("keyboard-interactive", "", "Welcome", "", [], (a: string[]) => answers.push(a));
    client.emit(
      "keyboard-interactive",
      "",
      "",
      "",
      [
        { prompt: "Password:", echo: false },
        { prompt: "Name:", echo: true },
      ],
      (a: string[]) => answers.push(a),
    );
    expect(answers).toEqual([[], ["hunter2", ""]]);
    client.emit("ready");
  });

  it("connects with the key file and its passphrase; never answers keyboard-interactive", async () => {
    const { client, pending } = connect({ ...withKey, secret: () => "phrase" });
    expect(client.config).toMatchObject({ privateKey: keyBytes, passphrase: "phrase", tryKeyboard: false });
    expect(client.config?.password).toBeUndefined();
    expect(client.listenerCount("keyboard-interactive")).toBe(0);
    client.emit("ready");
    await expect(pending).resolves.toBe(client);
  });

  it("rejects before connecting when the password is missing", async () => {
    const { client, pending } = connect({ ...withPassword, secret: () => null });
    await expect(pending).rejects.toThrow(/No password is saved/);
    expect(client.config).toBeNull();
  });
});
