// Transport errors, after HerdrKit's TransportError (Sources/HerdrKit/Transport.swift):
// the cases the desktop shell can reach, with the Swift wording.

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * An attach line the app will not type into the PTY's shell: the terminal's
 * line discipline acts on control bytes before the shell's quoting does.
 */
export class UnsafeAttachTargetError extends TransportError {
  constructor(readonly reason: string) {
    super(`This pane's terminal id cannot be typed safely into the remote shell (${reason}), so it is not attached.`);
    this.name = "UnsafeAttachTargetError";
  }
}

export class RequestTooLargeError extends TransportError {
  constructor(
    readonly bytes: number,
    readonly max: number,
  ) {
    super(`request too large for the argument transport: ${bytes} > ${max} command bytes`);
    this.name = "RequestTooLargeError";
  }
}

export class ResponseTooLargeError extends TransportError {
  constructor(
    readonly bytes: number,
    readonly max: number,
  ) {
    super(`Herdr returned an oversized response line (${bytes} > ${max} bytes)`);
    this.name = "ResponseTooLargeError";
  }
}

export class ClosedBeforeResponseError extends TransportError {
  constructor() {
    super("peer closed before sending a response line");
    this.name = "ClosedBeforeResponseError";
  }
}

export class RemoteSocketFailedError extends TransportError {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`couldn't reach the official Herdr socket at ~/${path}: ${detail}`);
    this.name = "RemoteSocketFailedError";
  }
}

export class RequestTimedOutError extends TransportError {
  constructor(
    readonly seconds: number,
    /**
     * The request was written to the relay, or handed to SSH on the exec path,
     * before its deadline passed: Herdr may still carry it out (neither a cancel nor ending the SSH client can
     * recall it), so its result is unknown. False only for a request proved unwritten: it never left the app.
     */
    readonly mayHaveLanded: boolean = false,
  ) {
    super(`the host did not answer within ${seconds} seconds`);
    this.name = "RequestTimedOutError";
  }
}

export class ConnectTimedOutError extends TransportError {
  constructor(readonly host: string) {
    super(`couldn't reach ${host} in time. It may be offline, or on a network this computer cannot see.`);
    this.name = "ConnectTimedOutError";
  }
}

export class ConnectFailedError extends TransportError {
  constructor(
    readonly host: string,
    readonly detail: string,
  ) {
    super(`couldn't connect to ${host}: ${detail}`);
    this.name = "ConnectFailedError";
  }
}

/** Why a machine can't be found or reached, from the socket's error code. */
export type UnreachableReason = "notFound" | "refused" | "unreachable";

export function unreachableReason(code: string | undefined): UnreachableReason | null {
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EAI_NONAME":
    case "EAI_FAIL":
      return "notFound";
    case "ECONNREFUSED":
      return "refused";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EHOSTDOWN":
    case "ENETDOWN":
    case "ETIMEDOUT":
    case "EADDRNOTAVAIL":
      return "unreachable";
    default:
      return null;
  }
}

/** The address was not found, nothing answered there, or SSH is off: in words. Still a connect failure. */
export class HostUnreachableError extends ConnectFailedError {
  constructor(
    host: string,
    readonly port: number,
    readonly reason: UnreachableReason,
  ) {
    super(host, reason);
    this.message =
      reason === "notFound"
        ? `Can't find ${host} on the network. Check the address.`
        : reason === "refused"
          ? `${host} refused the connection on port ${port}. Is Remote Login (SSH) on there?`
          : `Can't reach ${host}. It may be offline, or on a network this computer cannot see.`;
    this.name = "HostUnreachableError";
  }
}

/**
 * The connection ended during sign-in for a reason ssh2 reports in the
 * server's own words (a DISCONNECT description, a protocol error): fixed
 * words instead, as that text can hold anything, even what was sent. Still a
 * connect failure.
 */
export class ClosedDuringSignInError extends ConnectFailedError {
  constructor(host: string) {
    super(host, "closed during sign-in");
    this.message = `The connection to ${host} was closed during sign-in.`;
    this.name = "ClosedDuringSignInError";
  }
}

/** Takes each secret out of a text (••• in its place); empty secrets are skipped. */
export function redactSecrets(text: string, secrets: Iterable<string | null>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret !== null && secret !== "") result = result.split(secret).join("•••");
  }
  return result;
}

export class AuthenticationFailedError extends TransportError {
  constructor(
    readonly host: string,
    readonly method: "password" | "key" = "key",
  ) {
    super(method === "password" ? "The Mac refused the password. Check it in Edit machine." : `authentication to ${host} failed. Check the key`);
    this.name = "AuthenticationFailedError";
  }
}

export class HerdrNotInstalledError extends TransportError {
  constructor(readonly host: string) {
    super(`herdr is not installed on ${host}`);
    this.name = "HerdrNotInstalledError";
  }
}

/**
 * This Mac's Herdr is not running (no socket where Herdr puts
 * it), with a short hint. Not a failure: the machines list shows it as a note
 * (HostView.notRunning), never as an error.
 */
export class HerdrNotRunningHereError extends TransportError {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "HerdrNotRunningHereError";
  }
}
