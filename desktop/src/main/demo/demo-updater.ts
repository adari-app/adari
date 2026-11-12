// A fake electron-updater for the update captures (134-140) and the tests.
// No network and no electron-updater: a check finds the version it was given,
// a download stops at `holdAt` percent until finish(), and quitAndInstall
// only counts (a capture never quits). Development builds only (dev-modes.ts).

import { EventEmitter } from "node:events";

import { memoryUpdatePrefs, UpdateController, type Updater, type UpdaterLogger, type UpdateSettings } from "../updates";

export class DemoUpdater extends EventEmitter implements Updater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  fullChangelog = true;
  logger: UpdaterLogger | null = null;
  readonly feeds: unknown[] = [];
  checks = 0;
  downloads = 0;
  installs = 0;
  private finishDownload: (() => void) | null = null;

  constructor(
    private readonly newer: string,
    private readonly holdAt = 42,
  ) {
    super();
  }

  setFeedURL(options: { readonly provider: string }): void {
    this.feeds.push(options);
  }

  checkForUpdates(): Promise<{ readonly isUpdateAvailable: boolean; readonly updateInfo: { readonly version: string } }> {
    this.checks += 1;
    return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: this.newer } });
  }

  /** Starts, reports `holdAt` percent, and waits for finish(). */
  downloadUpdate(): Promise<unknown> {
    this.downloads += 1;
    return new Promise((resolve) => {
      this.finishDownload = () => resolve([]);
      setTimeout(() => this.emit("download-progress", { percent: this.holdAt }), 0);
    });
  }

  /** The download done. */
  finish(): void {
    this.emit("download-progress", { percent: 100 });
    this.finishDownload?.();
    this.finishDownload = null;
  }

  quitAndInstall(): void {
    this.installs += 1;
  }
}

/** The feed a demo controller names (never asked: its updater is the fake above). */
export const demoUpdateSettings: UpdateSettings = {
  enabled: true,
  off: null,
  feed: { provider: "generic", url: "https://updates.demo.invalid/adari" },
  feedName: "the demo feed",
  feedUrl: "https://updates.demo.invalid/adari",
};

/** An update controller on the fake: Restart's question answers Restart (`confirm`), with no dialog. */
export function demoUpdateController(version: string, newer = "0.1.1", confirm = true): { controller: UpdateController; updater: DemoUpdater } {
  const updater = new DemoUpdater(newer);
  const controller = new UpdateController({
    settings: demoUpdateSettings,
    version,
    prefs: memoryUpdatePrefs(),
    confirmInstall: () => Promise.resolve(confirm),
    // The fake has no signature to check (development builds only; nothing is loaded or asked).
    verifySignature: () => Promise.resolve(null),
    load: () => Promise.resolve(updater),
    log: (line) => console.log(`updates (demo): ${line}`),
  });
  return { controller, updater };
}
