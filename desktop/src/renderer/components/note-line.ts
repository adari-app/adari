// The composer's one note line under
// the message box. Every composer note shows there, in full and wrapping, never
// in the chip row: a send's (the draft's), the needs-you card's box notes
// (prompt/view.ts), Stop's, Restart's (Chat's box) and a Model or Effort
// pick's. One shows at a time, in that order. A note clears when the agent's
// status changes, on the next send, or 8 s after it showed; one marked `held`
// (a restart under way) stays until it ends. One
// marked `lasting` (how a restart ended) stays through the 8 s and a status
// change, until the next send, its ×, or the next restart.

/** How long a note stays on the line. */
export const composerNoteMs = 8_000;

/** One source of notes for the line. */
export interface NoteSource {
  readonly text: string | null;
  dismiss(): void;
  /** It stays while its work runs (the 8 s, a status change and a send leave it). */
  readonly held?: boolean;
  /** It stays until the next send or its × (the 8 s and a status change leave it). */
  readonly lasting?: boolean;
}

/** The note the line shows (null: none) and how its × dismisses it. */
export interface NoteLine {
  readonly text: string;
  readonly held: boolean;
  readonly lasting: boolean;
  dismiss(): void;
}

export function noteLineOf(sources: readonly NoteSource[]): NoteLine | null {
  const source = sources.find((candidate) => candidate.text !== null && candidate.text !== "");
  if (source === undefined || source.text === null) return null;
  return { text: source.text, held: source.held === true, lasting: source.lasting === true, dismiss: () => source.dismiss() };
}
