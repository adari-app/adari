// Settings, a page in the main window, as T3 Code has it
// (its sections listed on the left, the section on the right). The sidebar
// footer's button, the app menu's Settings… and ⌘, open it over the main
// area; Esc, its close button and ⌘, again go back to the pane, with the
// focus where it was (App.tsx). Only what the Mac app can really do.
//
// One straight layout, T3 Code's
// (apps/web/src/components/settings/settingsLayout.tsx). Each page is a
// readable column centred in the main area (WorkspacePageContainer's
// "readable" width); each section a title, a short line and one group of rows
// (SettingsSection, SettingsGroup); each row its title and help on the left
// and its value or actions in one right-hand column (SettingsRow's
// `minmax(0,1fr) auto` grid), the same heights and spacing on every page.
//
// - Machines: This Mac and the saved SSH machines, one row each (name, status,
//   address), Edit… and Remove… or This Mac's "Built in" in the actions column;
//   Add and Edit open the sidebar's own dialog (AddHostDialog), Remove asks
//   first and calls the same removeHost. Under each connected machine, one line
//   of Herdr's agent integrations ("Codex: not installed · Install"), read again as the page opens.
// - Chat: Send presses Return (the composer reads it); Start commands, each
//   machine's command per agent kind, editable: Return or leaving the field
//   saves it into ~/.adari/agents.json on the machine (the main process:
//   src/main/start-commands-write.ts), Esc puts it back.
// - Uploaded images: each machine's uploads in Adari's own folders, counted
//   (what is known within 2 s, then the rest), and Delete now after a
//   confirmation (the main process decides what goes).
// - Appearance: the terminal's text size, the View menu's same setting.
// - Updates: the version and build commit; Adari's own update state with the
//   pill's actions (Download, Restart…) and Check for Updates…, the last
//   check, and Check for updates automatically
//   (src/main/updates.ts); and Agent CLIs: the agents whose CLI says it has an
//   update (Claude Code, Codex), grouped by CLI, each with its instruction.
// - About: the version, the privacy line, and Open-source licenses, which
//   opens the notices file the app ships (THIRD_PARTY_NOTICES.md).

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { restartKinds } from "../../shared/agent-restart";
import type { AppInfo, HerdrDesktopBridge, HostView } from "../../shared/ipc-contract";
import {
  canDeleteUploads,
  deleteConfirmButton,
  deleteConfirmMessage,
  deleteConfirmTitle,
  deleteOutcome,
  privacyLine,
  sendPressesReturnFoot,
  settingsKey,
  settingsSections,
  uploadsCountText,
  uploadsFoot,
  versionLine,
  type SettingsSection,
} from "../../shared/settings";
import {
  commandFor,
  editableStartKinds,
  isAgentStartCommands,
  startCommandSaveRefusal,
  startCommandsDisplayPath,
  typedStart,
  type AgentStartCommands,
  type EditableStartKind,
} from "../../shared/start-commands";
import { agentUpdateWords, updateLineKinds } from "../../shared/update-mark";
import { automaticFoot, automaticLabel, lastCheckLine, offLine, offReasonText, updateStatusLine, type UpdateView } from "../../shared/updates";
import { defaultTerminalFontSize, maximumTerminalFontSize, minimumTerminalFontSize, type ViewCommand } from "../../shared/view-commands";
import { CloseIcon, ExternalIcon, PlusIcon } from "../icons";
import { composerSettings } from "../components/composer-settings";
import { escapeOwners, keyOwners } from "../components/escape-owners";
import { startCommandsStore } from "../components/resume";
import { UpdateMark } from "../components/UpdateMark";
import { handoffStore } from "../handoff/handoff-state";
import { ChatEarlyBadge } from "../components/agent-kind";
import { IntegrationsLine, settingsIntegrationItems } from "../components/integrations";
import { uploadsStore } from "./uploads-store";

/** An agent pane whose CLI has an update (HostView.updateReady), as the sidebar names it. */
export interface UpdateReadyPane {
  readonly hostId: string;
  readonly paneId: string;
  readonly name: string;
  readonly place: string;
  /** Its agent kind ("claude", "codex"); absent: Claude Code (the only one before). */
  readonly kind?: string | null;
}

export interface SettingsPageProps {
  readonly bridge: HerdrDesktopBridge;
  readonly info: AppInfo;
  readonly hosts: readonly HostView[];
  readonly section: SettingsSection;
  onSection(section: SettingsSection): void;
  /** Esc, the close button (⌘, and the menu are App's): back to the pane. */
  onClose(): void;
  /** A dialog over the page (Add or Edit machine) has Esc. */
  readonly covered: boolean;
  /** The terminal's text size (View › Bigger Text, Smaller Text, Actual Size). */
  readonly fontSize: number;
  onFontCommand(command: Extract<ViewCommand, "font-bigger" | "font-smaller" | "font-reset">): void;
  onAddMachine(): void;
  onEditMachine(hostId: string): void;
  /** Remove, after its confirmation: the sidebar's removeHost. */
  onRemoveMachine(hostId: string): Promise<void>;
  readonly updateReady: readonly UpdateReadyPane[];
  onOpenPane(hostId: string, paneId: string): void;
  /** Adari's own update state (renderer/updates/update-store.ts; absent: not known yet). */
  readonly update?: UpdateView | null;
  /** The pill's Download and Restart (Restart asks first, in the main process). */
  onUpdateAction?(action: "download" | "install"): void;
}

