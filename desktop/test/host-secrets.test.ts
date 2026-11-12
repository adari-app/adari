// Add a machine with a password or a key file, edit it, remove it: the saved
// machines (hosts.json) never hold a secret; the password or passphrase goes
// to the SecretStore (safeStorage, faked), leaves with its machine, and the
// page learns only that one is saved. Machines saved before passwords load
// unchanged.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AddHostRequest } from "../src/shared/ipc-contract";
import { HostStore, SavedHosts } from "../src/main/host-store";
import { isAddHostRequest, isEditHostRequest } from "../src/main/ipc";
import { SecretStore } from "../src/main/secret-store";
import { fakeCipher } from "./support/fake-cipher";

const password: AddHostRequest = {
  name: "Mac mini",
  host: "mac-mini.local",
  port: 22,
  username: "robin",
  auth: "password",
  keyPath: "",
  herdrSession: "default",
  secret: "hunter2-correct-horse",
};
const keyFile: AddHostRequest = { ...password, name: "Build box", host: "build.local", auth: "key", keyPath: "/keys/id_ed25519", secret: "" };

function setup(available = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-book-"));
  const hostsFile = path.join(dir, "hosts.json");
  const secretsFile = path.join(dir, "host-secrets.json");
  const make = () => new SavedHosts(new HostStore(hostsFile), new SecretStore(secretsFile, fakeCipher(available)), () => true);
  return { dir, hostsFile, secretsFile, make, book: make() };
}

