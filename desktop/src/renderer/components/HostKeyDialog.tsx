// "Trust this Mac?". The first
// connection to a machine stopped at its host key: nothing was sent to it (no
// password, no key signature, no command) and nothing was stored. The dialog
// shows the machine, the key's type, its SHA256 fingerprint as OpenSSH prints
// it and the command that prints it on the Mac. Trust and connect sends the
// question's id and that fingerprint back (the main process pins it only while
// that question is open and it is the key it asked about, then connects
// again); Cancel, or Escape, sends the question's id and stores nothing. An
// answer to a question no longer open does nothing. Clicking outside
// does not answer. Cancel has the focus, so Return never trusts.

import { useEffect, useRef, useState } from "react";

import type { HostKeyQuestion, HostView } from "../../shared/ipc-contract";
import { useEscapeOwner } from "./escape-owners";

export interface HostKeyDialogProps {
  readonly hostId: string;
  /** The machine as the sidebar names it. */
  readonly name: string;
  readonly question: HostKeyQuestion;
  /** The machines after the answer. */
  onAnswered(hosts: HostView[]): void;
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** host, [v6], or host:port when it is not 22. */
function endpoint(question: HostKeyQuestion): string {
  const host = question.host.includes(":") ? `[${question.host}]` : question.host;
  return question.port === 22 ? host : `${host}:${question.port}`;
}

export function HostKeyDialog({ hostId, name, question, onAnswered }: HostKeyDialogProps) {
  useEscapeOwner();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelButton.current?.focus(), []);

  const answer = (sending: () => Promise<HostView[]>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void sending().then(
      (hosts) => {
        setBusy(false);
        onAnswered(hosts);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(message(failure));
      },
    );
  };
  const trust = (): void => answer(() => window.herdrDesktop.trustHostKey(hostId, question.id, question.fingerprint));
  const cancel = (): void => answer(() => window.herdrDesktop.cancelHostKey(hostId, question.id));
  const where = endpoint(question);

  return (
    <>
      <div className="scrim" />
      <div
        className="dlg hostkey"
        role="alertdialog"
        aria-label="Trust this Mac?"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <div className="dt">Trust this Mac?</div>
        <div className="hk-body">
          This is the first connection to {name} from this computer. Nothing has been sent to it. Trust it only if the
          fingerprint below matches the one the Mac shows.
        </div>
        <dl className="hk-facts">
          <dt>Mac</dt>
          <dd>
            {name}
            {where === name ? null : <span className="mono hk-host">{where}</span>}
          </dd>
          <dt>Key type</dt>
          <dd className="mono">{question.typeLabel}</dd>
          <dt>Fingerprint</dt>
          <dd className="mono hk-fp">{question.fingerprint}</dd>
        </dl>
        <div className="hk-check-label">To check, run this on the Mac:</div>
        <div className="mono hk-check">{question.check}</div>
        <div className="df">
          <span className={error === null ? "note" : "note err"}>{error ?? ""}</span>
          <button className="btn" ref={cancelButton} onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn pri" onClick={trust} disabled={busy}>
            Trust and connect
          </button>
        </div>
      </div>
    </>
  );
}
