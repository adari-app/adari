// The attach line is TYPED into the PTY's login shell
// (as CitadelTransport does), so the terminal's line discipline sees it before
// the shell's quoting does. A server-supplied terminal or pane id carrying
// U+0015 (VKILL) could erase the command prefix and the opening quote, and the
// rest would run as a command. The session must refuse such an id before it
// connects and type nothing; ordinary ids, including quotes, spaces and shell
// metacharacters, must still be typed exactly as Swift builds them.

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { attachCommand, shellQuote, type AttachTarget } from "../src/main/herdr/commands";
import { TransportError } from "../src/main/herdr/errors";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { SshTerminalSession, type SshHostConfig } from "../src/main/herdr/ssh";

const config: SshHostConfig = { host: "mac-mini.local", port: 22, username: "robin", privateKeyPath: "/keys/none", herdrSession: "default" };
const policy = new PinningHostKeyPolicy(new MemoryPinStore());

/** An ssh2 Client stand-in: records connects, the PTY request and every byte typed. */
function fakeSsh() {
  const typed: string[] = [];
  let connects = 0;
  let ptyRequests = 0;
  const channel = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    write: (data: string | Buffer) => {
      typed.push(Buffer.isBuffer(data) ? data.toString("latin1") : data);
      return true;
    },
    setWindow: () => undefined,
  });
  const client = Object.assign(new EventEmitter(), {
    shell: (_options: unknown, callback: (error: Error | undefined, channel: unknown) => void) => {
      ptyRequests += 1;
      callback(undefined, channel);
    },
    end: () => undefined,
  });
  const connect = () => {
    connects += 1;
    return Promise.resolve(client as never);
  };
  return {
    connect,
    typed,
    get connects() {
      return connects;
    },
    get ptyRequests() {
      return ptyRequests;
    },
  };
}

function session(target: AttachTarget, ssh: ReturnType<typeof fakeSsh>, host: SshHostConfig = config): SshTerminalSession {
  return new SshTerminalSession(host, policy, target, { cols: 80, rows: 24 }, { data: () => undefined, exit: () => undefined }, ssh.connect);
}

const terminal = (terminalID: string): AttachTarget => ({ kind: "terminal", terminalID });
const agent = (paneID: string): AttachTarget => ({ kind: "agent", paneID });

describe("the typed attach line", () => {
  const ordinary = [
    "term_65efccd8ecce21",
    "term plain",
    "w2:p70",
    "air-box/w1:p9",
    "it's",
    "a;b && c || d | e & f",
    "$(touch /tmp/x) `id` ${HOME} $HOME",
    "<in >out 2>&1 * ? ~ # ! { } [ ] \\ \" '",
  ];

  for (const id of ordinary) {
    it(`types an ordinary id exactly as Swift builds it: ${JSON.stringify(id)}`, async () => {
      const ssh = fakeSsh();
      await session(terminal(id), ssh).start();
      expect(ssh.typed).toEqual([attachCommand(terminal(id), "default") + "\n"]);
    });
  }

  it("keeps quotes, spaces and metacharacters one shell word (checked with /bin/sh)", () => {
    for (const id of ordinary) {
      expect(execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(id)}`]).toString("utf8")).toBe(id);
    }
  });

  const unsafe: readonly [string, string][] = [
    ["VKILL before a command", "x\u0015printf PTY_CONTROL_PROBE #"],
    ["NUL", "term\u0000x"],
    ["VINTR", "term\u0003"],
    ["VEOF", "term\u0004"],
    ["backspace", "term\u0008"],
    ["tab", "term\u0009x"],
    ["line feed", "term\nprintf X"],
    ["carriage return", "term\rprintf X"],
    ["VLNEXT", "term\u0016\u0015"],
    ["VWERASE", "term\u0017"],
    ["escape", "term\u001b[2J"],
    ["DEL (VERASE)", "term\u007f"],
    ["C1 NEL", "term\u0085"],
    ["C1 CSI", "term\u009b2J"],
    ["non-ASCII (its bytes lose the high bit under ISTRIP)", "termՕ"],
    ["line separator", "term x"],
  ];

  for (const [what, id] of unsafe) {
    it(`refuses a terminal id with ${what}, before connecting, typing nothing`, async () => {
      const ssh = fakeSsh();
      const attempt = session(terminal(id), ssh).start();
      await expect(attempt).rejects.toThrow(/cannot be typed safely/);
      await expect(attempt).rejects.toBeInstanceOf(TransportError);
      expect(ssh.connects).toBe(0);
      expect(ssh.ptyRequests).toBe(0);
      expect(ssh.typed).toEqual([]);
    });
  }

  it("refuses the agent pane id fallback with a control too", async () => {
    const ssh = fakeSsh();
    await expect(session(agent("w1:p1\u0015printf X #"), ssh).start()).rejects.toThrow(/cannot be typed safely/);
    expect(ssh.typed).toEqual([]);
  });

  it("refuses a session name with a control (the whole typed line is checked)", async () => {
    const ssh = fakeSsh();
    await expect(session(terminal("term_1"), ssh, { ...config, herdrSession: "def\u0015ault" }).start()).rejects.toThrow(/cannot be typed safely/);
    expect(ssh.typed).toEqual([]);
  });

  it("bounds the id at 256 bytes and the typed line under the terminal's 1024-byte input line", async () => {
    const fits = fakeSsh();
    await session(terminal("a".repeat(256)), fits).start();
    expect(fits.typed).toHaveLength(1);

    const long = fakeSsh();
    await expect(session(terminal("a".repeat(257)), long).start()).rejects.toThrow(/cannot be typed safely/);
    expect(long.connects).toBe(0);

    // 150 quotes are within 256 bytes but expand to 750 typed bytes.
    const quoted = fakeSsh();
    await expect(session(terminal("'".repeat(150)), quoted).start()).rejects.toThrow(/cannot be typed safely/);
    expect(quoted.typed).toEqual([]);
  });
});
