// The user's own Terminal input on this machine while an answer is under way
// withdraws it. The answer notes the pane's Terminal input (PaneInputs) when it begins and the
// before-send gate compares it, beside the connection, agent, block and claim
// checks: any input meanwhile sends nothing, keeps no claim, and the card says
// Answer in Terminal. The case: the final read's reply holds form A, the
// user's Terminal input lands (B shows) before that reply reaches the answer.
// Every prompt kind answered by keys: Codex's form, Grok's frame, Claude's
// menu, Codex's [y/N] line, and the box's "No, tell…".

import { describe, expect, it } from "vitest";

import { HostRegistry } from "../src/main/hosts";
import { PaneInputs } from "../src/main/pane-inputs";
import { PromptService } from "../src/main/prompt/prompts";
import { TerminalSessions } from "../src/main/terminals";
import { NeedsCardStore } from "../src/renderer/chat/needs-card-store";
import { stopBindingOf } from "../src/shared/agent-stop";
import type { HostView } from "../src/shared/ipc-contract";
import { readingMatch } from "../src/shared/prompt/matcher";
import { answerTexts, type AnswerRequest, type AnswerResult, type PanePrompt } from "../src/shared/prompt/view";
import { C, F, G } from "./support/prompt-fixtures";
import { backend, clock, duringRead, FakeHerdr, show, snapshot } from "./support/prompt-herdr";

const pane = "w1:p1";

/** A machine whose pane w1:p1 runs `kind` showing `screens`, the service counting its Terminal input, and the user's Terminal open on it. */
async function setup(kind: "codex" | "grok" | "claude", screens: string[]) {
  const json = snapshot();
  const panes = json["panes"] as Record<string, unknown>[];
  const agents = json["agents"] as Record<string, unknown>[];
  panes[0]!["agent"] = kind;
  agents[0]!["agent"] = kind;
  agents[0]!["agent_session"] = { source: `herdr:${kind}`, agent: kind, kind: "id", value: `${kind}-1` };
  const herdr = new FakeHerdr(json, { [pane]: screens, "w1:p2": [F.working] });
  const inputs = new PaneInputs();
  const registry = new HostRegistry(() => undefined);
  const wire = backend(herdr, { value: 1 });
  wire.openTerminal = async () => ({ input() {}, resize() {}, close() {} });
  registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, wire);
  await registry.refreshAll();
  const time = clock();
  const service = new PromptService(registry, () => undefined, time, undefined, inputs);
  await service.tick();
  const terminals = new TerminalSessions(registry, inputs);
  const owner = { isDestroyed: () => false, send: () => undefined } as never;
  const terminal = await terminals.open(owner, { hostId: "mac", paneId: pane, cols: 80, rows: 40 });
  const name = kind === "codex" ? "Codex" : kind === "grok" ? "Grok" : "Claude";
  const prompt = (): PanePrompt => service.list().find((each) => each.paneId === pane)!;
  const request = (key: string, text?: string): AnswerRequest => ({
    hostId: "mac",
    paneId: pane,
    binding: stopBindingOf(registry.list()[0]!, pane, name),
    fingerprint: readingMatch(prompt().reading!)!.fingerprint,
    episode: prompt().episode,
    key,
    ...(text === undefined ? {} : { text }),
  });
  return {
    herdr,
    inputs,
    service,
    request,
    /** The user types `data` into the pane's Terminal (this app's), as the Terminal view writes it. */
    type: (data: string): void => terminals.input(owner, terminal.sessionId, data),
    keys: (): string[][] => herdr.sent("pane.send_keys").map((params) => params["keys"] as string[]),
    cleanup: (): void => {
      terminals.closeAll();
      service.stop();
    },
  };
}

const typed: AnswerResult = { type: "refused", note: answerTexts.typedMeanwhile, terminal: true };