describe("a machine with a password", () => {
  it("keeps the password out of hosts.json, encrypted in its own file", () => {
    const { book, hostsFile, secretsFile, make } = setup();
    const host = book.add(password);
    expect(host).toMatchObject({ auth: "password", privateKeyPath: "" });
    const hostsJson = readFileSync(hostsFile, "utf8");
    expect(hostsJson).not.toContain("hunter2");
    expect(hostsJson).not.toMatch(/"(secret|password|passphrase)"\s*:/);
    expect(readFileSync(secretsFile, "utf8")).not.toContain("hunter2");
    // Read back, in the main process only, when connecting; after a restart too.
    expect(make().connectConfig(host).secret?.()).toBe("hunter2-correct-horse");
  });

  it("tells the page only that a password is saved", () => {
    const { book } = setup();
    const host = book.add(password);
    const settings = book.settings(host.id);
    expect(settings).toEqual({
      id: host.id,
      name: "Mac mini",
      host: "mac-mini.local",
      port: 22,
      username: "robin",
      auth: "password",
      keyPath: "",
      herdrSession: "default",
      secretSaved: true,
    });
    expect(JSON.stringify(settings)).not.toContain("hunter2");
    expect(book.settings("nope")).toBeNull();
  });

  it("asks for the password", () => {
    const { book, hostsFile } = setup();
    expect(() => book.add({ ...password, secret: "" })).toThrow("Enter the password.");
    expect(() => book.add({ ...password, secret: null })).toThrow("Enter the password.");
    expect(existsSync(hostsFile)).toBe(false);
  });

  it("is refused, saying why, when the system cannot encrypt; a key file still works", () => {
    const { book, hostsFile, secretsFile } = setup(false);
    expect(book.passwordsAvailable()).toBe(false);
    expect(() => book.add(password)).toThrow(/can't encrypt a password.*not saved/);
    expect(existsSync(hostsFile)).toBe(false);
    expect(existsSync(secretsFile)).toBe(false);
    expect(() => book.add({ ...keyFile, secret: "pass" })).toThrow(/can't encrypt a passphrase/);
    const host = book.add(keyFile);
    expect(host.auth).toBe("key");
    expect(book.list()).toHaveLength(1);
  });

  it("removing the machine removes its password", () => {
    const { book, secretsFile, make } = setup();
    const kept = book.add({ ...password, name: "other", secret: "other-secret" });
    const host = book.add(password);
    expect(book.remove(host.id)).toBe(true);
    expect(readFileSync(secretsFile, "utf8")).not.toContain(host.id);
    expect(make().connectConfig(host).secret?.()).toBeNull();
    expect(make().connectConfig(kept).secret?.()).toBe("other-secret");
    book.remove(kept.id);
    expect(existsSync(secretsFile)).toBe(false);
    expect(book.remove("never")).toBe(false);
  });
});

describe("a machine with a key file", () => {
  it("asks for the key file; the passphrase is optional and kept like a password", () => {
    const { book, hostsFile } = setup();
    expect(() => book.add({ ...keyFile, keyPath: "" })).toThrow("Choose the private key file.");
    const plain = book.add(keyFile);
    expect(book.settings(plain.id)?.secretSaved).toBe(false);
    expect(book.connectConfig(plain).secret?.()).toBeNull();
    const locked = book.add({ ...keyFile, name: "locked", secret: "key-passphrase" });
    expect(book.settings(locked.id)).toMatchObject({ auth: "key", keyPath: "/keys/id_ed25519", secretSaved: true });
    expect(book.connectConfig(locked).secret?.()).toBe("key-passphrase");
    expect(readFileSync(hostsFile, "utf8")).not.toContain("key-passphrase");
  });

  it("loads hosts.json written before passwords unchanged, as key-file machines", () => {
    const { hostsFile, make } = setup();
    const old = {
      version: 1,
      hosts: [{ id: "a1", name: "Old", host: "old.local", port: 2222, username: "me", privateKeyPath: "/k/id", herdrSession: "default" }],
    };
    writeFileSync(hostsFile, JSON.stringify(old));
    const book = make();
    // The slot of a record without secretRef is its id; a key-file machine has nothing there.
    expect(book.list()).toEqual([{ ...old.hosts[0], auth: "key", secretRef: "a1" }]);
    expect(book.connectConfig(book.list()[0]!)).toMatchObject({ auth: "key", privateKeyPath: "/k/id" });
    expect(book.settings("a1")).toMatchObject({ auth: "key", keyPath: "/k/id", secretSaved: false });
  });
});

describe("Edit a machine", () => {
  it("keeps its id and place, and the saved password when none is typed", () => {
    const { book, make } = setup();
    const first = book.add(password);
    book.add(keyFile);
    const edited = book.update({ ...password, id: first.id, name: "Renamed", port: 2200, secret: null });
    expect(edited).toMatchObject({ id: first.id, name: "Renamed", port: 2200 });
    expect(book.list().map((host) => host.id)[0]).toBe(first.id);
    expect(make().connectConfig(edited).secret?.()).toBe("hunter2-correct-horse");
  });

  it("replaces the password when a new one is typed", () => {
    const { book } = setup();
    const host = book.add(password);
    book.update({ ...password, id: host.id, secret: "new-one" });
    // A config is bound to the record it was made from: the edited record reads the new one.
    expect(book.connectConfig(book.list()[0]!).secret?.()).toBe("new-one");
  });

  it("switching to a key file drops the password; back to a password asks for one", () => {
    const { book, secretsFile } = setup();
    const host = book.add(password);
    const asKey = book.update({ ...keyFile, id: host.id, secret: null });
    expect(asKey).toMatchObject({ auth: "key", privateKeyPath: "/keys/id_ed25519" });
    expect(book.settings(host.id)?.secretSaved).toBe(false);
    expect(existsSync(secretsFile)).toBe(false);
    expect(() => book.update({ ...password, id: host.id, secret: null })).toThrow("Enter the password.");
    book.update({ ...password, id: host.id, secret: "again" });
    expect(book.connectConfig(book.list()[0]!).secret?.()).toBe("again");
  });

  it("keeps or forgets a key's passphrase", () => {
    const { book } = setup();
    const host = book.add({ ...keyFile, secret: "phrase" });
    book.update({ ...keyFile, id: host.id, secret: null });
    expect(book.connectConfig(book.list()[0]!).secret?.()).toBe("phrase");
    book.update({ ...keyFile, id: host.id, secret: "" });
    expect(book.connectConfig(book.list()[0]!).secret?.()).toBeNull();
    expect(book.settings(host.id)?.secretSaved).toBe(false);
  });

  it("refuses a machine that is no longer saved, and keeps everything when the new secret cannot be saved", () => {
    const { book } = setup();
    expect(() => book.update({ ...password, id: "gone" })).toThrow("That machine is no longer saved.");
    const unavailable = setup(false);
    const host = unavailable.book.add(keyFile);
    expect(() => unavailable.book.update({ ...password, id: host.id, name: "changed" })).toThrow(/can't encrypt/);
    expect(unavailable.book.list()[0]).toMatchObject({ name: "Build box", auth: "key" });
  });
});

describe("the page's requests", () => {
  it("checks the shape: the method, the secret (or null to keep it), the id for an edit", () => {
    expect(isAddHostRequest(password)).toBe(true);
    expect(isAddHostRequest({ ...password, secret: null })).toBe(true);
    expect(isAddHostRequest({ ...password, auth: "agent" })).toBe(false);
    expect(isAddHostRequest({ ...password, secret: 5 })).toBe(false);
    expect(isAddHostRequest({ ...password, secret: "x".repeat(5000) })).toBe(false);
    const { auth: _auth, ...noAuth } = password;
    expect(isAddHostRequest(noAuth)).toBe(false);
    expect(isEditHostRequest({ ...password, id: "h1" })).toBe(true);
    expect(isEditHostRequest(password)).toBe(false);
  });

  // The secret's limit is 4096 bytes of UTF-8, not 4096 characters.
  it("limits the secret to 4096 bytes: ASCII and multibyte at the boundary", () => {
    expect(isAddHostRequest({ ...password, secret: "a".repeat(4096) })).toBe(true);
    expect(isAddHostRequest({ ...password, secret: "a".repeat(4097) })).toBe(false);
    const threeBytes = "密"; // 3 bytes in UTF-8
    expect(isAddHostRequest({ ...password, secret: threeBytes.repeat(1365) + "a" })).toBe(true); // 4096 bytes
    expect(isAddHostRequest({ ...password, secret: threeBytes.repeat(1366) })).toBe(false); // 4098 bytes
    expect(isAddHostRequest({ ...password, secret: threeBytes.repeat(4096) })).toBe(false); // 12288 bytes, 4096 characters
    expect(isEditHostRequest({ ...password, id: "h1", secret: threeBytes.repeat(4096) })).toBe(false);
    expect(isAddHostRequest({ ...password, secret: "🔑".repeat(1024) })).toBe(true); // 4096 bytes
    expect(isAddHostRequest({ ...password, secret: "🔑".repeat(1024) + "a" })).toBe(false);
  });
});
