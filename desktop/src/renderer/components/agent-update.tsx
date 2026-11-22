// Update on an agent CLI in the window (src/shared/agent-update.ts
// says what it does). One button, on the CLI's row in Settings › Updates ›
// Agent CLIs and beside the update mark in the agent's header, shown only
// while the machine has an update command for that CLI. A click asks once,
// with the exact command and the machine's name; Run asks the main process
// (main/herdr/agent-update.ts), which opens the shell tab and types the
// command; the window then shows that tab's terminal. Cancel, Esc or the scrim
// send nothing. A refusal is one line under the button.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  agentUpdateBindingOf,
  agentUpdateTexts,
  isAgentUpdateAnswer,
  sameUpdateBinding,
  updateCliName,
  type AgentUpdateRequest,
} from "../../shared/agent-update";
import type { HerdrDesktopBridge, HostView } from "../../shared/ipc-contract";
import { updateCommandFor, type AgentStartCommands } from "../../shared/start-commands";
import { handoffStore } from "../handoff/handoff-state";
import { useEscapeOwner } from "./escape-owners";
import { startCommandsStore } from "./resume";

/** A main-process rejection as the page puts it (Electron's "Error invoking remote method …" taken off). */
function reason(failure: unknown): string {
  return String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** What came of Run: the tab opened, a refusal's words, or the question again with the command there now. */
export type UpdateRunOutcome =
  | { readonly type: "opened" }
  | { readonly type: "refused"; readonly note: string }
  | { readonly type: "ask"; readonly command: string };

/**
 * Run, after the confirmation: one ask to the main process for the question `request` on `hostId`; the new tab's pane
 * opened with `onOpened`. A file read afresh there is handed to `onCommands` (the window keeps it).
 */
export async function runUpdate(
  bridge: Pick<HerdrDesktopBridge, "runAgentUpdate">,
  hostId: string,
  request: AgentUpdateRequest,
  onOpened: (hostId: string, paneId: string) => void,
  onCommands?: (hostId: string, commands: AgentStartCommands) => void,
): Promise<UpdateRunOutcome> {
  if (typeof bridge.runAgentUpdate !== "function") return { type: "refused", note: "This build cannot run an update from here." };
  try {
    const answer: unknown = await bridge.runAgentUpdate(hostId, request);
    if (!isAgentUpdateAnswer(answer)) return { type: "refused", note: "The machine's answer could not be read." };
    if ("stale" in answer) {
      if (answer.stale.commands !== null) onCommands?.(hostId, answer.stale.commands);
      return answer.stale.command !== null ? { type: "ask", command: answer.stale.command } : { type: "refused", note: answer.stale.note ?? "" };
    }
    onOpened(hostId, answer.paneId);
    return { type: "opened" };
  } catch (error) {
    return { type: "refused", note: reason(error) };
  }
}

/** The machine's update command for `kind` as the window holds its start commands on this connection (null: none, or not read yet). */
export function useUpdateCommand(host: HostView, kind: string | null | undefined, wanted: boolean): string | null {
  const connection = handoffStore.life.connection(host.id);
  const commands = useSyncExternalStore(startCommandsStore.subscribe, () => startCommandsStore.get(host.id, connection));
  useEffect(() => {
    if (wanted && host.state === "connected") startCommandsStore.load(window.herdrDesktop, host.id, connection);
  }, [wanted, host.id, host.state, connection]);
  if (commands === null || kind === null || kind === undefined) return null;
  return updateCommandFor(commands, kind.toLowerCase());
}

export interface AgentUpdateButtonProps {
  readonly bridge: Pick<HerdrDesktopBridge, "runAgentUpdate">;
  /** The machine as the window shows it now (its binding is taken when the question opens). */
  readonly host: Pick<HostView, "id" | "name" | "incarnation" | "connection" | "epoch">;
  readonly kind: string;
  /** The machine's update command for the CLI (the button shows only with one). */
  readonly command: string;
  /** Where the tab goes (null: none known; the main process then refuses in the shell path's words). */
  readonly workspaceId: string | null;
  onOpened(hostId: string, paneId: string): void;
  /** The machine's file as Run read it afresh (Settings keeps it beside its own read). */
  onCommands?(hostId: string, commands: AgentStartCommands): void;
  /** The header's smaller look. */
  readonly compact?: boolean;
}

/** The question as it opened: what it shows and where it goes. */
interface UpdateQuestion {
  readonly request: AgentUpdateRequest;
  readonly machine: string;
  /** Asked again because the file held another command. */
  readonly again: boolean;
}

/** Update: the button, its one confirmation, and a refusal's line. */
export function AgentUpdateButton({ bridge, host, kind, command, workspaceId, onOpened, onCommands, compact = false }: AgentUpdateButtonProps) {
  const [question, setQuestion] = useState<UpdateQuestion | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const asking = question !== null;
  useEscapeOwner(asking);
  useEffect(() => {
    if (!asking) return;
    runButton.current?.focus();
    if (typeof window.addEventListener !== "function") return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setQuestion(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [asking]);
  // The machine changed while the question was open: it closes with one line; nothing is sent.
  const binding = agentUpdateBindingOf(host);
  const bindingKey = `${binding.incarnation}|${binding.connection}|${binding.epoch ?? ""}`;
  useEffect(() => {
    if (question === null || sameUpdateBinding(agentUpdateBindingOf(host), question.request.binding)) return;
    setQuestion(null);
    setNote(agentUpdateTexts.machineChanged(question.machine));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingKey, question]);
  const cli = updateCliName(kind);
  const ask = (): void => {
    setNote(null);
    setQuestion({ request: { kind, command, workspaceId: workspaceId ?? "", binding: agentUpdateBindingOf(host) }, machine: host.name, again: false });
  };
  const run = (): void => {
    const asked = question;
    setQuestion(null);
    if (asked === null || running) return;
    if (!sameUpdateBinding(agentUpdateBindingOf(host), asked.request.binding)) {
      setNote(agentUpdateTexts.machineChanged(asked.machine));
      return;
    }
    setRunning(true);
    setNote(null);
    const keep = (hostId: string, commands: AgentStartCommands): void => {
      startCommandsStore.saved(hostId, asked.request.binding.connection, commands);
      onCommands?.(hostId, commands);
    };
    void runUpdate(bridge, host.id, asked.request, onOpened, keep).then((outcome) => {
      setRunning(false);
      if (outcome.type === "ask") setQuestion({ ...asked, request: { ...asked.request, command: outcome.command }, again: true });
      else setNote(outcome.type === "refused" ? outcome.note : null);
    });
  };
  const shown = question?.request.command ?? command;
  const title = agentUpdateTexts.confirmTitle(shown, question?.machine ?? host.name);
  return (
    <span className={compact ? "agent-upd compact" : "agent-upd"} data-agent-update={`${host.id}/${kind}`}>
      <button
        className={compact ? "btn sm" : "btn sm pri"}
        data-agent-update-button=""
        title={agentUpdateTexts.buttonTitle(command, host.name)}
        disabled={running}
        onClick={(event) => {
          event.stopPropagation();
          ask();
        }}
      >
        {agentUpdateTexts.button}
      </button>
      {note === null ? null : (
        <span className="agent-upd-note set-bad" data-agent-update-note="">
          {note}
        </span>
      )}
      {question !== null ? (
        <>
          <div className="scrim" onClick={() => setQuestion(null)} />
          <div className="dlg confirm set-confirm" role="alertdialog" aria-label={title} data-agent-update-confirm="">
            <div className="dt">{title}</div>
            <div className="confirm-body">
              {question.again ? <div data-agent-update-again="">{agentUpdateTexts.askedAgain(question.machine)}</div> : null}
              <div className="mono agent-upd-cmd" data-agent-update-command="">
                {shown}
              </div>
              <div>{agentUpdateTexts.confirmBody(cli)}</div>
            </div>
            <div className="df">
              <span className="note" />
              <button className="btn" data-agent-update-cancel="" onClick={() => setQuestion(null)}>
                Cancel
              </button>
              <button className="btn pri" ref={runButton} data-agent-update-run="" onClick={run}>
                {agentUpdateTexts.confirmButton}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </span>
  );
}