describe("the user's Terminal input during the answer's final read withdraws it", () => {
  it("Codex's form: the reply holds A, the user cancels A with 4 and B shows: zero keys, Answer in Terminal", async () => {
    const context = await setup("codex", [C.four]);
    try {
      const request = context.request("1");
      duringRead(context.herdr, () => {
        context.type("4");
        show(context.herdr, pane, C.second, C.after);
      });
      expect(await context.service.answer(request)).toEqual(typed);
      expect(context.inputs.generation("mac", pane)).toBe(1);
      expect(context.keys()).toEqual([]);
    } finally {
      context.cleanup();
    }
  });

  it("Grok's frame: the same held read, zero keys", async () => {
    const context = await setup("grok", [G.approval]);
    try {
      const request = context.request("1");
      duringRead(context.herdr, () => {
        context.type("3");
        show(context.herdr, pane, G.second, G.after);
      });
      expect(await context.service.answer(request)).toEqual(typed);
      expect(context.keys()).toEqual([]);
    } finally {
      context.cleanup();
    }
  });

  it("Claude's numbered menu and Codex's [y/N] line: the same held read, zero keys", async () => {
    for (const [kind, screen, key] of [
      ["claude", F.claudeEdit, "1"],
      ["codex", F.codexYesNo, "y"],
    ] as const) {
      const context = await setup(kind, [screen]);
      try {
        const request = context.request(key);
        duringRead(context.herdr, () => context.type("x"));
        expect(await context.service.answer(request), kind).toEqual(typed);
        expect(context.keys(), kind).toEqual([]);
      } finally {
        context.cleanup();
      }
    }
  });

  it("the box's “No, tell…” with text: zero keys, the text kept, Answer in Terminal", async () => {
    const context = await setup("claude", [F.claudeEdit]);
    try {
      const shown = readingMatch(context.service.list().find((each) => each.paneId === pane)!.reading!)!;
      const tell = shown.options.find((option) => option.opensComposer)!;
      const request = context.request(tell.key, "use the staging bucket");
      duringRead(context.herdr, () => context.type("n"));
      expect(await context.service.answer(request)).toEqual({ type: "refused", note: `${answerTexts.typedMeanwhile}. The text is kept.`, terminal: true });
      expect(context.keys()).toEqual([]);
      expect(context.herdr.sent("agent.prompt")).toEqual([]);
    } finally {
      context.cleanup();
    }
  });

  it("no claim is kept: with no typing, the next answer to the same form goes, the digit alone", async () => {
    const context = await setup("codex", [C.four]);
    try {
      const request = context.request("1");
      duringRead(context.herdr, () => context.type("j"));
      expect(await context.service.answer(request)).toEqual(typed);
      show(context.herdr, pane, C.four, C.after);
      expect(await context.service.answer(request)).toEqual({ type: "sent", label: "Allow" });
      expect(context.keys()).toEqual([["1"]]);
    } finally {
      context.cleanup();
    }
  });

  it("an untouched answer sends (Codex's form and Grok's frame)", async () => {
    for (const [kind, screens, label] of [
      ["codex", [C.four, C.after], "Always allow"],
      ["grok", [G.approval, G.after], undefined],
    ] as const) {
      const context = await setup(kind, [...screens]);
      try {
        const result = await context.service.answer(context.request(kind === "codex" ? "3" : "1"));
        expect(result.type, kind).toBe("sent");
        if (label !== undefined) expect(result).toEqual({ type: "sent", label });
        expect(context.keys(), kind).toEqual([[kind === "codex" ? "3" : "1"]]);
      } finally {
        context.cleanup();
      }
    }
  });

  it("typing after the digit went changes nothing: the answer stands (no Enter, no second key)", async () => {
    const context = await setup("codex", [C.four, C.after]);
    try {
      let typedOnce = false;
      context.herdr.beforeKeys = () => {
        // The keys are on their way: the user's typing now comes after the gate.
        if (!typedOnce) setTimeout(() => context.type("z"), 0);
        typedOnce = true;
      };
      expect(await context.service.answer(context.request("2"))).toEqual({ type: "sent", label: "Allow for this session" });
      expect(context.keys()).toEqual([["2"]]);
    } finally {
      context.cleanup();
    }
  });
});

describe("the card says Answer in Terminal", () => {
  const host = { id: "box", name: "build-box", state: "connected", topology: null, incarnation: 1, epoch: 0 } as unknown as HostView;

  it("a refusal for the user's Terminal input: the note, and the card's Answer in Terminal", async () => {
    const store = new NeedsCardStore();
    const reading = { type: "matched" as const, match: readingMatch((await import("../src/shared/prompt/matcher")).matchPrompt(C.four, pane, "codex"))! };
    store.receive([{ hostId: "box", paneId: pane, episode: "e1", incarnation: 1, connection: 1, epoch: 1, reading, quiet: false, cleared: false }]);
    const shown = reading.match;
    const bridge = { listPrompts: () => Promise.resolve([]), onPromptsChanged: () => () => undefined, answerPrompt: () => Promise.resolve(typed) };
    await store.answer(bridge, host, pane, "codex", shown, shown.options[0]!);
    expect(store.card("box", pane).note).toBe(answerTexts.typedMeanwhile);
    expect(store.card("box", pane).terminal).toEqual({ episode: "e1" });
    expect(store.card("box", pane).sent).toBeNull();
  });

  it("the same from the box: the box's note, and Answer in Terminal", async () => {
    const store = new NeedsCardStore();
    const reading = { type: "matched" as const, match: readingMatch((await import("../src/shared/prompt/matcher")).matchPrompt(F.claudeEdit, pane, "claude"))! };
    store.receive([{ hostId: "box", paneId: pane, episode: "e1", incarnation: 1, connection: 1, epoch: 1, reading, quiet: false, cleared: false }]);
    const shown = reading.match;
    const tell = shown.options.find((option) => option.opensComposer)!;
    const note = `${answerTexts.typedMeanwhile}. The text is kept.`;
    const bridge = { listPrompts: () => Promise.resolve([]), onPromptsChanged: () => () => undefined, answerPrompt: () => Promise.resolve<AnswerResult>({ type: "refused", note, terminal: true }) };
    await store.answer(bridge, host, pane, "claude", shown, tell, "use the staging bucket");
    expect(store.card("box", pane).boxNote).toBe(note);
    expect(store.card("box", pane).terminal).toEqual({ episode: "e1" });
  });
});

