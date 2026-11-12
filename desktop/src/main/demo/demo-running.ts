// The demo's background work (invented content in Claude
// Code 2.1.318's line shapes, never a real transcript; ids made up). The Mac
// mini's marigold pane (Bellhop) ended its turn with three things still
// running: a dev server in the background, a monitor on the build log (one
// event so far) and a background agent whose own transcript sits beside the
// session's (subagents/agent-<id>.jsonl, its meta.json naming the Agent
// call), so the Running strip has a shell, a monitor and a subagent with its
// step. The tidepool pane (Tidepool) holds the same three after they ended: the
// command done, the monitor stopped by TaskStop, the agent's hand-back.

import type { DemoTranscript, Json } from "./demo-chat";
import { ClaudeLines, json } from "./demo-chat";

const boardCwd = "/Users/demo/code/marigold";
const tidepoolCwd = "/Users/demo/code/tidepool";
const boardSession = "7a3f0c2e-5b1d-4e6b-9c0d-6d656d6f0011";
const tidepoolSession = "7a3f0c2e-5b1d-4e6b-9c0d-6d656d6f0012";
export const demoRunningPaneId = "wB:p1";
export const demoRanPaneId = "wD:p1";
export const demoRunningAgentId = "a7c4e1f09b3d2856";

const tasks = (session: string): string => `/private/tmp/claude-501/-Users-demo-code/${session}/tasks`;

/**
 * Lines the demo's ClaudeLines has no helper for: a result with toolUseResult, a queue-operation notice.
 * (Made when called, never at load: demo-chat.ts imports this file.)
 */
interface RunningLines {
  readonly t: ClaudeLines;
  launched(id: string, text: string, toolUseResult: { [key: string]: Json }, second: number, uuid: string): RunningLines;
  notice(fields: { task: string; toolUse: string; status?: string; summary?: string; event?: string; result?: string }, second: number): RunningLines;
}

function runningLines(session: string, folder: string, startMs: number): RunningLines {
  const t = new ClaudeLines(session, folder, startMs, `demo-run-${session.slice(-4)}`);
  const at = (second: number): string => new Date(startMs + second * 1_000).toISOString();
  const lines: RunningLines = {
    t,
    launched(id, text, toolUseResult, second, uuid) {
      t.lines.push(
        json({
          cwd: folder,
          isSidechain: false,
          message: { content: [{ content: text, is_error: false, tool_use_id: id, type: "tool_result" }], role: "user" },
          sessionId: session,
          timestamp: at(second),
          toolUseResult,
          type: "user",
          uuid,
          version: "2.1.318",
        }),
      );
      return lines;
    },
    notice(fields, second) {
      const parts = ["<task-notification>", `<task-id>${fields.task}</task-id>`, `<tool-use-id>${fields.toolUse}</tool-use-id>`, `<output-file>${tasks(session)}/${fields.task}.output</output-file>`];
      if (fields.status !== undefined) parts.push(`<status>${fields.status}</status>`);
      if (fields.summary !== undefined) parts.push(`<summary>${fields.summary}</summary>`);
      if (fields.event !== undefined) parts.push(`<event>${fields.event}</event>`);
      if (fields.result !== undefined) parts.push(`<result>${fields.result}</result>`);
      parts.push("</task-notification>");
      t.lines.push(json({ content: parts.join("\n"), operation: "enqueue", sessionId: session, timestamp: at(second), type: "queue-operation" }));
      return lines;
    },
  };
  return lines;
}

/** The three calls both panes start: a dev server, a monitor on its log, a background agent on a phone's layout. */
function start(r: RunningLines, ids: { shell: string; monitor: string; agent: string }, command: { shell: string; monitor: string }): RunningLines {
  r.t.user("Start the dev server, watch the build for errors and have an agent check the board on a phone.", 0);
  r.t.tool("toolu_demo_run_1", "Bash", { command: command.shell, description: "Start the dev server", run_in_background: true }, 4);
  r.launched(
    "toolu_demo_run_1",
    `Command running in background with ID: ${ids.shell}. Output is being written to: /private/tmp/claude-501/tasks/${ids.shell}.output. You will be notified when it completes.`,
    { backgroundTaskId: ids.shell, interrupted: false, isImage: false, noOutputExpected: false, stderr: "", stdout: "" },
    4,
    `demo-run-1-${ids.shell}`,
  );
  r.t.tool("toolu_demo_run_2", "Monitor", { command: command.monitor, description: "Watch the build for errors", timeout_ms: 1_800_000 }, 7);
  r.launched(
    "toolu_demo_run_2",
    `Monitor started (task ${ids.monitor}, expires in 30m unless the source ends first; events arrive as notifications)`,
    { persistent: false, taskId: ids.monitor, timeoutMs: 1_800_000 },
    7,
    `demo-run-2-${ids.monitor}`,
  );
  r.t.tool(
    "toolu_demo_run_3",
    "Agent",
    {
      description: "Check the board on a phone",
      prompt: "Open the board at 375 pt wide and check every card fits: titles, the due chips and the avatars.\nReport any overflow with the file and line.",
      run_in_background: true,
      subagent_type: "general-purpose",
    },
    10,
  );
  r.launched(
    "toolu_demo_run_3",
    `Async agent launched successfully.\nagentId: ${ids.agent} (internal ID - do not mention to user. Use SendMessage with to: '${ids.agent}' to continue this agent.)`,
    { agentId: ids.agent, isAsync: true, status: "async_launched" },
    10,
    `demo-run-3-${ids.agent}`,
  );
  r.t.text("The dev server is starting, a monitor watches the build log, and an agent is checking the board at phone width. I'll tell you what they find.", 14, true);
  return r;
}

