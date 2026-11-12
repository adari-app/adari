// Focus never rebuilds a terminal:
// a terminal's lifetime follows its port alone; which tile has the keyboard is
// a separate effect. Clicking from one tile to another, and back, keeps the
// same Ghostty terminal with its screen and scrollback, and a focus asked
// while the engine is still loading is given once it is up.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, useLayoutEffect: fakeReact.useEffect };
});

interface FakeTerminal {
  writes: string[];
  focuses: number;
  disposed: boolean;
}

const made: FakeTerminal[] = [];
let engineUp: () => void = () => undefined;

let engine: Promise<void> | null = null;

// The engine's WebAssembly comes in once for the window, and each terminal then gets its
// own instance of it (terminal-core.ts); held here until engineUp().
vi.mock("../src/renderer/terminal/terminal-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/terminal/terminal-core")>()),
  newTerminalCore: () => {
    engine ??= new Promise<void>((resolve) => {
      engineUp = resolve;
    });
    return engine.then(() => ({}));
  },
}));

vi.mock("ghostty-web", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
  Terminal: class {
    cols = 80;
    rows = 24;
    options: unknown;
    writes: string[] = [];
    focuses = 0;
    disposed = false;
    constructor(options: unknown) {
      this.options = options;
      made.push(this);
    }
    loadAddon() {}
    open() {}
    onData() {}
    // TerminalView also takes the wheel and the keys (terminal-input.ts).
    attachCustomWheelEventHandler() {}
    attachCustomKeyEventHandler() {}
    resize() {}
    focus() {
      this.focuses += 1;
    }
    write(bytes: Uint8Array) {
      this.writes.push(new TextDecoder().decode(bytes));
    }
    dispose() {
      this.disposed = true;
    }
  },
}));

import { HookHost } from "./support/fake-hooks";

const { TerminalView } = await import("../src/renderer/terminal/TerminalView");

type Props = Parameters<typeof TerminalView>[0];

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function fakePort() {
  const subscribers = new Set<(bytes: Uint8Array) => void>();
  return {
    subscribers,
    port: {
      subscribe(onData: (bytes: Uint8Array) => void) {
        subscribers.add(onData);
        return () => subscribers.delete(onData);
      },
      resize() {},
      input() {},
    },
    send(text: string) {
      for (const write of subscribers) write(new TextEncoder().encode(text));
    },
  };
}

/** TerminalView in a hook host with its two elements in place before the first render (no DOM here). */
function mount(props: Props): HookHost<Props> {
  const view = new HookHost(TerminalView as (props: Props) => unknown, props);
  // TerminalView's second and third hooks are the frame and host refs (its note listener
  // ref comes first).
  const slots = (view as unknown as { slots: unknown[] }).slots;
  // The paste, drag and drop listeners go on them.
  const listens = { addEventListener() {}, removeEventListener() {} };
  slots[1] = { current: { ...listens } };
  slots[2] = { current: { ...listens, replaceChildren() {} } };
  return view;
}

beforeEach(() => {
  made.length = 0;
  vi.stubGlobal("document", { fonts: { load: async () => undefined } });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
  // TerminalInput reads the bridge's copy and clipboard.
  vi.stubGlobal("window", { herdrDesktop: { copyText: () => undefined } });
});

afterEach(() => vi.unstubAllGlobals());

describe("a terminal tile's focus", () => {
  it("switching tile focus keeps the same terminal, its screen and its scrollback", async () => {
    const { port, subscribers, send } = fakePort();
    const view = mount({ port, autoFocus: true });
    view.render();
    engineUp();
    await settle();
    expect(made).toHaveLength(1);
    const terminal = made[0]!;
    expect(terminal.focuses).toBe(1);
    send("existing terminal screen\n");
    send("scrollback line 2\n");

    // Another tile is clicked: this one loses focus, then gets it back.
    view.render({ port, autoFocus: false });
    await settle();
    view.render({ port, autoFocus: true });
    await settle();

    expect(made).toHaveLength(1);
    expect(terminal.disposed).toBe(false);
    expect(terminal.writes).toEqual(["existing terminal screen\n", "scrollback line 2\n"]);
    expect(terminal.focuses).toBe(2);
    expect(subscribers.size).toBe(1);
    // Bytes after the switches still reach the same screen.
    send("after\n");
    expect(terminal.writes.at(-1)).toBe("after\n");

    view.unmount();
    expect(terminal.disposed).toBe(true);
    expect(subscribers.size).toBe(0);
  });

  it("a focus asked while the engine loads is given once the terminal is up, without a second terminal", async () => {
    const { port, send } = fakePort();
    const view = mount({ port, autoFocus: false });
    view.render();
    // Bytes and a focus request both arrive before Ghostty's WebAssembly is in.
    send("early bytes\n");
    view.render({ port, autoFocus: true });
    engineUp();
    await settle();
    expect(made).toHaveLength(1);
    expect(made[0]!.writes).toEqual(["early bytes\n"]);
    expect(made[0]!.focuses).toBe(1);
    view.unmount();
  });

  it("a terminal shown unfocused does not take the keyboard", async () => {
    const { port } = fakePort();
    const view = mount({ port, autoFocus: false });
    view.render();
    engineUp();
    await settle();
    expect(made).toHaveLength(1);
    expect(made[0]!.focuses).toBe(0);
    view.unmount();
  });

  it("a new port is a new terminal (the lifetime follows the port)", async () => {
    const first = fakePort();
    const second = fakePort();
    const view = mount({ port: first.port, autoFocus: false });
    view.render();
    engineUp();
    await settle();
    view.render({ port: second.port, autoFocus: false });
    await settle();
    expect(made).toHaveLength(2);
    expect(made[0]!.disposed).toBe(true);
    expect(first.subscribers.size).toBe(0);
    expect(second.subscribers.size).toBe(1);
    view.unmount();
  });
});
