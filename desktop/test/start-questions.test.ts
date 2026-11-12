// Grok Build's folder trust, Cursor
// Agent's workspace trust, and Gemini CLI's folder trust and sign-in picker,
// each drawn before the agent's prompt while Herdr reports the pane idle (read
// from live agents; the real frames are the positive controls,
// test/support/start-question-frames.ts). The readers,
// conservatively; the watch on a real HostRegistry (listed in startScreens,
// gone when the screen goes); the Send's guard through main's real IPC handler
// (refused before any byte, the note names the question, the text kept; a
// clear read sends; a pending, failed or reconnect-crossing newer read
// refuses); Chat's line and the card's. Fake Herdr and fake screens only: no
// socket, no network, no agent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import { HostRegistry } from "../src/main/hosts";
import { StartScreenService } from "../src/main/start-screens";
import { guardTexts } from "../src/main/herdr/send";
import { PaneReadGate } from "../src/shared/chat/live-reader";
import {
  applyStartScreens,
  boxStartScreenNote,
  readStartScreen,
  showsCodexHookReview,
  showsCursorTrust,
  showsGeminiSignIn,
  showsGeminiTrust,
  showsGrokTrust,
  startScreenLines,
  startScreenNotSent,
  startScreenTexts,
  startScreenWhy,
  type StartScreenKind,
} from "../src/shared/prompt/start-screen";
import { buildSidebarModel, sidebarInputFromTopology, type SidebarRow } from "../src/shared/sidebar-model";
import { emptyTimeline } from "../src/shared/chat/model";
import type { HostView } from "../src/shared/ipc-contract";
import { ComposerDrafts, sendDraft } from "../src/renderer/components/composer-drafts";
import { HookHost, elements } from "./support/fake-hooks";
import { paneTopology } from "./support/pane-topology";
import {
  cursorTrustFrame,
  cursorTrustFrameAnsi,
  geminiSignInFrame,
  geminiTrustFrame,
  geminiTrustFrameAnsi,
  grokTrustFrame,
  grokTrustFrameAnsi,
} from "./support/start-question-frames";

const { ChatView } = await import("../src/renderer/chat/ChatView");
const { NeedsCard } = await import("../src/renderer/chat/NeedsCard");
const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
};

const rowsOf = (text: string) => text.split("\n");
/** The frame with the rows from `from` (inclusive) to `to` (exclusive) taken out. */
const without = (text: string, from: number, to = from + 1) => {
  const rows = rowsOf(text);
  return [...rows.slice(0, from), ...rows.slice(to)].join("\n");
};
/** The frame's rows from `from` on (cut above). */
const from = (text: string, start: number) => rowsOf(text).slice(start).join("\n");
const indexOf = (text: string, words: string) => rowsOf(text).findIndex((row) => row.includes(words));
/** A row inside a 119-column box like the frames' (the box's own border). */
const boxed = (inner: string, width = 117) => `│ ${inner.padEnd(width - 1)}│`;

/** Each agent's own screen after the question was answered (shapes of their prompts; words of our own). */
const after = {
  grok: ["", "  ❯ Ask Grok anything", "", "  ~/fixture", "", "                                                                                          Grok Build  1.0.77 [stable]"].join("\n"),
  cursor: [
    "  ╭" + "─".repeat(115) + "╮",
    "  │ → Plan, search, build anything" + " ".repeat(84) + "│",
    "  ╰" + "─".repeat(115) + "╯",
    "  Grok 4.7 · 0%",
    "  / commands · @ files · ! shell",
  ].join("\n"),
  gemini: ["╭" + "─".repeat(117) + "╮", boxed(">   Type your message or @path/to/file"), "╰" + "─".repeat(117) + "╯", " ~/fixture        no sandbox (see /docs)        gemini-2.5-pro (100% context left)"].join("\n"),
};

// MARK: - the readers

