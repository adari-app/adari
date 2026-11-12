// Demo mode's two machines, from the repo's protocol 22 fixtures; no host, no
// network. Each is a session snapshot in Herdr's wire JSON, answered through
// the real client and decoders (demo-backend.ts), so the demo exercises the
// same path a real machine does.
//
// - "Mac mini" (macOS): the workspaces, tabs and panes of a Herdr
//   0.9.5 server (SidebarFixture: sidebar-*.json), with agents that put one
//   pane on a menu (needs you), two working, some done, the rest idle; and
//   the split tab (demoSplitTab: 4 panes, two live agents, two shells
//   printing).
// - "build-box" (Linux): MockWireFixtures' agent list (mock-agent-list.json)
//   arranged into four workspaces, two agents blocked, one working, the rest
//   idle or done, and a plain shell.
//
// Times are minutes before the demo started, so "2m" grows as the clock runs.

import type { HostDescriptor } from "../hosts";
import type { TerminalHandle, TerminalSink } from "../herdr/backend";
import type { TerminalDimensions } from "../herdr/terminal";
import type { TopologyPaneInfo } from "../herdr/wire";
import type { DemoClock } from "./demo-backend";
import type { DemoGitData } from "./demo-git";
import type { DemoCommit } from "./demo-remote";
import { demoAgentSession, demoTranscripts, type DemoTranscript } from "./demo-chat";
import { demoPromptScreens } from "./demo-prompts";
import { demoCodexLivePane, demoCursorLivePane, demoLivePane } from "./demo-live";

export interface DemoFixtures {
  /** protocol22/sidebar-workspaces.json, sidebar-tabs.json, sidebar-panes.json. */
  readonly sidebarWorkspaces: readonly unknown[];
  readonly sidebarTabs: readonly unknown[];
  readonly sidebarPanes: readonly unknown[];
  /** protocol22/mock-agent-list.json (a whole agent.list reply). */
  readonly mockAgentList: unknown;
  /** replay/idle.hfx and replay/heavy-excerpt.hfx (HRDRFX01). */
  readonly idle: Uint8Array;
  readonly heavy: Uint8Array;
  /** replay/claude-2.1.303-bash-dialog.txt: Claude Code asking to run a command. */
  readonly bashDialog: string;
}

type Json = Record<string, unknown>;

export interface DemoHost {
  readonly descriptor: HostDescriptor;
  /** The `snapshot` a protocol 22 server returns for session.snapshot. */
  readonly snapshot: Json;
  /** Chat's transcripts for some of its panes (demo-chat.ts). */
  readonly transcripts: readonly DemoTranscript[];
  /** Shells whose terminal prints a log without end (the split tab's). */
  readonly printing?: readonly string[];
  /** A machine with data of its own (no fixture): its git, its folders' commits, its terminals, its home folder. */
  readonly git?: DemoGitData;
  readonly commits?: Readonly<Record<string, readonly DemoCommit[]>>;
  readonly terminal?: (pane: TopologyPaneInfo, size: TerminalDimensions, sink: TerminalSink, clock: DemoClock) => TerminalHandle;
  readonly home?: string;
  /** What its blocked panes show to `pane.read`, screen by screen (demo-prompts.ts), and the Claude pane with the update line. */
  readonly screens?: Readonly<Record<string, readonly string[]>>;
  /** The pane whose reply streams on its screen once the user's message reaches it (demo-live.ts). */
  readonly liveReply?: string;
  /** The Codex pane whose reply streams on its screen once the user's message reaches it (demo-live.ts). */
  readonly codexLiveReply?: string;
  /** The Cursor pane whose reply streams on its screen once the user's message reaches it (demo-live.ts). */
  readonly cursorLiveReply?: string;
  /** Uploads already on the machine (Settings › Uploaded images counts them). */
  readonly uploads?: number;
}

const minute = 60_000;

export const demoHostIds = { macMini: "demo-mac-mini", buildBox: "demo-build-box" } as const;

/**
 * The Mac mini's 4-pane tab, in herdr-companion:
 * two columns, each split down; two working Claude panes (Chat, following
 * their live transcripts) and two shells printing a log (Terminal). With
 * workers 1 (2 panes) and wA's workers 1 (3), the demo has tabs of 2, 3 and 4.
 */
