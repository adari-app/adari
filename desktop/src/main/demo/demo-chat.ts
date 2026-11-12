// Demo mode's Chat: hand-written transcripts (invented content in Claude Code's
// and Codex's line shapes, never a real transcript) for some demo panes, served
// from memory by a reader the real ChatFeed follows, so the demo runs the same
// parse, follow and Load earlier path a machine does. Times are relative to the
// demo's start. A message sent from the demo composer is written into the
// pane's transcript a moment later (a queued_command while the agent works, a
// user line otherwise), as Claude Code would. The split tab's two agents have
// live transcripts: a step written every demoLiveStepMs from the first read,
// so their Chats follow live output.

import { TranscriptNotFoundError, type TranscriptFileReader } from "../../shared/chat/feed";
import { cursorFolderHash, cursorMetaPath } from "../../shared/chat/cursor-store";
import { grokFolderName, grokSummaryPath, type TranscriptSessionRef } from "../../shared/chat/locator";
import { demoGrokCommand, demoGrokTitle } from "./demo-prompts";
import { runningTranscripts } from "./demo-running";
import type { DemoRunningCall } from "./demo-tall";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A screenshot-like picture (168×112 PNG) the demo's first message carries. */
export const demoShotBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAKgAAABwCAIAAAAFRKyhAAABLElEQVR42u3csQmDQBiGYUcQa0klzuEYcoOIQ9glWLiQaziCI6SORUgIeObugXeCe4rvt7FomlYZVngC8AIv8MoFfg/dIc8EXuAFXo47gRd4gRd4RYQvy0oZBh68wAu8wAu8wCtF+Hl+6MPAgwcPHjx4x53AC7zAC7zA6zz4EHpFDzx48OBtvMALvMALvFz16V7s4MGDB2/jBR68wAu8wAu8wAu8UoKv65v+NPDgwYMHDx48ePDg38NP63LZkIMHDx68jQcPHjx48ODBgwf/2naf9FXgwYMHb+MFXuAFXuAVD34ch0wCDx48eBsv8AIv8AIv8AIv8AIv8AIv8AIv8AIP3g8OBV7gwQu8wAu8fm8P3cmBBw8ePHjwVMALvHzOCbzAC7zAC7zA63I9AetU5YrVwszOAAAAAElFTkSuQmCC";

export const demoShotPath =
  "/Users/demo/.herdr-companion-attachments-5d1e0c7a9b2f4e6d8c3a1b0f9e8d7c6b/attachment-6f1c2d3e-4b5a-4968-8776-a5b4c3d2e1f0.png";

/** One demo pane's transcript. */
export interface DemoTranscript {
  readonly paneID: string;
  readonly agent: "claude" | "codex" | "grok" | "cursor";
  readonly sessionID: string;
  readonly path: string;
  readonly cwd: string;
  readonly working: boolean;
  readonly lines: readonly string[];
  /** A transcript that keeps growing while its agent works (the demo's split tab). */
  readonly live?: DemoLive;
  /** Files beside it on the demo machine (a subagent's transcript and meta.json), by path. */
  readonly files?: { readonly [path: string]: string };
}

/** How often a live demo transcript takes its next step. */
export const demoLiveStepMs = 1_400;

/** After a long gap (the Mac asleep) a live transcript writes at most this many steps at once. */
const liveCatchUp = 20;

/**
 * A live transcript's steps: one line each, written `everyMs` apart from the
 * first time the transcript is read (so a test's clock, or the demo's, drives it).
 */
export interface DemoLive {
  readonly everyMs: number;
  /** The lines of step `index` (from 0), stamped `atMs`. */
  step(index: number, atMs: number): string[];
}

