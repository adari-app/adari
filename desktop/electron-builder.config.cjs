// electron-builder configuration: macOS dmg and zip, Windows NSIS, Linux
// AppImage and deb. Unsigned unless ADARI_SIGN_IDENTITY is set; notarized only
// when ADARI_NOTARY_PROFILE is set too (the mac block below).
// Nothing is published: every dist script runs electron-builder with
// `--publish never`, and the release files go up by hand.
//
// Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.):
// scripts/build-desktop-artifact.ts, createBuildConfig (artifact name pattern,
// one Electron language, the mac dmg + zip pair and its dmg window layout, the
// Linux AppImage + deb pair with the static AppImage runtime pin, the deb
// dependency list, NSIS with npmRebuild off, `publish` set explicitly: T3's
// github provider, here adari-app/adari). Not taken: T3's server sidecars, native helpers,
// passkey entitlements, protocols and signing hooks.
//
// Output goes to HERDR_RELEASE_DIR (default: release/, ignored by git).

const path = require("node:path");

const { signedReleaseIdentity } = require("./scripts/release-signing.cjs");

/**
 * ADARI_SIGN_IDENTITY as a Developer ID Application
 * identity, or null (unset: an unsigned build). Loading this config fails, so electron-builder makes nothing, for an
 * ad-hoc "-", a hash, another kind of certificate, a name without its team ID, or a host where electron-builder's own
 * guard would skip signing (scripts/release-signing.cjs; scripts/build.mjs asks the same before it bakes the team in).
 */
const signingIdentity = signedReleaseIdentity();

/**
 * The update feed, GitHub Releases of adari-app/adari, stable releases only (T3's
 * `publish` with provider github, scripts/build-desktop-artifact.ts). The same object as src/main/updates.ts's
 * UPDATE_GITHUB_FEED (test/updates.test.ts checks): electron-builder writes it into the app's app-update.yml and
 * names latest-mac.yml's files after it; the app sets the same feed itself. Only a signed build ever reads it.
 */
const UPDATE_GITHUB_FEED = { provider: "github", owner: "adari-app", repo: "adari", releaseType: "release" };

