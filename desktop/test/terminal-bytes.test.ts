// A legacy X10 mouse report is bytes, one per
// coordinate (32 + column), so a column over 95 is a byte over 127. It must
// reach the program's PTY as those bytes, not UTF-8 encoded on the way
// (194,152 for 152). The report goes as raw bytes from the terminal input
// through the port, the preload's IPC and main's terminal sessions to the PTY
// handle; main takes raw bytes only as a Uint8Array of 1 to 64 bytes. Text,
// and the UTF-8 mouse mode (1005), keep their UTF-8 encoding.

import { describe, expect, it, vi } from "vitest";

import type { HerdrHostBackend, TerminalHandle } from "../src/main/herdr/backend";
import type { HostRegistry } from "../src/main/hosts";
import { IPC, type HerdrDesktopBridge, type TerminalOpenRequest } from "../src/shared/ipc-contract";
import { RemoteTerminalPort } from "../src/renderer/terminal/remote-port";
import { TerminalInput, type TerminalSurface } from "../src/renderer/terminal/terminal-input";

const registered = vi.hoisted(() => ({ on: new Map<string, (...args: unknown[]) => void>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: () => undefined,
    on: (channel: string, listener: (...args: unknown[]) => void) => registered.on.set(channel, listener),
  },
}));

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { TerminalSessions } = await import("../src/main/terminals");

const owner = { isDestroyed: () => false, send: () => undefined };
const event = { senderFrame: { url: APP_ORIGIN }, sender: owner };

/** Main's sessions behind the real IPC handler, a PTY handle that records its bytes, and the renderer's port over them. */
async function wired() {
  const written: number[][] = [];
  const handle: TerminalHandle = { input: (data) => written.push([...data]), resize: () => undefined, close: () => undefined };
  const backend = { openTerminal: async () => handle } as unknown as HerdrHostBackend;
  const hosts = { backend: () => backend, pane: () => ({ paneID: "w1:p1" }) } as unknown as HostRegistry;
  const sessions = new TerminalSessions(hosts);
  registered.on.clear();
  registerIpc({ terminals: sessions } as unknown as Parameters<typeof registerIpc>[0]);
  const send = (...args: unknown[]): void => registered.on.get(IPC.terminalInput)!(event, ...args);
  const bridge = {
    openTerminal: (request: TerminalOpenRequest) => sessions.open(owner as never, request),
    // As the preload: the value goes through the IPC as it is (structured clone keeps a Uint8Array).
    terminalInput: (sessionId: string, data: unknown) => send(sessionId, data),
    terminalResize: () => undefined,
    closeTerminal: () => undefined,
    onTerminalData: () => () => undefined,
    onTerminalExit: () => () => undefined,
  } as unknown as HerdrDesktopBridge;
  const port = new RemoteTerminalPort(bridge, "mac-mini", "w1:p1", () => undefined, () => undefined);
  port.resize(160, 40);
  for (let n = 0; n < 10; n += 1) await Promise.resolve();
  return { port, written, send };
}

function input(port: RemoteTerminalPort, modes: readonly number[], col: number) {
  const surface: TerminalSurface = {
    getMode: (mode) => modes.includes(mode),
    alternateScreen: () => false,
    mouseTracking: () => true,
    bracketedPaste: () => false,
    hasSelection: () => false,
    getSelection: () => "",
    scrollLines: () => undefined,
    cellHeight: () => 17,
    cellAt: () => ({ col, row: 5 }),
  };
  return new TerminalInput(surface, {
    send: (data) => port.input(data),
    copy: () => undefined,
    note: () => undefined,
    upload: async () => ({ path: "/fixture", byteCount: 1 }),
    clipboardFiles: async () => ({ files: [], refused: [], excess: [], failures: [] }),
    prepareImage: async () => ({ data: new Uint8Array([1]), extension: "png" }),
    now: () => 0,
  });
}

const wheelUp = { deltaY: -17, deltaMode: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

describe("a mouse report's bytes at the program's PTY", () => {
  it("sends an X10 report at a column over 95 as one byte a coordinate", async () => {
    const w = await wired();
    input(w.port, [1000], 120).wheel(wheelUp);
    expect(w.written).toEqual([[27, 91, 77, 32 + 64, 32 + 120, 32 + 5]]);
  });

  it("sends an X10 report up to column 223, the last a byte can say, and nothing past it", async () => {
    const w = await wired();
    input(w.port, [1000], 223).wheel(wheelUp);
    input(w.port, [1000], 224).wheel(wheelUp);
    expect(w.written).toEqual([[27, 91, 77, 96, 255, 37]]);
  });

  it("keeps the UTF-8 mouse mode (1005) and SGR as text, UTF-8 encoded", async () => {
    const w = await wired();
    input(w.port, [1000, 1005], 120).wheel(wheelUp);
    input(w.port, [1000, 1006], 120).wheel(wheelUp);
    expect(w.written).toEqual([[27, 91, 77, 96, 194, 152, 37], [...new TextEncoder().encode("\x1b[<64;120;5M")]]);
  });

  it("keeps typed text UTF-8 encoded", async () => {
    const w = await wired();
    w.port.input("é\r");
    expect(w.written).toEqual([[0xc3, 0xa9, 13]]);
  });

  it("takes raw bytes in main only as a Uint8Array of 1 to 64 bytes", async () => {
    const w = await wired();
    const sessionId = (w.port as unknown as { sessionId: string }).sessionId;
    for (const bad of [new Uint8Array(0), new Uint8Array(65), [27, 91, 77], new Uint8Array(6).buffer, { 0: 27, length: 1 }, 42, null]) w.send(sessionId, bad);
    expect(w.written).toEqual([]);
    w.send(sessionId, new Uint8Array(64).fill(65));
    w.send(sessionId, new Uint8Array([27, 91, 77, 96, 152, 37]));
    expect(w.written.map((bytes) => bytes.length)).toEqual([64, 6]);
    expect(w.written[1]).toEqual([27, 91, 77, 96, 152, 37]);
  });
});
