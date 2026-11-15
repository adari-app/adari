// Adari reaching you while you are in another app: a Mac notification when an
// agent starts needing you, the Dock badge and the menu bar item (the main
// process's src/main/needs-notifier.ts applies the rules). This file is the
// part both sides share, pure, so it is tested without a window:
//
// - the report the page sends: the sidebar's own Needs you rows
//   (desktop-sidebar.ts buildDesktopSidebar's needsYou, the list ⇧⌘J walks;
//   never a second rule), with only what a row shows (its name, the pill's
//   words, project, machine and the needs-you line) and its keys, each text
//   clipped, at most maxReportRows rows; and which machines answer now, on
//   which connection (a machine seen for the first time, or again on a new
//   connection, is quiet);
// - the check main makes of it (isNeedsYouReport), as ipc.ts checks every payload;
// - the words: the notification, the menu bar item's menu, Settings › Notifications;
// - the three switches and how they are kept (all on by default).

import { needsPill, needsPillLabel, type NeedsPillKind } from "./needs-pill";
import type { DesktopRow } from "./desktop-sidebar";

/** One agent that needs you, as its sidebar row shows it. */
export interface NeedsYouEntry {
  readonly hostId: string;
  readonly paneId: string;
  /** The row's name (the sidebar's). */
  readonly name: string;
  /** The pill's words: "Pending Approval" or "Awaiting Input". */
  readonly pill: string;
  /** The row's project (its workspace's label). */
  readonly project: string;
  /** The machine's name. */
  readonly machine: string;
  /** The row's needs-you line, when it has one other than its name. */
  readonly summary: string | null;
}

/** A machine whose list is live now: connected, its own snapshot in (not the launch cache's). */
export interface NeedsYouMachine {
  readonly hostId: string;
  /** Its sidebar entry and connection ("<incarnation>:<connection>"): a new one is a new connection. */
  readonly epoch: string;
}

/** One waiting agent's identity: its machine and pane (no text). */
export type NeedsYouKey = readonly [hostId: string, paneId: string];

export interface NeedsYouReport {
  /** What is shown: the Needs you rows in the sidebar's order, the first maxReportRows of them, with their texts. */
  readonly rows: readonly NeedsYouEntry[];
  /**
   * What is known: every waiting agent's identity in the same order, the first maxReportWaiting of them. Who
   * started or stopped needing you is judged on this list, never on the shown rows. Shorter than `total`: cut off.
   */
  readonly waiting: readonly NeedsYouKey[];
  /** How many agents need you across machines (rows and identities past their caps counted too). */
  readonly total: number;
  readonly live: readonly NeedsYouMachine[];
}

export const emptyNeedsYouReport: NeedsYouReport = { rows: [], waiting: [], total: 0, live: [] };

/** At most this many rows cross with their texts (the menu shows 20; the notifications use them for their words). */
export const maxReportRows = 100;
/** At most this many waiting agents' identities cross (past it, the list is cut off: nothing past it is announced). */
export const maxReportWaiting = 2_000;
/** At most this many machines. */
export const maxReportMachines = 64;
/** Each shown text at most this long (clipped with … by the page). */
export const maxShownText = 160;
const maxIdLength = 256;
const maxEpochLength = 48;
/** A count no real list reaches. */
const maxTotal = 100_000;

/** One line of text: control characters and runs of spaces as one space, at most `max` characters (… at the cut). */
export function shownText(text: string, max = maxShownText): string {
  // oxlint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** What the page knows of a machine (HostView's fields this reads). */
export interface ReportHost {
  readonly id: string;
  readonly state: string;
  readonly topology: unknown;
  readonly catchingUp?: boolean;
  readonly connection?: number;
  readonly incarnation?: number;
}

/**
 * The report for the sidebar's Needs you rows (`needsYou`, built without a search, so a search in the
 * window hides nothing here), each row's pill as the sidebar shows it, and the machines.
 */
export function needsYouReport(
  needsYou: readonly DesktopRow[],
  hosts: readonly ReportHost[],
  pills: ReadonlyMap<string, NeedsPillKind>,
): NeedsYouReport {
  const rows = needsYou.slice(0, maxReportRows).map((entry): NeedsYouEntry => {
    // A row with no name at all (none is expected) is named for what it is, so the report still passes main's check.
    const name = shownText(entry.row.name) || "Agent";
    const activity = shownText(entry.row.activity ?? "");
    return {
      hostId: entry.hostId,
      paneId: entry.row.paneID,
      name,
      pill: needsPill(entry.row, pills.get(entry.key))?.label ?? needsPillLabel.input,
      project: shownText(entry.row.workspaceLabel),
      machine: shownText(entry.hostName),
      summary: activity === "" || activity === name ? null : activity,
    };
  });
  const live = hosts
    .filter((host) => host.state === "connected" && host.topology !== null && host.topology !== undefined && host.catchingUp !== true)
    .slice(0, maxReportMachines)
    .map((host) => ({ hostId: host.id, epoch: `${host.incarnation ?? 0}:${host.connection ?? 0}` }));
  const waiting = needsYou.slice(0, maxReportWaiting).map((entry): NeedsYouKey => [entry.hostId, entry.row.paneID]);
  return { rows, waiting, total: needsYou.length, live };
}

/** The same report (sent again only when it changed). */
export function sameReport(a: NeedsYouReport, b: NeedsYouReport): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- The check main makes (types, lengths, the caps) ---

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxIdLength;
}

