// The Mac's terminal look: JetBrains Mono 13 px, Ghostty's Dark Pastel theme,
// on black. The terminal fills its area edge to edge like Ghostty's own window:
// no column cap, no centring, Ghostty's 2-point window padding.

import type { ITheme } from "ghostty-web";

export const terminalFontSize = 13;
/** Ghostty's window padding (window-padding-x / window-padding-y, in points: CSS pixels here). */
export const ghosttyPadding = 2;
export const terminalFontFamily = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

export const darkPastel: ITheme = {
  background: "#000000",
  foreground: "#FFFFFF",
  cursor: "#BBBBBB",
  cursorAccent: "#FFFFFF",
  selectionBackground: "#B5D5FF",
  selectionForeground: "#000000",
  black: "#000000",
  red: "#FF5555",
  green: "#55FF55",
  yellow: "#FFFF55",
  blue: "#5555FF",
  magenta: "#FF55FF",
  cyan: "#55FFFF",
  white: "#BBBBBB",
  brightBlack: "#555555",
  brightRed: "#FF5555",
  brightGreen: "#55FF55",
  brightYellow: "#FFFF55",
  brightBlue: "#5555FF",
  brightMagenta: "#FF55FF",
  brightCyan: "#55FFFF",
  brightWhite: "#FFFFFF",
};
