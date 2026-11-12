// Recorded frames (fixtures/livepick, plain `pane.read` text from a test Herdr server: Grok Build 1.0.77,
// Cursor Agent 2026.11.11, OpenCode 1.18.21; the machine's name and the test folder's path replaced), and a
// fake OpenCode screen built from their shapes for the pick driver: its box (opencode-01, -10), "Select model"
// with a search (opencode-02, -05, -07, and one with GLM-5.3-Flash Free typed) and "Select variant" (opencode-09).

import { readFileSync } from "node:fs";
import path from "node:path";

import { fixturesRoot } from "./swift-fixtures";

/** One frame by its file name (without `.txt`). */
export function frame(name: string): string {
  return readFileSync(path.join(fixturesRoot, "livepick", `${name}.txt`), "utf8");
}

/** A model as the fake OpenCode lists it: its display name, its provider as drawn, its variants (none: no variant list). */
export interface FakeOpenCodeModel {
  readonly name: string;
  readonly provider: string;
  readonly variants: readonly string[];
}

export interface FakeOpenCodeOptions {
  /** `/models` and Return leave the prompt as it is: no list. */
  readonly listNeverOpens?: boolean;
  /** Text typed into the list's search does not show there (the wait for it runs out). */
  readonly searchNeverShows?: boolean;
  /** After a pick the footer names this instead of the model picked. */
  readonly footerAfter?: string;
  /** The box's text at the start (the user's draft). */
  readonly draft?: string;
}

type View =
  | { readonly kind: "prompt"; draft: string }
  | { readonly kind: "models"; search: string; highlight: number }
  | { readonly kind: "variants"; highlight: number; readonly model: FakeOpenCodeModel };

const logo = [
  "                                          \u{2584}",
  "         \u{2588}\u{2580}\u{2580}\u{2588} \u{2588}\u{2580}\u{2580}\u{2588} \u{2588}\u{2580}\u{2580}\u{2588} \u{2588}\u{2580}\u{2580}\u{2584} \u{2588}\u{2580}\u{2580}\u{2580} \u{2588}\u{2580}\u{2580}\u{2588} \u{2588}\u{2580}\u{2580}\u{2588} \u{2588}\u{2580}\u{2580}\u{2588}",
  "",
];
const pad = (text: string, width: number): string => (text.length >= width ? `${text}  ` : text + " ".repeat(width - text.length));

/**
 * OpenCode's screen as its TUI draws it in the frames, driven by the keys a pick writes: `/models` typed and Return
 * opens "Select model"; text typed there filters rows by display name (case ignored); Down moves the highlight (not
 * drawn: plain text shows none); Return picks the highlighted row (its variants next, else the prompt with the footer
 * naming it); Return on a variant finishes; Esc closes a list; Backspace takes a character off the box.
 */
export class FakeOpenCode {
  view: View;
  footer: string;
  /** Every write: ["type", text] or ["keys", [...]]. */
  readonly writes: unknown[][] = [];

  constructor(
    readonly models: readonly FakeOpenCodeModel[],
    current: string,
    readonly options: FakeOpenCodeOptions = {},
  ) {
    this.footer = current;
    this.view = { kind: "prompt", draft: options.draft ?? "" };
  }

  private rows(search: string): FakeOpenCodeModel[] {
    const words = search.toLowerCase();
    return this.models.filter((model) => model.name.toLowerCase().includes(words));
  }

  screen(): string {
    const view = this.view;
    if (view.kind === "prompt") {
      const popup = view.draft === "/models" ? ["  \u{2503} /models     Switch model                          \u{2503}"] : [];
      return [
        ...logo,
        ...popup,
        "  \u{2503}",
        `  \u{2503}  ${view.draft === "" ? 'Ask anything... "Fix a TODO in the codebase"' : view.draft}`,
        "  \u{2503}",
        `  \u{2503}  Build \u{B7} ${this.footer}`,
        `  \u{2579}${"\u{2580}".repeat(52)}`,
        "  tab agents  ctrl+p commands",
        "",
        "  /private/tmp/live/work/hello-          1.18.21",
        "  opencode",
      ].join("\n");
    }
    if (view.kind === "models") {
      const body =
        view.search === ""
          ? ["     Recent", `   \u{25CF} ${this.footer}                Free`]
          : this.rows(view.search).map((model) => `     ${pad(model.name, 37)}${model.provider}`);
      return [...logo, "", "     Select model                                esc", "", `     ${view.search === "" ? "Search" : view.search}`, "", ...body, "", "     Connect provider ctrl+a  Favorite ctrl+f", "", "  opencode"].join("\n");
    }
    return [...logo, "", "     Select variant                              esc", "", "     Search", "", "     Default", ...view.model.variants.map((name) => `     ${name}`), "", "", "  opencode"].join("\n");
  }

