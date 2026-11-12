// A machine's record and its secret commit
// together. The secret is saved under a slot the committed hosts.json names
// (secretRef); a new secret goes to a new slot first, hosts.json's rename is
// the commit, and the old slot is dropped after it. A failed or interrupted
// edit keeps the old address with the old password; slots no committed
// machine names are dropped when the app starts on a hosts.json it could read.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const failing = vi.hoisted(() => ({ rename: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync = (from: string, to: string): void => {
    if (failing.rename !== "" && to.endsWith(failing.rename)) throw new Error("synthetic rename failure");
    actual.renameSync(from, to);
  };
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

const { HostStore, SavedHosts } = await import("../src/main/host-store");
const { SecretStore } = await import("../src/main/secret-store");
const { fakeCipher } = await import("./support/fake-cipher");

import type { AddHostRequest } from "../src/shared/ipc-contract";

afterEach(() => {
  failing.rename = "";
});

const machineA: AddHostRequest = {
  name: "A",
  host: "a.invalid",
  port: 22,
  username: "robin",
  auth: "password",
  keyPath: "",
  herdrSession: "default",
  secret: "SYNTHETIC-password-A",
};

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-commit-"));
  const hostsFile = path.join(dir, "hosts.json");
  const secretsFile = path.join(dir, "host-secrets.json");
  const secrets = () => new SecretStore(secretsFile, fakeCipher());
  const make = () => new SavedHosts(new HostStore(hostsFile), secrets(), () => true);
  const slots = (): string[] => (existsSync(secretsFile) ? Object.keys((JSON.parse(readFileSync(secretsFile, "utf8")) as { secrets: object }).secrets) : []);
  return { hostsFile, secretsFile, secrets, make, slots, book: make() };
}

describe("Edit commits the machine and its password together", () => {
  it("a failed edit keeps the old address with the old password, now and after a restart", () => {
    const s = setup();
    const a = s.book.add(machineA);
    const live = s.book.connectConfig(a);
    failing.rename = "hosts.json";
    expect(() => s.book.update({ ...machineA, id: a.id, host: "b.invalid", secret: "SYNTHETIC-password-B" })).toThrow("synthetic rename failure");
    failing.rename = "";
    expect(s.book.list()[0]?.host).toBe("a.invalid");
    expect(live.secret?.()).toBe("SYNTHETIC-password-A");
    const restarted = s.make();
    expect(restarted.list()[0]?.host).toBe("a.invalid");
    expect(restarted.connectConfig(restarted.list()[0]!).secret?.()).toBe("SYNTHETIC-password-A");
    expect(readFileSync(s.secretsFile, "utf8")).toBeTruthy();
    expect(s.slots()).toHaveLength(1);
  });

  it("a successful edit moves to a new slot and drops the old one", () => {
    const s = setup();
    const a = s.book.add(machineA);
    const before = s.slots();
    const b = s.book.update({ ...machineA, id: a.id, host: "b.invalid", secret: "SYNTHETIC-password-B" });
    expect(s.slots()).toHaveLength(1);
    expect(s.slots()).not.toEqual(before);
    expect(s.book.connectConfig(b).secret?.()).toBe("SYNTHETIC-password-B");
    expect(readFileSync(s.hostsFile, "utf8")).toContain(s.slots()[0]!);
    expect(s.make().connectConfig(b).secret?.()).toBe("SYNTHETIC-password-B");
  });

  it("an edit interrupted before hosts.json was written: the new slot is dropped at start, the old pair stands", () => {
    const s = setup();
    const a = s.book.add(machineA);
    s.secrets().write(`${a.id}.interrupted`, "SYNTHETIC-password-B");
    const restarted = s.make();
    expect(s.slots()).toHaveLength(1);
    expect(restarted.list()[0]?.host).toBe("a.invalid");
    expect(restarted.connectConfig(restarted.list()[0]!).secret?.()).toBe("SYNTHETIC-password-A");
  });

  it("an edit interrupted after hosts.json was written: the old slot is dropped at start, the new pair stands", () => {
    const s = setup();
    const a = s.book.add(machineA);
    const oldSlot = s.slots()[0]!;
    const hosts = JSON.parse(readFileSync(s.hostsFile, "utf8")) as { hosts: Record<string, unknown>[] };
    s.secrets().write(`${a.id}.committed`, "SYNTHETIC-password-B");
    hosts.hosts[0] = { ...hosts.hosts[0], host: "b.invalid", secretRef: `${a.id}.committed` };
    writeFileSync(s.hostsFile, JSON.stringify(hosts));
    const restarted = s.make();
    expect(s.slots()).toEqual([`${a.id}.committed`]);
    expect(s.slots()).not.toContain(oldSlot);
    expect(restarted.connectConfig(restarted.list()[0]!)).toMatchObject({ host: "b.invalid" });
    expect(restarted.connectConfig(restarted.list()[0]!).secret?.()).toBe("SYNTHETIC-password-B");
  });

  it("a failed add leaves no slot behind", () => {
    const s = setup();
    failing.rename = "hosts.json";
    expect(() => s.book.add(machineA)).toThrow("synthetic rename failure");
    failing.rename = "";
    expect(s.book.list()).toEqual([]);
    expect(s.slots()).toEqual([]);
  });
});

describe("Remove leaves both or neither", () => {
  it("hosts.json not written: the machine and its password both stay", () => {
    const s = setup();
    const a = s.book.add(machineA);
    failing.rename = "hosts.json";
    expect(() => s.book.remove(a.id)).toThrow("synthetic rename failure");
    failing.rename = "";
    expect(s.book.settings(a.id)?.secretSaved).toBe(true);
    expect(s.book.connectConfig(a).secret?.()).toBe("SYNTHETIC-password-A");
    expect(s.make().settings(a.id)?.secretSaved).toBe(true);
  });

  it("the secret's cleanup failing still removes the machine; its slot goes at the next start", () => {
    const s = setup();
    const a = s.book.add(machineA);
    const b = s.book.add({ ...machineA, name: "B", host: "b.invalid", secret: "SYNTHETIC-other" });
    failing.rename = "host-secrets.json";
    expect(s.book.remove(a.id)).toBe(true);
    failing.rename = "";
    expect(s.book.settings(a.id)).toBeNull();
    expect(s.slots()).toHaveLength(2);
    const restarted = s.make();
    expect(s.slots()).toHaveLength(1);
    expect(restarted.connectConfig(b).secret?.()).toBe("SYNTHETIC-other");
  });
});

describe("start-up recovery is careful", () => {
  it("keeps every slot when hosts.json is damaged or missing", () => {
    const s = setup();
    s.book.add(machineA);
    writeFileSync(s.hostsFile, "{damaged");
    s.make();
    expect(s.slots()).toHaveLength(1);
    writeFileSync(s.hostsFile, "");
    s.make();
    expect(s.slots()).toHaveLength(1);
  });

  it("a machine saved by the first password build (no secretRef; the slot is its id) keeps its password", () => {
    const s = setup();
    s.secrets().write("legacy-id", "SYNTHETIC-legacy");
    writeFileSync(
      s.hostsFile,
      JSON.stringify({
        version: 1,
        hosts: [{ id: "legacy-id", name: "L", host: "l.invalid", port: 22, username: "me", auth: "password", privateKeyPath: "", herdrSession: "default" }],
      }),
    );
    const book = s.make();
    expect(s.slots()).toEqual(["legacy-id"]);
    expect(book.settings("legacy-id")?.secretSaved).toBe(true);
    expect(book.connectConfig(book.list()[0]!).secret?.()).toBe("SYNTHETIC-legacy");
  });
});
