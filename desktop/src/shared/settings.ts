// Settings, the page in the main window (the sidebar footer's
// button, the app menu's Settings… and ⌘, open it; Esc, its close button and
// ⌘, again go back). Its sections, the composer's "Send presses Return"
// (the iPhone app's CompanionComposerSettings, the same key), ⌘, itself, and
// the words of its rows, as the iPhone app's Settings has them
// (App/CompanionSettings.swift: CompanionMacFilesText). Pure, so they are
// tested without a window.

import type { ShortcutKey } from "./app-keys";
import type { UpdateView } from "./updates";

export type SettingsSection = "machines" | "chat" | "uploads" | "appearance" | "updates" | "about";

/** The page's sections, in the list's order (the first opens by default). */
export const settingsSections: readonly { readonly id: SettingsSection; readonly title: string }[] = [
  { id: "machines", title: "Machines" },
  { id: "chat", title: "Chat" },
  { id: "uploads", title: "Uploaded images" },
  { id: "appearance", title: "Appearance" },
  { id: "updates", title: "Updates" },
  { id: "about", title: "About" },
];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && settingsSections.some((section) => section.id === value);
}

/** The part of About's privacy line that is true of every build. */
export const privacyBase = "Adari talks to your Macs over SSH. No relay, no account, no telemetry.";

/**
 * About's one privacy line, true for the running build.
 * The one thing Adari contacts on its own is GitHub, for its update check (src/main/updates.ts), and only a build
 * that checks says so: an unsigned, development, demo, capture or non-Mac build, or one whose own signature check
 * failed (`update.off` set), or a page with no update state, says only privacyBase. A build that checks names GitHub
 * (its only feed: a signed release ignores HERDR_COMPANION_UPDATE_FEED) and says the switch is there, or that it is off.
 */
export function privacyLine(update: Pick<UpdateView, "off" | "automatic"> | null): string {
  if (update === null || update.off !== null) return privacyBase;
  return update.automatic ? `${privacyBase} It checks GitHub for updates, which you can turn off.` : `${privacyBase} It checks GitHub for updates only when you ask.`;
}

/** ⌘, (Ctrl+, on Windows and Linux): Settings, and again back to the pane. */
export function isSettingsShortcut(event: ShortcutKey, mac: boolean): boolean {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.altKey && !event.shiftKey && event.key === ",";
}

/** How ⌘, reads on this platform. */
export const settingsKey = (mac: boolean): string => (mac ? "⌘," : "Ctrl+,");

// --- Send presses Return (the iPhone app's adari.composer.sendPressesReturn, on by default) ---

export const sendPressesReturnKey = "adari.composer.sendPressesReturn";

/** On unless it was turned off (a value that is not "false" is on, as a missing one is). */
export function loadSendPressesReturn(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(sendPressesReturnKey) !== "false";
  } catch {
    return true;
  }
}

export function saveSendPressesReturn(storage: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    storage?.setItem(sendPressesReturnKey, on ? "true" : "false");
  } catch {
    // Not kept: the next launch has the default (on).
  }
}

export interface ReturnKey {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}

/**
 * Whether this key sends the composer's message. On (the default): Return
 * sends and Shift-Return adds a line. Off, as on the iPhone with
 * the setting off: Return adds a line and ⌘Return (Ctrl+Return on Windows and
 * Linux) sends. An IME's Return (composing) never sends.
 */
export function returnSends(event: ReturnKey, pressesReturn: boolean, mac: boolean): boolean {
  if (event.key !== "Enter" || event.isComposing === true || event.shiftKey) return false;
  if (pressesReturn) return true;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.altKey;
}

/** The Send button's tooltip for the setting. */
export function sendButtonTitle(pressesReturn: boolean, mac: boolean): string {
  if (pressesReturn) return "Send (Return) · Shift-Return for a new line";
  return `Send (${mac ? "⌘Return" : "Ctrl+Return"}) · Return for a new line`;
}

/** The setting's line under its switch. */
export function sendPressesReturnFoot(mac: boolean): string {
  return `On: Return sends and Shift-Return adds a line. Off: Return adds a line and ${mac ? "⌘Return" : "Ctrl+Return"} sends.`;
}

// --- Uploaded images (CompanionMacFilesText) ---

/** The app's uploads on one machine, as a walk of its upload folders counted them. */
export interface UploadsInventory {
  readonly files: number;
  readonly bytes: number;
  /** What is counted so far; the count goes on (absent: the whole count). */
  readonly partial?: true;
}

