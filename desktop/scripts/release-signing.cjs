// A build may update itself only when it is made to be
// signed with a Developer ID Application certificate and electron-builder will really sign it. An environment value
// is not proof of that, so both places that read ADARI_SIGN_IDENTITY ask signedReleaseIdentity first:
// scripts/build.mjs, before it bakes the certificate's team into the main bundle (the app's "may update" mark), and
// electron-builder.config.cjs, when electron-builder runs. Either one fails the build instead of making a package with
// updates on that would not be Developer ID signed: an ad-hoc identity ("-"), a hash or another kind of certificate,
// a name without its team ID, or a host where electron-builder's own guard (isSignAllowed: not a Mac, or a pull-request
// build without CSC_FOR_PULL_REQUEST) would skip signing before forceCodeSigning is ever read.
//
// The app then checks its own signature against that team before it first loads electron-updater
// (src/main/updates.ts checkOwnSignature), so a package that still came out unsigned, ad-hoc signed or signed by
// another team never checks for updates.

"use strict";

const developerIdPrefix = "Developer ID Application:";

/** Keychain Access's prefixes of the certificate kinds that are not Developer ID Application. */
const otherKinds = [
  "Developer ID Installer:",
  "Apple Development:",
  "Apple Distribution:",
  "Mac Developer:",
  "3rd Party Mac Developer Application:",
  "3rd Party Mac Developer Installer:",
  "Mac App Distribution:",
  "Mac Installer Distribution:",
  "iPhone Developer:",
  "iPhone Distribution:",
];

const nameHelp = 'Name the Developer ID Application certificate as Keychain Access shows it, without the prefix: "Name (TEAMID)".';

/**
 * ADARI_SIGN_IDENTITY read as a Developer ID Application identity: its name (as electron-builder takes it, without the
 * prefix) and its team ID; null when unset (an unsigned build). Anything else throws: it could not be a Developer ID.
 */
function developerIdIdentity(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return null;
  if (text === "-") {
    throw new Error(`ADARI_SIGN_IDENTITY is "-", electron-builder's ad-hoc signing. That is not a Developer ID, and an ad-hoc build must not update itself. Unset it for an unsigned build. ${nameHelp}`);
  }
  if (/^[0-9A-Fa-f]{40}$/u.test(text)) throw new Error(`ADARI_SIGN_IDENTITY is a certificate hash, and a hash does not say what kind of certificate it is. ${nameHelp}`);
  const kind = otherKinds.find((prefix) => text.startsWith(prefix));
  if (kind !== undefined) {
    throw new Error(`ADARI_SIGN_IDENTITY names a certificate of kind "${kind.slice(0, -1)}". Only a Developer ID Application certificate signs a download that updates itself. ${nameHelp}`);
  }
  const name = text.startsWith(developerIdPrefix) ? text.slice(developerIdPrefix.length).trim() : text;
  const match = /^\S.*\s\(([A-Z0-9]{10})\)$/u.exec(name);
  if (match === null) throw new Error(`ADARI_SIGN_IDENTITY "${text}" has no team ID. ${nameHelp}`);
  return { name, team: match[1] };
}

/**
 * Why electron-builder would leave this build unsigned whatever the identity, or null. Its own guard, read from the
 * installed electron-builder: MacPackager.sign returns before it looks at the identity or forceCodeSigning when
 * isSignAllowed() is false (not on a Mac, or a pull-request build without CSC_FOR_PULL_REQUEST=true).
 */
function signingSkipReason() {
  const { isSignAllowed } = require("app-builder-lib/out/codeSign/macCodeSign");
  if (isSignAllowed(false)) return null;
  if (process.platform !== "darwin") return "electron-builder signs Mac apps only on a Mac";
  return "electron-builder skips signing in a pull-request build (GITHUB_BASE_REF, TRAVIS_PULL_REQUEST, CIRCLE_PULL_REQUEST, BITRISE_PULL_REQUEST or APPVEYOR_PULL_REQUEST_NUMBER is set, and CSC_FOR_PULL_REQUEST is not true)";
}

/**
 * For a build that is to update itself: the Developer ID identity from ADARI_SIGN_IDENTITY, or null when it is unset
 * (an unsigned build, updates off). Throws when it is set but the package would not come out Developer ID signed.
 */
function signedReleaseIdentity() {
  const identity = developerIdIdentity(process.env.ADARI_SIGN_IDENTITY);
  if (identity === null) return null;
  const skipped = signingSkipReason();
  if (skipped !== null) throw new Error(`ADARI_SIGN_IDENTITY is set, but ${skipped}, so the package would come out unsigned. Refusing to build it.`);
  return identity;
}

module.exports = { developerIdIdentity, signingSkipReason, signedReleaseIdentity };
