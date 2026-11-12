// How tall the message box is: its text's height, from one line up to ten
// lines or 40% of the window, whichever is less; past that it scrolls inside
// (as T3 Code's, Claude Code's and Codex's boxes grow).

/** The most lines the box shows before it scrolls. */
export const boxMaxLines = 10;

/** The share of the window the box may take at most. */
export const boxMaxWindowShare = 0.4;

export interface BoxFit {
  readonly height: number;
  /** The text is taller than the box: it scrolls inside. */
  readonly scrolls: boolean;
}

/** The box's height for text `contentHeight` tall (its scrollHeight) on `lineHeight` lines in a window `windowHeight` tall. */
export function fitBox(contentHeight: number, lineHeight: number, windowHeight: number): BoxFit {
  const cap = Math.max(lineHeight, Math.min(boxMaxLines * lineHeight, windowHeight * boxMaxWindowShare));
  return { height: Math.min(Math.max(contentHeight, lineHeight), cap), scrolls: contentHeight > cap + 0.5 };
}
