// The SSH machines the user added, saved in the app's user-data folder as
// hosts.json, and their passwords. hosts.json holds no secret: a machine's
// sign-in method, and for a key file the path the user picked (read only when
// connecting). The password, or the key's passphrase, is kept encrypted by
// the SecretStore (src/main/secret-store.ts) in a slot the machine's record
// names (secretRef), read in the main process when connecting, and removed
// with the machine.
//
// The record and its secret commit together: a new
// secret goes to a new slot first, the rename of hosts.json naming it is the
// commit, and the old slot is dropped after. A failure before the commit
// leaves the old pair; slots no committed record names (an interrupted edit
// or remove) are dropped at start, before any connection, but only when
// hosts.json was read cleanly.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AddHostRequest, EditHostRequest, HostSettings, SshAuthMethod } from "../shared/ipc-contract";
import { officialSessionName } from "./herdr/commands";
import { redactSecrets } from "./herdr/errors";
import { AuthLatch, type SshHostConfig } from "./herdr/ssh";
import { decodeStrictUtf8, type SecretStore } from "./secret-store";

/** A machine as hosts.json keeps it: never its secret. */
export interface SavedHost extends Omit<SshHostConfig, "auth" | "secret"> {
  readonly id: string;
  readonly name: string;
  readonly auth: SshAuthMethod;
  /**
   * The secret store slot holding this machine's password or passphrase, or
   * null for none. Not a secret. A record from the first password build has
   * none and reads as its id (where that build kept it).
   */
  readonly secretRef: string | null;
}

/**
 * Checks an Add host request; returns the host to save (with a new id, or
 * `id` for an edit), or throws with what is wrong. The secret is checked by
 * SavedHosts, which keeps it.
 */
export function validateAddHost(request: AddHostRequest, fileExists: (path: string) => boolean = isFile, id: string = randomUUID()): SavedHost {
  const host = request.host.trim();
  const username = request.username.trim();
  if (host === "" || /\s/.test(host)) throw new Error("Enter the machine's address.");
  if (username === "" || /\s/.test(username)) throw new Error("Enter the SSH user name.");
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65_535) {
    throw new Error("The port is a number from 1 to 65535.");
  }
  let keyPath = "";
  if (request.auth === "key") {
    keyPath = request.keyPath.trim();
    if (keyPath === "") throw new Error("Choose the private key file.");
    if (!fileExists(keyPath)) throw new Error("The key file is not there.");
  }
  const session = officialSessionName(request.herdrSession === "" ? "default" : request.herdrSession);
  if (session === null) throw new Error("A Herdr session name is letters, digits, dot, dash and underscore.");
  const name = request.name.trim() === "" ? host : request.name.trim();
  return { id, name, host, port: request.port, username, auth: request.auth, privateKeyPath: keyPath, herdrSession: session, secretRef: null };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A machine from hosts.json; one saved before passwords (no `auth`) is a key-file machine. */
function savedHost(value: unknown): SavedHost | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const auth = v["auth"] === undefined ? "key" : v["auth"];
  if (
    typeof v["id"] !== "string" ||
    typeof v["name"] !== "string" ||
    typeof v["host"] !== "string" ||
    typeof v["port"] !== "number" ||
    typeof v["username"] !== "string" ||
    typeof v["privateKeyPath"] !== "string" ||
    typeof v["herdrSession"] !== "string" ||
    officialSessionName(v["herdrSession"]) === null ||
    (auth !== "key" && auth !== "password") ||
    (v["secretRef"] !== undefined && v["secretRef"] !== null && typeof v["secretRef"] !== "string")
  ) {
    return null;
  }
  return {
    id: v["id"],
    name: v["name"],
    host: v["host"],
    port: v["port"],
    username: v["username"],
    auth,
    privateKeyPath: v["privateKeyPath"],
    herdrSession: v["herdrSession"],
    secretRef: v["secretRef"] === undefined ? v["id"] : (v["secretRef"] as string | null),
  };
}

export class HostStore {
  constructor(private readonly path: string) {}