/** A confirmation over the page: Delete now on a machine, or Remove a machine. */
type Confirm = { readonly kind: "delete"; readonly hostId: string; readonly name: string } | { readonly kind: "remove"; readonly hostId: string; readonly name: string };

/** A main-process refusal as the page puts it (Electron's "Error invoking remote method …" taken off). */
function reason(failure: unknown): string {
  return String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function hostAddress(host: HostView): string {
  if (host.kind === "local") return "This Mac, no SSH";
  if (host.kind === "demo") return "Demo machine";
  return host.platform === null ? host.address : `${host.address} · ${host.platform}`;
}

function hostState(host: HostView): { text: string; off: boolean } {
  if (host.state === "connected") return { text: "Connected", off: false };
  if (host.state === "connecting") return { text: "Connecting…", off: false };
  if (host.notRunning !== undefined) return { text: "Herdr not running", off: false };
  return { text: "Offline", off: true };
}

// --- The layout (T3 Code's settingsLayout.tsx): plain functions, so a page's rows are its own elements ---

interface RowParts {
  /** The row's title (SettingsRow's h3), and what stands beside it (a status chip). */
  readonly title: ReactNode;
  readonly badge?: ReactNode;
  /** Its help line (SettingsRow's description). */
  readonly help?: ReactNode;
  /** What it says now, under the help (SettingsRow's status). */
  readonly status?: ReactNode;
  /** Its value or actions, in the right-hand column (SettingsRow's control). */
  readonly control?: ReactNode;
  readonly className?: string;
  readonly data?: Record<`data-${string}`, string>;
}

/** One row: title, help and status on the left; the value or actions on the right (stacked when the page is narrow). */
function row(key: string, parts: RowParts) {
  return (
    <div className={parts.className === undefined ? "set-row" : `set-row ${parts.className}`} key={key} {...parts.data}>
      <div className="set-ri">
        <div className="set-rt">
          <div className="set-rh">
            <span className="set-k">{parts.title}</span>
            {parts.badge ?? null}
          </div>
          {parts.help === undefined || parts.help === null ? null : <div className="set-rd">{parts.help}</div>}
          {parts.status === undefined || parts.status === null ? null : <div className="set-rs">{parts.status}</div>}
        </div>
        {parts.control === undefined || parts.control === null ? null : <div className="set-rc">{parts.control}</div>}
      </div>
    </div>
  );
}

/** A section: its title and short line (and an action on the right), then its group of rows (SettingsSection). */
function section(id: string, title: string, lead: ReactNode, body: ReactNode, options: { action?: ReactNode; foot?: ReactNode } = {}) {
  return (
    <section className="set-sec" aria-labelledby={`set-h-${id}`} key={id} data-set-sec={id}>
      <div className="set-h">
        <div className="set-ht">
          <h2 id={`set-h-${id}`}>{title}</h2>
          {lead === null ? null : <p className="set-lead">{lead}</p>}
        </div>
        {options.action === undefined ? null : <div className="set-ha">{options.action}</div>}
      </div>
      {body}
      {options.foot === undefined || options.foot === null ? null : <p className="set-foot">{options.foot}</p>}
    </section>
  );
}

function chip(text: string, tone: "plain" | "off" | "on" = "plain") {
  return <span className={tone === "plain" ? "set-chip" : `set-chip ${tone}`}>{text}</span>;
}

/**
 * The page's own reading of the machines' uploads, for each machine that answers (never
 * a count kept from an earlier read). Read each time Uploaded images shows (`counting` names it; null while another
 * section shows), when a machine connects again (a new connection
 * number), and whenever its count went stale (an upload to it settled: uploadsStore.invalidate). A failed count waits
 * for the next of those. A read asked for while a count or Delete now runs on the machine is queued after it
 * (uploads-store.ts).
 */
function useUploadCounts(bridge: HerdrDesktopBridge, hosts: readonly HostView[], counting: SettingsSection | null): void {
  const version = useSyncExternalStore(uploadsStore.subscribe, uploadsStore.version);
  const connected = hosts
    .filter((host) => host.state === "connected")
    .map((host) => `${host.id}\u0000${host.connection ?? 0}`)
    .join("\n");
  // The machines (and their connections) read while this section shows; cleared when it changes.
  const read = useRef<{ section: SettingsSection | null; keys: Set<string> }>({ section: null, keys: new Set() });
  useEffect(() => {
    if (read.current.section !== counting) read.current = { section: counting, keys: new Set() };
    if (counting === null) return;
    const now = connected === "" ? [] : connected.split("\n");
    // A machine no longer connected is read again when it is (even on the same connection number).
    for (const key of read.current.keys) if (!now.includes(key)) read.current.keys.delete(key);
    for (const key of now) {
      const hostId = key.slice(0, key.indexOf("\u0000"));
      if (read.current.keys.has(key) && uploadsStore.state(hostId).kind !== "unknown") continue;
      read.current.keys.add(key);
      void uploadsStore.refresh(bridge, hostId);
    }
  }, [bridge, counting, connected, version]);
}

/**
 * A machine's uploads as one row of Uploaded images (exported for its tests): the machine, what is there (what is
 * counted so far while the count goes on), and Delete now in the actions column; the last Delete now's outcome under it.
 */
export function UploadsLine({ host, onDelete, label }: { host: HostView; onDelete(): void; label?: string }) {
  useSyncExternalStore(uploadsStore.subscribe, uploadsStore.version);
  const state = uploadsStore.state(host.id);
  const outcome = uploadsStore.outcome(host.id);
  const online = host.state === "connected";
  return (
    <div className="set-row" data-uploads={host.id}>
      <div className="set-ri">
        <div className="set-rt">
          <div className="set-rh">
            <span className="set-k">{label ?? host.name}</span>
          </div>
          <div className="set-rd">
            <span className="set-up-c">{online || state.kind === "deleting" ? uploadsCountText(state) : "Not counted while it is not connected"}</span>
          </div>
          {outcome === null ? null : (
            <div className="set-rs">
              <span className="set-up-o">{typeof outcome === "string" ? outcome : deleteOutcome(outcome)}</span>
            </div>
          )}
        </div>
        <div className="set-rc">
          <button className="btn sm" disabled={!online || !canDeleteUploads(state)} onClick={onDelete} title="Delete the uploads Adari left on this machine">
            Delete now
          </button>
        </div>
      </div>
    </div>
  );
}

function Switch({ on, label, onChange, data }: { on: boolean; label: string; onChange(on: boolean): void; data?: Record<`data-${string}`, string> }) {
  return (
    <button className={on ? "set-switch on" : "set-switch"} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} {...data}>
      <i />
    </button>
  );
}

