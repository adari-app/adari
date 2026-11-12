// The host-key matrix, over real SSH to a Mac in this
// process (ssh2's Server on one end of a duplex pair; test/support/in-process-ssh.ts).
// First contact sends nothing whatever the sign-in (a password, or a key: no
// signature), and a terminal attach opens no shell. A pin that matches
// connects with no question; a pin file an earlier version wrote still does.
// A changed key, and a pin file that cannot be read, fail closed before any
// sign-in. Trust then the same key: the sign-in. Pins and keys live in the
// test scratch folder or in memory; never the home SSH folder.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({ mac: null as null | { socket(): Duplex } }));

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

import { utils } from "ssh2";

import { HerdrTuiBackend } from "../src/main/herdr/backend";
import {
  FilePinStore,
  MemoryPinStore,
  PinningHostKeyPolicy,
  openSSHFingerprint,
  sshHostKeyFingerprintSHA256,
} from "../src/main/herdr/host-key-pinning";
import { connectSsh, type SshHostConfig } from "../src/main/herdr/ssh";
import type { TopologyPaneInfo } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { InProcessMac, makeHostKey } from "./support/in-process-ssh";

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
const scratchRoot = process.env["HERDR_TEST_SCRATCH"] || os.tmpdir();

function scratch(): string {
  return mkdtempSync(path.join(scratchRoot, "host-key-matrix-"));
}

/** A throwaway client key in the scratch folder (OpenSSH format), for key sign-in. */
function withKeyFile(): SshHostConfig {
  const file = path.join(scratch(), "client_ed25519");
  writeFileSync(file, utils.generateKeyPairSync("ed25519").private, { mode: 0o600 });
  return { ...withPassword, auth: "key", privateKeyPath: file, secret: () => null };
}

function useMac(mac = new InProcessMac()): InProcessMac {
  wire.mac = mac;
  return mac;
}

afterEach(() => {
  wire.mac = null;
});

async function failure(pending: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  return pending.then(
    () => {
      throw new Error("the connection was made");
    },
    (error: unknown) => error as Error & Record<string, unknown>,
  );
}

/** A policy whose pin for the Mac is `wireKey`'s (as a Trust would have stored it). */
function pinnedTo(wireKey: Buffer): PinningHostKeyPolicy {
  const policy = new PinningHostKeyPolicy(new MemoryPinStore());
  expect(policy.trustNewKey(host, 22, sshHostKeyFingerprintSHA256(wireKey))).toBe("trust");
  return policy;
}

describe("first contact sends nothing, whatever the sign-in", () => {
  it("a key file: no public key offered, no signature", async () => {
    const mac = useMac();
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const error = await failure(connectSsh(withKeyFile(), policy, 5_000));
    expect(error.name).toBe("NewHostKeyError");
    expect(mac.seen.authentications).toEqual([]);
    expect(policy.pinnedFingerprint(host, 22)).toBeUndefined();
  });

  it("the control: the same key file, once the Mac is pinned, reaches the sign-in", async () => {
    const mac = useMac();
    const error = await failure(connectSsh(withKeyFile(), pinnedTo(mac.hostKey.wire), 5_000));
    // The in-process Mac takes passwords only: the key is offered, then refused.
    expect(mac.seen.authentications).toContain("publickey");
    expect(error.name).not.toBe("NewHostKeyError");
  });

  it("a terminal attach opens no shell", async () => {
    const mac = useMac();
    const backend = new HerdrTuiBackend(withPassword, new PinningHostKeyPolicy(new MemoryPinStore()));
    const pane = { paneID: "w1:p1", terminalID: "w1:t1", agent: "claude" } as TopologyPaneInfo;
    const error = await failure(backend.openTerminal(pane, { cols: 80, rows: 24 }, { data: () => undefined, exit: () => undefined }));
    expect(error.name).toBe("NewHostKeyError");
    expect(mac.seen.authentications).toEqual([]);
    expect(mac.seen.shells).toBe(0);
    expect(mac.seen.execs).toEqual([]);
    backend.close();
  });
});

