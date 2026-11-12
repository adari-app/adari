// A host-secrets.json
// that exists but cannot be read, decrypted as JSON or parsed is a failure,
// not an empty store. Every change refuses ("Could not read the saved
// passwords; nothing was changed."), both files stay byte for byte, every
// other machine keeps its secret, now and after a restart. has() carries the
// failure, so an Edit keeping a passphrase never turns into a clear. A missing
// file is still an empty store.

import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ file: "", failReadAt: -1, reads: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (harness.file !== "" && args[0] === harness.file) {
      if (harness.reads++ === harness.failReadAt) throw Object.assign(new Error("synthetic read EIO"), { code: "EIO" });
    }
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const { HostStore, SavedHosts } = await import("../src/main/host-store");
const { SecretStore, SecretStoreReadError } = await import("../src/main/secret-store");
const { sshAuthOptions } = await import("../src/main/herdr/ssh");
const { fakeCipher } = await import("./support/fake-cipher");

import type { AddHostRequest, EditHostRequest } from "../src/shared/ipc-contract";

afterEach(() => {
  harness.file = "";
  harness.failReadAt = -1;
  harness.reads = 0;
});

const refusal = "Could not read the saved passwords (EIO); nothing was changed.";
const request: AddHostRequest = {
  name: "A",
  host: "a.invalid",
  port: 22,
  username: "robin",
  auth: "password",
  keyPath: "",
  herdrSession: "default",
  secret: "SYNTHETIC-password-A",
};
const other: AddHostRequest = { ...request, name: "Sentinel", host: "other.invalid", secret: "SYNTHETIC-sentinel" };
const keyed: AddHostRequest = { ...request, auth: "key", keyPath: "/synthetic/key", secret: "SYNTHETIC-phrase-A" };

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-readfail-"));
  const hostsFile = path.join(dir, "hosts.json");
  const secretsFile = path.join(dir, "host-secrets.json");
  const make = () => new SavedHosts(new HostStore(hostsFile), new SecretStore(secretsFile, fakeCipher()), () => true);
  const files = () => Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name)).toString("base64")]));
  return { dir, hostsFile, secretsFile, make, files, book: make() };
}

type Book = InstanceType<typeof SavedHosts>;
const pairs = (book: Book) => book.list().map((host) => ({ host: host.host, auth: host.auth, secret: book.connectConfig(host).secret?.() ?? null }));

function failNextRead(file: string, at = 0): void {
  harness.file = file;
  harness.reads = 0;
  harness.failReadAt = at;
}

describe("a failed read of host-secrets.json refuses the change", () => {
  it("(a) Add: refused, both files unchanged, the other machine keeps its secret, also after a restart", () => {
    const s = setup();
    const sentinel = s.book.add(other);
    s.book.add(request);
    const before = s.files();
    failNextRead(s.secretsFile);
    expect(() => s.book.add({ ...request, host: "new.invalid", secret: "SYNTHETIC-new" })).toThrow(refusal);
    harness.file = "";
    expect(s.files()).toEqual(before);
    expect(s.book.list()).toHaveLength(2);
    expect(s.book.connectConfig(sentinel).secret?.()).toBe("SYNTHETIC-sentinel");
    expect(s.make().connectConfig(sentinel).secret?.()).toBe("SYNTHETIC-sentinel");
  });

  it("(b) Edit of address and password: refused, the old pair stands, the other machine keeps its secret", () => {
    const s = setup();
    const sentinel = s.book.add(other);
    const a = s.book.add(request);
    const before = s.files();
    const pairsBefore = pairs(s.book);
    // Every read this edit makes, failed in turn.
    for (let at = 0; at < 2; at += 1) {
      failNextRead(s.secretsFile, at);
      expect(() => s.book.update({ ...request, id: a.id, host: "b.invalid", secret: "SYNTHETIC-password-B" })).toThrow(refusal);
      harness.file = "";
      expect(s.files()).toEqual(before);
      expect(pairs(s.book)).toEqual(pairsBefore);
      expect(pairs(s.make())).toEqual(pairsBefore);
      expect(s.book.connectConfig(sentinel).secret?.()).toBe("SYNTHETIC-sentinel");
    }
  });

  it("(c) Edit keeping the passphrase while changing the key file: refused, the passphrase is not cleared", () => {
    const s = setup();
    const sentinel = s.book.add(other);
    const a = s.book.add(keyed);
    const before = s.files();
    failNextRead(s.secretsFile);
    expect(() => s.book.update({ ...keyed, id: a.id, keyPath: "/synthetic/other-key", secret: null })).toThrow(refusal);
    harness.file = "";
    expect(s.files()).toEqual(before);
    expect(s.book.list()[1]).toMatchObject({ privateKeyPath: "/synthetic/key" });
    expect(s.book.connectConfig(s.book.list()[1]!).secret?.()).toBe("SYNTHETIC-phrase-A");
    const restarted = s.make();
    expect(restarted.connectConfig(restarted.list()[1]!).secret?.()).toBe("SYNTHETIC-phrase-A");
    expect(restarted.connectConfig(sentinel).secret?.()).toBe("SYNTHETIC-sentinel");
  });

  it("Remove of a machine with a secret: refused, both stay", () => {
    const s = setup();
    s.book.add(other);
    const a = s.book.add(request);
    const before = s.files();
    failNextRead(s.secretsFile);
    expect(() => s.book.remove(a.id)).toThrow(refusal);
    harness.file = "";
    expect(s.files()).toEqual(before);
    expect(s.book.settings(a.id)?.secretSaved).toBe(true);
  });
});

