// The machines' passwords and key passphrases, kept apart from hosts.json:
// each encrypted with Electron's safeStorage (on macOS with a key held in the
// login Keychain), and only the ciphertext written, to host-secrets.json in
// the app's user-data folder, readable by the user only (0600). Read in the
// main process when connecting; the page is told only that one is saved.
// Never logged. Each secret sits in a slot named by the machine's committed
// record in hosts.json (see SavedHosts in host-store.ts).

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** What the store needs from Electron's safeStorage (a fake in tests). */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: "basic_text" means no keyring, so no real encryption. */
  getSelectedStorageBackend?(): string;
}

export type SecretKind = "password" | "passphrase";

export class SecretsUnavailableError extends Error {
  constructor(readonly kind: SecretKind) {
    super(
      `This computer can't encrypt a ${kind} right now (its secure storage, the Keychain on a Mac, is not available), ` +
        `so the ${kind} is not saved. A key file${kind === "passphrase" ? " without a passphrase" : ""} still works.`,
    );
    this.name = "SecretsUnavailableError";
  }
}

/** The secrets file could be read by others and could not be made private: it is not read. */
export class SecretFileError extends Error {
  constructor(readonly code: string) {
    super(
      `The saved passwords file can be read by other users of this computer and could not be made private (${code}), ` +
        "so it is not read. Check the permissions of host-secrets.json in the app's data folder.",
    );
    this.name = "SecretFileError";
  }
}

/**
 * host-secrets.json is there but could not be read, or is not this store's
 * file. Nothing is written over it: every change refuses with
 * these words, and a connection says it could not read the saved password.
 */
export class SecretStoreReadError extends Error {
  constructor(readonly reason: string) {
    super(`Could not read the saved passwords (${reason}); nothing was changed.`);
    this.name = "SecretStoreReadError";
  }
}

/** The bytes as UTF-8, or null when they are not valid UTF-8 (never a U+FFFD stand-in). */
export function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** File operations the store needs beyond reading and writing (a seam for the tests). */
export interface SecretFileOps {
  chmod(path: string, mode: number): void;
}

interface SecretFile {
  readonly version: 1;
  /** Host id to the safeStorage ciphertext, base64. */
  readonly secrets: Record<string, string>;
}

export class SecretStore {
  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher,
    private readonly ops: SecretFileOps = { chmod: chmodSync },
  ) {}

  /** Whether a secret can be saved: real encryption, not Linux's plain-text fallback. */
  available(): boolean {
    try {
      if (!this.cipher.isEncryptionAvailable()) return false;
      return this.cipher.getSelectedStorageBackend?.() !== "basic_text";
    } catch {
      return false;
    }
  }

  has(id: string): boolean {
    return Object.hasOwn(this.load(), id);
  }

  /**
   * The secret, or null when none is saved or it cannot be decrypted. Throws
   * when the file cannot be read (SecretStoreReadError, SecretFileError).
   */
  read(id: string): string | null {
    const sealed = this.load()[id];
    if (sealed === undefined) return null;
    try {
      return this.cipher.decryptString(Buffer.from(sealed, "base64"));
    } catch {
      return null;
    }
  }

  /** Encrypts and saves; throws SecretsUnavailableError (nothing written) when it cannot encrypt. */
  write(id: string, secret: string, kind: SecretKind = "password"): void {
    if (!this.available()) throw new SecretsUnavailableError(kind);
    const sealed = this.cipher.encryptString(secret).toString("base64");
    this.save({ ...this.load(), [id]: sealed });
  }

  remove(id: string): void {
    const secrets = this.load();
    if (!Object.hasOwn(secrets, id)) return;
    const rest = { ...secrets };
    delete rest[id];
    this.save(rest);
  }

  /**
   * Drops every slot not in `slots`: the leftovers of an edit or a remove that
   * was interrupted. Only called with the slots a hosts.json that was read
   * cleanly names (a damaged one names none and would wipe them all).
   */
  retain(slots: Iterable<string>): void {
    const keep = new Set(slots);
    const secrets = this.load();
    const kept = Object.fromEntries(Object.entries(secrets).filter(([slot]) => keep.has(slot)));
    if (Object.keys(kept).length !== Object.keys(secrets).length) this.save(kept);
  }

  /**
   * Deletes every write this store left unfinished (<file>.<pid>.tmp, from
   * any process): old encrypted copies, never promoted. Called at start under the app's single-instance lock, and after each
   * write, when no other write can be in flight.
   */
  discardStaleTemps(): void {
    const folder = dirname(this.path);
    const prefix = `${basename(this.path)}.`;
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(prefix) && /^\d+\.tmp$/.test(name.slice(prefix.length))) rmSync(join(folder, name), { force: true });
    }
  }

  /** An existing file wider than 0600 is made 0600 before it is read; throws SecretFileError when it cannot be. */
  private makePrivate(): void {
    let mode: number;
    try {
      mode = statSync(this.path).mode & 0o777;
    } catch {
      return;
    }
    if ((mode & 0o077) === 0) return;
    try {
      this.ops.chmod(this.path, 0o600);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw new SecretFileError(typeof code === "string" ? code : "unknown error");
    }
  }

  /**
   * The saved slots. A missing file is an empty store; a file that is there
   * but cannot be read, or is not this store's JSON, throws
   * SecretStoreReadError: every change refuses on it rather than
   * writing an empty store over committed secrets.
   */
  private load(): Record<string, string> {
    this.makePrivate();
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.path);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") return {};
      throw new SecretStoreReadError(typeof code === "string" ? code : "unreadable");
    }
    // Strict UTF-8: a lossy decode would turn a damaged byte into
    // U+FFFD and a partial, misnamed slot map that looks valid.
    const text = decodeStrictUtf8(bytes);
    if (text === null) throw new SecretStoreReadError("damaged");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SecretStoreReadError("damaged");
    }
    const secrets = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Partial<SecretFile>).secrets : undefined;
    if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) throw new SecretStoreReadError("damaged");
    const entries = Object.entries(secrets);
    if (!entries.every((entry) => typeof entry[1] === "string")) throw new SecretStoreReadError("damaged");
    return Object.fromEntries(entries);
  }


  private save(secrets: Record<string, string>): void {
    if (Object.keys(secrets).length === 0) {
      rmSync(this.path, { force: true });
      this.discardStaleTemps();
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    const file: SecretFile = { version: 1, secrets };
    rmSync(temp, { force: true }); // a leftover from a crash keeps its own mode; start fresh at 0600
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
    this.discardStaleTemps();
  }
}
