// What the pickers remember, in
// Adari's own settings (the page's localStorage, as New agent's last kind):
// the starred models per machine and agent, and New agent's last Model and
// Effort per machine and agent. Each value is checked when read (an id of the
// agent's pattern, a level of the effort pattern), bounded, and a storage that
// fails keeps nothing.

import { effortPattern, isModelId, type CatalogAgent } from "./model-catalog";
import type { StartChoice } from "./model-choices";

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const favouritesKey = "adari.models.favourites";
export const startChoicesKey = "adari.newAgent.models";

/** At most this many machines and agents are remembered, and this many stars for one. */
const maxEntries = 100;
const maxFavourites = 200;

const entryKey = (hostId: string, agent: CatalogAgent): string => `${hostId}|${agent}`;

function readMap(storage: PrefsStorage | null, key: string): Record<string, unknown> {
  try {
    const text = storage?.getItem(key) ?? null;
    if (text === null || text.length > 512 * 1_024) return {};
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeMap(storage: PrefsStorage | null, key: string, map: Record<string, unknown>): void {
  const keys = Object.keys(map);
  const kept = keys.length <= maxEntries ? map : Object.fromEntries(keys.slice(keys.length - maxEntries).map((one) => [one, map[one]]));
  try {
    storage?.setItem(key, JSON.stringify(kept));
  } catch {
    // Not kept: the picker starts with none next time.
  }
}

/** The models starred for the machine and agent. */
export function favouriteModels(storage: PrefsStorage | null, hostId: string, agent: CatalogAgent): ReadonlySet<string> {
  const list = readMap(storage, favouritesKey)[entryKey(hostId, agent)];
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((id): id is string => isModelId(agent, id)).slice(0, maxFavourites));
}

/** Stars or unstars `id` for the machine and agent; the stars after. */
export function toggleFavourite(storage: PrefsStorage | null, hostId: string, agent: CatalogAgent, id: string): ReadonlySet<string> {
  const now = new Set(favouriteModels(storage, hostId, agent));
  if (!isModelId(agent, id)) return now;
  if (now.has(id)) now.delete(id);
  else if (now.size < maxFavourites) now.add(id);
  const map = readMap(storage, favouritesKey);
  const key = entryKey(hostId, agent);
  delete map[key];
  if (now.size > 0) map[key] = [...now];
  writeMap(storage, favouritesKey, map);
  return now;
}

const noChoice: StartChoice = { model: null, effort: null };

/** New agent's last Model and Effort for the machine and agent (the agent's default for each at first). */
export function lastStartChoice(storage: PrefsStorage | null, hostId: string, agent: CatalogAgent): StartChoice {
  const saved = readMap(storage, startChoicesKey)[entryKey(hostId, agent)];
  if (typeof saved !== "object" || saved === null) return noChoice;
  const record = saved as Record<string, unknown>;
  const model = isModelId(agent, record["model"]) ? record["model"] : null;
  const effort = typeof record["effort"] === "string" && effortPattern.test(record["effort"]) ? record["effort"] : null;
  return { model, effort };
}

export function rememberStartChoice(storage: PrefsStorage | null, hostId: string, agent: CatalogAgent, choice: StartChoice): void {
  const map = readMap(storage, startChoicesKey);
  const key = entryKey(hostId, agent);
  delete map[key];
  if (choice.model !== null || choice.effort !== null) map[key] = { model: choice.model, effort: choice.effort };
  writeMap(storage, startChoicesKey, map);
}
