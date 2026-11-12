// "While you were away" in the window:
// the screen in the main area (the View menu's While You Were Away) with a card per agent: its run, its
// last reply, the files it changed and the commits in its folder, grouped Needs
// you, Finished, Still working and Quiet (folded). A card opens its pane in
// Chat at the first message after you left. The main process reads the
// machines (src/main/away/service.ts); the page shows its state and says when
// the digest is on screen.

import { useEffect, useState } from "react";

import {
  awayGroupTitle,
  awayGroups,
  cardsIn,
  digestHasNews,
  digestSummaryText,
  initialAwayViewState,
  shortHash,
  type AwayCard,
  type AwayViewState,
} from "../../shared/away/digest";
import {
  awayTitle,
  cardLabel,
  cardPlace,
  cardStats,
  cardTime,
  errorLine,
  macLineText,
  relativePath,
  replyLine,
  transcriptNote,
} from "../../shared/away/text";
import type { HerdrDesktopBridge } from "../../shared/ipc-contract";
import type { SidebarGlyph } from "../../shared/sidebar-model";
import { Glyph } from "../components/Sidebar";
import { ChevronDownIcon, ChevronRightIcon, CloseIcon } from "../icons";

/** The main process's away state, kept current. */
export function useAwayState(bridge: Pick<HerdrDesktopBridge, "awayState" | "onAwayUpdate">): AwayViewState {
  const [state, setState] = useState<AwayViewState>(initialAwayViewState);
  useEffect(() => {
    // A page without the away channels (an older bridge) shows nothing.
    if (typeof bridge.onAwayUpdate !== "function") return;
    let live = true;
    const off = bridge.onAwayUpdate((next) => setState(next));
    void bridge.awayState().then(
      (next) => {
        if (live) setState(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  return state;
}

/** Says once per digest that it is on screen (leaving afterwards counts it as seen). */
function useShown(state: AwayViewState, visible: boolean, onShown: () => void): void {
  const generatedAt = state.digest?.generatedAt ?? null;
  useEffect(() => {
    if (visible && generatedAt !== null) onShown();
  }, [visible, generatedAt, onShown]);
}

function cardGlyph(card: AwayCard): SidebarGlyph {
  switch (card.status) {
    case "blocked":
      return "needsYou";
    case "working":
      return "working";
    case "done":
      return card.isNew ? "doneUnseen" : "idle";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

export interface AwayCardViewProps {
  readonly card: AwayCard;
  /** Seconds since 1970. */
  readonly now: number;
  onOpen(card: AwayCard): void;
}

export function AwayCardView({ card, now, onOpen }: AwayCardViewProps) {
  const time = cardTime(card, now);
  const stats = cardStats(card);
  const error = errorLine(card);
  const note = transcriptNote(card);
  const moreFiles = card.fileCount - card.files.length;
  const moreCommits = card.commitCount - card.commits.length;
  return (
    <button className={card.group === "needsYou" ? "away-card ny" : "away-card"} data-card={card.id} aria-label={cardLabel(card, now)} onClick={() => onOpen(card)}>
      <div className="away-card-h">
        <span className="st">
          <Glyph glyph={cardGlyph(card)} />
        </span>
        <span className="nm">{card.name}</span>
        <span className="kd">{card.kind}</span>
        <span className="pl">{cardPlace(card)}</span>
        <span className="sp" />
        {time === null ? null : <span className={card.waitingSince === null ? "tm" : "tm ny"}>{time}</span>}
      </div>
      {stats === null ? null : <div className="away-stats">{stats}</div>}
      {card.lastReply === null ? null : (
        <div className="away-reply">
          {card.lastReply.lines.map((line, index) => (
            <div key={index}>{replyLine(line)}</div>
          ))}
        </div>
      )}
      {card.files.length === 0 ? null : (
        <div className="away-files">
          {card.files.map((file) => (
            <span className="f" key={file}>
              {relativePath(file, card.folder)}
            </span>
          ))}
          {moreFiles > 0 ? <span className="more">+{moreFiles} more</span> : null}
        </div>
      )}
      {card.commits.length === 0 ? null : (
        <div className="away-commits">
          {card.commits.map((commit) => (
            <div className="c" key={commit.hash}>
              <span className="h">{shortHash(commit)}</span>
              <span className="s">{commit.subject}</span>
            </div>
          ))}
          {moreCommits > 0 ? <div className="more">+{moreCommits} more</div> : null}
        </div>
      )}
      {error === null ? null : <div className="away-err">{error}</div>}
      {note === null ? null : <div className="away-note">{note}</div>}
    </button>
  );
}

export interface AwayScreenProps {
  readonly state: AwayViewState;
  /** Seconds since 1970. */
  readonly now: number;
  onClose(): void;
  onOpenCard(card: AwayCard): void;
  onMarkSeen(): void;
  onShown(): void;
}

/** The screen in the main area. */
export function AwayScreen({ state, now, onClose, onOpenCard, onMarkSeen, onShown }: AwayScreenProps) {
  const [quietOpen, setQuietOpen] = useState(false);
  useShown(state, true, onShown);
  const digest = state.digest;
  const lines = digest === null ? [] : digest.macs.map((line) => macLineText(line, now)).filter((text): text is string => text !== null);
  const caughtUp = digest !== null && !digestHasNews(digest);
  return (
    <main className="main away">
      <div className="mh">
        <div className="who">
          <span className="nm">{awayTitle}</span>
          {digest === null || digest.cards.length === 0 ? null : <span className="wsn">{digestSummaryText(digest)}</span>}
        </div>
        <span className="sp" />
        {state.building ? <span className="away-reading">Reading…</span> : null}
        <button className="btn sm" disabled={digest === null || digest.cards.length === 0} onClick={onMarkSeen}>
          Mark all seen
        </button>
        <button className="ib" title="Close (Esc)" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="away-scroll">
        <div className="away-col">
          {lines.map((text) => (
            <div className="away-mac" key={text}>
              {text}
            </div>
          ))}
          {digest === null ? (
            <div className="away-empty">{state.building ? "Reading what your agents did…" : "Nothing to show yet."}</div>
          ) : caughtUp ? (
            <div className="away-empty">
              <h2>All caught up</h2>
              <div>{state.seenAt !== null ? "Marked as seen." : "Nothing happened since you last looked."}</div>
            </div>
          ) : null}
          {digest === null
            ? null
            : awayGroups.map((group) => {
                const cards = cardsIn(digest, group);
                if (cards.length === 0) return null;
                const folded = group === "quiet" && !quietOpen;
                return (
                  <section className="away-group" key={group} data-group={group}>
                    {group === "quiet" ? (
                      <button className="away-group-h" onClick={() => setQuietOpen((open) => !open)}>
                        <span>{awayGroupTitle(group)}</span>
                        <span className="c">{cards.length}</span>
                        <span className="chev">{folded ? <ChevronRightIcon /> : <ChevronDownIcon />}</span>
                      </button>
                    ) : (
                      <div className={group === "needsYou" ? "away-group-h ny" : "away-group-h"}>
                        <span>{awayGroupTitle(group)}</span>
                        <span className="c">{cards.length}</span>
                      </div>
                    )}
                    {folded ? null : cards.map((card) => <AwayCardView key={card.id} card={card} now={now} onOpen={onOpenCard} />)}
                  </section>
                );
              })}
        </div>
      </div>
    </main>
  );
}
