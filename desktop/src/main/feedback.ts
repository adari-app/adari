// The Help menu's Report a Problem… and Send Feedback…, and Settings › About's
// same two (through the bridge's openFeedback, which carries only which one):
// the new issue's address built from this build's four details
// (src/shared/feedback.ts), checked to be a new issue of the update feed's
// repository and nothing else, then opened the way a link in Chat is (main.ts:
// the default browser, which comes forward; Adari's window is not touched; a
// capture run only says which). Nothing is sent, nothing is kept.

import { isSafeExternalUrl } from "../shared/external-url";
import { chipFamily, feedbackIssueUrl, isFeedbackIssueUrl, type FeedbackDetails, type FeedbackKind, type FeedbackRepo } from "../shared/feedback";
import { UPDATE_GITHUB_FEED } from "./updates";

/** The update feed's repository: the one place its owner and name are written. */
export const feedbackRepo: FeedbackRepo = { owner: UPDATE_GITHUB_FEED.owner, repo: UPDATE_GITHUB_FEED.repo };

/** What the details are read from (Electron's app and process, in main.ts). */
export interface FeedbackFacts {
  readonly version: string;
  /** Packaged and made to be signed with a Developer ID (main.ts signedBuild). */
  readonly packaged: boolean;
  readonly signed: boolean;
  readonly platform: NodeJS.Platform;
  /** process.getSystemVersion(): the macOS version on the Mac. */
  readonly systemVersion: string;
  readonly arch: string;
  /** app.runningUnderARM64Translation: an Intel build on Apple silicon. */
  readonly translated: boolean;
}

export function feedbackDetails(facts: FeedbackFacts): FeedbackDetails {
  return {
    version: facts.version,
    signedRelease: facts.packaged && facts.signed,
    macOS: facts.platform === "darwin" ? facts.systemVersion : `none (${facts.platform})`,
    chip: chipFamily(facts.arch, facts.translated),
  };
}

/** Opens the new issue through `open` (main's link opener); false, and nothing opened, if the address is not one. */
export function openFeedbackIssue(kind: FeedbackKind, details: FeedbackDetails, open: (url: string) => void): boolean {
  const url = feedbackIssueUrl(kind, details, feedbackRepo);
  if (!isSafeExternalUrl(url) || !isFeedbackIssueUrl(url, feedbackRepo)) return false;
  open(url);
  return true;
}
