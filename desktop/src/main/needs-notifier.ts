// The rules for reaching you while you are in another app, in the main process
// (so they keep working with the window closed). The page sends the sidebar's
// own Needs you rows on every change (src/shared/needs-notify.ts
// needsYouReport); this decides, after T3 Code's ThreadNotificationCoordinator
// (apps/web/src/components/ThreadNotificationCoordinator.tsx and .logic.ts:
// transitions only, a reconnect quiet, nothing while the window has focus,
// shown notifications closed when it gets it) and its Dock badge
// (apps/desktop/src/ipc/methods/notificationBadge.ts, cleared on quit):
//
// - one notification each time an agent starts needing you, closed when it
//   stops; it notifies again if it starts again. Who started or stopped is
//   judged on the report's full list of who is waiting (`waiting`), never on
//   the rows it carries for showing (the first 100): an agent sliding into
//   those rows or out of them is not a start or a stop. When that list is cut
//   off itself, nothing past it is announced and nothing announced is repeated;
// - a wait belongs to its machine's connection (the epoch): when the machine
//   stops answering, comes back on another connection or is removed, the
//   notifications shown for it close, and a click on one of them, or on a
//   menu item made for it, opens the agent only if that same wait is still
//   there (else it just brings the window forward, on nothing);
// - quiet for an agent already waiting when its machine is first seen (the
//   app opening, a machine added) or seen again on a new connection (a
//   reconnect), so nothing bursts in; it still counts;
// - quiet while Adari's window is the focused window (the sidebar shows it);
// - "Notify when an agent needs you" off: none; "Play a sound" off: silent;
// - the Dock badge: how many agents need you across machines, whether the
//   window has focus or not, none at zero (T3's badge counts unread ones and
//   clears on focus; this one is the number waiting);
// - the menu bar item while "Show Adari in the menu bar" is on, gone at once when it is turned off;
// - what became of the last notification (shown, or failed: on the Mac, macOS did not show it, as when Adari is
//   switched off in System Settings › Notifications), kept in memory only for Settings › Notifications; a later one
//   that shows clears a failure. Nothing is retried and nothing else about when or what Adari notifies depends on it
//   (the Dock badge and the menu bar item do not need the permission).
//
// The Electron parts (Notification, app.dock, Tray, the window) are behind
// NotifyPort, so the rules are tested with a fake one (as updates.ts takes its
// timers and updater); src/main/needs-notify-electron.ts is the real one.

import { readFileSync, renameSync, writeFileSync } from "node:fs";

import {
  decodeNotifySettings,
  defaultNotifySettings,
  emptyNeedsYouReport,
  entryKey,
  identityKey,
  menuBarView,
  needsNotification,
  sameReport,
  testNotification,
  testSentText,
  testUnsupportedText,
  notifyTexts,
  type MenuBarView,
  type NeedsYouReport,
  type NotificationContent,
  type NotifyDelivery,
  type NotifyOutcome,
  type NotifySettings,
} from "../shared/needs-notify";

/** How long Send a test notification waits for the system's answer before it says "Sent." as it always did. */
export const testAnswerWaitMs = 5_000;

/** A notification on screen (or in Notification Center): closed when its agent stops needing you. */
export interface ShownNotification {
  close(): void;
}

/** What a click in the menu bar item's menu asks for. */
export type MenuBarPick =
  | { readonly kind: "agent"; readonly hostId: string; readonly paneId: string }
  | { readonly kind: "open" }
  | { readonly kind: "settings" }
  | { readonly kind: "quit" };

/** The Electron parts, as the rules use them (needs-notify-electron.ts; a fake in the tests and capture runs). */
export interface NotifyPort {
  /** Whether this system shows notifications (Electron's Notification.isSupported()). */
  canNotify(): boolean;
  /**
   * Shows one; `onClick` when it is clicked; `onOutcome` once, with the system's answer (on the Mac: shown, or failed
   * when macOS refused it; "unknown" where the system does not say). The error's own words go to the log, not here.
   */
  notify(content: NotificationContent, onClick: () => void, onOutcome: (outcome: NotifyOutcome) => void): ShownNotification;
  /** The Dock icon's badge (0: none). A no-op where there is no Dock. */
  setBadge(count: number): void;
  /** The menu bar item as `view` says (null: none); `onPick` for its menu's clicks. A no-op where there is none. */
  setMenuBar(view: MenuBarView | null, onPick: (pick: MenuBarPick) => void): void;
  /** Adari's window is the focused window now. */
  windowFocused(): boolean;
  /** The window back in front (shown, un-minimized), on that agent when one is given. */
  reveal(target: { readonly hostId: string; readonly paneId: string } | null): void;
  /** The window in front with Settings open. */
  openSettings(): void;
  /** macOS's System Settings › Notifications (macNotificationSettingsUrl, the one fixed address). A no-op off the Mac. */
  openSystemSettings(): void;
  /** Quit Adari. */
  quit(): void;
}

