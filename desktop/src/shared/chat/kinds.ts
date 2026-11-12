// The agent kinds Chat reads, as Herdr reports them, one line per kind (a new
// reader adds its kind's line when it lands). A pane of any other kind opens on
// its own screen, and its Chat tab says Chat doesn't read it yet (pane-view.ts
// defaultView, unread.ts).
// The kinds are Herdr's agent labels (src/detect/mod.rs agent_label; the locator's agentFormat maps each to its
// transcript format). The helpers' other names are kept as aliases below (readsChat, chatReadsKind,
// chatReadKinds), so all code reads the same list. The store readers' three kinds (Hermes, Mastra Code, Cline)
// are lines of chatKinds too, so the one helper and the fallback see them as read; chatStoreKinds is those kinds
// of the one list (store-agents.ts names the three).

import { knownAgentName, readerKind } from "../agent-names";
import { isStoreAgentFormat } from "./agents/store-agents";

export const chatKinds: readonly string[] = [
  "claude",
  "codex",
  "grok",
  "cursor",
  "pi", // Pi (pi-mono's coding agent)
  "omp", // omp (oh-my-pi), Pi's format
  // OpenCode (its SQLite session store, agents/opencode-store.ts, agents/opencode-parser.ts)
  "opencode",
  // Kilo, an OpenCode fork with the same store (kilo.db), the same reader
  "kilo",
  // Gemini CLI (agents/gemini-parser.ts).
  "gemini",
  // Qwen Code (agents/qwen-parser.ts).
  "qwen",
  // Antigravity CLI, Herdr's `agy` (agents/antigravity-parser.ts). Its step kinds, statuses and result
  // association follow SpecStory's ANTIGRAVITY-FORMAT.md and parser.
  "agy",
  // GitHub Copilot CLI (events.jsonl, agents/copilot-parser.ts)
  "copilot",
  // Factory Droid (sessions/<folder>/<id>.jsonl, agents/droid-parser.ts)
  "droid",
  "kimi",
  // Maki's session logs (agents/maki-parser.ts) are not read for 0.1.0. Herdr reports no Maki session and the app
  // passes no argv, so only the folder's newest log could be followed, and a resumed older session would show
  // another; Maki opens on its own screen with the Chat line. The reader stays (agents/maki-*.ts) until a safe
  // resume identity exists.
  // Hermes (its SQLite state.db, agents/hermes-store.ts, agents/hermes-parser.ts)
  "hermes",
  // Mastra Code (its LibSQL mastra.db, agents/mastra-store.ts, agents/mastra-parser.ts)
  "mastracode",
  // Cline (its messages.json read whole, agents/cline-store.ts, agents/cline-parser.ts)
  "cline",
  // Kiro CLI's V3 sessions (agents/kiro-locate.ts, agents/kiro-parser.ts) are not read for 0.1.0, as Maki. Herdr
  // reports no Kiro session, so only the folder's newest V3 session could be followed, and a resumed older one (or
  // a new run before its first record) would show another session of the same folder; Kiro opens on its own
  // screen with the Chat line. The reader stays (agents/kiro-*.ts, with its tests) until an exact session identity
  // exists.
];

/**
 * The kinds the store registry's readers add (stores.ts). Their lines are in chatKinds above; this is the same
 * three, read from the one list.
 */
export const chatStoreKinds: readonly string[] = chatKinds.filter((kind) => isStoreAgentFormat(kind));

/**
 * Chat reads this kind's sessions (any case). An alias reads as the kind it names (agent-names.ts readerKind:
 * `github-copilot` is Copilot), as the service gate does.
 */
export function chatReads(kind: string | null | undefined): boolean {
  return kind !== null && kind !== undefined && chatKinds.includes(readerKind(kind));
}

/** Whether Chat reads a transcript for an agent of this kind (another name for chatReads). */
export const readsChat = chatReads;
/**
 * Whether Chat reads a transcript for panes of this agent kind (another name for chatReads; chatKinds holds
 * chatStoreKinds).
 */
export const chatReadsKind = chatReads;
/** The agent kinds Chat reads (another name for chatKinds: the same one list). */
export const chatReadKinds = chatKinds;

/**
 * The kinds Chat supports for 0.1.0: Claude Code and Codex. Every other kind in chatKinds keeps its Chat, marked
 * Early (T3 Code's "Early Access" badge as the model). Antigravity CLI (`agy`) is Early until it is tested live.
 * Gemini CLI is deprecated (Antigravity CLI is the agent for Google's models) and is early too. Grok Build, Cursor
 * Agent and OpenCode are Early as well: their screens change with every CLI update. A kind moves to supported by
 * adding it here. Only the Early badge and the early line follow this list; every kind's Chat, chips and Model
 * picks work the same either way.
 */
export const chatSupportedKinds: readonly string[] = ["claude", "codex"];

/** How Chat stands for a kind: "supported", "early" (Chat reads it, not run live), or null (Chat doesn't read it). */
export type ChatSupport = "supported" | "early";

/** The one question every place asks (any case, an alias as the kind it names): supported, early, or null. */
export function chatSupport(kind: string | null | undefined): ChatSupport | null {
  if (!chatReads(kind)) return null;
  return chatSupportedKinds.includes(readerKind(kind!)) ? "supported" : "early";
}

/** Whether Chat for this kind is early (it reads the kind, which is not one of the supported ones). */
export function chatEarly(kind: string | null | undefined): boolean {
  return chatSupport(kind) === "early";
}

/** The Early badge's word. */
export const chatEarlyLabel = "Early";

/**
 * The Early badge's title, and the line at the top of an early kind's empty Chat: "Chat for Gemini CLI is early. It
 * can miss things; the Terminal is always exact." The name is the agent tab's (the table's, else the kind
 * capitalised); null for a kind that is not early.
 */
export function chatEarlyText(kind: string | null | undefined): string | null {
  if (!chatEarly(kind)) return null;
  const name = knownAgentName(kind) ?? kind!.charAt(0).toUpperCase() + kind!.slice(1);
  return `Chat for ${name} is early. It can miss things; the Terminal is always exact.`;
}
