// The Mac app's own updates, as the page and
// the main process both see them. One state (UpdateView), the steps that move
// it, the sidebar pill's look for each state, and every word the updater says
// (the pill's tooltips, the toast, the Restart question, Settings › Updates,
// the menu's Check for Updates…). Pure, so it is tested without Electron.
//
// Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.; read at
// 09a54f01): apps/desktop/src/updates/updateMachine.ts (a check keeps a
// downloaded update; a newer version than the downloaded one replaces it; a
// failed download goes back to available; a failed install stays downloaded)
// and apps/web/src/components/desktopUpdate.logic.ts (the button's action per
// state, its tooltips, the install question), without T3's channels, release
// notes and architecture warning. Ours keeps a version found when a later
// check fails (T3 drops it to an error), so a failed check never hides the pill.

/**
 * Why this build does not update itself (UpdateView.off). flags: opened with a demo, capture or probe flag, which the
 * shipped app otherwise ignores; unsigned also covers a package whose own signature check failed.
 */
export type UpdatesOffReason = "unsigned" | "development" | "demo" | "flags" | "platform";

export type UpdateStatus = "off" | "idle" | "current" | "available" | "downloading" | "downloaded" | "installing";

export type UpdateFailureStep = "check" | "download" | "install";

export interface UpdateView {
  /**
   * off: this build does not update itself (`off` says why); idle: on, not checked yet; current: the last check found
   * nothing newer; available: a newer version is out; downloading; downloaded: ready to install; installing: Restart
   * was confirmed and Adari is quitting into the new version.
   */
  readonly status: UpdateStatus;
  readonly off: UpdatesOffReason | null;
  /** The version running now. */
  readonly current: string;
  /** The newer version the last check found (null: none known). */
  readonly available: string | null;
  /** The version downloaded and ready to install (null: none). */
  readonly downloaded: string | null;
  /** The download's progress, 0 to 100, while it downloads. */
  readonly percent: number | null;
  /** A check is under way (the status stays what it was, so the pill never blinks out during one). */
  readonly checking: boolean;
  /** When the last check ended, and how. */
  readonly lastCheck: { readonly at: number; readonly outcome: "current" | "available" | "failed" } | null;
  /** What failed last, in words (UpdateFailure), until the next step succeeds. */
  readonly error: { readonly during: UpdateFailureStep; readonly message: string } | null;
  /** Settings › Updates' "Check for updates automatically" (on by default). */
  readonly automatic: boolean;
  /** Downloads finished in this run: the page shows its toast once for each new one. */
  readonly downloads: number;
  /**
   * Restart was confirmed long ago (installWaitMs) and Squirrel.Mac is still preparing the update: Adari restarts when
   * it is ready, and there is nothing to click until that attempt ends.
   */
  readonly stillPreparing: boolean;
}

/** The first state: off with its reason, or on and not checked yet. */
export function initialUpdateView(current: string, off: UpdatesOffReason | null, automatic: boolean): UpdateView {
  return {
    status: off === null ? "idle" : "off",
    off,
    current,
    available: null,
    downloaded: null,
    percent: null,
    checking: false,
    lastCheck: null,
    error: null,
    automatic,
    downloads: 0,
    stillPreparing: false,
  };
}

// --- The steps (T3's updateMachine.ts reducers) ---

export function onCheckStart(view: UpdateView): UpdateView {
  return { ...view, checking: true };
}

/** A check failed: a version already found or downloaded stays (no pill goes away); the reason is kept for Settings. */
export function onCheckFailed(view: UpdateView, message: string, at: number): UpdateView {
  return { ...view, checking: false, lastCheck: { at, outcome: "failed" }, error: { during: "check", message } };
}

/** The feed has `version`, newer than this one. The one already downloaded stays downloaded; a newer one replaces it. */
export function onAvailable(view: UpdateView, version: string, at: number): UpdateView {
  const downloaded = view.downloaded === version;
  return {
    ...view,
    status: downloaded ? "downloaded" : "available",
    available: version,
    downloaded: downloaded ? version : null,
    percent: downloaded ? 100 : null,
    checking: false,
    lastCheck: { at, outcome: "available" },
    error: null,
  };
}

/** Nothing newer than this version. A download waiting to install stays (T3's reduceOnNoUpdate). */
export function onNotAvailable(view: UpdateView, at: number): UpdateView {
  const lastCheck = { at, outcome: "current" as const };
  if (view.downloaded !== null) return { ...view, status: "downloaded", available: view.downloaded, checking: false, lastCheck, error: null };
  return { ...view, status: "current", available: null, percent: null, checking: false, lastCheck, error: null };
}

export function onDownloadStart(view: UpdateView): UpdateView {
  return { ...view, status: "downloading", percent: 0, error: null };
}

