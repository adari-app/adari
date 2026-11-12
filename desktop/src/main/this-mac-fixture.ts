// A fake Herdr for This Mac's capture run and its tests, never
// the real one. Two parts, both in a folder the caller makes:
//
// - a fake `herdr` (fakeHerdrScript) on a temporary PATH: it logs its argv to
//   $HOME/herdr-argv.log and, for an attach, draws Herdr's first frame prefix
//   and echoes each typed line ("size" prints the window size, "quit" ends
//   it); the login shell finds it as it finds the real one;
// - Herdr's API socket served in this process (serveFakeHerdr): one request
//   line per connection answered with one reply line (Herdr's single-shot
//   command socket), and `events.subscribe` held open, answered with
//   subscription_started and then each pushed event line, until the client
//   closes it.
//
// openThisMacFixture puts both where Herdr puts them (HOME, XDG_CONFIG_HOME)
// for the capture run's This Mac ("found": herdr and the socket; "missing":
// neither), and the local session's options that point at them: /bin/sh -c
// with the fixture's PATH, never the user's login shell, home or socket.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import type { LocalSessionOptions } from "./herdr/local";

export interface HerdrRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** The reply line (JSON, no newline) to one request; a throw answers with a Herdr error. */
export type HerdrAnswer = (request: HerdrRequest, line: string) => string | Promise<string>;

export interface FakeHerdrServer {
  readonly socketPath: string;
  /** Every request, in the order they came. */
  readonly requests: HerdrRequest[];
  /** Subscriptions held open now. */
  subscribers(): number;
  /** One event line (`{"event": …, "data": …}`) to every held subscription; how many got it. */
  push(event: string, data: Readonly<Record<string, unknown>>): number;
  /** Ends every connection and removes the socket. */
  close(): Promise<void>;
}

/** The longest unix socket path macOS takes (sun_path holds 104 bytes with its NUL). */
export const maxSocketPathBytes = 103;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRequest(line: string): HerdrRequest | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    const params = object["params"];
    return {
      id: typeof object["id"] === "string" ? object["id"] : "",
      method: typeof object["method"] === "string" ? object["method"] : "",
      params: typeof params === "object" && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {},
    };
  } catch {
    return null;
  }
}