  load(): SavedHost[] {
    return this.read().hosts;
  }

  /** The machines, and whether hosts.json was there and read cleanly (only then may secrets be reconciled with it). */
  read(): { hosts: SavedHost[]; clean: boolean } {
    if (!existsSync(this.path)) return { hosts: [], clean: false };
    try {
      // Strict UTF-8, as the secret store: a damaged byte in a
      // secretRef must not become a misnamed slot that recovery prunes past.
      const text = decodeStrictUtf8(readFileSync(this.path));
      if (text === null) return { hosts: [], clean: false };
      const parsed = JSON.parse(text) as { hosts?: unknown };
      if (!Array.isArray(parsed.hosts)) return { hosts: [], clean: false };
      const hosts = parsed.hosts.map(savedHost);
      const valid = hosts.filter((host): host is SavedHost => host !== null);
      return { hosts: valid, clean: valid.length === hosts.length };
    } catch {
      return { hosts: [], clean: false };
    }
  }

  save(hosts: readonly SavedHost[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    // Only these fields, so nothing else a caller carries can reach the file.
    const plain = hosts.map(({ id, name, host, port, username, auth, privateKeyPath, herdrSession, secretRef }) => ({
      id,
      name,
      host,
      port,
      username,
      auth,
      privateKeyPath,
      herdrSession,
      secretRef,
    }));
    writeFileSync(temp, `${JSON.stringify({ version: 1, hosts: plain }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

/** What becomes of a machine's saved secret on Add or Edit. */
type SecretChange = { readonly kind: "keep" } | { readonly kind: "clear" } | { readonly kind: "set"; readonly value: string };

function secretChange(request: AddHostRequest, previous: { auth: SshAuthMethod; saved: boolean } | null): SecretChange {
  const sameMethod = previous !== null && previous.auth === request.auth && previous.saved;
  if (request.auth === "password") {
    if (request.secret === null && sameMethod) return { kind: "keep" };
    if (request.secret === null || request.secret === "") throw new Error("Enter the password.");
    return { kind: "set", value: request.secret };
  }
  if (request.secret === null) return sameMethod ? { kind: "keep" } : { kind: "clear" };
  return request.secret === "" ? { kind: "clear" } : { kind: "set", value: request.secret };
}

/**
 * The saved machines and their secrets, together: Add, Edit and Remove keep
 * hosts.json and the secret store in step, and a secret that cannot be
 * encrypted refuses the whole change before anything is written.
 */
export class SavedHosts {
  private hosts: SavedHost[];

  constructor(
    private readonly store: HostStore,
    private readonly secrets: SecretStore,
    private readonly fileExists: (path: string) => boolean = isFile,
    load = true,
    /** Run start-up recovery (only the instance holding the app's single-instance lock does). */
    recover = true,
  ) {
    const read = load ? store.read() : { hosts: [], clean: false };
    this.hosts = read.hosts;
    // Recover an interrupted edit or remove: drop the slots no committed record names.
    if (recover && read.clean) {
      attempt(() => this.secrets.retain(this.hosts.flatMap((host) => (host.secretRef === null ? [] : [host.secretRef]))));
    }
  }

  list(): readonly SavedHost[] {
    return this.hosts;
  }

  passwordsAvailable(): boolean {
    return this.secrets.available();
  }

  add(request: AddHostRequest): SavedHost {
    const valid = validateAddHost(request, this.fileExists);
    const change = secretChange(request, null);
    const secretRef = this.writeSecret(valid, change);
    const host: SavedHost = { ...valid, secretRef };
    this.commit([...this.hosts, host], secretRef);
    return host;
  }

  update(request: EditHostRequest): SavedHost {
    const index = this.hosts.findIndex((candidate) => candidate.id === request.id);
    const previous = this.hosts[index];
    if (previous === undefined) throw new Error("That machine is no longer saved.");
    const valid = validateAddHost(request, this.fileExists, previous.id);
    const saved = previous.secretRef !== null && this.secrets.has(previous.secretRef);
    const change = secretChange(request, { auth: previous.auth, saved });
    // A new secret goes to a new slot; when it cannot be encrypted, nothing changes.
    const secretRef = change.kind === "keep" ? previous.secretRef : this.writeSecret(valid, change);
    const host: SavedHost = { ...valid, secretRef };
    const next = [...this.hosts];
    next[index] = host;
    this.commit(next, change.kind === "set" ? secretRef : null);
    // Committed: the old slot is no longer named. If dropping it fails, the next start does.
    if (previous.secretRef !== null && previous.secretRef !== secretRef) {
      const old = previous.secretRef;
      attempt(() => this.secrets.remove(old));
    }
    return host;
  }

  /**
   * Removes the machine, then its secret. When hosts.json cannot be written,
   * or the secrets file cannot be read, both stay (and this throws); when only the secret's cleanup fails, its
   * slot is no longer named and goes at the next start.
   */
  remove(id: string): boolean {
    const host = this.hosts.find((candidate) => candidate.id === id);
    if (host === undefined) return false;
    // The secrets file must be readable first: when it is not, both stay.
    if (host.secretRef !== null) this.secrets.has(host.secretRef);
    this.saveHosts(this.hosts.filter((candidate) => candidate.id !== id));
    const slot = host.secretRef;
    if (slot !== null) attempt(() => this.secrets.remove(slot));
    return true;
  }

  /** The machine for Edit: whether a secret is saved, never the secret. */
  settings(id: string): HostSettings | null {
    const host = this.hosts.find((candidate) => candidate.id === id);
    if (host === undefined) return null;
    return {
      id: host.id,
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      auth: host.auth,
      keyPath: host.privateKeyPath,
      herdrSession: host.herdrSession,
      secretSaved: host.secretRef !== null && this.secrets.has(host.secretRef),
    };
  }

  /**
   * What the SSH connection is given: the machine, the secret of its
   * committed slot (read when connecting), and a fresh sign-in latch (new
   * credentials are tried again; Try again resets it).
   */
  connectConfig(host: SavedHost, authLatch: AuthLatch = new AuthLatch()): SshHostConfig {
    const { secretRef, ...config } = host;
    const secrets = this.secrets;
    return { ...config, secret: () => (secretRef === null ? null : secrets.read(secretRef)), authLatch };
  }

  /**
   * Takes every saved password and passphrase out of a text: error texts on
   * their way to the page. A secret that cannot be
   * read cannot be taken out, and was not used to connect either.
   */
  redact(text: string): string {
    return redactSecrets(text, this.savedSecrets());
  }

  /**
   * `redact` with the saved secrets read (and decrypted) once, now, for many
   * texts: the launch cache's one write, so it does not decrypt per text.
   */
  redactor(): (text: string) => string {
    const secrets = this.savedSecrets();
    return (text) => redactSecrets(text, secrets);
  }

  private savedSecrets(): (string | null)[] {
    return this.hosts.map((host) => {
      if (host.secretRef === null) return null;
      try {
        return this.secrets.read(host.secretRef);
      } catch {
        return null;
      }
    });
  }

  /** Saves a new secret in a new slot; the slot, or null when the machine keeps none. */
  private writeSecret(host: SavedHost, change: SecretChange): string | null {
    if (change.kind !== "set") return null;
    const slot = `${host.id}.${randomUUID()}`;
    this.secrets.write(slot, change.value, host.auth === "password" ? "password" : "passphrase");
    return slot;
  }

  /** Writes hosts.json (the commit); on failure drops the slot written for it and throws. */
  private commit(hosts: SavedHost[], newSlot: string | null): void {
    try {
      this.saveHosts(hosts);
    } catch (error) {
      if (newSlot !== null) attempt(() => this.secrets.remove(newSlot));
      throw error;
    }
  }

  private saveHosts(hosts: SavedHost[]): void {
    this.store.save(hosts);
    this.hosts = hosts;
  }
}

/** Best-effort cleanup: a slot left behind is dropped at the next start. */
function attempt(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // left for start-up recovery
  }
}