function isShown(value: unknown, empty = false): value is string {
  return typeof value === "string" && value.length <= maxShownText && (empty || value.length > 0);
}

const pillWords: readonly string[] = Object.values(needsPillLabel);

function isEntry(value: unknown): value is NeedsYouEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !["hostId", "paneId", "name", "pill", "project", "machine", "summary"].includes(key))) return false;
  return (
    isId(entry["hostId"]) &&
    isId(entry["paneId"]) &&
    isShown(entry["name"]) &&
    typeof entry["pill"] === "string" &&
    pillWords.includes(entry["pill"]) &&
    isShown(entry["project"], true) &&
    isShown(entry["machine"], true) &&
    (entry["summary"] === null || isShown(entry["summary"]))
  );
}

/**
 * `check` holds for every index of a real array, holes included: a structured-cloned array keeps its holes, and
 * Array.prototype.every skips them, so a hole is read here as undefined and refused.
 */
function everyIndex<T>(value: unknown, max: number, check: (item: unknown) => item is T): value is T[] {
  if (!Array.isArray(value) || value.length > max) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !check(value[index])) return false;
  }
  return true;
}

function isKey(value: unknown): value is NeedsYouKey {
  return everyIndex(value, 2, isId) && value.length === 2;
}

function isMachine(value: unknown): value is NeedsYouMachine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const machine = value as Record<string, unknown>;
  if (Object.keys(machine).some((key) => key !== "hostId" && key !== "epoch")) return false;
  return isId(machine["hostId"]) && typeof machine["epoch"] === "string" && machine["epoch"].length > 0 && machine["epoch"].length <= maxEpochLength;
}

/**
 * The page's report, checked: shapes, lengths, the caps, every index of every array (no holes), no row or
 * identity twice, every shown row among the identities, the total at least the identities; anything else is refused.
 */
export function isNeedsYouReport(value: unknown): value is NeedsYouReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (Object.keys(report).some((key) => !["rows", "waiting", "total", "live"].includes(key))) return false;
  const rows = report["rows"];
  const waiting = report["waiting"];
  const live = report["live"];
  const total = report["total"];
  if (!everyIndex(rows, maxReportRows, isEntry)) return false;
  if (!everyIndex(waiting, maxReportWaiting, isKey)) return false;
  if (!everyIndex(live, maxReportMachines, isMachine)) return false;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < waiting.length || total > maxTotal) return false;
  const known = new Set(waiting.map((key) => identityKey(key[0], key[1])));
  if (known.size !== waiting.length) return false;
  const shown = new Set(rows.map((row) => identityKey(row.hostId, row.paneId)));
  return shown.size === rows.length && [...shown].every((key) => known.has(key));
}

/** One agent's identity as a map key, without ambiguity (an id may hold any character). */
export function identityKey(hostId: string, paneId: string): string {
  return JSON.stringify([hostId, paneId]);
}

/** A row's key, as the sidebar keys it (desktop-sidebar rowKey). */
export function entryKey(entry: Pick<NeedsYouEntry, "hostId" | "paneId">): string {
  return `${entry.hostId}/${entry.paneId}`;
}

// --- The words ---

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
  /** No sound (Play a sound off). */
  readonly silent: boolean;
}

/** The notification for an agent that started needing you: its name; the pill's words, project and machine; its line. */
export function needsNotification(entry: NeedsYouEntry, sound: boolean): NotificationContent {
  const where = [entry.pill, entry.project, entry.machine].filter((part) => part !== "").join(" · ");
  return { title: entry.name, body: entry.summary === null ? where : `${where}\n${entry.summary}`, silent: !sound };
}