describe("the readers: each agent's own start question, the real frames as positive controls", () => {
  it.each([
    ["grok", grokTrustFrame, "grokTrust"],
    ["grok", grokTrustFrameAnsi, "grokTrust"],
    ["cursor", cursorTrustFrame, "cursorTrust"],
    ["cursor", cursorTrustFrameAnsi, "cursorTrust"],
    ["gemini", geminiTrustFrame, "geminiTrust"],
    ["gemini", geminiTrustFrameAnsi, "geminiTrust"],
    ["gemini", geminiSignInFrame, "geminiSignIn"],
  ] as const)("%s: the real frame reads as its question (%#)", (kind, frame, expected) => {
    expect(readStartScreen(frame, kind)).toBe(expected);
    expect(readStartScreen(frame.replace(/\n/g, "\r\n"), kind)).toBe(expected);
    expect(readStartScreen(`zsh % ${kind}\n${"older output\n".repeat(80)}${frame}`, kind)).toBe(expected);
    // Herdr reads the pane's last lines: the frame with or without its trailing blank rows.
    expect(readStartScreen(`${frame.replace(/\n+$/, "")}\n\n\n`, kind)).toBe(expected);
  });

  it("Grok Build reads 200 lines (its question sits in the middle of a tall screen), Codex 40 as before", () => {
    expect(startScreenLines("grok")).toBe(200);
    expect(startScreenLines("cursor")).toBe(200);
    expect(startScreenLines("gemini")).toBe(200);
    expect(startScreenLines("codex")).toBe(40);
    // A tall pane: 30 more blank rows between the question and Grok's version line.
    const rows = rowsOf(grokTrustFrame);
    const footer = rows.findIndex((row) => row.includes("Grok Build  1.0.77"));
    const tall = [...rows.slice(0, footer), ...Array<string>(30).fill(""), ...rows.slice(footer)].join("\n");
    expect(rowsOf(tall).length).toBeGreaterThan(60);
    expect(showsGrokTrust(rowsOf(tall).slice(-100).join("\n"))).toBe(true);
  });

  describe("near misses", () => {
    it("the question quoted in a reply with text under it", () => {
      // Grok: a row of the reply under the choices, above its version line.
      const grokRows = rowsOf(grokTrustFrame);
      const no = grokRows.findIndex((row) => row.includes("No, quit"));
      expect(showsGrokTrust([...grokRows.slice(0, no + 1), "  That is Grok's trust question; answer y to go on.", ...grokRows.slice(no + 1)].join("\n"))).toBe(false);
      expect(showsGrokTrust(`${grokTrustFrame}\n${after.grok}`)).toBe(false);
      // Cursor and Gemini: the box quoted, then the agent's own prompt under it.
      expect(showsCursorTrust(`${cursorTrustFrame}\n${after.cursor}`)).toBe(false);
      expect(showsGeminiTrust(`${geminiTrustFrame}\n${after.gemini}`)).toBe(false);
      expect(showsGeminiSignIn(`${geminiSignInFrame}\n${after.gemini}`)).toBe(false);
      // Text under the choices inside the box.
      const cursorRows = rowsOf(cursorTrustFrame);
      const quit = cursorRows.findIndex((row) => row.includes("[q] Quit"));
      expect(showsCursorTrust([...cursorRows.slice(0, quit + 1), "  " + boxed(" so I answered q, which quit it.", 115), ...cursorRows.slice(quit + 1)].join("\n"))).toBe(false);
      const geminiRows = rowsOf(geminiTrustFrame);
      const dont = geminiRows.findIndex((row) => row.includes("3. Don't trust"));
      expect(showsGeminiTrust([...geminiRows.slice(0, dont + 1), " " + boxed("Pick one with the arrow keys."), ...geminiRows.slice(dont + 1)].join("\n"))).toBe(false);
      // The same words as plain text, no box.
      const plainGemini = rowsOf(geminiTrustFrame)
        .map((row) => row.replace(/[│╭╮╰╯─]/g, " "))
        .join("\n");
      expect(showsGeminiTrust(plainGemini)).toBe(false);
    });

    it("a frame missing its choice rows, or one of them", () => {
      const yes = indexOf(grokTrustFrame, "Yes, proceed");
      expect(showsGrokTrust(without(grokTrustFrame, yes, yes + 2))).toBe(false);
      expect(showsGrokTrust(without(grokTrustFrame, yes + 1))).toBe(false);
      const trust = indexOf(cursorTrustFrame, "[a] Trust this workspace");
      expect(showsCursorTrust(without(cursorTrustFrame, trust, trust + 2))).toBe(false);
      expect(showsCursorTrust(without(cursorTrustFrame, trust + 1))).toBe(false);
      const one = indexOf(geminiTrustFrame, "1. Trust folder");
      expect(showsGeminiTrust(without(geminiTrustFrame, one, one + 3))).toBe(false);
      expect(showsGeminiTrust(without(geminiTrustFrame, one + 1))).toBe(false);
      const google = indexOf(geminiSignInFrame, "1. Sign in with Google");
      expect(showsGeminiSignIn(without(geminiSignInFrame, google, google + 3))).toBe(false);
      expect(showsGeminiSignIn(without(geminiSignInFrame, google + 2))).toBe(false);
    });

    it("a frame cut above the title (and one missing its box's top edge)", () => {
      expect(showsGrokTrust(from(grokTrustFrame, indexOf(grokTrustFrame, "Do you trust") + 1))).toBe(false);
      expect(showsCursorTrust(from(cursorTrustFrame, indexOf(cursorTrustFrame, "Workspace Trust Required") + 1))).toBe(false);
      expect(showsCursorTrust(from(cursorTrustFrame, indexOf(cursorTrustFrame, "Workspace Trust Required")))).toBe(false);
      expect(showsGeminiTrust(from(geminiTrustFrame, indexOf(geminiTrustFrame, "Do you trust the files") + 1))).toBe(false);
      expect(showsGeminiTrust(from(geminiTrustFrame, indexOf(geminiTrustFrame, "Do you trust the files")))).toBe(false);
      expect(showsGeminiSignIn(from(geminiSignInFrame, indexOf(geminiSignInFrame, "Get started") + 1))).toBe(false);
      // The title's row turned into something else inside the box.
      expect(showsGeminiTrust(geminiTrustFrame.replace("Do you trust the files in this folder?", "Do you trust the files in this folder? (asked once)   "))).toBe(false);
    });

    it("another agent kind showing the same words: only the pane's own agent's screens are read", () => {
      for (const frame of [grokTrustFrame, cursorTrustFrame, geminiTrustFrame, geminiSignInFrame]) {
        expect(readStartScreen(frame, "claude")).toBeNull();
        expect(readStartScreen(frame, "codex")).toBeNull();
        expect(readStartScreen(frame, null)).toBeNull();
        expect(showsCodexHookReview(frame)).toBe(false);
      }
      // Cursor's box says "Do you trust the contents of this directory?" too: not Grok's question, nor the reverse.
      expect(readStartScreen(cursorTrustFrame, "grok")).toBeNull();
      expect(readStartScreen(grokTrustFrame, "cursor")).toBeNull();
      expect(readStartScreen(geminiTrustFrame, "cursor")).toBeNull();
      expect(readStartScreen(geminiTrustFrame, "grok")).toBeNull();
      expect(readStartScreen(grokTrustFrame, "gemini")).toBeNull();
      expect(readStartScreen(cursorTrustFrame, "gemini")).toBeNull();
      // Grok's words with Cursor's keys, and Cursor's with Grok's.
      expect(showsGrokTrust(grokTrustFrame.replace("Yes, proceed                 y", "[a] Trust this workspace"))).toBe(false);
      expect(showsCursorTrust(cursorTrustFrame.replace("[a] Trust this workspace", "Yes, proceed  y      ...."))).toBe(false);
    });

    it("the screen after the question was answered", () => {
      expect(readStartScreen(after.grok, "grok")).toBeNull();
      expect(readStartScreen(`${rowsOf(grokTrustFrame).slice(0, 13).join("\n")}\n${after.grok}`, "grok")).toBeNull();
      expect(readStartScreen(`dev % cursor-agent\n${after.cursor}`, "cursor")).toBeNull();
      // Gemini trusted the folder: its sign-in picker comes next (another question), then its prompt.
      expect(readStartScreen(geminiSignInFrame, "gemini")).toBe("geminiSignIn");
      expect(readStartScreen(after.gemini, "gemini")).toBeNull();
    });

    it("keys, labels and markers: wrong ones are not the question; the marker may be on either choice, never on two or none", () => {
      expect(showsGrokTrust(grokTrustFrame.replace("Yes, proceed                 y", "Yes, proceed                 n"))).toBe(false);
      expect(showsGrokTrust(grokTrustFrame.replace("No, quit                     n", "No, cancel                   n"))).toBe(false);
      expect(showsGrokTrust(grokTrustFrame.replace("Grok Build  1.0.77 [stable]", "Grok Build is ready to help."))).toBe(false);
      // Grok's question without its version line under it still reads (blank rows only after the choices).
      expect(showsGrokTrust(grokTrustFrame.replace("Grok Build  1.0.77 [stable]", ""))).toBe(true);

      const cursorOther = cursorTrustFrame.replace("▶ [a] Trust this workspace", "  [a] Trust this workspace").replace("  [q] Quit", "▶ [q] Quit");
      expect(showsCursorTrust(cursorOther)).toBe(true);
      expect(showsCursorTrust(cursorTrustFrame.replace("▶ [a] Trust this workspace", "  [a] Trust this workspace"))).toBe(false);
      expect(showsCursorTrust(cursorTrustFrame.replace("  [q] Quit", "▶ [q] Quit"))).toBe(false);
      expect(showsCursorTrust(cursorTrustFrame.replace("[q] Quit", "[x] Quit"))).toBe(false);

      const geminiOther = geminiTrustFrame.replace("● 1. Trust folder", "  1. Trust folder").replace("  2. Trust parent folder", "● 2. Trust parent folder");
      expect(showsGeminiTrust(geminiOther)).toBe(true);
      expect(showsGeminiTrust(geminiTrustFrame.replace("● 1. Trust folder", "  1. Trust folder"))).toBe(false);
      expect(showsGeminiTrust(geminiTrustFrame.replace("3. Don't trust", "4. Don't trust"))).toBe(false);
      expect(showsGeminiTrust(geminiTrustFrame.replace("3. Don't trust", "3. Don’t trust"))).toBe(true);
      expect(showsGeminiSignIn(geminiSignInFrame.replace("3. Vertex AI", "3. Vertex  AI"))).toBe(false);
      expect(showsGeminiSignIn(geminiSignInFrame.replace("How would you like to authenticate for this project?", "How would you like to pay for this project?          "))).toBe(false);
      // The sign-in picker's own rows under the choices are its footer; another row there is not.
      expect(showsGeminiSignIn(geminiSignInFrame.replace("(Use Enter to select)", "(Use Tab to select)  "))).toBe(false);
    });
  });

  it("the captures' demo screens (177-180) read as their questions", async () => {
    const { demoGrokTrustScreen, demoCursorTrustScreen, demoGeminiTrustScreen, demoGeminiSignInScreen, startQuestionCaptureSteps } = await import("../src/main/start-question-captures");
    expect(readStartScreen(demoGrokTrustScreen, "grok")).toBe("grokTrust");
    expect(readStartScreen(demoCursorTrustScreen, "cursor")).toBe("cursorTrust");
    expect(readStartScreen(demoGeminiTrustScreen, "gemini")).toBe("geminiTrust");
    expect(readStartScreen(demoGeminiSignInScreen, "gemini")).toBe("geminiSignIn");
    expect(startQuestionCaptureSteps({ macMini: "mini" }, async () => undefined).map((step) => step.name)).toEqual([
      "177-grok-trust-needs-you",
      "178-cursor-trust-needs-you",
      "179-gemini-trust-needs-you",
      "180-gemini-signin-needs-you",
    ]);
  });

  it("Chat's box: a Send to a pane showing one of these questions gets the screen's own note (Codex's hook review keeps the box's)", () => {
    const screens = (kind: StartScreenKind) => ({ startScreens: { incarnation: 1, connection: 1, epoch: 1, panes: [{ paneId: "w1:p1", kind, terminalID: "t" }] } });
    expect(boxStartScreenNote(screens("grokTrust"), "w1:p1")).toBe(startScreenNotSent("grok", "grokTrust"));
    expect(boxStartScreenNote(screens("cursorTrust"), "w1:p1")).toBe(startScreenNotSent("cursor", "cursorTrust"));
    expect(boxStartScreenNote(screens("geminiTrust"), "w1:p1")).toBe(startScreenNotSent("gemini", "geminiTrust"));
    expect(boxStartScreenNote(screens("geminiSignIn"), "w1:p1")).toBe(startScreenNotSent("gemini", "geminiSignIn"));
    expect(boxStartScreenNote(screens("codexHookReview"), "w1:p1")).toBeNull();
    expect(boxStartScreenNote(screens("grokTrust"), "w1:p2")).toBeNull();
    expect(boxStartScreenNote({}, "w1:p1")).toBeNull();
  });

  it("the lines and notes: one plain line per screen, no em dash; Codex's words unchanged", () => {
    expect(startScreenTexts.grokTrust).toBe("Grok Build is asking whether to trust this folder. Answer it in its terminal.");
    expect(startScreenTexts.cursorTrust).toBe("Cursor Agent is asking whether to trust this workspace. Answer it in its terminal.");
    expect(startScreenTexts.geminiTrust).toBe("Gemini CLI is asking whether to trust this folder. Answer it in its terminal.");
    expect(startScreenTexts.geminiSignIn).toBe("Gemini CLI is asking you to sign in. Answer it in its terminal.");
    expect(startScreenNotSent("grok", "grokTrust")).toBe("Not sent: Grok Build is asking whether to trust this folder. Answer it in its terminal. The text is kept.");
    expect(startScreenNotSent("gemini", "geminiSignIn")).toBe("Not sent: Gemini CLI is asking you to sign in. Answer it in its terminal. The text is kept.");
    expect(startScreenNotSent("cursor", null)).toBe("Not sent: the app could not check whether Cursor Agent is asking a question in its terminal. The text is kept.");
    expect(startScreenNotSent("codex", null)).toBe(startScreenTexts.notSent);
    expect(startScreenNotSent("codex", "codexHookReview")).toBe("Not sent: Codex is asking whether to trust Herdr's hook in its terminal. The text is kept.");
    for (const text of Object.values(startScreenTexts)) expect(text.includes("—")).toBe(false);
  });
});

