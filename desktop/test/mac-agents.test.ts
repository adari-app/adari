// Every agent kind Herdr reports gets its own name, a glyph, a
// place in New agent, and a pane that opens on its own screen while Chat does
// not read it. Herdr's kinds are its `agent_label`s (src/detect/mod.rs in
// Herdr's source); the names are as each agent writes its own (sources in
// src/shared/agent-names.ts).


import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CoreAgentKind } from "../src/main/herdr/core-projection";
import { kindTitle } from "../src/main/herdr/new-agent";
import { modePickTexts } from "../src/main/herdr/mode-pick";
import { AgentGlyph, agentGlyphShape, agentName } from "../src/renderer/components/agent-kind";
import { coreStartKinds, newAgentKinds } from "../src/shared/new-agent";
import { defaultView, PaneViews, paneViewsKey, type ViewStorage } from "../src/shared/pane-view";
import { agentName as cardAgentName, waitingPlaceholder } from "../src/shared/prompt/card";
import { agentName as searchAgentName, authorText } from "../src/shared/search/text";
import { absentStartCommands, startCommandsWith } from "../src/shared/start-commands";

/** Herdr's agent labels (src/detect/mod.rs agent_label, Agent::ALL), exactly as it reports them. */
const herdrLabels = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode", "copilot",
  "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "letta", "maki", "muse",
];

/** Each kind's name, as the agent writes its own. */
const names: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
  cursor: "Cursor Agent",
  copilot: "GitHub Copilot",
  amp: "Amp",
  gemini: "Gemini CLI",
  grok: "Grok Build",
  agy: "Antigravity CLI",
  cline: "Cline",
  devin: "Devin CLI",
  droid: "Factory Droid",
  hermes: "Hermes Agent",
  kilo: "Kilo Code CLI",
  kimi: "Kimi Code CLI",
  kiro: "Kiro CLI",
  letta: "Letta Code",
  maki: "Maki",
  mastracode: "Mastra Code",
  muse: "Muse Code",
  omp: "Oh My Pi",
  qodercli: "Qoder CLI",
  qwen: "Qwen Code",
};

describe("names: every kind Herdr reports, in every place that names one", () => {
  it("the table covers every Herdr label", () => {
    expect(Object.keys(names).sort()).toEqual([...herdrLabels].sort());
  });

  it.each(Object.entries(names))("%s is %s", (kind, name) => {
    // The composer's chip, the sidebar's tooltip, Restart, Stop (agent-kind.tsx).
    expect(agentName(kind)).toBe(name);
    expect(agentName(kind.toUpperCase())).toBe(name);
    // Search's author line (shared/search/text.ts).
    expect(searchAgentName(kind)).toBe(name);
    expect(authorText("agent", kind)).toBe(name);
    // The needs-you card and the answer box (shared/prompt/card.ts).
    expect(cardAgentName(kind)).toBe(name);
    // New agent's summary lines (main/herdr/new-agent.ts).
    expect(kindTitle(kind)).toBe(name);
  });

  it("a shell and an empty kind keep their words", () => {
    expect(agentName("claude", false)).toBe("Shell");
    expect(agentName(undefined)).toBe("Agent");
    expect(agentName("")).toBe("Agent");
    expect(searchAgentName(null)).toBe("Agent");
    expect(searchAgentName("")).toBe("Agent");
    expect(cardAgentName(null)).toBe("The agent");
    expect(cardAgentName("agent")).toBe("The agent");
  });

  it("an unknown kind keeps today's capitalised fallback, in each place", () => {
    expect(agentName("aider")).toBe("Aider");
    expect(agentName("crush")).toBe("Crush");
    expect(searchAgentName("aider")).toBe("Aider");
    expect(searchAgentName("Aider")).toBe("Aider");
    expect(cardAgentName("aider")).toBe("Aider");
    expect(kindTitle("aider")).toBe("Aider");
  });

  it("mode picks name the agent as the table does", () => {
    expect(modePickTexts.noBox("claude")).toBe("Not set: Claude Code's box is not on its screen now (a dialog or a list). Check its terminal.");
    expect(modePickTexts.noBox("grok")).toBe("Not set: Grok Build's box is not on its screen now (a dialog or a list). Check its terminal.");
    expect(modePickTexts.draft("cursor")).toBe("Not set: Cursor Agent's box has text in it. Send or clear it, then pick again.");
  });

  it("the needs-you card and its box name the agent", () => {
    expect(waitingPlaceholder("gemini")).toBe("Gemini CLI is waiting on the question above");
    expect(waitingPlaceholder("kimi")).toBe("Kimi Code CLI is waiting on the question above");
  });

  it("New agent titles each kind by its name", () => {
    const titles = Object.fromEntries(newAgentKinds(absentStartCommands).map((choice) => [choice.kind, choice.title]));
    // Gemini CLI is deprecated there (Antigravity CLI replaces it); its pane and chip keep its name.
    for (const [kind, name] of Object.entries(names)) expect(titles[kind]).toBe(kind === "gemini" ? "Gemini CLI (deprecated)" : name);
    expect(titles["shell"]).toBe("Shell");
  });
});

