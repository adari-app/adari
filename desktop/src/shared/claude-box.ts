// The rules of Claude Code's prompt box, for every reader that finds
// the box by them (approval-modes.ts, chat/live-screen.ts, update-mark.ts).
// The twin of Sources/HerdrKit/ClaudeBoxRule.swift.
//
// - 2.1.318 draws both rules as `─` only, the pane's width.
// - 2.1.319 draws the session's name in the top rule: a run of `─`, one space,
//   the name (cut with `…` when it does not fit), one trailing space. Its
//   bottom rule is still `─` only.
// - 2.1.303 drew a name with one `─` after it ("──── my-session ─"); a name
//   in the middle of the rule reads too.
//
// A screen whose last rule carries a label is no box: the bottom rule is
// plain in every version.

const dash = "\u{2500}"; // ─

/** At least four dashes, a space, one label (no `─`, not starting blank), then nothing, a space, or more dashes. */
const titledRule = /^\u{2500}{4,} [^\u{2500}\s][^\u{2500}]*?(?: ?\u{2500}+)? ?$/u;

/** The bottom rule (and 2.1.318's top rule): dashes only, at least 8. */
export function isClaudeBottomRule(line: string): boolean {
  return [...line].length >= 8 && [...line].every((c) => c === dash);
}

/** The top rule: plain, or titled with one label. */
export function isClaudeTopRule(line: string): boolean {
  return isClaudeBottomRule(line) || ([...line].length >= 8 && titledRule.test(line));
}

/**
 * The box's rules in `lines` (each as its reader trims it): the last rule of
 * either kind is the bottom and must be plain; the nearest rule of either kind
 * above it is the top. Null: no such pair (a ruled transcript line under the
 * box, a lone rule).
 */
export function claudeBoxRules(lines: readonly string[]): { readonly top: number; readonly bottom: number } | null {
  let bottom = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isClaudeTopRule(lines[index]!)) {
      bottom = index;
      break;
    }
  }
  if (bottom < 0 || !isClaudeBottomRule(lines[bottom]!)) return null;
  for (let index = bottom - 1; index >= 0; index -= 1) if (isClaudeTopRule(lines[index]!)) return { top: index, bottom };
  return null;
}
