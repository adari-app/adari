// Host-key pinning, ported from HerdrKit (Sources/HerdrKit/HostKeyPinning.swift).
//
// The policy is the Swift one: the presented key's fingerprint is the SHA-256
// of its SSH wire encoding (type tag plus key material), hex-encoded; pins are
// keyed by `host:port`; the same key is trusted again, and a changed key is
// refused before authentication. A first key is never pinned by itself. With no
// pin the answer is "ask": the key exchange ends with a NewHostKeyError naming
// the key (OpenSSH's SHA256: fingerprint and its type) before any password, key
// signature or command, nothing is stored, and the page asks. Its Trust pins
// exactly that key through the store's one compare-and-pin (there is no
// lookup-then-store API to misuse) and connects again.
//
// The Swift PinStore is in-memory and the app supplies its own persistence; here
// the persistent store is a small JSON file in the app's user-data folder (no
// Keychain), so a pin survives a restart.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** trust: the pinned key; reject: another key is pinned, or the pins cannot be read; ask: nothing is pinned. */
export type HostKeyDecision = "trust" | "reject" | "ask";

/** SHA-256 of a host key's SSH wire encoding, lowercase hex (64 characters). */
export function sshHostKeyFingerprintSHA256(wireKey: Uint8Array): string {
  return createHash("sha256").update(wireKey).digest("hex");
}