// MARK: - a machine: the real watch and guard on a real HostRegistry

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => ((resolve = done), (reject = fail)));
  return { promise, resolve, reject };
}

type PaneSpec = Parameters<typeof paneTopology>[0][number];
/** The text as an agent's TUI takes it: one bracketed paste. */
const pasted = (text: string) => `\u001b[200~${text}\u001b[201~`;
type Kind = "grok" | "cursor" | "gemini";

const prompts: Record<Kind, string> = { grok: after.grok, cursor: after.cursor, gemini: after.gemini };
const questions: readonly { readonly kind: Kind; readonly frame: string; readonly screen: StartScreenKind }[] = [
  { kind: "grok", frame: grokTrustFrame, screen: "grokTrust" },
  { kind: "cursor", frame: cursorTrustFrame, screen: "cursorTrust" },
  { kind: "gemini", frame: geminiTrustFrame, screen: "geminiTrust" },
  { kind: "gemini", frame: geminiSignInFrame, screen: "geminiSignIn" },
];

async function world(kind: Kind, panes: PaneSpec[] = [{ id: "w1:p1", agent: kind, terminal: "term1" }]) {
  let now = 10_000;
  let epoch = 1;
  let topology = paneTopology(panes);
  const screens = new Map(panes.map((pane) => [pane.id, prompts[kind]]));
  const calls: unknown[][] = [];
  /** Reads held, in the order they reached the backend (each answered by the test). */
  const held: ReturnType<typeof deferred<string>>[] = [];
  let holding = false;
  let failRead = false;
  let afterText: (() => void) | null = null;
  const backend = {
    kind: "herdr-tui",
    snapshot: async () => topology,
    connectionEpoch: () => epoch,
    paneText: async (paneId: string, lines: number) => {
      calls.push(["pane.read", paneId, lines]);
      if (failRead) throw new Error("read failed");
      if (holding) {
        const read = deferred<string>();
        held.push(read);
        return read.promise;
      }
      return screens.get(paneId) ?? "";
    },
    prompt: async (paneId: string, text: string) => void calls.push(["prompt", paneId, text]),
    sendText: async (paneId: string, text: string) => {
      calls.push(["text", paneId, text]);
      afterText?.();
    },
    sendInput: async (paneId: string, text: string, keys: readonly string[]) => void calls.push(["input", paneId, text, keys]),
    agentKeys: async (paneId: string, keys: readonly string[]) => void calls.push(["keys", paneId, keys]),
    paneSendKeys: async (paneId: string, keys: readonly string[]) => void calls.push(["pane keys", paneId, keys]),
    close() {},
  };
  let service: StartScreenService | null = null;
  const hosts = new HostRegistry(() => service?.hostsChanged());
  service = new StartScreenService(hosts, { now: () => now, every: () => () => undefined }, new PaneReadGate());
  hosts.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null }, backend as never);
  await hosts.refresh("mini");
  await flush();
  const host = (): HostView => hosts.list()[0]!;
  return {
    hosts,
    service,
    host,
    screens,
    calls,
    held,
    tick: async (ms = 2_500) => {
      now += ms;
      service!.hostsChanged();
      await flush();
    },
    setPanes: async (next: PaneSpec[]) => {
      topology = paneTopology(next);
      await hosts.refresh("mini");
      await flush();
    },
    hold: (value: boolean) => {
      holding = value;
    },
    failReads: (value: boolean) => {
      failRead = value;
    },
    setEpoch: (value: number) => {
      epoch = value;
    },
    /** Runs right after the Send's text is written (before its Return). */
    onText: (run: () => void) => {
      afterText = run;
    },
    /** The clock moves on and the watch asks for its reads now, without waiting for them. */
    tickNow: (ms = 2_500) => {
      now += ms;
      service!.hostsChanged();
    },
    reads: () => calls.filter((call) => call[0] === "pane.read"),
    writes: () => calls.filter((call) => call[0] !== "pane.read"),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Chat's Send through main's real IPC handler, bound as the page saw the pane. */
function send(w: World, kind: Kind, text: string, paneId = "w1:p1"): Promise<void> {
  registerIpc({ hosts: w.hosts, startScreens: w.service } as never);
  const pane = w.host().topology!.panes.find((candidate) => candidate.paneID === paneId)!;
  const binding = { terminalID: pane.terminalID, isAgent: true, kind, session: null, run: w.hosts.run("mini", paneId) };
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
  return registered.handles.get(IPC.paneSend)!(event, "mini", paneId, text, binding) as Promise<void>;
}

/** The page's sidebar row for the pane as App shows it (applyStartScreens). */
function sidebarRow(host: HostView, paneId = "w1:p1") {
  const [shown] = applyStartScreens([host]);
  const model = buildSidebarModel(sidebarInputFromTopology(shown!.topology!, { macID: "mini", nowUnixMs: 1_800_000_000_000 }));
  return { row: model.projects.flatMap((section) => section.rows).find((candidate) => candidate.paneID === paneId)!, model };
}

describe("the watch: a pane of each kind showing its question is listed in startScreens and leaves when it goes", () => {
  it.each(questions.map((question) => [question.screen, question] as const))("%s", async (_name, question) => {
    const w = await world(question.kind);
    expect(w.host().startScreens).toBeUndefined();
    w.screens.set("w1:p1", question.frame);
    await w.tick();
    expect(w.host().startScreens?.panes).toEqual([{ paneId: "w1:p1", kind: question.screen, terminalID: "term1" }]);
    expect(w.service.showing("mini", "w1:p1")).toBe(question.screen);
    // 200 lines a read for these kinds.
    expect(w.reads().every((call) => call[2] === 200)).toBe(true);
    const { row, model } = sidebarRow(w.host());
    expect(row.status).toBe("blocked");
    expect(row.glyph).toBe("needsYou");
    expect(model.priority.find((section) => section.kind === "needsYou")?.rows.map((each) => each.paneID)).toEqual(["w1:p1"]);
    // Answered in its terminal: the mark goes, Herdr's idle shows again.
    w.screens.set("w1:p1", prompts[question.kind]);
    await w.tick();
    expect(w.host().startScreens).toBeUndefined();
    expect(sidebarRow(w.host()).row.glyph).not.toBe("needsYou");
    expect(w.writes()).toEqual([]);
  });

  it("the page applies a mark only to a pane still running that screen's agent", async () => {
    const w = await world("grok");
    w.screens.set("w1:p1", grokTrustFrame);
    await w.tick();
    const shown = w.host();
    const relabelled = { ...shown, startScreens: { ...shown.startScreens!, panes: [{ ...shown.startScreens!.panes[0]!, kind: "cursorTrust" as const }] } };
    expect(applyStartScreens([relabelled])[0]!.topology).toBe(shown.topology);
    expect(applyStartScreens([shown])[0]!.topology).not.toBe(shown.topology);
  });

  it("a pane of these kinds with a session Herdr names, or a working one, is not read", async () => {
    const w = await world("cursor", [
      { id: "w1:s", agent: "cursor", terminal: "t-s", session: "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84" },
      { id: "w1:g", agent: "gemini", terminal: "t-g", session: "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f85" },
    ]);
    await w.tick();
    expect(w.reads()).toEqual([]);
  });
});

describe("the Send's guard for each kind (fake pane, main's real IPC handler)", () => {
  it.each(questions.map((question) => [question.screen, question] as const))("%s showing: refused before any byte, the note names the question, the text kept", async (_name, question) => {
    // The watch has it: refused at main's door.
    const w = await world(question.kind);
    w.screens.set("w1:p1", question.frame);
    await w.tick();
    const note = startScreenNotSent(question.kind, question.screen);
    await expect(send(w, question.kind, "Reply with exactly one word: pong")).rejects.toThrow(note);
    expect(w.writes()).toEqual([]);

    // The watch has not seen it yet: the Send's own read does, inside its turn. The draft stays with the note.
    const fresh = await world(question.kind);
    fresh.screens.set("w1:p1", question.frame);
    const drafts = new ComposerDrafts({ transport: () => null });
    drafts.edit("mini/w1:p1", "Reply with exactly one word: pong");
    expect(sendDraft(drafts, (_host, paneId, text) => send(fresh, question.kind, text, paneId), "mini", "w1:p1")).toBe(true);
    await flush();
    await flush();
    expect(fresh.writes()).toEqual([]);
    expect(drafts.get("mini/w1:p1").text).toBe("Reply with exactly one word: pong");
    expect(drafts.get("mini/w1:p1").error).toBe(note);
    // Its read marks the pane as needing you at once.
    expect(fresh.host().startScreens?.panes.map((pane) => pane.kind)).toEqual([question.screen]);
  });

  it.each(["grok", "cursor", "gemini"] as const)("%s: a clear read sends (one 200-line read, then the text, then its Return)", async (kind) => {
    const w = await world(kind);
    const before = w.reads().length;
    await send(w, kind, "hello");
    expect(w.reads().length).toBe(before + 1);
    expect(w.reads().at(-1)).toEqual(["pane.read", "w1:p1", 200]);
    expect(w.writes()).toEqual([
      ["text", "w1:p1", pasted("hello")],
      ["keys", "w1:p1", ["Enter"]],
    ]);
  });

  it.each(questions.map((question) => [question.screen, question] as const))("%s read between the text and its Return: no Return, the note says why", async (_name, question) => {
    const w = await world(question.kind);
    // The question is up by the time the text landed (as if the agent drew it meanwhile); the watch reads it.
    w.onText(() => {
      w.screens.set("w1:p1", question.frame);
      w.tickNow();
    });
    await expect(send(w, question.kind, "hello")).rejects.toThrow(guardTexts.noReturn(question.kind, startScreenWhy(question.kind, question.screen)));
    expect(w.writes()).toEqual([["text", "w1:p1", pasted("hello")]]);
  });

  it.each(["grok", "cursor", "gemini"] as const)("%s: a read that fails refuses with the could-not-check note, nothing written", async (kind) => {
    const w = await world(kind);
    w.failReads(true);
    await expect(send(w, kind, "hello")).rejects.toThrow(startScreenNotSent(kind, null));
    expect(w.writes()).toEqual([]);
  });

  it.each(questions.map((question) => [question.screen, question] as const))(
    "%s appearing between the Send's first read and its write (a newer read queued behind it): no write, no Return",
    async (_name, question) => {
      const w = await world(question.kind);
      w.hold(true);
      const sending = send(w, question.kind, "yes");
      await flush();
      expect(w.held).toHaveLength(1);
      // The watch asks for a newer read; it waits behind the Send's own read in the shared gate.
      await w.tick();
      // The Send's read answers the ordinary prompt; the question is up by the newer read.
      w.hold(false);
      w.screens.set("w1:p1", question.frame);
      w.held[0]!.resolve(prompts[question.kind]);
      await expect(sending).rejects.toThrow(startScreenNotSent(question.kind, question.screen));
      expect(w.writes()).toEqual([]);
    },
  );

  it.each(["grok", "cursor", "gemini"] as const)("%s: the newer read failing refuses; it answering the prompt lets the Send go", async (kind) => {
    const w = await world(kind);
    w.hold(true);
    const sending = send(w, kind, "yes");
    await flush();
    await w.tick();
    w.hold(false);
    w.failReads(true);
    w.held[0]!.resolve(prompts[kind]);
    await expect(sending).rejects.toThrow(startScreenNotSent(kind, null));
    expect(w.writes()).toEqual([]);

    const ok = await world(kind);
    ok.hold(true);
    const going = send(ok, kind, "yes");
    await flush();
    await ok.tick();
    ok.hold(false);
    ok.held[0]!.resolve(prompts[kind]);
    await going;
    expect(ok.writes().map((call) => call[0])).toEqual(["text", "keys"]);
  });

  it.each(["grok", "cursor", "gemini"] as const)("%s: the guard refuses while a newer read is pending, or after one crossed a reconnect", async (kind) => {
    const w = await world(kind);
    const guard = w.service.sendGuard("mini", "w1:p1");
    expect(await guard.read(kind, "term1")).toBe(true);
    expect(guard.clear()).toBe(true);
    // A newer read is asked for and is still out: the older clear answer allows nothing.
    w.hold(true);
    await w.tick();
    expect(w.held).toHaveLength(1);
    expect(guard.clear()).toBe(false);
    // It answers the prompt: clear again.
    w.hold(false);
    w.held[0]!.resolve(prompts[kind]);
    await flush();
    expect(guard.clear()).toBe(true);

    // The Send's own read crossing a reconnect (another command connection): refused, and the guard stays shut.
    const r = await world(kind);
    const crossing = r.service.sendGuard("mini", "w1:p1");
    r.hold(true);
    const reading = crossing.read(kind, "term1");
    await flush();
    r.setEpoch(2);
    r.held[0]!.resolve(prompts[kind]);
    expect(await reading).toBe(false);
    expect(crossing.clear()).toBe(false);
    expect(startScreenNotSent(kind, crossing.shown?.() ?? null)).toBe(startScreenNotSent(kind, null));
    expect(r.writes()).toEqual([]);
  });

  it("a Cursor Agent pane that never gets a session: every Send reads its screen once (bounded), long after the watch's window", async () => {
    const w = await world("cursor");
    await w.tick(10 * 60_000);
    await w.tick();
    const watchReads = w.reads().length;
    await w.tick();
    expect(w.reads().length, "the watch's window is over").toBe(watchReads);
    await send(w, "cursor", "one");
    await send(w, "cursor", "two");
    expect(w.reads().length).toBe(watchReads + 2);
    // The question coming back later (a new folder in the same terminal is a new run; here the screen alone): refused.
    w.screens.set("w1:p1", cursorTrustFrame);
    await expect(send(w, "cursor", "three")).rejects.toThrow(startScreenNotSent("cursor", "cursorTrust"));
    expect(w.writes()).toHaveLength(4);
  });
});

// MARK: - Chat's line and the card

const rowOf = (kind: string) => ({ paneID: "w1:p1", status: "blocked", name: "fixture", workspaceLabel: "app", isAgent: true, kind }) as unknown as SidebarRow;
const texts = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => {
    const children = element.props["children"];
    return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string");
  });