/** Serves a fake Herdr API socket at `socketPath` until close(). */
export function serveFakeHerdr(socketPath: string, answer: HerdrAnswer): Promise<FakeHerdrServer> {
  if (Buffer.byteLength(socketPath, "utf8") > maxSocketPathBytes) {
    return Promise.reject(new Error(`the fake socket's path is over ${maxSocketPathBytes} bytes: ${socketPath}`));
  }
  const requests: HerdrRequest[] = [];
  const held = new Set<net.Socket>();
  const open = new Set<net.Socket>();

  const respond = async (socket: net.Socket, line: string): Promise<void> => {
    const request = parseRequest(line);
    if (request === null) {
      socket.end(`${JSON.stringify({ id: "", error: { code: "invalid_request", message: "the request is not a JSON object" } })}\n`);
      return;
    }
    requests.push(request);
    if (request.method === "events.subscribe") {
      held.add(socket);
      socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
      return;
    }
    let reply: string;
    try {
      reply = await answer(request, line);
    } catch (error) {
      reply = JSON.stringify({ id: request.id, error: { code: "fixture_failed", message: describe(error) } });
    }
    if (!socket.destroyed) socket.end(`${reply}\n`);
  };

  // allowHalfOpen: nc may shut its sending side once the request is written; the reply still goes back.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    open.add(socket);
    let buffered = Buffer.alloc(0);
    let read = false;
    socket.on("error", () => undefined);
    socket.on("close", () => {
      open.delete(socket);
      held.delete(socket);
    });
    // A held subscription ends when its client's sending side does (nc's stdin closed).
    socket.on("end", () => {
      if (held.delete(socket)) socket.end();
    });
    socket.on("data", (chunk: Buffer) => {
      if (read) return;
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      read = true;
      void respond(socket, buffered.subarray(0, newline).toString("utf8"));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve({
        socketPath,
        requests,
        subscribers: () => held.size,
        push(event, data) {
          const line = `${JSON.stringify({ event, data })}\n`;
          for (const socket of held) socket.write(line);
          return held.size;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of open) socket.destroy();
            open.clear();
            held.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * The fake `herdr`: logs its argv; an attach (`--session <s> agent|terminal
 * attach <id>`) turns its echo off, draws Herdr's first frame prefix
 * (terminal.ts officialFramePrefix), then answers each line it reads.
 */
export const fakeHerdrScript = [
  "#!/bin/sh",
  "# A fake herdr (This Mac's capture fixture), never Herdr.",
  'printf \'%s\\n\' "$*" >> "$HOME/herdr-argv.log"',
  'case " $* " in',
  '  *" attach "*)',
  "    stty -echo 2>/dev/null",
  String.raw`    printf '\033[?2026h\033[?25l\033]8;;\033\\'`,
  String.raw`    printf 'fake herdr: attached\r\n'`,
  "    while IFS= read -r line; do",
  '      case "$line" in',
  String.raw`        size) printf 'size %s\r\n' "$(stty size)" ;;`,
  "        quit) exit 0 ;;",
  String.raw`        *) printf 'echo:%s\r\n' "$line" ;;`,
  "      esac",
  "    done",
  "    ;;",
  String.raw`  *) printf 'fake herdr %s\n' "$*" ;;`,
  "esac",
  "",
].join("\n");

/** Writes the fake `herdr` into `folder` (executable); its path. */
export function writeFakeHerdr(folder: string): string {
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "herdr");
  writeFileSync(file, fakeHerdrScript, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

/** The capture's invented session: one workspace, a working Claude Code pane and a shell, in the fixture's home. */
export function fixtureSnapshot(home: string, nowMs: number): Record<string, unknown> {
  const folder = path.join(home, "Code", "herdr-companion");
  const pane = (id: string, terminal: string, focused: boolean, agent: string | null) => ({
    pane_id: id,
    terminal_id: terminal,
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused,
    cwd: folder,
    ...(agent === null ? {} : { agent }),
    agent_status: agent === null ? "unknown" : "working",
    revision: 1,
  });
  return {
    version: "0.9.5",
    protocol: 22,
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    focused_pane_id: "w1:p1",
    workspaces: [
      { workspace_id: "w1", number: 1, label: "herdr-companion", focused: true, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" },
    ],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "desktop", focused: true, pane_count: 2, agent_status: "working" }],
    panes: [pane("w1:p1", "term-1", true, "claude"), pane("w1:p2", "term-2", false, null)],
    layouts: [],
    agents: [{ pane_id: "w1:p1", name: "this-mac", agent: "claude", agent_status: "working", status_since_unix_ms: nowMs - 4 * 60_000 }],
  };
}

export interface ThisMacFixture {
  /** The local session's options: /bin/sh -c, the fixture's PATH, HOME and XDG_CONFIG_HOME. */
  readonly options: LocalSessionOptions;
  /** The served socket ("found"), or null ("missing"). */
  readonly server: FakeHerdrServer | null;
  close(): Promise<void>;
}

/**
 * The capture run's This Mac in `root` (a new, short folder: the socket path
 * must fit): "found" puts the fake herdr on its PATH and serves the socket at
 * XDG_CONFIG_HOME/herdr/herdr.sock with the invented session; "missing" has
 * neither.
 */
export async function openThisMacFixture(root: string, state: "found" | "missing", now: () => number = Date.now): Promise<ThisMacFixture> {
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const config = path.join(root, "c");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(home, "Code", "herdr-companion"), { recursive: true });
  mkdirSync(path.join(config, "herdr"), { recursive: true });
  let server: FakeHerdrServer | null = null;
  if (state === "found") {
    writeFakeHerdr(bin);
    server = await serveFakeHerdr(path.join(config, "herdr", "herdr.sock"), (request) => {
      switch (request.method) {
        case "session.snapshot":
          return JSON.stringify({ id: request.id, result: { type: "session_snapshot", snapshot: fixtureSnapshot(home, now()) } });
        case "pane.read":
          return JSON.stringify({ id: request.id, result: { type: "pane_read", read: { text: "" } } });
        default:
          return JSON.stringify({ id: request.id, error: { code: "not_in_fixture", message: `${request.method} is not in the capture fixture` } });
      }
    });
  }
  const running = server;
  return {
    options: {
      shell: "/bin/sh",
      login: false,
      home,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: config, LANG: "en_US.UTF-8" },
    },
    server: running,
    close: async () => {
      await running?.close();
    },
  };
}
