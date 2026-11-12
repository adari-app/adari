// A terminal that ended (normal detach, takeover,
// refusal) or failed to open must stay ended. The view calls resize() from its
// ResizeObserver on every layout change; that must not start another attach,
// and keys typed after the end must never reach a later session. Reopening is
// a deliberate act: a new port (the Reconnect button).

import { describe, expect, it } from "vitest";

import type { HerdrDesktopBridge, TerminalDataEvent, TerminalExitEvent, TerminalOpenRequest } from "../src/shared/ipc-contract";
import { RemoteTerminalPort } from "../src/renderer/terminal/remote-port";

/** The preload bridge's terminal calls, recorded; open replies are released by the test. */
function fakeBridge() {
  const opens: TerminalOpenRequest[] = [];
  const replies: { resolve: (value: { sessionId: string }) => void; reject: (error: Error) => void }[] = [];
  const inputs: [string, string][] = [];
  const resizes: [string, number, number][] = [];
  const closes: string[] = [];
  const dataListeners = new Set<(event: TerminalDataEvent) => void>();
  const exitListeners = new Set<(event: TerminalExitEvent) => void>();
  const bridge = {
    openTerminal: (request: TerminalOpenRequest) => {
      opens.push(request);
      return new Promise<{ sessionId: string }>((resolve, reject) => replies.push({ resolve, reject }));
    },
    terminalInput: (sessionId: string, data: string) => inputs.push([sessionId, data]),
    terminalResize: (sessionId: string, cols: number, rows: number) => resizes.push([sessionId, cols, rows]),
    closeTerminal: (sessionId: string) => closes.push(sessionId),
    onTerminalData: (listener: (event: TerminalDataEvent) => void) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onTerminalExit: (listener: (event: TerminalExitEvent) => void) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  } as unknown as HerdrDesktopBridge;
  return {
    bridge,
    opens,
    inputs,
    resizes,
    closes,
    reply: async (index: number, sessionId: string) => {
      replies[index]?.resolve({ sessionId });
      await Promise.resolve();
      await Promise.resolve();
    },
    refuse: async (index: number, message: string) => {
      replies[index]?.reject(new Error(message));
      await Promise.resolve();
      await Promise.resolve();
    },
    data: (sessionId: string, text: string) => {
      for (const listener of dataListeners) listener({ sessionId, data: new TextEncoder().encode(text) });
    },
    exit: (sessionId: string, reason: string | null) => {
      for (const listener of exitListeners) listener({ sessionId, reason });
    },
  };
}

function port(fake: ReturnType<typeof fakeBridge>) {
  const ended: (string | null)[] = [];
  const errors: string[] = [];
  const received: string[] = [];
  const p = new RemoteTerminalPort(fake.bridge, "mac-mini", "w1:p1", (reason) => ended.push(reason), (message) => errors.push(message));
  p.subscribe((bytes) => received.push(new TextDecoder().decode(bytes)));
  return { port: p, ended, errors, received };
}

describe("RemoteTerminalPort", () => {
  it("opens once at the first size, holds early keys and bytes, then flushes them in order", async () => {
    const fake = fakeBridge();
    const { port: p, received } = port(fake);
    p.input("early");
    p.resize(80, 24);
    p.resize(100, 30);
    expect(fake.opens).toHaveLength(1);
    fake.data("s1", "first frame");
    await fake.reply(0, "s1");
    expect(received).toEqual(["first frame"]);
    expect(fake.inputs).toEqual([["s1", "early"]]);
    expect(fake.resizes).toEqual([["s1", 100, 30]]);
    p.input("later");
    expect(fake.inputs).toEqual([
      ["s1", "early"],
      ["s1", "later"],
    ]);
  });

  for (const [what, reason] of [
    ["a normal detach", null],
    ["a takeover", "Another client took over this terminal."],
    ["a refusal", "Herdr could not attach to this agent. It may have exited or changed identity."],
  ] as const) {
    it(`stays ended after ${what}: input and a resize start no new attach and send no keys`, async () => {
      const fake = fakeBridge();
      const { port: p, ended } = port(fake);
      p.resize(80, 24);
      await fake.reply(0, "s1");
      fake.exit("s1", reason);
      expect(ended).toEqual([reason]);
      p.input("typed after the end\r");
      p.resize(120, 40);
      p.resize(90, 30);
      await Promise.resolve();
      expect(fake.opens).toHaveLength(1);
      expect(fake.inputs).toEqual([]);
      expect(fake.resizes).toEqual([]);
    });
  }

  it("stays ended when the attach ends before its open reply, dropping keys typed meanwhile", async () => {
    const fake = fakeBridge();
    const { port: p, ended } = port(fake);
    p.resize(80, 24);
    p.input("typed while opening");
    fake.data("s1", "bytes");
    fake.exit("s1", "Another client took over this terminal.");
    await fake.reply(0, "s1");
    expect(ended).toEqual(["Another client took over this terminal."]);
    p.input("after");
    p.resize(100, 30);
    expect(fake.opens).toHaveLength(1);
    expect(fake.inputs).toEqual([]);
  });

  it("stays failed when the open fails: input and a resize start no new attach and send no keys", async () => {
    const fake = fakeBridge();
    const { port: p, errors } = port(fake);
    p.resize(80, 24);
    p.input("typed while opening");
    await fake.refuse(0, "Error invoking remote method 'herdr:terminal-open': Error: could not connect");
    expect(errors).toEqual(["could not connect"]);
    p.input("after the failure");
    p.resize(100, 30);
    expect(fake.opens).toHaveLength(1);
    expect(fake.inputs).toEqual([]);
  });

  it("reopens only as a new port, and the ended port's keys never reach it", async () => {
    const fake = fakeBridge();
    const first = port(fake);
    first.port.resize(80, 24);
    await fake.reply(0, "s1");
    fake.exit("s1", null);
    first.port.input("stale keys");
    first.port.dispose();

    const second = port(fake);
    second.port.resize(80, 24);
    expect(fake.opens).toHaveLength(2);
    await fake.reply(1, "s2");
    second.port.input("fresh keys");
    expect(fake.inputs).toEqual([["s2", "fresh keys"]]);
  });

  it("closes a session whose reply arrives after dispose", async () => {
    const fake = fakeBridge();
    const { port: p } = port(fake);
    p.resize(80, 24);
    p.dispose();
    await fake.reply(0, "s1");
    expect(fake.closes).toEqual(["s1"]);
    p.resize(100, 30);
    expect(fake.opens).toHaveLength(1);
  });
});