/**
 * Each machine's start commands, read once per machine while Chat shows (the main process reads ~/.adari/agents.json),
 * and set to what a save there answered (the file as the reader reads it after the save).
 */
function useStartCommands(bridge: HerdrDesktopBridge, hosts: readonly HostView[], shown: boolean) {
  const [read, setRead] = useState<ReadonlyMap<string, AgentStartCommands>>(new Map());
  // The saves made here, per machine: a read that started before one is void (as
  // StartCommandsStore.saved), so a late read never puts back the command a save replaced.
  const saves = useRef(new Map<string, number>());
  const connected = hosts
    .filter((host) => host.state === "connected")
    .map((host) => `${host.id}\u0000${host.connection ?? 0}`)
    .join("\n");
  useEffect(() => {
    if (!shown || connected === "" || typeof bridge.startCommands !== "function") return;
    let live = true;
    for (const key of connected.split("\n")) {
      const hostId = key.slice(0, key.indexOf("\u0000"));
      const before = saves.current.get(hostId) ?? 0;
      void bridge.startCommands(hostId).then(
        (commands) => {
          if (!live || !isAgentStartCommands(commands) || (saves.current.get(hostId) ?? 0) !== before) return;
          setRead((current) => new Map(current).set(hostId, commands));
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [bridge, shown, connected]);
  const set = (hostId: string, commands: AgentStartCommands): void => {
    saves.current.set(hostId, (saves.current.get(hostId) ?? 0) + 1);
    setRead((current) => new Map(current).set(hostId, commands));
  };
  return { read, set };
}

/**
 * A field's Saved line. Only the kinds restart knows (agent-restart.ts restartKinds: Claude Code,
 * Codex, Grok Build) promise a restart; Cursor Agent's command is typed by New agent and Resume only.
 */
export function savedText(entry: EditableStartKind, command: string): string {
  if (command === "") return `Saved. ${entry.name} starts with ${entry.stock} again.`;
  return Object.hasOwn(restartKinds, entry.kind) ? `Saved. New agent, Resume and restart type ${command}.` : `Saved. New agent and Resume type ${command}.`;
}

/** A start-command field's last save: under way, done, or why not. */
type SaveState = { readonly kind: "saving"; readonly command: string } | { readonly kind: "saved"; readonly text: string } | { readonly kind: "failed"; readonly text: string };

const fieldKey = (hostId: string, kind: string): string => `${hostId}\u0000${kind}`;

/** Why the machine's fields cannot be edited now, or null when they can. */
function startFileNote(host: HostView, commands: AgentStartCommands | undefined): string | null {
  if (host.state !== "connected") return "Not connected. Start commands are read and saved while it is connected.";
  if (commands === undefined) return `Reading ${startCommandsDisplayPath}…`;
  if (commands.status.type === "malformed") return `${startCommandsDisplayPath} was not read: ${commands.status.reason}. Fix it on the machine first; Adari does not rewrite a file it cannot read.`;
  if (commands.status.type === "unreadable") return `${startCommandsDisplayPath} was not read: ${commands.status.reason}. It is read again when the machine connects again.`;
  return null;
}

/** What the machine's file says, in a few words, for its group's header. */
function startFileLine(commands: AgentStartCommands | undefined): string {
  if (commands === undefined || commands.status.type === "unreadable" || commands.status.type === "malformed") return startCommandsDisplayPath;
  if (commands.status.type === "absent") return `No ${startCommandsDisplayPath} yet: each agent starts with its own command.`;
  return `From ${startCommandsDisplayPath}`;
}

/** Under a kind's field: the command in the file not used (refused by the reader, or not plain), or null. */
function kindNote(commands: AgentStartCommands | undefined, entry: EditableStartKind): string | null {
  if (commands === undefined || commands.status.type !== "read") return null;
  const start = typedStart(commands, entry.kind);
  if (start.type === "typed" || start.notTyped === null) return null;
  return `Not used: ${start.notTyped}. ${entry.name} starts with ${entry.stock} until it is changed here.`;
}

export function SettingsPage(props: SettingsPageProps) {
  const { bridge, info, hosts, section: shownSection } = props;
  // Esc is the page's while it shows (never Stop in the Chat under it). Its hold's number: a hold after it is a dialog
  // or menu over the page (a hold from before, the box over the terminal under it, is not).
  const ownHold = useRef(0);
  useEffect(() => {
    const release = escapeOwners.hold();
    ownHold.current = escapeOwners.latest();
    return release;
  }, []);
  const mac = info.platform === "darwin";
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // A check asked for here: its outcome in words and when it came back (a later check's line replaces it).
  const [checked, setChecked] = useState<{ readonly text: string; readonly at: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Start commands: what you typed and has not saved yet, and each field's last save.
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [saves, setSaves] = useState<ReadonlyMap<string, SaveState>>(new Map());
  // About's Open-source licenses: why the file did not open, when it did not.
  const [licensesNote, setLicensesNote] = useState<string | null>(null);
  const pressesReturn = useSyncExternalStore(composerSettings.subscribe, composerSettings.sendPressesReturn);
  useUploadCounts(bridge, hosts, shownSection === "uploads" ? shownSection : null);
  const startCommands = useStartCommands(bridge, hosts, shownSection === "chat");
  const nav = useRef<HTMLElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  // Settings opened: each machine that answered integration.list is read again.
  useEffect(() => {
    void bridge.refreshIntegrations?.().catch(() => undefined);
  }, [bridge]);
  // The keyboard comes into the page as it opens (the pane under it keeps its focus for the way back: App.tsx).
  useEffect(() => {
    const current = nav.current?.querySelector<HTMLButtonElement>('[aria-current="page"]');
    current?.focus();
  }, []);
  useEffect(() => {
    if (confirm !== null) confirmButton.current?.focus();
  }, [confirm]);
  // Updates' "Last checked today at …" reads the clock while it shows.
  const lastCheckAt = props.update?.lastCheck?.at ?? null;
  useEffect(() => {
    if (shownSection !== "updates") return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(clock);
  }, [shownSection, lastCheckAt]);

  // Esc: a confirmation first, then the page (a dialog over it, a field that owns the keys and a key already taken keep it).
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const coveredRef = useRef(props.covered);
  coveredRef.current = props.covered;
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  useEffect(() => {
    if (typeof window.addEventListener !== "function") return;
    const onKey = (event: KeyboardEvent): void => {
      // A hold taken after the page's is a dialog or menu over it (its hold goes a task after it closed).
      if (event.key !== "Escape" || event.defaultPrevented || coveredRef.current || keyOwners.any() || escapeOwners.heldAfter(ownHold.current)) return;
      event.preventDefault();
      if (confirmRef.current !== null) setConfirm(null);
      else closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const confirmNow = (): void => {
    const asked = confirm;
    setConfirm(null);
    if (asked === null) return;
    if (asked.kind === "delete") void uploadsStore.deleteNow(bridge, asked.hostId);
    else void props.onRemoveMachine(asked.hostId).then(() => uploadsStore.forget(asked.hostId));
  };

  const pick = (next: SettingsSection): void => {
    if (next !== shownSection) props.onSection(next);
  };

  const askDelete = (host: HostView) => () => setConfirm({ kind: "delete", hostId: host.id, name: host.name });

  // --- Machines ---

  const machinesPage = section(
    "machines",
    "Machines",
    "The Macs and Linux machines Adari reaches over SSH, and This Mac. Edit changes how it signs in; Remove forgets it and its saved password here.",
    <div className="set-group">
      {hosts.length === 0 ? <div className="set-empty">No machines yet. Add a machine to see its agents.</div> : null}
      {hosts.map((host) => {
        const state = hostState(host);
        return row(host.id, {
          title: host.name,
          badge: chip(state.text, state.off ? "off" : host.state === "connected" ? "on" : "plain"),
          help: hostAddress(host),
          // One line of Herdr's agent integrations, with Install or Update.
          status: settingsIntegrationItems(host).length === 0 ? null : <IntegrationsLine host={host} bridge={bridge} />,
          data: { "data-machine": host.id },
          control:
            host.kind === "ssh" ? (
              <>
                <button className="btn sm" onClick={() => props.onEditMachine(host.id)}>
                  Edit…
                </button>
                <button className="btn sm danger" onClick={() => setConfirm({ kind: "remove", hostId: host.id, name: host.name })}>
                  Remove…
                </button>
              </>
            ) : (
              <span className="set-built">{host.kind === "local" ? "Built in" : "Demo"}</span>
            ),
        });
      })}
    </div>,
    {
      action: (
        <button className="btn sm" onClick={props.onAddMachine} title="Add a machine (SSH)">
          <PlusIcon size={13} />
          Add a machine…
        </button>
      ),
    },
  );

  // --- Chat ---

  const setDraft = (key: string, value: string | null): void =>
    setDrafts((current) => {
      const next = new Map(current);
      if (value === null) next.delete(key);
      else next.set(key, value);
      return next;
    });
  const setSave = (key: string, value: SaveState | null): void =>
    setSaves((current) => {
      const next = new Map(current);
      if (value === null) next.delete(key);
      else next.set(key, value);
      return next;
    });

  /** Saves the field's draft (Return, or leaving the field): nothing when unchanged; refused here when the reader would refuse it. */
  const commitStart = (host: HostView, entry: EditableStartKind): void => {
    const key = fieldKey(host.id, entry.kind);
    const draft = drafts.get(key);
    if (draft === undefined) return;
    const commands = startCommands.read.get(host.id);
    const command = draft.trim();
    const current = commands === undefined ? "" : (commandFor(commands, entry.kind) ?? "");
    if (command === current) {
      setDraft(key, null);
      return;
    }
    // Return, then leaving the field: one save.
    const running = saves.get(key);
    if (running?.kind === "saving" && running.command === command) return;
    const refusal = startCommandSaveRefusal(command);
    if (refusal !== null) {
      setSave(key, { kind: "failed", text: `Not saved: ${refusal}` });
      return;
    }
    if (typeof bridge.saveStartCommand !== "function") {
      setSave(key, { kind: "failed", text: "Not saved: this build cannot save start commands." });
      return;
    }
    setSave(key, { kind: "saving", command });
    void bridge.saveStartCommand(host.id, entry.kind, command).then(
      (saved) => {
        if (!isAgentStartCommands(saved)) {
          setSave(key, { kind: "failed", text: "Not saved: the answer was not start commands." });
          return;
        }
        startCommands.set(host.id, saved);
        // New agent and the Resume chip use it from now on (the main process keeps the same for restart).
        startCommandsStore.saved(host.id, handoffStore.life.connection(host.id), saved);
        setDrafts((now) => {
          if (now.get(key) !== draft) return now;
          const next = new Map(now);
          next.delete(key);
          return next;
        });
        setSave(key, { kind: "saved", text: savedText(entry, command) });
      },
      (failure: unknown) => setSave(key, { kind: "failed", text: `Not saved: ${reason(failure)}` }),
    );
  };

  const startField = (host: HostView, entry: EditableStartKind, commands: AgentStartCommands | undefined, editable: boolean) => {
    const key = fieldKey(host.id, entry.kind);
    const draft = drafts.get(key);
    const saved = commands === undefined ? null : commandFor(commands, entry.kind);
    const value = draft ?? saved ?? "";
    // While you type: the reader's own refusal, at once (a refused command is never written).
    const refusal = draft === undefined ? null : startCommandSaveRefusal(draft.trim());
    const save = saves.get(key) ?? null;
    const note = kindNote(commands, entry);
    const status =
      refusal !== null ? (
        <span className="set-bad">{refusal}</span>
      ) : save?.kind === "saving" ? (
        "Saving…"
      ) : save?.kind === "failed" ? (
        <span className="set-bad">{save.text}</span>
      ) : save?.kind === "saved" ? (
        <span className="set-good">{save.text}</span>
      ) : draft !== undefined && draft.trim() !== (saved ?? "") ? (
        "Not saved yet: Return saves it on the machine, Esc puts it back."
      ) : note === null ? null : (
        <span className="set-bad">{note}</span>
      );
    return row(entry.kind, {
      title: entry.name,
      // An early kind's Early badge beside its name: Grok Build's and Cursor Agent's rows show it; Claude Code's and Codex's none.
      badge: <ChatEarlyBadge kind={entry.kind} />,
      // Codex's grey line (Adari adds --no-daemon); none for the other kinds.
      ...(entry.note === undefined ? {} : { help: entry.note }),
      status,
      data: { "data-start-kind": entry.kind },
      control: (
        <input
          className={refusal !== null ? "inp mono set-in bad" : "inp mono set-in"}
          data-start-input={`${host.id}/${entry.kind}`}
          aria-label={`${entry.name} start command on ${host.name}`}
          aria-invalid={refusal !== null}
          placeholder={entry.stock}
          value={value}
          disabled={!editable}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          onChange={(event) => {
            setDraft(key, event.target.value);
            if (save?.kind !== "saving") setSave(key, null);
          }}
          onBlur={() => commitStart(host, entry)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              commitStart(host, entry);
            } else if (event.key === "Escape" && draft !== undefined) {
              // Esc puts back what is saved (and is not the page's Esc then).
              event.preventDefault();
              event.stopPropagation();
              setDraft(key, null);
              setSave(key, null);
            }
          }}
        />
      ),
    });
  };

  const chatPage = (
    <>
      {section(
        "chat",
        "Message box",
        "How the message box under a Chat sends what you type.",
        <div className="set-group">
          {row("return", {
            title: "Send presses Return",
            help: sendPressesReturnFoot(mac),
            control: <Switch on={pressesReturn} label="Send presses Return" onChange={(on) => composerSettings.setSendPressesReturn(on)} />,
          })}
        </div>,
      )}
      {section(
        "start",
        "Start commands",
        <>
          What New agent, Resume and a restart type to start each agent on a machine. Empty starts it with its own command, shown in grey. Return or leaving the field
          saves it in <span className="mono">{startCommandsDisplayPath}</span> on that machine; the file’s other entries stay as they are. Esc puts it back.
        </>,
        <div className="set-groups">
          {hosts.length === 0 ? (
            <div className="set-group">
              <div className="set-empty">No machines yet.</div>
            </div>
          ) : null}
          {hosts.map((host) => {
            const commands = startCommands.read.get(host.id);
            const note = startFileNote(host, commands);
            const state = hostState(host);
            return (
              <div className="set-group" key={host.id} data-start={host.id}>
                {row("machine", {
                  className: "set-row-head",
                  title: host.name,
                  badge: chip(state.text, state.off ? "off" : host.state === "connected" ? "on" : "plain"),
                  help: note ?? startFileLine(commands),
                })}
                {editableStartKinds.map((entry) => startField(host, entry, commands, note === null))}
              </div>
            );
          })}
        </div>,
      )}
    </>
  );

  // --- Uploaded images ---

  const uploadsPage = section(
    "uploads",
    "Uploaded images",
    "What Adari uploaded to each machine for its agents, in Adari’s own upload folders there. Delete now removes only those files.",
    <div className="set-group">
      {hosts.length === 0 ? <div className="set-empty">No machines yet.</div> : null}
      {hosts.map((host) => (
        <UploadsLine key={host.id} host={host} onDelete={askDelete(host)} />
      ))}
    </div>,
    { foot: uploadsFoot() },
  );

  // --- Appearance ---

  const appearancePage = section(
    "appearance",
    "Terminal",
    "How a pane’s terminal draws its text.",
    <div className="set-group">
      {row("size", {
        title: "Text size",
        help: "The same setting as View › Bigger Text, Smaller Text and Actual Size: the terminal’s text, for this window.",
        control: (
          <>
            <div className="set-step" role="group" aria-label="Text size">
              <button aria-label="Smaller Text" title={`Smaller Text (${mac ? "⌘−" : "Ctrl+−"})`} disabled={props.fontSize <= minimumTerminalFontSize} onClick={() => props.onFontCommand("font-smaller")}>
                A−
              </button>
              <span className="set-step-v" aria-live="polite" data-font-size={props.fontSize}>
                {props.fontSize} pt
              </span>
              <button aria-label="Bigger Text" title={`Bigger Text (${mac ? "⌘+" : "Ctrl++"})`} disabled={props.fontSize >= maximumTerminalFontSize} onClick={() => props.onFontCommand("font-bigger")}>
                A+
              </button>
            </div>
            <button className="btn sm" disabled={props.fontSize === defaultTerminalFontSize} onClick={() => props.onFontCommand("font-reset")} title={`Actual Size (${mac ? "⌘0" : "Ctrl+0"})`}>
              Actual Size
            </button>
          </>
        ),
      })}
      <div className="set-preview" style={{ fontSize: props.fontSize }}>
        <span>❯ npm run typecheck && npm test</span>
      </div>
    </div>,
  );

  // --- Updates ---

  const commit = info.commit ?? null;
  const update = props.update ?? null;
  const updatesOn = update === null ? info.updates.enabled : update.status !== "off";
  // The outcome of the check asked for here, until a later check ends (an automatic one, or the menu's).
  const shownCheck = checked !== null && (update?.lastCheck === null || update?.lastCheck === undefined || update.lastCheck.at <= checked.at) ? checked.text : null;
  const switchShown = updatesOn && update !== null;
  const footText = !updatesOn ? (update?.off === null || update?.off === undefined ? offLine : offReasonText(update.off)) : automaticFoot(update?.automatic ?? true);
  const foot = <span data-update-foot="">{footText}</span>;
  const updateActions = (
    <span className="set-acts" data-update-actions="">
      {update?.status === "available" ? (
        <button className="btn sm pri" title={`Download Adari ${update.available ?? ""}; it installs only when you restart Adari`} onClick={() => props.onUpdateAction?.("download")}>
          Download
        </button>
      ) : null}
      {update?.status === "downloading" ? (
        <button className="btn sm" disabled>
          Downloading… {Math.floor(update.percent ?? 0)}%
        </button>
      ) : null}
      {update?.status === "downloaded" ? (
        <button className="btn sm pri" title="Asks first, then quits Adari and opens the new version" onClick={() => props.onUpdateAction?.("install")}>
          Restart…
        </button>
      ) : null}
      {update?.status === "installing" ? (
        <button className="btn sm" disabled>
          Restarting…
        </button>
      ) : null}
      <button
        className="btn sm"
        disabled={!updatesOn || checking || update?.checking === true || update?.status === "downloading" || update?.status === "installing"}
        title={updatesOn ? `Ask ${info.updates.feedUrl ?? "the update feed"} for a newer version` : offLine}
        onClick={() => {
          setChecking(true);
          void bridge.checkForUpdates().then(
            (outcome) => {
              setChecking(false);
              setChecked({ text: outcome, at: Date.now() });
            },
            () => {
              setChecking(false);
              setChecked({ text: "Could not check for updates.", at: Date.now() });
            },
          );
        }}
      >
        {checking || update?.checking === true ? "Checking…" : "Check for Updates…"}
      </button>
    </span>
  );

  // Agent CLIs: the covered CLIs in the start-command table's order (Claude Code first), each with its marked agents.
  const coveredKinds = [...updateLineKinds].sort(
    (a, b) => editableStartKinds.findIndex((entry) => entry.kind === a) - editableStartKinds.findIndex((entry) => entry.kind === b),
  );
  const paneKind = (pane: UpdateReadyPane): string => {
    const kind = (pane.kind ?? "claude").toLowerCase();
    return Object.hasOwn(agentUpdateWords, kind) ? kind : "claude";
  };
  const resumeForm = (kind: string): string | null => {
    const restart = Object.hasOwn(restartKinds, kind) ? restartKinds[kind]! : null;
    return restart === null ? null : restart.resume(restart.executable, "<session>");
  };
  const coveredNames = coveredKinds.map((kind) => agentUpdateWords[kind]!.cli);
  const uncovered = editableStartKinds.filter((entry) => !updateLineKinds.has(entry.kind)).map((entry) => entry.name);

  const updatesPage = (
    <>
      {section(
        "updates",
        "Adari",
        "This app’s version and its own updates.",
        <div className="set-group">
          {row("version", { title: "Version", control: <span className="set-v mono">{versionLine(info.version, commit)}</span> })}
          {row("update", {
            title: "Updates",
            help: <span data-update-status="">{update === null ? (info.updates.enabled ? "Not checked yet." : offLine) : updateStatusLine(update)}</span>,
            status: (
              <>
                {updatesOn ? (
                  <span className="set-line-s" data-update-last="">
                    {checking ? "Checking…" : shownCheck !== null ? shownCheck : update === null ? "Not checked yet." : lastCheckLine(update, now)}
                  </span>
                ) : null}
                {switchShown ? null : foot}
              </>
            ),
            data: { "data-update-state": update?.status ?? (info.updates.enabled ? "unknown" : "off") },
            control: updateActions,
          })}
          {switchShown
            ? row("automatic", {
                title: automaticLabel,
                help: foot,
                control: <Switch on={update.automatic} label={automaticLabel} data={{ "data-update-automatic": "" }} onChange={(on) => void bridge.setAutomaticUpdates?.(on).catch(() => undefined)} />,
              })
            : null}
        </div>,
      )}
      {section(
        "agent-clis",
        "Agent CLIs",
        `An agent whose CLI says on its screen that it has a newer version, read from the same few lines as before. Covered: ${coveredNames.join(" and ")}.`,
        <div className="set-groups">
          {coveredKinds.map((kind) => {
            const words = agentUpdateWords[kind]!;
            const panes = props.updateReady.filter((pane) => paneKind(pane) === kind);
            const resume = resumeForm(kind);
            return (
              <div className="set-group" key={kind} data-update-kind={kind}>
                {row("cli", {
                  className: "set-row-head",
                  title: words.cli,
                  badge: chip(words.label, panes.length > 0 ? "on" : "plain"),
                  help: words.words,
                  status:
                    resume === null ? null : (
                      <span data-update-resume={kind}>
                        Resume types <span className="mono">{resume}</span>. Restart on the new version, in the agent’s header, does the /exit and the Resume.
                      </span>
                    ),
                  control: <span className="set-v faint">{panes.length === 0 ? "None now" : panes.length === 1 ? "1 agent" : `${panes.length} agents`}</span>,
                })}
                {panes.map((pane) => (
                  <button className="set-upd" key={`${pane.hostId}/${pane.paneId}`} onClick={() => props.onOpenPane(pane.hostId, pane.paneId)} title={`Open ${pane.name}`}>
                    <UpdateMark kind={kind} />
                    <span className="set-mn">{pane.name}</span>
                    <span className="set-v faint">{pane.place}</span>
                    <span className="set-open">Open</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>,
        { foot: uncovered.length === 0 ? null : `Not listed: ${uncovered.join(" and ")}. ${uncovered.length === 1 ? "It prints" : "They print"} no update notice Adari can read.` },
      )}
    </>
  );

  // --- About ---

  const aboutPage = section(
    "about",
    "About",
    "This build of Adari.",
    <div className="set-group">
      {row("version", { title: "Version", control: <span className="set-v mono">{versionLine(info.version, commit)}</span> })}
      {row("privacy", { title: "Privacy", help: <span className="set-privacy">{privacyLine(update)}</span> })}
      {row("licenses", {
        title: "Open-source licenses",
        help: "The notices and licence texts of the code and fonts this build ships, in the app’s THIRD_PARTY_NOTICES.md.",
        status: licensesNote === null ? null : <span className="set-bad">{licensesNote}</span>,
        data: { "data-licenses": "" },
        control: (
          <button
            className="btn sm"
            disabled={typeof bridge.openLicenses !== "function"}
            onClick={() => {
              setLicensesNote(null);
              void bridge.openLicenses?.().then(
                (why) => setLicensesNote(why),
                (failure: unknown) => setLicensesNote(`Could not open it: ${reason(failure)}`),
              );
            }}
          >
            View licenses
            <ExternalIcon size={12} />
          </button>
        ),
      })}
    </div>,
  );

  const shown: Record<SettingsSection, ReactNode> = { machines: machinesPage, chat: chatPage, uploads: uploadsPage, appearance: appearancePage, updates: updatesPage, about: aboutPage };
  return (
    <div className="settings-page" role="region" aria-label="Settings" data-section={shownSection}>
      <div className="mh set-mh">
        <div className="who">
          <span className="nm">Settings</span>
          <span className="wsn">{settingsKey(mac)} to go back</span>
        </div>
        <span className="sp" />
        <button className="ib" title="Close (Esc)" aria-label="Close Settings" onClick={props.onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="set-body">
        <nav className="set-nav" aria-label="Settings sections" ref={nav}>
          {settingsSections.map((entry, index) => (
            <button
              key={entry.id}
              className={entry.id === shownSection ? "set-nav-i on" : "set-nav-i"}
              aria-current={entry.id === shownSection ? "page" : undefined}
              data-section={entry.id}
              onClick={() => pick(entry.id)}
              onKeyDown={(event) => {
                const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                if (step === 0) return;
                event.preventDefault();
                const next = settingsSections[(index + step + settingsSections.length) % settingsSections.length]!;
                pick(next.id);
                const target = (event.currentTarget.parentElement as HTMLElement | null)?.querySelector<HTMLButtonElement>(`[data-section="${next.id}"]`);
                target?.focus();
              }}
            >
              {entry.title}
            </button>
          ))}
        </nav>
        <div className="set-scroll">
          <div className="set-col">{shown[shownSection]}</div>
        </div>
      </div>
      {confirm === null ? null : (
        <>
          <div className="scrim" onClick={() => setConfirm(null)} />
          <div className="dlg confirm set-confirm" role="alertdialog" aria-label={confirm.kind === "delete" ? deleteConfirmTitle(confirm.name) : `Remove ${confirm.name}?`}>
            <div className="dt">{confirm.kind === "delete" ? deleteConfirmTitle(confirm.name) : `Remove ${confirm.name}?`}</div>
            <div className="confirm-body">
              {confirm.kind === "delete"
                ? deleteConfirmMessage(uploadsStore.state(confirm.hostId), confirm.name)
                : "Adari forgets this machine, its saved password or passphrase and its drafts here. Nothing on the machine changes."}
            </div>
            <div className="df">
              <span className="note" />
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn danger" ref={confirmButton} data-confirm={confirm.kind} onClick={confirmNow}>
                {confirm.kind === "delete" ? deleteConfirmButton(uploadsStore.state(confirm.hostId)) : "Remove"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
