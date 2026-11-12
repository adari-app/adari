// Herdr's agent integrations on the page.
// Chat's no-session state names a missing or old integration with Install or
// Update (ChatIntegration), and Settings › Machines lists each connected
// machine's on one line (IntegrationsLine). Both read the machine's
// HostView.integrations (the main process's list, read on that connection,
// and the last click's outcome) and send the same click: bound to the machine
// as the window shows it, never on its own (src/main/integrations.ts).

import { useSyncExternalStore } from "react";

import type { HerdrDesktopBridge, HostView } from "../../shared/ipc-contract";
import {
  integrationActionOf,
  integrationButton,
  integrationItem,
  integrationStateWords,
  integrationTargetOf,
  integrationTexts,
  type IntegrationBinding,
  type IntegrationItem,
  type IntegrationOutcome,
} from "../../shared/integrations";
import type { SidebarRow } from "../../shared/sidebar-model";
import { ChatEarlyBadge } from "./agent-kind";
import { useRestart } from "./restart-view";

/** The click's binding: the machine's entry, connection and command connection as `host` shows them. */
export function integrationBindingOf(host: Pick<HostView, "incarnation" | "connection" | "epoch">): IntegrationBinding {
  return { incarnation: host.incarnation ?? 0, connection: host.connection ?? 0, epoch: host.epoch ?? null };
}

/** A refusal the main process gave a click (nothing was sent), per machine and target, until the next click. */
class IntegrationNotes {
  private readonly notes = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private serial = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  version = (): number => this.serial;

  note(hostId: string, target: string): string | null {
    return this.notes.get(`${hostId}|${target}`) ?? null;
  }

  set(hostId: string, target: string, note: string | null): void {
    const key = `${hostId}|${target}`;
    if ((this.notes.get(key) ?? null) === note) return;
    if (note === null) this.notes.delete(key);
    else this.notes.set(key, note);
    this.serial += 1;
    for (const listener of this.listeners) listener();
  }

  /** Clicks under way (one click, one ask). */
  readonly asking = new Set<string>();

  reset(): void {
    this.notes.clear();
    this.asking.clear();
    this.serial += 1;
  }
}

export const integrationNotes = new IntegrationNotes();

