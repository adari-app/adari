// Transcript lines for background work, in the shapes Claude Code records,
// ids and text invented: a background Bash call and its launch
// result, a Monitor call and its start, a task's notice, and Agent calls
// (foreground and background). Shared by the Running strip's and the
// subagent steps' tests; chat-running.test.ts keeps its own copies.

import { json, session, stamp, user } from "./chat-lines";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

export const tasksFolder = "/private/tmp/claude-501/-Users-fixture-proj/5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f/tasks";

export const typed = (text: string, uuid: string, second: number): string =>
  user(text, uuid, second, { promptSource: "typed", turnOrigin: "human", origin: { kind: "human" } });

export function assistantTool(id: string, name: string, input: { [key: string]: JSONValue }, uuid: string, second: number): string {
  return json({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "assistant",
    uuid,
    message: { content: [{ id, input, name, type: "tool_use" }], id: "msg_" + uuid, role: "assistant", stop_reason: "tool_use", type: "message" },
  });
}

export const backgroundBash = (id: string, command: string, description: string, uuid: string, second: number): string =>
  assistantTool(id, "Bash", { command, description, run_in_background: true, timeout: 600_000 }, uuid, second);

export const monitorCall = (id: string, command: string, description: string, uuid: string, second: number): string =>
  assistantTool(id, "Monitor", { command, description, timeout_ms: 1_800_000 }, uuid, second);

export const agentCall = (id: string, description: string, prompt: string, uuid: string, second: number, background: boolean): string =>
  assistantTool(id, "Agent", { description, prompt, subagent_type: "Explore", run_in_background: background }, uuid, second);

export function toolResult(id: string, text: string, toolUseResult: JSONValue, uuid: string, second: number): string {
  return json({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    toolUseResult,
    type: "user",
    uuid,
    message: { content: [{ content: text, is_error: false, tool_use_id: id, type: "tool_result" }], role: "user" },
  });
}

export const shellLaunched = (id: string, taskID: string, uuid: string, second: number): string =>
  toolResult(id, `Command running in background with ID: ${taskID}. Output is being written to: ${tasksFolder}/${taskID}.output`, { backgroundTaskId: taskID, stdout: "", stderr: "" }, uuid, second);

export const monitorLaunched = (id: string, taskID: string, uuid: string, second: number): string =>
  toolResult(id, `Monitor started (task ${taskID}, expires in 30m unless the source ends first; events arrive as notifications)`, { persistent: false, taskId: taskID, timeoutMs: 1_800_000 }, uuid, second);

/** A background agent's launch result: it names the agent's id. */
export const agentLaunched = (id: string, agentID: string, uuid: string, second: number): string =>
  toolResult(id, `Async agent launched successfully.\nagentId: ${agentID} (internal ID - do not mention to user.)`, { agentId: agentID, isAsync: true, status: "async_launched" }, uuid, second);

export function notice(fields: { task: string; toolUse: string; status?: string; summary?: string; event?: string }): string {
  const parts = ["<task-notification>", `<task-id>${fields.task}</task-id>`, `<tool-use-id>${fields.toolUse}</tool-use-id>`, `<output-file>${tasksFolder}/${fields.task}.output</output-file>`];
  if (fields.status !== undefined) parts.push(`<status>${fields.status}</status>`);
  if (fields.summary !== undefined) parts.push(`<summary>${fields.summary}</summary>`);
  if (fields.event !== undefined) parts.push(`<event>${fields.event}</event>`);
  parts.push("</task-notification>");
  return parts.join("\n");
}

/** A notice written as a queue-operation line. */
export const queued = (text: string, second: number): string =>
  json({ content: text, operation: "enqueue", sessionId: session, timestamp: stamp(second), type: "queue-operation" });

/**
 * A turn running all three kinds: a background shell (2 s), a monitor (3 s)
 * with one event (10 s), a background agent (4 s), and a foreground agent
 * (5 s) still working.
 */
export const busyTurn: readonly string[] = [
  typed("Start the server, watch the build and look around", "u1", 0),
  backgroundBash("toolu_sh", "npm run dev -- --port 5173\nsleep 1\necho ready", "Start the dev server", "a1", 2),
  shellLaunched("toolu_sh", "b7k2q9", "r1", 2),
  monitorCall("toolu_mon", "tail -f build.log | grep --line-buffered ERROR", "Watch the build for errors", "a2", 3),
  monitorLaunched("toolu_mon", "m4x8", "r2", 3),
  agentCall("toolu_bga", "Check the phone layout", "Open the phone layout and check the chips row fits at 375 pt.\nReport any overflow.", "a3", 4, true),
  agentLaunched("toolu_bga", "a1b2c3d4e5f60718", "r3", 4),
  agentCall("toolu_fga", "Read the banner", "Read Banner.swift and say what sets its line limit.", "a4", 5, false),
  queued(notice({ task: "m4x8", toolUse: "toolu_mon", status: "running", event: "ERROR src/a.ts: missing semicolon" }), 10),
];

// MARK: a subagent's own transcript (fixtures only)

/** The session's subagents folder beside the fixture transcript (chat-lines' claudePath). */
export const subagentsFolder = "/Users/fixture/.claude/projects/-Users-fixture-proj/5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f/subagents";

/** The foreground agent's id (its launch result gives none while it runs). */
export const foregroundAgentID = "f9e8d7c6b5a40312";

/** A subagent's meta.json: `toolUseId` names the parent's Agent call. */
export const subagentMeta = (toolUseID: string, finished: boolean, description = "Read the banner"): string =>
  json({ agentType: "Explore", description, finished, isBuiltIn: true, launchedWithDefaults: true, requestNonInteractive: false, requestShape: "agent", spawnDepth: 1, toolUseId: toolUseID }) + "\n";

/** The prompt line that opens a subagent's transcript. */
export const subagentPrompt = (agentID: string, text: string, uuid: string, second: number): string =>
  json({ agentId: agentID, isSidechain: true, message: { content: text, role: "user" }, parentUuid: null, sessionId: session, timestamp: stamp(second), type: "user", uuid }) + "\n";

/** One assistant line of a subagent's transcript calling `name`. */
export const subagentTool = (agentID: string, id: string, name: string, input: { [key: string]: JSONValue }, uuid: string, second: number): string =>
  json({
    agentId: agentID,
    isSidechain: true,
    message: { content: [{ type: "text", text: "Looking." }, { id, input, name, type: "tool_use" }], id: "msg_" + uuid, role: "assistant", stop_reason: "tool_use", type: "message" },
    parentUuid: null,
    sessionId: session,
    timestamp: stamp(second),
    type: "assistant",
    uuid,
  }) + "\n";

/** A subagent's tool result line. */
export const subagentResult = (agentID: string, id: string, text: string, uuid: string, second: number): string =>
  json({
    agentId: agentID,
    isSidechain: true,
    message: { content: [{ content: text, is_error: false, tool_use_id: id, type: "tool_result" }], role: "user" },
    parentUuid: null,
    sessionId: session,
    timestamp: stamp(second),
    type: "user",
    uuid,
  }) + "\n";
