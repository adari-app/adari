// Messages with blank lines, for every Esc suite: Claude Code draws a blank line as a blank row of its
// box, and the box's clearing keys go per drawn row (Ctrl+U clears one row, Backspace joins it to the row above).

export const blankLineMessages: readonly (readonly [string, string])[] = [
  ["one blank line", "first line\n\nsecond line"],
  ["two blank lines", "first line\n\n\nsecond line"],
  ["a blank line at the start", "\nfirst line\nsecond line"],
  ["a blank line at the end", "first line\nsecond line\n"],
];
