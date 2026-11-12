// The needs-you card at the end of Chat: while Herdr says the shown agent is blocked or
// input-pending, the question its pane shows, as main read it.
//
// - Matched: "Claude wants to run / edit / create" or "Claude asks", the file
//   or command in mono, up to six diff rows and "N more", the question in the
//   agent's words, the numbered options (the one Return picks filled
//   vermilion). A click, a digit 1–9, ↑ ↓ and Return answer (the keys only
//   while no text field has the focus and nothing on top owns the keys), each
//   through main's fingerprint check. After an answer: "Sent: Yes" until the
//   screen moves on.
// - Unmatched: its lines in mono and Answer in Terminal (the pane's
//   Terminal, where its own keys answer it).
// - Not read yet: "Reading the question on <machine>…".
// - Grok 1.0.70's approval frame: "Grok wants to run", the
//   frame's title, the command whole, Grok's options in its order and words. On
//   a Grok pane the card shows only while the frame (or part of it) is on
//   screen: a read with nothing prompt-like hides it. An answer whose screen did
//   not show it take leaves the card as the screen says, with Answer in Terminal.
// - Codex's tool-call question: "Codex wants to use a
//   tool", Codex's header, its parameter rows, and each option's label with its
//   description under it, one per row, in Codex's order (nothing hidden).
// - Claude's command of more than one row shows
//   under the header as a block, its first six rows and "N more", with the
//   description Claude draws over it. Claude's frame read without its header
//   (a command taller than the screen) is unmatched: Answer in Terminal under
//   the screen's lines, never buttons. When the screen agrees with
//   exactly one of Chat's running tool calls, the card shows that call above
//   the lines, labelled as Chat's and not read from the question (its tool,
//   description and first lines, or the file's name as the question gives it).
// - Codex's update question at start: "Codex has an
//   update", its first line, and its three choices in its words ("Update now
//   (runs `npm install -g @openai/codex`)", "Skip", "Skip until next
//   version"), answered with its own keys (Return for the marked one, Esc for
//   Skip); a choice whose key is not known shows the Terminal instead.

import { useEffect, useRef, useSyncExternalStore } from "react";

import type { ChatToolCall } from "../../shared/chat/model";
import type { HostView } from "../../shared/ipc-contract";
import type { SidebarRow } from "../../shared/sidebar-model";
import { agentName, cardContent, cardKeyAction, keptLines, keyHint, moreLinesLabel, type CardLine } from "../../shared/prompt/card";
import { readingCut, readingMatch, sideBySide, type PromptMatch } from "../../shared/prompt/matcher";
import { promptSubject, type PromptSubject } from "../../shared/prompt/subject";
import type { PanePrompt } from "../../shared/prompt/view";
import { escapeOwners } from "../components/escape-owners";
import { keyOrigins, windowEscStops } from "../components/agent-stop";
import { needsCards } from "./needs-card-store";
import { startScreenOf, startScreenTexts } from "../../shared/prompt/start-screen";

export interface NeedsCardProps {
  readonly host: HostView;
  readonly row: SidebarRow;
  /** Shows the pane's Terminal (Answer in Terminal). */
  readonly onShowTerminal: () => void;
  /** The card takes the keys (the one pane view, or the focused tile). */
  readonly keysActive?: boolean;
  /** Chat's running tool calls (subject.ts pendingToolCalls); words for a frame read without its header, nothing more. */
  readonly pending?: readonly ChatToolCall[];
}

const sign: Record<CardLine["kind"], string> = { added: "+", removed: "−", context: " " };

/**
 * The card shows: Herdr says the agent waits on the user;
 * on a Grok pane, not once main's last read showed nothing prompt-like (the
 * frame left the screen; Grok's waits show only there).
 */
export function needsCardShown(row: Pick<SidebarRow, "isAgent" | "status"> & { readonly kind?: string | null }, prompt: PanePrompt | null = null): boolean {
  if (!row.isAgent || row.status !== "blocked") return false;
  return !(row.kind?.toLowerCase() === "grok" && prompt !== null && prompt.reading?.type === "unmatched" && prompt.quiet);
}