describe("pins", () => {
  it("a matching pin connects with no question", async () => {
    const mac = useMac();
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor, new HerdrTuiBackend(withPassword, pinnedTo(mac.hostKey.wire)));
    await registry.refresh("mini");
    const [view] = registry.list();
    expect(view?.state).toBe("connected");
    expect(view?.hostKey).toBeUndefined();
    expect(mac.seen.passwords).toEqual(["fixture-password"]);
    registry.close();
  });

  it("a pin file an earlier version wrote (version 1) still connects with no question", async () => {
    const mac = useMac();
    const file = path.join(scratch(), "known_hosts.json");
    const before = `${JSON.stringify({ version: 1, pins: { [`${host}:22`]: sshHostKeyFingerprintSHA256(mac.hostKey.wire) } }, null, 2)}\n`;
    writeFileSync(file, before, { mode: 0o600 });
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor, new HerdrTuiBackend(withPassword, new PinningHostKeyPolicy(new FilePinStore(file))));
    await registry.refresh("mini");
    expect(registry.list()[0]?.state).toBe("connected");
    expect(registry.list()[0]?.hostKey).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(before);
    registry.close();
  });

  it("a changed key is refused before any sign-in, and the pin stays", async () => {
    const mac = useMac();
    const old = makeHostKey();
    const policy = pinnedTo(old.wire);
    const error = await failure(connectSsh(withPassword, policy, 5_000));
    expect(error.name).toBe("HostKeyRejectedError");
    expect(error.message).toContain(openSSHFingerprint(mac.hostKey.wire));
    expect(mac.seen.authentications).toEqual([]);
    expect(policy.pinnedFingerprint(host, 22)).toBe(sshHostKeyFingerprintSHA256(old.wire));
  });

  it("a pin file that cannot be read fails closed: no question, no sign-in, nothing written", async () => {
    const mac = useMac();
    const file = path.join(scratch(), "known_hosts.json");
    writeFileSync(file, "{ not json", { mode: 0o600 });
    const policy = new PinningHostKeyPolicy(new FilePinStore(file));
    const error = await failure(connectSsh(withPassword, policy, 5_000));
    expect(error.name).not.toBe("NewHostKeyError");
    expect(mac.seen.authentications).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    expect(policy.trustNewKey(host, 22, sshHostKeyFingerprintSHA256(mac.hostKey.wire))).toBe("reject");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("a pin file Trust writes: exactly the key shown, and the same key then signs in", async () => {
    const mac = useMac();
    const file = path.join(scratch(), "known_hosts.json");
    const policy = new PinningHostKeyPolicy(new FilePinStore(file));
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor, new HerdrTuiBackend(withPassword, policy));
    await registry.refresh("mini");
    const asked = registry.list()[0]?.hostKey;
    expect(asked?.fingerprint).toBe(openSSHFingerprint(mac.hostKey.wire));
    await registry.trustHostKey("mini", asked!.id, asked!.fingerprint, (key) => policy.trustNewKey(key.host, key.port, key.fingerprint));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, pins: { [`${host}:22`]: sshHostKeyFingerprintSHA256(mac.hostKey.wire) } });
    expect(registry.list()[0]?.state).toBe("connected");
    expect(mac.seen.passwords).toEqual(["fixture-password"]);
    // A new policy over the same file (the next launch): no question.
    const next = new HostRegistry(() => undefined);
    next.add(descriptor, new HerdrTuiBackend(withPassword, new PinningHostKeyPolicy(new FilePinStore(file))));
    await next.refresh("mini");
    expect(next.list()[0]?.state).toBe("connected");
    expect(next.list()[0]?.hostKey).toBeUndefined();
    registry.close();
    next.close();
  });
});
