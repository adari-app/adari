// The context ring while its pane compacts stays one ring. Chat's spinner rule
// `.spin` (chat.css, loaded after app.css and as heavy as `.cmp-ib`) must not
// land on the ring's button while Compact runs: the 32 pt button would become
// an 11 pt bordered circle turning on its own, its 16 pt ring spilling out of
// it down and to the right, drawn as two rings that do not line up (a grey one
// up and to the left, the blue fill down and to the right). While it compacts,
// only the composer button's rules and the ring's own land on its button, and
// only its svg turns, about its own centre.

import { readdirSync, readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { decodeSessionTopology } = await import("../src/main/herdr/wire");
const { HookHost, elements } = await import("./support/fake-hooks");
const { ContextRing } = await import("../src/renderer/components/ContextRing");
const { agentPicks, pickContext } = await import("../src/renderer/components/agent-picks");
type HostView = import("../src/shared/ipc-contract").HostView;
type SidebarRow = import("../src/shared/sidebar-model").SidebarRow;
type Node = { type: unknown; props: Record<string, unknown> };

function claudeHost(): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }],
  });
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology, run: { connection: 3, arrivals: { "w1:p1": 2 } } } as unknown as HostView;
}

const row = { paneID: "w1:p1", name: "design", workspaceLabel: "workers", kind: "claude", isAgent: true, status: "idle" } as unknown as SidebarRow;

/** The ring as it is drawn now: its button (classes, attributes), its svg and the svg's two circles. */
function drawn(host: HostView) {
  const ui = new HookHost(ContextRing as (props: object) => unknown, { host, row });
  ui.render();
  const all = elements(ui.tree) as Node[];
  ui.unmount();
  const button = all.find((e) => e.type === "button" && String(e.props["className"] ?? "").includes("ctx-ring"))!;
  const attributes = new Map<string, string>();
  for (const [name, value] of Object.entries(button.props)) {
    if (typeof value === "string" || typeof value === "boolean") attributes.set(name === "className" ? "class" : name, String(value));
  }
  return {
    classes: String(button.props["className"]).split(/\s+/u).filter((name) => name !== ""),
    attributes,
    svg: all.find((e) => e.type === "svg")!,
    circles: all.filter((e) => e.type === "circle"),
  };
}

interface Rule {
  readonly sheet: string;
  readonly selector: string;
  readonly body: string;
}

/** `text` split at `by` outside brackets and parentheses. */
function splitTop(text: string, by: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < text.length; at += 1) {
    const c = text[at]!;
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === by && depth === 0) {
      parts.push(text.slice(from, at));
      from = at + 1;
    }
  }
  return [...parts, text.slice(from)];
}

/** A sheet's style rules, one per selector, those inside @media, @container and @supports too (not @keyframes or @font-face). */
function rulesOf(sheet: string, text: string): Rule[] {
  const rules: Rule[] = [];
  let at = 0;
  for (let open = text.indexOf("{", at); open >= 0; open = text.indexOf("{", at)) {
    const before = text.slice(at, open);
    const prelude = before.slice(before.lastIndexOf(";") + 1).trim();
    let close = open;
    for (let depth = 0; close < text.length; close += 1) {
      if (text[close] === "{") depth += 1;
      else if (text[close] === "}" && --depth === 0) break;
    }
    const body = text.slice(open + 1, close);
    if (/^@(media|container|supports|layer)\b/u.test(prelude)) rules.push(...rulesOf(sheet, body));
    else if (!prelude.startsWith("@")) for (const selector of splitTop(prelude, ",")) rules.push({ sheet, selector: selector.trim(), body });
    at = close + 1;
  }
  return rules;
}

/** Every style rule of the renderer's sheets (src/renderer/styles: main.tsx loads them all, RunningStrip.tsx running-strip.css). */
function styleRules(): Rule[] {
  const folder = new URL("../src/renderer/styles/", import.meta.url);
  return readdirSync(folder)
    .filter((name) => name.endsWith(".css"))
    .flatMap((sheet) => rulesOf(sheet, readFileSync(new URL(sheet, folder), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "")));
}

/** The selector's last compound, the element it styles (what follows its last combinator outside brackets). */
function subject(selector: string): string {
  let depth = 0;
  let from = 0;
  for (let at = 0; at < selector.length; at += 1) {
    const c = selector[at]!;
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && /[\s>+~]/u.test(c)) from = at + 1;
  }
  return selector.slice(from);
}

