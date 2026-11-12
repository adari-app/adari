// What the needs-you card may say about a Claude Code approval frame whose top
// (the "Bash command" header) is above the screen. The screen cannot say what
// it asks, so the card shows Chat's running tool call, labelled as Chat's and
// not read from the question, never as what Claude wants, and never with
// answer buttons: a cut frame is unmatched and is answered in Terminal.
//
// A call is shown only when the screen agrees with it and no other running
// call does:
// - a command: the rows on screen are the end of its command, compared as
//   written (the spaces inside a row count), only the terminal's row breaks
//   and the frame's indentation set aside;
// - an edit or a new file: the question names its file, the whole name as a
//   word; the card then shows that name as the screen gives it, not the
//   call's folder.
// The calls are those of the newest turn while it runs; a finished turn lends
// none, and no earlier turn is looked at.

import type { ChatTimeline, ChatToolCall } from "../chat/model";
import type { CutFrame } from "./matcher";

export interface PromptSubject {
  readonly kind: "run" | "edit" | "create";
  /** The tool's name as the agent wrote it ("Bash", "Edit"). */
  readonly toolName: string;
  /** The call's description (a command's); null without one, and for a file. */
  readonly description: string | null;
  /** The file's name as the question on screen gives it; null for a command. */
  readonly file: string | null;
  /** A command's lines (trailing blank lines dropped); empty for a file. */
  readonly rows: readonly string[];
}

/** The newest turn's tool calls with no result yet, while that turn runs: none a shell command the user ran, none run in the background, none a subagent's. */
export function pendingToolCalls(timeline: Pick<ChatTimeline, "turns">): ChatToolCall[] {
  const turn = timeline.turns.at(-1);
  if (turn === undefined || turn.isFinished) return [];
  return turn.items.flatMap((item) => {
    if (item.type !== "toolCall") return [];
    const call = item.value;
    return call.state === "running" && !call.isUserShell && call.task === undefined && call.subagent === undefined ? [call] : [];
  });
}

/**
 * Whether `command` ends in `rows` (the frame's body rows on screen, each
 * trimmed): from its end back, each row as written, with only whitespace
 * (a line break and its indentation, or the space a word-wrap took) or
 * nothing (a word cut at the screen's edge) between two rows.
 */
export function commandEndsWith(command: string, rows: readonly string[]): boolean {
  if (rows.length === 0) return false;
  let at = command.replace(/\s+$/u, "").length;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row === "") return false;
    if (index < rows.length - 1) while (at > 0 && /\s/u.test(command.charAt(at - 1))) at -= 1;
    if (!command.slice(0, at).endsWith(row)) return false;
    at -= row.length;
  }
  return true;
}

/** The file's last path part. */
function baseName(path: string): string {
  return path.split("/").filter((part) => part !== "").at(-1) ?? "";
}

/** Whether the question names `name` whole: one of its words, a final "?" or "," aside. */
function namesFile(question: string, name: string): boolean {
  return question.split(/\s+/u).some((word) => word.replace(/[?,]+$/u, "") === name);
}

/** What one call says of the cut frame `cut`, when the screen agrees with it; null otherwise. */
function subjectOf(call: ChatToolCall, cut: CutFrame): PromptSubject | null {
  if (call.toolName === "Bash" && call.detail.type === "bash") {
    const command = call.detail.bash.command;
    if (!commandEndsWith(command, cut.rows)) return null;
    return { kind: "run", toolName: call.toolName, description: call.bashDescription ?? null, file: null, rows: command.replace(/\s+$/u, "").split("\n") };
  }
  if (call.kind === "edit" && (call.toolName === "Edit" || call.toolName === "MultiEdit" || call.toolName === "Write")) {
    const name = baseName(call.target);
    if (name === "" || !namesFile(cut.question, name)) return null;
    return { kind: call.toolName === "Write" ? "create" : "edit", toolName: call.toolName, description: null, file: name, rows: [] };
  }
  return null;
}

/** What the card says of the cut frame `cut`: the one running call the screen agrees with; null when none does, or more than one. */
export function promptSubject(calls: readonly ChatToolCall[] | null | undefined, cut: CutFrame | null | undefined): PromptSubject | null {
  if (calls === null || calls === undefined || cut === null || cut === undefined) return null;
  const named = calls.flatMap((call) => {
    const subject = subjectOf(call, cut);
    return subject === null ? [] : [subject];
  });
  return named.length === 1 ? named[0]! : null;
}
