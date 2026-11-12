// The across-agents screen, opened from the sidebar: every machine in
// the sidebar, each workspace's agent panes with their folder's git and their
// session's own files, the agents with changes first. A row opens that
// agent's Changes. Read when it opens, on Refresh, when a machine comes or
// goes, and once when a pane leaves Working; never on a timer.
// Each machine is read on its own and shows its rows as it
// finishes. A pane leaving Working never ends the read running: it asks for
// one more after it (at most one waiting, however many turns finish). Only
// Refresh, a new set of machines and leaving the screen end a read.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentLine, changesText, overviewHostsItems, turnFinished, workingPanes, type ChangesOverviewHost, type ChangesOverviewItem } from "../../shared/changes/content";
import { rowHasChanges } from "../../shared/changes/overview";
import type { HerdrDesktopBridge, HostView } from "../../shared/ipc-contract";
import { ChevronLeftIcon, ChevronRightIcon, MonitorIcon, RefreshIcon } from "../icons";

export type ChangesOverviewBridge = Pick<HerdrDesktopBridge, "changesOverview" | "closeChanges">;

export interface ChangesOverviewProps {
  readonly bridge: ChangesOverviewBridge;
  readonly hosts: readonly HostView[];
  onOpenAgent(hostId: string, paneId: string): void;
  onClose(): void;
}

/** The machines listed and whether each answers: a change reads again. */
const machinesKey = (hosts: readonly HostView[]): string => hosts.map((host) => host.id + (host.state === "offline" ? ":off" : ":on")).join("|");

export function ChangesOverview({ bridge, hosts, onOpenAgent, onClose }: ChangesOverviewProps) {
  /** Each machine's last answer, by its id. */
  const [read, setRead] = useState<Readonly<Record<string, ChangesOverviewHost>>>({});
  const [refreshing, setRefreshing] = useState(true);
  const live = useRef(true);
  /** The current read (a newer one makes older answers stale), the machines it still waits for, and whether one more is asked. */
  const round = useRef(0);
  const pending = useRef(0);
  const again = useRef(false);
  const listed = useRef(hosts);
  listed.current = hosts;
  const machines = machinesKey(hosts);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      bridge.closeChanges();
    };
  }, [bridge]);

  /** Reads every machine that answers; `restart` ends the read running, else a read running is followed by one more. */
  const readAll = useCallback(
    (restart: boolean): void => {
      if (!restart && pending.current > 0) {
        again.current = true;
        return;
      }
      again.current = false;
      round.current += 1;
      const current = round.current;
      const online = listed.current.filter((host) => host.state !== "offline");
      pending.current = online.length;
      setRefreshing(online.length > 0);
      const settled = (host: HostView, answer: ChangesOverviewHost | null): void => {
        if (!live.current || current !== round.current) return;
        // An ended read keeps what was shown; with nothing shown yet it says so rather than spin.
        setRead((before) => (answer !== null ? { ...before, [host.id]: answer } : before[host.id] !== undefined ? before : { ...before, [host.id]: failedHost(host) }));
        pending.current -= 1;
        if (pending.current > 0) return;
        if (again.current) readAll(false);
        else setRefreshing(false);
      };
      for (const host of online) {
        void bridge.changesOverview(host.id).then(
          (answer) => settled(host, answer),
          () => settled(host, failedHost(host)),
        );
      }
    },
    [bridge],
  );

  useEffect(() => {
    readAll(true);
  }, [readAll, machines]);

  // A turn finished (a pane left Working): read again, once, after the read running.
  const working = useMemo(() => workingPanes(hosts), [hosts]);
  const lastWorking = useRef(working);
  useEffect(() => {
    if (turnFinished(lastWorking.current, working)) readAll(false);
    lastWorking.current = working;
  }, [working, readAll]);

  const items: ChangesOverviewItem[] = overviewHostsItems(
    hosts.map(
      (host): ChangesOverviewHost =>
        host.state === "offline" ? { hostId: host.id, name: host.name, state: "offline", groups: [] } : (read[host.id] ?? { hostId: host.id, name: host.name, state: "loading", groups: [] }),
    ),
  );

  return (
    <main className="main changes-overview" data-testid="changes-overview">
      <div className="mh">
        <button type="button" className="ib" aria-label="Back" onClick={onClose}>
          <ChevronLeftIcon size={16} />
        </button>
        <span className="who">
          <span className="nm" role="heading" aria-level={1}>
            {changesText.title}
          </span>
          <span className="wsn">{changesText.entrySubtitle}</span>
        </span>
        <span className="sp" />
        <button type="button" className={refreshing ? "ib on" : "ib"} aria-label="Refresh" aria-busy={refreshing} onClick={() => readAll(true)}>
          <RefreshIcon size={14} />
        </button>
      </div>
      <div className="ch-scroll">
        <div className="ch-col">{items.map((item) => drawItem(item, onOpenAgent))}</div>
      </div>
    </main>
  );
}

function drawItem(item: ChangesOverviewItem, open: (hostId: string, paneId: string) => void) {
  const kind = item.kind;
  switch (kind.type) {
    case "mac":
      return (
        <div key={item.id} data-item={item.id} className="ov-mac" role="heading" aria-level={2}>
          <MonitorIcon size={14} />
          <span className="t">{kind.name}</span>
          {kind.detail === null ? null : <span className="d">{kind.detail}</span>}
        </div>
      );
    case "workspace":
      return (
        <div key={item.id} data-item={item.id} className="ov-ws" role="heading" aria-level={3}>
          {kind.name}
        </div>
      );
    case "note":
      return (
        <div key={item.id} data-item={item.id} className="ch-note">
          {kind.text}
        </div>
      );
    case "loading":
      return (
        <div key={item.id} data-item={item.id} className="ch-loading" aria-live="polite">
          <span className="ch-spin" aria-hidden="true" />
          {changesText.readingEveryAgent}
        </div>
      );
    case "agent": {
      const row = kind.row;
      const line = agentLine(row);
      const changed = rowHasChanges(row);
      return (
        <button
          key={item.id}
          type="button"
          data-item={item.id}
          className={changed ? "ov-agent changed" : "ov-agent"}
          aria-label={`${row.pane.name}, ${row.pane.kind}, ${line}`}
          onClick={() => open(kind.hostId, row.pane.paneId)}
        >
          <span className="dot" aria-hidden="true" />
          <span className="body">
            <span className="top">
              <span className="nm">{row.pane.name}</span>
              <span className="kd mono">{row.pane.kind}</span>
            </span>
            {row.pane.folder === null ? null : <span className="fd mono">{row.pane.folder}</span>}
            <span className="ln">{line}</span>
          </span>
          <ChevronRightIcon size={12} />
        </button>
      );
    }
  }
}

const failedHost = (host: HostView): ChangesOverviewHost => ({ hostId: host.id, name: host.name, state: "failed", groups: [] });