/** A command's rows in mono and "N more" under them. */
function CommandRows({ rows, more }: { readonly rows: readonly string[]; readonly more: number }) {
  const label = moreLinesLabel(more);
  return (
    <div className="nc-run">
      <pre className="nc-cmd">{rows.join("\n")}</pre>
      {label === null ? null : <div className="nc-more">{label}</div>}
    </div>
  );
}

/**
 * Chat's running call the screen agrees with, over a frame read
 * without its header, under its label: Chat's words, not the question's, and nothing that answers.
 */
function SubjectLines({ subject }: { readonly subject: PromptSubject }) {
  return (
    <div className="nc-subj">
      <div className="nc-from">Chat’s running call, not read from the question:</div>
      {subject.file === null ? (
        <div className="nc-desc">{subject.description === null ? subject.toolName : `${subject.toolName}: ${subject.description}`}</div>
      ) : (
        <div className="nc-desc">
          {`${subject.toolName} `}
          <code className="nc-file">{subject.file}</code>
        </div>
      )}
      {subject.rows.length === 0 ? null : <CommandRows rows={subject.rows.slice(0, keptLines)} more={Math.max(0, subject.rows.length - keptLines)} />}
    </div>
  );
}

export function NeedsCard({ host, row, onShowTerminal, keysActive = true, pending }: NeedsCardProps) {
  const bridge = window.herdrDesktop;
  useEffect(() => needsCards.attach(bridge), [bridge]);
  useSyncExternalStore(needsCards.subscribe, needsCards.version, needsCards.version);
  const prompt = needsCards.forPane(host.id, row.paneID);
  const shown = needsCardShown(row, prompt);
  const card = needsCards.card(host.id, row.paneID);
  const match = prompt === null || prompt.reading === null ? null : readingMatch(prompt.reading);
  const content = match === null ? null : cardContent(match, row.kind);
  // A frame read without its header (always unmatched), and Chat's call the screen agrees with.
  const subject = prompt === null ? null : promptSubject(pending, readingCut(prompt.reading));
  const selection = match === null || content === null ? 0 : needsCards.selection(host.id, row.paneID, match, content.returnIndex);
  const answering = card.busy || card.sent !== null;

  const pick = (target: PromptMatch, index: number): void => {
    const option = target.options[index];
    if (option === undefined) return;
    // A choice answered in the Terminal (its key is not known here): nothing is sent.
    if (option.inTerminal === true) {
      onShowTerminal();
      return;
    }
    needsCards.select(host.id, row.paneID, target, index);
    void needsCards.answer(bridge, host, row.paneID, row.kind, target, option);
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;

  // The card's keys: digits, ↑ ↓ and Return, while no text field has the focus.
  const keyed = shown && keysActive && match !== null && !answering && host.state === "connected";
  const paneId = row.paneID;
  const hostId = host.id;
  useEffect(() => {
    if (!keyed || match === null || typeof window.addEventListener !== "function") return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || escapeOwners.any()) return;
      const active = typeof document === "undefined" ? null : document.activeElement;
      const free = windowEscStops(active, null, paneId, keyOrigins(event));
      const index = needsCards.selection(hostId, paneId, match, cardContent(match, null).returnIndex);
      const action = cardKeyAction(
        { key: event.key, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey, textFocused: !free, composing: event.isComposing },
        match.options,
        index,
      );
      if (action.type === "none") return;
      event.preventDefault();
      if (action.type === "select") needsCards.select(hostId, paneId, match, action.index);
      else pickRef.current(match, action.index);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyed, match, hostId, paneId]);

  if (!shown) return null;
  const agent = agentName(row.kind);
  // The last answer's note shows under every kind of card.
  const note = card.note === null ? null : <div className="nc-note">{card.note}</div>;

  // An agent's start screen (Codex's hook review): what it asks and
  // where to answer it. Nothing here answers it (no option, no key).
  const startScreen = startScreenOf(host, row.paneID);
  if (startScreen !== null) {
    return (
      <div className="ncard" data-needs-card="startScreen" data-start-screen={startScreen.kind} tabIndex={-1}>
        <div className="nc-h">
          <span className="dot" />
          <span className="nc-t">{`${agent} needs you`}</span>
        </div>
        <div className="nc-desc">{startScreenTexts[startScreen.kind]}</div>
        <div className="nc-foot">
          <button className="btn sm nc-term" onClick={onShowTerminal}>
            Show the terminal
          </button>
        </div>
      </div>
    );
  }

  if (prompt === null || prompt.reading === null) {
    return (
      <div className="ncard" data-needs-card="reading" tabIndex={-1}>
        <div className="nc-h">
          <span className="dot" />
          <span className="nc-t">{`${agent} needs you`}</span>
        </div>
        <div className="nc-reading">
          <span className="spin" />
          {`Reading the question on ${host.name}…`}
        </div>
        {note}
      </div>
    );
  }

  if (match === null || content === null) {
    const lines = prompt.reading.type === "unmatched" ? prompt.reading.lines : [];
    return (
      <div className="ncard" data-needs-card="unmatched" data-subject={subject?.kind} tabIndex={-1}>
        <div className="nc-h">
          <span className="dot" />
          <span className="nc-t">{`${agent} needs you`}</span>
        </div>
        {subject === null ? null : <SubjectLines subject={subject} />}
        {lines.length === 0 ? null : <pre className="nc-lines">{lines.join("\n")}</pre>}
        <div className="nc-foot">
          <button className="btn sm nc-term" onClick={onShowTerminal}>
            Answer in Terminal
          </button>
          <span className="nc-hint">The app cannot read this question’s options; its own keys answer it there.</span>
        </div>
        {note}
      </div>
    );
  }

  const more = moreLinesLabel(content.moreLines);
  // Options with their descriptions go one per row.
  const described = content.options.some((option) => option.detail !== undefined);
  return (
    <div className="ncard" data-needs-card={content.kind} tabIndex={-1}>
      <div className="nc-h">
        <span className="dot" />
        <span className="nc-t">{content.header}</span>
        {content.target === null ? null : (
          <code className="nc-target" title={content.target}>
            {content.target}
          </code>
        )}
      </div>
      {content.description === null ? null : <div className="nc-desc">{content.description}</div>}
      {content.commandRows.length === 0 ? null : <CommandRows rows={content.commandRows} more={content.commandMore} />}
      {content.lines.length === 0 ? null : (
        <div className="nc-diff">
          {content.lines.map((line, index) => (
            <div key={index} className={`dl ${line.kind}`}>
              <span className="n">{line.number ?? ""}</span>
              <span className="s">{sign[line.kind]}</span>
              <span className="t">{line.text}</span>
            </div>
          ))}
          {more === null ? null : <div className="dl more">{more}</div>}
        </div>
      )}
      <div className="nc-q">{content.question}</div>
      {content.command === null ? null : <pre className="nc-cmd">{content.command}</pre>}
      {content.parameters.length === 0 ? null : <pre className="nc-params">{content.parameters.join("\n")}</pre>}
      {card.sent !== null ? (
        <div className="nc-sent" data-sent={card.sent.label}>{`Sent: ${card.sent.label}`}</div>
      ) : (
        <>
          <div className={sideBySide(match) && !described ? "nc-opts row" : "nc-opts"} role="group" aria-label={content.question}>
            {content.options.map((option, index) => (
              <button
                key={option.key}
                className={index === selection ? "nc-opt on" : "nc-opt"}
                data-key={option.key}
                disabled={card.busy || host.state !== "connected"}
                onClick={() => pick(match, index)}
              >
                <span className="k">{option.key}</span>
                <span className="l">{option.label}</span>
                {option.detail === undefined ? null : <span className="d">{option.detail}</span>}
              </button>
            ))}
          </div>
          <div className="nc-hint">{keyHint(content)}</div>
        </>
      )}
      {card.terminal === null ? null : (
        <div className="nc-foot">
          <button className="btn sm nc-term" onClick={onShowTerminal}>
            Answer in Terminal
          </button>
        </div>
      )}
      {note}
    </div>
  );
}