export const demoSplitTab = {
  tabId: "w7:tS",
  workspaceId: "w7",
  panes: ["w7:pS1", "w7:pS2", "w7:pS3", "w7:pS4"],
  chats: ["w7:pS1", "w7:pS3"],
  terminals: ["w7:pS2", "w7:pS4"],
} as const;

function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

/** A workspace's or tab's rolled-up status, as Herdr reports it: what needs you wins. */
function rollUp(statuses: readonly string[]): string {
  for (const status of ["blocked", "working", "done", "idle"]) {
    if (statuses.includes(status)) return status;
  }
  return "unknown";
}

/** The Mac mini's Claude pane whose Claude Code has an update installed. */
export const demoUpdateReadyPaneId = "w6:p1";

/** Its screen as `pane.read` gives it (an invented one, in Claude Code's shape): the line right above the box. */
export const demoUpdateReadyScreen = (() => {
  const width = 100;
  const rule = "\u2500".repeat(width);
  const line = "\u2714 Update installed \u00B7 Restart to update";
  return [
    "\u276F show the code block",
    "",
    "\u23FA Here is the snippet, highlighted.",
    "",
    "\u273B Worked for 12s",
    "",
    " ".repeat(width - [...line].length) + line,
    rule,
    "\u276F ",
    rule,
    "  Opus 5.5 | 12% ctx | herdr-companion | v2.1.312",
    "  \u23F5\u23F5 auto mode on (shift+tab to cycle)",
  ].join("\n");
})();

/** Build-box's idle Codex pane (trendline) whose Codex says a newer version is available. */
export const demoCodexUpdatePaneId = "w2:p1";

/**
 * Its screen as `pane.read` gives it (an invented one, in Codex 0.167.0's shape: its header, then the bordered cell
 * Codex adds when it starts with a newer version out, each line as its binary carries it), then its box.
 */
export const demoCodexUpdateScreen = (() => {
  const cell = (rows: readonly string[], width: number): string[] => [
    `\u256D${"\u2500".repeat(width + 2)}\u256E`,
    ...rows.map((row) => `\u2502 ${row}${" ".repeat(Math.max(0, width - [...row].length))} \u2502`),
    `\u2570${"\u2500".repeat(width + 2)}\u256F`,
  ];
  return [
    ...cell([">_ OpenAI Codex (v0.167.0)", "", "model:     gpt-5.5-codex high   /model to change", "directory: /srv/trendline"], 50),
    "",
    ...cell(["\u2728 Update available! 0.167.0 -> 0.168.0", "Run npm install -g @openai/codex to update.", "", "See full release notes:", "https://github.com/openai/codex/releases/latest"], 50),
    "",
    "\u203A Ask Codex to do anything",
    "",
    "  gpt-5.5-codex high \u00B7 /srv/trendline",
    "  ? for shortcuts",
    "",
  ].join("\n");
})();

/** The uploads already on each demo machine (Settings › Uploaded images: a few hundred on the Mac mini). */
export const demoUploadCounts = { macMini: 312, buildBox: 27 } as const;

