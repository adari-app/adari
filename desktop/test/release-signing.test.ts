// Developer ID signing, the hardened runtime and
// notarization are wired in the mac block and off by default. With nothing set
// the identity is null (no signing, as before); ADARI_SIGN_IDENTITY names the
// certificate; notarization runs only when ADARI_NOTARY_PROFILE names a
// notarytool keychain profile. Each case loads the config in a fresh node, so
// the environment it reads is exactly the one given.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");
// The pull-request variables too: electron-builder's own signing guard reads them.
const cleared = [
  "ADARI_SIGN_IDENTITY",
  "ADARI_NOTARY_PROFILE",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE",
  "CSC_NAME",
  "CSC_LINK",
  "GITHUB_BASE_REF",
  "TRAVIS_PULL_REQUEST",
  "CIRCLE_PULL_REQUEST",
  "BITRISE_PULL_REQUEST",
  "APPVEYOR_PULL_REQUEST_NUMBER",
  "CSC_FOR_PULL_REQUEST",
];

interface Loaded {
  readonly mac?: { identity: string | null; forceCodeSigning: boolean; hardenedRuntime: boolean; entitlements: string; entitlementsInherit: string; notarize: boolean; extendInfo: Record<string, string> };
  readonly keychainProfile?: string | null;
  readonly error?: string;
}

const baseEnv = (): Record<string, string | undefined> => Object.fromEntries(Object.entries(process.env).filter(([name]) => !cleared.includes(name)));

function load(env: Record<string, string>): Loaded {
  const base = baseEnv();
  const script = `try { const c = require(${JSON.stringify(path.join(root, "electron-builder.config.cjs"))}); console.log(JSON.stringify({ mac: c.mac, keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE ?? null })); } catch (e) { console.log(JSON.stringify({ error: e.message })); }`;
  return JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { ...base, ...env }, encoding: "utf8" })) as Loaded;
}

