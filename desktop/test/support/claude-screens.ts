// Claude Code 2.1.319 screens for the Esc queue tests: the box between its
// rules (the top one titled), the working line above it, queued messages and
// their hint, the footer's mode row. The shapes of claude-titled-box.test.ts.

const width = 80;
const dashes = (count: number): string => "\u{2500}".repeat(count);
const name = "esc queue";
const titled = `${dashes(width - [...name].length - 2)} ${name} `;
const plain = dashes(width);
const modeRow = "  \u{23F5}\u{23F5} auto mode on (shift+tab to cycle)";
export const workingLine = "\u{273B} Cogitating\u{2026} (3s \u{00B7} \u{2193} 12 tokens \u{00B7} esc to interrupt)";

export interface ScreenShape {
  /** The box's text, one row per line ("" empty). */
  readonly draft?: string;
  readonly working?: boolean;
  /** Messages waiting in Claude's queue (shown with its hint). */
  readonly queued?: readonly string[];
  /** The reply on screen above. */
  readonly above?: readonly string[];
}

export function claudeScreen(shape: ScreenShape = {}): string {
  const draft = shape.draft ?? "";
  const rows = draft === "" ? ["\u{276F}\u{00A0}"] : draft.split("\n").map((line, index) => (index === 0 ? `\u{276F} ${line}` : `  ${line}`));
  const queued = shape.queued ?? [];
  return [
    ...(shape.above ?? ["\u{23FA} Got it. ..."]),
    "",
    ...(shape.working === true ? [workingLine] : []),
    ...queued.map((text) => `  \u{23BF} ${text}`),
    ...(queued.length > 0 ? ["    Press up to edit queued messages"] : []),
    titled,
    ...rows,
    plain,
    modeRow,
  ].join("\n");
}
