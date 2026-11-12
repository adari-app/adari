// What Chat reads off Claude Code's screen around an Esc and a send (Claude
// Code 2.1.319, driven with `herdr agent prompt` and `herdr agent send-keys`):
//
// - Esc after Claude took a message but before any answer drops the message
//   from the conversation and puts its text back in Claude's own box; text
//   left there joins the next `agent.prompt` with no separator ("queued alpha"
//   + "line one" arrived as "queued alphaline one").
// - Ctrl+U deletes one line of the box (cursor to the line's start); a single
//   Esc at idle does not clear it, two open the rewind menu.
// - Queued messages show "Press up to edit queued messages" under the working
//   line; Esc then runs them at once as one prompt.
//
// The box and its draft are approval-modes.ts's readClaudeModeScreen (with
// claude-box.ts's rules); the working line is the live row's
// (chat/live-screen.ts). The twin of Sources/HerdrKit/ClaudeScreenFacts.swift.

import { readClaudeModeScreen } from "./approval-modes";
import { claudeBoxRules } from "./claude-box";
import { isClaudeWorkingLine } from "./chat/live-screen";

/**
 * Claude Code's hint while messages wait in its queue. 2.1.319 draws it inside
 * the box itself (`❯ Press up to edit queued messages`): a box whose only line is exactly this hint
 * is empty, as approval-modes.ts reads Claude's dimmed `Try "…"` suggestion.
 */
export const queuedHint = "Press up to edit queued messages";

/**
 * Claude Code 2.1.322 draws this line under a message waiting in its queue, below the running
 * turn (with the box's hint above). Either one on screen says the queue holds something.
 */
export const queuedSendNow = "ctrl+enter to send now";

/**
 * Ctrl+U and Backspace as Herdr's agent.send_keys names them: "ctrl+u" clears the box line, "Backspace" deletes one
 * character; the tmux-style "C-u" is refused with `invalid_key`.
 */
export const clearLineKey = "ctrl+u";
export const backspaceKey = "Backspace";

/** How many rows above the box the working line may stand (queued messages and tips go between). */
const workingSpan = 16;

/** What one read of a Claude Code screen says. */
export interface ClaudeScreenFacts {
  /** The box's text ("" when empty); null when no box is at the bottom (a dialog, a menu, not Claude). */
  readonly draft: string | null;
  /** The working line shows above the box. */
  readonly working: boolean;
  /** Messages wait in Claude's queue. */
  readonly queued: boolean;
}

export function readClaudeScreenFacts(screen: string): ClaudeScreenFacts {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/u, ""));
  const box = readClaudeModeScreen(screen);
  const rules = claudeBoxRules(lines.map((line) => line.trim()));
  const top = rules?.top ?? lines.length;
  let working = false;
  for (let index = top - 1; index >= Math.max(0, top - workingSpan); index -= 1) {
    if (isClaudeWorkingLine(lines[index]!)) {
      working = true;
      break;
    }
  }
  // The hint alone in the box is no typed text (approval-modes.ts is left as other features read it).
  const draft = box === null ? null : box.draft === queuedHint ? "" : box.draft;
  return { draft, working, queued: screen.includes(queuedHint) || screen.includes(queuedSendNow) };
}

/** The box's text and a message as the same words: every whitespace aside (the box wraps lines where it likes). */
export function sameBoxText(draft: string, sent: string): boolean {
  const squeeze = (text: string): string => text.replace(/\s+/gu, "");
  const left = squeeze(draft);
  return left !== "" && left === squeeze(sent);
}

// A Chat send with pictures, the twin of Sources/HerdrKit/ClaudeScreenFacts.swift
// (imagePaths, held, chipsFirst, settled, chips, remnant). Claude Code takes in each picture whose path a
// prompt carries and draws its `[Image #N]` chip; a Return that lands
// meanwhile is lost and the message stays in its box.

/** The image kinds Claude Code takes in from a path in a prompt (ClaudeScreenFacts.imageExtensions). */
export const imageExtensions: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Every whitespace aside (the box wraps lines where it likes). */
function squeezed(text: string): string {
  return text.replace(/\s+/gu, "");
}

/** The words of `text`, split at any whitespace. */
function words(text: string): string[] {
  return text.split(/\s+/u).filter((word) => word !== "");
}

/** `text` as a regular expression that matches it literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * ClaudeScreenFacts.imagePaths: the image paths a message carries: each word that is an absolute path (or one
 * under `~/`) to one of `imageExtensions`, as the composer appends an upload's path after the text (joinedMessage).
 */
