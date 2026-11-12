// The Changes view's diffs (the twin of the iPhone app's CompanionDiffParserTests
// and CompanionDiffViewHostedTests). git's unified
// text (a file's staged and unstaged parts, an untracked file, a commit) and an
// agent's own edits become rows: files, hunk headers, context, added and
// removed lines with the new side's numbers, "\ No newline at end of file", and
// what is not shown (binary, past a bound). Copy copies the text as read. The
// view draws only the rows in sight (a 2,000-line diff stays light), scrolls
// down and, as wide as its widest line, sideways; it never wraps.

import { afterEach, describe, expect, it, vi } from "vitest";

import { diffLine, type ChatDiffLine } from "../src/shared/chat/model";
import {
  binaryNotice,
  cutNotice,
  diffColumns,
  diffLayout,
  displayCharacters,
  documentFromEdits,
  documentFromGit,
  documentFromText,
  editMoreNotice,
  editTitle,
  moreRowsNotice,
  rowAccessibilityText,
  rowSign,
  visibleRows,
  type DiffDocument,
  type DiffRow,
  type DiffRowKind,
} from "../src/shared/changes/diff";
import type { AgentEdit } from "../src/shared/changes/tools";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { DiffLines, DiffView } = await import("../src/renderer/changes/DiffView");

const row = (document: DiffDocument, kind: DiffRowKind, text: string): DiffRow | undefined => document.rows.find((r) => r.kind === kind && r.text === text);

