// host-secrets.json is decoded as strict UTF-8.
// Node's "utf8" read swaps an invalid byte for U+FFFD, so a file with one
// damaged byte would parse as a partial, misnamed slot map: a keep-passphrase
// Edit would become a clear and start-up recovery would drop the slot. So an
// undecodable file is damaged: every consumer refuses (start-up skips its recovery), both
// files stay byte for byte, and the ciphertext is still there after a
// restart.

import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AddHostRequest } from "../src/shared/ipc-contract";
import { HostStore, SavedHosts } from "../src/main/host-store";
import { SecretStore, SecretStoreReadError } from "../src/main/secret-store";
import { fakeCipher } from "./support/fake-cipher";

const sentinelRequest: AddHostRequest = {
  name: "Sentinel",
  host: "other.invalid",
  port: 22,
  username: "robin",
  auth: "password",
  keyPath: "",
  herdrSession: "default",
  secret: "SYNTHETIC-sentinel",
};
const phrase: AddHostRequest = { ...sentinelRequest, name: "Key", host: "a.invalid", auth: "key", keyPath: "/synthetic/key", secret: "SYNTHETIC-phrase-A" };

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-utf8-"));
  const hostsFile = path.join(dir, "hosts.json");
  const secretsFile = path.join(dir, "host-secrets.json");
  const secrets = new SecretStore(secretsFile, fakeCipher());
  const make = () => new SavedHosts(new HostStore(hostsFile), new SecretStore(secretsFile, fakeCipher()), () => true);
  const book = make();
  const sentinel = book.add(sentinelRequest);
  const a = book.add(phrase);
  const canonical = () => Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name)).toString("base64")]));
  return { dir, hostsFile, secretsFile, secrets, make, book, sentinel, a, canonical };
}

type Action = "read" | "has" | "write" | "remove" | "retain" | "keep-edit" | "startup";

describe("an invalid byte in a committed slot name", () => {
  for (const action of ["read", "has", "write", "remove", "retain", "keep-edit", "startup"] as Action[]) {
    it(action, () => {
      const s = setup();
      const original = fs.readFileSync(s.secretsFile);
      const bad = Buffer.from(original);
      const offset = bad.indexOf(s.a.secretRef!);
      expect(offset).toBeGreaterThan(0);
      bad[offset] = 0xff;
      fs.writeFileSync(s.secretsFile, bad);
      // The damage is on disk; a lossy read would hide it.
      expect(bad.toString("utf8")).toContain("�");
      const before = s.canonical();
      const sealed = (JSON.parse(original.toString("utf8")) as { secrets: Record<string, string> }).secrets[s.a.secretRef!]!;
      const run: Record<Action, () => unknown> = {
        read: () => s.secrets.read(s.a.secretRef!),
        has: () => s.secrets.has(s.a.secretRef!),
        write: () => s.secrets.write("new", "SYNTHETIC-new"),
        remove: () => s.secrets.remove(s.sentinel.secretRef!),
        retain: () => s.secrets.retain([s.a.secretRef!, s.sentinel.secretRef!]),
        "keep-edit": () => s.book.update({ ...phrase, id: s.a.id, keyPath: "/synthetic/new-key", secret: null }),
        startup: () => s.make(),
      };
      let error: unknown = null;
      try {
        run[action]();
      } catch (caught) {
        error = caught;
      }
      if (action === "startup") expect(error).toBeNull();
      else {
        expect(error).toBeInstanceOf(SecretStoreReadError);
        expect(String(error)).toContain("Could not read the saved passwords (damaged); nothing was changed.");
      }
      expect(s.canonical()).toEqual(before);
      expect(s.book.list().find((host) => host.id === s.a.id)?.secretRef).toBe(s.a.secretRef);
      s.make();
      expect(s.canonical()).toEqual(before);
      expect(fs.readFileSync(s.secretsFile).includes(Buffer.from(sealed))).toBe(true);
      // Mended by hand (the byte put back), the passphrase is there again.
      fs.writeFileSync(s.secretsFile, original);
      const mended = s.make();
      expect(mended.connectConfig(mended.list().find((host) => host.id === s.a.id)!).secret?.()).toBe("SYNTHETIC-phrase-A");
    });
  }
});

describe("an invalid byte in hosts.json", () => {
  it("reads as damaged (no machines listed), and start-up prunes no slot", () => {
    const s = setup();
    const original = fs.readFileSync(s.hostsFile);
    const bad = Buffer.from(original);
    const offset = bad.indexOf(s.a.secretRef!);
    expect(offset).toBeGreaterThan(0);
    bad[offset] = 0xff;
    fs.writeFileSync(s.hostsFile, bad);
    const before = s.canonical();
    const restarted = s.make();
    expect(restarted.list()).toEqual([]);
    expect(s.canonical()).toEqual(before);
    fs.writeFileSync(s.hostsFile, original);
    const mended = s.make();
    expect(mended.connectConfig(mended.list().find((host) => host.id === s.a.id)!).secret?.()).toBe("SYNTHETIC-phrase-A");
  });
});

describe("valid UTF-8 still loads", () => {
  it("a file with text in other scripts (a slot named in Arabic, a 4-byte emoji) loads and round-trips", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "herdr-utf8-ok-"));
    const file = path.join(dir, "host-secrets.json");
    const store = new SecretStore(file, fakeCipher());
    store.write("ماك-ميني.🔑", "SYNTHETIC-كلمة");
    expect(new SecretStore(file, fakeCipher()).read("ماك-ميني.🔑")).toBe("SYNTHETIC-كلمة");
    // Written by hand with a BOM-free non-ASCII value too.
    fs.writeFileSync(file, JSON.stringify({ version: 1, secrets: { "主机.slot": Buffer.from("enc:" + Buffer.from("x").toString("hex")).toString("base64") } }), "utf8");
    expect(new SecretStore(file, fakeCipher()).has("主机.slot")).toBe(true);
  });

  it("a machine with a non-ASCII host name keeps its password", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "herdr-utf8-host-"));
    const make = () => new SavedHosts(new HostStore(path.join(dir, "hosts.json")), new SecretStore(path.join(dir, "host-secrets.json"), fakeCipher()), () => true);
    const host = make().add({ ...sentinelRequest, name: "ماك ميني", host: "xn--mgbh0fb.local" });
    const restarted = make();
    expect(restarted.list()[0]?.name).toBe("ماك ميني");
    expect(restarted.connectConfig(host).secret?.()).toBe("SYNTHETIC-sentinel");
  });
});