/** Where the switches are kept. */
export interface NotifySettingsStore {
  load(): NotifySettings;
  save(settings: NotifySettings): void;
}

export function memoryNotifySettings(initial: NotifySettings = defaultNotifySettings): NotifySettingsStore {
  let kept = initial;
  return {
    load: () => kept,
    save: (settings) => {
      kept = settings;
    },
  };
}

/** `{"notify": …, "sound": …, "menuBar": …}` in `file` (userData/notify-settings.json, beside update-settings.json); missing or unreadable: all on. */
export function fileNotifySettings(file: string, log: (line: string) => void = () => undefined): NotifySettingsStore {
  let kept: unknown = null;
  try {
    kept = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // None yet, or not readable: the defaults.
  }
  return {
    load: () => decodeNotifySettings(kept),
    save: (settings) => {
      kept = settings;
      try {
        writeFileSync(`${file}.tmp`, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
      } catch (error) {
        log(`could not keep the notification settings: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * One agent's time needing you, on one connection of its machine (`epoch`; null while the machine is not answering).
 * A new record each time it starts needing you or its machine comes back on another connection; the same object for
 * as long as neither happens, so a notification or a menu item made for it can tell whether it is still that wait.
 */
interface Wait {
  readonly id: number;
  readonly hostId: string;
  readonly paneId: string;
  readonly epoch: string | null;
}

export class NeedsNotifier {
  private report: NeedsYouReport = emptyNeedsYouReport;
  /** Each live machine's epoch in the last report. */
  private machines = new Map<string, string>();
  /** The waits known from the last report, by agent (identityKey). */
  private known = new Map<string, Wait>();
  /** The last report's list of who is waiting was cut off (more waiting than it names). */
  private cut = false;
  private waits = 0;
  /** The notifications shown, by agent, each with the wait it was shown for, until that wait ends. */
  private readonly shown = new Map<string, { readonly wait: Wait; readonly notification: ShownNotification }>();
  /** The last test notification, held so its click still comes (one no one holds may be collected). */
  private tested: ShownNotification | null = null;
  private current: NotifySettings;
  private menuBar: string | null = null;
  private badge: number | null = null;
  private stopped = false;
  private reports = 0;
  /** What became of the last notification the system answered for (null: none yet, or none that says). */
  private delivered: NotifyDelivery | null = null;

  constructor(
    private readonly port: NotifyPort,
    private readonly store: NotifySettingsStore = memoryNotifySettings(),
    private readonly now: () => number = Date.now,
  ) {
    this.current = store.load();
  }

  /** The switches now. */
  settings(): NotifySettings {
    return this.current;
  }

  /** Changes one or more switches; kept, and applied at once (the menu bar item comes or goes). */
  setSettings(change: Partial<NotifySettings>): NotifySettings {
    this.current = { ...this.current, ...change };
    this.store.save(this.current);
    this.applyMenuBar();
    return this.current;
  }

  /** The menu bar item and badge as the switches say, before any report (an empty list). */
  start(): void {
    this.applyBadge();
    this.applyMenuBar();
  }

  /** The page's report: who started needing you, who stopped, the count. */
  update(next: NeedsYouReport): void {
    if (this.stopped) return;
    this.reports += 1;
    const unchanged = sameReport(this.report, next);
    this.report = next;
    if (unchanged) return;
    const machines = new Map(next.live.map((machine) => [machine.hostId, machine.epoch]));
    const cut = next.total > next.waiting.length;
    const known = new Map<string, Wait>();
    const started: Wait[] = [];
    for (const [hostId, paneId] of next.waiting) {
      const key = identityKey(hostId, paneId);
      const epoch = machines.get(hostId) ?? null;
      const before = this.known.get(key);
      // Still the same wait: it was waiting, on the same connection (or still on none).
      if (before !== undefined && before.epoch === epoch) {
        known.set(key, before);
        continue;
      }
      this.waits += 1;
      const wait: Wait = { id: this.waits, hostId, paneId, epoch };
      known.set(key, wait);
      // A start: on a machine seen on this same connection last time, absent from a list that named everyone.
      if (before === undefined && epoch !== null && this.machines.get(hostId) === epoch && !this.cut) started.push(wait);
    }
    // A cut-off list does not say who stopped: a wait past it stays known while its connection lasts (no close, no repeat).
    if (cut) {
      for (const [key, wait] of this.known) {
        if (!known.has(key) && wait.epoch !== null && machines.get(wait.hostId) === wait.epoch) known.set(key, wait);
      }
    }
    this.known = known;
    this.machines = machines;
    this.cut = cut;
    // A wait that ended (stopped needing you, its machine not answering, on another connection, removed): its notification closes.
    for (const [key, shown] of this.shown) {
      if (known.get(key) === shown.wait) continue;
      shown.notification.close();
      this.shown.delete(key);
    }
    const quiet = !this.current.notify || this.port.windowFocused() || !this.port.canNotify();
    if (!quiet && started.length > 0) {
      const rows = new Map(next.rows.map((row) => [identityKey(row.hostId, row.paneId), row]));
      for (const wait of started) {
        const key = identityKey(wait.hostId, wait.paneId);
        // Past the rows sent for showing there are no words to show: quiet (it counts; the sidebar lists it).
        const row = rows.get(key);
        if (row === undefined) continue;
        const notification = this.port.notify(
          needsNotification(row, this.current.sound),
          () => {
            if (this.shown.get(key)?.wait === wait) this.shown.delete(key);
            this.open(wait);
          },
          (outcome) => this.answered(outcome),
        );
        this.shown.set(key, { wait, notification });
      }
    }
    this.applyBadge();
    this.applyMenuBar();
  }

  /** The window got focus: the notifications shown close (the sidebar has them), as T3 clears its own. */
  focused(): void {
    this.closeShown();
  }

  /**
   * Settings' Send a test notification (it also has macOS ask for permission the first time); what to say, once the
   * system answered: "Sent." as before, or, when macOS did not show it, the line that it is off (after
   * testAnswerWaitMs with no answer: "Sent."). One notification, never sent again.
   */
  test(): Promise<string> {
    if (!this.port.canNotify()) return Promise.resolve(testUnsupportedText);
    return new Promise((resolve) => {
      let said = false;
      const say = (text: string): void => {
        if (said) return;
        said = true;
        clearTimeout(timer);
        resolve(text);
      };
      const timer = setTimeout(() => say(testSentText), testAnswerWaitMs);
      this.tested = this.port.notify(
        testNotification(this.current.sound),
        () => this.port.reveal(null),
        (outcome) => {
          this.answered(outcome);
          say(outcome === "failed" ? notifyTexts.offLine : testSentText);
        },
      );
    });
  }

  /** What became of the last notification (Settings › Notifications reads it): shown or failed, and when; null: nothing known. */
  delivery(): NotifyDelivery | null {
    return this.delivered;
  }

  /** Settings' Open Notification Settings: macOS's own pane (the port opens the one fixed address). */
  openSystemSettings(): void {
    this.port.openSystemSettings();
  }

  /** Quitting: every notification closed, the badge and the menu bar item gone, no more reports taken. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.closeShown();
    this.tested?.close();
    this.tested = null;
    this.port.setBadge(0);
    this.badge = 0;
    if (this.menuBar !== null) this.port.setMenuBar(null, () => undefined);
    this.menuBar = null;
  }

  /** The last report and how many came (the capture's proof that the list keeps coming with the window away). */
  seen(): { readonly report: NeedsYouReport; readonly reports: number; readonly shown: readonly string[] } {
    return { report: this.report, reports: this.reports, shown: [...this.shown.values()].map((shown) => entryKey(shown.wait)) };
  }

  /** The system's answer for one notification: the last one known ("unknown" changes nothing). */
  private answered(outcome: NotifyOutcome): void {
    if (outcome === "unknown") return;
    this.delivered = { outcome, at: this.now() };
  }

  /** A click made for `wait`: that agent, if it is still that same wait; else just the window, on nothing. */
  private open(wait: Wait | undefined): void {
    const still = wait !== undefined && this.known.get(identityKey(wait.hostId, wait.paneId)) === wait;
    this.port.reveal(still ? { hostId: wait.hostId, paneId: wait.paneId } : null);
  }

  private closeShown(): void {
    for (const shown of this.shown.values()) shown.notification.close();
    this.shown.clear();
  }

  private applyBadge(): void {
    if (this.badge === this.report.total) return;
    this.badge = this.report.total;
    this.port.setBadge(this.report.total);
  }

  private applyMenuBar(): void {
    if (this.stopped) return;
    if (!this.current.menuBar) {
      if (this.menuBar !== null) this.port.setMenuBar(null, () => undefined);
      this.menuBar = null;
      return;
    }
    const view = menuBarView(this.report);
    // Each agent item is made for the wait known now; a click checks it is still that wait.
    const made = new Map<string, Wait>();
    for (const item of view.items) {
      if (item.kind !== "agent") continue;
      const key = identityKey(item.hostId, item.paneId);
      const wait = this.known.get(key);
      if (wait !== undefined) made.set(key, wait);
    }
    const shape = JSON.stringify({ view, waits: [...made.values()].map((wait) => wait.id) });
    if (shape === this.menuBar) return;
    this.menuBar = shape;
    this.port.setMenuBar(view, (pick) => this.pick(pick, made));
  }

  private pick(pick: MenuBarPick, made: ReadonlyMap<string, Wait>): void {
    switch (pick.kind) {
      case "agent":
        this.open(made.get(identityKey(pick.hostId, pick.paneId)));
        return;
      case "open":
        this.port.reveal(null);
        return;
      case "settings":
        this.port.openSettings();
        return;
      case "quit":
        this.port.quit();
    }
  }
}

/**
 * A NotifyPort that only records (the tests', and the demo's and capture runs': they never show a real
 * notification, put a mark in the menu bar or touch the Dock). Its window's focus and the system's support are set
 * by hand; each call goes to `log` as a line too.
 */
export class RecordedNotifyPort implements NotifyPort {
  focused = false;
  supported = true;
  /** The system's answer each notification gets at once ("unknown", as a recording says nothing); null: held until `answer` is called. */
  outcome: NotifyOutcome | null = "unknown";
  readonly notifications: { content: NotificationContent; closed: boolean; click: () => void; answer: (outcome: NotifyOutcome) => void }[] = [];
  readonly badges: number[] = [];
  menuBar: MenuBarView | null = null;
  menuBarSets = 0;
  /** Each menu set's click handler, oldest first (a menu still open after a newer one was set calls its own). */
  readonly menuPickers: ((pick: MenuBarPick) => void)[] = [];
  readonly reveals: ({ readonly hostId: string; readonly paneId: string } | null)[] = [];
  settingsOpened = 0;
  systemSettingsOpened = 0;
  quits = 0;

  constructor(private readonly log: (line: string) => void = () => undefined) {}

  canNotify(): boolean {
    return this.supported;
  }

  notify(content: NotificationContent, onClick: () => void, onOutcome: (outcome: NotifyOutcome) => void): ShownNotification {
    let answered = false;
    const answer = (outcome: NotifyOutcome): void => {
      if (answered) return;
      answered = true;
      onOutcome(outcome);
    };
    const record = { content, closed: false, click: onClick, answer };
    this.notifications.push(record);
    this.log(`notification (recorded, not shown): ${JSON.stringify(content)}`);
    if (this.outcome !== null) answer(this.outcome);
    return {
      close: () => {
        record.closed = true;
        this.log(`notification closed (recorded): ${content.title}`);
      },
    };
  }

  setBadge(count: number): void {
    this.badges.push(count);
    this.log(`dock badge (recorded, not set): ${count}`);
  }

  setMenuBar(view: MenuBarView | null, onPick: (pick: MenuBarPick) => void): void {
    this.menuBar = view;
    this.menuBarSets += 1;
    this.menuPickers.push(onPick);
    this.log(`menu bar (recorded, not shown): ${view === null ? "none" : JSON.stringify(view)}`);
  }

  /** A click in the latest menu (as its item would call it). */
  pick(pick: MenuBarPick): void {
    this.menuPickers.at(-1)?.(pick);
  }

  windowFocused(): boolean {
    return this.focused;
  }

  reveal(target: { readonly hostId: string; readonly paneId: string } | null): void {
    this.reveals.push(target);
  }

  openSettings(): void {
    this.settingsOpened += 1;
  }

  openSystemSettings(): void {
    this.systemSettingsOpened += 1;
    this.log("system notification settings (recorded, not opened)");
  }

  quit(): void {
    this.quits += 1;
  }

  /** The notifications still open. */
  open(): NotificationContent[] {
    return this.notifications.filter((record) => !record.closed).map((record) => record.content);
  }
}
