// Host-key pinning, after HerdrKit's HostKeyPinningTests: the same two fixture
// keys, the same rules (first contact asks and pins nothing;
// Trust pins exactly the key shown; the same key is trusted again; a changed
// key is refused; pins are per host AND port), plus the file store this app
// adds so a pin survives a restart.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FilePinStore,
  HostKeyRejectedError,
  MemoryPinStore,
  NewHostKeyError,
  hostKeyCheckCommand,
  keyTypeLabel,
  openSSHFingerprintOfPin,
  sshKeyType,
  PinningHostKeyPolicy,
  PinningHostKeyValidator,
  openSSHFingerprint,
  sshHostKeyFingerprintSHA256,
  wireKeyFromOpenSSHLine,
} from "../src/main/herdr/host-key-pinning";

const keyAText = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFC/pYhTFrUoMpRRfd1LTRs7gZ7TZuv4MPD7PcWa01KM fixture-a";
const keyBText = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKtaOymmREbaU+scg5KF53w9vK9ijZSY27ib0eXyGNeK fixture-b";
const keyA = wireKeyFromOpenSSHLine(keyAText);
const keyB = wireKeyFromOpenSSHLine(keyBText);

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "herdr-pins-"));
}

describe("fingerprints", () => {
  it("are stable, 64 hex characters, over the key's wire encoding", () => {
    const first = sshHostKeyFingerprintSHA256(keyA);
    expect(sshHostKeyFingerprintSHA256(keyA)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // The wire encoding starts with the type tag, as NIOSSHPublicKey.write does.
    expect(keyA.readUInt32BE(0)).toBe(11);
    expect(keyA.subarray(4, 15).toString("latin1")).toBe("ssh-ed25519");
    expect(keyA.length).toBe(4 + 11 + 4 + 32);
  });

  it("differ for different keys", () => {
    expect(sshHostKeyFingerprintSHA256(keyA)).not.toBe(sshHostKeyFingerprintSHA256(keyB));
  });

  it("show the OpenSSH form to people", () => {
    expect(openSSHFingerprint(keyA)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it("refuse a key line whose type tag does not match", () => {
    expect(() => wireKeyFromOpenSSHLine(keyAText.replace("ssh-ed25519", "ssh-rsa"))).toThrow();
  });
});

const pinA = sshHostKeyFingerprintSHA256(keyA);
const pinB = sshHostKeyFingerprintSHA256(keyB);

describe("the new key's names", () => {
  it("reads the type off the wire key and names the file to check on the Mac", () => {
    expect(sshKeyType(keyA)).toBe("ssh-ed25519");
    expect(sshKeyType(Buffer.from("no"))).toBeNull();
    expect(keyTypeLabel("ssh-ed25519")).toBe("ED25519");
    expect(keyTypeLabel("ecdsa-sha2-nistp256")).toBe("ECDSA");
    expect(keyTypeLabel("rsa-sha2-512")).toBe("RSA");
    expect(hostKeyCheckCommand("ssh-ed25519")).toBe("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub");
    expect(hostKeyCheckCommand("ecdsa-sha2-nistp384")).toBe("ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub");
    expect(hostKeyCheckCommand("ssh-rsa")).toBe("ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub");
  });

  it("the pin and the fingerprint shown are the same digest", () => {
    expect(openSSHFingerprintOfPin(pinA)).toBe(openSSHFingerprint(keyA));
    expect(openSSHFingerprintOfPin("zz")).toBeNull();
  });
});

describe("the validator (PinningHostKeyValidator)", () => {
  it("asks on first contact: refused as a new key, named, nothing pinned", () => {
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const validator = new PinningHostKeyValidator("h", 22, policy);
    expect(policy.pinnedFingerprint("h", 22)).toBeUndefined();
    expect(validator.verify(keyA)).toBe(false);
    expect(validator.lastRejection).toBeInstanceOf(NewHostKeyError);
    expect(validator.lastRejection).toMatchObject({ fingerprint: pinA, display: openSSHFingerprint(keyA), keyType: "ssh-ed25519" });
    expect(policy.pinnedFingerprint("h", 22)).toBeUndefined();
    expect(validator.verify(keyA)).toBe(false);
  });

  it("trusts the key Trust pinned, again on reconnect", () => {
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const validator = new PinningHostKeyValidator("h", 22, policy);
    expect(policy.trustNewKey("h", 22, pinA)).toBe("trust");
    expect(validator.verify(keyA)).toBe(true);
    expect(validator.verify(keyA)).toBe(true);
  });

  it("rejects a changed key, naming it", () => {
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const validator = new PinningHostKeyValidator("h", 22, policy);
    policy.trustNewKey("h", 22, pinA);
    expect(validator.verify(keyB)).toBe(false);
    expect(validator.lastRejection).toBeInstanceOf(HostKeyRejectedError);
    expect(validator.lastRejection?.fingerprint).toBe(pinB);
  });

  it("pins different ports independently", () => {
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const v22 = new PinningHostKeyValidator("h", 22, policy);
    const v2222 = new PinningHostKeyValidator("h", 2222, policy);
    policy.trustNewKey("h", 22, pinA);
    expect(v22.verify(keyA)).toBe(true);
    expect(v2222.verify(keyB)).toBe(false);
    expect(v2222.lastRejection).toBeInstanceOf(NewHostKeyError);
    policy.trustNewKey("h", 2222, pinB);
    expect(v2222.verify(keyB)).toBe(true);
    expect(v22.verify(keyB)).toBe(false);
    expect(v2222.verify(keyA)).toBe(false);
  });
});

describe("the policy (PinningHostKeyPolicy)", () => {
  it("scopes pins to host and port", () => {
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const c = "cc".repeat(32);
    const d = "dd".repeat(32);
    expect(policy.evaluate("h", 22, c)).toBe("ask");
    expect(policy.trustNewKey("h", 22, c)).toBe("trust");
    expect(policy.evaluate("h", 22, c)).toBe("trust");
    expect(policy.evaluate("h", 2222, d)).toBe("ask");
    expect(policy.evaluate("h", 22, d)).toBe("reject");
  });

  it("lets only one of many Trusts for a first contact win", async () => {
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const a = "aa".repeat(32);
    const b = "bb".repeat(32);
    const decisions = await Promise.all(
      Array.from({ length: 64 }, (_, i) => Promise.resolve().then(() => [i % 2 === 0 ? a : b, policy.trustNewKey("h", 22, i % 2 === 0 ? a : b)] as const)),
    );
    const trusted = new Set(decisions.filter(([, decision]) => decision === "trust").map(([fp]) => fp));
    expect(trusted.size).toBe(1);
  });
});

describe("the file store", () => {
  it("keeps a pin across instances (an app restart)", () => {
    const file = path.join(scratch(), "known-hosts.json");
    const a = sshHostKeyFingerprintSHA256(keyA);
    const b = sshHostKeyFingerprintSHA256(keyB);
    const first = new PinningHostKeyPolicy(new FilePinStore(file));
    expect(first.evaluate("mac.local", 22, a)).toBe("ask");
    expect(first.trustNewKey("mac.local", 22, a)).toBe("trust");
    const reopened = new PinningHostKeyPolicy(new FilePinStore(file));
    expect(reopened.pinnedFingerprint("mac.local", 22)).toBe(a);
    expect(reopened.evaluate("mac.local", 22, b)).toBe("reject");
    expect(reopened.evaluate("mac.local", 22, a)).toBe("trust");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, pins: { "mac.local:22": a } });
  });

  it("refuses everything when the pin file is unreadable, rather than trusting as first contact", () => {
    const file = path.join(scratch(), "known-hosts.json");
    writeFileSync(file, "{ not json");
    const store = new FilePinStore(file);
    expect(new PinningHostKeyPolicy(store).evaluate("h", 22, "aa".repeat(32))).toBe("reject");
    expect(() => new PinningHostKeyPolicy(store).trustNewKey("h", 22, "aa".repeat(32))).not.toThrow();
    expect(new PinningHostKeyPolicy(store).trustNewKey("h", 22, "aa".repeat(32))).toBe("reject");
    expect(store.error).not.toBeNull();
  });

  it("forgets one endpoint when its host is removed", () => {
    const file = path.join(scratch(), "known-hosts.json");
    const store = new FilePinStore(file);
    const policy = new PinningHostKeyPolicy(store);
    policy.trustNewKey("h", 22, "aa".repeat(32));
    store.forget("h:22");
    expect(new PinningHostKeyPolicy(new FilePinStore(file)).evaluate("h", 22, "bb".repeat(32))).toBe("ask");
  });
});
