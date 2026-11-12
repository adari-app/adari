// What an OpenCode 1.18.21 screen shows, read from `pane.read`'s plain text:
//
// - its box: lines under a "┃" bar at the margin of two, the box's text (its
//   placeholder `Ask anything...` when empty; `/models` with the command
//   list's row `┃ /models  Switch model  ┃` over it while typed), then the
//   footer `Build · Beam Free OpenCode` (the agent, the model's display name
//   and its provider's), closed by a `╹▀▀▀` line;
// - its "Select model" list: the title with `esc` at its right, the search
//   line (`Search` while empty, else the text typed), then one row per model,
//   its display name and its provider's name apart (`Beam Free      OpenCode`),
//   then `Connect provider ctrl+a  Favorite ctrl+f`;
// - its "Select variant" list: the title, `Search`, then `Default` and the
//   model's variant names, one per row.
//
// Anything else is "other". Nothing here writes; the pick driver
// (src/main/herdr/opencode-pick.ts) reads each screen through this.

/** OpenCode's empty box shows its placeholder, which starts so. */
export const openCodePlaceholder = "Ask anything...";
/** What a live pick types first: OpenCode's own command for its model list. */
export const openCodeModelsCommand = "/models";

/** One row of OpenCode's "Select model" list with a search typed: its display name and its provider's name. */
export interface OpenCodeModelRow {
  readonly name: string;
  readonly provider: string;
}

export type OpenCodeScreen =
  /** The box: its text ("" for the placeholder), and the footer's line after "Build · " (null: none that reads). */
  | { readonly kind: "prompt"; readonly draft: string; readonly empty: boolean; readonly footer: string | null }
  /**
   * "Select model": the search typed (null: its "Search" placeholder) and the rows under it; `rows` null when a line
   * there is not a row of a name and a provider (a header, a tag column): not a list a pick can choose in.
   */
  | { readonly kind: "models"; readonly search: string | null; readonly rows: readonly OpenCodeModelRow[] | null }
  /** "Select variant": the search typed (null: none) and its rows' words ("Default", "low", …). */
  | { readonly kind: "variants"; readonly search: string | null; readonly rows: readonly string[] }
  | { readonly kind: "other" };

const bar = "\u{2503}";
const listTitle = /^ {3,}(Select model|Select variant) {2,}esc$/u;
const footerLine = /^(\S+(?: \S+)*) \u{B7} (.+)$/u;

/** The last box on the screen (its lines between the bar's top and the `╹` line), or null. */
function readBox(lines: readonly string[]): OpenCodeScreen | null {
  const bottom = lines.findLastIndex((line) => line.startsWith(`  \u{2579}`));
  if (bottom < 1) return null;
  let top = bottom;
  while (top > 0 && lines[top - 1]!.startsWith(`  ${bar}`)) top -= 1;
  if (top === bottom) return null;
  // The command list's rows (`┃ /models  Switch model  ┃`) stand over the box's own text: not the box's.
  const content = lines
    .slice(top, bottom)
    .filter((line) => !(line.startsWith(`  ${bar} `) && line.endsWith(bar) && line.length > 4 && !line.startsWith(`  ${bar}  `)))
    .map((line) => line.slice(3).trim());
  const written = content.filter((text) => text !== "");
  if (written.length === 0) return null;
  const footer = footerLine.exec(written[written.length - 1]!);
  if (footer === null) return { kind: "prompt", draft: written.join(" "), empty: false, footer: null };
  const above = written.slice(0, -1);
  const draft = above.join(" ");
  const empty = above.length === 0 || (above.length === 1 && above[0]!.startsWith(openCodePlaceholder));
  return { kind: "prompt", draft: empty ? "" : draft, empty, footer: footer[2]!.trim() };
}

/** A list's rows: from the line after its search to the line before `Connect provider` or the list's end. */
function listRows(lines: readonly string[]): string[] {
  const rows: string[] = [];
  for (const line of lines) {
    // The list's own lines stand at a margin of three or more; the screen's (the folder, "opencode") at two.
    if (line.trim() === "") continue;
    if (!/^ {3,}\S/.test(line)) break;
    const text = line.trim();
    if (/^Connect provider\b/.test(text)) break;
    rows.push(text);
  }
  return rows;
}

/** One model row: a display name and a provider apart by two spaces or more (the current one's `●` taken off). */
function modelRow(text: string): OpenCodeModelRow | null {
  const parts = text.replace(/^\u{25CF} /u, "").split(/ {2,}/);
  if (parts.length !== 2 || parts[0]!.trim() === "" || parts[1]!.trim() === "") return null;
  return { name: parts[0]!.trim(), provider: parts[1]!.trim() };
}

/** The bottom of an OpenCode screen: its box, its model list, its variant list, or "other". */
export function readOpenCodeScreen(screen: string): OpenCodeScreen {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/u, ""));
  const title = lines.findLastIndex((line) => listTitle.test(line));
  if (title >= 0) {
    const which = listTitle.exec(lines[title]!)![1]!;
    const after = lines.slice(title + 1);
    const searchAt = after.findIndex((line) => line.trim() !== "");
    if (searchAt < 0 || !/^ {3,}\S/.test(after[searchAt]!)) return { kind: "other" };
    const typed = after[searchAt]!.trim();
    const search = typed === "Search" ? null : typed;
    const rows = listRows(after.slice(searchAt + 1));
    if (which === "Select variant") return { kind: "variants", search, rows };
    const parsed = rows.map(modelRow);
    return { kind: "models", search, rows: parsed.every((row): row is OpenCodeModelRow => row !== null) ? parsed : null };
  }
  return readBox(lines) ?? { kind: "other" };
}

/** A provider's id and its name on screen compared: letters and digits only, case ignored ("opencode" and "OpenCode"). */
export function sameProvider(providerId: string, shown: string): boolean {
  const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = plain(providerId);
  return id !== "" && id === plain(shown);
}

/** The footer's line names the model: its display name, then a provider's name that is the model's provider. */
export function footerNames(footer: string, name: string, providerId: string): boolean {
  if (!footer.startsWith(`${name} `)) return false;
  return sameProvider(providerId, footer.slice(name.length + 1).trim());
}