/** The background agent's own transcript: its prompt, a read, a search, then the phone tests running. */
function agentTranscript(session: string, agentID: string, startMs: number): string {
  const at = (second: number): string => new Date(startMs + second * 1_000).toISOString();
  let serial = 0;
  const line = (type: string, message: { [key: string]: Json }, second: number): string => {
    serial += 1;
    return json({ agentId: agentID, cwd: boardCwd, isSidechain: true, message, parentUuid: null, sessionId: session, timestamp: at(second), type, uuid: `demo-sub-${serial}`, version: "2.1.318" });
  };
  const tool = (id: string, name: string, input: { [key: string]: Json }, second: number): string =>
    line("assistant", { content: [{ id, input, name, type: "tool_use" }], id: `msg_demo_sub_${id}`, role: "assistant", stop_reason: "tool_use", type: "message" }, second);
  const result = (id: string, text: string, second: number): string => line("user", { content: [{ content: text, is_error: false, tool_use_id: id, type: "tool_result" }], role: "user" }, second);
  return [
    line("user", { content: "Open the board at 375 pt wide and check every card fits: titles, the due chips and the avatars.\nReport any overflow with the file and line.", role: "user" }, 10),
    tool("toolu_demo_sub_1", "Read", { file_path: `${boardCwd}/src/board/Card.tsx` }, 14),
    result("toolu_demo_sub_1", "     1\timport { DueChip } from './DueChip';", 15),
    tool("toolu_demo_sub_2", "Grep", { path: `${boardCwd}/src/board`, pattern: "min-width|white-space" }, 31),
    result("toolu_demo_sub_2", "src/board/DueChip.css:4:  white-space: nowrap;", 32),
    tool("toolu_demo_sub_3", "Bash", { command: "npx playwright test board.spec.ts --project=iphone-se", description: "Run the board's phone tests" }, 58),
  ]
    .map((each) => each + "\n")
    .join("");
}

/** The marigold pane: its turn ended with the three still running. */
function boardRunning(startMs: number): DemoTranscript {
  const base = startMs - 6 * 60_000 - 12_000;
  const r = start(
    runningLines(boardSession, boardCwd, base),
    { shell: "b3k7q2xd", monitor: "m9f2w4", agent: demoRunningAgentId },
    { shell: "npm run dev -- --port 5173", monitor: "tail -f .next/build.log | grep --line-buffered -E 'ERROR|WARN'" },
  );
  r.notice({ task: "m9f2w4", toolUse: "toolu_demo_run_2", status: "running", event: "WARN src/board/Card.tsx:88: Each child in a list should have a unique \"key\" prop." }, 96);
  const path = `/Users/demo/.claude/projects/-Users-demo-code-marigold/${boardSession}.jsonl`;
  const folder = `${path.slice(0, -".jsonl".length)}/subagents`;
  return {
    paneID: demoRunningPaneId,
    agent: "claude",
    sessionID: boardSession,
    path,
    cwd: boardCwd,
    working: false,
    lines: r.t.lines,
    files: {
      [`${folder}/agent-${demoRunningAgentId}.meta.json`]: json({
        agentType: "general-purpose",
        description: "Check the board on a phone",
        finished: false,
        isBuiltIn: true,
        launchedWithDefaults: true,
        requestNonInteractive: false,
        requestShape: "agent",
        spawnDepth: 1,
        toolUseId: "toolu_demo_run_3",
      }),
      [`${folder}/agent-${demoRunningAgentId}.jsonl`]: agentTranscript(boardSession, demoRunningAgentId, base),
    },
  };
}

/** The tidepool pane: the same three after they ended (the command done, the monitor stopped, the agent's report). */
function tidepoolRan(startMs: number): DemoTranscript {
  const base = startMs - 520 * 60_000 - 9 * 60_000;
  const r = start(
    runningLines(tidepoolSession, tidepoolCwd, base),
    { shell: "b5n8r1tz", monitor: "m2c6v8", agent: "c1d2e3f4a5b60789" },
    { shell: "npm run dev -- --port 5173", monitor: "tail -f render.log | grep --line-buffered -E 'ERROR|WARN'" },
  );
  r.notice({ task: "m2c6v8", toolUse: "toolu_demo_run_2", status: "running", event: "WARN scenes/04.json: narration longer than the scene" }, 96).notice(
    {
      task: "c1d2e3f4a5b60789",
      toolUse: "toolu_demo_run_3",
      status: "completed",
      summary: 'Agent "Check the board on a phone" completed',
      result: "Two cards overflow at 375 pt: the due chip in DueChip.css has no min-width, and long titles in Card.tsx:41 do not wrap.",
    },
    212,
  );
  r.t.text("The agent found two overflows at 375 pt: the due chip and long card titles. Stopping the monitor, the build is quiet.", 220);
  r.t.tool("toolu_demo_run_4", "TaskStop", { task_id: "m2c6v8" }, 222).result("toolu_demo_run_4", "Successfully stopped task: m2c6v8", 222);
  r.notice({ task: "b5n8r1tz", toolUse: "toolu_demo_run_1", status: "completed", summary: 'Background command "Start the dev server" completed (exit code 0)' }, 300);
  r.t.text("All three are done: the dev server exited cleanly, the monitor is stopped, and the two overflows are listed above.", 304, true);
  return {
    paneID: demoRanPaneId,
    agent: "claude",
    sessionID: tidepoolSession,
    path: `/Users/demo/.claude/projects/-Users-demo-code-tidepool/${tidepoolSession}.jsonl`,
    cwd: tidepoolCwd,
    working: false,
    lines: r.t.lines,
  };
}

/** The demo's two background-work transcripts. */
export function runningTranscripts(startMs: number): DemoTranscript[] {
  return [boardRunning(startMs), tidepoolRan(startMs)];
}
