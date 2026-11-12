// The one plain line a Chat tab shows for an agent whose
// kind Chat doesn't read (kinds.ts). The name is the one the agent tab carries
// (agent-kind.tsx's agentName: the table's, else the kind capitalised).

import { knownAgentName } from "../agent-names";
import { chatReads } from "./kinds";

/** "Chat doesn't read Gemini CLI's sessions yet. …", or null: a kind Chat reads, a shell, an agent with no kind. */
export function chatUnreadLine(isAgent: boolean, kind: string | null | undefined): string | null {
  if (!isAgent || kind === null || kind === undefined || kind === "" || chatReads(kind)) return null;
  const name = knownAgentName(kind) ?? kind.charAt(0).toUpperCase() + kind.slice(1);
  return `Chat doesn't read ${name}'s sessions yet. Its own screen is on the ${name} tab.`;
}
