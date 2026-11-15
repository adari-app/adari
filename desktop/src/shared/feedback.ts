// Report a Problem… and Send Feedback… (the Help menu and Settings › About).
// Adari sends nothing itself: each opens the person's browser on a new GitHub
// issue of the app's own repository, its body already filled in, and they
// press Submit there (or not). The body is a short template and four details
// about this build and this Mac: Adari's version, a signed release or a
// development build, the macOS version and the chip family. Nothing else
// goes in: no machine, address, user name, path, agent, chat or terminal
// text, no log. The repository is the update feed's (src/main/feedback.ts
// passes UPDATE_GITHUB_FEED's owner and name); the address is built here and
// checked again before it opens (isFeedbackIssueUrl).

/** Which of the two. */
export type FeedbackKind = "problem" | "feedback";

export const feedbackKinds: readonly FeedbackKind[] = ["problem", "feedback"];

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return value === "problem" || value === "feedback";
}

/** The Help menu's items. */
export const feedbackMenuLabels: Readonly<Record<FeedbackKind, string>> = {
  problem: "Report a Problem…",
  feedback: "Send Feedback…",
};

/** Settings › About: each row's title, and the one line under the two rows. */
export const feedbackRowTitles: Readonly<Record<FeedbackKind, string>> = {
  problem: "Report a problem",
  feedback: "Send feedback",
};
export const feedbackRowButton = "New issue";
export const feedbackFoot = "Opens a new issue on GitHub in your browser. Adari sends nothing itself.";

/** A GitHub repository, as the update feed names it. */
export interface FeedbackRepo {
  readonly owner: string;
  readonly repo: string;
}

/** The four details, and nothing else. */
export interface FeedbackDetails {
  /** app.getVersion(). */
  readonly version: string;
  /** A packaged build made to be signed with a Developer ID (a release); anything else is a development build. */
  readonly signedRelease: boolean;
  /** The macOS version (process.getSystemVersion()). */
  readonly macOS: string;
  /** "Apple silicon" or "Intel" (chipFamily). */
  readonly chip: string;
}

/** The address, with its body, stays under this many characters. */
export const maxFeedbackUrlLength = 2_000;

/** The longest a detail's value is written (it is shortened further only if the address would be too long). */
const detailValueLength = 64;

/** The Mac's chip family: Apple silicon (also an Intel build running under Rosetta on it) or Intel. */
export function chipFamily(arch: string, translated: boolean): string {
  return arch === "arm64" || translated ? "Apple silicon" : "Intel";
}

/** The sections each body asks for, in order. */
const sections: Readonly<Record<FeedbackKind, readonly string[]>> = {
  problem: ["What happened", "What you expected", "Steps"],
  feedback: ["Your idea or feedback"],
};

/** A value on one line: no control or line-break characters, spaces collapsed, at most `limit` characters. */
function oneLine(value: string, limit: number): string {
  const flat = String(value)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(flat).slice(0, Math.max(0, limit)).join("");
}

/** The details block's four lines. */
export function feedbackDetailLines(details: FeedbackDetails, limit = detailValueLength): string[] {
  return [
    `- Adari version: ${oneLine(details.version, limit)}`,
    `- Build: ${details.signedRelease ? "signed release" : "development build"}`,
    `- macOS: ${oneLine(details.macOS, limit)}`,
    `- Chip: ${oneLine(details.chip, limit)}`,
  ];
}

/** The issue's body as it opens: the kind's sections, each with a line to write on, then the details. */
export function feedbackBody(kind: FeedbackKind, details: FeedbackDetails, limit = detailValueLength): string {
  const asks = sections[kind].map((title) => `### ${title}\n\n\n`).join("");
  return `${asks}### Details\n\n${feedbackDetailLines(details, limit).join("\n")}\n`;
}

/** Where a new issue of `repo` is written. */
export function feedbackIssueBase(repo: FeedbackRepo): string {
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/new`;
}

/**
 * The new issue's address: the title left empty, the body URL-encoded, the whole under maxFeedbackUrlLength
 * characters (a long or odd version or macOS value is shortened until it fits; the template always does).
 */
export function feedbackIssueUrl(kind: FeedbackKind, details: FeedbackDetails, repo: FeedbackRepo): string {
  const base = feedbackIssueBase(repo);
  for (let limit = detailValueLength; ; limit -= 8) {
    const url = `${base}?body=${encodeURIComponent(feedbackBody(kind, details, limit))}`;
    if (url.length < maxFeedbackUrlLength || limit <= 0) return url;
  }
}

/**
 * Whether `candidate` is a new issue of `repo` and nothing else: https, github.com with no port or sign-in, the
 * issues/new path, only a body (and a title) in the query, no fragment, under the length cap.
 */
export function isFeedbackIssueUrl(candidate: string, repo: FeedbackRepo): boolean {
  if (typeof candidate !== "string" || candidate.length >= maxFeedbackUrlLength) return false;
  if (!candidate.startsWith(`${feedbackIssueBase(repo)}?`)) return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "") return false;
  if (url.pathname !== `/${repo.owner}/${repo.repo}/issues/new` || url.hash !== "") return false;
  const keys = [...url.searchParams.keys()];
  return keys.includes("body") && keys.every((key) => key === "body" || key === "title") && new Set(keys).size === keys.length;
}
