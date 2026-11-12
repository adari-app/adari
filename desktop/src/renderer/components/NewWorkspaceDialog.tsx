// New workspace (in New agent's dialog style): the machine (a choice only when
// more than one answers; the selected pane's first), a folder on it with the
// folders its panes are in suggested (a ~ path allowed), and the name, the
// folder's last part until you type your own. Return creates it, Esc cancels
// (the dialog owns Esc while open: escape-owners.ts). Herdr's refusal stays in
// the dialog to try again; once made, the window selects it and the main area
// offers Start an agent in it (NewWorkspaceReady, App.tsx).
//
// T3 Code's Add project shape: the machine first,
// always a picker of the answering machines (the title follows it); then the
// folder, a field that lists the folders under what you type on that machine
// (folder-browse.tsx), with Choose… on This Mac, and the recent folders (its
// panes') as rows of name and whole path; then the name, from the folder.

import { useRef, useState } from "react";

import {
  defaultMachine,
  defaultWorkspaceName,
  workspaceNameSent,
  workspaceOpenRefusal,
  type NewWorkspaceHost,
  type NewWorkspaceMachine,
  type NewWorkspaceRequest,
  type NewWorkspaceResult,
  type TypedName,
} from "../../shared/new-workspace";
import { shortFolder } from "../../shared/new-agent";
import { CloseIcon, FolderIcon } from "../icons";
import { useEscapeOwner } from "./escape-owners";
import { chooseButton, folderList, useFolderBrowse, type FolderCalls } from "./folder-browse";