const labels = (tree: unknown) => elements(tree).filter((element) => element.type === "button").map((button) => button.props["children"]);

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;
const bridgeCalls: string[] = [];

function browser(): void {
  vi.stubGlobal("window", {
    herdrDesktop: {
      onChatUpdate: (listener: Listener) => {
        chatListener = listener;
        return () => undefined;
      },
      openChat: () => undefined,
      closeChat: () => undefined,
      setChatFollowing: () => undefined,
      copyText: () => undefined,
      sendToPane: () => (bridgeCalls.push("sendToPane"), Promise.resolve()),
      answerPrompt: () => (bridgeCalls.push("answerPrompt"), Promise.resolve({ type: "refused", note: "" })),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection: () => null,
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  });
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
}

const views: HookHost<object>[] = [];
function mount(component: unknown, props: object): HookHost<object> {
  const view = new HookHost(component as (props: object) => unknown, props);
  views.push(view);
  view.render();
  return view;
}

beforeEach(() => {
  registered.handles.clear();
  bridgeCalls.length = 0;
  browser();
});

afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  // The page's Chat store attaches to the bridge once: its listener stays for the file.
  vi.unstubAllGlobals();
});

describe("Chat and the card say it in one plain line; nothing answers it", () => {
  const names: Record<Kind, string> = { grok: "Grok Build", cursor: "Cursor Agent", gemini: "Gemini CLI" };
  it.each(questions.map((question) => [question.screen, question] as const))("%s", async (_name, question) => {
    const w = await world(question.kind);
    w.screens.set("w1:p1", question.frame);
    await w.tick();
    const [shown] = applyStartScreens([w.host()]);
    const line = startScreenTexts[question.screen];
    const chat = mount(ChatView, { host: shown, row: rowOf(question.kind), onShowTerminal: () => undefined });
    chatListener?.({ hostId: "mini", paneId: "w1:p1", state: { status: "unavailable", reason: "noSession" }, timeline: emptyTimeline });
    chat.render();
    expect(texts(chat.tree)).toContain(line);
    expect(labels(chat.tree)).toContain("Show the terminal");
    const card = mount(NeedsCard, { host: shown, row: rowOf(question.kind), onShowTerminal: () => undefined });
    expect(texts(card.tree)).toContain(`${names[question.kind]} needs you`);
    expect(texts(card.tree)).toContain(line);
    expect(labels(card.tree)).toEqual(["Show the terminal"]);
    expect(bridgeCalls).toEqual([]);
    expect(w.writes()).toEqual([]);
  });
});