export function onDownloadProgress(view: UpdateView, percent: number): UpdateView {
  if (view.status !== "downloading") return view;
  return { ...view, percent: clampPercent(percent) };
}

export function onDownloaded(view: UpdateView, version: string): UpdateView {
  return { ...view, status: "downloaded", available: version, downloaded: version, percent: 100, error: null, downloads: view.downloads + 1 };
}

/** Back to Download (the version is still out) with the reason; with no version known, to current. */
export function onDownloadFailed(view: UpdateView, message: string): UpdateView {
  return { ...view, status: view.available !== null ? "available" : "current", percent: null, error: { during: "download", message } };
}

export function onInstallStart(view: UpdateView): UpdateView {
  return { ...view, status: "installing", error: null, stillPreparing: false };
}

/** The confirmed Restart is still under way after installWaitMs: still installing, said honestly. */
export function onInstallSlow(view: UpdateView): UpdateView {
  if (view.status !== "installing") return view;
  return { ...view, stillPreparing: true };
}

/** The install attempt ended without a restart: still downloaded, so Restart can be tried again. */
export function onInstallFailed(view: UpdateView, message: string): UpdateView {
  return { ...view, status: "downloaded", error: { during: "install", message }, stillPreparing: false };
}

/** This run does not update itself after all (its own signature check failed): off, with nothing found or kept. */
export function onUpdatesOff(view: UpdateView, reason: UpdatesOffReason): UpdateView {
  return { ...view, status: "off", off: reason, available: null, downloaded: null, percent: null, checking: false, error: null, stillPreparing: false };
}

export function onAutomatic(view: UpdateView, automatic: boolean): UpdateView {
  return { ...view, automatic };
}

function clampPercent(percent: number): number {
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
}

// --- The sidebar pill (T3's SidebarUpdatePill: Download, a progress ring, Restart) ---

export type UpdatePillAction = "download" | "install" | "none";

export interface UpdatePill {
  /** download: its click downloads; install: its click asks to restart; none: nothing to click (downloading, restarting). */
  readonly action: UpdatePillAction;
  /** The icon: a download arrow, the progress ring, or a restart arrow. */
  readonly icon: "download" | "progress" | "restart";
  /** The pill's word or percentage. */
  readonly label: string;
  /** Its tooltip and accessible name. */
  readonly title: string;
  readonly percent: number | null;
  readonly busy: boolean;
}

/** The pill for this state, or null (no newer version known, a check under way or failed, updates off: no pill). */
export function updatePill(view: UpdateView): UpdatePill | null {
  const version = view.downloaded ?? view.available;
  switch (view.status) {
    case "available": {
      const failed = view.error?.during === "download" ? `The download failed: ${view.error.message}. Click to try again.` : null;
      return { action: "download", icon: "download", label: "Download", title: failed ?? `Adari ${version} is available. Click to download it.`, percent: null, busy: false };
    }
    case "downloading": {
      const percent = Math.floor(view.percent ?? 0);
      return { action: "none", icon: "progress", label: `${percent}%`, title: `Downloading Adari ${version} (${percent}%)`, percent, busy: true };
    }
    case "downloaded": {
      const failed = view.error?.during === "install" ? `Installing ${version} failed: ${view.error.message}. Click to try again.` : null;
      return { action: "install", icon: "restart", label: "Restart", title: failed ?? `Adari ${version} is downloaded. Click to restart and install it.`, percent: 100, busy: false };
    }
    case "installing":
      return { action: "none", icon: "restart", label: "Restarting…", title: view.stillPreparing ? stillPreparingLine(version) : `Installing Adari ${version} and restarting`, percent: 100, busy: true };
    default:
      return null;
  }
}

/** A confirmed Restart that is taking long: said as it is, with nothing to click until it ends. */
function stillPreparingLine(version: string | null): string {
  return `Still preparing Adari ${version}. Adari restarts when it is ready.`;
}

// --- The toast and the Restart question ---

/** Shown once when a download finishes (T3's desktopUpdate.toast.tsx, in Adari's name). */
export const updateDownloadedToast = "Update downloaded. Restart Adari from the update button to install it.";

/**
 * The question Restart asks first (T3's getDesktopUpdateInstallConfirmationMessage). Its second line is ours and true:
 * quitting Adari only lets go of its connections; the agents run in Herdr on each machine and are there when Adari
 * connects again.
 */
export function installQuestion(version: string | null): { readonly message: string; readonly detail: string; readonly buttons: readonly [string, string] } {
  return {
    message: `Install update${version === null ? "" : ` ${version}`} and restart Adari?`,
    detail: "Your agents keep running in Herdr on each machine. Adari connects to them again when it opens.",
    buttons: ["Restart", "Cancel"],
  };
}

