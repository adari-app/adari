// A fake This Mac for the local-session tests, all under the test scratch
// folder (HERDR_TEST_SCRATCH, else the temporary folder):
//
// - a home folder of its own (HOME), so `~/.config/herdr/herdr.sock`, the
//   attachments folders, agents.json and `~/.claude/projects` are the fake's;
// - a fake `herdr` on a temporary PATH (bin/ first, then /usr/bin:/bin only),
//   which logs its argv and, for an attach, draws Herdr's first frame and
//   echoes what is typed (src/main/this-mac-fixture.ts fakeHerdrScript);
// - the API socket served in this process (serveFakeHerdr), answering as
//   Herdr 0.9.5 through LiveHerdr (session.snapshot, …) and agent.prompt.
//
// Its options read no login shell (login: false): commands run under
// /bin/sh -c with the fake's PATH and HOME as given, so no profile puts a
// real herdr ahead of the fake; never this Mac's own shell, home, Herdr
// socket or git config. (A test that reads a login shell's environment gives
// its own HOME/ZDOTDIR startup files or a stand-in shell.)

import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LocalSessionOptions } from "../../src/main/herdr/local";
import { serveFakeHerdr, writeFakeHerdr, type FakeHerdrServer, type HerdrAnswer } from "../../src/main/this-mac-fixture";
import { LiveHerdr } from "./live-herdr";

export const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());

export interface FakeMac {
  readonly root: string;
  readonly bin: string;
  readonly home: string;
  readonly live: LiveHerdr;
  /** The prompts agent.prompt received, in order. */
  readonly prompts: { target: string; text: string }[];
  /** The served API socket, once serve() ran. */
  server: FakeHerdrServer | null;
  /** The local session's options: /bin/sh -c, the fake's PATH and HOME, and `env` on top. */
  options(env?: Readonly<Record<string, string>>): LocalSessionOptions;
  /**
   * Serves `~/.config/herdr/herdr.sock` in this process (or `socketPath`,
   * and `answer` in place of the fake's own answers).
   */
  serve(settings?: { socketPath?: string; answer?: HerdrAnswer }): Promise<FakeHerdrServer>;
  /** What the fake herdr was run with, one line per run. */
  argv(): string[];
  close(): Promise<void>;
}

const open: FakeMac[] = [];

/** Herdr's answer to `workspace.create`: workspace wE with its first tab and that tab's shell pane at the folder. */
export function workspaceCreated(id: string, params: Readonly<Record<string, unknown>>): string {
  const label = String(params["label"]);
  return JSON.stringify({
    id,
    result: {
      type: "workspace_created",
      workspace: { workspace_id: "wE", number: 3, label, focused: false, pane_count: 1, tab_count: 1, active_tab_id: "wE:t1", agent_status: "unknown" },
      tab: { tab_id: "wE:t1", workspace_id: "wE", number: 1, label: "", focused: false, pane_count: 1, agent_status: "unknown" },
      root_pane: { pane_id: "wE:p1", terminal_id: "tE", workspace_id: "wE", tab_id: "wE:t1", focused: false, cwd: params["cwd"], agent_status: "unknown", revision: 1 },
    },
  });
}

/** A fake Mac: its herdr on PATH when `herdr` (default true). Tab w1:t1 holds w1:p1 (Claude) and w1:p2 (a shell). */
export function makeFakeMac(settings: { herdr?: boolean } = {}): FakeMac {
  const root = mkdtempSync(path.join(scratch, "tm-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (settings.herdr !== false) writeFakeHerdr(bin);
  const live = new LiveHerdr();
  live.addTab("w1:t1", ["w1:p1", "w1:p2"], { "w1:p1": "claude" });
  const prompts: { target: string; text: string }[] = [];
  const fake: FakeMac = {
    root,
    bin,
    home,
    live,
    prompts,
    server: null,
    options: (env = {}) => ({
      shell: "/bin/sh",
      login: false,
      home,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LANG: "en_US.UTF-8", ...env },
    }),
    async serve(settings = {}) {
      const socketPath = settings.socketPath ?? path.join(home, ".config", "herdr", "herdr.sock");
      mkdirSync(path.dirname(socketPath), { recursive: true });
      fake.server = await serveFakeHerdr(
        socketPath,
        settings.answer ??
          ((request, line) => {
            if (request.method === "agent.prompt") {
              prompts.push({ target: String(request.params["target"]), text: String(request.params["text"]) });
              return JSON.stringify({ id: request.id, result: { type: "ok" } });
            }
            // New workspace's `workspace.create`, as Herdr answers it (Wire.swift WorkspaceCreation).
            if (request.method === "workspace.create") return workspaceCreated(request.id, request.params);
            return live.roundTrip(line);
          }),
      );
      return fake.server;
    },
    argv() {
      try {
        return readFileSync(path.join(home, "herdr-argv.log"), "utf8").split("\n").filter((line) => line !== "");
      } catch {
        return [];
      }
    },
    async close() {
      await fake.server?.close();
      fake.server = null;
    },
  };
  open.push(fake);
  return fake;
}

/** Closes every fake's socket (afterEach). */
export async function closeFakeMacs(): Promise<void> {
  for (const fake of open.splice(0)) await fake.close();
}

/** Resolves once `check` is true, polling every 20 ms; rejects after `timeoutMs` with `what`. */
export async function eventually(check: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
