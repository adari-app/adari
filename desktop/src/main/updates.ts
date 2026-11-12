// The Mac app updates itself the T3 Code way.
//
// - The feed is GitHub Releases of adari-app/adari through electron-updater's
//   github provider, stable releases only (UPDATE_GITHUB_FEED; the same object
//   is electron-builder.config.cjs's `publish`, and test/updates.test.ts checks
//   they are equal). HERDR_COMPANION_UPDATE_FEED, an https URL, swaps it for a
//   generic feed (a test server, or a later mock), as T3 does for its mock
//   server (DesktopUpdates.ts:1135-1146), in tests and development only: a
//   signed release always checks GitHub.
// - On only where it can work: Squirrel.Mac installs only signed updates, so
//   only a packaged Mac build that scripts/build.mjs made to be signed with a
//   Developer ID Application certificate (main.ts reads its team from
//   __ADARI_UPDATE_TEAM__) checks, and only once the app has checked its own
//   signature against that team (checkOwnSignature).
//   Unsigned packages, development runs, tests, the demo, the
//   captures and any launch with a demo, capture or probe flag never load
//   electron-updater and never touch the network.
// - When: about 15 s after the app opens, then every 4 minutes (T3's
//   DesktopUpdates.ts:58-59, 887-905), while "Check for updates automatically"
//   is on; off, no automatic check at all (Check for Updates… still works).
// - Nothing downloads or installs until the user clicks: autoDownload and
//   autoInstallOnAppQuit off (T3's DesktopUpdates.ts:1161-1162), Download and
//   Restart are the user's clicks, and Restart asks first (confirmInstall).
// - A failed automatic check is a log line and Settings' last-check line,
//   never a dialog or the pill. Check for Updates… says what happened.
// - What a check sends: electron-updater's GET requests to the feed, with the
//   all-zero staging id below in place of its per-install one (configureUpdater).
//
// The state and its steps are src/shared/updates.ts (after T3's updateMachine.ts).

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  initialUpdateView,
  installQuestion,
  onAutomatic,
  onAvailable,
  onCheckFailed,
  onCheckStart,
  onDownloaded,
  onDownloadFailed,
  onDownloadProgress,
  onDownloadStart,
  onInstallFailed,
  onInstallSlow,
  onInstallStart,
  onNotAvailable,
  onUpdatesOff,
  updateFailureText,
  type ManualCheck,
  type UpdatesOffReason,
  type UpdateView,
} from "../shared/updates";

/** The update feed: GitHub Releases of adari-app/adari, stable releases only. electron-builder.config.cjs publishes the same. */
export const UPDATE_GITHUB_FEED = { provider: "github", owner: "adari-app", repo: "adari", releaseType: "release" } as const;