export interface NewWorkspaceDialogProps {
  /** The answering machines; only the ones when the dialog opened are offered, each with its connection then. */
  readonly machines: readonly NewWorkspaceMachine[];
  /** Every machine as the window shows it now: a chosen machine offline, reconnected or re-added since is refused. */
  readonly hosts: readonly NewWorkspaceHost[];
  /** The machine it opens on (the selected pane's), or null: the first. */
  readonly wanted: string | null;
  /** The folder it opens with (captures), else empty. */
  readonly initialFolder?: string;
  /** The folder field's list and This Mac's Choose… (absent: a plain field). */
  readonly folders?: FolderCalls | null;
  create(machine: NewWorkspaceMachine, request: NewWorkspaceRequest): Promise<NewWorkspaceResult>;
  onCreated(machine: NewWorkspaceMachine, result: NewWorkspaceResult): void;
  onClose(): void;
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

type Phase = { readonly type: "editing" } | { readonly type: "working"; readonly name: string } | { readonly type: "failed"; readonly message: string };

export function NewWorkspaceDialog({ machines: live, hosts, wanted, initialFolder = "", folders = null, create, onCreated, onClose }: NewWorkspaceDialogProps) {
  useEscapeOwner();
  // The machines and their connections as the dialog opened; live updates only refuse.
  const [machines] = useState(() => live);
  const [hostId, setHostId] = useState<string | null>(() => defaultMachine(machines, wanted)?.hostId ?? null);
  const machine = machines.find((candidate) => candidate.hostId === hostId) ?? null;
  const refusal = machine === null ? null : workspaceOpenRefusal(machine, hosts);
  const [folder, setFolder] = useState(initialFolder);
  const [typed, setTyped] = useState<TypedName>({ text: "", edited: false });
  const [phase, setPhase] = useState<Phase>({ type: "editing" });
  // Closed (Escape, Cancel): a create still under way opens nothing.
  const closed = useRef(false);
  const browse = useFolderBrowse({
    calls: folders,
    hostId,
    machine: machine?.hostName ?? "the machine",
    local: machine?.local === true,
    offline: machine !== null && refusal !== null,
    folder,
    setFolder,
    disabled: phase.type === "working",
  });

  const trimmed = folder.trim();
  const name = typed.edited ? typed.text : trimmed === "" ? "" : defaultWorkspaceName(trimmed);
  const sent = workspaceNameSent(trimmed, typed);
  const working = phase.type === "working";
  const ready = machine !== null && refusal === null && trimmed !== "" && !working;

  const close = (): void => {
    closed.current = true;
    onClose();
  };

  const go = (): void => {
    if (!ready || machine === null) return;
    setPhase({ type: "working", name: sent });
    // The connection the dialog opened on: a reconnect before it goes refuses here and in main (main/herdr/new-workspace.ts).
    create(machine, { folder: trimmed, name: sent, binding: machine.binding }).then(
      (result) => {
        if (!closed.current) onCreated(machine, result);
      },
      (failure: unknown) => {
        if (!closed.current) setPhase({ type: "failed", message: message(failure) });
      },
    );
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // The folder list's keys first while it is open (Esc closes it; a second Esc closes the dialog).
    if (!event.nativeEvent.isComposing && browse.key(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      // A focused button (Cancel, a suggestion) or the machine's menu does its own thing.
      const target = event.target as { tagName?: string } | null;
      if (target?.tagName === "BUTTON" || target?.tagName === "SELECT") return;
      event.preventDefault();
      go();
    }
  };

  const note =
    phase.type === "failed"
      ? `Not created: ${phase.message}`
      : phase.type === "working"
        ? `Creating ${phase.name}…`
        : machine === null
          ? "No machine is answering."
          : refusal !== null
            ? refusal
            : trimmed === ""
            ? `A folder on ${machine.hostName}; the workspace is named after it`
            : `${sent} at ${shortFolder(trimmed)}, with a shell in its first tab`;
  const title = machine === null ? "New workspace" : `New workspace on ${machine.hostName}`;

  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="dlg na nw" role="dialog" aria-label={title} onKeyDown={onKeyDown}>
        <div className="dt">
          {title}
          <span className="sp" />
          <button className="ib" onClick={close} title="Close" aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="fld">
          <div className="lb">Machine</div>
          <select className="inp" value={hostId ?? ""} disabled={working || machines.length === 0} aria-label="Machine" onChange={(event) => setHostId(event.target.value)}>
            {machine === null ? <option value="">No machine is answering</option> : null}
            {machines.map((candidate) => (
              <option key={candidate.hostId} value={candidate.hostId}>
                {candidate.hostName}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <div className="lb">Folder on {machine?.hostName ?? "the machine"}</div>
          <div className="fb-wrap">
            <div className="key-pick">
              <input
                className="inp mono"
                value={folder}
                placeholder={machine?.local === true ? "~/code/project, or Choose…" : "Type a folder: / or ~/"}
                aria-label="Folder"
                aria-expanded={browse.open}
                disabled={working}
                autoFocus
                spellCheck={false}
                onChange={(event) => browse.typed(event.target.value)}
                onBlur={() => browse.close()}
              />
              {chooseButton(browse, working)}
            </div>
            {folderList(browse)}
          </div>
          {browse.chooseNote === null ? null : <div className="fb-note">{browse.chooseNote}</div>}
          {machine !== null && machine.suggestions.length > 0 ? (
            <div className="nw-recent">
              <div className="nw-recent-h">Recent folders on {machine.hostName}</div>
              {machine.suggestions.map((path) => (
                <button
                  key={path}
                  className={path === trimmed ? "nw-row on" : "nw-row"}
                  title={path}
                  aria-label={`Folder ${path}`}
                  disabled={working}
                  onClick={() => {
                    browse.close();
                    setFolder(path);
                  }}
                >
                  <FolderIcon size={14} />
                  <span className="nm">{defaultWorkspaceName(path)}</span>
                  <span className="pa">{path}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="fld">
          <div className="lb">Name</div>
          <input
            className="inp"
            value={name}
            placeholder={trimmed === "" ? "Named after the folder" : defaultWorkspaceName(trimmed)}
            aria-label="Name"
            disabled={working}
            spellCheck={false}
            onChange={(event) => setTyped({ text: event.target.value, edited: true })}
          />
        </div>
        <div className="df">
          <span className={phase.type === "failed" || (refusal !== null && !working) ? "note err" : "note"} role="status">
            {note}
          </span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn pri" onClick={go} disabled={!ready}>
            Create <kbd>↩</kbd>
          </button>
        </div>
      </div>
    </>
  );
}

export interface NewWorkspaceReadyProps {
  readonly hostName: string;
  readonly label: string;
  readonly folder: string;
  /** Herdr put its shell somewhere else (the line that says where), or null. */
  readonly elsewhere?: string | null;
  /** That machine answers and has the workspace, as New agent can start there (false: both buttons off). */
  readonly present: boolean;
  onStartAgent(): void;
  onOpenShell(): void;
}

/**
 * The main area once it is made ("Workspace created": what
 * was made, then Start an agent in it): Return or a
 * click opens New agent for the workspace at its folder; Open its shell shows
 * the shell Herdr put in its first tab. The sidebar has it selected.
 */
export function NewWorkspaceReady({ hostName, label, folder, elsewhere = null, present, onStartAgent, onOpenShell }: NewWorkspaceReadyProps) {
  return (
    <main className="main">
      <div className="mh" />
      <div className="empty nw-made">
        <div className="ctr">
          <div className="mark">&gt;_</div>
          <h1>{label}</h1>
          <div className="sub">
            {!present
              ? `${label} is not available on ${hostName} now`
              : elsewhere !== null
                ? `${elsewhere}.`
                : `${label} is on ${hostName}, with a shell in its first tab at ${shortFolder(folder)}`}
          </div>
          <div className="nw-acts">
            <button className="btn pri" autoFocus disabled={!present} onClick={onStartAgent}>
              Start an agent in it <kbd>↩</kbd>
            </button>
            <button className="btn" disabled={!present} onClick={onOpenShell}>
              Open its shell
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