/** A main-process rejection as the page puts it (Electron's "Error invoking remote method …" taken off). */
function reason(failure: unknown): string {
  return String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** Your Install or Update on `target`: one ask to the main process, bound to `host` as shown; a refusal is kept as a note. */
export async function clickInstall(bridge: Pick<HerdrDesktopBridge, "installIntegration">, host: HostView, target: string): Promise<void> {
  const key = `${host.id}|${target}`;
  if (integrationNotes.asking.has(key)) return;
  integrationNotes.set(host.id, target, null);
  if (typeof bridge.installIntegration !== "function") {
    integrationNotes.set(host.id, target, integrationTexts.unavailable);
    return;
  }
  integrationNotes.asking.add(key);
  try {
    const reply = await bridge.installIntegration(host.id, target, integrationBindingOf(host));
    if (!reply.sent) integrationNotes.set(host.id, target, reply.note);
  } catch (error) {
    integrationNotes.set(host.id, target, `Not installed: ${reason(error)}`);
  } finally {
    integrationNotes.asking.delete(key);
  }
}

/** What Chat's no-session state shows for an integration (ChatIntegration draws it). */
export interface ChatIntegrationLook {
  readonly item: IntegrationItem;
  /** The main line: why Chat has nothing, what is under way, or that it was installed. */
  readonly line: string;
  /** A second line: the last click's failure, or a refusal (nothing sent). */
  readonly note: string | null;
  /** Herdr's own lines from the install. */
  readonly messages: readonly string[];
  /** Install or Update (disabled while one runs); null: none. */
  readonly button: { readonly label: string; readonly disabled: boolean } | null;
  /** The agent's Restart beside it (after an install, only where it can work). */
  readonly restart: boolean;
}

/**
 * Chat's no-session state for an agent of `kind` on `host`: null (today's line) unless Herdr listed its integration
 * as not installed or out of date on this connection, or a click on it left an outcome or a note.
 *
 * After an install, `restartWorks` (the agent's resume-based Restart can run for
 * this pane: restartResumes) shows the existing Restart; without it (no session id to resume, or a kind with no
 * resume-based Restart) the line gives the steps instead, beside Show the terminal, and no greyed Restart shows.
 *
 * `paneId`'s agent started after the integration was in place (the main process lists the
 * panes Adari's New agent started then: HostIntegrations.startedAfter): no steps, only that Chat shows its replies
 * after the first message. Any other pane keeps the steps after an install (Adari cannot tell when it started).
 * A pane whose screen showed the hook review (HostIntegrations.hookReviewed) gets
 * the conservative line until its session is named, never the first-message one.
 * A fresh read that says not installed or out of date clears the Installed outcome in the
 * main process, so Install or Update shows again here.
 */
export function chatIntegrationLook(
  host: HostView,
  kind: string | null | undefined,
  note: string | null,
  restartWorks = false,
  paneId: string | null = null,
): ChatIntegrationLook | null {
  const item = integrationItem(host.integrations, integrationTargetOf(kind));
  if (item === null) return null;
  const outcome: IntegrationOutcome | undefined = host.integrations?.outcomes[item.target];
  const action = integrationActionOf(item.state);
  const inPlace = item.state === "current" || outcome?.phase === "installed";
  // A pane that showed the hook review, no session yet: your choice is not known.
  if (inPlace && paneId !== null && (host.integrations?.hookReviewed?.[item.target] ?? []).includes(paneId)) {
    return { item, line: integrationTexts.hookOff(item.name), note, messages: [], button: null, restart: false };
  }
  if (inPlace && paneId !== null && (host.integrations?.startedAfter?.[item.target] ?? []).includes(paneId)) {
    return { item, line: integrationTexts.firstMessage(item.name), note, messages: [], button: null, restart: false };
  }
  if (outcome?.phase === "installed") {
    const line = restartWorks ? outcome.text : integrationTexts.installedSteps(item.name);
    return { item, line, note, messages: outcome.messages, button: null, restart: restartWorks };
  }
  if (action === null) return null;
  const cause = integrationTexts.cause(item.name, host.name, item.state as "not_installed" | "outdated");
  if (outcome?.phase === "installing") {
    return { item, line: cause, note: outcome.text, messages: [], button: { label: integrationButton[action], disabled: true }, restart: false };
  }
  return {
    item,
    line: cause,
    note: note ?? (outcome?.phase === "failed" ? outcome.text : null),
    messages: outcome?.messages ?? [],
    button: { label: integrationButton[action], disabled: false },
    restart: false,
  };
}

/** The note a click left for the target (subscribed: a refusal shows when it comes). */
export function useIntegrationNote(hostId: string, target: string | null): string | null {
  useSyncExternalStore(integrationNotes.subscribe, integrationNotes.version);
  return target === null ? null : integrationNotes.note(hostId, target);
}

/** Herdr's lines, each as plain text. */
function messageLines(lines: readonly string[]) {
  if (lines.length === 0) return null;
  return (
    <div className="int-msgs">
      {lines.map((line, index) => (
        <div key={index}>{line}</div>
      ))}
    </div>
  );
}

/** Chat's no-session state for a missing or old integration: the line, Herdr's messages, Install or Update, and after it Restart (where it can work) or the steps. */
export function ChatIntegration({ host, row, look, onShowTerminal }: { host: HostView; row: SidebarRow; look: ChatIntegrationLook; onShowTerminal(): void }) {
  const restart = useRestart(host, row);
  const bridge = window.herdrDesktop;
  return (
    <div className="chat-int" data-integration={look.item.target} data-integration-state={look.item.state}>
      <div className="chat-int-line">{look.line}</div>
      {look.note === null ? null : <div className="chat-int-note">{look.note}</div>}
      {messageLines(look.messages)}
      <div className="chat-int-acts">
        {look.button === null ? null : (
          <button className="btn sm pri" data-integration-install={look.item.target} disabled={look.button.disabled} onClick={() => void clickInstall(bridge, host, look.item.target)}>
            {look.button.label}
          </button>
        )}
        {look.restart ? (
          <button className="btn sm" data-integration-restart="" disabled={restart.disabledReason !== null} {...(restart.disabledReason === null ? {} : { title: restart.disabledReason })} onClick={restart.run}>
            Restart
          </button>
        ) : null}
        <button className="btn sm" onClick={onShowTerminal}>
          Show the terminal
        </button>
      </div>
      {look.restart && (restart.note ?? restart.disabledReason) !== null ? <div className="chat-int-note">{restart.note ?? `Restart: ${restart.disabledReason}`}</div> : null}
    </div>
  );
}

/** Settings › Machines: the machine's shown integrations whose agent Herdr finds there (`available`), each with its state. */
export function settingsIntegrationItems(host: HostView): IntegrationItem[] {
  if (host.state !== "connected") return [];
  return (host.integrations?.items ?? []).filter((item) => item.available);
}

/** One line under a connected machine in Settings › Machines: "Codex: not installed · Install", with the outcomes under it. */
export function IntegrationsLine({ host, bridge }: { host: HostView; bridge: Pick<HerdrDesktopBridge, "installIntegration"> }) {
  useSyncExternalStore(integrationNotes.subscribe, integrationNotes.version);
  const items = settingsIntegrationItems(host);
  if (items.length === 0) return null;
  const outcomes = host.integrations?.outcomes ?? {};
  const notes = items.flatMap((item) => {
    const outcome = outcomes[item.target];
    const note = integrationNotes.note(host.id, item.target);
    const lines = [...(outcome === undefined ? [] : [outcome.text]), ...(note === null ? [] : [note]), ...(outcome?.messages ?? [])];
    return lines.length === 0 ? [] : [{ target: item.target, lines }];
  });
  return (
    <div className="set-int" data-integrations={host.id}>
      <div className="set-int-line">
        {items.map((item) => {
          const action = integrationActionOf(item.state);
          const installing = outcomes[item.target]?.phase === "installing";
          return (
            <span className="set-int-i" key={item.target} data-integration={item.target} data-integration-state={item.state}>
              {item.name}
              {/* An early kind's Chat says Early here too (its name's badge). */}
              <ChatEarlyBadge kind={item.kind} />
              {`: ${integrationStateWords[item.state]}`}
              {action === null ? null : (
                <>
                  {" · "}
                  <button className="set-int-b" data-integration-install={item.target} disabled={installing} onClick={() => void clickInstall(bridge, host, item.target)}>
                    {integrationButton[action]}
                  </button>
                </>
              )}
            </span>
          );
        })}
      </div>
      {notes.map((entry) => (
        <div className="set-int-out" key={entry.target} data-integration-out={entry.target}>
          {entry.lines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