export function imagePaths(text: string): string[] {
  return words(text).filter((word) => {
    if (!word.startsWith("/") && !word.startsWith("~/")) return false;
    const dot = word.lastIndexOf(".");
    if (dot < 0) return false;
    const extension = word.slice(dot + 1);
    return !extension.includes("/") && imageExtensions.has(extension.toLowerCase());
  });
}

/**
 * ClaudeScreenFacts.Held: how Claude's box holds a message sent to it. `none`: not there (empty, or other
 * text); `mine`: the message and nothing else, each picture as its path or its chip; `within`: the message with
 * other text around it (your typing, which `agent.prompt` joins with no separator).
 */
export type Held = "none" | "mine" | "within";

/** Claude Code's chip for a picture it took in, every whitespace aside (`[Image#18]`). */
const chipPattern = "\\[Image#[0-9]+\\]";

/** The in-place match (ClaudeScreenFacts.heldInPlace): each chip where its path was. */
function heldInPlace(draft: string, sent: string): Held {
  const paths = new Set(imagePaths(sent));
  const parts = words(sent);
  const box = squeezed(draft);
  if (parts.length === 0 || box === "") return "none";
  const pattern = parts.map((word) => (paths.has(word) ? `(?:${literal(word)}|${chipPattern})` : literal(word))).join("");
  if (new RegExp(`^${pattern}$`).test(box)) return "mine";
  return new RegExp(pattern).test(box) ? "within" : "none";
}

/** The pictures in `part`: chips, and our paths by how often each shows. */
function pictures(part: string, item: string): { chips: number; paths: Map<string, number> } {
  let chips = 0;
  const paths = new Map<string, number>();
  for (const match of part.matchAll(new RegExp(item, "g"))) {
    const picture = match[0];
    if (picture.startsWith("[")) chips += 1;
    else paths.set(picture, (paths.get(picture) ?? 0) + 1);
  }
  return { chips, paths };
}

const total = (counts: ReadonlyMap<string, number>): number => [...counts.values()].reduce((sum, count) => sum + count, 0);

/** The message's text with its image paths taken out, every whitespace aside. */
function caption(sent: string, paths: readonly string[]): string {
  const ours = new Set(paths);
  return words(sent)
    .filter((word) => !ours.has(word))
    .join("");
}

/**
 * `draft` against `sent` as Claude Code lays out a message whose pictures it takes in
 * (ClaudeScreenFacts.chipsFirst). A box with three pictures: `[Image #18] [Image #19] [Image #20]found this
 * on X` for "found this on X <path> <path> <path>": each picture first, as its chip or (not in yet) its path,
 * then the text with the paths taken out, no separator; a path still going in may stand after the text. Every
 * whitespace aside. `mine`: one picture of ours per path (chip or path) and the text, nothing else. `within`: the
 * text with at least that many pictures and more around it (your typing joined, a picture of yours).
 */
function chipsFirst(draft: string, sent: string, paths: readonly string[]): Held {
  const box = squeezed(draft);
  if (box === "") return "none";
  const text = caption(sent, paths);
  const item = `(?:${[chipPattern, ...[...new Set(paths)].sort().map(literal)].join("|")})`;
  const wanted = new Map<string, number>();
  for (const path of paths) wanted.set(path, (wanted.get(path) ?? 0) + 1);
  const whole = new RegExp(`^(${item}*)${literal(text)}(${item}*)$`).exec(box);
  if (whole !== null) {
    const before = pictures(whole[1] ?? "", item);
    const after = pictures(whole[2] ?? "", item);
    const found = new Map(before.paths);
    for (const [path, count] of after.paths) found.set(path, (found.get(path) ?? 0) + count);
    if (before.chips + after.chips + total(found) === paths.length && [...found].every(([path, count]) => (wanted.get(path) ?? 0) >= count)) {
      return "mine";
    }
  }
  const all = pictures(box, item);
  if (all.chips + total(all.paths) >= paths.length && (text === "" || box.includes(text))) return "within";
  return "none";
}

/**
 * The box's text against `sent` (ClaudeScreenFacts.held), every whitespace
 * aside, each image path in `sent` matching itself or `[Image #N]`, in place or in Claude Code's own layout
 * (`chipsFirst`). Ours alone in either layout is `mine`; else ours with more around it in either is `within`.
 */