/** JSON with sorted keys (the fixtures' house style). */
export function json(value: Json): string {
  const sort = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const out: { [key: string]: Json } = {};
      for (const key of Object.keys(v).sort()) out[key] = sort(v[key]!);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Writes Claude Code lines for one session; `second` is seconds after `base`. */
export class ClaudeLines {
  private serial = 0;
  readonly lines: string[] = [];

  constructor(
    private readonly sessionID: string,
    private readonly cwd: string,
    private readonly baseMs: number,
    /** Each line's uuid starts with this (a live step's own, so none repeats). */
    private readonly uuidPrefix = `demo-${sessionID.slice(0, 8)}`,
  ) {}

  stamp(second: number): string {
    return new Date(this.baseMs + second * 1_000).toISOString();
  }

  private uuid(): string {
    this.serial += 1;
    return `${this.uuidPrefix}-${String(this.serial).padStart(4, "0")}`;
  }

  private base(type: string, second: number): { [key: string]: Json } {
    return {
      cwd: this.cwd,
      isSidechain: false,
      sessionId: this.sessionID,
      timestamp: this.stamp(second),
      type,
      uuid: this.uuid(),
      version: "2.1.316",
    };
  }

  user(content: Json, second: number): this {
    this.lines.push(json({ ...this.base("user", second), message: { content, role: "user" }, userType: "external" }));
    return this;
  }

  queued(prompt: string, second: number): this {
    this.lines.push(json({ ...this.base("attachment", second), attachment: { prompt, type: "queued_command" } }));
    return this;
  }

  private assistant(content: Json[], second: number, stop: string | null, extra: { [key: string]: Json } = {}): void {
    const base = this.base("assistant", second);
    this.lines.push(
      json({
        ...base,
        // Claude Code writes the session's effort on every assistant line (the Effort chip: Extra high).
        effort: "xhigh",
        ...extra,
        // A usage as Claude Code writes it, for the context ring (its count grows with the turn).
        message: {
          content,
          id: "msg_" + String(base["uuid"]),
          model: "claude-opus-5-5",
          role: "assistant",
          stop_reason: stop,
          type: "message",
          usage: { input_tokens: 6, cache_creation_input_tokens: 1_840, cache_read_input_tokens: 196_000 + Math.min(second, 400) * 40, output_tokens: 412 },
        },
      }),
    );
  }

  tool(id: string, name: string, input: { [key: string]: Json }, second: number): this {
    this.assistant([{ id, input, name, type: "tool_use" }], second, "tool_use");
    return this;
  }

  result(id: string, output: string, second: number, error = false): this {
    this.lines.push(
      json({ ...this.base("user", second), message: { content: [{ content: output, is_error: error, tool_use_id: id, type: "tool_result" }], role: "user" } }),
    );
    return this;
  }

  text(markdown: string, second: number, ends = false): this {
    this.assistant([{ text: markdown, type: "text" }], second, ends ? "end_turn" : null);
    return this;
  }

  progress(text: string, second: number): this {
    this.assistant([{ signature: "demo", thinking: text, type: "thinking" }], second, null, { thinkingDisplay: "updates" });
    return this;
  }
}

const macBuildCwd = "/Users/demo/code/worktrees/aurora-web-mac";

/** Mac mini's Mac-build worker pane: a finished turn, then one running. */
function macBuild(startMs: number): DemoTranscript {
  const sessionID = "7a3f0c2e-5b1d-4e6b-9c0d-6d656d6f0001";
  const t = new ClaudeLines(sessionID, macBuildCwd, startMs - 31 * 60_000);
  t.user(
    [
      {
        text:
          "Work through the plan in /Users/demo/code/notes/aurora-web-mac.md and follow it exactly. " +
          demoShotPath,
        type: "text",
      },
    ],
    0,
  )
    .tool("toolu_demo_01", "Read", { file_path: "/Users/demo/code/notes/aurora-web-mac.md" }, 3)
    .result("toolu_demo_01", Array.from({ length: 74 }, (_, i) => `${String(i + 1).padStart(6)}→line ${i + 1}`).join("\n"), 4)
    .text(
      "The plan makes **Designed for iPad** permanent and fixes Mac input: trackpad scrolling, Return to send, the touch key row hidden, and the ⌘ shortcuts. Starting with scrolling.",
      9,
    )
    .tool("toolu_demo_02", "Grep", { path: "App/Terminal", pattern: "allowedScrollTypesMask" }, 12)
    .result("toolu_demo_02", "Found 4 files\nApp/Terminal/CompanionTerminalView.swift\nApp/Terminal/TerminalScroll.swift\nApp/Terminal/TerminalInput.swift\nApp/Terminal/TerminalKeys.swift", 13)
    .tool(
      "toolu_demo_03",
      "Edit",
      {
        file_path: "/Users/demo/code/worktrees/aurora-web-mac/App/Terminal/CompanionTerminalView.swift",
        new_string: "pan.allowedScrollTypesMask = .all\npan.maximumNumberOfTouches = 2",
        old_string: "pan.allowedScrollTypesMask = []",
      },
      24,
    )
    .result("toolu_demo_03", "The file has been updated.", 25)
    .tool("toolu_demo_04", "Bash", { command: "swift test --force-resolved-versions --filter CompanionTerminalScrollTests", description: "Run the scroll tests" }, 31)
    .result(
      "toolu_demo_04",
      "Test Suite 'CompanionTerminalScrollTests' passed at 2026-11-01 02:41:07.311.\nExecuted 6 tests, with 0 failures (0 unexpected) in 0.208 seconds",
      58,
    )
    .text(
      [
        "Scrolling works with two fingers and the mouse wheel. The change in `CompanionTerminalView.swift`:",
        "",
        "```swift",
        "let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))",
        "pan.allowedScrollTypesMask = .all      // trackpad and mouse wheel, not only touches",
        "pan.maximumNumberOfTouches = 2",
        "addGestureRecognizer(pan)",
        "```",
        "",
        "Next: Return sends, Shift-Return makes a new line.",
      ].join("\n"),
      68,
      true,
    )
    // The running turn, started a little over two minutes ago.
    .user("Now make Return send and Shift-Return a new line, on the iPad keyboard too.", 28 * 60 + 50)
    .tool("toolu_demo_05", "Bash", { command: "rg -n 'keyCommands|UIKeyCommand' App" }, 28 * 60 + 54)
    .result("toolu_demo_05", "App/CompanionChatComposer.swift:41:    override var keyCommands: [UIKeyCommand]? {\nApp/CompanionKeys.swift:12:let returnKey = UIKeyCommand(", 28 * 60 + 55)
    .progress("I'm checking how the composer handles Return before changing it: the key command wins over the text view's own newline.", 29 * 60 + 2)
    .tool("toolu_demo_06", "Read", { file_path: "/Users/demo/code/worktrees/aurora-web-mac/App/CompanionChatComposer.swift" }, 29 * 60 + 6)
    .result("toolu_demo_06", Array.from({ length: 277 }, (_, i) => `${String(i + 1).padStart(6)}→line ${i + 1}`).join("\n"), 29 * 60 + 7)
    .queued("also check the iPad layout with the keyboard attached", 29 * 60 + 20)
    .tool("toolu_demo_07", "Bash", { command: "swift test --force-resolved-versions --filter ComposerReturnTests", description: "Run the Return tests" }, 29 * 60 + 41);
  return {
    paneID: "w7:p1G",
    agent: "claude",
    sessionID,
    path: `/Users/demo/.claude/projects/-Users-demo-code-worktrees-aurora-web-mac/${sessionID}.jsonl`,
    cwd: macBuildCwd,
    working: true,
    lines: t.lines,
  };
}

const designCwd = "/Users/demo/code/worktrees/aurora-web-design";

/** Mac mini's design pane (done): one finished turn with a table and a failed command kept open. */
function designMac(startMs: number): DemoTranscript {
  const sessionID = "7a3f0c2e-5b1d-4e6b-9c0d-6d656d6f0002";
  const t = new ClaudeLines(sessionID, designCwd, startMs - 12 * 60_000);
  // An earlier request the user stopped: its Interrupted notice stays at its place in the chat.
  t.user("Run the design suite on every size.", 0)
    .tool("toolu_demo_10", "Bash", { command: "swift run design-suite --all-sizes" }, 3)
    .result("toolu_demo_10", "The user doesn't want to proceed with this tool use. The tool use was rejected.", 40, true)
    .user([{ text: "[Request interrupted by user for tool use]", type: "text" }], 40)
    .user("Check the chat column widths against the design and list what differs.", 180)
    .tool("toolu_demo_11", "Bash", { command: "rg -n -- '--col' design/mac-v1/mac.css" }, 184)
    .result("toolu_demo_11", "design/mac-v1/mac.css:54:  --col: 760px;\ndesign/mac-v1/mac.css:68:  --col: 720px;", 185)
    .tool("toolu_demo_12", "Bash", { command: "swift run design-diff --strict" }, 189)
    .result("toolu_demo_12", "Exit code 1\nerror: no target named 'design-diff'", 191, true)
    .tool("toolu_demo_13", "Read", { file_path: "/Users/demo/code/worktrees/aurora-web-design/App/CompanionMacV1Theme.swift" }, 194)
    .result("toolu_demo_13", Array.from({ length: 430 }, (_, i) => `${String(i + 1).padStart(6)}→x`).join("\n"), 195)
    .text(
      [
        "Two differences; the rest matches.",
        "",
        "| Metric | Design | App |",
        "| --- | ---: | ---: |",
        "| Chat column (Mac) | 760 | 760 |",
        "| Chat column (iPad) | 720 | 744 |",
        "| Thumb | 56 | 52 |",
        "",
        "There is no `design-diff` target, so I compared by hand.",
      ].join("\n"),
      232,
      true,
    );
  return {
    paneID: "w7:p1H",
    agent: "claude",
    sessionID,
    path: `/Users/demo/.claude/projects/-Users-demo-code-worktrees-aurora-web-design/${sessionID}.jsonl`,
    cwd: designCwd,
    working: false,
    lines: t.lines,
  };
}

const atelierCwd = "/Users/demo/code/atelier";

/** Mac mini's Codex pane (idle): one finished Codex turn. */
function codexAtelier(startMs: number): DemoTranscript {
  const sessionID = "019a3c2e-7d41-7b20-9f3e-6d656d6f0003";
  const base = startMs - 50 * 60_000;
  const stamp = (second: number): string => new Date(base + second * 1_000).toISOString();
  let ordinal = 0;
  const line = (type: string, payload: { [key: string]: Json }, second: number): string =>
    json({ ordinal: ordinal++, payload, timestamp: stamp(second), type });
  const lines = [
    line("session_meta", { cwd: atelierCwd, id: sessionID, originator: "codex_cli_rs", source: "cli", timestamp: stamp(0) }, 0),
    // Its turn's approval policy and sandbox, Codex's Ask for approval preset (the Permissions chip's word).
    line("turn_context", { approval_policy: "on-request", approvals_reviewer: "user", sandbox_policy: { type: "workspace-write" } }, 1),
    line("event_msg", { turn_id: "turn-a", type: "task_started" }, 1),
    line("response_item", { content: [{ text: "Which notes mention Qwen or DeepSeek this week?", type: "input_text" }], id: "m1", role: "user", type: "message" }, 1),
    line(
      "response_item",
      { call_id: "call_1", id: "ctc1", input: "text(await tools.exec_command({cmd:'rg -l -i \"qwen|deepseek\" notes'}));", name: "exec", status: "completed", type: "custom_tool_call" },
      4,
    ),
    line(
      "response_item",
      { call_id: "call_1", id: "ctco1", output: [{ text: "Script completed\nOutput:\nnotes/2026-10-29.md\nnotes/2026-10-31.md\n", type: "input_text" }], type: "custom_tool_call_output" },
      6,
    ),
    line(
      "response_item",
      {
        content: [{ text: "Two notes: **2026-10-29** (Qwen 3.5 pricing) and **2026-10-31** (DeepSeek V4 eval). Neither has a decision yet.", type: "output_text" }],
        id: "m2",
        role: "assistant",
        type: "message",
      },
      21,
    ),
    line("event_msg", { duration_ms: 20_000, turn_id: "turn-a", type: "task_complete" }, 21),
  ];
  return {
    paneID: "w5:pH",
    agent: "codex",
    sessionID,
    path: `/Users/demo/.codex/sessions/2026/11/02/rollout-2026-11-02T04-00-00-${sessionID}.jsonl`,
    cwd: atelierCwd,
    working: false,
    lines,
  };
}

const sundialCwd = "/Users/demo/code/sundial";

/** One invented request in the long demo chat: what the user asked, what the agent ran, its reply. */
interface DemoExchange {
  readonly ask: string;
  readonly tools: readonly (readonly [name: string, input: { [key: string]: Json }, output: string])[];
  readonly reply: string;
}

const fence = (language: string, ...lines: string[]): string => ["```" + language, ...lines, "```"].join("\n");

/** The long chat's requests: code in many languages, headings, lists, a table, links (all invented). */
const sundialExchanges: readonly DemoExchange[] = [
  {
    ask: "Add a retry with backoff to the price fetcher.",
    tools: [
      ["Read", { file_path: `${sundialCwd}/src/prices/fetch.ts` }, Array.from({ length: 88 }, (_, i) => `${i + 1}→x`).join("\n")],
      ["Edit", { file_path: `${sundialCwd}/src/prices/fetch.ts`, new_string: "await retry(() => get(url), { attempts: 4 })", old_string: "await get(url)" }, "The file has been updated."],
    ],
    reply: [
      "## Retry with backoff",
      "",
      "The fetcher now tries **four times**, doubling the wait each time and adding a little jitter:",
      "",
      fence(
        "ts",
        "export async function retry<T>(run: () => Promise<T>, { attempts = 4, baseMs = 250 } = {}): Promise<T> {",
        "  let last: unknown;",
        "  for (let attempt = 0; attempt < attempts; attempt += 1) {",
        "    try {",
        "      return await run();",
        "    } catch (error) {",
        "      last = error; // keep the newest failure",
        "      await sleep(baseMs * 2 ** attempt + Math.random() * 100);",
        "    }",
        "  }",
        "  throw last;",
        "}",
      ),
      "",
      "A 404 is not retried: it will not get better on its own.",
    ].join("\n"),
  },
  {
    ask: "What does the config look like now?",
    tools: [["Read", { file_path: `${sundialCwd}/config/fetcher.json` }, "1→{"]],
    reply: [
      "The fetcher's settings, with the new `retry` block:",
      "",
      fence("json", "{", '  "baseUrl": "https://prices.example.invalid/v2",', '  "timeoutMs": 8000,', '  "retry": { "attempts": 4, "baseMs": 250 },', '  "cache": true,', '  "region": null', "}"),
      "",
      "And the same in the deploy file:",
      "",
      fence("yaml", "fetcher:", "  timeout_ms: 8000   # per request", "  retry:", "    attempts: 4", "    base_ms: 250", "  cache: true"),
    ].join("\n"),
  },
  {
    ask: "Run the tests.",
    tools: [["Bash", { command: "npm test -- --run prices", description: "Run the price tests" }, "✓ prices/fetch.test.ts (12 tests) 214ms\n\nTest Files  1 passed (1)\n     Tests  12 passed (12)"]],
    reply: [
      "All 12 price tests pass. To run them yourself:",
      "",
      fence("bash", "cd ~/sundial", "npm ci --ignore-scripts", 'npm test -- --run prices   # about 2 s', 'echo "exit: $?"'),
    ].join("\n"),
  },
  {
    ask: "Show me the diff.",
    tools: [["Bash", { command: "git diff --stat" }, " src/prices/fetch.ts | 14 ++++++++++----\n 1 file changed, 10 insertions(+), 4 deletions(-)"]],
    reply: [
      "One file, ten lines in and four out:",
      "",
      fence(
        "diff",
        "--- a/src/prices/fetch.ts",
        "+++ b/src/prices/fetch.ts",
        "@@ -12,7 +12,9 @@ export async function fetchPrices(ids: string[]) {",
        "   const url = `${base}/prices?ids=${ids.join(\",\")}`;",
        "-  const response = await get(url);",
        "+  const response = await retry(() => get(url), { attempts: 4 });",
        "+  if (response.status === 404) return [];",
        "   return parse(await response.json());",
      ),
    ].join("\n"),
  },
  {
    ask: "Is there a Python script that reads these prices too?",
    tools: [["Grep", { path: sundialCwd, pattern: "prices" }, "Found 2 files\nscripts/report.py\nsrc/prices/fetch.ts"]],
    reply: [
      "Yes, `scripts/report.py` reads the same endpoint. Its loop, for reference:",
      "",
      fence(
        "python",
        "def weekly_report(ids: list[str]) -> dict:",
        '    """Average price per id over the last seven days."""',
        "    totals = {}",
        "    for day in range(7):",
        "        rows = fetch(ids, days_ago=day)  # one request per day",
        "        for row in rows:",
        "            totals.setdefault(row['id'], []).append(row['price'])",
        "    return {k: sum(v) / len(v) for k, v in totals.items() if v}",
      ),
      "",
      "It has no retry. Shall I give it the same one?",
    ].join("\n"),
  },
  {
    ask: "Not now. Where is the price table stored?",
    tools: [["Bash", { command: "sqlite3 data/prices.db '.schema prices'" }, "CREATE TABLE prices (id TEXT, day DATE, price REAL);"]],
    reply: [
      "In SQLite, `data/prices.db`. The week's averages straight from it:",
      "",
      fence("sql", "SELECT id, AVG(price) AS average", "FROM prices", "WHERE day >= DATE('now', '-7 days')  -- the last week", "GROUP BY id", "ORDER BY average DESC;"),
      "",
      "| Table | Rows | Size |",
      "| --- | ---: | ---: |",
      "| prices | 18,204 | 1.1 MB |",
      "| ids | 312 | 24 KB |",
    ].join("\n"),
  },
  {
    ask: "The Swift widget shows the same price. How does it refresh?",
    tools: [["Read", { file_path: `${sundialCwd}/Widget/PriceProvider.swift` }, "1→import WidgetKit"]],
    reply: [
      "It asks for a new timeline every **15 minutes**:",
      "",
      fence(
        "swift",
        "struct PriceProvider: TimelineProvider {",
        "    func getTimeline(in context: Context, completion: @escaping (Timeline<PriceEntry>) -> Void) {",
        "        Task {",
        '            let price = try? await PriceClient.shared.latest(id: "core")',
        "            let next = Date().addingTimeInterval(15 * 60)",
        "            completion(Timeline(entries: [PriceEntry(date: .now, price: price)], policy: .after(next)))",
        "        }",
        "    }",
        "}",
      ),
    ].join("\n"),
  },
  {
    ask: "And the status page?",
    tools: [["Read", { file_path: `${sundialCwd}/web/status.html` }, "1→<!doctype html>"]],
    reply: [
      "A static page with one badge:",
      "",
      fence("html", "<!-- refreshed by the fetcher -->", '<div class="badge" data-state="ok">', '  <span class="dot"></span> Prices up to date', "</div>"),
      "",
      fence("css", ".badge { display: inline-flex; gap: 6px; padding: 4px 10px; border-radius: 999px; }", '.badge[data-state="ok"] .dot { background: #3fb950; width: 8px; height: 8px; }'),
    ].join("\n"),
  },
  {
    ask: "The CLI is in Rust, right? How does it parse ids?",
    tools: [["Read", { file_path: `${sundialCwd}/cli/src/ids.rs` }, "1→use std::str::FromStr;"]],
    reply: [
      "Yes. Ids are checked when they are read:",
      "",
      fence(
        "rust",
        "pub fn parse_ids<'a>(input: &'a str) -> Result<Vec<&'a str>, String> {",
        "    let ids: Vec<&str> = input.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();",
        "    if ids.iter().any(|id| id.len() > 32) {",
        '        return Err(format!("an id is longer than {} characters", 32));',
        "    }",
        "    Ok(ids)",
        "}",
      ),
    ].join("\n"),
  },
  {
    ask: "And the small Go service that serves the cache?",
    tools: [["Read", { file_path: `${sundialCwd}/cache/main.go` }, "1→package main"]],
    reply: [
      "It keeps the newest prices in memory for a minute:",
      "",
      fence(
        "go",
        "func (c *Cache) Get(id string) (float64, bool) {",
        "\tc.mu.RLock()",
        "\tdefer c.mu.RUnlock()",
        "\tentry, ok := c.items[id]",
        "\tif !ok || time.Since(entry.at) > time.Minute {",
        "\t\treturn 0, false // stale or missing",
        "\t}",
        "\treturn entry.price, true",
        "}",
      ),
    ].join("\n"),
  },
  {
    ask: "Summarise what changed today.",
    tools: [["Bash", { command: "git log --oneline --since=midnight" }, "4c1e9a2 prices: retry with backoff\n9b0d7f1 prices: 404 returns nothing"]],
    reply: [
      "### Today",
      "",
      "1. The fetcher retries four times with backoff and jitter.",
      "2. A 404 returns an empty list instead of failing.",
      "3. Tests: 12 passing, none skipped.",
      "",
      "Not changed: `scripts/report.py` (no retry yet), the widget, the cache.",
      "",
      "> The report script is the one place that still fails on a slow day.",
      "",
      "Details are in [the pull request](https://example.invalid/pr/41).",
    ].join("\n"),
  },
];

/** Mac mini's sundial pane (done): a long finished chat, code in many languages (the scroll probe reads it too). */
function sundial(startMs: number): DemoTranscript {
  const sessionID = "7a3f0c2e-5b1d-4e6b-9c0d-6d656d6f0004";
  const t = new ClaudeLines(sessionID, sundialCwd, startMs - 3 * 3_600_000);
  let second = 0;
  sundialExchanges.forEach((exchange, index) => {
    t.user(exchange.ask, second);
    exchange.tools.forEach(([name, input, output], call) => {
      const id = `toolu_demo_p${index}_${call}`;
      t.tool(id, name, input, second + 3 + call * 6).result(id, output, second + 5 + call * 6);
    });
    second += 8 + exchange.tools.length * 6 + 20 * (index % 3);
    t.text(exchange.reply, second, true);
    second += 240;
  });
  return {
    paneID: "w6:p1",
    agent: "claude",
    sessionID,
    path: `/Users/demo/.claude/projects/-Users-demo-code-sundial/${sessionID}.jsonl`,
    cwd: sundialCwd,
    working: false,
    lines: t.lines,
  };
}

/** One step of a live transcript's cycle: writes one line for step `index`; `pass` counts the cycles (from 0). */
type LiveStep = (t: ClaudeLines, index: number, pass: number) => void;

/** A live transcript's steps, cycling: each step's lines with uuids of their own. */
function liveSteps(sessionID: string, cwd: string, steps: readonly LiveStep[]): DemoLive {
  return {
    everyMs: demoLiveStepMs,
    step(index, atMs) {
      const t = new ClaudeLines(sessionID, cwd, atMs, `live-${sessionID.slice(0, 8)}-${index}`);
      steps[index % steps.length]!(t, index, Math.floor(index / steps.length));
      return t.lines;
    },
  };
}

/** The tool id of the call made at step `index` (its result is the next step). */
const liveTool = (tag: string, index: number): string => `toolu_live_${tag}_${String(index).padStart(5, "0")}`;

const lookCwd = "/Users/demo/code/worktrees/aurora-web-look";
const attachCwd = "/Users/demo/code/worktrees/aurora-web-attach";

const numbered = (count: number, text: (n: number) => string): string => Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(6)}→${text(i + 1)}`).join("\n");

/** The split tab's first agent (working): a turn on the sidebar's look that keeps going, a step every demoLiveStepMs. */
function liveLook(startMs: number): DemoTranscript {
  // Session 0006 (the sundial chat has 0004).
  const sessionID = "7a3f0c2e-5b1d-4e6b-9c0d-6d656d6f0006";
  const t = new ClaudeLines(sessionID, lookCwd, startMs - 3 * 60_000);
  t.user("Bring the sidebar rows to the design: row spacing, the count badge, the folded header.", 0)
    .tool("toolu_demo_20", "Read", { file_path: `${lookCwd}/design/desktop-v1/sidebar.css` }, 4)
    .result("toolu_demo_20", numbered(64, (n) => (n % 8 === 0 ? "  gap: 8px;" : "  …")), 5)
    .progress("The design keeps 8 px between rows and a 28 px row; the app has 6 and 26.", 14);
  const live = liveSteps(sessionID, lookCwd, [
    (l, _i, pass) => l.progress(`Comparing the sidebar with the design at 1440 × 900, pass ${pass + 1}.`, 0),
    (l, i) => l.tool(liveTool("look", i), "Bash", { command: "npx vitest run test/sidebar-model.test.ts", description: "Run the sidebar tests" }, 0),
    (l, i, pass) =>
      l.result(liveTool("look", i - 1), `✓ test/sidebar-model.test.ts (41 tests) ${200 + ((pass * 37) % 90)}ms\n\n Test Files  1 passed (1)\n      Tests  41 passed (41)`, 0),
    (l, i) =>
      l.tool(liveTool("look", i), "Edit", { file_path: `${lookCwd}/desktop/src/renderer/styles/sidebar.css`, new_string: "  gap: 8px;", old_string: "  gap: 6px;" }, 0),
    (l, i) => l.result(liveTool("look", i - 1), "The file has been updated.", 0),
    (l, _i, pass) =>
      l.text(`Pass ${pass + 1}: the rows match the design (**8 px** apart, **28 px** tall). Checking the header's count badge next.`, 0),
  ]);
  return {
    paneID: "w7:pS1",
    agent: "claude",
    sessionID,
    path: `/Users/demo/.claude/projects/-Users-demo-code-worktrees-aurora-web-look/${sessionID}.jsonl`,
    cwd: lookCwd,
    working: true,
    lines: t.lines,
    live,
  };
}