function macMini(fixtures: DemoFixtures, startUnixMs: number): DemoHost {
  const agent = (pane: string, status: string, minutesAgo: number, extra: Json = {}): Json => ({
    pane_id: pane,
    agent: "claude",
    agent_status: status,
    status_since_unix_ms: startUnixMs - minutesAgo * minute,
    ...extra,
  });
  const agents = [
    // A menu on screen: idle with input pending reads as needs you.
    agent("w2:p70", "idle", 2, { input_pending: true, input_prompt_kind: "permission" }),
    agent("w7:p1G", "working", 14),
    agent("w7:p1", "working", 38),
    agent("w7:p1H", "done", 6),
    agent("w6:p1", "done", 26),
    agent("w3:p1", "done", 52),
    agent("w2:p1", "done", 100),
    agent("w5:p1", "done", 180),
    agent("w5:pH", "idle", 45, { agent: "codex" }),
    agent("w9:p1", "idle", 125),
    agent("wA:p1", "idle", 240),
    agent("wA:pJ", "idle", 75),
    // Blocked on Codex's tool-call question (demo-prompts.ts) for 12 minutes.
    agent("wA:pM", "blocked", 12, { agent: "codex" }),
    agent("wA:pK", "idle", 80),
    agent("wB:p1", "idle", 300),
    // A Cursor pane (Herdr names no session for it; Chat follows its folder).
    agent("wC:p1", "idle", 410, { agent: "cursor" }),
    agent("wD:p1", "idle", 520),
    // A Grok pane (Herdr names no session for it; Chat follows its folder),
    // blocked on Grok's approval frame (demo-prompts.ts) for a minute, its turn running for 17.
    agent("wD:pK", "blocked", 1, { agent: "grok" }),
    agent("w7:pS1", "working", 3),
    agent("w7:pS3", "working", 9),
  ];
  // The panes with a Chat transcript carry its session, as Herdr's agent_session would.
  const transcripts = demoTranscripts(startUnixMs);
  for (const transcript of transcripts) {
    const entry = agents.find((candidate) => candidate["pane_id"] === transcript.paneID);
    const session = demoAgentSession(transcript);
    if (entry !== undefined) Object.assign(entry, session === null ? { cwd: transcript.cwd } : { agent_session: session, cwd: transcript.cwd });
  }
  const split = splitTab();
  return {
    // The blocked panes' screens; one Claude pane's screen shows Claude Code's update line.
    screens: { ...demoPromptScreens(fixtures.bashDialog).macMini, [demoUpdateReadyPaneId]: [demoUpdateReadyScreen] },
    uploads: demoUploadCounts.macMini,
    liveReply: demoLivePane,
    codexLiveReply: demoCodexLivePane,
    cursorLiveReply: demoCursorLivePane,
    transcripts,
    printing: demoSplitTab.terminals,
    descriptor: { id: demoHostIds.macMini, name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" },
    snapshot: {
      version: "0.9.5",
      protocol: 22,
      focused_workspace_id: "w7",
      focused_tab_id: "w7:t1",
      focused_pane_id: "w7:p1",
      // herdr-companion counts the split tab's tab and panes.
      workspaces: fixtures.sidebarWorkspaces.map((workspace) => {
        const entry = object(workspace);
        if (entry["workspace_id"] !== demoSplitTab.workspaceId) return workspace;
        return { ...entry, tab_count: Number(entry["tab_count"] ?? 0) + 1, pane_count: Number(entry["pane_count"] ?? 0) + split.panes.length };
      }),
      tabs: [...fixtures.sidebarTabs, split.tab],
      // The Grok pane is Grok's in the pane list too, as Herdr reports it,
      // and the Cursor pane is Cursor's there too.
      panes: [
        ...fixtures.sidebarPanes.map((pane) => {
          const id = object(pane)["pane_id"];
          if (id === "wD:pK") return { ...object(pane), agent: "grok", agent_status: "blocked", label: "tidepool-narration · grok" };
          if (id === "wA:pM") return { ...object(pane), agent_status: "blocked" };
          if (id === "wC:p1") return { ...object(pane), agent: "cursor", label: "harbor · cursor" };
          return pane;
        }),
        ...split.panes,
      ],
      layouts: [],
      agents,
    },
  };
}

/** The split tab's tab and panes, in Herdr's wire JSON (the panes in its layout's order). */
function splitTab(): { tab: Json; panes: Json[] } {
  const { tabId, workspaceId } = demoSplitTab;
  const pane = (paneId: string, terminal: string, cwd: string, label: string, title: string, agent: string | null): Json => ({
    pane_id: paneId,
    terminal_id: terminal,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused: false,
    agent_status: agent === null ? "unknown" : "working",
    revision: 3,
    cwd,
    foreground_cwd: cwd,
    label,
    ...(agent === null ? {} : { agent }),
    terminal_title_stripped: title,
  });
  const look = "/Users/demo/code/worktrees/aurora-web-look";
  const attach = "/Users/demo/code/worktrees/aurora-web-attach";
  return {
    tab: { agent_status: "working", focused: false, label: "desktop work", number: 20, pane_count: 4, tab_id: tabId, workspace_id: workspaceId },
    panes: [
      pane("w7:pS1", "term_demo_split_1", look, "aurora-web-look · opus", "aurora-web-look", "claude"),
      pane("w7:pS2", "term_demo_split_2", look, "look log", "tail -f logs/desktop.log", null),
      pane("w7:pS3", "term_demo_split_3", attach, "aurora-web-attach · opus", "aurora-web-attach", "claude"),
      pane("w7:pS4", "term_demo_split_4", attach, "attach log", "tail -f logs/desktop.log", null),
    ],
  };
}

const boxWorkspaces: readonly { id: string; label: string }[] = [
  { id: "w1", label: "clients" },
  { id: "w2", label: "herdr" },
  { id: "w3", label: "research" },
  { id: "w4", label: "calls" },
];

/** Minutes in their current status for build-box's agents (the mock list has no times). */
const boxMinutes: Readonly<Record<string, number>> = {
  "w1:p1": 1,
  "w1:p2": 7,
  "w2:p1": 25,
  "w2:p2": 3,
  "w3:p1": 130,
  "w3:p2": 40,
  "w4:p1": 190,
  "w4:p2": 9,
};

function buildBox(fixtures: DemoFixtures, startUnixMs: number): DemoHost {
  const listed = object(object(fixtures.mockAgentList)["result"])["agents"];
  // The workspace panes only: not the other machine's pane, not the archived one.
  const mock = (Array.isArray(listed) ? listed : [])
    .map(object)
    .filter((a) => typeof a["pane_id"] === "string" && /^w[1-4]:p\d$/.test(a["pane_id"]) && a["archived"] === undefined);

  const panes: Json[] = mock.map((a, index) => ({
    pane_id: a["pane_id"],
    terminal_id: `term-box-${index + 1}`,
    workspace_id: String(a["pane_id"]).split(":")[0],
    tab_id: `${String(a["pane_id"]).split(":")[0]}:t1`,
    focused: index === 0,
    cwd: a["cwd"],
    label: a["name"],
    agent: a["agent"],
    agent_status: a["agent_status"],
    terminal_title_stripped: a["terminal_title_stripped"],
    revision: 1,
  }));
  panes.push({
    pane_id: "w2:p3",
    terminal_id: "term-box-shell",
    workspace_id: "w2",
    tab_id: "w2:t1",
    focused: false,
    cwd: "/root/herdr",
    label: "build",
    agent_status: "unknown",
    terminal_title_stripped: "cargo build --release",
    revision: 1,
  });

  const agents: Json[] = mock.map((a) => ({
    pane_id: a["pane_id"],
    name: a["name"],
    agent: a["agent"],
    agent_status: a["agent_status"],
    cwd: a["cwd"],
    terminal_title_stripped: a["terminal_title_stripped"],
    status_since_unix_ms: startUnixMs - (boxMinutes[String(a["pane_id"])] ?? 60) * minute,
  }));

  const statusOf = (workspace: string): string =>
    rollUp(panes.filter((p) => p["workspace_id"] === workspace).map((p) => String(p["agent_status"])));
  const countOf = (workspace: string): number => panes.filter((p) => p["workspace_id"] === workspace).length;

  return {
    // Its Codex pane shows Codex's update notice.
    screens: { ...demoPromptScreens(fixtures.bashDialog).buildBox, [demoCodexUpdatePaneId]: [demoCodexUpdateScreen] },
    uploads: demoUploadCounts.buildBox,
    transcripts: [],
    descriptor: { id: demoHostIds.buildBox, name: "build-box", kind: "demo", address: "demo", platform: "Linux" },
    snapshot: {
      version: "0.9.5",
      protocol: 22,
      focused_workspace_id: "w1",
      focused_tab_id: "w1:t1",
      focused_pane_id: "w1:p1",
      workspaces: boxWorkspaces.map((w, index) => ({
        workspace_id: w.id,
        number: index + 1,
        label: w.label,
        focused: index === 0,
        pane_count: countOf(w.id),
        tab_count: 1,
        active_tab_id: `${w.id}:t1`,
        agent_status: statusOf(w.id),
      })),
      tabs: boxWorkspaces.map((w, index) => ({
        tab_id: `${w.id}:t1`,
        workspace_id: w.id,
        number: 1,
        label: "main",
        focused: index === 0,
        pane_count: countOf(w.id),
        agent_status: statusOf(w.id),
      })),
      panes,
      layouts: [],
      agents,
    },
  };
}

/** The two demo machines, with times relative to `startUnixMs`. */
export function demoHosts(fixtures: DemoFixtures, startUnixMs: number): DemoHost[] {
  return [macMini(fixtures, startUnixMs), buildBox(fixtures, startUnixMs)];
}
