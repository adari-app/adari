// The Help menu's Report a Problem… and Send Feedback…, and Settings › About's
// same two (through the bridge's openFeedback, which carries only which one):
// the new issue's address built from this build's four details
// (src/shared/feedback.ts), checked to be a new issue of the update feed's
// repository and nothing else, then opened the way a link in Chat is (main.ts:
// the default browser, which comes forward; Adari's window is not touched; a
// capture run only says which). Nothing is sent, nothing is kept. Report a
// Problem carries the answers not sent because the question changed
// (PromptService.refusals), as counts and fixed words only.

import { isSafeExternalUrl } from "../shared/external-url";
import { chipFamily, feedbackIssueUrl, isFeedbackIssueUrl, type FeedbackDetails, type FeedbackKind, type FeedbackRepo, type FeedbackSpeed } from "../shared/feedback";
import type { PromptRefusal } from "../shared/prompt/refusals";
import { SpeedLog, speedLine, type SpeedRecord } from "../shared/speed-record";
import { UPDATE_GITHUB_FEED } from "./updates";

/**
 * New agent's and picture messages' timings, the last 20 of each, kept in memory
 * only; each logged once as its line through `log` (`new-agent: …`, `picture-send: …`).
 */
export function speedLogs(log: (line: string) => void): { readonly starts: SpeedLog; readonly pictures: SpeedLog; record(record: SpeedRecord): void } {
  const starts = new SpeedLog();
  const pictures = new SpeedLog();
  return {
    starts,
    pictures,
    record: (record) => {
      (record.what === "start" ? starts : pictures).record(record);
      log(`${record.what === "start" ? "new-agent" : "picture-send"}: ${speedLine(record)}`);
    },
  };
}

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
export function openFeedbackIssue(
  kind: FeedbackKind,
  details: FeedbackDetails,
  open: (url: string) => void,
  refusals: readonly PromptRefusal[] = [],
  speed: FeedbackSpeed = { start: [], picture: [] },
): boolean {
  const url = feedbackIssueUrl(kind, details, feedbackRepo, refusals, speed);
  if (!isSafeExternalUrl(url) || !isFeedbackIssueUrl(url, feedbackRepo)) return false;
  open(url);
  return true;
}
