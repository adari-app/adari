// A screen header's title and subtitle read as two things
// ("Changes  What each agent changed"), never run together
// ("ChangesWhat each agent changed"). The across-agents Changes screen and the
// away screen put them in `.mh .who` (`.nm` then `.wsn`); the style sheet sets
// them apart in the header's look: the title in ink at 14 px medium, the
// subtitle muted and smaller, a gap between, on one line that ellipsises.

import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChangesOverview } from "../src/renderer/changes/ChangesOverview";

const css = (name: string): string => readFileSync(new URL(`../src/renderer/styles/${name}`, import.meta.url), "utf8");
const sheets = (): string => ["tokens.css", "app.css", "changes.css", "away-search.css"].map(css).join("\n");

/** The declarations of every rule whose selector list names `selector`, joined. */
function rule(text: string, selector: string): string {
  return [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1]!.split(",").some((part) => part.trim() === selector))
    .map((match) => match[2]!)
    .join(";");
}

function decl(text: string, selector: string, property: string): string | undefined {
  const found = [...rule(text, selector).matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "g"))];
  return found.at(-1)?.[1]?.trim();
}

describe("a screen header's title and subtitle", () => {
  it("the Changes screen puts its title and subtitle in two spans of .who", () => {
    const html = renderToStaticMarkup(
      createElement(ChangesOverview, { bridge: { changesOverview: () => Promise.resolve(null), closeChanges: () => undefined }, hosts: [], onOpenAgent: () => undefined, onClose: () => undefined }),
    );
    expect(html).toMatch(/<span class="who"><span class="nm" role="heading" aria-level="1">Changes<\/span><span class="wsn">What each agent changed<\/span><\/span>/);
  });

  it("the style sheet sets them apart on one line: a gap, the subtitle muted and smaller", () => {
    const all = sheets();
    expect(decl(all, ".mh .who", "display")).toBe("flex");
    expect(decl(all, ".mh .who", "align-items")).toBe("baseline");
    const gap = decl(all, ".mh .who", "gap");
    expect(gap).toBeDefined();
    expect(Number.parseFloat(gap!)).toBeGreaterThanOrEqual(6);
    expect(decl(all, ".mh .who", "min-width")).toBe("0");
    expect(decl(all, ".mh .who", "white-space")).toBe("nowrap");
    expect(decl(all, ".mh .who", "font-size")).toBe("14px");
    expect(decl(all, ".mh .wsn", "color")).toBe("var(--ink-3)");
    expect(decl(all, ".mh .wsn", "font-size")).toBe("12.5px");
    expect(decl(all, ".mh .wsn", "text-overflow")).toBe("ellipsis");
  });
});
