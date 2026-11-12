// The sidebar: machines, their workspaces and panes, one line per row, with the
// agents that need you lifted into a group at the top, as the phone does.
// Projects shows each machine's tree; Priority merges every machine by status.

import { Fragment, useEffect, useRef, type ReactNode } from "react";

import { foldedMachineRows, rowKey as desktopRowKey, type DesktopRow, type DesktopSidebar } from "../../shared/desktop-sidebar";
import { prioritySectionTitle, type SidebarGlyph, type SidebarMode, type SidebarPrioritySectionKind, type SidebarRow } from "../../shared/sidebar-model";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  FolderOpenIcon,
  MonitorIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "../icons";
import { AgentGlyph, agentName } from "./agent-kind";
import { UpdateMark } from "./UpdateMark";
import { RenameField } from "./RenameField";
import { paneRenameKey, workspaceRenameKey } from "../../shared/pane-manage";
import { isCoreID } from "../../shared/core-ids";
import { needsPill, type NeedsPill as NeedsPillValue, type NeedsPillKind } from "../../shared/needs-pill";
import { useSidebarWidth } from "./sidebar-width";

const glyphClass: Record<SidebarGlyph, string> = {
  needsYou: "g ny",
  working: "g work",
  doneUnseen: "g done",
  idle: "g idle",
  unknown: "g unknown",
  shell: "g shell",
};

export function Glyph({ glyph }: { glyph: SidebarGlyph }) {
  return <i className={glyphClass[glyph]} />;
}

function rowClass(row: SidebarRow, selected: boolean, placed: boolean, shown = false): string {
  return ["row", placed ? "placed" : "", row.glyph === "needsYou" ? "ny" : "", row.isDimmed ? "idle" : "", selected ? "sel" : "", shown && !selected ? "shown" : ""]
    .filter(Boolean)
    .join(" ");
}

/** T3 Code's status pill on a row that needs you: its dot and its words (src/shared/needs-pill.ts). */
function NeedsPill({ pill }: { pill: NeedsPillValue }) {
  return (
    <span className={`pill ${pill.kind}`}>
      <i />
      {pill.label}
    </span>
  );
}

interface RowProps {
  readonly row: SidebarRow;
  readonly rowKey: string;
  readonly selected: boolean;
  /** On screen in the main area's tiles. */
  readonly shown?: boolean;
  /** Where the row lives, shown instead of its activity in cross-machine groups. */
  readonly place?: string;
  readonly onSelect: () => void;
  /** Right-click: the row's menu at the pointer. */
  readonly onMenu: (x: number, y: number) => void;
  /** The blocked pane's reading (absent: not known); drawn only while Herdr says it needs you. */
  readonly pillKind?: NeedsPillKind;
}

/**
 * A row's whole text, for its tooltip (a row cut off shows it on hover): its name and its second
 * text (its activity, or where it lives), then its folder on a line of its own.
 */
function rowTitle(row: SidebarRow, second: string | undefined): string {
  const text = [row.name, second ?? ""].filter((part) => part !== "").join(" · ");
  return row.cwd === undefined || row.cwd === "" ? text : `${text}\n${row.cwd}`;
}

/** Beside a pill the title is in its own box, which goes when it would show only a letter (app.css). */
function titled(text: string, pill: NeedsPillValue | null): ReactNode {
  return pill === null ? text : <span className="fit">{text}</span>;
}

function Row({ row, rowKey, selected, shown = false, place, onSelect, onMenu, pillKind }: RowProps) {
  const pill = needsPill(row, pillKind);
  return (
    <button
      className={rowClass(row, selected, place !== undefined, shown)}
      data-row={rowKey}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
      title={rowTitle(row, place ?? row.activity)}
    >
      <span className="st">
        <Glyph glyph={row.glyph} />
      </span>
      <span className="nm">{row.name}</span>
      {row.updateReady === true ? <UpdateMark kind={row.kind} /> : null}
      {row.isAgent ? (
        <span className="kd" title={agentName(row.kind)}>
          <AgentGlyph kind={row.kind} />
        </span>
      ) : null}
      {pill === null ? null : <NeedsPill pill={pill} />}
      {place === undefined ? <span className="act">{titled(row.activity ?? "", pill)}</span> : <span className="ws2">{titled(place, pill)}</span>}
      {row.time === undefined ? null : <span className="tm">{row.time}</span>}
    </button>
  );
}

