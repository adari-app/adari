// Every agent kind Herdr reports, one table for every place
// that names a kind (the composer's chip, the sidebar, search, the needs-you
// card, mode picks, New agent) and the glyph each gets.
//
// `kind` is Herdr's label exactly as it reports it on a pane (`agent_label` in
// Herdr's src/detect/mod.rs: `agy` for Antigravity, `copilot` for GitHub
// Copilot, `qodercli` for Qoder). Herdr's `agent.start` takes every one of
// them (`parse_agent_label`, src/app/agents.rs) and types the kind's own
// executable into the pane's shell, so each is one New agent can start on a
// Herdr machine.
//
// `name` is the agent's own name as it writes it. Sources: the agent's own
// screen where this repo has it recorded (Grok Build's banner,
// test/support/grok-model-fixtures.ts; Cursor Agent's header,
// test/support/live-cursor-fixtures.ts), the agents' own names for Claude
// Code, Codex, Gemini CLI, OpenCode, GitHub Copilot and Factory Droid, Herdr's
// Supported agents table (docs agents.mdx) and Herdr App's programs.json
// for the rest, and the Swift app's "Oh My Pi" (Sources/HerdrKit/Wire.swift).
//
// `initials` draw its monogram (agent-kind.tsx), in the row's ink: the name's
// first letter, and its last word's for a name of two or more words (a
// trailing "CLI" left out). The kinds drawn as their own line glyphs (Claude
// Code, Codex, Gemini CLI, Cursor Agent, Grok Build, OpenCode) have none. No
// tint: at 12 px a colour says nothing; the row's ink reads.

export interface AgentKindEntry {
  readonly kind: string;
  readonly name: string;
  /** Null for the six drawn glyphs. */
  readonly initials: string | null;
}

const entry = (kind: string, name: string, initials: string | null = null): AgentKindEntry => ({ kind, name, initials });

/** Every kind Herdr reports, in Herdr App's menu order first, the rest by name. */
export const agentKinds: readonly AgentKindEntry[] = [
  entry("claude", "Claude Code"),
  entry("codex", "Codex"),
  entry("pi", "Pi", "P"),
  entry("opencode", "OpenCode"),
  entry("cursor", "Cursor Agent"),
  entry("copilot", "GitHub Copilot", "GC"),
  entry("amp", "Amp", "A"),
  entry("gemini", "Gemini CLI"),
  entry("grok", "Grok Build"),
  entry("agy", "Antigravity CLI", "A"),
  entry("cline", "Cline", "C"),
  entry("devin", "Devin CLI", "D"),
  entry("droid", "Factory Droid", "FD"),
  entry("hermes", "Hermes Agent", "HA"),
  entry("kilo", "Kilo Code CLI", "KC"),
  entry("kimi", "Kimi Code CLI", "KC"),
  entry("kiro", "Kiro CLI", "K"),
  entry("letta", "Letta Code", "LC"),
  entry("maki", "Maki", "M"),
  entry("mastracode", "Mastra Code", "MC"),
  entry("muse", "Muse Code", "MC"),
  entry("omp", "Oh My Pi", "OP"),
  entry("qodercli", "Qoder CLI", "Q"),
  entry("qwen", "Qwen Code", "QC"),
];

const byKind = new Map(agentKinds.map((item) => [item.kind, item]));

/**
 * Herdr's other names for a kind in the table, each to that
 * kind. `github-copilot` is GitHub Copilot (Herdr's detect/mod.rs). Only an exact alias is here: `agy` and `maki`
 * are kinds of their own, and Chat doesn't read them.
 */
const kindAliases: ReadonlyMap<string, string> = new Map([["github-copilot", "copilot"]]);

/**
 * The kind as the table and Chat's readers name it: lowercased, an alias as the kind it names. The one pure
 * kind-to-reader mapping. The locator's agentFormat reads through it, and so does the chat service's gate. So do
 * chatReads (so defaultView and the fallback line, unread.ts) and the names and glyphs below.
 */
export function readerKind(kind: string): string {
  const lower = kind.toLowerCase();
  return kindAliases.get(lower) ?? lower;
}

/** The table's entry for a kind (any case, an alias as the kind it names), or null for a kind Herdr does not report. */
export function agentKindEntry(kind: string | null | undefined): AgentKindEntry | null {
  return kind === null || kind === undefined ? null : (byKind.get(readerKind(kind)) ?? null);
}

/** The agent's own name for a kind the table has ("Claude Code", "Gemini CLI"), else null: each place keeps its own fallback. */
export function knownAgentName(kind: string | null | undefined): string | null {
  return agentKindEntry(kind)?.name ?? null;
}
