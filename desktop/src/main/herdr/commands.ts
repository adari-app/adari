// The remote commands, byte for byte as HerdrKit's CitadelTransport builds them
// (Sources/HerdrKit/CitadelTransport.swift): one SSH exec per request, the
// request JSON line base64-encoded inside a single-quoted argument, decoded on
// the host and handed to the official socket with `nc -U`; the PTY attach runs
// the resolved `herdr` binary. Plain strings throughout (no template literals),
// so `${XDG_CONFIG_HOME:-...}` reaches the remote shell as written.
//
// Note: `/usr/bin/base64 -D` is the macOS spelling (CitadelTransport targets
// Macs); a Linux host needs `-d`. Kept identical here.

import { RequestTooLargeError, UnsafeAttachTargetError } from "./errors";

/** Conservative ceiling on the SSH exec command, below common argv limits. */
export const maxCommandBytes = 120_000;
/** A control/event JSON line cannot consume unbounded memory. */
export const maxResponseLineBytes = 1_048_576;
export const maxDiagnosticBytes = 8_192;

export const defaultConnectTimeoutMs = 15_000;
export const defaultRoundTripTimeoutMs = 10_000;
/**
 * `agent.prompt`'s own deadline. Its reply can take longer than the default
 * 10 s while the agent works; a missed deadline ends the SSH client with the
 * request in flight (ssh.ts roundTrip), so under the default a Claude message
 * ends "Sent, but the Mac did not confirm it" and the user's first send while
 * Claude works never lands. Herdr's own refusals (agent_not_ready, timeout)
 * still come back as its errors within this.
 */
export const promptRoundTripTimeoutMs = 60_000;

export const herdrNotInstalledSentinel = "__HERDR_NOT_INSTALLED__";
export const socketMissingSentinel = "__HERDR_SOCKET_MISSING__";

export const defaultSessionName = "default";

/**
 * Resolves the official executable for PTY attach. Homebrew on Apple Silicon is
 * explicitly covered even though a non-login SSH shell may omit it.
 */
export const herdrPathResolution =
  'unset HERDR_SOCKET_PATH; HERDR=$(command -v herdr 2>/dev/null || true); for P in /opt/homebrew/bin/herdr /usr/local/bin/herdr "$HOME/.local/bin/herdr"; do [ -n "$HERDR" ] && break; [ -x "$P" ] && HERDR="$P"; done; [ -x "$HERDR" ] || { printf \'__HERDR_NOT_INSTALLED__\\n\' >&2; exit 127; }; ';

/** POSIX single-quote escaping, used for every user-controlled shell argument. */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\"'\"'") + "'";
}

/** The official socket is newline-delimited. */
export function socketPayload(requestLine: string): string {
  return requestLine.endsWith("\n") ? requestLine : requestLine + "\n";
}

/** The request, base64-encoded (UTF-8, standard alphabet, padded). */
export function encodedRequest(requestLine: string): string {
  return Buffer.from(requestLine, "utf8").toString("base64");
}

/**
 * A validated official Herdr session name (Swift `OfficialHerdrSession`):
 * trimmed, 1 to 64 bytes, not `.` or `..`, only [0-9A-Za-z._-].
 */
export function officialSessionName(raw: string): string | null {
  const name = raw.trim();
  if (name === "" || Buffer.byteLength(name, "utf8") > 64 || name === "." || name === "..") return null;
  return /^[0-9A-Za-z._-]+$/.test(name) ? name : null;
}

/** The session's API socket, relative to the SSH account's home folder. */
export function sessionSocketPath(session: string): string {
  if (session === defaultSessionName) return ".config/herdr/herdr.sock";
  return ".config/herdr/sessions/" + session + "/herdr.sock";
}

/**
 * Derives the selected official API socket exactly as official Herdr does,
 * including XDG_CONFIG_HOME; an inherited socket override is cleared.
 */
export function resolvedSocketSetup(session: string): string {
  const location =
    session === defaultSessionName
      ? 'SOCKET="$CONFIG_ROOT/herdr/herdr.sock"; '
      : 'SOCKET="$CONFIG_ROOT/herdr/sessions/"' + shellQuote(session) + '"/herdr.sock"; ';
  return (
    'unset HERDR_SOCKET_PATH; CONFIG_ROOT=${XDG_CONFIG_HOME:-"$HOME/.config"}; ' +
    location +
    '[ -S "$SOCKET" ] || { printf \'__HERDR_SOCKET_MISSING__\\n\' >&2; exit 66; }; '
  );
}

/**
 * Whether Herdr is on this computer, asked in the login shell:
 * prints `herdr` when the command resolves (`command -v`; it is never run)
 * and `socket` when the session's API socket exists where Herdr puts it (the
 * same rule as resolvedSocketSetup: XDG_CONFIG_HOME, else ~/.config, an
 * inherited override cleared). Always exits 0.
 */