/** What one Delete now did (src/main/uploads/sweep.ts sweepUploads with every age), and what is left. */
export interface UploadsDeleteResult {
  readonly removedFiles: number;
  readonly removedBytes: number;
  readonly removedFolders: number;
  /** Uploads left because something in this app still uses them (an upload under way, a draft, a send). */
  readonly keptFiles: number;
  /** Why it stopped early (nothing more was touched after it), or null. */
  readonly stopped: string | null;
  /** The uploads still on the machine after it (null: not counted again). */
  readonly remaining: UploadsInventory | null;
}

/** A machine's uploads as the page shows them. */
export type UploadsState =
  | { readonly kind: "unknown" }
  | { readonly kind: "counting" }
  | { readonly kind: "counted"; readonly inventory: UploadsInventory }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "deleting" };

/** A size as the Finder writes one (ByteCountFormatter's file style: 1000 bytes a KB). */
export function byteSize(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value === 0) return "Zero KB";
  if (value < 1_000) return value === 1 ? "1 byte" : `${Math.round(value)} bytes`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)} KB`;
  if (value < 1_000_000_000) return `${trimmed(value / 1_000_000, 1)} MB`;
  return `${trimmed(value / 1_000_000_000, 2)} GB`;
}

function trimmed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

export function filesText(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

/** The row's second line. */
export function uploadsCountText(state: UploadsState): string {
  switch (state.kind) {
    case "unknown":
    case "counting":
      return "Counting…";
    case "deleting":
      return "Deleting…";
    case "failed":
      return `Could not count them: ${state.reason}`;
    case "counted":
      if (state.inventory.partial === true) return `${filesText(state.inventory.files)} so far, ${byteSize(state.inventory.bytes)}, still counting\u2026`;
      return state.inventory.files === 0 ? "None" : `${filesText(state.inventory.files)}, ${byteSize(state.inventory.bytes)}`;
  }
}

/**
 * Delete now is offered for a count with files in it, and for a count still going on, even one that has found
 * nothing yet (its zero is not known to be the whole); a whole count of none is not.
 */
export function canDeleteUploads(state: UploadsState): boolean {
  return state.kind === "counted" && (state.inventory.files > 0 || state.inventory.partial === true);
}

/** A count with files in it that is the whole count (the confirmation names its files only then). */
const wholeCountWithFiles = (state: UploadsState): state is { readonly kind: "counted"; readonly inventory: UploadsInventory } =>
  state.kind === "counted" && state.inventory.files > 0 && state.inventory.partial !== true;

export function deleteConfirmTitle(machine: string): string {
  return `Delete the uploaded images on ${machine}?`;
}

export function deleteConfirmButton(state: UploadsState): string {
  if (wholeCountWithFiles(state)) {
    return state.inventory.files === 1 ? "Delete 1 file" : `Delete ${state.inventory.files} files`;
  }
  return "Delete files";
}

export function deleteConfirmMessage(state: UploadsState, machine: string): string {
  let what = `The images and files Adari uploaded to ${machine}`;
  if (wholeCountWithFiles(state)) what += ` (${filesText(state.inventory.files)}, ${byteSize(state.inventory.bytes)})`;
  return `${what} are deleted from Adari's upload folders there. Nothing else on the machine is touched. Files an upload under way, a draft or a send in this app still uses are kept.`;
}

/** The section's foot: the daily sweep, then the last Delete now's outcome. */
export function uploadsFoot(): string {
  return "Images and files you attach are uploaded to the machine for the agent to read. Once a day after connecting, Adari deletes the ones older than 30 days.";
}

export function deleteOutcome(result: UploadsDeleteResult): string {
  // An error part way leaves what was already removed removed (each was the app's own
  // upload, cleared for removal); said plainly, never as if nothing happened.
  if (result.stopped !== null) {
    const done =
      result.removedFiles > 0
        ? `${filesText(result.removedFiles)} (${byteSize(result.removedBytes)}) ${result.removedFiles === 1 ? "was" : "were"} already deleted before it; the rest are still on the machine.`
        : "Nothing was deleted.";
    return `Delete now stopped at an error (${result.stopped}). ${done}`;
  }
  const parts: string[] = [];
  parts.push(result.removedFiles > 0 ? `deleted ${filesText(result.removedFiles)} (${byteSize(result.removedBytes)})` : "nothing to delete");
  if (result.keptFiles > 0) parts.push(`kept ${result.keptFiles} still used in Adari`);
  return `Delete now: ${parts.join(", ")}.`;
}

// --- Updates and About ---

/** "0.1.0 · 5df5d784": the version and, when the build knew it, the commit it was built from. */
export function versionLine(version: string, commit: string | null): string {
  return commit === null || commit === "" ? version : `${version} · ${commit}`;
}