export function held(draft: string, sent: string): Held {
  const inPlace = heldInPlace(draft, sent);
  if (inPlace === "mine") return inPlace;
  const paths = imagePaths(sent);
  if (paths.length === 0) return inPlace;
  const laidOut = chipsFirst(draft, sent, paths);
  if (laidOut === "mine") return laidOut;
  return inPlace === "within" || laidOut === "within" ? "within" : "none";
}

/**
 * The box holds `sent`, a message Chat sent, and nothing else (ClaudeScreenFacts.isOwn): its words, each image
 * path as itself or Claude Code's chip, in place or chips first (`held` is `mine`). For a message with no image
 * path this is `sameBoxText`. Our own message in Claude's box (the clear before a send, its retry, the take-back
 * after an Esc) matches by this alone: text around it (`within`, your typing) or other text is never ours.
 */
export function isOwn(draft: string, sent: string): boolean {
  return held(draft, sent) === "mine";
}

/** The `[Image #N]` chips (ClaudeScreenFacts.chips) in `draft`, every whitespace aside (`[Image#18]`). */
export function boxChips(draft: string): string[] {
  return [...squeezed(draft).matchAll(new RegExp(chipPattern, "g"))].map((match) => match[0]);
}

/**
 * Claude's box as read right before a prompt's write (ClaudeBoxSteps.BoxBefore): its chips
 * and whether its queued-message hint showed. After the write only chips not here stand for the prompt's
 * pictures, and only a hint not here is the prompt's.
 */
export interface BoxBefore {
  readonly chips: ReadonlySet<string>;
  readonly queued: boolean;
}

/**
 * The box shows `sent` alone (ClaudeScreenFacts.settled(_:sent:before:); `held` is `mine`)
 * with every picture in (one chip per image path, none of its paths left), and every chip new since `before`
 * (none in the box before the write). Claude Code numbers each picture it takes in afresh, so an earlier
 * message's chips (the same caption, as many pictures) never stand for this prompt's. Only then may the
 * corrective Return go: one before the last chip is drawn is lost as Herdr's own was.
 */
export function settled(draft: string, sent: string, before: BoxBefore): boolean {
  if (held(draft, sent) !== "mine") return false;
  const paths = imagePaths(sent);
  const box = squeezed(draft);
  if (paths.some((path) => box.includes(path))) return false;
  const chips = boxChips(draft);
  if (chips.length !== paths.length) return false;
  return chips.filter((chip) => !before.chips.has(chip)).length === paths.length;
}

/**
 * `draft` holds a piece of a message with pictures or of `sent` (ClaudeScreenFacts.remnant):
 * a chip, one of `sent`'s image paths, or `sent`'s text (its words, the paths taken out), every whitespace
 * aside. With `held` `none` (a picture missing, the caption changed, more text around): neither ours nor gone,
 * and never proof that ours went.
 */
export function remnant(draft: string, sent: string): boolean {
  const box = squeezed(draft);
  if (box === "") return false;
  if (new RegExp(chipPattern).test(box)) return true;
  const paths = imagePaths(sent);
  if (paths.some((path) => box.includes(path))) return true;
  const text = caption(sent, paths);
  return text !== "" && box.includes(text);
}

/** The keys that empty a box holding `draft`: per row, Ctrl+U then Backspace (the cursor stands at the end). */
export function boxClearKeys(draft: string): string[] {
  const rows = Math.max(1, draft.split("\n").length);
  const keys: string[] = [];
  for (let row = 0; row < rows; row += 1) keys.push(clearLineKey, backspaceKey);
  return keys;
}

/**
 * The keys that empty Claude's input row after Up pulled the queue into it (the cursor at its
 * end): Ctrl+U, and for each row above it Backspace (to the end of that row) and Ctrl+U again. One row is just
 * Ctrl+U (on 2.1.322: Up, then ctrl+u, and the turn runs on with nothing sent).
 */
export function pullClearKeys(draft: string): string[] {
  const rows = Math.max(1, draft.split("\n").length);
  const keys = [clearLineKey];
  for (let row = 1; row < rows; row += 1) keys.push(backspaceKey, clearLineKey);
  return keys;
}

/**
 * The width of Claude's box on `screen`, its bottom rule's length in
 * characters; null when no box is at the bottom. A row of the box that wraps is about this wide.
 */