export function herdrPresenceCommand(session: string): string {
  const location =
    session === defaultSessionName ? '"$CONFIG_ROOT/herdr/herdr.sock"' : '"$CONFIG_ROOT/herdr/sessions/"' + shellQuote(session) + '"/herdr.sock"';
  return (
    'unset HERDR_SOCKET_PATH; CONFIG_ROOT=${XDG_CONFIG_HOME:-"$HOME/.config"}; ' +
    "if command -v herdr >/dev/null 2>&1; then printf 'herdr\\n'; fi; " +
    "if [ -S " +
    location +
    " ]; then printf 'socket\\n'; fi; exit 0"
  );
}

/** herdrPresenceCommand's answer: its lines, each exactly `herdr` or `socket`. */
export function parseHerdrPresence(output: string): { herdr: boolean; socket: boolean } {
  const lines = new Set(output.split(/\r?\n/).map((line) => line.trim()));
  return { herdr: lines.has("herdr"), socket: lines.has("socket") };
}

function checkSize(command: string): string {
  const bytes = Buffer.byteLength(command, "utf8");
  if (bytes > maxCommandBytes) throw new RequestTooLargeError(bytes, maxCommandBytes);
  return command;
}

/** One-shot form for ordinary request/reply calls (CitadelTransport.officialRequestCommand). */
export function officialRequestCommand(requestLine: string, session: string): string {
  const payload = socketPayload(requestLine);
  return checkSize(
    resolvedSocketSetup(session) +
      "printf '%s' " +
      shellQuote(encodedRequest(payload)) +
      ' | /usr/bin/base64 -D | /usr/bin/nc -U "$SOCKET"',
  );
}

/** Sends one base64-encoded JSON line to one explicit socket (CitadelTransport.socketCommand). */
export function socketCommand(requestLine: string, remoteSocketPath: string): string {
  const path = remoteSocketPath === "" ? ".config/herdr/herdr.sock" : remoteSocketPath;
  return checkSize(
    'SOCKET="$HOME"/' +
      shellQuote(path) +
      "; [ -S \"$SOCKET\" ] || { printf '__HERDR_SOCKET_MISSING__\\n' >&2; exit 66; }; printf '%s\\n' " +
      shellQuote(encodedRequest(socketPayload(requestLine))) +
      ' | /usr/bin/base64 -D | /usr/bin/nc -U "$SOCKET"',
  );
}

/** A held bidirectional exec for subscriptions (CitadelTransport.heldSocketCommand). */
export function heldSocketCommand(session: string): string {
  return resolvedSocketSetup(session) + 'exec /usr/bin/nc -U "$SOCKET"';
}

export type AttachTarget =
  | { readonly kind: "agent"; readonly paneID: string }
  | { readonly kind: "terminal"; readonly terminalID: string };

/** The PTY attach line (CitadelTransport's OfficialTerminalConnection.attachCommand). */
export function attachCommand(target: AttachTarget, session: string, takeover = false): string {
  const command = target.kind === "agent" ? " agent attach " : " terminal attach ";
  const identifier = target.kind === "agent" ? target.paneID : target.terminalID;
  return (
    herdrPathResolution +
    'exec "$HERDR" --session ' +
    shellQuote(session) +
    command +
    shellQuote(identifier) +
    (takeover ? " --takeover" : "")
  );
}

/** The longest attach identifier the app types (bytes). Herdr's ids are short ASCII. */
export const maxAttachIdentifierBytes = 256;
/**
 * The longest line the app types into a PTY's shell, newline excluded: under
 * the terminal's canonical input limit (MAX_CANON is 1024 on macOS, 4096 on
 * Linux), past which the line discipline drops input.
 */
export const maxTypedLineBytes = 1000;

/**
 * True for text that is safe to TYPE into a PTY: printable ASCII only. Any C0
 * control or DEL can be a line-discipline character (VKILL, VERASE, VWERASE,
 * VLNEXT, VINTR, VEOF, …) acting before the shell sees its quotes; C1 controls
 * and every other byte >= 0x80 are refused too, because with ISTRIP set a
 * byte loses its high bit and can become one of those controls.
 */
export function isTypeable(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}

/**
 * The exact bytes the attach writes into the PTY: the attach command and a
 * newline, checked right before typing. The command is CitadelTransport's,
 * byte for byte; the checks are this app's.
 */
export function typedAttachLine(target: AttachTarget, session: string, takeover = false): string {
  const identifier = target.kind === "agent" ? target.paneID : target.terminalID;
  if (identifier === "") throw new UnsafeAttachTargetError("an empty id");
  if (!isTypeable(identifier)) throw new UnsafeAttachTargetError("a control or non-ASCII character in the id");
  if (Buffer.byteLength(identifier, "utf8") > maxAttachIdentifierBytes) {
    throw new UnsafeAttachTargetError(`an id over ${maxAttachIdentifierBytes} bytes`);
  }
  const command = attachCommand(target, session, takeover);
  if (!isTypeable(command)) throw new UnsafeAttachTargetError("a control or non-ASCII character in the command");
  if (Buffer.byteLength(command, "utf8") > maxTypedLineBytes) {
    throw new UnsafeAttachTargetError(`a command over ${maxTypedLineBytes} bytes`);
  }
  return command + "\n";
}

/** Builds the request JSON line the way HerdrClient.encodeRequest does. */
export function requestLine(id: string, method: string, params: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ id, method, params });
}
