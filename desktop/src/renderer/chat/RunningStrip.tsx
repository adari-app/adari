// The Running strip, right above the message box while
// anything runs: one item per running shell, monitor and subagent (an icon per
// kind, its description on one line, the time it has run, ticking). A click
// opens a small panel above it with the command or the prompt (first lines)
// and a monitor's newest event (a subagent's newest step); Esc or a
// click elsewhere closes it, and while it is open it owns Esc (escape-owners.ts:
// Esc does not stop the agent). An item leaves when it ends; with many items the
// strip scrolls sideways (it never wraps under the box nor covers it).

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { runningWork, type ChatRunningKind, type ChatRunningWork } from "../../shared/chat/model";
import type { HostView } from "../../shared/ipc-contract";
import type { SidebarRow } from "../../shared/sidebar-model";
import { useEscapeOwner } from "../components/escape-owners";
import { AgentIcon, MonitorIcon, PromptIcon } from "../icons";
import { chatUpdates } from "./chat-state";
import { panelView, shownTimeline, stripItems } from "./running-strip";
import "../styles/running-strip.css";

/** The time now (seconds), once a second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1_000);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now() / 1_000);
    const timer = setInterval(() => setNow(Date.now() / 1_000), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function kindIcon(kind: ChatRunningKind): ReactNode {
  switch (kind) {
    case "shell":
      return <PromptIcon size={13} />;
    case "monitor":
      return <MonitorIcon size={13} />;
    case "agent":
      return <AgentIcon size={13} />;
  }
}

/** The strip for the pane's Chat: what its timeline runs, by Herdr's status. */
export function RunningStrip({ host, row }: { host: HostView; row: SidebarRow }) {
  const mine = useSyncExternalStore(chatUpdates.subscribe, () => chatUpdates.forPane(host.id, row.paneID));
  const live = mine?.state.status === "live";
  const items = live && mine !== undefined ? runningWork(shownTimeline(mine.timeline, row.status)) : [];
  return <RunningStripView items={items} />;
}

export function RunningStripView({ items, now }: { items: readonly ChatRunningWork[]; now?: number }) {
  const ticking = useNow(now === undefined && items.length > 0);
  const time = now ?? ticking;
  const [openID, setOpenID] = useState<string | null>(null);
  const open = openID === null ? undefined : items.find((item) => item.id === openID);
  const shown = open !== undefined;
  useEscapeOwner(shown);
  const ref = useRef<HTMLDivElement>(null);
  // Its item ended: the panel goes with it.
  useEffect(() => {
    if (openID !== null && !shown) setOpenID(null);
  }, [openID, shown]);
  useEffect(() => {
    if (!shown || typeof window.addEventListener !== "function") return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (ref.current !== null && target !== null && ref.current.contains(target)) return;
      setOpenID(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpenID(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [shown]);
  if (items.length === 0) return null;
  const strip = stripItems(items, time);
  const panel = open === undefined ? null : panelView(open);
  return (
    <div className="run-strip" ref={ref} aria-label="Running">
      {panel === null ? null : (
        <div className="run-panel" role="dialog" aria-label={panel.title}>
          <div className="rp-h">
            <span className="rp-k">{panel.label}</span>
            <span className="rp-t">{panel.title}</span>
          </div>
          {panel.step === null ? null : (
            <div className="rp-step">
              <span className="rp-l">Now</span>
              <span className="rp-v">{panel.step}</span>
            </div>
          )}
          {panel.lines.length === 0 ? null : (
            <div className="rp-sec">
              <div className="rp-l">{panel.heading}</div>
              <div className="rp-code">
                {panel.lines.map((line, index) => (
                  <div key={index} className="rp-line">
                    {line}
                  </div>
                ))}
                {panel.more > 0 ? <div className="rp-line dim">{`⋯ ${panel.more} more ${panel.more === 1 ? "line" : "lines"}`}</div> : null}
              </div>
            </div>
          )}
          {panel.event === null ? null : (
            <div className="rp-sec">
              <div className="rp-l">Newest event</div>
              <div className="rp-code">
                {panel.event.split("\n").slice(-3).map((line, index) => (
                  <div key={index} className="rp-line">
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <div className="run-items">
        {strip.map((item) => (
          <button
            key={item.id}
            className={item.id === openID ? "run-item open" : "run-item"}
            data-kind={item.kind}
            aria-expanded={item.id === openID}
            aria-haspopup="dialog"
            title={`${item.kindLabel}: ${item.title}`}
            onClick={() => setOpenID((current) => (current === item.id ? null : item.id))}
          >
            <span className="ri-i">{kindIcon(item.kind)}</span>
            <span className="ri-t">{item.title}</span>
            {item.step === null ? null : <span className="ri-s">{item.step}</span>}
            <span className="ri-e">{item.elapsed}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