export function claudeBoxWidth(screen: string): number | null {
  const lines = screen.split("\n").map((line) => line.trim());
  const rules = claudeBoxRules(lines);
  return rules === null ? null : [...lines[rules.bottom]!].length;
}

/** The box's own columns before its text: the prompt mark and a space (`❯ `), or the two spaces of a row under it. */
const boxIndent = 2;
/** How much shorter than the box a row may be and still be one Claude Code wrapped (its own margin). */
export const wrapSlack = 6;
/** A row break where the next row's first word would not fit after the row: a wrap at a space, or a newline. */
const wordWrap = "\u0001";
/** A row break after a full row: a wrap inside a word, at a space, or a newline. */
const fullWrap = "\u0002";

/**
 * `draft` (the box's rows, joined by newlines, as ClaudeScreenFacts reads them) with
 * each row break marked by what the screen can show it to be: after a full row any wrap (fullWrap); after a row too
 * short for that but where the next row's first word would not have fit, a wrap at a space (wordWrap); else a
 * newline only. Width not known: every break is a newline (a wrapped message then reads as not ours, and is left).
 */
function shownRows(draft: string, width: number | null): string {
  const rows = draft.split("\n");
  const limit = width === null ? null : width - boxIndent - wrapSlack;
  let shown = rows[0] ?? "";
  for (let index = 1; index < rows.length; index += 1) {
    const before = [...rows[index - 1]!].length;
    const next = [...(rows[index]!.split(/\s+/u)[0] ?? "")].length;
    const mark = limit === null ? "\n" : before >= limit ? fullWrap : before + 1 + next > limit ? wordWrap : "\n";
    shown += mark + rows[index]!;
  }
  return shown;
}

/** One character as a pattern, then a place a wrap inside a word may stand (after a full row only). */
const charPattern = (char: string): string => `${literal(char)}${fullWrap}?`;

/** A word as a pattern: its characters, a wrap allowed between any two. */
const wordPattern = (word: string): string => [...word].map(charPattern).join("");

/** Between two words of a row: spaces, or a wrap at a space. */
const wordGap = `(?: +|[${wordWrap}${fullWrap}])`;

/** Claude Code's chip for a picture it took in (`[Image #18]`), its space possibly a wrap. */
const chipShown = String.raw`\[Image` + wordGap + String.raw`#[0-9]+\]`;

/** A logical line's words: whitespace only between them (the box trims each row). */
const lineWords = (line: string): string[] => line.split(/[^\S\n]+/u).filter((word) => word !== "");

/** Your message's lines as the box shows them: each trimmed, blank ones gone (the box shows no blank row). */
const messageLines = (text: string): string[][] =>
  text
    .split("\n")
    .map(lineWords)
    .filter((words) => words.length > 0);

/** A newline of your message: a row break the screen shows (a soft one may be a newline too). */
const lineBreak = `[\n${wordWrap}${fullWrap}]`;

/**
 * One message of yours as Claude's box may show it, exactly: its words with their
 * boundaries (a space between two words is spaces or a wrap; no space inside a word, only a wrap), its newlines as
 * row breaks, and each image path as itself or Claude Code's chip in its place; or, for a message with pictures,
 * one chip per picture first and then its text (Claude Code's own layout).
 */
function messagePattern(text: string): string {
  const paths = new Set(imagePaths(text));
  const lines = messageLines(text);
  const inPlace = lines.map((words) => words.map((word) => (paths.has(word) ? `(?:${wordPattern(word)}|${chipShown})` : wordPattern(word))).join(wordGap)).join(lineBreak);
  if (paths.size === 0) return inPlace;
  const count = imagePaths(text).length;
  const caption = lines
    .map((words) => words.filter((word) => !paths.has(word)))
    .filter((words) => words.length > 0)
    .map((words) => words.map(wordPattern).join(wordGap))
    .join(lineBreak);
  return `(?:${inPlace}|(?:${chipShown}${wordGap}?){${count}}${caption})`;
}

/**
 * Claude's box shows exactly `texts` (your messages, oldest first, joined by newlines as
 * Claude Code joins its queue) and nothing else. Unlike `isOwn`, a word boundary inside a row counts: `a bc` is not
 * `abc`. Only a row break the screen shows can stand for a wrap (`shownRows`, by the box's `width`).
 */
export function showsExactly(draft: string, texts: readonly string[], width: number | null): boolean {
  if (draft.trim() === "" || texts.length === 0) return false;
  const pattern = texts.map(messagePattern).join(lineBreak);
  return new RegExp(`^${pattern}$`, "u").test(shownRows(draft, width));
}

