// The model picker's rows (T3 Code's
// ModelPickerContent and modelPickerSearch as the model of the behaviour, in
// Adari's own code): with nothing typed, "Agent's default" first, then the
// starred models (Favourites), then the rest under their group headers when
// the list has groups; with a search, one ranked list: an exact id or label
// first, then a prefix, a word inside, anywhere, letters in order, each by
// the field it matched (the label, the id, the group), a starred model ahead
// of an equal one, the list's own order last.

import type { CatalogModel } from "./model-catalog";

/** One row of the picker. */
export type PickerRow =
  | { readonly kind: "default"; readonly label: string; readonly note: string | null; readonly ticked: boolean }
  | { readonly kind: "header"; readonly label: string }
  | { readonly kind: "model"; readonly model: CatalogModel; readonly ticked: boolean; readonly favourite: boolean };

/** Lowercased, trimmed, inner runs of space as one. */
export function normalizeQuery(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Letters of `token` in order inside `value`: the gaps between them (lower is closer), or null. */
function lettersInOrder(value: string, token: string): number | null {
  let at = 0;
  let first = -1;
  let last = -1;
  let gaps = 0;
  for (let index = 0; index < value.length && at < token.length; index += 1) {
    if (value[index] !== token[at]) continue;
    if (first < 0) first = index;
    if (last >= 0) gaps += index - last - 1;
    last = index;
    at += 1;
  }
  if (at < token.length) return null;
  // Letters strewn across a long name are not a match ("big" in "baidu/ernie-light").
  const span = last - first + 1;
  return span > Math.max(12, token.length * 3) ? null : gaps * 3 + (span - token.length);
}

/** How well `token` matches `value` (lower is better), from `base`: exact, prefix, a word's start, inside, letters in order. */
function tokenScore(value: string, token: string, base: number): number | null {
  if (value === "" || token === "") return null;
  if (value === token) return base;
  if (value.startsWith(token)) return base + 2;
  if ([" ", "-", "_", "/", ".", "~"].some((mark) => value.includes(`${mark}${token}`))) return base + 4;
  if (value.includes(token)) return base + 6;
  if (token.length < 3) return null;
  const gaps = lettersInOrder(value, token);
  return gaps === null ? null : base + 100 + gaps;
}

/** A starred model's head start over an equal match. */
const favouriteBoost = 24;
/** An exact id or label beats any other match. */
const exactScore = -1_000;

/** The model's score for `query` (lower is better; null: it does not match). Nothing typed: 0 for every model. */
export function modelScore(model: Pick<CatalogModel, "id" | "label" | "group">, query: string, favourite = false): number | null {
  const normal = normalizeQuery(query);
  if (normal === "") return 0;
  const label = normalizeQuery(model.label);
  const id = model.id.toLowerCase();
  if (normal === label || normal === id) return exactScore;
  const fields = [label, id, (model.group ?? "").toLowerCase(), `${label} ${id} ${(model.group ?? "").toLowerCase()}`];
  let score = 0;
  for (const token of normal.split(" ")) {
    let best: number | null = null;
    fields.forEach((field, index) => {
      const found = tokenScore(field, token, index * 10);
      if (found !== null && (best === null || found < best)) best = found;
    });
    if (best === null) return null;
    score += best;
  }
  return favourite ? score - favouriteBoost : score;
}

/** The models matching `query`, best first (a starred one ahead of an equal match, then the list's order). */
export function rankModels(models: readonly CatalogModel[], query: string, favourites: ReadonlySet<string>): CatalogModel[] {
  const ranked: { model: CatalogModel; score: number; favourite: boolean; order: number }[] = [];
  models.forEach((model, order) => {
    const favourite = favourites.has(model.id);
    const score = modelScore(model, query, favourite);
    if (score !== null) ranked.push({ model, score, favourite, order });
  });
  ranked.sort((a, b) => a.score - b.score || Number(b.favourite) - Number(a.favourite) || a.order - b.order);
  return ranked.map((entry) => entry.model);
}

export interface PickerInput {
  readonly models: readonly CatalogModel[];
  readonly query: string;
  readonly favourites: ReadonlySet<string>;
  /** The id ticked (null: none, or the agent's default when `defaultTicked`). */
  readonly current: string | null;
  /** The "Agent's default" row: its words and line (null: no such row here). */
  readonly defaultRow: { readonly label: string; readonly note: string | null; readonly ticked: boolean } | null;
}

/** The words a search must share with "Agent's default" for that row to stay while searching. */
const defaultWords = ["default", "agent"];

/** The picker's rows for what is typed. */
export function pickerRows(input: PickerInput): PickerRow[] {
  const query = normalizeQuery(input.query);
  const row = (model: CatalogModel): PickerRow => ({ kind: "model", model, ticked: model.id === input.current, favourite: input.favourites.has(model.id) });
  const rows: PickerRow[] = [];
  const defaultRow = input.defaultRow;
  if (query !== "") {
    if (defaultRow !== null && defaultWords.some((word) => word.startsWith(query) || query.split(" ").every((token) => defaultWords.some((one) => one.startsWith(token))))) {
      rows.push({ kind: "default", ...defaultRow });
    }
    for (const model of rankModels(input.models, query, input.favourites)) rows.push(row(model));
    return rows;
  }
  if (defaultRow !== null) rows.push({ kind: "default", ...defaultRow });
  const starred = input.models.filter((model) => input.favourites.has(model.id));
  const rest = input.models.filter((model) => !input.favourites.has(model.id));
  if (starred.length > 0) {
    rows.push({ kind: "header", label: "Favourites" });
    for (const model of starred) rows.push(row(model));
  }
  const grouped = rest.some((model) => model.group !== null);
  if (!grouped) {
    if (starred.length > 0 && rest.length > 0) rows.push({ kind: "header", label: "All models" });
    for (const model of rest) rows.push(row(model));
    return rows;
  }
  // The models with no group first (under "All models" after Favourites), then each group in the list's order.
  const loose = rest.filter((model) => model.group === null);
  if (loose.length > 0) {
    if (starred.length > 0) rows.push({ kind: "header", label: "All models" });
    for (const model of loose) rows.push(row(model));
  }
  const order: string[] = [];
  const members = new Map<string, CatalogModel[]>();
  for (const model of rest) {
    if (model.group === null) continue;
    if (!members.has(model.group)) {
      members.set(model.group, []);
      order.push(model.group);
    }
    members.get(model.group)!.push(model);
  }
  for (const group of order) {
    rows.push({ kind: "header", label: group });
    for (const model of members.get(group)!) rows.push(row(model));
  }
  return rows;
}

/** The rows a key may land on (not headers). */
export function pickable(row: PickerRow): boolean {
  return row.kind !== "header";
}

/** The next row a key lands on from `from` (-1: none yet) going `step` (1 down, -1 up), or `from` when there is none. */
export function nextPickable(rows: readonly PickerRow[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < rows.length; index += step) {
    if (pickable(rows[index]!)) return index;
  }
  return from;
}

/** The row a fresh list highlights: the ticked one, else the first pickable one (-1: none). */
export function firstHighlight(rows: readonly PickerRow[], query: string): number {
  if (normalizeQuery(query) === "") {
    const ticked = rows.findIndex((row) => (row.kind === "model" || row.kind === "default") && row.ticked);
    if (ticked >= 0) return ticked;
  }
  return rows.findIndex(pickable);
}

/** Row heights for the windowed list: a header's and a model's (px). */
export const headerHeight = 26;
export const rowHeight = 30;

/** Each row's top (px) and the whole height. */
export function rowOffsets(rows: readonly PickerRow[]): { readonly tops: readonly number[]; readonly height: number } {
  const tops: number[] = [];
  let at = 0;
  for (const row of rows) {
    tops.push(at);
    at += row.kind === "header" ? headerHeight : rowHeight;
  }
  return { tops, height: at };
}

/** The rows to draw for a window from `scrollTop` of `viewHeight` (px), `overscan` rows each side. */
export function visibleRange(tops: readonly number[], height: number, scrollTop: number, viewHeight: number, overscan = 6): { readonly start: number; readonly end: number } {
  if (tops.length === 0) return { start: 0, end: 0 };
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, height - viewHeight)));
  // The last row starting at or above `top`.
  let low = 0;
  let high = tops.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tops[middle]! <= top) low = middle;
    else high = middle - 1;
  }
  let end = low;
  while (end < tops.length && tops[end]! < top + viewHeight) end += 1;
  return { start: Math.max(0, low - overscan), end: Math.min(tops.length, end + overscan) };
}