describe("the app's service counts the user's Terminal input", () => {
  it("main gives the card's service the same PaneInputs the Terminal sessions bump", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
    const made = main.indexOf("const paneInputs = new PaneInputs();");
    const service = main.indexOf("const prompts = new PromptService(");
    expect(made).toBeGreaterThan(-1);
    expect(made).toBeLessThan(service);
    expect(main.slice(service, main.indexOf("\n  );", service))).toMatch(/paneReads,\s*paneInputs,\s*$/);
    expect(main).toContain("new TerminalSessions(registry, paneInputs)");
  });
});

describe("Desktop's only option card lists Codex's form in its order", () => {
  // The Swift app's Inbox lists the options the same way; Desktop has no other card with options.
  const host = { id: "box", name: "build-box", state: "connected", topology: null, incarnation: 1, epoch: 0 } as unknown as HostView;
  const codexRow = { paneID: pane, isAgent: true, status: "blocked", kind: "codex", name: "quartz-api" } as never;
  const previous = (globalThis as { window?: unknown }).window;
  const bridge = { listPrompts: () => Promise.resolve([]), onPromptsChanged: () => () => undefined, answerPrompt: () => Promise.resolve<AnswerResult>({ type: "sent", label: "Allow" }) };
  const shown = async (text: string): Promise<PanePrompt> => {
    const { matchPrompt } = await import("../src/shared/prompt/matcher");
    return { hostId: "box", paneId: pane, episode: "e1", incarnation: 1, connection: 1, epoch: 1, reading: matchPrompt(text, pane, "codex"), quiet: false, cleared: false };
  };
  const render = async (): Promise<string> => {
    const [{ createElement }, { renderToStaticMarkup }, { NeedsCard }] = await Promise.all([import("react"), import("react-dom/server"), import("../src/renderer/chat/NeedsCard")]);
    return renderToStaticMarkup(createElement(NeedsCard, { host, row: codexRow, onShowTerminal: () => undefined }));
  };
  const markOn = (text: string, digit: string): string => text.split("\n").map((row) => (/^ {2}[› ] \d\. /u.test(row) ? `  ${row[4] === digit ? "›" : " "}${row.slice(3)}` : row)).join("\n");

  it("the mark on Cancel: Codex's order unchanged, Cancel chosen, every description, Always allow plainly", async () => {
    const { needsCards } = await import("../src/renderer/chat/needs-card-store");
    (globalThis as { window?: unknown }).window = { herdrDesktop: bridge };
    try {
      needsCards.receive([await shown(markOn(C.four, "4"))]);
      const html = await render();
      expect([...html.matchAll(/data-key="(\d)"/gu)].map((found) => found[1])).toEqual(["1", "2", "3", "4"]);
      expect(html).toContain('<button class="nc-opt on" data-key="4"><span class="k">4</span><span class="l">Cancel</span><span class="d">Cancel this tool call</span></button>');
      expect(html).toContain('<span class="l">Always allow</span><span class="d">Run the tool and remember this choice for future tool calls</span>');
      expect(html).not.toMatch(/\d more/u);
    } finally {
      (globalThis as { window?: unknown }).window = previous;
      needsCards.receive([]);
    }
  });

  it("the two-option form: both listed with their descriptions, not side by side", async () => {
    const { needsCards } = await import("../src/renderer/chat/needs-card-store");
    (globalThis as { window?: unknown }).window = { herdrDesktop: bridge };
    try {
      needsCards.receive([await shown(C.two)]);
      const html = await render();
      expect(html).toContain('<div class="nc-opts" role="group"');
      expect(html).toContain('<span class="l">Allow</span><span class="d">Run the tool and continue</span>');
      expect(html).toContain('<span class="l">Cancel</span><span class="d">Cancel this tool call</span>');
    } finally {
      (globalThis as { window?: unknown }).window = previous;
      needsCards.receive([]);
    }
  });
});
