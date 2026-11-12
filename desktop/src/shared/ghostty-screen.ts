// Reads a Ghostty terminal's visible screen as text: one line per row, a wide
// character once (its spacer cell skipped), a multi-codepoint grapheme (ZWJ
// emoji, flags) whole. Used by the engine test and by the renderer's "copy
// screen" path; the same reading the Swift app's viewportText gives.

export interface ScreenCell {
  readonly codepoint: number;
  readonly width: number;
  readonly grapheme_len: number;
}

export interface ScreenSource {
  getLine(y: number): readonly ScreenCell[] | null;
  getGraphemeString(row: number, col: number): string;
}

export function screenText(source: ScreenSource, rows: number): string {
  const lines: string[] = [];
  for (let y = 0; y < rows; y += 1) {
    const cells = source.getLine(y);
    let line = "";
    if (cells !== null) {
      for (let x = 0; x < cells.length; x += 1) {
        const cell = cells[x];
        if (cell === undefined || cell.width === 0) continue;
        if (cell.grapheme_len > 0) line += source.getGraphemeString(y, x);
        else line += cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint);
      }
    }
    lines.push(line.replace(/ +$/, ""));
  }
  return lines.join("\n");
}
