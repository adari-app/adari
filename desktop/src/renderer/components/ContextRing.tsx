// The context ring just left of the paperclip,
// for a Claude or Codex pane. It fills with used / limit (the accent below
// 80%, amber from 80%, red from 90%; its tooltip "212k of 400k"); hovering or
// clicking it opens its card: "Context", "53% · 212k / 400k", a bar with a
// tick where it compacts, where the limit comes from, and Compact. Compact
// goes the hidden way the chips' picks go (agent-picks.ts: never in your box,
// no command in Chat); while the pane works or shows a dialog it reads
// "Compact after this turn" and holds one; the ring spins until the
// transcript shows the compaction, and Chat says "Compacted" once.
//
// A Cursor pane's ring takes its footer's share of the
// window (`256K`, `· 6.8%`), shown only while a footer reads; its card has no
// Compact (Cursor compacts by itself).

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { HostView } from "../../shared/ipc-contract";
import type { SidebarRow } from "../../shared/sidebar-model";
import { contextView, type ContextView } from "../../shared/context-meter";
import { agentPicks, pickContext, type CompactState, type PickContext } from "./agent-picks";
import { contextScreens } from "./context-screens";
import { draftKey } from "./composer-drafts";
import { useEscapeOwner } from "./escape-owners";

/** Compact's state on the card: held, running, waiting for the pane's turn to end (not held yet), or ready. */
export type CardState = CompactState | "waits";

export interface ContextCardView {
  readonly title: string;
  readonly headline: string;
  readonly source: string | null;
  readonly button: string;
  readonly disabled: boolean;
}

/** The card's words. */
export function contextCard(view: ContextView, state: CardState): ContextCardView {
  const button = state === "running" ? "Compacting…" : state === "held" || state === "waits" ? "Compact after this turn" : "Compact";
  return { title: "Context", headline: view.headline, source: view.source, button, disabled: state === "held" || state === "running" };
}

const radius = 6;
const circumference = 2 * Math.PI * radius;

export function ContextRing({ host, row }: { host: HostView; row: SidebarRow }) {
  useSyncExternalStore(agentPicks.subscribe, agentPicks.version);
  useSyncExternalStore(contextScreens.subscribe, contextScreens.version);
  const key = draftKey(host.id, row.paneID);
  // A Grok pane's ring from its signals.json, only with both its numbers;
  // without them it has no ring, and its card no Esc (as a pane the ring does not read).
  const picked = row.isAgent ? pickContext(host, row.paneID) : null;
  const grokRead = (binding: PickContext["binding"]): boolean => {
    const values = agentPicks.settings(key, binding);
    return values.used !== null && values.used !== undefined && values.window !== null && values.window !== undefined && values.window > 0;
  };
  const context = picked === null || (picked.agent === "grok" && !grokRead(picked.binding)) ? null : picked;
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  // A card shown owns Esc (it closes it), not Stop, whether a click pinned it or the pointer
  // shows it; one whose context went does not.
  const held = (pinned || hover) && context !== null;
  useEscapeOwner(held);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setPinned(false);
    setHover(false);
  }, [key]);
  // Its context gone (the pane's agent now a kind the ring does not read): the card is not pinned or hovered when it comes back.
  const gone = context === null;
  useEffect(() => {
    if (!gone) return;
    setPinned(false);
    setHover(false);
  }, [gone]);
  useEffect(() => {
    if (!held || typeof window.addEventListener !== "function") return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (ref.current !== null && target !== null && !ref.current.contains(target)) setPinned(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Closed, however it was shown (the pointer still over the ring shows it again only when it comes back).
      setPinned(false);
      setHover(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [held]);
  // OpenCode's pane has the Model chip only.
  if (context === null || context.agent === "opencode") return null;
  const cursor = context.agent === "cursor";
  const grok = context.agent === "grok";
  if (cursor && agentPicks.cursorFooter(key, context.binding) === null) return null;
  const settings = agentPicks.settings(key, context.binding);
  const view = contextView({
    agent: context.agent,
    used: settings.used ?? null,
    window: settings.window ?? null,
    model: settings.model,
    limits: agentPicks.limits(key, context.binding),
    screenRemaining: contextScreens.remaining(key, context.binding, { compactedAt: settings.compactedAt ?? null, usedAt: settings.usedAt ?? null }),
  });
  const compacting = agentPicks.compacting(key, context.binding);
  const atPrompt = context.status === "idle" || context.status === "done";
  const card = contextCard(view, compacting ?? (atPrompt ? null : "waits"));
  const fill = view.percent === null ? (view.used === null ? 0 : 0.12) : view.percent / 100;
  const open = pinned || hover;
  // Compacting shows by a class of the ring's own; with `spin`, Chat's spinner rule (chat.css
  // `.spin`) landed on this button too and it drew as two rings that did not line up.
  return (
    <span className={`ctx-ring-w${open ? " open" : ""}`} ref={ref} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        className={`cmp-ib ctx-ring ${view.level}${compacting === "running" ? " compacting" : ""}`}
        aria-label={`Context: ${view.tooltip}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={view.tooltip}
        onClick={() => setPinned(!pinned)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="trk" cx="8" cy="8" r={radius} />
          <circle
            className="fill"
            cx="8"
            cy="8"
            r={radius}
            strokeDasharray={`${(fill * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>
      {open ? (
        <div className="ctx-card" role="dialog" aria-label="Context">
          <div className="cc-t">{card.title}</div>
          <div className="cc-h">{card.headline}</div>
          <div className="cc-bar">
            <span className={`cc-f ${view.level}`} style={{ width: `${view.percent ?? 0}%` }} />
            {view.tickPercent === null ? null : <span className="cc-tick" style={{ left: `${view.tickPercent}%` }} title="Where it compacts" />}
          </div>
          {card.source === null ? null : <div className="cc-s">{card.source}</div>}
          {cursor || grok ? null : (
          <button
            className={card.disabled ? "btn sm off" : "btn sm"}
            aria-disabled={card.disabled}
            onClick={() => {
              if (card.disabled) return;
              agentPicks.pick(context, { kind: "compact", value: "compact", label: "Compact" });
            }}
          >
            {card.button}
          </button>
          )}
        </div>
      ) : null}
    </span>
  );
}
