// The mouse in a terminal tile: TerminalView, with ghostty-web's real
// SelectionManager over Ghostty's VT core (the rest of ghostty-web's Terminal
// faked, its own press and link click as 0.4.0 has them), on a few DOM nodes
// that pass events as Chromium does (support/fake-dom.ts):
// - a press and its release go to a program that asked for the mouse, through
//   the pane's port, and no selection is made or copied;
// - a program's OSC 52 copy as its drag ends counts the release of a press it
//   took as your own action (2 s after the press, right after the release);
//   a write with no action is still refused; the release of the app's own
//   selection changes nothing;
// - ⌘-click on a web address or a program's own link opens it, nothing sent;
// - the left click that only gives this terminal the keyboard goes nowhere;
// - two tiles side by side each keep their own;
// - a fresh click in another tile retires a stale held press (one release, no
//   clipboard window), and Close Window (the real StayOpen hiding the window)
//   or a blur finishes a held press with the terminal still working after.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeNode, mouse, type MouseInit } from "./support/fake-dom";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, useLayoutEffect: fakeReact.useEffect };
});

const shared = vi.hoisted(() => ({
  ghostty: null as unknown as import("ghostty-web").Ghostty,
  made: [] as unknown[],
}));

const cellWidth = 8;
const cellHeight = 16;
const cols = 40;
const rows = 6;

vi.mock("../src/renderer/terminal/terminal-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/terminal/terminal-core")>()),
  newTerminalCore: async () => shared.ghostty,
}));

interface LinkLike {
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate(event: unknown): void;
}

vi.mock("ghostty-web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ghostty-web")>();
  return {
    ...actual,
    FitAddon: class {
      proposeDimensions() {
        return { cols, rows };
      }
    },
    Terminal: class {
      cols = cols;
      rows = rows;
      options: unknown;
      focused = 0;
      wasmTerm?: import("ghostty-web").GhosttyTerminal;
      renderer?: { getCanvas(): FakeNode; getMetrics(): { width: number; height: number }; charHeight: number; charWidth: number };
      selectionManager?: import("ghostty-web").SelectionManager;
      linkDetector = { providers: [] as { provideLinks(y: number, done: (links: LinkLike[] | undefined) => void): void }[], invalidateCache() {} };
      buffer = {
        active: {
          type: "normal",
          getLine: (y: number) => {
            const cells = this.wasmTerm?.getLine(y);
            if (cells === undefined || cells === null) return undefined;
            return {
              length: cells.length,
              isWrapped: this.wasmTerm!.isRowWrapped(y),
              getCell: (x: number) => {
                const cell = cells[x];
                return cell === undefined ? undefined : { getCodepoint: () => cell.codepoint, getWidth: () => cell.width, getHyperlinkId: () => cell.hyperlink_id };
              },
            };
          },
        },
      };
      constructor(options: unknown) {
        this.options = options;
        shared.made.push(this);
      }
      loadAddon() {}
      open(host: FakeNode) {
        const canvas = host.append(new FakeNode("canvas"));
        canvas.rect = { left: 0, top: 0, width: cols * cellWidth, height: rows * cellHeight };
        this.wasmTerm = shared.ghostty.createTerminal(this.cols, this.rows);
        this.renderer = { getCanvas: () => canvas, getMetrics: () => ({ width: cellWidth, height: cellHeight }), charHeight: cellHeight, charWidth: cellWidth };
        // ghostty-web 0.4.0's own: the canvas's press keeps the keyboard, the host's click opens the link under it.
        canvas.addEventListener("mousedown", (event) => {
          event.preventDefault();
          this.focused += 1;
        });
        host.addEventListener("click", (event) => {
          const e = event as unknown as { clientX: number; clientY: number };
          const x = Math.floor(e.clientX / cellWidth);
          const y = Math.floor(e.clientY / cellHeight);
          for (const provider of this.linkDetector.providers) {
            provider.provideLinks(y, (links) => {
              const link = links?.find(({ range: { start, end } }) => (y > start.y || x >= start.x) && (y < end.y || x <= end.x));
              link?.activate(event);
            });
          }
        });
        const textarea = { style: {}, value: "", focus() {}, select() {}, setSelectionRange() {}, addEventListener() {}, removeEventListener() {} };
        this.selectionManager = new actual.SelectionManager(this as never, this.renderer as never, this.wasmTerm, textarea as never);
      }
      getMode(mode: number) {
        return this.wasmTerm!.getMode(mode, false);
      }
      getViewportY() {
        return 0;
      }
      scrollLines() {}
      onData() {}
      attachCustomWheelEventHandler() {}
      attachCustomKeyEventHandler() {}
      resize() {}
      focus() {
        this.focused += 1;
      }
      hasSelection() {
        return this.selectionManager?.hasSelection() ?? false;
      }
      getSelection() {
        return this.selectionManager?.getSelection() ?? "";
      }
      write(bytes: Uint8Array) {
        this.wasmTerm!.write(bytes);
        this.wasmTerm!.update();
      }
      dispose() {
        this.selectionManager?.dispose();
      }
    },
  };
});