interface DesktopRowViewProps {
  readonly entry: DesktopRow;
  readonly selectedKey: string | null;
  readonly shownKeys?: ReadonlySet<string>;
  readonly needsPills?: ReadonlyMap<string, NeedsPillKind>;
  onSelect(hostId: string, paneId: string): void;
  onRowMenu(hostId: string, paneId: string, x: number, y: number): void;
}

function DesktopRowView({ entry, selectedKey, shownKeys, needsPills, onSelect, onRowMenu }: DesktopRowViewProps) {
  return (
    <Row
      row={entry.row}
      rowKey={entry.key}
      selected={entry.key === selectedKey}
      shown={shownKeys?.has(entry.key) === true}
      place={`${entry.row.workspaceLabel} · ${entry.hostName}`}
      pillKind={needsPills?.get(entry.key)}
      onSelect={() => onSelect(entry.hostId, entry.row.paneID)}
      onMenu={(x, y) => onRowMenu(entry.hostId, entry.row.paneID, x, y)}
    />
  );
}

function GroupHeader(props: {
  title: string;
  count: number;
  needsYou?: boolean;
  folded: boolean;
  onToggle: () => void;
}) {
  return (
    <button className={props.needsYou === true ? "grp-h ny" : "grp-h"} onClick={props.onToggle}>
      <span>{props.title}</span>
      <span className="c">{props.count}</span>
      <span className="sp" />
      <span className="chev">{props.folded ? <ChevronRightIcon /> : <ChevronDownIcon />}</span>
    </button>
  );
}

export interface SidebarProps {
  readonly sidebar: DesktopSidebar;
  readonly selectedKey: string | null;
  /** Every pane on screen in the main area (the selected one and the other tiles). */
  readonly shownKeys?: ReadonlySet<string>;
  readonly search: string | null;
  readonly demo: boolean;
  /** Machines folded to their header (ignored while searching). */
  readonly foldedHosts: ReadonlySet<string>;
  /**
   * Each blocked pane's reading, by row key (desktop-sidebar rowKey): Pending Approval or Awaiting
   * Input on its row (absent: not known, Awaiting Input). The pill shows only while Herdr says the pane needs you.
   */
  readonly needsPills?: ReadonlyMap<string, NeedsPillKind>;
  onSelect(hostId: string, paneId: string): void;
  /** A row's right-click (its menu: Open in Ghostty). */
  onRowMenu(hostId: string, paneId: string, x: number, y: number): void;
  onToggleHost(hostId: string): void;
  /** A machine header's right-click (its menu: Edit machine…). */
  onHostMenu(hostId: string, x: number, y: number): void;
  /** Try again, beside a refused sign-in. */
  onRetryHost(hostId: string): void;
  onMode(mode: SidebarMode): void;
  onToggleWorkspace(hostId: string, workspaceId: string): void;
  onToggleExpanded(hostId: string, workspaceId: string): void;
  onToggleSection(kind: SidebarPrioritySectionKind): void;
  onSearch(text: string | null): void;
  onAddHost(): void;
  /** New agent: the top row (null: the selected pane's workspace) or a workspace header's + (that workspace). */
  onNewAgent(place: { hostId: string; workspaceId: string } | null): void;
  /** A workspace header's right-click (its menu: New agent here). */
  onWorkspaceMenu(hostId: string, workspaceId: string, x: number, y: number): void;
  /** How ⌘N reads here ("⌘N", "Ctrl+N"). */
  readonly newAgentKey?: string;
  /** New workspace: its row under New agent, and how ⇧⌘N reads here. */
  onNewWorkspace?(): void;
  readonly newWorkspaceKey?: string;
  /**
   * Above the list: the search's Search all conversations row. (The View menu opens the Changes and "While you
   * were away" screens.)
   */
  readonly top?: ReactNode;
  /**
   * The inline rename open now: its slot (pane-manage paneRenameKey on a row, workspaceRenameKey on
   * a workspace header) and the name it opened with; null or absent: none. Its field is drawn in that row's or
   * header's place; Return gives its text to onRenameSave, Esc or a click away calls onRenameCancel.
   */
  readonly renaming?: { readonly key: string; readonly initial: string; readonly target?: "tab" } | null;
  /** `key`: the slot the field was drawn in (a field replaced by another's never ends the new one). */
  onRenameSave?(text: string, key?: string): void;
  onRenameCancel?(key?: string): void;
  /** The footer's Settings button (opens Settings, or goes back when it is open), and how ⌘, reads here. */
  onOpenSettings?(): void;
  readonly settingsOpen?: boolean;
  readonly settingsKey?: string;
  /**
   * The update pill (components/UpdatePill.tsx) while a newer Adari is out, at the
   * footer's right end in the agent count's place (the count comes back when it goes); null or absent: the count.
   */
  readonly updatePill?: ReactNode;
}

