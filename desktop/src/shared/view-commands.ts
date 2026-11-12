// The View menu's commands to the page (the main process sends them on
// IPC.viewCommand): the terminal's font size, kept per window, and the message
// box over the terminal; the File menu's New Workspace…; the two screens the
// sidebar's cards open (While You Were Away, What Each Agent Changed); and View ›
// Terminal, the open pane's terminal drawer (⌘J). Pure, so the sizes are tested
// without a window.

export type ViewCommand = "font-bigger" | "font-smaller" | "font-reset" | "toggle-box" | "toggle-changes" | "new-workspace" | "open-away" | "open-changes" | "toggle-terminal";

export const viewCommands: readonly ViewCommand[] = ["font-bigger", "font-smaller", "font-reset", "toggle-box", "toggle-changes", "new-workspace", "open-away", "open-changes", "toggle-terminal"];

export function isViewCommand(value: unknown): value is ViewCommand {
  return typeof value === "string" && (viewCommands as readonly string[]).includes(value);
}

/** The Mac's terminal size (App/CompanionTerminalMacLook.swift: JetBrains Mono 13). */
export const defaultTerminalFontSize = 13;
export const minimumTerminalFontSize = 8;
export const maximumTerminalFontSize = 32;

/** The size after ⌘+ / ⌘- / ⌘0, one point a step, within the bounds. */
export function nextFontSize(current: number, command: ViewCommand): number {
  const size = clampFontSize(current);
  switch (command) {
    case "font-bigger":
      return Math.min(maximumTerminalFontSize, size + 1);
    case "font-smaller":
      return Math.max(minimumTerminalFontSize, size - 1);
    case "font-reset":
      return defaultTerminalFontSize;
    case "toggle-box":
    case "toggle-changes":
    case "new-workspace":
    case "open-away":
    case "open-changes":
    case "toggle-terminal":
      return size;
  }
}

export function clampFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultTerminalFontSize;
  return Math.min(maximumTerminalFontSize, Math.max(minimumTerminalFontSize, Math.round(value)));
}

/** The window's saved size (sessionStorage is per window: each window keeps its own). */
export function loadFontSize(storage: Pick<Storage, "getItem"> | null): number {
  const saved = storage?.getItem(fontSizeKey) ?? null;
  return saved === null ? defaultTerminalFontSize : clampFontSize(Number(saved));
}

export function saveFontSize(storage: Pick<Storage, "setItem"> | null, size: number): void {
  storage?.setItem(fontSizeKey, String(clampFontSize(size)));
}

export const fontSizeKey = "adari.terminal.font-size";