describe("signing and notarization, off by default", () => {
  it("with nothing set: identity null (no signing), no notarization, the hardened runtime and JIT entitlements ready", () => {
    const { mac, keychainProfile } = load({});
    expect(mac!.identity).toBeNull();
    expect(mac!.notarize).toBe(false);
    expect(keychainProfile).toBeNull();
    expect(mac!.hardenedRuntime).toBe(true);
    expect(mac!.entitlements).toBe(path.join(root, "build", "entitlements.mac.plist"));
    expect(mac!.entitlementsInherit).toBe(mac!.entitlements);
  });

  it("ADARI_SIGN_IDENTITY names the certificate; the Developer ID prefix electron-builder refuses is dropped", () => {
    expect(load({ ADARI_SIGN_IDENTITY: "Example Co (ABCDE12345)" }).mac!.identity).toBe("Example Co (ABCDE12345)");
    expect(load({ ADARI_SIGN_IDENTITY: "Developer ID Application: Example Co (ABCDE12345)" }).mac!.identity).toBe("Example Co (ABCDE12345)");
    expect(load({ ADARI_SIGN_IDENTITY: "Example Co (ABCDE12345)" }).mac!.notarize).toBe(false);
  });

  // A build made with ADARI_SIGN_IDENTITY updates itself (scripts/build.mjs), so it must
  // come out signed: a certificate that is not found fails the build instead of a warning and an unsigned app.
  it("with ADARI_SIGN_IDENTITY set, a missing certificate fails the build (forceCodeSigning); unset, nothing is forced", () => {
    expect(load({}).mac!.forceCodeSigning).toBe(false);
    expect(load({ ADARI_SIGN_IDENTITY: "Example Co (ABCDE12345)" }).mac!.forceCodeSigning).toBe(true);
  });

  // Set is not proof. electron-builder then makes nothing: the config does not load.
  it("refuses an ad-hoc '-', a hash, another certificate kind and a name without its team ID: none is a Developer ID", () => {
    expect(load({ ADARI_SIGN_IDENTITY: "-" }).error).toMatch(/ad-hoc signing\. That is not a Developer ID/u);
    expect(load({ ADARI_SIGN_IDENTITY: "0123456789ABCDEF0123456789ABCDEF01234567" }).error).toMatch(/certificate hash/u);
    expect(load({ ADARI_SIGN_IDENTITY: "Apple Distribution: Example Co (ABCDE12345)" }).error).toMatch(/certificate of kind "Apple Distribution"/u);
    expect(load({ ADARI_SIGN_IDENTITY: "Example Co" }).error).toMatch(/has no team ID/u);
  });

  it("refuses to sign where electron-builder's own guard would skip signing (a pull-request build), unless CSC_FOR_PULL_REQUEST=true", () => {
    for (const name of ["GITHUB_BASE_REF", "TRAVIS_PULL_REQUEST", "CIRCLE_PULL_REQUEST", "BITRISE_PULL_REQUEST", "APPVEYOR_PULL_REQUEST_NUMBER"]) {
      expect(load({ ADARI_SIGN_IDENTITY: "Example Co (ABCDE12345)", [name]: "12" }).error, name).toMatch(/skips signing in a pull-request build.*Refusing to build it/u);
    }
    // "false" is not a pull request (builder-util's isPullRequest); unsigned pull-request builds are as before.
    expect(load({ ADARI_SIGN_IDENTITY: "Example Co (ABCDE12345)", TRAVIS_PULL_REQUEST: "false" }).mac!.identity).toBe("Example Co (ABCDE12345)");
    expect(load({ GITHUB_BASE_REF: "main" }).mac!.identity).toBeNull();
    expect(load({ ADARI_SIGN_IDENTITY: "Example Co (ABCDE12345)", GITHUB_BASE_REF: "main", CSC_FOR_PULL_REQUEST: "true" }).mac).toMatchObject({ identity: "Example Co (ABCDE12345)", forceCodeSigning: true });
  });

  it("scripts/build.mjs fails a release build for '-' or a pull-request build, before it bakes or builds anything", () => {
    const dist = path.join(root, "dist", "main", "main.cjs");
    const before = existsSync(dist) ? statSync(dist).mtimeMs : null;
    for (const env of [{ ADARI_SIGN_IDENTITY: "-" }, { ADARI_SIGN_IDENTITY: "Example Co (ABCDE12345)", GITHUB_BASE_REF: "main" }]) {
      const run = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs"), "--release"], { cwd: root, env: { ...baseEnv(), ...env }, encoding: "utf8", timeout: 60_000 });
      expect(run.status, JSON.stringify(env)).toBe(1);
      expect(run.stderr).toMatch(/^build: ADARI_SIGN_IDENTITY /mu);
      expect(run.stdout).not.toContain("built dist/");
    }
    expect(existsSync(dist) ? statSync(dist).mtimeMs : null).toBe(before);
  });

  it("ADARI_NOTARY_PROFILE turns notarization on and hands electron-builder the keychain profile", () => {
    const { mac, keychainProfile } = load({ ADARI_SIGN_IDENTITY: "Example Co (ABCDE12345)", ADARI_NOTARY_PROFILE: "adari-notary" });
    expect(mac!.notarize).toBe(true);
    expect(keychainProfile).toBe("adari-notary");
  });

  it("refuses a notary profile without a signing identity, or beside another notary credential", () => {
    expect(load({ ADARI_NOTARY_PROFILE: "adari-notary" }).error).toMatch(/needs a signed app/u);
    expect(load({ ADARI_SIGN_IDENTITY: "X (ABCDE12345)", ADARI_NOTARY_PROFILE: "adari-notary", APPLE_ID: "someone@example.com" }).error).toMatch(/Unset APPLE_ID/u);
  });

  it("the entitlements are allow-jit and nothing else", () => {
    const plist = readFileSync(path.join(root, "build", "entitlements.mac.plist"), "utf8");
    expect(plist.match(/<key>[^<]+<\/key>/gu)).toEqual(["<key>com.apple.security.cs.allow-jit</key>"]);
  });

  it("says why it asks for the local network in Adari's words", () => {
    expect(load({}).mac!.extendInfo["NSLocalNetworkUsageDescription"]).toBe("Adari connects over SSH to the Macs you add and to Herdr on this Mac.");
  });
});