/** The pane's or workspace's rename field, in the place of its row or header. */
function renameField(props: SidebarProps, key: string, what: "pane" | "workspace", name: string): ReactNode {
  const renaming = props.renaming ?? null;
  if (renaming === null || renaming.key !== key) return null;
  return (
    <RenameField
      key={key}
      kind={what === "pane" ? "row" : "header"}
      initial={renaming.initial}
      label={what === "workspace" ? `Rename workspace ${name}` : renaming.target === "tab" ? `Rename tab ${name}` : `Rename ${name}`}
      hint={`Return saves · Esc cancels · renames the ${what === "pane" && renaming.target === "tab" ? "tab" : what} in Herdr`}
      onSave={(text) => props.onRenameSave?.(text, key)}
      onCancel={() => props.onRenameCancel?.(key)}
    />
  );
}

/** A machine header's whole text, for its tooltip: name, platform, status and (folded) its panes. */
function hostTitle(host: DesktopSidebar["hosts"][number]["host"], status: { text: string } | null, panes: string | null): string {
  return [host.name, host.platform, status?.text ?? null, panes].filter((part): part is string => part !== null && part !== "").join(" · ");
}

function hostStatus(host: DesktopSidebar["hosts"][number]["host"], hasModel: boolean): { text: string; off: boolean } | null {
  const state = host.state;
  // This Mac without its Herdr running is not a failure: a plain status, its note below.
  if (state === "offline" && host.notRunning !== undefined) return { text: "Not running", off: false };
  if (state === "offline") return { text: hasModel ? "Offline · last known" : "Offline", off: true };
  // The last sidebar from the launch cache, until the first snapshot lands.
  if (host.catchingUp === true) return { text: "Catching up…", off: false };
  if (state === "connecting") return { text: "Connecting…", off: false };
  return null;
}