/** Where a person sees the same releases. */
export const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_GITHUB_FEED.owner}/${UPDATE_GITHUB_FEED.repo}/releases`;

export type UpdateFeed = typeof UPDATE_GITHUB_FEED | { readonly provider: "generic"; readonly url: string };

/** T3's AUTO_UPDATE_STARTUP_DELAY and AUTO_UPDATE_POLL_INTERVAL (DesktopUpdates.ts:58-59). */
export const firstCheckDelayMs = 15_000;
export const checkIntervalMs = 4 * 60_000;
/**
 * After Restart, the app quits into the new version once Squirrel.Mac has it ready. Still here after this long, Adari
 * says it is still preparing the update; only an error from the updater ends the attempt.
 */
export const installWaitMs = 90_000;

/**
 * electron-updater 6.8.9 makes a random id, keeps it in the app's data folder (`.updaterId`) and sends it with every
 * check as `x-user-staging-id` (AppUpdater.js:189, 386-387, 501-525), for staged rollouts. Adari has none: every copy
 * sends this same all-zero id, and the file is never made.
 */
export const anonymousStagingId = "00000000-0000-0000-0000-000000000000";

/** How the app was built and launched. */
export interface UpdateBuild {
  readonly platform: NodeJS.Platform;
  /** Electron's app.isPackaged. */
  readonly packaged: boolean;
  /**
   * scripts/build.mjs made a release build to be signed with a Developer ID Application certificate
   * (__ADARI_UPDATE_TEAM__ is its team). The app still checks its own signature before it loads electron-updater.
   */
  readonly signed: boolean;
  /** A demo, capture, probe or showcase run. */
  readonly demo: boolean;
  /** Opened with a demo, capture or probe flag (launch-options.ts hasInstrumentFlag), even where the app ignores it. */
  readonly flags?: boolean;
}

export interface UpdateSettings {
  readonly enabled: boolean;
  /** Why not (null when enabled). */
  readonly off: UpdatesOffReason | null;
  readonly feed: UpdateFeed;
  /** The feed in words, for failures: "GitHub", or the test feed's host. */
  readonly feedName: string;
  /** Where it checks (AppInfo.updates.feedUrl). */
  readonly feedUrl: string;
}

/**
 * Updates run only in a signed, packaged Mac build outside the demo, opened without a demo, capture or probe flag. A
 * feed override must be https, and a signed release ignores it: its feed is GitHub, stable releases only.
 */
export function updateSettings(env: Readonly<Record<string, string | undefined>>, build: UpdateBuild): UpdateSettings {
  const off: UpdatesOffReason | null = build.demo
    ? "demo"
    : build.flags === true
      ? "flags"
      : !build.packaged
        ? "development"
        : build.platform !== "darwin"
          ? "platform"
          : !build.signed
            ? "unsigned"
            : null;
  const override = build.signed ? undefined : env["HERDR_COMPANION_UPDATE_FEED"]?.trim();
  const url = override !== undefined && /^https:\/\/[^\s]+$/u.test(override) ? safeUrl(override) : null;
  if (url !== null) return { enabled: off === null, off, feed: { provider: "generic", url: url.href }, feedName: url.host, feedUrl: url.href };
  return { enabled: off === null, off, feed: UPDATE_GITHUB_FEED, feedName: "GitHub", feedUrl: UPDATE_RELEASES_URL };
}

function safeUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

// --- The app's own signature ---

/** The .app bundle around a Mac app's executable (…/Adari.app/Contents/MacOS/Adari). */
export function appBundleOf(execPath: string): string {
  return path.resolve(execPath, "..", "..", "..");
}

/**
 * A Developer ID Application signature by `team`: Apple's anchor, the Developer ID intermediate
 * (1.2.840.113635.100.6.2.6), a Developer ID Application leaf (1.2.840.113635.100.6.1.13) and its team. The same
 * clauses as the designated requirement codesign gives a Developer ID app; ad-hoc, unsigned, Apple's own and other
 * teams' signatures do not meet it.
 */
export function developerIdRequirement(team: string): string {
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${team}"`;
}

/** Runs a program; its exit code (-1: it did not run) and what it wrote to stderr. */
export type RunFile = (file: string, args: readonly string[]) => Promise<{ readonly code: number; readonly stderr: string }>;

const runFile: RunFile = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: 60_000, encoding: "utf8" }, (error, _stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : -1;
      resolve({ code, stderr: String(stderr ?? "") || (error?.message ?? "") });
    });
  });

/**
 * The app checks its own signature before it ever loads electron-updater: `codesign --verify` of the running bundle
 * against developerIdRequirement(team), the team scripts/build.mjs baked in. null: signed with a Developer ID of that
 * team; otherwise why not (no network; codesign reads the bundle on disk). Not --strict: a genuine Developer ID app
 * can fail it over a stray extended attribute, and the question here is only whose signature it is.
 */
export async function checkOwnSignature(appPath: string, team: string, run: RunFile = runFile): Promise<string | null> {
  if (!/^[A-Z0-9]{10}$/u.test(team)) return "this build has no Developer ID team";
  if (!appPath.endsWith(".app")) return `${appPath} is not an app bundle`;
  const { code, stderr } = await run("/usr/bin/codesign", ["--verify", "--test-requirement", `=${developerIdRequirement(team)}`, appPath]);
  if (code === 0) return null;
  const first = stderr.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? `exit ${code}`;
  return `the app is not signed with a Developer ID of team ${team} (codesign: ${first})`;
}

// --- electron-updater, as much of it as Adari uses ---

export interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
}

