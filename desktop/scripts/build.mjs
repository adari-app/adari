// Builds the three parts T3 Code's desktop app has: the main process and the
// preload as CommonJS bundles (esbuild), and the renderer (Vite + React).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

import { signedReleaseIdentity } from "./release-signing.cjs";
import { licensesFile, writeThirdPartyLicenses } from "./third-party-licenses.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Whether this build is for a package. `npm run dist:mac|win|linux` run
 * `node scripts/build.mjs --release && electron-builder …` (package.json), so `--release` is what
 * makes every packaged build a release build. ADARI_RELEASE_BUILD=1 does the same (=0 forces a
 * development build). The rest is a fallback for a hand-run build: npm_lifecycle_event dist:*, or a
 * parent process whose command line is `electron-builder … --mac|--win|--linux` (not on Windows).
 */
function isReleaseBuild() {
  if (process.argv.includes("--release")) return true;
  const forced = process.env.ADARI_RELEASE_BUILD;
  if (forced === "1") return true;
  if (forced === "0") return false;
  if (/^dist:(mac|win|linux)$/u.test(process.env.npm_lifecycle_event ?? "")) return true;
  if (process.platform === "win32") return false;
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
    let line;
    try {
      line = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    } catch {
      return false;
    }
    const match = /^(\d+)\s+(.*)$/su.exec(line);
    if (match === null) return false;
    if (/\belectron-builder\b.*\s--(mac|win|linux)\b/u.test(match[2])) return true;
    pid = Number(match[1]);
  }
  return false;
}

const release = isReleaseBuild();

/**
 * The commit this build is made from, for Settings (git's short hash; no network). Outside a git
 * checkout, or with git missing, none (Settings shows the version alone).
 */
function buildCommit() {
  try {
    const hash = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{7,40}$/u.test(hash) ? hash : "";
  } catch {
    return "";
  }
}

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  logLevel: "warning",
  absWorkingDir: root,
  outExtension: { ".js": ".cjs" },
  // The repo's fixtures ride inside the main bundle for demo mode (development builds only, below).
  loader: { ".hfx": "binary", ".txt": "text" },
  // A dist build leaves out the demo, the showcase, the captures, the probes and the fixtures:
  // main.ts requires src/main/dev-modes.ts only when this is true, and esbuild drops the dead branch.
  define: { __ADARI_DEMO__: release ? "false" : "true" },
};
// The build's commit, for Settings › Updates and About (src/main/build-info.ts).
common.define.__ADARI_COMMIT__ = JSON.stringify(buildCommit());

/**
 * Whether this build updates itself. Squirrel.Mac installs only signed updates, so only
 * a release build made to be signed with a Developer ID Application certificate gets the certificate's team ID baked in;
 * a plain `npm run dist:mac` (an unsigned package), `npm start` and the tests get "", and src/main/updates.ts never loads
 * electron-updater for them. ADARI_SIGN_IDENTITY being set is not proof, so
 * signedReleaseIdentity (scripts/release-signing.cjs) fails this build for an ad-hoc "-", a hash, another kind of
 * certificate, a name without its team ID, or a host where electron-builder would skip signing (its isSignAllowed
 * guard). The app checks its own signature against this team again before its first check (checkOwnSignature).
 */
let signing = null;
if (release) {
  try {
    signing = signedReleaseIdentity();
  } catch (error) {
    console.error(`build: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
common.define.__ADARI_UPDATE_TEAM__ = JSON.stringify(signing === null ? "" : signing.team);

await esbuild({
  ...common,
  entryPoints: { main: "src/main/main.ts" },
  outdir: "dist/main",
  // Shipped as node_modules in the package (electron-builder copies dependencies).
  external: ["electron", "ssh2", "electron-updater"],
});

await esbuild({
  ...common,
  entryPoints: { preload: "src/preload/preload.ts" },
  outdir: "dist/preload",
  // A sandboxed preload can require only "electron": everything else is bundled.
  external: ["electron"],
});

// The list of every shipped component and its licence, made again from the installed packages
// before the renderer is bundled. Settings does not show it (About opens THIRD_PARTY_NOTICES.md,
// which every package ships); the list stays in the repo, kept current here and checked by settings-licenses.test.ts.
if (writeThirdPartyLicenses(root)) console.log(`wrote ${licensesFile} (the installed packages changed)`);

await viteBuild({ configFile: path.join(root, "vite.config.ts"), logLevel: "warn" });

console.log(
  `built dist/main, dist/preload, dist/renderer (${release ? "release: no demo, showcase, captures or probes" : "development: demo included"}; updates ${signing === null ? "off: not a signed release" : `on: Developer ID team ${signing.team}, which the app checks it is signed by before its first check`})`,
);