export function Sidebar(props: SidebarProps) {
  const { sidebar, selectedKey } = props;
  const mode = sidebar.mode;
  const list = useRef<HTMLDivElement>(null);
  // The width kept from the edge's last drag (or the default), as the sidebar's --sb-w.
  const width = useSidebarWidth();
  useEffect(() => {
    list.current?.scrollTo({ top: 0 });
  }, [mode]);
  // A new selection scrolls into view: its first row, so a pane that needs you shows in the group on top.
  useEffect(() => {
    if (selectedKey === null) return;
    const row = list.current?.querySelector(`[data-row="${CSS.escape(selectedKey)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  return (
    <aside className="sb" style={width.style}>
      <div className="sb-drag">
        <span className="brand">Adari</span>
        <button className={props.search === null ? "ib" : "ib on"} title="Search (⌘F)" onClick={() => props.onSearch(props.search === null ? "" : null)}>
          <SearchIcon />
        </button>
        <button className="ib" title="Add a machine" onClick={props.onAddHost}>
          <PlusIcon />
        </button>
      </div>
      <div className="sb-top">
        <div className="seg">
          <button className={mode === "projects" ? "on" : ""} onClick={() => props.onMode("projects")}>
            Projects
          </button>
          <button className={mode === "priority" ? "on" : ""} onClick={() => props.onMode("priority")}>
            Priority
            {sidebar.badge > 0 ? (
              <span className="nyc">
                <i />
                {sidebar.badge}
              </span>
            ) : null}
          </button>
        </div>
        {props.search === null ? null : (
          <div className="search">
            <SearchIcon size={14} />
            <input
              autoFocus
              placeholder="Search panes"
              value={props.search}
              onChange={(event) => props.onSearch(event.target.value)}
              onKeyDown={(event) => {
                // Its closing Esc is its own, never Stop.
                if (event.key === "Escape") {
                  event.preventDefault();
                  props.onSearch(null);
                }
              }}
            />
            <button className="ib" style={{ width: 20, height: 20 }} onClick={() => props.onSearch(null)} title="Close search">
              <CloseIcon size={12} />
            </button>
          </div>
        )}
      </div>

      {props.top}
      <div className="sb-list" ref={list}>
        <button className="sb-new" title="New agent" onClick={() => props.onNewAgent(null)}>
          <span className="fi">
            <PlusIcon size={14} />
          </span>
          New agent
          <span className="k">{props.newAgentKey ?? "⌘N"}</span>
        </button>
        {props.onNewWorkspace === undefined ? null : (
          <button className="sb-new" title="New workspace" onClick={props.onNewWorkspace}>
            <span className="fi">
              <FolderIcon size={14} />
            </span>
            New workspace
            <span className="k">{props.newWorkspaceKey ?? "⇧⌘N"}</span>
          </button>
        )}
        {mode === "projects" ? (
          <>
            {sidebar.needsYou.length > 0 ? (
              <div className="grp">
                <GroupHeader
                  title="Needs you"
                  count={sidebar.needsYou.length}
                  needsYou
                  folded={sidebar.needsYouFolded}
                  onToggle={() => props.onToggleSection("needsYou")}
                />
                {sidebar.needsYouFolded
                  ? null
                  : sidebar.needsYou.map((entry) => (
                      <DesktopRowView key={entry.key} entry={entry} selectedKey={selectedKey} shownKeys={props.shownKeys} needsPills={props.needsPills} onSelect={props.onSelect} onRowMenu={props.onRowMenu} />
                    ))}
              </div>
            ) : null}
            {sidebar.hosts.map(({ host, model }) => {
              const status = hostStatus(host, model !== null);
              const folded = props.foldedHosts.has(host.id) && !sidebar.isSearching;
              // Folded, the machine keeps its agents that need you.
              const kept = folded && model !== null ? foldedMachineRows(model) : [];
              const paneCount = model?.projects.reduce((n, section) => n + section.header.paneCount, 0) ?? 0;
              // Folded, a machine counts its panes; one whose Herdr is not running has none to count.
              const panes = folded && model !== null && host.notRunning === undefined ? `${paneCount} ${paneCount === 1 ? "pane" : "panes"}` : null;
              const needsYou = model !== null && model.priorityBadge > 0;
              return (
                <div className={host.catchingUp === true ? "host catching" : "host"} key={host.id} data-host={host.id}>
                  <button
                    className="host-h"
                    title={hostTitle(host, status, panes)}
                    onClick={() => props.onToggleHost(host.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      props.onHostMenu(host.id, event.clientX, event.clientY);
                    }}
                  >
                    <span className="mi">
                      <MonitorIcon />
                    </span>
                    {/* The name first, whole; its badges in a box after it that takes only what it
                        leaves and gives way first (the platform goes whole, then the status is cut: app.css). */}
                    <span className="hn">{host.name}</span>
                    <span className="hb">
                      {status === null && !needsYou && panes === null ? null : (
                        <span className="hg">
                          {status === null ? null : <span className={status.off ? "hs off" : "hs"}>{status.text}</span>}
                          {needsYou ? <i className="ny" /> : null}
                          {panes === null ? null : <span className="pc">{panes}</span>}
                        </span>
                      )}
                      {host.platform === null ? null : <span className="pf">{host.platform}</span>}
                    </span>
                    <span className="chev">{folded ? <ChevronRightIcon /> : <ChevronDownIcon />}</span>
                  </button>
                  {host.notRunning === undefined ? null : (
                    <div className="host-note">
                      <span className="nt">{host.notRunning.text}</span>
                      <span className="hint">{host.notRunning.hint}</span>
                    </div>
                  )}
                  {host.error === null ? null : (
                    <div className="host-err">
                      {host.error}
                      {host.authRefused === true ? (
                        <button className="host-retry" title="Sign in once more with the saved password or key" onClick={() => props.onRetryHost(host.id)}>
                          Try again
                        </button>
                      ) : host.hostKeyDeclined === true ? (
                        <button className="host-retry" title="Connect again and see the Mac's host key once more" onClick={() => props.onRetryHost(host.id)}>
                          Try again
                        </button>
                      ) : null}
                    </div>
                  )}
                  {kept.length === 0 ? null : (
                    <div className="host-ny">
                      {kept.map(({ row, place }) => {
                        const key = desktopRowKey(host.id, row.paneID);
                        return (
                          <Row
                            key={key}
                            row={row}
                            rowKey={key}
                            selected={key === selectedKey}
                            shown={props.shownKeys?.has(key) === true}
                            place={place}
                            pillKind={props.needsPills?.get(key)}
                            onSelect={() => props.onSelect(host.id, row.paneID)}
                            onMenu={(x, y) => props.onRowMenu(host.id, row.paneID, x, y)}
                          />
                        );
                      })}
                    </div>
                  )}
                  {folded ? null : model?.projects.map((section) => (
                    <div className="ws" key={section.header.workspaceID}>
                      <div
                        className="ws-hw"
                        data-ws={section.header.workspaceID}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          props.onWorkspaceMenu(host.id, section.header.workspaceID, event.clientX, event.clientY);
                        }}
                      >
                        {renameField(props, workspaceRenameKey(host.id, section.header.workspaceID), "workspace", section.header.label) ?? (
                          <>
                            <button
                              className={section.header.isEmpty ? "ws-h dim" : "ws-h"}
                              title={section.header.label}
                              onClick={() => props.onToggleWorkspace(host.id, section.header.workspaceID)}
                            >
                              <span className="fi">{section.header.isFolded || section.header.isEmpty ? <FolderIcon /> : <FolderOpenIcon />}</span>
                              <span className="n">{section.header.label}</span>
                              {/* A herdr-core space says so, "Herdr App" to VoiceOver. */}
                              {isCoreID(section.header.workspaceID) ? (
                                <span className="app" title="Herdr App">
                                  <span aria-hidden="true">App</span>
                                  <span className="vh">Herdr App</span>
                                </span>
                              ) : null}
                              <span className="sp" />
                              {section.header.needsYou ? <i className="ny" /> : null}
                              {/* Folded, the header counts its agents that need you beside the amber dot. */}
                              {section.header.isFolded && section.header.needsYouCount > 0 ? (
                                <span className="nyn" title={`${section.header.needsYouCount} need${section.header.needsYouCount === 1 ? "s" : ""} you`}>
                                  {section.header.needsYouCount}
                                </span>
                              ) : null}
                              <span className="c">{section.header.paneCount}</span>
                            </button>
                            <button
                              className={host.state === "connected" ? "ws-add" : "ws-add off"}
                              title={host.state === "connected" ? `New agent in ${section.header.label}` : `${host.name} is not answering`}
                              aria-label={`New agent in ${section.header.label}`}
                              disabled={host.state !== "connected"}
                              onClick={() => props.onNewAgent({ hostId: host.id, workspaceId: section.header.workspaceID })}
                            >
                              <PlusIcon size={14} />
                            </button>
                          </>
                        )}
                      </div>
                      {section.rows.map((row) => {
                        const key = `${host.id}/${row.paneID}`;
                        return (
                          renameField(props, paneRenameKey(host.id, row.paneID), "pane", row.name) ?? (
                            <Row
                              key={key}
                              row={row}
                              rowKey={key}
                              selected={key === selectedKey}
                              shown={props.shownKeys?.has(key) === true}
                              pillKind={props.needsPills?.get(key)}
                              onSelect={() => props.onSelect(host.id, row.paneID)}
                              onMenu={(x, y) => props.onRowMenu(host.id, row.paneID, x, y)}
                            />
                          )
                        );
                      })}
                      {section.hiddenCount > 0 ? (
                        <button className="row more" onClick={() => props.onToggleExpanded(host.id, section.header.workspaceID)}>
                          Show {section.hiddenCount} more
                        </button>
                      ) : null}
                      {section.canShowLess ? (
                        <button className="row more" onClick={() => props.onToggleExpanded(host.id, section.header.workspaceID)}>
                          Show less
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              );
            })}
          </>
        ) : (
          <>
            {sidebar.hosts
              .filter(({ host }) => host.state !== "connected")
              .map(({ host, model }) => {
                const status = hostStatus(host, model !== null);
                return (
                  <Fragment key={host.id}>
                    <div className="host-h" title={hostTitle(host, status, null)}>
                      <span className="mi">
                        <MonitorIcon />
                      </span>
                      <span className="hn">{host.name}</span>
                      <span className="hb">
                        {status === null ? null : (
                          <span className="hg">
                            <span className={status.off ? "hs off" : "hs"}>{status.text}</span>
                          </span>
                        )}
                      </span>
                    </div>
                    {/* The not-running note and its hint, as in Projects. */}
                    {host.notRunning === undefined ? null : (
                      <div className="host-note">
                        <span className="nt">{host.notRunning.text}</span>
                        <span className="hint">{host.notRunning.hint}</span>
                      </div>
                    )}
                  </Fragment>
                );
              })}
            {sidebar.priority.map((section) => (
              <div className="grp" key={section.kind}>
                <GroupHeader
                  title={prioritySectionTitle(section.kind)}
                  count={section.count}
                  needsYou={section.kind === "needsYou"}
                  folded={section.isFolded}
                  onToggle={() => props.onToggleSection(section.kind)}
                />
                {section.rows.map(
                  (entry) =>
                    renameField(props, paneRenameKey(entry.hostId, entry.row.paneID), "pane", entry.row.name) ?? (
                      <DesktopRowView key={entry.key} entry={entry} selectedKey={selectedKey} shownKeys={props.shownKeys} needsPills={props.needsPills} onSelect={props.onSelect} onRowMenu={props.onRowMenu} />
                    ),
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="sb-foot">
        {/* A real button: Settings in the main window (⌘, too); again, back to the pane. */}
        <button
          className={props.settingsOpen === true ? "sb-set on" : "sb-set"}
          data-settings-button=""
          aria-pressed={props.settingsOpen === true}
          title={`Settings (${props.settingsKey ?? "⌘,"})`}
          onClick={() => props.onOpenSettings?.()}
        >
          <SettingsIcon />
          Settings
        </button>
        <span className="sp" />
        {props.demo ? <span className="demo">Demo</span> : null}
        {props.updatePill !== undefined && props.updatePill !== null ? (
          props.updatePill
        ) : (
          <span className="ag">
            {sidebar.agentCount} {sidebar.agentCount === 1 ? "agent" : "agents"}
          </span>
        )}
      </div>
      {/* T3 Code's rail on the right edge: drag to widen or narrow, double-click for the default. */}
      <div
        className="sb-rail"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        title="Drag to resize the sidebar · double-click for its default width"
        {...width.edge}
      />
    </aside>
  );
}