import { HookHost } from "./support/fake-hooks";

const { Ghostty } = await import("ghostty-web");
const { TerminalView } = await import("../src/renderer/terminal/TerminalView");

type Props = Parameters<typeof TerminalView>[0];

interface MadeTerminal {
  renderer: { getCanvas(): FakeNode };
  selectionManager: import("ghostty-web").SelectionManager;
  focused: number;
}

beforeAll(async () => {
  const wasm = readFileSync(path.join(process.cwd(), "node_modules/ghostty-web/ghostty-vt.wasm"));
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
  shared.ghostty = new Ghostty(instance);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

let root: FakeNode & { activeElement: unknown; windowFocused: boolean };
let clipboard: string[];
let opened: string[];

function fakePort() {
  const subscribers = new Set<(bytes: Uint8Array) => void>();
  const inputs: (string | number[])[] = [];
  return {
    inputs,
    port: {
      subscribe(onData: (bytes: Uint8Array) => void) {
        subscribers.add(onData);
        return () => subscribers.delete(onData);
      },
      resize() {},
      input(data: string | Uint8Array) {
        inputs.push(typeof data === "string" ? data : [...data]);
      },
    },
    send(text: string) {
      for (const write of subscribers) write(new TextEncoder().encode(text));
    },
  };
}

/** A terminal tile up in its frame, the program's bytes on its screen, the keyboard in it. */
async function tile(program: string) {
  const { port, send, inputs } = fakePort();
  const frame = root.append(new FakeNode("term-frame"));
  const hostElement = frame.append(new FakeNode("term-host"));
  const view = new HookHost(TerminalView as (props: Props) => unknown, { port, autoFocus: true });
  const slots = (view as unknown as { slots: unknown[] }).slots;
  slots[1] = { current: frame };
  slots[2] = { current: hostElement };
  view.render();
  await settle();
  const terminal = shared.made.at(-1) as MadeTerminal;
  const canvas = terminal.renderer.getCanvas();
  root.activeElement = canvas;
  if (program !== "") send(program);
  const xy = (col: number, row: number) => ({ clientX: (col - 1) * cellWidth + 4, clientY: (row - 1) * cellHeight + 8 });
  const press = (col: number, row: number, init: Partial<MouseInit> = {}): void => {
    canvas.dispatchEvent(mouse("mousedown", { ...xy(col, row), buttons: 1, ...init }, canvas));
  };
  const release = (col: number, row: number, init: Partial<MouseInit> = {}): void => {
    canvas.dispatchEvent(mouse("mouseup", { ...xy(col, row), buttons: 0, ...init }, canvas));
    canvas.dispatchEvent(mouse("click", { ...xy(col, row), buttons: 0, ...init }, canvas));
  };
  return { view, terminal, canvas, hostElement, frame, send, inputs, press, release };
}

beforeEach(() => {
  shared.made.length = 0;
  clipboard = [];
  opened = [];
  vi.useFakeTimers();
  const document = Object.assign(new FakeNode("document"), {
    fonts: { load: async () => undefined },
    visibilityState: "visible",
    activeElement: null as unknown,
    windowFocused: true,
    hasFocus: () => root.windowFocused,
  });
  root = document;
  vi.stubGlobal("document", document);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
  vi.stubGlobal("window", { herdrDesktop: { copyText: (text: string) => clipboard.push(text), openLink: (url: string) => opened.push(url) } });
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    clipboard: {
      writeText: () => {
        throw new Error("ghostty-web's own copy ran");
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const osc52 = (text: string): string => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
const tracking = "\x1b[?1000;1002;1006h";

describe("a press in a terminal tile whose program asked for the mouse", () => {
  it("goes to the program through the pane, its release too, and makes no selection", async () => {
    const t = await tile(`${tracking}hello world`);
    t.press(1, 1);
    t.canvas.dispatchEvent(mouse("mousemove", { clientX: 4 * cellWidth + 4, clientY: 8, buttons: 1 }, t.canvas));
    t.release(5, 1);
    expect(t.inputs).toEqual(["\x1b[<0;1;1M", "\x1b[<32;5;1M", "\x1b[<0;5;1m"]);
    expect(t.terminal.selectionManager.hasSelection()).toBe(false);
    expect(clipboard).toEqual([]);
    // It keeps the keyboard, as ghostty-web's own press would have given it.
    expect(t.terminal.focused).toBeGreaterThan(0);
    t.view.unmount();
  });

  it("with Shift held, is today's selection, copied as it ends, nothing sent", async () => {
    const t = await tile(`${tracking}hello world`);
    t.press(1, 1, { shiftKey: true });
    t.canvas.dispatchEvent(mouse("mousemove", { clientX: 4 * cellWidth + 4, clientY: 8, buttons: 1, shiftKey: true }, t.canvas));
    t.release(5, 1, { shiftKey: true });
    expect(t.inputs).toEqual([]);
    expect(clipboard).toEqual(["hello"]);
    t.view.unmount();
  });
});

describe("a program's OSC 52 copy as its drag ends", () => {
  it("is honoured 2 s after the press when it comes right after the release of a press the program took", async () => {
    const t = await tile(tracking);
    t.press(1, 1);
    vi.advanceTimersByTime(2_500);
    t.release(5, 1);
    vi.advanceTimersByTime(100);
    t.send(osc52("the program's selection"));
    expect(clipboard).toEqual(["the program's selection"]);
    t.view.unmount();
  });

  it("with no action of the user's in the tile is still refused", async () => {
    const t = await tile(tracking);
    t.send(osc52("on its own"));
    expect(clipboard).toEqual([]);
    t.view.unmount();
  });

  it("is refused after the release of a press that was the app's own selection (only the press counted)", async () => {
    const t = await tile(tracking);
    t.press(1, 1, { shiftKey: true });
    vi.advanceTimersByTime(2_500);
    t.release(1, 1, { shiftKey: true });
    t.send(osc52("too late"));
    expect(clipboard).toEqual([]);
    t.view.unmount();
  });

  it("is refused 2 s after a release, as after any action", async () => {
    const t = await tile(tracking);
    t.press(1, 1);
    t.release(1, 1);
    vi.advanceTimersByTime(2_001);
    t.send(osc52("too late"));
    expect(clipboard).toEqual([]);
    t.view.unmount();
  });
});

describe("what stays the app's", () => {
  it("⌘-click on a web address opens it and sends nothing; elsewhere ⌘-click goes to the program", async () => {
    const t = await tile(`${tracking}see https://example.com/a now`);
    t.press(10, 1, { metaKey: true });
    t.release(10, 1, { metaKey: true });
    expect(opened).toEqual(["https://example.com/a"]);
    expect(t.inputs).toEqual([]);
    t.press(2, 1, { metaKey: true });
    t.release(2, 1, { metaKey: true });
    expect(t.inputs).toEqual(["\x1b[<0;2;1M", "\x1b[<0;2;1m"]);
    expect(opened).toEqual(["https://example.com/a"]);
    t.view.unmount();
  });

  it("⌘-click on a program's own link (OSC 8) sends nothing either", async () => {
    const t = await tile(`${tracking}\x1b]8;;https://example.com/osc\x1b\\docs\x1b]8;;\x1b\\ here`);
    t.press(2, 1, { metaKey: true });
    t.release(2, 1, { metaKey: true });
    expect(t.inputs).toEqual([]);
    t.press(7, 1, { metaKey: true });
    expect(t.inputs).toEqual(["\x1b[<0;7;1M"]);
    t.view.unmount();
  });

  it("the left click that only gives this terminal the keyboard goes nowhere, nor makes a selection", async () => {
    const t = await tile(`${tracking}hello world`);
    root.activeElement = root.append(new FakeNode("message box"));
    t.press(1, 1);
    t.canvas.dispatchEvent(mouse("mousemove", { clientX: 4 * cellWidth + 4, clientY: 8, buttons: 1 }, t.canvas));
    t.release(5, 1);
    expect(t.inputs).toEqual([]);
    expect(t.terminal.selectionManager.hasSelection()).toBe(false);
    expect(clipboard).toEqual([]);
    root.activeElement = t.canvas;
    root.windowFocused = false;
    t.press(1, 1);
    t.release(1, 1);
    expect(t.inputs).toEqual([]);
    root.windowFocused = true;
    t.press(1, 1);
    t.release(1, 1);
    expect(t.inputs).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    t.view.unmount();
  });

  it("two tiles side by side each send only their own; a click into the other tile only gives it the keyboard", async () => {
    const a = await tile(tracking);
    const b = await tile(tracking);
    root.activeElement = a.canvas;
    a.press(1, 1);
    a.release(1, 1);
    b.press(1, 1);
    b.release(1, 1);
    expect(a.inputs).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    expect(b.inputs).toEqual([]);
    root.activeElement = b.canvas;
    b.press(2, 2);
    b.release(2, 2);
    expect(b.inputs).toEqual(["\x1b[<0;2;2M", "\x1b[<0;2;2m"]);
    expect(a.inputs).toHaveLength(2);
    a.view.unmount();
    b.view.unmount();
  });

  it("takes its listeners back when the tile closes", async () => {
    const t = await tile(tracking);
    t.view.unmount();
    expect(t.frame.listening("mousedown")).toBe(0);
    expect(root.listening("mousemove")).toBe(0);
    expect(root.listening("mouseup")).toBe(0);
    t.press(1, 1);
    expect(t.inputs).toEqual([]);
  });
});

// The review's cases in a tile (its CONTRACT cases as written).
const { RemoteTerminalPort } = await import("../src/renderer/terminal/remote-port");

describe("a release the app only inferred, in a tile", () => {
  it("CONTRACT: recovering a missed release from a later hover must not grant fresh clipboard permission", async () => {
    const t = await tile(tracking);
    t.press(1, 1);
    vi.advanceTimersByTime(60_000);
    t.canvas.dispatchEvent(mouse("mousemove", { clientX: 4, clientY: 8, buttons: 0 }, t.canvas));
    t.send(osc52("late hover overwrites clipboard"));
    expect(clipboard).toEqual([]);
    // The program still got its release.
    expect(t.inputs).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    t.view.unmount();
  });

  it("nor from a move over another tile", async () => {
    const a = await tile(tracking);
    const b = await tile(tracking);
    root.activeElement = a.canvas;
    a.press(1, 1);
    vi.advanceTimersByTime(60_000);
    b.canvas.dispatchEvent(mouse("mousemove", { clientX: 12, clientY: 8, buttons: 0 }, b.canvas));
    a.send(osc52("from the other tile's move"));
    expect(clipboard).toEqual([]);
    expect(a.inputs).toEqual(["\x1b[<0;1;1M", "\x1b[<0;2;1m"]);
    a.view.unmount();
    b.view.unmount();
  });
});

describe("a press the format cannot say, in a tile", () => {
  it("CONTRACT: an unencodable legacy press must not authorize a clipboard write on its release", async () => {
    const t = await tile("\x1b[?1000h");
    t.canvas.rect.width = 2400;
    const terminal = t.terminal as unknown as { cols: number };
    terminal.cols = 300;
    t.canvas.dispatchEvent(mouse("mousedown", { clientX: 223 * 8 + 4, clientY: 8, buttons: 1 }, t.canvas));
    expect(t.inputs).toEqual([]);
    vi.advanceTimersByTime(2500);
    t.release(1, 1);
    t.send(osc52("never reported press"));
    expect(clipboard).toEqual([]);
    expect(t.inputs).toEqual([]);
    t.view.unmount();
  });

  it("the UTF-8 twin", async () => {
    const t = await tile("\x1b[?1000;1005h");
    t.canvas.rect.width = 2100 * 8;
    (t.terminal as unknown as { cols: number }).cols = 2100;
    t.canvas.dispatchEvent(mouse("mousedown", { clientX: 2015 * 8 + 4, clientY: 8, buttons: 1 }, t.canvas));
    vi.advanceTimersByTime(2500);
    t.release(1, 1);
    t.send(osc52("never reported press"));
    expect(clipboard).toEqual([]);
    expect(t.inputs).toEqual([]);
    t.view.unmount();
  });
});

/** The preload bridge's terminal calls in the order they came. */
function orderedBridge() {
  const log: string[] = [];
  const data = new Set<(event: { sessionId: string; data: Uint8Array }) => void>();
  let reply: ((value: { sessionId: string }) => void) | null = null;
  const bridge = {
    openTerminal: () => new Promise<{ sessionId: string }>((resolve) => (reply = resolve)),
    terminalInput: (_session: string, input: string | Uint8Array) => log.push(`input ${typeof input === "string" ? input : String.fromCharCode(...input)}`),
    terminalResize: () => undefined,
    closeTerminal: (session: string) => log.push(`close ${session}`),
    onTerminalData: (listener: (event: { sessionId: string; data: Uint8Array }) => void) => {
      data.add(listener);
      return () => data.delete(listener);
    },
    onTerminalExit: () => () => undefined,
  };
  return {
    log,
    bridge: bridge as unknown as ConstructorParameters<typeof RemoteTerminalPort>[0],
    open: async (session: string) => {
      reply?.({ sessionId: session });
      await settle();
    },
    send: (session: string, text: string) => {
      for (const listener of data) listener({ sessionId: session, data: new TextEncoder().encode(text) });
    },
  };
}

/** A tile on a real RemoteTerminalPort (the pane's Terminal and the drawer's shell use one), opened as session s1. */
async function remoteTile(program: string) {
  const wire = orderedBridge();
  const port = new RemoteTerminalPort(wire.bridge, "host", "pane", () => undefined, () => undefined);
  const frame = root.append(new FakeNode("term-frame"));
  const hostElement = frame.append(new FakeNode("term-host"));
  const view = new HookHost(TerminalView as (props: Props) => unknown, { port, autoFocus: true });
  const slots = (view as unknown as { slots: unknown[] }).slots;
  slots[1] = { current: frame };
  slots[2] = { current: hostElement };
  view.render();
  await settle();
  await wire.open("s1");
  wire.send("s1", program);
  const canvas = (shared.made.at(-1) as MadeTerminal).renderer.getCanvas();
  root.activeElement = canvas;
  const at = (col: number) => ({ clientX: (col - 1) * cellWidth + 4, clientY: 8 });
  return {
    wire,
    port,
    view,
    frame,
    hostElement,
    press: (col: number) => canvas.dispatchEvent(mouse("mousedown", { ...at(col), buttons: 1 }, canvas)),
    drag: (col: number) => canvas.dispatchEvent(mouse("mousemove", { ...at(col), buttons: 1 }, canvas)),
    // The button comes up after the view went: on whatever is under the pointer now.
    release: (col: number) => root.dispatchEvent(mouse("mouseup", { ...at(col), buttons: 0 })),
  };
}

describe("the view going away mid-press", () => {
  it("drawer hidden or tab switched, the port disposed first: one release, sent before the attach closes", async () => {
    const t = await remoteTile(tracking);
    t.press(1);
    t.drag(3);
    t.port.dispose();
    t.view.unmount();
    t.release(5);
    expect(t.wire.log).toEqual(["input \x1b[<0;1;1M", "input \x1b[<32;3;1M", "input \x1b[<0;3;1m", "close s1"]);
  });

  it("the same with the view's cleanup first", async () => {
    const t = await remoteTile(tracking);
    t.press(1);
    t.view.unmount();
    t.port.dispose();
    t.release(5);
    expect(t.wire.log).toEqual(["input \x1b[<0;1;1M", "input \x1b[<0;1;1m", "close s1"]);
  });

  it("the port replaced (Reconnect): the old attach gets the release, once, and the new one nothing", async () => {
    const t = await remoteTile(tracking);
    t.press(2);
    const next = orderedBridge();
    const replacement = new RemoteTerminalPort(next.bridge, "host", "pane", () => undefined, () => undefined);
    t.view.render({ port: replacement, autoFocus: true });
    await settle();
    t.port.dispose();
    await next.open("s2");
    next.send("s2", `${tracking}${osc52("no action in the new view")}`);
    t.release(5);
    expect(t.wire.log).toEqual(["input \x1b[<0;2;1M", "input \x1b[<0;2;1m", "close s1"]);
    expect(next.log).toEqual([]);
    expect(clipboard).toEqual([]);
    t.view.unmount();
    replacement.dispose();
  });

  it("closing with nothing held sends nothing", async () => {
    const t = await remoteTile(tracking);
    t.press(1);
    t.release(1);
    t.port.dispose();
    t.view.unmount();
    expect(t.wire.log).toEqual(["input \x1b[<0;1;1M", "input \x1b[<0;1;1m", "close s1"]);
    const idle = await remoteTile(tracking);
    idle.view.unmount();
    idle.port.dispose();
    expect(idle.wire.log).toEqual(["close s1"]);
  });
});

// In a tile: the re-review's two view CONTRACT cases as written,
// with the window a node above the document (its blur reaches the tile).
const { StayOpen } = await import("../src/main/stay-open");
const { EventEmitter } = await import("node:events");

/** The re-review's bridge (rerev1-view.test.ts wire): every terminal call logged with its session. */
function wire() {
  const log: string[] = [];
  const data = new Set<(event: { sessionId: string; data: Uint8Array }) => void>();
  let reply: ((value: { sessionId: string }) => void) | null = null;
  const bridge = {
    openTerminal: () => new Promise<{ sessionId: string }>((resolve) => (reply = resolve)),
    terminalInput: (id: string, d: string | Uint8Array) => log.push(`input ${id} ${typeof d === "string" ? d : [...d].join(",")}`),
    terminalResize() {},
    closeTerminal: (id: string) => log.push("close " + id),
    onTerminalData: (listener: (event: { sessionId: string; data: Uint8Array }) => void) => {
      data.add(listener);
      return () => data.delete(listener);
    },
    onTerminalExit: () => () => undefined,
  } as unknown as ConstructorParameters<typeof RemoteTerminalPort>[0];
  return {
    bridge,
    log,
    resolve: async (id = "s1") => {
      reply?.({ sessionId: id });
      await settle();
    },
    send: (text: string, id = "s1") => {
      for (const listener of data) listener({ sessionId: id, data: new TextEncoder().encode(text) });
    },
  };
}

/** The re-review's mounted tile on a real RemoteTerminalPort (rerev1-view.test.ts mountedRemote). */
async function mountedRemote() {
  const w = wire();
  const port = new RemoteTerminalPort(w.bridge, "host", "pane", () => {}, () => {});
  const frame = root.append(new FakeNode("frame"));
  const hostElement = frame.append(new FakeNode("host"));
  const view = new HookHost(TerminalView as (props: Props) => unknown, { port, autoFocus: true });
  const slots = (view as unknown as { slots: unknown[] }).slots;
  slots[1] = { current: frame };
  slots[2] = { current: hostElement };
  view.render();
  await settle();
  await w.resolve();
  w.send(tracking);
  const canvas = (shared.made.at(-1) as MadeTerminal).renderer.getCanvas();
  // The keyboard in it (the probe's fake Terminal focused itself as it opened, as the installed one does).
  root.activeElement = canvas;
  const at = (col: number) => ({ clientX: (col - 1) * 8 + 4, clientY: 8 });
  return {
    w,
    port,
    view,
    frame,
    hostElement,
    canvas,
    press: (col = 1) => canvas.dispatchEvent(mouse("mousedown", { ...at(col), buttons: 1 }, canvas)),
    release: (col = 1) => canvas.dispatchEvent(mouse("mouseup", { ...at(col), buttons: 0 }, canvas)),
  };
}

/** A Mac window as StayOpen sees it; `hide` is what macOS does to the renderer: focus lost, the page hidden. */
function nativeWindow() {
  const native = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
  native.isDestroyed = () => false;
  native.isFullScreen = () => false;
  native.setFullScreen = () => {};
  native.hide = () => {
    root.windowFocused = false;
    (window as unknown as FakeNode).dispatchEvent(new Event("blur"));
    root.dispatchEvent(new Event("visibilitychange"));
  };
  return native;
}

describe("the re-review's cases in a tile", () => {
  beforeEach(() => {
    const events = Object.assign(new FakeNode("window"), window);
    events.append(root);
    vi.stubGlobal("window", events);
  });

  it("CONTRACT: another tile's fresh same-button click must not renew a stale gesture's clipboard action", async () => {
    const a = await tile(tracking);
    const b = await tile(tracking);
    root.activeElement = a.canvas;
    a.press(1, 1);
    vi.advanceTimersByTime(60000);
    expect(a.hostElement.contains(root.activeElement)).toBe(true);
    b.press(1, 1);
    b.release(1, 1);
    expect(a.inputs).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    expect(b.inputs).toEqual([]);
    a.send(osc52("a old gesture"));
    expect(clipboard).toEqual([]);
    b.send(osc52("b action"));
    expect(clipboard).toEqual(["b action"]);
    a.view.unmount();
    b.view.unmount();
  });

  it("the same with the keyboard already in the other tile: its click reports there, the stale press gets one release", async () => {
    const a = await tile(tracking);
    const b = await tile(tracking);
    root.activeElement = a.canvas;
    a.press(1, 1);
    vi.advanceTimersByTime(60000);
    // Back by keyboard to the other tile, the pointer already over it: no move.
    root.activeElement = b.canvas;
    b.press(2, 1);
    b.release(2, 1);
    expect(a.inputs).toEqual(["\x1b[<0;1;1M", "\x1b[<0;2;1m"]);
    expect(b.inputs).toEqual(["\x1b[<0;2;1M", "\x1b[<0;2;1m"]);
    a.send(osc52("a old gesture"));
    expect(clipboard).toEqual([]);
    b.send(osc52("b action"));
    expect(clipboard).toEqual(["b action"]);
    a.view.unmount();
    b.view.unmount();
  });

  it("CONTRACT: Close Window hiding the still-mounted Mac terminal must finish its held press", async () => {
    const t = await mountedRemote();
    t.press(2);
    vi.advanceTimersByTime(60000);
    // Real StayOpen is the production Close Window path, with a fake native surface.
    const native = nativeWindow();
    const policy = new StayOpen(true, { onBeforeQuit() {} });
    policy.attach(native as never);
    let prevented = false;
    native.emit("close", {
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(t.port.state).toBe("open");
    expect(t.w.log).toEqual(["input s1 \x1b[<0;2;1M", "input s1 \x1b[<0;2;1m"]);
    t.w.send(osc52("window finish action"));
    expect(clipboard).toEqual([]);
    t.view.unmount();
    t.port.dispose();
  });

  it("the window shown again: the listeners are still there and a click reports as before", async () => {
    const t = await mountedRemote();
    const listening = [t.frame.listening("mousedown"), root.listening("mousedown"), root.listening("mouseup"), (window as unknown as FakeNode).listening("blur")];
    t.press(2);
    const native = nativeWindow();
    new StayOpen(true, { onBeforeQuit() {} }).attach(native as never);
    native.emit("close", { preventDefault() {} });
    // The button's real release comes while the window is away: nothing more.
    root.dispatchEvent(mouse("mouseup", { clientX: 4, clientY: 8, buttons: 0 }));
    expect([t.frame.listening("mousedown"), root.listening("mousedown"), root.listening("mouseup"), (window as unknown as FakeNode).listening("blur")]).toEqual(listening);
    // Shown again (the Dock icon): focus back, the keyboard in the terminal.
    root.windowFocused = true;
    root.activeElement = t.canvas;
    t.press(4);
    t.release(4);
    expect(t.w.log).toEqual(["input s1 \x1b[<0;2;1M", "input s1 \x1b[<0;2;1m", "input s1 \x1b[<0;4;1M", "input s1 \x1b[<0;4;1m"]);
    t.w.send(osc52("after the window is back"));
    expect(clipboard).toEqual(["after the window is back"]);
    t.view.unmount();
    expect((window as unknown as FakeNode).listening("blur")).toBe(0);
    t.port.dispose();
  });

  it("blur with a press held: one release, no clipboard window; blur with nothing held: nothing", async () => {
    const t = await tile(tracking);
    t.press(3, 2);
    vi.advanceTimersByTime(60000);
    (window as unknown as FakeNode).dispatchEvent(new Event("blur"));
    expect(t.inputs).toEqual(["\x1b[<0;3;2M", "\x1b[<0;3;2m"]);
    t.send(osc52("blur action"));
    expect(clipboard).toEqual([]);
    (window as unknown as FakeNode).dispatchEvent(new Event("blur"));
    expect(t.inputs).toEqual(["\x1b[<0;3;2M", "\x1b[<0;3;2m"]);
    t.view.unmount();
  });
});