/** The split tab's second agent (working): composer attachments, a step every demoLiveStepMs. */
function liveAttach(startMs: number): DemoTranscript {
  const sessionID = "7a3f0c2e-5b1d-4e6b-9c0d-6d656d6f0005";
  const t = new ClaudeLines(sessionID, attachCwd, startMs - 9 * 60_000);
  t.user("Let the user drop images and files into the composer: a chip each above the box, sent with the message.", 0)
    .tool("toolu_demo_30", "Grep", { path: "desktop/src/renderer", pattern: "onDrop|dataTransfer" }, 5)
    .result("toolu_demo_30", "Found 2 files\ndesktop/src/renderer/components/MainPane.tsx\ndesktop/src/renderer/components/Composer.tsx", 6)
    .text("The composer has no drop handler yet; the terminal takes drops as paths. Adding one to the composer.", 15);
  const live = liveSteps(sessionID, attachCwd, [
    (l, _i, pass) => l.progress(`Reading how the composer keeps a dropped file before it is sent (attempt ${pass + 1}).`, 0),
    (l, i) => l.tool(liveTool("attach", i), "Read", { file_path: `${attachCwd}/desktop/src/renderer/components/Composer.tsx` }, 0),
    (l, i) => l.result(liveTool("attach", i - 1), numbered(48, (n) => (n === 12 ? "export function Composer(props: ComposerProps) {" : "…")), 0),
    (l, i) => l.tool(liveTool("attach", i), "Bash", { command: "npx vitest run test/composer.test.ts", description: "Run the composer tests" }, 0),
    (l, i, pass) =>
      l.result(liveTool("attach", i - 1), `✓ test/composer.test.ts (36 tests) ${110 + ((pass * 53) % 70)}ms\n\n Test Files  1 passed (1)\n      Tests  36 passed (36)`, 0),
    (l, _i, pass) => l.text(`Attempt ${pass + 1}: a dropped image shows as a chip with its size; Backspace at the start of the box removes it.`, 0),
  ]);
  return {
    paneID: "w7:pS3",
    agent: "claude",
    sessionID,
    path: `/Users/demo/.claude/projects/-Users-demo-code-worktrees-aurora-web-attach/${sessionID}.jsonl`,
    cwd: attachCwd,
    working: true,
    lines: t.lines,
    live,
  };
}

