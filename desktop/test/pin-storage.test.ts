// A pin that could not be saved must not be trusted.
// The store publishes a new pin only after the file is written and renamed;
// until then the endpoint has no pin, and a reopened store sees exactly what
// reached the disk. A first key is pinned only by the person's
// Trust (trustNewKey), so that is where a save fails: it throws, the endpoint
// stays unpinned, and every connection keeps asking (NewHostKeyError) until a
// Trust saves.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FilePinStore,
  NewHostKeyError,
  PinStorageError,
  PinningHostKeyPolicy,
  PinningHostKeyValidator,
  sshHostKeyFingerprintSHA256,
  wireKeyFromOpenSSHLine,
} from "../src/main/herdr/host-key-pinning";

const keyA = wireKeyFromOpenSSHLine("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFC/pYhTFrUoMpRRfd1LTRs7gZ7TZuv4MPD7PcWa01KM fixture-a");
const keyB = wireKeyFromOpenSSHLine("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKtaOymmREbaU+scg5KF53w9vK9ijZSY27ib0eXyGNeK fixture-b");

function scratch(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-pin-storage-"));
  return { dir, file: path.join(dir, "known_hosts.json") };
}

/** Puts a non-empty directory where the pin file goes, so the rename onto it fails. */
function obstruct(file: string): () => void {
  mkdirSync(file);
  writeFileSync(path.join(file, "occupant"), "x");
  return () => renameSync(file, `${file}.obstruction`);
}

const pinA = sshHostKeyFingerprintSHA256(keyA);
const pinB = sshHostKeyFingerprintSHA256(keyB);

describe("a pin that cannot be saved", () => {
  it("is not trusted when the rename fails: Trust throws, the Mac is asked again (the same key too), and trusted once it saves", () => {
    const { dir, file } = scratch();
    const store = new FilePinStore(file);
    expect(store.pinned("h:22")).toBeUndefined(); // loaded: nothing pinned yet
    const clear = obstruct(file);
    const policy = new PinningHostKeyPolicy(store);
    const validator = new PinningHostKeyValidator("h", 22, policy);

    expect(validator.verify(keyA)).toBe(false);
    expect(validator.lastRejection).toBeInstanceOf(NewHostKeyError);
    expect(() => policy.trustNewKey("h", 22, pinA)).toThrow(PinStorageError);
    expect(() => policy.trustNewKey("h", 22, pinA)).toThrow(/could not be saved/);
    expect(validator.verify(keyA)).toBe(false);
    expect(validator.lastRejection).toBeInstanceOf(NewHostKeyError);
    expect(policy.pinnedFingerprint("h", 22)).toBeUndefined();
    // No temp file is left beside the pin file.
    expect(readdirSync(dir).sort()).toEqual(["known_hosts.json"]);

    clear();
    expect(policy.trustNewKey("h", 22, pinA)).toBe("trust");
    expect(validator.verify(keyA)).toBe(true);
    const reopened = new PinningHostKeyPolicy(new FilePinStore(file));
    expect(reopened.pinnedFingerprint("h", 22)).toBe(pinA);
    expect(new PinningHostKeyValidator("h", 22, reopened).verify(keyB)).toBe(false);
  });

  it("is not trusted when the write fails (folder not writable), and nothing reaches the disk", () => {
    const { dir, file } = scratch();
    const store = new FilePinStore(file);
    expect(store.pinned("h:22")).toBeUndefined();
    const policy = new PinningHostKeyPolicy(store);
    const validator = new PinningHostKeyValidator("h", 22, policy);
    chmodSync(dir, 0o500);
    try {
      expect(() => policy.trustNewKey("h", 22, pinA)).toThrow(PinStorageError);
      expect(validator.verify(keyA)).toBe(false);
      expect(validator.lastRejection).toBeInstanceOf(NewHostKeyError);
      expect(existsSync(file)).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(new FilePinStore(file).pinned("h:22")).toBeUndefined();
    expect(policy.trustNewKey("h", 22, pinA)).toBe("trust");
    expect(validator.verify(keyA)).toBe(true);
    expect(new FilePinStore(file).pinned("h:22")).toBe(pinA);
  });

  it("leaves the pins already saved as they were", () => {
    const { file } = scratch();
    const store = new FilePinStore(file);
    const policy = new PinningHostKeyPolicy(store);
    expect(policy.trustNewKey("h", 22, pinA)).toBe("trust");
    expect(new PinningHostKeyValidator("h", 22, policy).verify(keyA)).toBe(true);
    // Swap the saved file for an obstruction; the store keeps its loaded pins.
    renameSync(file, `${file}.saved`);
    const clear = obstruct(file);
    const other = new PinningHostKeyValidator("g", 22, policy);
    expect(() => policy.trustNewKey("g", 22, pinB)).toThrow(PinStorageError);
    expect(other.verify(keyB)).toBe(false);
    expect(new PinningHostKeyValidator("h", 22, policy).verify(keyA)).toBe(true);
    expect(policy.pinnedFingerprint("g", 22)).toBeUndefined();
    clear();
    renameSync(`${file}.saved`, file);
    const reopened = new FilePinStore(file);
    expect(reopened.pinned("h:22")).toBe(pinA);
    expect(reopened.pinned("g:22")).toBeUndefined();
  });

  it("keeps a pin whose removal could not be saved", () => {
    const { file } = scratch();
    const store = new FilePinStore(file);
    const policy = new PinningHostKeyPolicy(store);
    expect(policy.trustNewKey("h", 22, pinA)).toBe("trust");
    renameSync(file, `${file}.saved`);
    obstruct(file);
    expect(() => store.forget("h:22")).toThrow(/could not be saved/);
    expect(policy.pinnedFingerprint("h", 22)).toBe(pinA);
    expect(new PinningHostKeyValidator("h", 22, policy).verify(keyB)).toBe(false);
  });
});
