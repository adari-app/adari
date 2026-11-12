// The agent's kind as a small glyph and a name: the sidebar's rows and the
// composer's agent chip show it the way T3 Code shows a thread's provider.
// The glyphs are our own line drawings in the row's ink (never a vendor's
// mark or colour, and never the needs-you yellow); every other
// kind Herdr reports is its monogram, the name's initials in the same frame
// (src/shared/agent-names.ts).
//
// At 12 px two letters cannot be read and a tint
// says nothing, so Cursor Agent, Grok Build and OpenCode get their own line
// drawings that suggest the name (a pointer, a mallet, an open pair of code
// brackets), and every remaining monogram draws in the row's ink, untinted.

import type { ReactNode } from "react";

import { agentKindEntry, knownAgentName } from "../../shared/agent-names";
import { chatEarlyLabel, chatEarlyText } from "../../shared/chat/kinds";

/** The agent's name for a chip ("Claude Code", "Codex"); a shell is "Shell". */
export function agentName(kind: string | undefined, isAgent = true): string {
  if (!isAgent) return "Shell";
  if (kind === undefined || kind === "") return "Agent";
  const known = knownAgentName(kind);
  return known ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * The agent's own name for the pane switch's middle tab, its own screen ("Claude
 * Code", "Codex", "Grok", "Cursor", any other kind's name from agentName). Claude's program is Claude Code; the
 * composer's chip keeps agentName's shorter "Claude". With the
 * names in agent-names.ts agentName is already "Claude Code", "Grok Build", "Cursor Agent", so this is agentName.
 */
export function agentOwnName(kind: string | undefined): string {
  return kind?.toLowerCase() === "claude" ? "Claude Code" : agentName(kind);
}

/** The switch's title for that tab: "Claude Code's own screen". */
export function agentScreenTitle(kind: string | undefined): string {
  return `${agentOwnName(kind)}'s own screen`;
}

type GlyphShape = "claude" | "codex" | "gemini" | "cursor" | "grok" | "opencode" | "monogram" | "agent" | "shell";

/** The drawing a kind gets: its own (six kinds), its monogram (every other kind Herdr reports), else a ring. */
export function agentGlyphShape(kind: string | undefined, isAgent = true): GlyphShape {
  if (!isAgent) return "shell";
  switch (kind?.toLowerCase()) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "gemini":
      return "gemini";
    case "cursor":
      return "cursor";
    case "grok":
      return "grok";
    case "opencode":
      return "opencode";
    default:
      return agentKindEntry(kind)?.initials != null ? "monogram" : "agent";
  }
}

const paths: Readonly<Record<Exclude<GlyphShape, "monogram">, ReactNode>> = {
  // An eight-ray spark.
  claude: <path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6 6 18" />,
  // A hexagon around a point.
  codex: (
    <>
      <path d="M12 3.6 19.3 7.8v8.4L12 20.4l-7.3-4.2V7.8z" />
      <circle cx="12" cy="12" r="1.4" />
    </>
  ),
  // A four-point star.
  gemini: <path d="M12 3.5c.7 4.6 3.9 7.8 8.5 8.5-4.6.7-7.8 3.9-8.5 8.5-.7-4.6-3.9-7.8-8.5-8.5 4.6-.7 7.8-3.9 8.5-8.5z" />,
  // Cursor Agent: a pointer (a cursor).
  cursor: <path d="M6 3.5v15.5l4.3-4.1 2.9 6.2 2.7-1.3-2.9-6.1h6z" />,
  // Grok Build: a mallet (building).
  grok: (
    <>
      <path d="M12.6 4.6 19.4 11.4 16.6 14.2 9.8 7.4z" />
      <path d="M13.2 10.8 4.8 19.2" />
    </>
  ),
  // OpenCode: a pair of code brackets, open.
  opencode: <path d="m8.5 6.5-5 5.5 5 5.5M15.5 6.5l5 5.5-5 5.5" />,
  // Any other agent: a ring around a point.
  agent: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="1.6" />
    </>
  ),
  shell: <path d="m5.5 8 4 4-4 4M12 16.5h6.5" />,
};

/** A monogram: a rounded frame, faintly filled, around one or two letters, in the row's ink (no tint). */
function monogram(initials: string): ReactNode {
  return (
    <>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="currentColor" fillOpacity={0.14} />
      <text
        x="12"
        y="12.6"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        stroke="none"
        fontSize={initials.length > 1 ? 10.5 : 13}
        fontWeight={700}
        letterSpacing={initials.length > 1 ? -0.4 : 0}
      >
        {initials}
      </text>
    </>
  );
}

export function AgentGlyph({ kind, isAgent = true, size = 12 }: { kind: string | undefined; isAgent?: boolean; size?: number }) {
  const shape = agentGlyphShape(kind, isAgent);
  const known = shape === "monogram" ? agentKindEntry(kind) : null;
  return (
    <svg
      className={`ag-g ag-${shape}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {known?.initials == null ? paths[shape as Exclude<GlyphShape, "monogram">] : monogram(known.initials)}
    </svg>
  );
}

/**
 * The Early badge (T3 Code's "Early Access" badge as the model, small and quiet) for a kind whose Chat
 * is early (kinds.ts chatSupport), titled "Chat for <agent> is early. …"; nothing for a supported kind, a kind Chat
 * doesn't read, a shell. The pane's Chat tab, New agent's list and Settings' agents show it.
 */
export function ChatEarlyBadge({ kind }: { kind: string | null | undefined }) {
  const title = chatEarlyText(kind);
  if (title === null) return null;
  return (
    <span className="early-b" title={title} data-chat-early={kind ?? ""}>
      {chatEarlyLabel}
    </span>
  );
}
