// Chat's box while the card shows the agent's question
// (the Swift app's CompanionChatAnswer): with a "No, tell…" option, the box's
// text and Send answer with it ("Tell Claude what to do instead (answers 3)");
// without one, the box says the agent is waiting on the question above, and a
// Send keeps the draft with that note.

import { agentName, sendAnswers, tellPlaceholder, waitingPlaceholder } from "./card";
import { readingMatch, type PromptMatch, type PromptOption, type PromptReading } from "./matcher";
import { answerTexts } from "./view";

export interface BoxAnswer {
  readonly placeholder: string;
  /** The question on the card, when it was matched. */
  readonly match: PromptMatch | null;
  /** The option the box's text answers with. */
  readonly tell: PromptOption | null;
  /** Why a Send of `text` (with `chips` attachments) does not go; null when it answers with `tell`. */
  refusal(text: string, chips: number): string | null;
}

export function boxAnswer(input: {
  /** Chat's card shows (Herdr says the agent waits on the user). */
  readonly asking: boolean;
  readonly reading: PromptReading | null;
  readonly kind: string | null | undefined;
  /** An answer is under way, or went and the screen has not moved on. */
  readonly busy: boolean;
}): BoxAnswer | null {
  if (!input.asking) return null;
  const match = input.reading === null ? null : readingMatch(input.reading);
  const tell = match?.options.find((option) => option.opensComposer) ?? null;
  const name = agentName(input.kind);
  return {
    placeholder: tell === null ? waitingPlaceholder(input.kind) : tellPlaceholder(input.kind, tell),
    match,
    tell,
    refusal(text: string, chips: number): string | null {
      if (match === null || tell === null) return answerTexts.waiting(name);
      if (input.busy) return `${answerTexts.busy}. The text is kept.`;
      if (chips > 0) return `Not sent: pictures and files cannot go with “${tell.label}”. The text is kept.`;
      return sendAnswers(tell, false, text.trim() !== "") === null ? answerTexts.emptyText : null;
    },
  };
}
