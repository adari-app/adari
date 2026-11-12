// The box's row at narrow widths (the app's
// CompanionChipsFitTests' rule): the Permissions chip shrinks to its icon
// before Model and Effort lose their words. The row is a size container;
// below its width the mode chip's word goes (its icon, its menu and its
// aria-label stay); Model's and Effort's words never go. A
// long Model chip (or any chip) shrinks with an ellipsis instead of
// pushing Send out of the box: Model first, the Permissions chip never.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (name: string): string => readFileSync(new URL(`../src/renderer/styles/${name}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const sheets = (): string => ["tokens.css", "app.css", "changes.css", "away-search.css"].map(css).join("\n");

/** The top-level rules (outside any @ block) for `selector`, joined. */
function rule(text: string, selector: string): string {
  return [...flat(text).matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1]!.split(",").some((part) => part.trim() === selector))
    .map((match) => match[2]!)
    .join(";");
}

function decl(text: string, selector: string, property: string): string | undefined {
  const found = [...rule(text, selector).matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "g"))];
  return found.at(-1)?.[1]?.trim();
}

/** Each `@container <name> (<query>) { … }` block: its query and body. */
function containers(text: string): { name: string; query: string; body: string }[] {
  const out: { name: string; query: string; body: string }[] = [];
  for (const match of text.matchAll(/@container\s+([a-z-]*)\s*\(([^)]*)\)\s*\{/g)) {
    let depth = 1;
    let index = match.index! + match[0].length;
    const start = index;
    while (depth > 0 && index < text.length) {
      if (text[index] === "{") depth += 1;
      if (text[index] === "}") depth -= 1;
      index += 1;
    }
    out.push({ name: match[1]!, query: match[2]!.trim(), body: text.slice(start, index - 1) });
  }
  return out;
}

/** The sheet without its @container blocks (the rules that hold at every width). */
function flat(text: string): string {
  let out = text;
  for (const block of containers(text)) out = out.replace(block.body, "");
  return out;
}

describe("the box's row at narrow widths", () => {
  it("is a size container named cmp-bar", () => {
    const all = sheets();
    expect(decl(all, ".cmp-bar", "container-type")).toBe("inline-size");
    expect(decl(all, ".cmp-bar", "container-name")).toBe("cmp-bar");
  });

  it("below its width the Permissions chip shows only its icon", () => {
    const blocks = containers(sheets()).filter((block) => block.name === "cmp-bar");
    const narrow = blocks.find((block) => /\.chip\.pick\.mode\s+\.ct\s*\{[^}]*display\s*:\s*none/.test(block.body));
    expect(narrow).toBeDefined();
    const width = Number(/max-width:\s*(\d+)px/.exec(narrow!.query)?.[1]);
    expect(width).toBeGreaterThanOrEqual(480);
    expect(width).toBeLessThanOrEqual(760);
    // Its chevron goes with the word; the icon stays.
    expect(narrow!.body).not.toMatch(/\.chip\.pick\.mode\s+svg\s*\{[^}]*display\s*:\s*none/);
  });

  it("Model's and Effort's words never go and their chips never shrink", () => {
    const all = sheets();
    for (const block of containers(all)) {
      expect(block.body).not.toMatch(/\.chip\.pick\.(model|effort)\s+\.ct\s*\{[^}]*display\s*:\s*none/);
      expect(block.body).not.toMatch(/\.chip\.pick\s+\.ct\s*\{[^}]*display\s*:\s*none/);
    }
    expect(all).not.toMatch(/\.chip\.pick\.(model|effort)\s+\.ct\s*\{[^}]*display\s*:\s*none/);
    // The Permissions chip still never shrinks (it has its icon-only width below 620 px).
    expect(decl(all, ".cmp-bar .chip.pick", "flex")).toBe("none");
  });

  it("a long chip shrinks with an ellipsis, Model first, so Send stays in the box", () => {
    const all = sheets();
    const shrink = (selector: string): number => Number(decl(all, selector, "flex")!.split(/\s+/)[1]);
    // The Model chip's weight dwarfs the others': it gives up its width first, down to a few letters and its chevron.
    expect(shrink(".cmp-bar .chip.pick.model")).toBeGreaterThanOrEqual(100);
    expect(decl(all, ".cmp-bar .chip.pick.model", "min-width")).toMatch(/^\d+px$/);
    expect(shrink(".cmp-bar .chip.pick.effort")).toBe(1);
    expect(decl(all, ".cmp-bar .chip", "flex")).toBe("0 1 auto");
    expect(shrink(".cmp-bar .chip.agent")).toBeLessThan(1);
    expect(shrink(".cmp-bar .chip.agent")).toBeGreaterThan(0);
    // Only the button clips (the chip's menu opens above it); its name ends in an ellipsis.
    expect(decl(all, ".cmp-bar .chip.pick .pick-b", "overflow")).toBe("hidden");
    expect(decl(all, ".cmp-bar .chip.pick .pick-b", "min-width")).toBe("0");
    expect(decl(all, ".cmp-bar .chip.pick .pick-b .ct", "min-width")).toBe("0");
    expect(decl(all, ".cmp-bar .chip .ct", "text-overflow")).toBe("ellipsis");
    expect(decl(all, ".cmp-bar .chip.pick", "overflow")).toBeUndefined();
    // The row never wraps and never scrolls sideways; the ring, the paperclip and Send never shrink.
    expect(decl(all, ".cmp-bar", "flex-wrap")).toBe("nowrap");
    expect(decl(all, ".cmp-bar", "overflow")).toBe("visible");
    expect(decl(all, ".cmp-ib", "flex")).toBe("none");
    expect(decl(all, ".send", "flex")).toBe("none");
  });

  it("the mode chip's icon never shrinks either", () => {
    const all = sheets();
    expect(decl(all, ".cmp-bar .chip svg", "flex")).toBe("none");
  });
});

describe("the Permissions menu's look", () => {
  it("each mode's icon beside its word and its description on a muted line under it", () => {
    const all = sheets();
    expect(decl(all, ".chip-menu .ds", "display")).toBe("block");
    expect(decl(all, ".chip-menu .ds", "color")).toBe("var(--ink-4)");
    expect(decl(all, ".chip-menu .mi", "flex")).toBe("none");
  });

  it("is wide enough for each description (capture 95): its width wins over the chip menus' 150 px", () => {
    const all = sheets();
    // `.ctx.chip-menu` sets 150 px after it; the same two classes would lose, so the Permissions menu names three.
    expect(decl(all, ".ctx.chip-menu", "min-width")).toBe("150px");
    expect(decl(all, ".ctx.chip-menu.modes", "min-width")).toBe("280px");
    expect(decl(all, ".ctx.chip-menu.modes", "max-width")).toBe("340px");
  });
});