/** The part of electron-updater's AppUpdater Adari uses (its autoUpdater fits it; tests give a fake). */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  fullChangelog: boolean;
  logger: UpdaterLogger | null;
  setFeedURL(options: { readonly provider: string; readonly [key: string]: unknown }): void;
  checkForUpdates(): Promise<{ readonly isUpdateAvailable?: boolean; readonly updateInfo: { readonly version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "download-progress", listener: (progress: { readonly percent: number }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** What Settings says when electron-updater's updater cannot be had: a sentence, never a JavaScript error. */
export const updaterLoadFailure = "Adari could not load its updater.";

function field(holder: unknown, key: string): unknown {
  return holder !== null && (typeof holder === "object" || typeof holder === "function") ? (holder as Record<string, unknown>)[key] : undefined;
}

function isUpdater(value: unknown): value is Updater {
  return ["checkForUpdates", "downloadUpdate", "quitAndInstall", "setFeedURL", "on"].every((name) => typeof field(value, name) === "function");
}

/**
 * electron-updater's autoUpdater out of what importing the module gave. The release
 * build leaves electron-updater out of the bundle and keeps its import a real dynamic import; Node's ESM loader names a
 * CommonJS module's exports by reading its source, and electron-updater 6.8.9 defines `autoUpdater` with an
 * arrow-function getter (out/main.js: `get: () => {…}`) that this reading does not find. So the namespace has no
 * autoUpdater and only `default` (module.exports) has it; a bundler's interop (the tests') gives it as a named export.
 * Taken from wherever it is; nowhere, not an updater, or its getter throws: updaterLoadFailure (the detail is logged).
 */
export function updaterFrom(loaded: unknown, log: (line: string) => void = () => undefined): Updater {
  // In this order, each looked at only when the one before has no updater (a strict namespace throws on a missing name).
  const places: readonly (() => unknown)[] = [() => loaded, () => field(loaded, "default"), () => field(loaded, "module.exports")];
  for (const place of places) {
    let holder: unknown;
    try {
      holder = place();
    } catch {
      continue;
    }
    let updater: unknown;
    try {
      updater = field(holder, "autoUpdater");
    } catch (error) {
      log(`could not load the updater: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(updaterLoadFailure);
    }
    if (isUpdater(updater)) return updater;
  }
  log("could not load the updater: electron-updater has no autoUpdater");
  throw new Error(updaterLoadFailure);
}

/** The controller's own load: electron-updater imported only now (the first check that runs), its updater taken by updaterFrom. */
export async function loadElectronUpdater(log: (line: string) => void = () => undefined): Promise<Updater> {
  let loaded: unknown;
  try {
    loaded = await import("electron-updater");
  } catch (error) {
    log(`could not load the updater: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(updaterLoadFailure);
  }
  return updaterFrom(loaded, log);
}

/** Sets an updater up as Adari runs it (also what the fake-feed test runs on electron-updater's own AppUpdater). */
export function configureUpdater(updater: Updater, feed: UpdateFeed, log: (line: string) => void): void {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.fullChangelog = false;
  updater.logger = {
    info: (message) => log(`updater: ${String(message)}`),
    warn: (message) => log(`updater warning: ${String(message)}`),
    error: (message) => log(`updater error: ${String(message)}`),
  };
  // The per-install staging id (anonymousStagingId says why): a protected field of AppUpdater 6.8.9.
  (updater as unknown as { stagingUserIdPromise: { readonly value: Promise<string> } }).stagingUserIdPromise = { value: Promise.resolve(anonymousStagingId) };
  updater.setFeedURL({ ...feed });
}

// --- Settings › Updates' one setting, kept in the app's data folder ---

export interface UpdatePrefs {
  automatic(): boolean;
  setAutomatic(on: boolean): void;
}

/** In memory (demo and capture runs, off builds): on unless set. */
export function memoryUpdatePrefs(automatic = true): UpdatePrefs {
  let on = automatic;
  return {
    automatic: () => on,
    setAutomatic: (value) => {
      on = value;
    },
  };
}

/** `{"automatic": false}` in `file`; missing or unreadable: on (the default). */
export function fileUpdatePrefs(file: string, log: (line: string) => void = () => undefined): UpdatePrefs {
  let on = true;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { automatic?: unknown };
    on = parsed.automatic !== false;
  } catch {
    // None yet, or not readable: the default.
  }
  return {
    automatic: () => on,
    setAutomatic: (value) => {
      on = value;
      try {
        writeFileSync(`${file}.tmp`, `${JSON.stringify({ automatic: value })}\n`, { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
      } catch (error) {
        log(`could not keep the setting: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

// --- The controller ---

export interface UpdateTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const globalTimers: UpdateTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface UpdateControllerDeps {
  readonly settings: UpdateSettings;
  /** The version running now (app.getVersion()). */
  readonly version: string;
  readonly prefs: UpdatePrefs;
  /** Restart's question (main.ts: a dialog over the window); true: Restart, false: Cancel. */
  confirmInstall(question: ReturnType<typeof installQuestion>): Promise<boolean>;
  /**
   * The app's own signature (main.ts: checkOwnSignature on the running bundle): null when it is the Developer ID one
   * this build was made for, else why not. Asked once, before electron-updater is first loaded; anything but null
   * turns this run's updates off.
   */
  verifySignature(): Promise<string | null>;
  /** electron-updater's autoUpdater, loaded on the first check that runs (never while off). */
  readonly load?: () => Promise<Updater>;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly timers?: UpdateTimers;
}

export type InstallAnswer = "installing" | "cancelled" | "not-ready";

export class UpdateController {
  private state: UpdateView;
  private updater: Promise<Updater> | null = null;
  private checkRun: Promise<ManualCheck> | null = null;
  private downloadRun: Promise<boolean> | null = null;
  private asking = false;
  /** The signature check's answer (once per run): true, the Developer ID one; false, updates are off for this run. */
  private signature: Promise<boolean> | null = null;
  private refused = false;
  private readonly handles: { readonly kind: "timeout" | "interval"; readonly handle: unknown }[] = [];
  private installTimer: unknown = null;
  /** A confirmed Restart handed to electron-updater and not ended yet (one native install attempt at a time). */
  private installAttempt: { readonly detach: () => void } | null = null;
  private readonly listeners = new Set<(view: UpdateView) => void>();
  private readonly load: () => Promise<Updater>;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly timers: UpdateTimers;

  constructor(private readonly deps: UpdateControllerDeps) {
    this.load = deps.load ?? (() => loadElectronUpdater(this.log));
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? globalTimers;
    this.state = initialUpdateView(deps.version, deps.settings.off, deps.prefs.automatic());
  }

  get settings(): UpdateSettings {
    return this.deps.settings;
  }

  view(): UpdateView {
    return this.state;
  }

  /** Every change of the state (main.ts sends it to the page). */
  subscribe(listener: (view: UpdateView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The automatic checks: the first after 15 s, then every 4 minutes (each skipped while the setting is off). */
  start(): void {
    if (!this.enabled() || this.handles.length > 0) return;
    // The app's own signature, checked now (no network) so Settings and About say the truth from the start.
    void this.signatureOk();
    this.handles.push({ kind: "timeout", handle: this.timers.setTimeout(() => void this.automaticCheck(), firstCheckDelayMs) });
    this.handles.push({ kind: "interval", handle: this.timers.setInterval(() => void this.automaticCheck(), checkIntervalMs) });
  }

  stop(): void {
    for (const { kind, handle } of this.handles.splice(0)) {
      if (kind === "timeout") this.timers.clearTimeout(handle);
      else this.timers.clearInterval(handle);
    }
    if (this.installTimer !== null) this.timers.clearTimeout(this.installTimer);
    this.installTimer = null;
  }

  /** On in this build, and its own signature has not been refused. */
  private enabled(): boolean {
    return this.deps.settings.enabled && !this.refused;
  }

  setAutomatic(on: boolean): UpdateView {
    this.deps.prefs.setAutomatic(on);
    this.set(onAutomatic(this.state, on));
    return this.state;
  }

  /** Asks the feed for a newer version (never downloads). `automatic` failures are only logged and kept for Settings. */
  check(kind: "automatic" | "manual"): Promise<ManualCheck> {
    if (!this.enabled()) return Promise.resolve({ kind: "off" });
    const version = this.state.downloaded ?? this.state.available ?? this.deps.version;
    if (this.state.status === "downloading") return Promise.resolve({ kind: "downloading", version });
    if (this.state.status === "installing") return Promise.resolve({ kind: "downloaded", version });
    this.checkRun ??= this.runCheck(kind).finally(() => {
      this.checkRun = null;
    });
    return this.checkRun;
  }

  /** Downloads the version the last check found; resolves true once it is downloaded. Only the user's click calls this. */
  download(): Promise<boolean> {
    if (this.downloadRun !== null) return this.downloadRun;
    // A check under way (an automatic one, say) ends first: the download takes what it found.
    if (this.checkRun !== null) return this.checkRun.then(() => this.download());
    if (!this.enabled() || this.state.status !== "available" || this.state.available === null) return Promise.resolve(false);
    const version = this.state.available;
    this.set(onDownloadStart(this.state));
    this.downloadRun = this.runDownload(version).finally(() => {
      this.downloadRun = null;
    });
    return this.downloadRun;
  }

  /**
   * Restart: asks first; Restart quits into the downloaded version, Cancel keeps it for later. One install attempt at
   * a time: while a confirmed Restart is under way, however long Squirrel.Mac takes, nothing hands
   * electron-updater another; Restart is offered again only once that attempt has ended with an error.
   */
  async requestInstall(): Promise<InstallAnswer> {
    const version = this.state.downloaded;
    if (this.installAttempt !== null) return "installing";
    if (!this.enabled() || this.state.status !== "downloaded" || version === null || this.asking) return "not-ready";
    this.asking = true;
    let restart = false;
    try {
      restart = await this.deps.confirmInstall(installQuestion(version));
    } finally {
      this.asking = false;
    }
    if (!restart) return "cancelled";
    if (this.installAttempt !== null) return "installing";
    if (this.state.status !== "downloaded" || this.state.downloaded !== version) return "not-ready";
    const updater = await this.configured();
    if (this.installAttempt !== null) return "installing";
    this.set(onInstallStart(this.state));
    this.log(`installing ${version} and restarting`);
    this.installTimer = this.timers.setTimeout(() => {
      this.installTimer = null;
      // Not a failure: the attempt is still under way. Said as it is; nothing to click until it ends.
      if (this.state.status === "installing") {
        this.set(onInstallSlow(this.state));
        this.log(`still preparing ${version} after ${installWaitMs / 1000} s`);
      }
    }, installWaitMs);
    const attempt = { detach: (): void => undefined };
    this.installAttempt = attempt;
    try {
      const detach = handOver(updater);
      // An error the updater reported during the hand-over has ended this attempt already: let go at once.
      if (this.installAttempt === attempt) this.installAttempt = { detach };
      else detach();
    } catch (error) {
      this.installFailed(updateFailureText(error, this.deps.settings.feedName));
    }
    return "installing";
  }

  private async automaticCheck(): Promise<void> {
    if (!this.enabled() || !this.deps.prefs.automatic()) return;
    if (this.checkRun !== null || this.state.status === "downloading" || this.state.status === "installing") return;
    await this.check("automatic");
  }

  private async runCheck(kind: "automatic" | "manual"): Promise<ManualCheck> {
    this.set(onCheckStart(this.state));
    try {
      const updater = await this.configured();
      const result = await updater.checkForUpdates();
      const at = this.now();
      if (result === null) throw new Error("The updater is not active in this build.");
      const found = result.updateInfo.version;
      if (result.isUpdateAvailable === true && typeof found === "string" && found !== "") this.set(onAvailable(this.state, found, at));
      else this.set(onNotAvailable(this.state, at));
      this.log(`${kind} check: ${this.state.status === "current" ? `nothing newer than ${this.deps.version}` : `${found} ${this.state.status}`}`);
      if (this.state.status === "downloaded") return { kind: "downloaded", version: this.state.downloaded ?? found };
      if (this.state.status === "available") return { kind: "available", version: found };
      return { kind: "current", version: this.deps.version };
    } catch (error) {
      // Its own signature was refused: off for this run, said by the state (not a failed check).
      if (error instanceof UpdatesRefused) return { kind: "off" };
      const message = updateFailureText(error, this.deps.settings.feedName);
      this.set(onCheckFailed(this.state, message, this.now()));
      // The quiet part: an automatic check's failure is this line (and Settings' last-check line), nothing else.
      this.log(`${kind} check failed: ${message}`);
      return { kind: "failed", message };
    }
  }

  private async runDownload(version: string): Promise<boolean> {
    try {
      const updater = await this.configured();
      this.log(`downloading ${version}`);
      await updater.downloadUpdate();
      this.set(onDownloaded(this.state, version));
      this.log(`downloaded ${version}`);
      return true;
    } catch (error) {
      const message = updateFailureText(error, this.deps.settings.feedName);
      this.set(onDownloadFailed(this.state, message));
      this.log(`download of ${version} failed: ${message}`);
      return false;
    }
  }

  /** The install attempt ended without a restart: its native hand-over is let go, and Restart can be tried again. */
  private installFailed(message: string): void {
    if (this.installTimer !== null) this.timers.clearTimeout(this.installTimer);
    this.installTimer = null;
    this.installAttempt?.detach();
    this.installAttempt = null;
    this.set(onInstallFailed(this.state, message));
    this.log(`install failed: ${message}`);
  }

  /** The app's own signature, checked once per run; refused, this run's updates are off (no load, no request). */
  private signatureOk(): Promise<boolean> {
    this.signature ??= this.deps
      .verifySignature()
      .catch((error: unknown) => `the signature check did not run (${error instanceof Error ? error.message : String(error)})`)
      .then((why) => {
        if (why === null) {
          this.log("signature check passed");
          return true;
        }
        this.refused = true;
        for (const { kind, handle } of this.handles.splice(0)) {
          if (kind === "timeout") this.timers.clearTimeout(handle);
          else this.timers.clearInterval(handle);
        }
        this.set(onUpdatesOff(this.state, "unsigned"));
        this.log(`off: ${why}; no update checks in this run`);
        return false;
      });
    return this.signature;
  }

  /** electron-updater, loaded and set up once (a failed load is tried again next time), never before the signature check passed. */
  private configured(): Promise<Updater> {
    if (this.updater === null) {
      const loading = this.signatureOk().then((ok) => {
        if (!ok) throw new UpdatesRefused();
        return this.load();
      }).then((updater) => {
        configureUpdater(updater, this.deps.settings.feed, this.log);
        updater.on("download-progress", (progress) => this.set(onDownloadProgress(this.state, progress.percent)));
        // Checks and downloads fail through their own promises; an error while installing comes only as this event
        // (Squirrel.Mac refusing the update, for one).
        updater.on("error", (error) => {
          if (this.state.status === "installing") this.installFailed(updateFailureText(error, this.deps.settings.feedName));
        });
        return updater;
      });
      loading.catch(() => {
        if (this.updater === loading) this.updater = null;
      });
      this.updater = loading;
    }
    return this.updater;
  }

  private set(next: UpdateView): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

/** This run's own signature was refused: electron-updater is never loaded. */
class UpdatesRefused extends Error {
  constructor() {
    super("updates are off: the app is not signed with the Developer ID this build was made for");
  }
}

/** The part of electron-updater's MacUpdater the hand-over touches: Electron's autoUpdater (Squirrel.Mac). */
interface NativeUpdater {
  listeners(event: "update-downloaded"): ((...args: unknown[]) => void)[];
  removeListener(event: "update-downloaded", listener: (...args: unknown[]) => void): unknown;
}

/**
 * quitAndInstall, and a way to let go of what it armed. electron-updater 6.8.9's MacUpdater.quitAndInstall adds an
 * "update-downloaded" listener to Squirrel.Mac's updater that quits into the update, and never takes it away; after an
 * attempt that ended in an error, a second Restart would add a second one, and one completion would then install twice.
 * The listeners this call added are noted, and detach() removes them.
 */
function handOver(updater: Updater): () => void {
  const native = (updater as unknown as { nativeUpdater?: Partial<NativeUpdater> }).nativeUpdater;
  const watchable = native !== undefined && typeof native.listeners === "function" && typeof native.removeListener === "function";
  const before = watchable ? native.listeners!("update-downloaded") : [];
  updater.quitAndInstall();
  if (!watchable) return () => undefined;
  const added = native.listeners!("update-downloaded").filter((listener) => !before.includes(listener));
  return () => {
    for (const listener of added) native.removeListener!("update-downloaded", listener);
  };
}