/** The same digest as OpenSSH shows it (`SHA256:` + unpadded base64), for people. */
export function openSSHFingerprint(wireKey: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(wireKey).digest("base64").replace(/=+$/, "")}`;
}

/** The wire encoding of an OpenSSH public key line (`type base64 [comment]`). */
export function wireKeyFromOpenSSHLine(line: string): Buffer {
  const parts = line.trim().split(/\s+/);
  const encoded = parts[1];
  if (parts.length < 2 || encoded === undefined) throw new Error("not an OpenSSH public key line");
  const blob = Buffer.from(encoded, "base64");
  // The blob starts with its own type tag; it must match the line's.
  const tagLength = blob.length >= 4 ? blob.readUInt32BE(0) : -1;
  const tag = tagLength >= 0 && 4 + tagLength <= blob.length ? blob.subarray(4, 4 + tagLength).toString("latin1") : "";
  if (tag !== parts[0]) throw new Error("the key's type tag does not match its line");
  return blob;
}

/** The type tag a wire-encoded key starts with ("ssh-ed25519"), or null. */
export function sshKeyType(wireKey: Uint8Array): string | null {
  const key = Buffer.from(wireKey);
  if (key.length < 4) return null;
  const length = key.readUInt32BE(0);
  if (length === 0 || length > 64 || 4 + length > key.length) return null;
  const tag = key.subarray(4, 4 + length).toString("latin1");
  return /^[\x21-\x7e]+$/.test(tag) ? tag : null;
}

/** OpenSSH's name for a key type in `ssh-keygen -l` (ED25519, ECDSA, RSA). */
export function keyTypeLabel(keyType: string): string {
  if (keyType === "ssh-ed25519") return "ED25519";
  if (keyType.startsWith("ecdsa-sha2-")) return "ECDSA";
  if (keyType === "ssh-rsa" || keyType === "rsa-sha2-256" || keyType === "rsa-sha2-512") return "RSA";
  if (keyType === "ssh-dss") return "DSA";
  return keyType;
}

/** Where to check a key on the Mac: its sshd's public key of that type. */
export function hostKeyCheckCommand(keyType: string): string {
  const files: Record<string, string> = {
    ED25519: "ssh_host_ed25519_key.pub",
    ECDSA: "ssh_host_ecdsa_key.pub",
    RSA: "ssh_host_rsa_key.pub",
    DSA: "ssh_host_dsa_key.pub",
  };
  return `ssh-keygen -lf /etc/ssh/${files[keyTypeLabel(keyType)] ?? "ssh_host_*_key.pub"}`;
}

/** The OpenSSH form of a pin (64 hex characters): the same digest, as the person is shown it. */
export function openSSHFingerprintOfPin(pin: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(pin)) return null;
  return `SHA256:${Buffer.from(pin, "hex").toString("base64").replace(/=+$/, "")}`;
}

export function pinKey(host: string, port: number): string {
  return `${host}:${port}`;
}

/** The pin file could not be written; nothing new was pinned. */
export class PinStorageError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`the host key could not be saved to ${path} (${detail})`);
    this.name = "PinStorageError";
  }
}

/**
 * The only write path is compareAndPin; `pinned` and `compare` are read-only.
 * A store that persists throws PinStorageError when a new pin cannot be saved,
 * and then has not pinned it. A connection only compares; compareAndPin runs
 * for the person's Trust.
 */
export interface PinStore {
  pinned(key: string): string | undefined;
  /** The pin's verdict on `presented` without writing: "ask" when nothing is pinned. */
  compare(key: string, presented: string): HostKeyDecision;
  compareAndPin(key: string, presented: string): "trust" | "reject";
}

export class MemoryPinStore implements PinStore {
  private readonly pins = new Map<string, string>();

  pinned(key: string): string | undefined {
    return this.pins.get(key);
  }

  compare(key: string, presented: string): HostKeyDecision {
    const existing = this.pins.get(key);
    if (existing === undefined) return "ask";
    return existing === presented ? "trust" : "reject";
  }

  compareAndPin(key: string, presented: string): "trust" | "reject" {
    const existing = this.pins.get(key);
    if (existing !== undefined) return existing === presented ? "trust" : "reject";
    this.pins.set(key, presented);
    return "trust";
  }
}

interface PinFile {
  readonly version: 1;
  readonly pins: Record<string, string>;
}

/**
 * Pins in a JSON file, written atomically (temp file then rename). The main
 * process is single-threaded and compareAndPin is synchronous, so two first
 * contacts cannot interleave between the read and the write. A file that cannot
 * be read as a pin file is never treated as "nothing pinned" (that would trust a
 * substituted key as a first contact): every evaluation is refused until it is
 * fixed or removed. A change is saved before it is published: a candidate map is
 * written and renamed into place, and only then becomes the store's pins, so a
 * pin that never reached the disk is never trusted.
 */
export class FilePinStore implements PinStore {
  private pins: Map<string, string> | null = null;
  private loadError: string | null = null;

  constructor(private readonly path: string) {}

  private load(): Map<string, string> | null {
    if (this.pins !== null || this.loadError !== null) return this.pins;
    if (!existsSync(this.path)) {
      this.pins = new Map();
      return this.pins;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PinFile>;
      if (parsed.version !== 1 || typeof parsed.pins !== "object" || parsed.pins === null) {
        throw new Error("unknown pin file format");
      }
      const pins = new Map<string, string>();
      for (const [key, value] of Object.entries(parsed.pins)) {
        if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`bad pin for ${key}`);
        pins.set(key, value);
      }
      this.pins = pins;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
    return this.pins;
  }

  /** Why the pin file is unusable, when it is. */
  get error(): string | null {
    this.load();
    return this.loadError;
  }

  pinned(key: string): string | undefined {
    return this.load()?.get(key);
  }

  compare(key: string, presented: string): HostKeyDecision {
    const pins = this.load();
    // A pin file that cannot be read is never "nothing pinned".
    if (pins === null) return "reject";
    const existing = pins.get(key);
    if (existing === undefined) return "ask";
    return existing === presented ? "trust" : "reject";
  }

  compareAndPin(key: string, presented: string): "trust" | "reject" {
    const pins = this.load();
    if (pins === null) return "reject";
    const existing = pins.get(key);
    if (existing !== undefined) return existing === presented ? "trust" : "reject";
    const candidate = new Map(pins);
    candidate.set(key, presented);
    this.save(candidate);
    this.pins = candidate;
    return "trust";
  }

  /** Forgets one endpoint's pin (the user removed the host); a failed save keeps it. */
  forget(key: string): void {
    const pins = this.load();
    if (pins === null || !pins.has(key)) return;
    const candidate = new Map(pins);
    candidate.delete(key);
    this.save(candidate);
    this.pins = candidate;
  }

  /** Writes `pins` to a temp file and renames it into place; throws PinStorageError, leaving no temp file. */
  private save(pins: ReadonlyMap<string, string>): void {
    const body: PinFile = { version: 1, pins: Object.fromEntries([...pins.entries()].sort()) };
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // the temp file was never created, or its folder is not writable
      }
      throw new PinStorageError(this.path, error instanceof Error ? error.message : String(error));
    }
  }
}

/** Asks on first contact (pins only on the person's Trust) and hard-stops on change (Swift `PinningHostKeyPolicy`). */
export class PinningHostKeyPolicy {
  constructor(private readonly store: PinStore) {}

  /** Compared with the pin, nothing written: "ask" when the endpoint has none. */
  evaluate(host: string, port: number, presented: string): HostKeyDecision {
    return this.store.compare(pinKey(host, port), presented);
  }

  /**
   * The person's Trust for a key they were shown: pins exactly
   * `fingerprint` while nothing is pinned for the endpoint, through the store's
   * one compare-and-pin. "trust": that key is the pin now; "reject": another key
   * got there first. Throws PinStorageError when the pin cannot be saved.
   */
  trustNewKey(host: string, port: number, fingerprint: string): "trust" | "reject" {
    return this.store.compareAndPin(pinKey(host, port), fingerprint);
  }

  pinnedFingerprint(host: string, port = 22): string | undefined {
    return this.store.pinned(pinKey(host, port));
  }
}

/** The presented key would have been pinned, but the pin could not be saved: refused until it can be. */
export class HostKeyStorageError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly fingerprint: string,
    readonly detail: string,
  ) {
    super(`the host key for ${host}:${port} could not be saved (${detail}); refusing to connect until it can be`);
    this.name = "HostKeyStorageError";
  }
}

export class HostKeyRejectedError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly fingerprint: string,
    readonly display: string,
  ) {
    super(`the host key for ${host}:${port} changed (now ${display}); refusing to connect`);
    this.name = "HostKeyRejectedError";
  }
}

/**
 * A host key seen for the first time for an endpoint with no
 * pin. Nothing was trusted or stored and nothing was sent: the key exchange
 * ended with this before any authentication. `fingerprint` is the pin Trust
 * stores (hex); `display` is the same digest as OpenSSH prints it, shown to
 * the person; `keyType` the key's type as the server sent it.
 */
export class NewHostKeyError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly fingerprint: string,
    readonly display: string,
    readonly keyType: string,
  ) {
    super(`${host}:${port} presented a host key this computer has not trusted (${keyType} ${display}); nothing was sent. Check it and trust it to connect.`);
    this.name = "NewHostKeyError";
  }
}

/**
 * The ssh2 `hostVerifier` for one endpoint (Swift `PinningHostKeyValidator`).
 * ssh2 passes the raw wire-format key when `hostHash` is not set; a rejection
 * stops the handshake (ssh2 sends no NEWKEYS) before any authentication or
 * command. First contact is refused the same way, as a NewHostKeyError for the
 * page to ask about. The last rejection is kept so the connection error can name it.
 */
export class PinningHostKeyValidator {
  lastRejection: HostKeyRejectedError | HostKeyStorageError | NewHostKeyError | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly policy: PinningHostKeyPolicy,
  ) {}

  readonly verify = (wireKey: Buffer): boolean => {
    const fingerprint = sshHostKeyFingerprintSHA256(wireKey);
    let decision: HostKeyDecision;
    try {
      decision = this.policy.evaluate(this.host, this.port, fingerprint);
    } catch (error) {
      // Pins that could not be read are not trusted; the connection error names the storage problem.
      const detail = error instanceof PinStorageError ? error.detail : error instanceof Error ? error.message : String(error);
      this.lastRejection = new HostKeyStorageError(this.host, this.port, fingerprint, detail);
      return false;
    }
    if (decision === "trust") return true;
    this.lastRejection =
      decision === "ask"
        ? new NewHostKeyError(this.host, this.port, fingerprint, openSSHFingerprint(wireKey), sshKeyType(wireKey) ?? "unknown")
        : new HostKeyRejectedError(this.host, this.port, fingerprint, openSSHFingerprint(wireKey));
    return false;
  };
}
