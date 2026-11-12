// Types for scripts/release-signing.cjs (test/release-signing.test.ts and
// test/update-boundary.test.ts import it).

export interface DeveloperIdIdentity {
  /** As electron-builder takes it: "Name (TEAMID)", without the "Developer ID Application: " prefix. */
  readonly name: string;
  /** The certificate's team ID (its subject OU). */
  readonly team: string;
}

export declare function developerIdIdentity(raw: string | undefined): DeveloperIdIdentity | null;
export declare function signingSkipReason(): string | null;
export declare function signedReleaseIdentity(): DeveloperIdIdentity | null;