const productName = "Adari";

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "ai.adari.desktop",
  productName,
  artifactName: "Adari-${version}-${arch}.${ext}",
  electronLanguages: ["en-US"],
  directories: {
    output: process.env.HERDR_RELEASE_DIR || path.join(__dirname, "release"),
    // The icon: build/icon.icns and build/icon.png, drawn from the iPhone app's artwork in the macOS shape.
    buildResources: "build",
  },
  files: [
    "dist/**/*",
    "package.json",
    // The third-party notices and licence texts, self-contained, at the root
    // of app.asar on every OS. Not also in
    // extraResources: electron-builder leaves out of the app files whatever
    // extraResources or extraFiles copy (platformPackager's excludePatterns).
    "THIRD_PARTY_NOTICES.md",
    // T3's exclusions: source maps and type declarations.
    "!**/*.map",
    "!**/*.d.ts",
    "!**/*.d.cts",
    // ssh2's optional native parts are not built (both requires are guarded):
    // ssh2 runs in plain JS, so one package serves every OS without a native
    // toolchain. Their sources stay out of the package.
    "!**/node_modules/cpu-features/**",
    "!**/node_modules/buildcheck/**",
    "!**/node_modules/nan/**",
    "!**/node_modules/ssh2/lib/protocol/crypto/src/**",
    "!**/node_modules/ssh2/lib/protocol/crypto/binding.gyp",
  ],
  npmRebuild: false,
  nodeGypRebuild: false,
  asar: true,
  // app-update.yml in the app and latest-mac.yml beside the dmg and zip come from this (nothing is uploaded).
  publish: [UPDATE_GITHUB_FEED],

  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    category: "public.app-category.developer-tools",
    // Our icon in the macOS shape (the iPhone app's artwork).
    icon: "build/icon.icns",
    // Signing and notarization, off unless asked for. Option names checked
    // against the installed electron-builder 26.16.1 (app-builder-lib scheme.json and out/options/macOptions.d.ts).
    // ADARI_SIGN_IDENTITY names a Developer ID Application certificate in the login Keychain, "Name (TEAMID)", without
    // the "Developer ID Application: " prefix, which electron-builder refuses (macCodeSign.js checkPrefix; dropped here
    // if given). Unset, the identity is null: no signing at all, so an unset environment builds the unsigned app.
    identity: signingIdentity === null ? null : signingIdentity.name,
    // With ADARI_SIGN_IDENTITY set, a certificate that is not found fails the build.
    // electron-builder 26.16.1 would only warn and build the app unsigned (MacTargetHelper.findSigningIdentity,
    // macCodeSign.reportError), and scripts/build.mjs turns updates on for exactly these builds: Squirrel.Mac installs
    // only signed updates, so a build with updates on must be signed. (Its pull-request guard returns before this is
    // read: signedReleaseIdentity above refuses such a build first.)
    forceCodeSigning: signingIdentity !== null,
    // Applies only when the app is signed (osx-sign's per-file options); an unsigned build is not touched by it.
    hardenedRuntime: true,
    // JIT only (V8's JIT, ghostty-vt.wasm in the renderer); no unsigned executable memory, no library validation
    // switch-off. The same file for the helpers, which inherit it.
    entitlements: path.join(__dirname, "build", "entitlements.mac.plist"),
    entitlementsInherit: path.join(__dirname, "build", "entitlements.mac.plist"),
    // Notarization only when ADARI_NOTARY_PROFILE names a notarytool keychain profile (xcrun notarytool
    // store-credentials). electron-builder 26's `notarize` is a boolean, and it reads the profile from
    // APPLE_KEYCHAIN_PROFILE (MacTargetHelper.getNotarizeOptions), so it is handed over here. It needs a signed app,
    // and an APPLE_ID or APPLE_API_KEY set alongside would win over the profile, so both are refused.
    notarize: (() => {
      const profile = process.env.ADARI_NOTARY_PROFILE;
      if (!profile) return false;
      if (signingIdentity === null) throw new Error("ADARI_NOTARY_PROFILE is set but ADARI_SIGN_IDENTITY is not: notarization needs a signed app.");
      for (const name of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
        if (process.env[name]) throw new Error(`Unset ${name}: with ADARI_NOTARY_PROFILE the notarytool keychain profile is the only credential.`);
      }
      process.env.APPLE_KEYCHAIN_PROFILE = profile;
      return true;
    })(),
    extendInfo: {
      NSLocalNetworkUsageDescription: "Adari connects over SSH to the Macs you add and to Herdr on this Mac.",
    },
  },
  dmg: {
    title: `${productName} \${version}`,
    window: { width: 640, height: 432 },
    contents: [
      { x: 166, y: 214, type: "file" },
      { x: 474, y: 214, type: "link", path: "/Applications" },
    ],
    iconSize: 120,
    iconTextSize: 12,
  },

  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    // Editing the .exe's resources needs rcedit under Wine on a Mac; off until
    // Windows builds run on Windows with signing.
    signAndEditExecutable: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    differentialPackage: true,
  },

  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    executableName: "adari",
    category: "Development",
    synopsis: "One sidebar across your machines' Herdr panes",
    maintainer: "Elysium Technologies <maintainer@example.invalid>",
    desktop: { entry: { StartupWMClass: "adari" } },
  },
  // The static AppImage runtime, so hosts with only FUSE 3 do not need libfuse2 (T3's pin).
  toolsets: { appimage: "1.0.3" },
  deb: {
    depends: [
      "libasound2t64 | libasound2",
      "libatspi2.0-0t64 | libatspi2.0-0",
      "libgbm1",
      "libgtk-3-0t64 | libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libuuid1",
      "libxss1",
      "libxtst6",
      "xdg-utils",
    ],
  },
};