const narrationCwd = "/Users/demo/code/worktrees/tidepool-narration";

/** The line kinds Grok 1.0.70 marks with their turn's start (`_meta.turnStartMs`). */
const grokTurnKinds: ReadonlySet<string> = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);

/** How long the Grok pane's running turn has run when the demo starts (the frame's clock, 17m8s). */
export const demoGrokTurnMs = (17 * 60 + 8) * 1_000;

/**
 * Mac mini's Grok pane: one finished Grok turn in its
 * updates.jsonl line shapes (invented text). Herdr names no session for a Grok
 * pane, so Chat finds it under the folder Grok files the pane's folder in.
 * The lines are as Grok 1.0.70 writes them: `timestamp` in Unix seconds,
 * `_meta.agentTimestampMs` in milliseconds, and the turn's agent lines carry its
 * start (`_meta.turnStartMs`).
 * Then a second turn, running for `demoGrokTurnMs`, whose
 * last call (the command its approval frame shows, demo-prompts.ts) is pending:
 * a `tool_call` with no `tool_call_update` yet, as Grok writes while it waits.
 */
function grokNarration(startMs: number): DemoTranscript {
  const sessionID = "019a3c2e-9a10-7c20-8d30-6d656d6f0007";
  const base = startMs - 330 * 60_000 - 3 * 60_000;
  const running = startMs - demoGrokTurnMs;
  let event = 0;
  const line = (second: number, update: { [key: string]: Json }, meta: { [key: string]: Json } = {}, turnBase = base): string => {
    event += 1;
    const at = turnBase + Math.round(second * 1_000);
    const turn: { [key: string]: Json } = typeof update.sessionUpdate === "string" && grokTurnKinds.has(update.sessionUpdate) ? { turnStartMs: turnBase + 40 } : {};
    return json({
      method: "session/update",
      params: { _meta: { agentTimestampMs: at, eventId: `demo-grok-${event}`, ...turn, ...meta }, sessionId: sessionID, update },
      timestamp: Math.floor(at / 1_000),
    });
  };
  const tool = (name: string, kind: string, label: string): Json => ({
    "x.ai/tool": { kind, label, name, namespace: "grok_build", read_only: kind === "read" || kind === "search", version: 1 },
  });
  const script = `${narrationCwd}/scripts/narrate.py`;
  const lines = [
    line(0, { _meta: { promptIndex: 0 }, content: { text: "The narration cuts off the last word of each scene. Find out why and fix it.", type: "text" }, sessionUpdate: "user_message_chunk" }),
    line(2, { content: { text: "The cut is probably in how scene audio is trimmed.", type: "text" }, sessionUpdate: "agent_thought_chunk" }),
    line(2.4, { content: { text: " Reading the script first.", type: "text" }, sessionUpdate: "agent_thought_chunk" }),
    line(4, { _meta: tool("read_file", "read", "Read"), rawInput: { target_file: script }, sessionUpdate: "tool_call", title: "read_file", toolCallId: "demo-read-1" }),
    line(4.2, {
      content: [{ content: { text: "def trim(clip, end):\n    return clip[: end - FADE]\n", type: "text" }, type: "content" }],
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId: "demo-read-1",
    }),
    line(9, { _meta: tool("grep", "search", "Search"), rawInput: { pattern: "FADE" }, sessionUpdate: "tool_call", title: "grep", toolCallId: "demo-grep-2" }),
    line(9.3, {
      rawOutput: { Content: { absolute_root_path: narrationCwd, content: "scripts/narrate.py:4:FADE = 0.35\nscripts/narrate.py:31:    return clip[: end - FADE]" }, type: "Content" },
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId: "demo-grep-2",
    }),
    line(15, { _meta: tool("edit_file", "edit", "Edit"), rawInput: { file_path: script }, sessionUpdate: "tool_call", title: "edit_file", toolCallId: "demo-edit-3" }),
    line(15.4, {
      content: [{ newText: "    return clip[:end].fade_out(FADE)", oldText: "    return clip[: end - FADE]", path: script, type: "diff" }],
      kind: "edit",
      sessionUpdate: "tool_call_update",
      status: "completed",
      title: "Edit scripts/narrate.py",
      toolCallId: "demo-edit-3",
    }),
    line(20, { _meta: tool("run_terminal_command", "execute", "Run command"), rawInput: { command: "python3 -m pytest tests/test_narrate.py -q" }, sessionUpdate: "tool_call", title: "run_terminal_command", toolCallId: "demo-run-4" }),
    line(31, {
      content: [{ content: { text: "........\n8 passed in 2.41s", type: "text" }, type: "content" }],
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId: "demo-run-4",
    }),
    line(34, { content: { text: "Each scene was trimmed by the fade length **before** fading, so the last ", type: "text" }, sessionUpdate: "agent_message_chunk" }),
    line(34.3, { content: { text: "0.35 s of speech was cut. It now fades out over the scene's own end; the 8 narration tests pass.", type: "text" }, sessionUpdate: "agent_message_chunk" }),
    line(35, { elapsed_ms: 35_000, prompt_id: "demo-prompt-0", sessionUpdate: "turn_completed", stop_reason: "end_turn" }),
    // The running turn, its last call waiting on the approval frame.
    line(0, { _meta: { promptIndex: 1 }, content: { text: "Render scene 3 and check its last word now lands inside the fade.", type: "text" }, sessionUpdate: "user_message_chunk" }, {}, running),
    line(3, { content: { text: "Reading the script again before rendering the scene.", type: "text" }, sessionUpdate: "agent_thought_chunk" }, {}, running),
    line(6, { _meta: tool("read_file", "read", "Read"), rawInput: { target_file: script }, sessionUpdate: "tool_call", title: "read_file", toolCallId: "demo-read-5" }, {}, running),
    line(6.2, {
      content: [{ content: { text: "def trim(clip, end):\n    return clip[:end].fade_out(FADE)\n", type: "text" }, type: "content" }],
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId: "demo-read-5",
    }, {}, running),
    line(9, { _meta: tool("run_terminal_command", "execute", "Run command"), rawInput: { command: demoGrokCommand }, sessionUpdate: "tool_call", title: demoGrokTitle, toolCallId: "demo-run-6" }, {}, running),
  ];
  return {
    paneID: "wD:pK",
    agent: "grok",
    sessionID,
    path: `/Users/demo/.grok/sessions/${grokFolderName(narrationCwd)}/${sessionID}/updates.jsonl`,
    cwd: narrationCwd,
    working: true,
    lines,
  };
}