// A sweep: every read an operation makes, failed in turn, leaves
// the machines and their secrets either as before or as after, the same after
// a restart.
describe("every read failure, every operation", () => {
  const cases: { name: string; initial: AddHostRequest | null; action: "add" | "edit" | "remove"; edit: Partial<EditHostRequest> }[] = [
    { name: "add on empty store", initial: null, action: "add", edit: {} },
    { name: "add beside committed machine", initial: null, action: "add", edit: {} },
    { name: "edit address and password", initial: request, action: "edit", edit: { host: "b.invalid", secret: "SYNTHETIC-password-B" } },
    { name: "edit address keeping password", initial: request, action: "edit", edit: { host: "b.invalid", secret: null } },
    { name: "edit password only", initial: request, action: "edit", edit: { secret: "SYNTHETIC-password-B" } },
    { name: "password to key without passphrase", initial: request, action: "edit", edit: { auth: "key", keyPath: "/synthetic/key", secret: "" } },
    { name: "password to key with passphrase", initial: request, action: "edit", edit: { auth: "key", keyPath: "/synthetic/key", secret: "SYNTHETIC-phrase-B" } },
    { name: "key with passphrase to password", initial: keyed, action: "edit", edit: { auth: "password", keyPath: "", secret: "SYNTHETIC-password-B" } },
    { name: "clear key passphrase", initial: keyed, action: "edit", edit: { secret: "" } },
    { name: "change key keeping passphrase", initial: keyed, action: "edit", edit: { keyPath: "/synthetic/other-key", secret: null } },
    { name: "remove beside committed machine", initial: request, action: "remove", edit: {} },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const prepare = () => {
        const s = setup();
        if (c.name !== "add on empty store") s.book.add(other);
        const a = c.initial === null ? null : s.book.add(c.initial);
        const run = (): unknown =>
          c.action === "add" ? s.book.add(request) : c.action === "remove" ? s.book.remove(a!.id) : s.book.update({ ...c.initial!, ...c.edit, id: a!.id });
        return { ...s, run };
      };
      const baseline = prepare();
      const before = pairs(baseline.book);
      failNextRead(baseline.secretsFile, -1);
      baseline.run();
      const reads = harness.reads;
      harness.file = "";
      const after = pairs(baseline.book);
      expect(reads).toBeGreaterThan(0);
      for (let at = 0; at < reads; at += 1) {
        const s = prepare();
        failNextRead(s.secretsFile, at);
        try {
          s.run();
        } catch (error) {
          expect(String(error)).toContain(refusal);
        }
        harness.file = "";
        const actual = pairs(s.book);
        expect([before, after]).toContainEqual(actual);
        expect(pairs(s.make())).toEqual(actual);
      }
    });
  }
});

describe("missing, damaged and unreadable files", () => {
  it("a missing file is an empty store: Add works", () => {
    const s = setup();
    expect(fs.existsSync(s.secretsFile)).toBe(false);
    const a = s.book.add(request);
    expect(s.book.connectConfig(a).secret?.()).toBe("SYNTHETIC-password-A");
  });

  it("a damaged file refuses every change and is never overwritten", () => {
    const s = setup();
    const a = s.book.add(request);
    fs.writeFileSync(s.secretsFile, "{damaged");
    const before = s.files();
    const store = new SecretStore(s.secretsFile, fakeCipher());
    expect(() => store.write("x", "y")).toThrow(SecretStoreReadError);
    expect(() => store.remove(a.secretRef!)).toThrow(SecretStoreReadError);
    expect(() => store.retain([])).toThrow(SecretStoreReadError);
    expect(() => store.has(a.secretRef!)).toThrow(SecretStoreReadError);
    expect(() => s.book.add({ ...request, host: "new.invalid" })).toThrow("Could not read the saved passwords (damaged); nothing was changed.");
    expect(() => s.book.update({ ...request, id: a.id, secret: "SYNTHETIC-B" })).toThrow(/nothing was changed/);
    // A start-up on it prunes nothing either.
    s.make();
    expect(s.files()).toEqual(before);
    for (const shape of ["[]", "null", '{"version":1,"secrets":[]}', '{"version":1,"secrets":{"a":5}}']) {
      fs.writeFileSync(s.secretsFile, shape);
      expect(() => new SecretStore(s.secretsFile, fakeCipher()).write("x", "y")).toThrow(SecretStoreReadError);
      expect(fs.readFileSync(s.secretsFile, "utf8")).toBe(shape);
    }
  });

  it("has() carries a read failure; a connection says it could not read the saved password", () => {
    const s = setup();
    const a = s.book.add(request);
    const store = new SecretStore(s.secretsFile, fakeCipher());
    failNextRead(s.secretsFile);
    expect(() => store.has(a.secretRef!)).toThrow(SecretStoreReadError);
    failNextRead(s.secretsFile);
    expect(() => sshAuthOptions(s.book.connectConfig(a))).toThrow("couldn't connect to a.invalid: could not read the saved password (EIO)");
    failNextRead(s.secretsFile);
    expect(() => s.book.settings(a.id)).toThrow(refusal);
  });

  it("a key-file machine without a passphrase needs no read: Add still works with the file unreadable", () => {
    const s = setup();
    s.book.add(request);
    failNextRead(s.secretsFile, 0);
    const k = s.book.add({ ...keyed, host: "k.invalid", secret: "" });
    harness.file = "";
    expect(k.secretRef).toBeNull();
  });
});