// --- A check asked for by hand (the menu's and Settings' Check for Updates…) ---

export type ManualCheck =
  | { readonly kind: "off" }
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "downloading"; readonly version: string }
  | { readonly kind: "downloaded"; readonly version: string }
  | { readonly kind: "failed"; readonly message: string };

/** The outcome in words: the menu's dialog says it, and Settings shows it under the button. */
export function describeManualCheck(check: ManualCheck): string {
  switch (check.kind) {
    case "off":
      return offLine;
    case "current":
      return `Adari ${check.version} is the latest version.`;
    case "available":
      return `Adari ${check.version} is available.`;
    case "downloading":
      return `Adari ${check.version} is downloading.`;
    case "downloaded":
      return `Adari ${check.version} is downloaded. Restart Adari from the update button to install it.`;
    case "failed":
      return `Could not check for updates: ${check.message}`;
  }
}

// --- Settings › Updates ---

/** What an off build says (Settings, and the menu's item greyed): the signed download is the one that updates. */
export const offLine = "Updates come with the signed download.";

/** Why this build is off, under it. */
export function offReasonText(reason: UpdatesOffReason): string {
  switch (reason) {
    case "unsigned":
      return "This build is not signed with a Developer ID, so it does not check for updates or install them. The signed download from GitHub Releases updates itself.";
    case "development":
      return "A development run never checks for updates.";
    case "demo":
      return "The demo and the captures never check for updates.";
    case "flags":
      return "Adari was opened with a demo, capture or probe flag, so it does not check for updates until it is opened without one.";
    case "platform":
      return "Updates come with the signed Mac download; this build does not update itself.";
  }
}

/** The state in one line, beside the actions. */
export function updateStatusLine(view: UpdateView): string {
  const version = view.downloaded ?? view.available;
  switch (view.status) {
    case "off":
      return offLine;
    case "idle":
      return view.checking ? "Checking…" : "Not checked yet.";
    case "current":
      return view.checking ? "Checking…" : `Adari ${view.current} is the latest version.`;
    case "available":
      return view.error?.during === "download" ? `Adari ${version} is available. The download failed: ${view.error.message}` : `Adari ${version} is available.`;
    case "downloading":
      return `Downloading Adari ${version}… ${Math.floor(view.percent ?? 0)}%`;
    case "downloaded":
      return view.error?.during === "install"
        ? `Adari ${version} is downloaded. Installing it failed: ${view.error.message}`
        : `Adari ${version} is downloaded. Restart Adari to install it.`;
    case "installing":
      return view.stillPreparing ? stillPreparingLine(version) : `Installing Adari ${version}…`;
  }
}

/** "today at 14:02", "Nov 8 at 09:15" (the time in the Mac's own format). */
export type TimeWords = (at: number, now: number) => string;

export const localTimeWords: TimeWords = (at, now) => {
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (new Date(now).toDateString() === when.toDateString()) return `today at ${time}`;
  return `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
};

/** The last check's line: when, and its failure in short words (Settings only; a failed automatic check is quiet elsewhere). */
export function lastCheckLine(view: UpdateView, now: number, words: TimeWords = localTimeWords): string {
  if (view.lastCheck === null) return view.automatic ? "Not checked yet. The first check is about 15 seconds after Adari opens." : "Not checked yet.";
  const when = words(view.lastCheck.at, now);
  if (view.lastCheck.outcome === "failed") return `Last check ${when} failed.${view.error?.during === "check" ? ` ${view.error.message}` : ""}`;
  return `Last checked ${when}.`;
}

export const automaticLabel = "Check for updates automatically";

/** The setting's line under its switch. */
export function automaticFoot(automatic: boolean): string {
  return automatic
    ? "About 15 seconds after Adari opens, then every 4 minutes. Nothing downloads or installs until you click."
    : "Adari checks only when you ask (Check for Updates…).";
}

// --- What failed, in short words ---

/** A failure from the updater as Settings and the menu say it (`feed`: "GitHub", or the test feed's host). */
export function updateFailureText(error: unknown, feed: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";
  const status = typeof error === "object" && error !== null ? (error as { statusCode?: unknown }).statusCode : undefined;
  if (status === 404 || /No published versions|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_NO_PUBLISHED_VERSIONS/u.test(`${code} ${raw}`) || /^HttpError: 404\b/u.test(raw)) {
    return `No release is published on ${feed} yet.`;
  }
  if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/u.test(`${code} ${raw}`)) return "The latest release has no update files (latest-mac.yml).";
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/u.test(`${code} ${raw}`)) {
    return `Could not reach ${feed}.`;
  }
  const first = raw.split("\n")[0]!.trim();
  const text = first === "" ? "Unknown error" : first;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
