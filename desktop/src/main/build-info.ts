// The commit the app was built from, for Settings' Updates and
// About (the iPhone app's "1.0 (build) · commit"). scripts/build.mjs sets
// __ADARI_COMMIT__ from `git rev-parse --short=8 HEAD` (no network); a build
// made outside a git checkout, or code run straight from the sources (the
// tests), has none.

declare const __ADARI_COMMIT__: string | undefined;

/** A short hash as git prints one: 7 to 40 lowercase hex characters; anything else is not a commit. */
export function commitOf(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/.test(value) ? value : null;
}

export const buildCommit: string | null = commitOf(typeof __ADARI_COMMIT__ === "string" ? __ADARI_COMMIT__ : undefined);