/** Settings' Send a test notification. */
export function testNotification(sound: boolean): NotificationContent {
  return { title: "Adari", body: "Notifications are on. Adari tells you here when an agent needs you.", silent: !sound };
}

export const testSentText = "Sent. If nothing showed, look in System Settings › Notifications › Adari.";
export const testUnsupportedText = "This system cannot show notifications.";

/** The menu bar's first line. */
export function needsCountLine(total: number): string {
  if (total === 0) return "No agent needs you";
  return total === 1 ? "1 agent needs you" : `${total} agents need you`;
}

/** The menu shows at most this many agents, then "and N more". */
export const menuBarAgents = 20;

export type MenuBarItem =
  | { readonly kind: "line"; readonly label: string }
  | { readonly kind: "agent"; readonly label: string; readonly hostId: string; readonly paneId: string }
  | { readonly kind: "separator" }
  | { readonly kind: "open"; readonly label: string }
  | { readonly kind: "settings"; readonly label: string }
  | { readonly kind: "quit"; readonly label: string };

export interface MenuBarView {
  /** Beside the mark: the count, or nothing at zero. */
  readonly title: string;
  readonly tooltip: string;
  readonly items: readonly MenuBarItem[];
}

/** One waiting agent's item: name, project, machine, the pill's words. */
export function menuBarAgentLabel(entry: NeedsYouEntry): string {
  return [entry.name, entry.project, entry.machine, entry.pill].filter((part) => part !== "").join(" · ");
}

/** The menu bar item: its count, and its menu in the sidebar's Needs you order. */
export function menuBarView(report: NeedsYouReport): MenuBarView {
  const shown = report.rows.slice(0, menuBarAgents);
  const more = report.total - shown.length;
  const items: MenuBarItem[] = [
    { kind: "line", label: needsCountLine(report.total) },
    ...shown.map((entry): MenuBarItem => ({ kind: "agent", label: menuBarAgentLabel(entry), hostId: entry.hostId, paneId: entry.paneId })),
    ...(more > 0 ? [{ kind: "line", label: `and ${more} more` } as const] : []),
    { kind: "separator" },
    { kind: "open", label: "Open Adari" },
    { kind: "settings", label: "Settings…" },
    { kind: "quit", label: "Quit Adari" },
  ];
  return {
    title: report.total > 0 ? String(report.total) : "",
    tooltip: report.total > 0 ? `Adari: ${needsCountLine(report.total)}` : "Adari",
    items,
  };
}

// --- The switches (Settings › Notifications) ---

export interface NotifySettings {
  /** "Notify when an agent needs you". */
  readonly notify: boolean;
  /** "Play a sound". */
  readonly sound: boolean;
  /** "Show Adari in the menu bar". */
  readonly menuBar: boolean;
}

export const defaultNotifySettings: NotifySettings = { notify: true, sound: true, menuBar: true };

const settingKeys = ["notify", "sound", "menuBar"] as const;

/** What was kept: each switch on unless it was kept off (a missing or odd value is the default, on). */
export function decodeNotifySettings(value: unknown): NotifySettings {
  const kept = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return { notify: kept["notify"] !== false, sound: kept["sound"] !== false, menuBar: kept["menuBar"] !== false };
}

/** A change from the page: one or more of the three switches, booleans only. */
export function isNotifySettingsChange(value: unknown): value is Partial<NotifySettings> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => (settingKeys as readonly string[]).includes(key) && typeof (value as Record<string, unknown>)[key] === "boolean");
}

/** Settings › Notifications' words. */
export const notifyTexts = {
  title: "Notifications",
  lead: "How Adari tells you an agent needs you while you are in another app. The Dock icon shows how many agents need you.",
  notify: "Notify when an agent needs you",
  notifyHelp: "A notification when an agent starts needing you, unless Adari’s window is in front. Click it to open that agent.",
  sound: "Play a sound",
  soundHelp: "The notification comes with the system’s sound.",
  menuBar: "Show Adari in the menu bar",
  menuBarHelp: "Adari’s mark in the menu bar, with how many agents need you and a menu to open each one.",
  testTitle: "Test notification",
  testHelp: "The first one has macOS ask whether Adari may show notifications.",
  test: "Send a test notification",
  testFailed: "Not sent: Adari could not reach its notifications.",
  macLine: "macOS decides whether notifications show, in System Settings › Notifications › Adari.",
  otherLine: "Your system decides whether notifications show, in its notification settings.",
} as const;
