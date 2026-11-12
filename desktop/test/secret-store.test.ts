// A machine's password or key passphrase lives apart from hosts.json:
// encrypted with Electron's safeStorage (faked here; the real one is never
// called in tests), the ciphertext alone in its own file, readable by the
// user only. When the system cannot encrypt, nothing is saved and the
// reason says so.

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SecretFileError, SecretStore, SecretStoreReadError, SecretsUnavailableError } from "../src/main/secret-store";
import { sshAuthOptions } from "../src/main/herdr/ssh";
import { fakeCipher } from "./support/fake-cipher";

function folder(): string {
  return mkdtempSync(path.join(tmpdir(), "herdr-secrets-"));
}

describe("SecretStore", () => {
  // No prune of "secrets without a machine" at start: a damaged hosts.json reads as no machines and would wipe them all.
  it("keeps the secret encrypted in its own 0600 file and reads it back", () => {
    const file = path.join(folder(), "host-secrets.json");
    const store = new SecretStore(file, fakeCipher());
    expect(store.has("h1")).toBe(false);
    expect(store.read("h1")).toBeNull();
    store.write("h1", "correct horse");
    expect(store.has("h1")).toBe(true);
    expect(store.read("h1")).toBe("correct horse");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("correct horse");
    expect(raw).not.toContain("horse");
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces a secret and removes one; the file goes with the last one", () => {
    const file = path.join(folder(), "host-secrets.json");
    const store = new SecretStore(file, fakeCipher());
    store.write("h1", "one");
    store.write("h2", "two");
    store.write("h1", "uno");
    expect(store.read("h1")).toBe("uno");
    store.remove("h1");
    expect(store.has("h1")).toBe(false);
    expect(store.read("h2")).toBe("two");
    expect(readFileSync(file, "utf8")).not.toContain("h1");
    store.remove("h2");
    expect(existsSync(file)).toBe(false);
    store.remove("never-saved");
  });

  it("refuses to save when the system cannot encrypt, and says why", () => {
    const file = path.join(folder(), "host-secrets.json");
    const store = new SecretStore(file, fakeCipher(false));
    expect(store.available()).toBe(false);
    expect(() => store.write("h1", "secret")).toThrow(SecretsUnavailableError);
    expect(() => store.write("h1", "secret")).toThrow(/can't encrypt/);
    expect(existsSync(file)).toBe(false);
  });

  it("treats Linux's plain-text fallback as no encryption", () => {
    const store = new SecretStore(path.join(folder(), "s.json"), fakeCipher(true, "basic_text"));
    expect(store.available()).toBe(false);
    expect(new SecretStore(path.join(folder(), "s.json"), fakeCipher(true, "gnome_libsecret")).available()).toBe(true);
  });

  it("refuses a damaged file (never read as empty); reads nothing from a secret it cannot decrypt", () => {
    const dir = folder();
    const file = path.join(dir, "host-secrets.json");
    writeFileSync(file, "{not json");
    const store = new SecretStore(file, fakeCipher());
    expect(() => store.read("h1")).toThrow(SecretStoreReadError);
    writeFileSync(file, JSON.stringify({ version: 1, secrets: { h1: Buffer.from("garbage").toString("base64") } }));
    expect(store.has("h1")).toBe(true);
    expect(store.read("h1")).toBeNull();
  });

  // An interrupted write leaves host-secrets.json.<pid>.tmp,
  // an old encrypted copy. Never promoted; discarded at start and by every write.
  describe("stale temp files", () => {
    function withStaleTemp() {
      const dir = folder();
      const file = path.join(dir, "host-secrets.json");
      new SecretStore(file, fakeCipher()).write("h1", "old-secret");
      const stale = `${file}.987654321.tmp`;
      writeFileSync(stale, readFileSync(file), { mode: 0o600 });
      writeFileSync(path.join(dir, "hosts.json.987654321.tmp"), "not ours");
      writeFileSync(path.join(dir, "host-secrets.json.bak"), "not ours");
      return { dir, file, stale };
    }
    const leftovers = (dir: string) => readdirSync(dir).filter((name) => /^host-secrets\.json\.\d+\.tmp$/.test(name));

    it("are discarded at start, never promoted; other files are left alone", () => {
      const { dir, file, stale } = withStaleTemp();
      const store = new SecretStore(file, fakeCipher());
      store.discardStaleTemps();
      expect(existsSync(stale)).toBe(false);
      expect(store.read("h1")).toBe("old-secret");
      expect(readdirSync(dir).sort()).toEqual(["host-secrets.json", "host-secrets.json.bak", "hosts.json.987654321.tmp"]);
    });

    it("a replace leaves no older copy", () => {
      const { dir, file } = withStaleTemp();
      new SecretStore(file, fakeCipher()).write("h1", "new-secret");
      expect(leftovers(dir)).toEqual([]);
    });

    it("removing the last secret leaves no copy at all", () => {
      const { dir, file } = withStaleTemp();
      new SecretStore(file, fakeCipher()).remove("h1");
      expect(existsSync(file)).toBe(false);
      expect(leftovers(dir)).toEqual([]);
    });
  });

  // A file someone widened is made private before it is read.
  describe("an existing file with wider permissions", () => {
    function widened() {
      const file = path.join(folder(), "host-secrets.json");
      new SecretStore(file, fakeCipher()).write("h1", "secret");
      chmodSync(file, 0o644);
      return file;
    }

    it("is 0600 after it is opened and read", () => {
      const file = widened();
      const store = new SecretStore(file, fakeCipher());
      expect(store.read("h1")).toBe("secret");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it("is 0600 after it is opened and asked whether a secret is saved", () => {
      const file = widened();
      expect(new SecretStore(file, fakeCipher()).has("h1")).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it("is 0600 after a rewrite", () => {
      const file = widened();
      new SecretStore(file, fakeCipher()).write("h2", "other");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it("is not read when it cannot be made private, and the connection says why", () => {
      const file = widened();
      const store = new SecretStore(file, fakeCipher(), {
        chmod: () => {
          throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        },
      });
      expect(() => store.read("h1")).toThrow(SecretFileError);
      expect(() => store.read("h1")).toThrow(/can be read by other users.*could not be made private \(EPERM\).*not read/);
      expect(() => store.write("h1", "x")).toThrow(SecretFileError);
      expect(() =>
        sshAuthOptions({ host: "a.invalid", port: 22, username: "me", herdrSession: "default", auth: "password", privateKeyPath: "", secret: () => store.read("h1") }),
      ).toThrow(/couldn't connect to a.invalid: The saved passwords file can be read by other users/);
    });
  });
});
