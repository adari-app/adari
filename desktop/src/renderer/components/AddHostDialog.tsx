// Add a machine, or edit one: address, user, the Herdr session, and how it
// signs in: a password (the default) or a private key
// file the user picks (its path only; nothing is copied) with an optional
// passphrase. A password or passphrase crosses once, to be saved encrypted in
// the main process; Edit only learns that one is saved, and leaving the field
// empty keeps it. The first connection shows the machine's host key to check
// and trust (HostKeyDialog); a later change is refused.

import { useState } from "react";

import type { AddHostRequest, HostSettings, HostView, SshAuthMethod } from "../../shared/ipc-contract";
import { CloseIcon } from "../icons";
import { useEscapeOwner } from "./escape-owners";

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

const pinNote = "The first connection shows the machine's host key to check and trust; a changed key is refused.";
const noPasswordStorage =
  "This computer can't save a password right now: its secure storage (the Keychain on a Mac) is not available. Use a key file.";

export interface AddHostDialogProps {
  /** The machine to edit, or null to add one. */
  readonly editing: HostSettings | null;
  /** Whether a password can be saved here (AppInfo.passwordStorage). */
  readonly passwordStorage: boolean;
  onClose(): void;
  /** The machines after the add, edit or remove. */
  onSaved(hosts: HostView[]): void;
}

export function AddHostDialog({ editing, passwordStorage, onClose, onSaved }: AddHostDialogProps) {
  useEscapeOwner();
  const [name, setName] = useState(editing?.name ?? "");
  const [host, setHost] = useState(editing?.host ?? "");
  const [port, setPort] = useState(String(editing?.port ?? 22));
  const [username, setUsername] = useState(editing?.username ?? "");
  const [session, setSession] = useState(editing?.herdrSession ?? "default");
  const [auth, setAuth] = useState<SshAuthMethod>(editing?.auth ?? "password");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keyPath, setKeyPath] = useState(editing?.keyPath ?? "");
  const [passphrase, setPassphrase] = useState("");
  // Edit: the passphrase saved for this machine is to be dropped.
  const [forgetPassphrase, setForgetPassphrase] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A secret saved for this machine under the method now chosen: an empty field keeps it.
  const savedPassword = editing !== null && editing.auth === "password" && editing.secretSaved;
  const savedPassphrase = editing !== null && editing.auth === "key" && editing.secretSaved && !forgetPassphrase;

  const secret = (): string | null => {
    if (auth === "password") return password !== "" ? password : savedPassword ? null : "";
    return passphrase !== "" ? passphrase : savedPassphrase ? null : "";
  };

  const passwordBlocked = auth === "password" && !passwordStorage && !(savedPassword && password === "");
  const ready =
    host.trim() !== "" &&
    username.trim() !== "" &&
    (auth === "password" ? password !== "" || savedPassword : keyPath.trim() !== "") &&
    !passwordBlocked;

  const finish = (request: Promise<HostView[]>): void => {
    setBusy(true);
    setError(null);
    request.then(
      (hosts) => {
        setBusy(false);
        onSaved(hosts);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(message(failure));
      },
    );
  };

  const save = (): void => {
    const request: AddHostRequest = {
      name,
      host,
      port: Number(port),
      username,
      auth,
      keyPath: auth === "key" ? keyPath : "",
      herdrSession: session,
      secret: secret(),
    };
    finish(editing === null ? window.herdrDesktop.addHost(request) : window.herdrDesktop.updateHost({ ...request, id: editing.id }));
  };

  const remove = (): void => {
    if (editing === null) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    finish(window.herdrDesktop.removeHost(editing.id));
  };

  const title = editing === null ? "Add a machine" : "Edit machine";
  const note = error ?? (auth === "password" && !passwordStorage ? noPasswordStorage : pinNote);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="dlg" role="dialog" aria-label={title} onKeyDown={(event) => event.key === "Escape" && onClose()}>
        <div className="dt">
          {title}
          <span className="sp" />
          <button className="ib" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="fld">
          <div className="lb">
            Name <span className="o">optional</span>
          </div>
          <input className="inp" aria-label="Name" value={name} placeholder="Mac mini" onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="fld fld-row">
          <div>
            <div className="lb">Address</div>
            <input className="inp mono" aria-label="Address" value={host} placeholder="mac-mini.local" onChange={(e) => setHost(e.target.value)} />
          </div>
          <div>
            <div className="lb">Port</div>
            <input className="inp mono" aria-label="Port" value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} />
          </div>
        </div>
        <div className="fld fld-row">
          <div>
            <div className="lb">User</div>
            <input className="inp mono" aria-label="User" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <div className="lb">Session</div>
            <input className="inp mono" aria-label="Session" value={session} onChange={(e) => setSession(e.target.value)} />
          </div>
        </div>
        <div className="fld">
          <div className="lb">Sign in with</div>
          <div className="seg auth-seg" role="group" aria-label="Sign in with">
            <button className={auth === "password" ? "on" : ""} data-auth="password" aria-pressed={auth === "password"} onClick={() => setAuth("password")}>
              Password
            </button>
            <button className={auth === "key" ? "on" : ""} data-auth="key" aria-pressed={auth === "key"} onClick={() => setAuth("key")}>
              Key file
            </button>
          </div>
        </div>
        {auth === "password" ? (
          <div className="fld">
            <div className="lb">Password</div>
            <div className="key-pick">
              <input
                className="inp"
                aria-label="Password"
                type={showPassword ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={password}
                placeholder={savedPassword ? "Saved · type a new one to replace it" : "The user's password on that machine"}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(event) => event.key === "Enter" && ready && !busy && save()}
              />
              <button className="btn" title={showPassword ? "Hide the password" : "Show the password"} onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="fld">
              <div className="lb">Private key file</div>
              <div className="key-pick">
                <input
                  className="inp mono"
                  aria-label="Private key file"
                  value={keyPath}
                  placeholder="Choose a key file"
                  onChange={(e) => setKeyPath(e.target.value)}
                />
                <button
                  className="btn"
                  onClick={() =>
                    void window.herdrDesktop.pickKeyFile().then((picked) => {
                      if (picked !== null) setKeyPath(picked);
                    })
                  }
                >
                  Choose…
                </button>
              </div>
            </div>
            <div className="fld">
              <div className="lb">
                Passphrase <span className="o">optional</span>
              </div>
              <div className="key-pick">
                <input
                  className="inp"
                  aria-label="Key passphrase"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={passphrase}
                  placeholder={savedPassphrase ? "Saved · type a new one to replace it" : "Only if the key has one"}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
                {savedPassphrase ? (
                  <button className="btn" title="Forget the saved passphrase" onClick={() => setForgetPassphrase(true)}>
                    Forget
                  </button>
                ) : null}
              </div>
            </div>
          </>
        )}
        <div className="df">
          {editing === null ? null : (
            <button className="btn danger" onClick={remove} disabled={busy}>
              {confirmRemove ? `Remove ${editing.name}` : "Remove…"}
            </button>
          )}
          <span className={error === null && !passwordBlocked ? "note" : "note err"}>{note}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" onClick={save} disabled={busy || !ready}>
            {editing === null ? "Add" : "Save"}
          </button>
        </div>
      </div>
    </>
  );
}
