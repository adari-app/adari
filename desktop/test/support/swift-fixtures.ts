// The protocol 22 fixtures the desktop app shares with HerdrKit's tests, read
// straight out of the Swift test sources (raw string literals), so the copies
// in desktop/fixtures can be checked against them (test/fixtures-sync.test.ts)
// and regenerated (`HERDR_UPDATE_FIXTURES=1 npx vitest run test/fixtures-sync.test.ts`).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const repoRoot = path.resolve(desktopRoot, "..");
export const fixturesRoot = path.join(desktopRoot, "fixtures");

export interface SwiftFixture {
  /** File under desktop/fixtures. */
  readonly file: string;
  /** Swift source, relative to the repo root. */
  readonly source: string;
  /** Text that precedes the literal in the source (the first raw string after it is taken). */
  readonly anchor: string;
}

export const swiftFixtures: readonly SwiftFixture[] = [
  {
    file: "protocol22/official-agent-list.json",
    source: "Tests/HerdrKitTests/OfficialCompanionTests.swift",
    anchor: "func testOfficialAgentListDecodesWithoutForkFields",
  },
  {
    file: "protocol22/official-session-snapshot.json",
    source: "Tests/HerdrKitTests/OfficialCompanionTests.swift",
    anchor: "func testOfficialSessionSnapshotDecodesWorkspaceTabsAndPlainPanes",
  },
  {
    file: "protocol22/mock-agent-list.json",
    source: "Tests/HerdrKitTests/MockWireFixtureTests.swift",
    anchor: "static let agentList = ",
  },
  {
    file: "protocol22/sidebar-workspaces.json",
    source: "Tests/HerdrKitTests/SidebarFixture.swift",
    anchor: "static let workspacesJSON = ",
  },
  {
    file: "protocol22/sidebar-tabs.json",
    source: "Tests/HerdrKitTests/SidebarFixture.swift",
    anchor: "static let tabsJSON = ",
  },
  {
    file: "protocol22/sidebar-panes.json",
    source: "Tests/HerdrKitTests/SidebarFixture.swift",
    anchor: "static let panesJSON = ",
  },
];

/** Byte-for-byte copies (the replay recordings and the live dialog capture). */
export const copiedFixtures: readonly { readonly file: string; readonly source: string }[] = [
  { file: "replay/idle.hfx", source: "Tests/HerdrCompanionTests/Fixtures/idle.hfx" },
  { file: "replay/idle.expected.json", source: "Tests/HerdrCompanionTests/Fixtures/idle.expected.json" },
  { file: "replay/heavy-excerpt.hfx", source: "Tests/HerdrCompanionTests/Fixtures/heavy-excerpt.hfx" },
  {
    file: "replay/heavy-excerpt.expected.json",
    source: "Tests/HerdrCompanionTests/Fixtures/heavy-excerpt.expected.json",
  },
  {
    file: "replay/claude-2.1.303-bash-dialog.txt",
    source: "Tests/HerdrCompanionTests/Fixtures/Live/claude-2.1.303-bash-dialog.txt",
  },
];

/**
 * The value of the first Swift raw string literal (`#"…"#` or `#"""…"""#`)
 * after `anchor`. Multi-line literals drop the closing delimiter's indentation
 * from every line, as Swift does. Interpolation is refused (none is expected).
 */
export function extractRawString(swift: string, anchor: string): string {
  const at = swift.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  const open = swift.indexOf('#"', at);
  if (open < 0) throw new Error(`no raw string after: ${anchor}`);
  let value: string;
  if (swift.startsWith('#"""', open)) {
    const bodyStart = swift.indexOf("\n", open) + 1;
    const close = swift.indexOf('"""#', bodyStart);
    if (close < 0) throw new Error(`unterminated multi-line literal after: ${anchor}`);
    const lineStart = swift.lastIndexOf("\n", close) + 1;
    const indent = swift.slice(lineStart, close);
    if (!/^[ \t]*$/.test(indent)) throw new Error(`closing delimiter not on its own line after: ${anchor}`);
    const body = swift.slice(bodyStart, lineStart === bodyStart ? bodyStart : lineStart - 1);
    value = body
      .split("\n")
      .map((line) => {
        if (line.startsWith(indent)) return line.slice(indent.length);
        if (line.trim() === "") return "";
        throw new Error(`a line is indented less than the closing delimiter after: ${anchor}`);
      })
      .join("\n");
  } else {
    const close = swift.indexOf('"#', open + 2);
    if (close < 0) throw new Error(`unterminated literal after: ${anchor}`);
    value = swift.slice(open + 2, close);
  }
  if (value.includes("\\#(")) throw new Error(`interpolated literal after: ${anchor}`);
  return value;
}

/** Every single-line raw string literal between two anchors, in source order. */
export function rawStringsBetween(swift: string, from: string, to: string): string[] {
  const start = swift.indexOf(from);
  const end = swift.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`region not found: ${from} .. ${to}`);
  const region = swift.slice(start, end);
  const values: string[] = [];
  let at = region.indexOf('#"');
  while (at >= 0) {
    if (region.startsWith('#"""', at)) throw new Error("multi-line literal in region");
    const close = region.indexOf('"#', at + 2);
    if (close < 0) throw new Error("unterminated literal in region");
    values.push(region.slice(at + 2, close));
    at = region.indexOf('#"', close + 2);
  }
  return values;
}

/**
 * Whether a file outside desktop/ is in this tree. The public copy holds the
 * Mac app only, so a test that compares against an iPhone source runs only
 * when that source is here.
 */
export function hasRepoFile(relative: string): boolean {
  return existsSync(path.join(repoRoot, relative));
}

export function readRepoFile(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

export function readSwiftFixture(fixture: SwiftFixture): string {
  return extractRawString(readFileSync(path.join(repoRoot, fixture.source), "utf8"), fixture.anchor);
}

export function readFixture(file: string): string {
  return readFileSync(path.join(fixturesRoot, file), "utf8");
}
