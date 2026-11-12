// First contact with a Mac nothing is pinned for. The policy answers "ask" instead of pinning, and the
// connection ends during the key exchange with a NewHostKeyError naming the
// key (its SHA256: fingerprint as OpenSSH prints it, and its type): no
// password, no key signature, no command and no pin. Over real SSH: ssh2's
// Server in this process on one end of a duplex pair, the app's ssh2 Client
// on the other (test/support/in-process-ssh.ts); nothing on the network.

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

import { HerdrTuiBackend } from "../src/main/herdr/backend";
import {
  MemoryPinStore,
  PinningHostKeyPolicy,
  PinningHostKeyValidator,
  openSSHFingerprint,
  sshHostKeyFingerprintSHA256,
} from "../src/main/herdr/host-key-pinning";
import { connectSsh, type SshHostConfig } from "../src/main/herdr/ssh";
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

describe("first contact with a Mac nothing is pinned for", () => {
  it("the validator asks: it refuses the key, names it (SHA256: and type) and stores nothing", () => {
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const validator = new PinningHostKeyValidator(host, 22, policy);
    const key = makeHostKey();
    expect(validator.verify(key.wire)).toBe(false);
    expect(validator.lastRejection?.name).toBe("NewHostKeyError");
    expect(validator.lastRejection).toMatchObject({
      host,
      port: 22,
      fingerprint: sshHostKeyFingerprintSHA256(key.wire),
      display: openSSHFingerprint(key.wire),
      keyType: "ssh-ed25519",
    });
    expect(policy.pinnedFingerprint(host, 22)).toBeUndefined();
  });

  it("over a real key exchange: the attempt ends with the new key before any sign-in reaches the Mac; nothing is pinned", async () => {
    const mac = useMac();
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const error = await failure(connectSsh(withPassword, policy, 5_000));
    expect(error.name).toBe("NewHostKeyError");
    expect(error).toMatchObject({ host, port: 22, display: openSSHFingerprint(mac.hostKey.wire), keyType: "ssh-ed25519" });
    expect(mac.seen.connections).toBe(1);
    expect(mac.seen.authentications).toEqual([]);
    expect(mac.seen.passwords).toEqual([]);
    expect(mac.seen.sessions).toBe(0);
    expect(policy.pinnedFingerprint(host, 22)).toBeUndefined();
  });

  it("the machine's first snapshot sends no password and no exec; the sidebar holds the question", async () => {
    const mac = useMac();
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor, new HerdrTuiBackend(withPassword, policy));
    await registry.refresh("mini");
    expect(mac.seen.passwords).toEqual([]);
    expect(mac.seen.execs).toEqual([]);
    expect(policy.pinnedFingerprint(host, 22)).toBeUndefined();
    const [view] = registry.list();
    expect(view?.state).toBe("offline");
    expect(view?.hostKey).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
      host,
      port: 22,
      keyType: "ssh-ed25519",
      typeLabel: "ED25519",
      fingerprint: openSSHFingerprint(mac.hostKey.wire),
      check: "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub",
    });
    registry.close();
  });

  it("while the question is open the machine is not tried again", async () => {
    const mac = useMac();
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor, new HerdrTuiBackend(withPassword, new PinningHostKeyPolicy(new MemoryPinStore())));
    await registry.refresh("mini");
    await registry.refreshAll();
    await registry.refresh("mini");
    expect(mac.seen.connections).toBe(1);
    expect(mac.seen.authentications).toEqual([]);
    registry.close();
  });
});
