// What the start question tests share (a fake redraw and a tall Grok screen, each agent's ordinary prompt, and a
// machine: the real watch and guard on a real HostRegistry with a fake Herdr whose reads honour the lines asked for,
// sent through main's real IPC handler). The test file mocks electron and passes the handlers it caught. Fake Herdr and fake screens only: no socket, no network, no agent.

import { HostRegistry } from "../../src/main/hosts";
import { registerIpc } from "../../src/main/ipc";
import { APP_ORIGIN } from "../../src/main/protocol";
import { StartScreenService } from "../../src/main/start-screens";
import { PaneReadGate } from "../../src/shared/chat/live-reader";
import { IPC } from "../../src/shared/ipc-contract";
import { paneTopology } from "./pane-topology";

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => ((resolve = done), (reject = fail)));
  return { promise, resolve, reject };
}

export type Kind = "grok" | "cursor" | "gemini";

/** Each agent's ordinary prompt (shapes of their own; words of our own). */
export const prompts: Record<Kind, string> = {
  grok: "❯ Ask Grok anything\nGrok Build  1.0.77 [stable]",
  cursor: "╭──────────────────────────────╮\n│ → Plan, search, build anything│\n╰──────────────────────────────╯\n/ commands · @ files · ! shell",
  gemini: "> Type your message or @path/to/file\nno sandbox",
};

// eslint-disable-next-line no-control-regex
export const strip = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

/**
 * A redraw of a frame at `width` columns (a fake): each row's text and indentation kept, borders drawn again at the
 * width, text inside wrapped at word boundaries (a word longer than the room broken at it).
 */
export function redraw(frame: string, width: number): string {
  const wrap = (line: string, space: number): string[] => {
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    if (line.trim() === "") return [""];
    const rows: string[] = [];
    let row = indent;
    for (let word of line.trim().split(/\s+/)) {
      while (word.length > space - indent.length) {
        if (row.trim() !== "") {
          rows.push(row);
          row = indent;
        }
        rows.push(indent + word.slice(0, space - indent.length));
        word = word.slice(space - indent.length);
      }
      if (row.trim() !== "" && row.length + 1 + word.length > space) {
        rows.push(row);
        row = indent + word;
      } else row += (row.trim() !== "" ? " " : "") + word;
    }
    rows.push(row);
    return rows;
  };
  return strip(frame)
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      if (/^╭─+╮$/u.test(trimmed)) return [`╭${"─".repeat(width - 2)}╮`];
      if (/^╰─+╯$/u.test(trimmed)) return [`╰${"─".repeat(width - 2)}╯`];
      if (trimmed.startsWith("│") && trimmed.endsWith("│")) return wrap(trimmed.slice(1, -1).trimEnd(), width - 2).map((row) => `│${row.padEnd(width - 2)}│`);
      return wrap(trimmed, width);
    })
    .join("\n");
}

/** A Grok screen `height` rows tall: the question centred, its version line on the last row. */
export function tallGrok(height: number): string {
  const content = ["Do you trust the contents of this directory?", "/fixture", "", "Grok Build may run or modify contents in this directory,", "posing security risks.", "", "Yes, proceed  y", "No, quit  n"];
  const top = Math.floor((height - content.length) / 2);
  return [...Array<string>(top).fill(""), ...content, ...Array<string>(height - top - content.length - 1).fill(""), "Grok Build  1.0.77 [stable]"].join("\n");
}
export const last = (text: string, lines: number) => text.split("\n").slice(-lines).join("\n");

// MARK: - a machine: the real watch and guard on a real HostRegistry, main's real IPC handler

/** A machine whose pane reads honour the lines asked for (the last `lines` rows of the screen). */
export async function startQuestionWorld(kind: Kind, handles: ReadonlyMap<string, (...args: unknown[]) => unknown>) {
  let now = 10_000;
  let epoch = 1;
  const topology = paneTopology([{ id: "w1:p1", agent: kind, terminal: "term1" }]);
  const calls: unknown[][] = [];
  const screens = new Map([["w1:p1", prompts[kind]]]);
  let onText: (() => void) | undefined;
  let onSnapshot: (() => Promise<void> | void) | undefined;
  let onRead: ((paneId: string, lines: number) => Promise<string>) | undefined;
  const backend = {
    kind: "herdr-tui",
    connectionEpoch: () => epoch,
    snapshot: async () => {
      await onSnapshot?.();
      return topology;
    },
    paneText: async (paneId: string, lines: number) => {
      calls.push(["read", paneId, lines]);
      return onRead !== undefined ? onRead(paneId, lines) : last(screens.get(paneId) ?? "", lines);
    },
    sendText: async (paneId: string, text: string) => {
      calls.push(["text", paneId, text]);
      onText?.();
    },
    prompt: async (paneId: string, text: string) => void calls.push(["prompt", paneId, text]),
    sendInput: async (paneId: string, text: string, keys: readonly string[]) => void calls.push(["input", paneId, text, keys]),
    agentKeys: async (paneId: string, keys: readonly string[]) => void calls.push(["keys", paneId, keys]),
    close() {},
  };
  let service: StartScreenService | undefined;
  const hosts = new HostRegistry(() => service?.hostsChanged());
  service = new StartScreenService(hosts, { now: () => now, every: () => () => undefined }, new PaneReadGate());
  hosts.add({ id: "mini", name: "Mini", kind: "ssh", address: "fixture", platform: null }, backend as never);
  await hosts.refresh("mini");
  await flush();
  return {
    screens,
    service: service!,
    writes: () => calls.filter((call) => call[0] !== "read"),
    reads: () => calls.filter((call) => call[0] === "read"),
    tickNow: (ms = 2_500) => {
      now += ms;
      service!.hostsChanged();
    },
    onText: (run: typeof onText) => (onText = run),
    onSnapshot: (run: typeof onSnapshot) => (onSnapshot = run),
    onRead: (run: typeof onRead) => (onRead = run),
    setEpoch: (value: number) => (epoch = value),
    send: async (text: string) => {
      registerIpc({ hosts, startScreens: service } as never);
      const pane = hosts.pane("mini", "w1:p1")!;
      const binding = { terminalID: pane.terminalID, isAgent: true, kind, session: null, run: hosts.run("mini", "w1:p1") };
      await handles.get(IPC.paneSend)!({ senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } }, "mini", "w1:p1", text, binding);
    },
  };
}