/**
 * A message with pictures as Claude Code draws it while a picture is
 * still going in (as recorded: `[Image #11] [Image #12]<caption><path>`): each picture first, as
 * its chip or its path, then the caption word for word (its word boundaries kept, as `showsExactly` keeps them),
 * then at least one of its paths still going in, with or without a space before it. One picture per path in all.
 * Each picture's place is its own group, so the paths drawn can be
 * counted against the message's own (`pathsAllowed`); one layout per count of pictures before the caption. Empty
 * for a message with no picture.
 */
function picturesGoingIn(text: string): RegExp[] {
  const all = imagePaths(text);
  if (all.length === 0) return [];
  const paths = new Set(all);
  const caption = messageLines(text)
    .map((words) => words.filter((word) => !paths.has(word)))
    .filter((words) => words.length > 0)
    .map((words) => words.map(wordPattern).join(wordGap))
    .join(lineBreak);
  const path = `(?:${[...paths].map(wordPattern).join("|")})`;
  const picture = `(${chipShown}|${path})`;
  const layouts: RegExp[] = [];
  for (let first = 0; first < all.length; first += 1) {
    const before = `${picture}${wordGap}?`.repeat(first);
    const after = `${wordGap}?(${path})`.repeat(all.length - first);
    layouts.push(new RegExp(`^${before}${caption}${after}$`, "u"));
  }
  return layouts;
}

/**
 * The pictures one layout drew (each place's text, as matched) hold
 * each raw path no more times than `text` holds it; the chips stand for the rest. Chat's `abc /a.png /b.png` is
 * never Terminal's `abc /a.png /a.png` (a path repeated past its count, another missing).
 */
function pathsAllowed(drawn: readonly (string | undefined)[], text: string): boolean {
  const left = new Map<string, number>();
  for (const path of imagePaths(text)) left.set(path, (left.get(path) ?? 0) + 1);
  for (const place of drawn) {
    if (place === undefined) return false;
    const shown = place.replace(new RegExp(`[${wordWrap}${fullWrap}]`, "gu"), "");
    if (new RegExp(`^${chipShown}$`, "u").test(place)) continue;
    const allowed = left.get(shown);
    if (allowed === undefined || allowed === 0) return false;
    left.set(shown, allowed - 1);
  }
  return true;
}

/**
 * Claude's box holds exactly `text`, one message Chat sent, as a Send's cleanup may clear
 * it: `showsExactly` (word boundaries kept, each picture as its path or chip in place, or chips first), or a message
 * with pictures while one is still going in (`picturesGoingIn`). Unlike `isOwn`, the caption's spaces count: Terminal's
 * `a bc [Image #18]` is never Chat's `abc` with a picture. Each raw path is counted
 * against its own allowance (`pathsAllowed`), never one path standing for another.
 */
export function showsOwnSend(draft: string, text: string, width: number | null): boolean {
  if (showsExactly(draft, [text], width)) return true;
  if (draft.trim() === "") return false;
  const shown = shownRows(draft, width);
  return picturesGoingIn(text).some((layout) => {
    const match = layout.exec(shown);
    return match !== null && pathsAllowed(match.slice(1), text);
  });
}

/**
 * What Ctrl+U left of the pulled row is its start (`pulled`, as read after Up): the same rows up to
 * where it ends, a row break and the spaces of a wrap read as one space. Anything else is not ours to clear.
 */
export function pulledStart(left: string, pulled: string): boolean {
  const flat = (text: string): string => text.replace(/\s+/gu, " ").trim();
  const rest = flat(left);
  return rest !== "" && flat(pulled).startsWith(rest);
}

/** The most of your queued texts a take-back asks for (SentTexts keeps as many sends per pane). */
export const takeBackMost = 8;

/** What a take-back of your queued messages did (main/herdr/claude-box.ts takeBackQueued). */
export type QueuedTakeBack =
  /**
   * Nothing pressed, and nothing to say: a read of Claude's box showed no queue (it went, or the turn ended). Esc
   * stops as usual. Only that; a read that failed, a screen with no box, or a request
   * refused is `left`, so the press does not stop.
   */
  | { readonly type: "none" }
  /** Claude's input row held exactly `texts` (yours, oldest first) after Up and was proved empty after: they are Chat's again. */
  | { readonly type: "taken"; readonly texts: readonly string[]; readonly note: string }
  /** Nothing came back (`pressed`: Up, or Up and Ctrl+U, went first); the note says why and what to do. */
  | { readonly type: "left"; readonly note: string; readonly pressed: boolean };