const partsOf = (compound: string): string[] => compound.match(/::?[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?|\.[\w-]+|#[\w-]+|\[[^\]]*\]|\*|[\w-]+/gu) ?? [];
const classesOf = (compound: string): string[] => partsOf(compound).filter((part) => part.startsWith(".")).map((part) => part.slice(1));

/**
 * Whether a compound can land on the ring's button: a button (or any element) with all its classes, its attributes
 * as drawn, in any state (hover, focus, its ::before and ::after too). Its ancestors are taken to match.
 */
function landsOn(compound: string, button: ReturnType<typeof drawn>): boolean {
  return partsOf(compound).every((part) => {
    if (part.startsWith("::")) return true;
    if (part.startsWith(":")) return part !== ":disabled";
    if (part.startsWith(".")) return button.classes.includes(part.slice(1));
    if (part.startsWith("#")) return false;
    if (part.startsWith("[")) {
      const match = /^\[\s*([\w-]+)\s*(?:(\W?=)\s*["']?([^"'\]]*)["']?\s*)?\]$/u.exec(part);
      if (match === null) return true;
      const value = button.attributes.get(match[1]!);
      if (value === undefined) return false;
      return match[2] !== "=" || value === match[3];
    }
    return part === "*" || part === "button";
  });
}

const key = "mac-mini/w1:p1";

describe("the context ring while its pane compacts", () => {
  beforeEach(() => {
    agentPicks.clear();
    vi.stubGlobal("window", { herdrDesktop: { sendToPane: async () => undefined, copyText: () => undefined } });
  });

  it("only the composer button's rules and the ring's own land on its button (never Chat's spinner `.spin`)", () => {
    const host = claudeHost();
    const resting = drawn(host);
    const context = pickContext(host, "w1:p1")!;
    agentPicks.pick(context, { kind: "compact", value: "compact", label: "Compact" });
    expect(agentPicks.compacting(key, context.binding)).toBe("running");
    const compacting = drawn(host);
    // One class of its own says it compacts (the svg under it turns).
    expect(compacting.classes.filter((name) => !resting.classes.includes(name))).toHaveLength(1);
    const landing = styleRules().filter((rule) => classesOf(subject(rule.selector)).length > 0 && landsOn(subject(rule.selector), compacting));
    expect(landing.length).toBeGreaterThan(0);
    const strangers = landing.filter((rule) => !classesOf(subject(rule.selector)).some((name) => name === "cmp-ib" || name === "ctx-ring"));
    expect(strangers.map((rule) => `${rule.sheet}: ${rule.selector}`)).toEqual([]);
  });

  it("only its svg turns, about its own centre: one 16 pt box, the track and the fill on its centre, nothing moving the origin", () => {
    const host = claudeHost();
    const resting = drawn(host);
    const context = pickContext(host, "w1:p1")!;
    agentPicks.pick(context, { kind: "compact", value: "compact", label: "Compact" });
    const compacting = drawn(host);
    const state = compacting.classes.find((name) => !resting.classes.includes(name))!;
    const rules = styleRules();
    // The one turning rule is the ring's own, on its svg, a pure turn.
    const turning = rules.filter((rule) => /(^|;)\s*animation(-name)?\s*:/u.test(rule.body) && rule.selector.includes("ctx-ring"));
    expect(turning.map((rule) => rule.selector)).toEqual([`.cmp-ib.ctx-ring.${state} svg`]);
    const name = /animation(?:-name)?\s*:\s*([\w-]+)/u.exec(turning[0]!.body)![1]!;
    const sheets = readdirSync(new URL("../src/renderer/styles/", import.meta.url)).map((sheet) => readFileSync(new URL(`../src/renderer/styles/${sheet}`, import.meta.url), "utf8")).join("\n");
    expect(new RegExp(`@keyframes ${name} \\{ to \\{ transform: rotate\\(360deg\\); \\} \\}`, "u").test(sheets)).toBe(true);
    // Its box and centre: 16 by 16 on a 16 by 16 view box, both circles at (8, 8), the fill started at the top about that centre.
    expect([compacting.svg.props["width"], compacting.svg.props["height"], compacting.svg.props["viewBox"]]).toEqual(["16", "16", "0 0 16 16"]);
    expect(compacting.circles.map((circle) => [circle.props["className"], circle.props["cx"], circle.props["cy"]])).toEqual([
      ["trk", "8", "8"],
      ["fill", "8", "8"],
    ]);
    expect(compacting.circles[1]!.props["transform"]).toBe("rotate(-90 8 8)");
    // Nothing sets a transform origin or box anywhere (an outer svg turns about its box's centre).
    expect(rules.filter((rule) => /transform-(origin|box)\s*:/u.test(rule.body)).map((rule) => rule.selector)).toEqual([]);
  });
});