  type(text: string): void {
    this.writes.push(["type", text]);
    const view = this.view;
    if (view.kind === "prompt") view.draft += text;
    else if (view.kind === "models" && this.options.searchNeverShows !== true) {
      view.search += text;
      view.highlight = 0;
    }
  }

  keys(keys: readonly string[]): void {
    this.writes.push(["keys", [...keys]]);
    for (const key of keys) this.key(key);
  }

  private key(key: string): void {
    const view = this.view;
    if (key === "Escape") {
      if (view.kind !== "prompt") this.view = { kind: "prompt", draft: "" };
      return;
    }
    if (key === "Backspace") {
      if (view.kind === "prompt") view.draft = view.draft.slice(0, -1);
      return;
    }
    if (key === "Down") {
      if (view.kind !== "prompt") view.highlight += 1;
      return;
    }
    if (key !== "Enter") return;
    if (view.kind === "prompt") {
      if (view.draft === "/models" && this.options.listNeverOpens !== true) this.view = { kind: "models", search: "", highlight: 0 };
      else view.draft = "";
      return;
    }
    if (view.kind === "models") {
      const model = this.rows(view.search)[view.highlight];
      if (model === undefined) return;
      if (model.variants.length > 0) {
        this.view = { kind: "variants", highlight: 0, model };
        return;
      }
      this.finish(model);
      return;
    }
    this.finish(view.model);
  }

  private finish(model: FakeOpenCodeModel): void {
    this.footer = this.options.footerAfter ?? `${model.name} ${model.provider}`;
    this.view = { kind: "prompt", draft: "" };
  }

  /** The keys written, flattened in order ("type:/models", "Enter", …). */
  keyLog(): string[] {
    return this.writes.flatMap((write) => (write[0] === "type" ? [`type:${String(write[1])}`] : (write[1] as string[])));
  }
}

/** The models in the frames (opencode-05, -06, -07, and the search for GLM-5.3-Flash Free), Beam Free with its variants (opencode-models-verbose-first3). */
export const frameModels: readonly FakeOpenCodeModel[] = [
  { name: "Beam Free", provider: "OpenCode", variants: ["low", "medium", "high", "xhigh", "max"] },
  { name: "Beam 1.0 501B A23B", provider: "OpenRouter", variants: [] },
  { name: "GLM-5.3-Flash Free", provider: "OpenCode", variants: [] },
  { name: "MiniMax M3.1 Flash Free", provider: "OpenCode", variants: [] },
  { name: "DeepSeek V4.1 Flash Free", provider: "OpenCode", variants: ["low", "high", "max"] },
];

/** How the fake Cursor draws its own list under a typed `/model <words>` (absent fields: as Cursor does). */
export interface CursorListDraw {
  /** The header's words (Cursor's: the words typed). */
  readonly header?: string;
  /** The marked first row's family (Cursor's: the exact family typed, when it has one). */
  readonly marked?: string;
  /** Its second column (the variant Cursor remembers for the family). */
  readonly variant?: string;
  /** No list drawn (the box row alone, as Cursor 2026.11.05's shape was taken to be). */
  readonly none?: boolean;
}

/**
 * Cursor 2026.11.11's screen with `/model <words>` typed in its box (cursor-live-01, -03): `screen`'s box
 * row holding `draft`, and in place of the footer under it Cursor's own list: ` Models matching "<words>"` with Max
 * mode at its right, the marked first row (` →  <family>   <variant>`), its hint line.
 */
export function cursorTypedScreen(screen: string, draft: string, list: CursorListDraw = {}): string {
  const lines = screen.split("\n");
  const box = lines.findLastIndex((line) => /^ {2}\u{2192} /u.test(line));
  if (box < 0) throw new Error("no Cursor box row in the frame");
  const head = [...lines.slice(0, box), `  \u{2192} ${draft}`];
  if (list.none === true || !draft.startsWith("/model ")) return [...head, ...lines.slice(box + 1)].join("\n");
  const words = list.header ?? draft.slice("/model ".length);
  const marked = list.marked ?? words;
  const header = ` Models matching "${words}"`;
  return [
    ...head,
    "",
    "",
    `${header.padEnd(43)}Max mode: OFF`,
    "",
    ` \u{2192}  ${marked.padEnd(24)} ${list.variant ?? "Fast"} (Tab to modify)`,
    "",
    " Edit prompt to filter \u{2022} Enter to select \u{2022} Tab to edit",
  ].join("\n");
}