/** The Mac mini demo machine's transcripts. */
const harborCwd = "/Users/demo/code/harbor";

/** The Cursor chat's `<timestamp>`, the user's local time as Cursor writes it (UTC here). */
function cursorTimestamp(ms: number): string {
  const date = new Date(ms);
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hour = date.getUTCHours() % 12 === 0 ? 12 : date.getUTCHours() % 12;
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${weekdays[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${hour}:${minute} ${date.getUTCHours() < 12 ? "AM" : "PM"} (UTC+0)`;
}

/** The user's message as a Cursor store blob, timed `atMs`. */
export function cursorUserLine(text: string, atMs: number): string {
  return json({ content: [{ text: `<timestamp>${cursorTimestamp(atMs)}</timestamp>\n<user_query>\n${text}\n</user_query>`, type: "text" }], role: "user" });
}

/**
 * Mac mini's Cursor pane (idle): one Cursor agent chat in its store's blob shapes
 * (invented text), served as the line view the app reads from a store.db (one blob per line, in the
 * root's order). Herdr names no session for it, so Chat finds the newest chat Cursor filed under the
 * md5 of the pane's folder, whose meta.json names the folder.
 */
function cursorHarbor(startMs: number): DemoTranscript {
  const sessionID = "6b1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
  const at = startMs - 410 * 60_000 - 6 * 60_000;
  const file = `${harborCwd}/Sources/Harbor/RateLimiter.swift`;
  const call = (id: string, toolName: string, args: { [key: string]: Json }): Json => ({ args, toolCallId: id, toolName, type: "tool-call" });
  const result = (id: string, toolName: string, text: string, isError = false, exitCode: number | null = null): string =>
    json({
      content: [{ result: text, toolCallId: id, toolName, type: "tool-result" }],
      providerOptions: { cursor: { highLevelToolCallResult: { isError, output: exitCode === null ? {} : { success: { exitCode } } } } },
      role: "tool",
    });
  const assistant = (...parts: Json[]): string => json({ content: parts, role: "assistant" });
  const text = (value: string): Json => ({ text: value, type: "text" });
  const lines = [
    json({ content: "You are an invented coding agent in a demo.", role: "system" }),
    json({ content: [{ text: "<user_info>\nOS Version: darwin\nWorkspace Path: " + harborCwd + "\n</user_info>", type: "text" }], role: "user" }),
    cursorUserLine("The rate limiter lets one extra request through per window. Fix it and run its tests.", at),
    assistant({ text: "", type: "reasoning" }, text("Reading the limiter first."), call("demo-cursor-read", "Read", { path: file })),
    result("demo-cursor-read", "Read", "func allow() -> Bool {\n    if count > limit { return false }\n    count += 1\n    return true\n}"),
    assistant(call("demo-cursor-grep", "Grep", { pattern: "count > limit", path: harborCwd })),
    result("demo-cursor-grep", "Grep", "Sources/Harbor/RateLimiter.swift:12:    if count > limit { return false }"),
    assistant(
      text("The check lets the request after the limit through: it should stop at the limit itself."),
      call("demo-cursor-edit", "StrReplace", { new_string: "    if count >= limit { return false }", old_string: "    if count > limit { return false }", path: file }),
    ),
    result("demo-cursor-edit", "StrReplace", "The file was updated."),
    assistant(call("demo-cursor-test1", "Shell", { command: "swift test --filter RateLimiterTests", working_directory: harborCwd })),
    result("demo-cursor-test1", "Shell", "error: no such module 'HarborTestSupport'", true, 1),
    assistant(text("The test target needs its support module built first."), call("demo-cursor-test2", "Shell", { command: "swift build --target HarborTestSupport && swift test --filter RateLimiterTests" })),
    result("demo-cursor-test2", "Shell", "Test Suite 'RateLimiterTests' passed.\n\t Executed 6 tests, with 0 failures", false, 0),
    assistant(text("Fixed: the limiter stops at the limit (`>=`), so a window takes exactly `limit` requests. The 6 RateLimiterTests pass.")),
  ];
  return {
    paneID: "wC:p1",
    agent: "cursor",
    sessionID,
    path: `/Users/demo/.cursor/chats/${cursorFolderHash(harborCwd)}/${sessionID}/store.db`,
    cwd: harborCwd,
    working: false,
    lines,
  };
}

export function demoTranscripts(startMs: number): DemoTranscript[] {
  return [
    macBuild(startMs),
    designMac(startMs),
    codexAtelier(startMs),
    sundial(startMs),
    liveLook(startMs),
    liveAttach(startMs),
    grokNarration(startMs),
    cursorHarbor(startMs),
    // Background work running, and the same after it ended.
    ...runningTranscripts(startMs),
  ];
}

/** Herdr's `agent_session` for a demo transcript (wire JSON); none for Grok or Cursor, as Herdr names none for their panes. */
export function demoAgentSession(transcript: DemoTranscript): { [key: string]: Json } | null {
  if (transcript.agent === "grok" || transcript.agent === "cursor") return null;
  return { agent: transcript.agent, kind: "id", source: `herdr:${transcript.agent}`, value: transcript.sessionID };
}

// Codex rollout lines written while the demo runs (demo-live.ts).

/** The ordinals of the lines written live, after the demo rollout's own. */
let codexOrdinal = 1_000;

/** A Codex rollout line (the demo's codexAtelier shape) stamped `atMs`. */
export function codexLiveLine(type: string, payload: { [key: string]: Json }, atMs: number): string {
  codexOrdinal += 1;
  return json({ ordinal: codexOrdinal, payload, timestamp: new Date(atMs).toISOString(), type });
}

/** The user's message as the Codex rollout records it: a new turn. */
export function demoCodexUserLines(text: string, atMs: number): string[] {
  const turn = `turn-live-${atMs}`;
  return [
    codexLiveLine("event_msg", { turn_id: turn, type: "task_started" }, atMs),
    codexLiveLine("response_item", { content: [{ text, type: "input_text" }], id: `live-user-${atMs}`, role: "user", type: "message" }, atMs),
  ];
}

/** A pane whose reply lands in its transcript once written (demo-live.ts). */
interface DemoLanding {
  readonly paneID: string;
  landing(sessionID: string, cwd: string): string[] | null;
}

/** Serves the demo transcripts (and the demo picture) from memory; appends what the composer sends. */
export class DemoTranscriptReader implements TranscriptFileReader<TranscriptSessionRef> {
  private readonly files = new Map<string, Uint8Array>();
  private readonly paths = new Map<string, string>();
  private readonly byPane = new Map<string, DemoTranscript>();
  private readonly byPath = new Map<string, DemoTranscript>();
  /** Each live transcript's clock: when it was first read, and how many steps it has written. */
  private readonly live = new Map<string, { since: number; steps: number }>();

  constructor(
    transcripts: readonly DemoTranscript[],
    private readonly now: () => number = Date.now,
    /** The pane, or panes, whose reply lands in its transcript once written (demo-live.ts). */
    liveReply: DemoLanding | readonly DemoLanding[] | null = null,
  ) {
    for (const transcript of transcripts) {
      this.files.set(transcript.path, new TextEncoder().encode(transcript.lines.join("\n") + "\n"));
      this.paths.set(transcript.sessionID, transcript.path);
      this.byPane.set(transcript.paneID, transcript);
      this.byPath.set(transcript.path, transcript);
      // A subagent's own transcript and meta.json beside the session's.
      for (const [path, content] of Object.entries(transcript.files ?? {})) this.files.set(path, new TextEncoder().encode(content));
      // A Grok session's summary.json names its folder (info.cwd), which Chat checks.
      const summary = transcript.agent === "grok" ? grokSummaryPath(transcript.path) : null;
      // And the model and effort its chips show; signals.json its window.
      if (summary !== null) {
        this.files.set(summary, new TextEncoder().encode(JSON.stringify({ info: { cwd: transcript.cwd }, current_model_id: "grok-4.7", reasoning_effort: "high" })));
        this.files.set(summary.slice(0, -"summary.json".length) + "signals.json", new TextEncoder().encode(JSON.stringify({ contextTokensUsed: 12_400, contextWindowTokens: 256_000 })));
      }
      // A Cursor chat's meta.json names its folder (cwd), which Chat checks.
      const meta = transcript.agent === "cursor" ? cursorMetaPath(transcript.path) : null;
      if (meta !== null) {
        const updatedAtMs = this.now();
        this.files.set(meta, new TextEncoder().encode(JSON.stringify({ createdAtMs: updatedAtMs, cwd: transcript.cwd, hasConversation: true, schemaVersion: 1, title: "Rate limiter", updatedAtMs })));
      }
    }
    this.files.set(demoShotPath, Uint8Array.from(atob(demoShotBase64), (c) => c.charCodeAt(0)));
    this.liveReplies = liveReply === null ? [] : Array.isArray(liveReply) ? [...(liveReply as readonly DemoLanding[])] : [liveReply as DemoLanding];
  }

  private readonly liveReplies: readonly DemoLanding[];

  /** A file beside a session written again (a Grok switch's summary.json). */
  setFile(path: string, text: string): void {
    this.files.set(path, new TextEncoder().encode(text));
  }

  /** A live transcript writes the steps due since it was first read. */
  private grow(path: string): void {
    const live = this.byPath.get(path)?.live;
    if (live === undefined) return;
    const now = this.now();
    const state = this.live.get(path);
    if (state === undefined) {
      this.live.set(path, { since: now, steps: 0 });
      return;
    }
    let due = Math.floor((now - state.since) / live.everyMs);
    if (due <= state.steps) return;
    if (due - state.steps > liveCatchUp) {
      // Back from a long gap: the clock moves on, only the last few steps are written.
      state.since = now - (state.steps + liveCatchUp) * live.everyMs;
      due = state.steps + liveCatchUp;
    }
    const lines: string[] = [];
    for (let index = state.steps; index < due; index += 1) lines.push(...live.step(index, state.since + (index + 1) * live.everyMs));
    state.steps = due;
    this.append(path, lines);
  }

  private append(path: string, lines: readonly string[]): void {
    const file = this.files.get(path);
    if (file === undefined || lines.length === 0) return;
    const added = new TextEncoder().encode(lines.join("\n") + "\n");
    const next = new Uint8Array(file.length + added.length);
    next.set(file);
    next.set(added, file.length);
    this.files.set(path, next);
  }

  locate(ref: TranscriptSessionRef): Promise<string | null> {
    const lookup = ref.lookup;
    if (lookup.kind === "path") return Promise.resolve(this.files.has(lookup.path) ? lookup.path : null);
    if (lookup.kind === "id") return Promise.resolve(this.paths.get(lookup.id) ?? null);
    // A Grok pane's folder, as the locator's search under ~/.grok/sessions finds it.
    if (ref.format === "grok") {
      const found = [...this.byPath.values()].find((transcript) => transcript.agent === "grok" && transcript.cwd === lookup.folder);
      return Promise.resolve(found?.path ?? null);
    }
    // A Cursor pane's folder, as the locator's search under ~/.cursor/chats finds it.
    if (ref.format === "cursor") {
      const found = [...this.byPath.values()].find((transcript) => transcript.agent === "cursor" && transcript.cwd === lookup.folder);
      return Promise.resolve(found?.path ?? null);
    }
    return Promise.resolve(null);
  }

  size(path: string): Promise<number> {
    this.grow(path);
    const transcript = this.byPath.get(path);
    const live = transcript === undefined ? undefined : this.liveReplies.find((each) => each.paneID === transcript.paneID);
    if (transcript !== undefined && live !== undefined) this.append(path, live.landing(transcript.sessionID, transcript.cwd) ?? []);
    const file = this.files.get(path);
    return file === undefined ? Promise.reject(new TranscriptNotFoundError(path)) : Promise.resolve(file.length);
  }

  read(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (file === undefined) return Promise.reject(new TranscriptNotFoundError(path));
    return Promise.resolve(file.slice(offset, offset + maxBytes));
  }

  /** The names directly inside `folder` (a session's subagents folder). */
  list(folder: string): Promise<readonly string[]> {
    const prefix = folder.endsWith("/") ? folder : folder + "/";
    const names = [...this.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")).map((path) => path.slice(prefix.length));
    return names.length === 0 ? Promise.reject(new TranscriptNotFoundError(folder)) : Promise.resolve(names);
  }

  /** A file the demo machine now has (an upload), for Chat's thumbnails. */
  store(path: string, data: Uint8Array): void {
    this.files.set(path, data.slice());
  }

  /**
   * Capture 133: the user's message and a tool call with no result yet written
   * into a Claude pane's transcript (Chat's running call); false when the pane has none.
   */
  running(paneID: string, call: DemoRunningCall, nowMs: number): boolean {
    const transcript = this.byPane.get(paneID);
    if (transcript === undefined || transcript.agent !== "claude" || !this.files.has(transcript.path)) return false;
    this.grow(transcript.path);
    const lines = new ClaudeLines(transcript.sessionID, transcript.cwd, nowMs, `tall-${nowMs}`);
    lines.user(call.ask, 0).tool(call.id, call.name, call.input, 2);
    this.append(transcript.path, lines.lines);
    return true;
  }

  /**
   * Captures 165-166: what a slash command printed (Claude Code's /model confirmation) written into a
   * Claude pane's transcript, as Claude Code writes it; false when the pane has none.
   */
  commandPrinted(paneID: string, stdout: string, nowMs: number): boolean {
    const transcript = this.byPane.get(paneID);
    if (transcript === undefined || transcript.agent !== "claude" || !this.files.has(transcript.path)) return false;
    this.grow(transcript.path);
    const lines = new ClaudeLines(transcript.sessionID, transcript.cwd, nowMs, `printed-${nowMs}`);
    lines.user(`<local-command-stdout>${stdout}</local-command-stdout>`, 0);
    this.append(transcript.path, lines.lines);
    return true;
  }

  /**
   * Captures 173-174: Claude Code's compaction written into the pane's transcript,
   * its marker and its summary line, as a `/compact` leaves them; false when the pane has no Claude transcript.
   */
  compacted(paneID: string, nowMs: number): boolean {
    const transcript = this.byPane.get(paneID);
    if (transcript === undefined || transcript.agent !== "claude" || !this.files.has(transcript.path)) return false;
    this.grow(transcript.path);
    const base = { cwd: transcript.cwd, isSidechain: false, sessionId: transcript.sessionID, timestamp: new Date(nowMs).toISOString(), version: "2.1.322" };
    const summary =
      "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
    this.append(transcript.path, [
      json({ ...base, type: "system", subtype: "compact_boundary", uuid: `compact-${nowMs}-1`, content: "Conversation compacted", level: "info", isMeta: false, compactMetadata: { trigger: "manual", preTokens: 312_408 } }),
      json({ ...base, type: "user", uuid: `compact-${nowMs}-2`, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: summary }, userType: "external" }),
    ]);
    return true;
  }

  /**
   * Captures 181-185: a Codex turn_context naming the model and effort, as Codex
   * writes one when a turn begins (its approval policy and sandbox as the pane's first one); false when the pane has
   * no Codex transcript.
   */
  codexModel(paneID: string, model: string, effort: string, nowMs: number): boolean {
    const transcript = this.byPane.get(paneID);
    if (transcript === undefined || transcript.agent !== "codex" || !this.files.has(transcript.path)) return false;
    this.grow(transcript.path);
    const payload = { approval_policy: "on-request", approvals_reviewer: "user", sandbox_policy: { type: "workspace-write" }, model, effort };
    this.append(transcript.path, [json({ payload, timestamp: new Date(nowMs).toISOString(), type: "turn_context" })]);
    return true;
  }

  /** Writes a sent message into the pane's transcript; false when the pane has none. */
  record(paneID: string, text: string, working: boolean, nowMs: number): boolean {
    const transcript = this.byPane.get(paneID);
    const file = transcript === undefined ? undefined : this.files.get(transcript.path);
    if (transcript === undefined || file === undefined) return false;
    this.grow(transcript.path);
    // The user's message in a Codex rollout starts a new turn (the demo's Codex pane answers it, demo-live.ts).
    if (transcript.agent === "codex") {
      this.append(transcript.path, demoCodexUserLines(text, nowMs));
      return true;
    }
    // The user's message as a Cursor blob.
    if (transcript.agent === "cursor") {
      this.append(transcript.path, [cursorUserLine(text, nowMs)]);
      return true;
    }
    const lines = new ClaudeLines(transcript.sessionID, transcript.cwd, nowMs);
    if (working) lines.queued(text, 0);
    else lines.user(text, 0);
    this.append(
      transcript.path,
      lines.lines.map((line) => line.replace(/"uuid":"demo-/, `"uuid":"sent-${nowMs}-`)),
    );
    return true;
  }
}
