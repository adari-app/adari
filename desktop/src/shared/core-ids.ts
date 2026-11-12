// The prefix of every herdr-core id the app shows (panes, spaces, tabs, the machine group), so a
// page can tell a herdr-core space from a Herdr TUI one (CoreIDs in src/main/herdr/core-model.ts builds them).

export const coreIDPrefix = "hc:";

/** A herdr-core id (`hc:`). */
export function isCoreID(id: string): boolean {
  return id.startsWith(coreIDPrefix);
}