describe("the diff, parsed", () => {
  it("reads a hunk with the new side's numbers and no newline at the end", () => {
    const text = [
      "diff --git a/src/app.swift b/src/app.swift",
      "index 1111111..2222222 100644",
      "--- a/src/app.swift",
      "+++ b/src/app.swift",
      "@@ -10,3 +10,4 @@ struct App {",
      " let a = 1",
      "-let b = 2",
      "+let b = 3",
      "+let c = 4",
      " let d = 5",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const document = documentFromText(text);
    expect(document.rows.map((r) => r.kind)).toEqual(["file", "hunk", "context", "removed", "added", "added", "context", "noNewline"]);
    expect(document.rows.map((r) => r.text)).toEqual([
      "src/app.swift",
      "@@ -10,3 +10,4 @@ struct App {",
      "let a = 1",
      "let b = 2",
      "let b = 3",
      "let c = 4",
      "let d = 5",
      "\\ No newline at end of file",
    ]);
    expect(document.rows.map((r) => r.number)).toEqual([null, null, 10, null, 11, 12, 13, null]);
    expect(document.rows.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(document.added).toBe(2);
    expect(document.removed).toBe(1);
    expect(document.files.map((f) => f.name)).toEqual(["src/app.swift"]);
    expect(document.copyText, "Copy copies the text as read").toBe(text);
    expect(document.files[0]?.copyText).toBe(text);
    expect(document.binary).toBe(false);
    expect(document.cut).toBe(false);
    expect(document.largestNumber).toBe(13);
    expect(document.rows.map(rowSign)).toEqual(["", "", " ", "-", "+", "+", " ", ""]);
  });

  it("lets the hunk's counts decide what a line is", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      "--- old rule",
      "+++ new rule",
      "",
      " last",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -5 +5 @@",
      "-x",
      "+y",
    ].join("\n");
    const document = documentFromText(text);
    expect(document.rows.map((r) => r.kind)).toEqual(["file", "hunk", "removed", "added", "context", "context", "file", "hunk", "removed", "added"]);
    expect(document.rows[2]!.text).toBe("-- old rule");
    expect(document.rows[3]!.text).toBe("++ new rule");
    expect(document.rows[4]!.text).toBe("");
    expect(document.rows.map((r) => r.number)).toEqual([null, null, null, 1, 2, 3, null, null, null, 5]);
    expect(document.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(document.files.map((f) => f.row)).toEqual([0, 6]);
    expect(document.rows[0]!.file).toBe(0);
    expect(document.rows[6]!.file).toBe(1);
    expect(document.files[1]!.copyText.startsWith("diff --git a/b.txt b/b.txt\n")).toBe(true);
    expect(document.files[1]!.copyText.endsWith("+y\n")).toBe(true);
    expect(document.files[0]!.copyText.includes("b.txt")).toBe(false);
  });

  it("reads new, renamed, deleted and binary files", () => {
    const text = [
      "diff --git a/sp ace.txt b/sp ace.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "--- /dev/null",
      "+++ b/sp ace.txt\t",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/old.txt b/new.txt",
      "similarity index 90%",
      "rename from old.txt",
      "rename to new.txt",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 3333333..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/img.png b/img.png",
      "index 4444444..5555555 100644",
      "Binary files a/img.png and b/img.png differ",
      'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    const document = documentFromText(text);
    expect(document.files.map((f) => f.name)).toEqual(["sp ace.txt", "old.txt → new.txt", "gone.txt", "img.png", "tab\there.txt"]);
    expect(row(document, "meta", "new file mode 100644")).toBeDefined();
    expect(row(document, "added", "hello")?.number).toBe(1);
    expect(row(document, "meta", "rename from old.txt")).toBeDefined();
    expect(row(document, "meta", "deleted file mode 100644")).toBeDefined();
    expect(row(document, "removed", "bye")?.number).toBeNull();
    expect(row(document, "notice", binaryNotice)).toBeDefined();
    expect(row(document, "meta", "new mode 100755")).toBeDefined();
    expect(document.binary).toBe(true);
    expect(
      document.rows.some((r) => r.text.startsWith("index ") || r.text.startsWith("--- ") || r.text.startsWith("+++ ")),
      "the names show in the file rows",
    ).toBe(false);
  });

  it("reads a commit with its stat, then its diff", () => {
    const hash = "ab".repeat(20);
    const text = [
      `commit ${hash}`,
      "Author: Fixture <fixture@example.invalid>",
      "Date:   2026-11-02 10:00:00 +0000",
      "",
      "    Fix the pairing test",
      "",
      "    --- not a header",
      "---",
      " src/a.swift | 2 +-",
      " 1 file changed, 1 insertion(+), 1 deletion(-)",
      "",
      "diff --git a/src/a.swift b/src/a.swift",
      "index 1111111..2222222 100644",
      "--- a/src/a.swift",
      "+++ b/src/a.swift",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const document = documentFromGit({ parts: [{ title: "", text }], cut: false }, 524_288);
    expect(document.rows[0]?.kind).toBe("meta");
    expect(document.rows[0]?.text).toBe(`commit ${hash}`);
    expect(row(document, "meta", "    Fix the pairing test")).toBeDefined();
    expect(row(document, "meta", "    --- not a header")).toBeDefined();
    expect(row(document, "meta", " src/a.swift | 2 +-")).toBeDefined();
    expect(row(document, "meta", "---")).toBeDefined();
    expect(document.files.map((f) => f.name)).toEqual(["src/a.swift"]);
    expect(document.rows.filter((r) => r.kind === "section").length, "one untitled part: no section row").toBe(0);
    expect(row(document, "added", "new")?.number).toBe(1);
    expect(document.added).toBe(1);
    expect(document.removed).toBe(1);
    expect(document.copyText).toBe(text);
  });

  it("titles a file's parts, copies both, and ends a cut read with its bound", () => {
    const staged = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1,2 @@\n one\n+two\n";
    const unstaged = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,3 @@\n one\n two\n+thr";
    const document = documentFromGit(
      {
        parts: [
          { title: "Staged", text: staged },
          { title: "Not staged", text: unstaged },
        ],
        cut: true,
      },
      262_144,
    );
    expect(document.rows.filter((r) => r.kind === "section").map((r) => r.text)).toEqual(["Staged", "Not staged"]);
    expect(document.rows[0]?.kind).toBe("section");
    expect(document.files.length).toBe(2);
    expect(document.files.map((f) => f.copyText)).toEqual([staged, unstaged + "\n"]);
    expect(document.cut).toBe(true);
    expect(document.rows[document.rows.length - 1]?.kind).toBe("notice");
    expect(document.rows[document.rows.length - 1]?.text).toBe(cutNotice(262_144));
    expect(cutNotice(262_144)).toContain("256 KB");
    expect(document.copyText).toBe("# Staged\n" + staged + "\n# Not staged\n" + unstaged);
    expect(document.added).toBe(2);
    expect(row(document, "added", "thr")?.number).toBe(3);
  });

  it("bounds long lines and many lines where they are drawn", () => {
    const long = "x".repeat(5_000);
    const text = `@@ -1 +1,2 @@\n-a\tb\u001b[0m\r\n+${long}\n+ok\n`;
    const document = documentFromText(text);
    const added = document.rows.filter((r) => r.kind === "added");
    expect(Array.from(added[0]!.text).length).toBe(displayCharacters + 1);
    expect(added[0]!.text.endsWith("…")).toBe(true);
    expect(added[0]!.cut).toBe(true);
    expect(added[added.length - 1]!.cut).toBe(false);
    expect(document.rows.find((r) => r.kind === "removed")?.text).toBe("a    b�[0m");
    expect(document.copyText.includes(long)).toBe(true);
    expect(document.columns).toBe(displayCharacters + 1);

    const many = "@@ -0,0 +1,300 @@\n" + Array.from({ length: 300 }, (_, i) => `+line ${i + 1}`).join("\n") + "\n";
    const capped = documentFromText(many, 100);
    expect(capped.rows.length).toBe(101);
    expect(capped.rows[capped.rows.length - 1]?.kind).toBe("notice");
    expect(capped.rows[capped.rows.length - 1]?.text).toBe(moreRowsNotice(201));
    expect(capped.added, "the counts are of every line").toBe(300);
    expect(capped.copyText).toBe(many);
  });

  it("counts wide characters as two columns and marks as none", () => {
    expect(diffColumns("abc")).toBe(3);
    expect(diffColumns("日本")).toBe(4);
    expect(diffColumns("é")).toBe(1);
    expect(diffColumns("🙂x")).toBe(3);
  });

  const time = 1_793_570_000;
  const edit = (callId: string, tool: string, turn: number, message: string, minutes: number, lines: ChatDiffLine[], more = 0): AgentEdit => ({
    callId,
    tool,
    path: "/Users/fixture/proj/src/a.swift",
    turnId: `t${turn}`,
    turnNumber: turn,
    turnMessage: message,
    time: time + minutes * 60,
    added: lines.filter((l) => l.kind === "added").length,
    removed: lines.filter((l) => l.kind === "removed").length,
    lines,
    moreLines: more,
  });

  it("shows an agent's edits of a file under their turns, a Write numbered from 1", () => {
    const edits = [
      edit("c1", "Write", 1, "make the file", 0, [diffLine("added", "one"), diffLine("added", "two")]),
      edit("c2", "Edit", 2, "fix two", 5, [diffLine("context", "one"), diffLine("removed", "two"), diffLine("added", "2")], 7),
    ];
    const document = documentFromEdits(edits, "UTC");
    expect(document.rows.map((r) => r.kind)).toEqual(["hunk", "added", "added", "hunk", "context", "removed", "added", "notice"]);
    expect(document.rows[0]!.text).toBe(editTitle(edits[0]!, "UTC"));
    expect(document.rows[0]!.text.startsWith("Turn 1 · Write · ")).toBe(true);
    expect(document.rows[0]!.text, "21:53 UTC in the locale's clock").toMatch(/ (21:53|9:53\s?PM) /);
    expect(document.rows[3]!.text.endsWith("“fix two”")).toBe(true);
    expect(document.rows.map((r) => r.number)).toEqual([null, 1, 2, null, null, null, null, null]);
    expect(document.rows[7]!.text).toBe(editMoreNotice(7));
    expect(document.added).toBe(3);
    expect(document.removed).toBe(1);
    expect(document.copyText).toBe(
      `# ${document.rows[0]!.text}\n+one\n+two\n\n# ${document.rows[3]!.text}\n one\n-two\n+2\n# ${editMoreNotice(7)}\n`,
    );
  });

  it("names each line's kind first for VoiceOver", () => {
    const document = documentFromText("@@ -3,2 +3,2 @@\n keep\n-gone\n+here\n\\ No newline at end of file\n");
    expect(document.rows.map(rowAccessibilityText)).toEqual([
      "hunk @@ -3,2 +3,2 @@",
      "line 3, keep",
      "removed line, gone",
      "added line 4, here",
      "no newline at end of file",
    ]);
  });

  it("has nothing to show for no parts and no edits", () => {
    expect(documentFromGit({ parts: [], cut: false }, 262_144).rows).toEqual([]);
    expect(documentFromEdits([]).rows).toEqual([]);
  });
});

function longDiff(lines = 2_000, longLine = true): string {
  let text = `diff --git a/big.swift b/big.swift\n--- a/big.swift\n+++ b/big.swift\n@@ -1,${lines} +1,${lines} @@\n`;
  for (let number = 1; number <= lines; number += 1) {
    if (number % 4 === 0) text += `-let removed${number} = ${number}\n`;
    else if (number % 4 === 1) text += `+let added${number} = ${number}\n`;
    else text += ` let context${number} = ${number}\n`;
  }
  if (longLine) text += "+" + "wide ".repeat(120) + "\n";
  return text;
}

describe("the diff, drawn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lays rows out at fixed heights and finds the ones in sight", () => {
    const document = documentFromText(longDiff());
    const layout = diffLayout(document);
    expect(layout.offsets.length).toBe(document.rows.length);
    expect(layout.offsets[0]).toBe(0);
    expect(layout.offsets[1]).toBe(layout.heights.file);
    expect(layout.total).toBe(layout.heights.file + (document.rows.length - 1) * layout.heights.line);
    const top = visibleRows(layout, 0, 600, 10);
    expect(top.start).toBe(0);
    expect(top.end).toBeLessThan(60);
    const middle = visibleRows(layout, 20_000, 600, 10);
    expect(middle.start).toBeGreaterThan(900);
    expect(middle.end - middle.start).toBeLessThan(60);
    const bottom = visibleRows(layout, layout.total, 600, 10);
    expect(bottom.end).toBe(document.rows.length);
  });

  it("draws a 2,000-line diff's rows in sight only, scrolls down and sideways", () => {
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      disconnect(): void {}
    });
    const document = documentFromText(longDiff());
    const host = new HookHost(DiffLines, { document, copy: () => undefined });
    let tree = host.render();
    const drawn = (): string[] => elements(tree).filter((e) => e.props["data-row"] !== undefined).map((e) => String(e.props["data-row"]));
    expect(drawn().length).toBeGreaterThan(10);
    expect(drawn().length).toBeLessThan(100);
    expect(drawn()[0]).toBe("0");
    const content = elements(tree).find((e) => e.props["className"] === "diff-content")!;
    const style = content.props["style"] as Record<string, string | number>;
    expect(style.height).toBe(diffLayout(document).total);
    expect(String(style.width), "as wide as the widest line, in columns").toContain(`${document.columns + 1}ch`);
    expect(document.columns, "the long line's 600 columns").toBe(600);
    const scroller = elements(tree).find((e) => e.props["className"] === "diff-scroll")!;
    (scroller.props["onScroll"] as (event: unknown) => void)({ currentTarget: { scrollTop: 20_000, clientHeight: 600 } });
    tree = host.tree;
    const rows = drawn().map(Number);
    expect(rows[0]).toBeGreaterThan(900);
    expect(rows.length).toBeLessThan(100);
    const lines = elements(tree).filter((e) => e.props["data-row"] !== undefined);
    expect(lines.every((e) => e.props["aria-label"] !== undefined)).toBe(true);
  });

  it("shows the counts, the files and Copy above, and nothing to show for an empty diff", () => {
    const copied: string[] = [];
    const document = documentFromText("diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b b/b\n@@ -1 +1 @@\n-c\n+d\n");
    const host = new HookHost(DiffView, { document, copy: (text: string) => copied.push(text) });
    const tree = host.render();
    const text = elements(tree)
      .flatMap((e) => (typeof e.props.children === "string" ? [e.props.children] : Array.isArray(e.props.children) ? e.props.children.filter((c) => typeof c === "string") : []))
      .join(" ");
    expect(text).toContain("+2");
    expect(text).toContain("−2");
    expect(text).toContain("2 files");
    const copy = elements(tree).find((e) => e.props["aria-label"] === "Copy the diff")!;
    (copy.props["onClick"] as () => void)();
    expect(copied).toEqual([document.copyText]);

    const empty = new HookHost(DiffView, { document: documentFromText(""), copy: () => undefined }).render();
    expect(JSON.stringify(elements(empty).map((e) => e.props.children))).toContain("Nothing to show for this file.");
  });
});