/** The notes of a take-back, on the line under the box. No em dashes. */
export const takeBackTexts = {
  taken: "Taken back. Claude keeps working.",
  takenStillQueued: "Taken back. Claude Code still shows a queued message.",
  boxHasText: "Not taken back: Claude Code's box has other text. Esc again stops Claude.",
  notOurs: "Not taken back: the agent in this pane changed since you sent it.",
  changed: "Not taken back: the pane changed. Open Terminal to check Claude Code's box.",
  dialog: "Not taken back: Claude Code is asking something. Answer it first.",
  /** Herdr says the turn moved on since the send was queued (it ended, or another began). */
  alreadyGot: "Not taken back: Claude already received it.",
  /** Herdr showed another episode before Up: it may have gone as that turn's prompt. No key went. */
  notSure: "Not taken back: Claude may already have received it. Check the conversation before you send it again.",
  /** No box that reads at the bottom of Claude's screen (a dialog, a menu). No key went. */
  noBox: "Not taken back: Claude Code's box is not showing (a question or a menu may be open). Answer it in Terminal first.",
  /** The screen could not be read, or the request could not go. No key went. */
  unread: "Not taken back: Claude Code's screen could not be read. Esc again stops Claude.",
  /** More queued than a take-back asks for. */
  tooMany: `Not taken back: more than ${takeBackMost} of your messages are waiting. Open Terminal to take them back. Esc again stops Claude.`,
  /** The machine's connection is not the one the page shows. No key went. */
  connection: "Not taken back: the connection to this machine changed. Try again in a moment.",
  /** Up or a bubble's Take back with nothing of yours on Claude's screen (Esc stops then instead, with no note). */
  noQueue: "Not taken back: Claude Code shows no queued message. It may have gone to Claude already.",
  /** No session, or its transcript (Claude Code's queue record) could not be read. No key went. */
  unrecorded: "Not taken back: Claude Code's record of this session could not be read. Esc again stops Claude.",
  /** After Up, neither a pull nor a delivery showed in Claude Code's record in time. Nothing cleared. */
  notSureTaken: "Not sure it was taken back: check Claude's box in Terminal.",
  /** The pulled queue was not your texts alone. Nothing cleared. */
  alsoTerminal: "Not taken back: Claude's box also holds text typed in Terminal.",
  /** Claude received it, and Up left text in Claude's box that is not exactly yours. */
  alreadyGotBoxText: "Not taken back: Claude already received it. Claude's box now holds text; clear it in Terminal.",
  /** Pulled and cleared, but the empty box was not seen: your words are back here all the same. */
  takenCheckBox: "Taken back. Part of it may still show in Claude's box; clear it in Terminal before you send.",
} as const;

/** The cancelled message back in our box: its text first, then a newline and what you had typed. */
export function putBack(cancelled: string, composer: string): string {
  return composer === "" ? cancelled : `${cancelled}\n${composer}`;
}

export const claudeBoxTexts = {
  /** The box could not be emptied after one retry. */
  stillHasText: "Claude Code's box still has text. Open Terminal to clear it.",
  /** A send to a box holding our own message that would not empty. */
  notSentStillHasText: "Not sent: Claude Code's box still has text. Open Terminal to clear it.",
  /** A take-back left pulled or unknown text in Claude's row; no Send joins it. */
  pulledNotSent: "Not sent: Claude's box still holds the pulled message. Clear it in Terminal first.",
} as const;

/** After Herdr or the screen stops showing working, Esc still goes this long (the turn's edges). */
export const escGraceMs = 2_000;

/** The backstop: idle or done, no queue on screen, this long: a bubble may no longer say Queued. */
export const backstopMs = 5_000;

/**
 * Esc goes while Herdr's status or Claude's screen shows working, or
 * within 2 s after either last did; never at a settled idle (two Escs there
 * open Claude Code's rewind menu).
 */
export function escGoes(input: { readonly herdrWorking: boolean; readonly screenWorking: boolean; readonly lastWorkingMs: number | null; readonly nowMs: number }): boolean {
  if (input.herdrWorking || input.screenWorking) return true;
  return input.lastWorkingMs !== null && input.nowMs - input.lastWorkingMs < escGraceMs && input.nowMs >= input.lastWorkingMs;
}