/** The kinds drawn as their own line glyphs (Cursor Agent, Grok Build and OpenCode too). */
const drawnKinds = ["claude", "codex", "gemini", "cursor", "grok", "opencode"];

describe("glyphs: every kind gets one", () => {
  it("keeps the three drawn ones; Cursor Agent, Grok Build and OpenCode get their own", () => {
    expect(agentGlyphShape("claude")).toBe("claude");
    expect(agentGlyphShape("codex")).toBe("codex");
    expect(agentGlyphShape("gemini")).toBe("gemini");
    expect(agentGlyphShape("cursor")).toBe("cursor");
    expect(agentGlyphShape("grok")).toBe("grok");
    expect(agentGlyphShape("opencode")).toBe("opencode");
    expect(agentGlyphShape("claude", false)).toBe("shell");
  });

  // Every remaining monogram in the row's ink (no tint: at 12 px a colour says nothing).
  it.each(Object.keys(names).filter((kind) => !drawnKinds.includes(kind)))("%s gets a monogram in the row's ink", (kind) => {
    expect(agentGlyphShape(kind)).toBe("monogram");
    const svg = renderToStaticMarkup(createElement(AgentGlyph, { kind }));
    // The glyph frame: the same 24-unit box as the drawn ones.
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain("ag-monogram");
    const letters = /<text[^>]*>([^<]+)<\/text>/.exec(svg)?.[1] ?? "";
    expect(letters).toMatch(/^[A-Z][A-Za-z]?$/);
    // The initials are the name's.
    const words = names[kind]!.replace(/ CLI$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
    expect(letters[0]).toBe(words[0]![0]);
    if (letters.length === 2) expect(letters[1]).toBe(words.at(-1)![0]);
    // No tint: no colour of its own, the row's ink (currentColor) only.
    expect(svg).not.toMatch(/style=|color:var\(/);
    expect(svg).toContain('fill="currentColor"');
  });

  it("no kind's glyph carries a tint", () => {
    for (const kind of Object.keys(names)) expect(renderToStaticMarkup(createElement(AgentGlyph, { kind }))).not.toMatch(/style=|var\(--/);
  });

  it("an unknown kind keeps the generic ring", () => {
    expect(agentGlyphShape("aider")).toBe("agent");
    expect(renderToStaticMarkup(createElement(AgentGlyph, { kind: "aider" }))).toContain("ag-agent");
  });
});

// Antigravity CLI (agy) takes Gemini CLI's place in the first list; Gemini CLI follows by name.
const herdrAppFirst = ["claude", "codex", "pi", "opencode", "cursor", "copilot", "amp", "agy", "grok"];
const restByName = ["cline", "devin", "droid", "gemini", "hermes", "kilo", "kimi", "kiro", "letta", "maki", "mastracode", "muse", "omp", "qodercli", "qwen"];

describe("New agent: every agent Herdr can start on that machine", () => {
  it("a Herdr machine: Herdr App's order first, the rest by name, then a shell", () => {
    expect(newAgentKinds(absentStartCommands).map((choice) => choice.kind)).toEqual([...herdrAppFirst, ...restByName, "shell"]);
  });

  it("lists exactly the kinds Herdr's agent.start accepts (its labels)", () => {
    const listed = newAgentKinds(absentStartCommands).map((choice) => choice.kind).filter((kind) => kind !== "shell");
    expect([...listed].sort()).toEqual([...herdrLabels].sort());
  });

  it("agents.json extras come after Herdr's kinds, before the shell; a kind it names keeps its place", () => {
    const commands = startCommandsWith({ type: "read" }, { aider: "aider", claude: "cl", zed: "zed --agent", "Bad Kind": "x" });
    const kinds = newAgentKinds(commands);
    expect(kinds.map((choice) => choice.kind)).toEqual([...herdrAppFirst, ...restByName, "aider", "zed", "shell"]);
    expect(kinds.find((choice) => choice.kind === "claude")?.detail).toBe("Runs cl");
    expect(kinds.find((choice) => choice.kind === "gemini")?.detail).toBe("Herdr starts gemini");
    expect(kinds.find((choice) => choice.kind === "aider")).toMatchObject({ title: "Aider", detail: "Runs aider" });
  });

  it("a herdr-core machine: the kinds its start takes (Claude Code, Codex, Grok Build), extras, a shell", () => {
    const commands = startCommandsWith({ type: "read" }, { aider: "aider", gemini: "gemini" });
    expect(newAgentKinds(absentStartCommands, "hc:space-1").map((choice) => choice.kind)).toEqual(["claude", "codex", "grok", "shell"]);
    expect(newAgentKinds(commands, "hc:space-1").map((choice) => choice.kind)).toEqual(["claude", "codex", "grok", "aider", "gemini", "shell"]);
    expect(newAgentKinds(absentStartCommands, "w1").map((choice) => choice.kind)).toEqual([...herdrAppFirst, ...restByName, "shell"]);
  });

  it("the herdr-core list is what its bridge's agent.start takes (core-actions.ts: its known kinds but Cursor)", () => {
    expect([...coreStartKinds]).toEqual(CoreAgentKind.known.filter((kind) => kind !== "cursor"));
  });
});

class MemoryStorage implements ViewStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe("the default view follows what Chat reads", () => {
  it("a kind Chat reads opens on Chat; any other agent on its own screen; a shell on its terminal", () => {
    for (const kind of ["claude", "codex", "grok", "cursor"]) expect(defaultView({ paneID: "w1:p1", isAgent: true, kind })).toBe("chat");
    // pi, opencode, copilot, kimi, agy, gemini, cline, hermes and mastracode are Chat kinds; these stay unread.
    // Kiro stays unread for 0.1.0, as Maki.
    for (const kind of ["amp", "kiro", "devin", "letta", "muse", "qodercli", "aider"]) expect(defaultView({ paneID: "w1:p1", isAgent: true, kind })).toBe("terminal");
    expect(defaultView({ paneID: "w1:p1", isAgent: true, kind: "CLAUDE" })).toBe("chat");
    expect(defaultView({ paneID: "w1:p1", isAgent: false, kind: "shell" })).toBe("terminal");
  });

  it("a caller that gives no kind keeps Chat for an agent", () => {
    expect(defaultView({ paneID: "w1:p1", isAgent: true })).toBe("chat");
  });

  it("a kept pick still wins", () => {
    const storage = new MemoryStorage();
    const views = new PaneViews(storage);
    // Gemini is a Chat kind; the unread pane is devin's.
    const unread = { paneID: "w1:p2", isAgent: true, kind: "devin" };
    const claude = { paneID: "w1:p1", isAgent: true, kind: "claude" };
    expect(views.view("mini", unread)).toBe("terminal");
    expect(views.view("mini", claude)).toBe("chat");
    views.pick("mini", unread, "chat");
    views.pick("mini", claude, "terminal");
    expect(views.view("mini", unread)).toBe("chat");
    expect(views.view("mini", claude)).toBe("terminal");
    // Across a restart.
    const again = new PaneViews(storage);
    expect(again.view("mini", unread)).toBe("chat");
    expect(again.view("mini", claude)).toBe("terminal");
    expect(JSON.parse(storage.getItem(paneViewsKey)!)).toEqual({ "mini|w1:p2": "chat", "mini|w1:p1": "terminal" });
  });
});
