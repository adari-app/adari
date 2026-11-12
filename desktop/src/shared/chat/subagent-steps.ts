// A running subagent's current step. Claude Code
// writes each subagent's own transcript beside the session's:
// `<session folder>/subagents/agent-<agentId>.jsonl`, with
// `agent-<agentId>.meta.json` holding `toolUseId` (the parent's Agent call id)
// and `finished`. The feed reads, for each subagent its timeline holds
// running, that file's tail (never more than `subagentTailBytes`) and takes
// its newest tool call, in the tool rows' words (model.ts toolStepText). A
// background agent's id is in its launch result; a foreground one's file is
// found by listing the folder and matching meta.json's toolUseId. Read only
// while it runs and Chat is on show, at most once a `intervalMs`; no more
// once meta.json says finished. A folder or file that does not read leaves
// the agent without a step (never an error of the chat's). The twin of
// HerdrKit's ChatSubagentSteps.swift.

import { claudeToolCall } from "./claude-parser";
import type { TranscriptFileReader } from "./feed";
import { toolStepText, type ChatSubagent } from "./model";
import { asArray, asObject, asString, isObject } from "./tools";

/** The names directly inside a folder on the agent's machine, read only (an SFTP readdir). */
export interface TranscriptFolderListing {
  list(folder: string): Promise<readonly string[]>;
}

export const isFolderListing = (reader: unknown): reader is TranscriptFolderListing =>
  typeof reader === "object" && reader !== null && typeof (reader as { list?: unknown }).list === "function";

/** A subagent transcript is read from its end: at most this much. */
export const subagentTailBytes = 64 * 1_024;
/** meta.json is small: no more than this is read. */
export const maxSubagentMetaBytes = 16 * 1_024;
/** At most this many new meta.json files are read in one pass (each one once). */
export const maxMetaReadsPerPass = 16;
/** A folder listing past this many names is not looked through further. */
export const maxListedNames = 2_000;
export const defaultStepIntervalMs = 1_000;
/**
 * A pass runs beside the follow (never holding it up) and issues no request after this long; its
 * follow reads on meanwhile, and the next pass starts once it is over.
 */
export const stepPassMs = 5_000;

/**
 * Whether a pass may go on: its follow is current, not paused, Chat on show (and within its time);
 * with a call id, also that call still runs. Checked before and after every request and before anything is kept.
 */
export type StepPassAlive = (callID?: string) => boolean;

const agentIDPattern = /^[A-Za-z0-9_-]{1,128}$/;

/** `<transcript minus .jsonl>/subagents`, or null for a file that is not a Claude transcript. */
export function subagentsFolderOf(transcript: string): string | null {
  if (!transcript.endsWith(".jsonl")) return null;
  return transcript.slice(0, -".jsonl".length) + "/subagents";
}

export interface SubagentMeta {
  readonly toolUseID: string | null;
  readonly finished: boolean;
}

/** meta.json's toolUseId and finished; null when it does not parse. */
export function subagentMetaOf(bytes: Uint8Array): SubagentMeta | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const object = asObject(value);
  if (object === null) return null;
  const toolUseID = asString(object.toolUseId);
  return { toolUseID: toolUseID !== null && toolUseID.length > 0 ? toolUseID : null, finished: object.finished === true };
}

/**
 * The newest tool call's step in a transcript's tail, or null when it holds none. `whole`: the bytes start
 * at the file's start; otherwise the first line is cut and is not read.
 */
export function newestStep(bytes: Uint8Array, whole: boolean): string | null {
  const lines = new TextDecoder().decode(bytes).split("\n");
  if (!whole) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0 || !line.includes("tool_use")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const object = asObject(value);
    if (object === null || asString(object.type) !== "assistant") continue;
    const content = asArray(asObject(object.message)?.content) ?? [];
    for (let item = content.length - 1; item >= 0; item -= 1) {
      const part = content[item];
      if (!isObject(part) || asString(part.type) !== "tool_use") continue;
      const name = asString(part.name) ?? "";
      if (name.length === 0) continue;
      const step = toolStepText(claudeToolCall(asString(part.id) ?? "", name, asObject(part.input) ?? {}, null));
      if (step.length > 0) return step;
    }
  }
  return null;
}

/** What the feed reads with: its own reader (a listing when the reader has one). */
export type SubagentStepReader = Pick<TranscriptFileReader, "size" | "read"> & Partial<TranscriptFolderListing>;

interface Followed {
  /** The subagent transcript's size at the last read, and the step read from it. */
  size: number;
  step: string | null;
}

/** One feed's reads of its running subagents' steps. */
export class SubagentSteps {
  /** agentId → the Agent call id its meta.json names (read once each). */
  private readonly owners = new Map<string, string>();
  /** Agent ids whose meta.json said finished: never read again. */
  private readonly finished = new Set<string>();
  private readonly followed = new Map<string, Followed>();
  private lastPass = Number.NEGATIVE_INFINITY;
  /** Bytes read (diagnostics, tests). */
  bytesRead = 0;

  constructor(
    private readonly intervalMs: number = defaultStepIntervalMs,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A pass is due: none in the last `intervalMs`. */
  get due(): boolean {
    return this.now() - this.lastPass >= this.intervalMs;
  }

  /** How many agents its memory holds (owners, finished, followed: diagnostics, tests). */
  get known(): number {
    return this.owners.size + this.finished.size + this.followed.size;
  }

  /**
   * One pass: each running agent's newest step (call id → step, null when none is known). Never throws: what
   * does not read is left without a step. `alive` is asked before and after every request and
   * before anything is kept; once it says no, the pass reads and keeps nothing more (a call that ended is skipped).
   */
  async read(
    reader: SubagentStepReader,
    transcript: string,
    agents: readonly ChatSubagent[],
    alive: StepPassAlive = () => true,
  ): Promise<Map<string, string | null>> {
    this.lastPass = this.now();
    const steps = new Map<string, string | null>();
    const folder = subagentsFolderOf(transcript);
    const running = agents.filter((agent) => agent.state === "running");
    if (folder === null || running.length === 0) return steps;
    const found = new Map<string, string>();
    for (const [agentID, callID] of this.owners) found.set(callID, agentID);
    // A foreground agent's id is not in the parent transcript while it runs: its meta.json names its call.
    const unmatched = running.filter((agent) => agent.agentID === null && !found.has(agent.id));
    if (unmatched.length > 0 && isFolderListing(reader) && alive()) {
      try {
        const names = (await reader.list(folder)).slice(0, maxListedNames);
        if (!alive()) return steps;
        let reads = 0;
        for (const name of names) {
          const match = /^agent-(.+)\.meta\.json$/.exec(name);
          const agentID = match?.[1];
          if (agentID === undefined || !agentIDPattern.test(agentID) || this.owners.has(agentID) || this.finished.has(agentID)) continue;
          if (reads >= maxMetaReadsPerPass) break;
          reads += 1;
          const meta = await this.meta(reader, folder, agentID);
          if (!alive()) return steps;
          if (meta?.toolUseID == null) continue;
          this.owners.set(agentID, meta.toolUseID);
          found.set(meta.toolUseID, agentID);
          if (meta.finished) this.finished.add(agentID);
        }
      } catch {
        // The folder does not read: those agents show without a step.
      }
    }
    for (const agent of running) {
      if (!alive()) return steps;
      // A call that ended while the pass ran is not read on.
      if (!alive(agent.id)) continue;
      const agentID = agent.agentID ?? found.get(agent.id) ?? null;
      if (agentID === null || !agentIDPattern.test(agentID)) {
        steps.set(agent.id, null);
        continue;
      }
      const step = await this.step(reader, folder, agentID, agent.id, alive);
      if (!alive(agent.id)) continue;
      steps.set(agent.id, step);
    }
    return steps;
  }

  private async meta(reader: SubagentStepReader, folder: string, agentID: string): Promise<SubagentMeta | null> {
    try {
      const bytes = await reader.read(`${folder}/agent-${agentID}.meta.json`, 0, maxSubagentMetaBytes);
      this.bytesRead += bytes.length;
      return subagentMetaOf(bytes);
    } catch {
      return null;
    }
  }

  /**
   * The agent's newest step: its meta.json checked (its call's, not finished), then its transcript's tail when it
   * grew. No request and nothing kept once `alive` says no for the call.
   */
  private async step(reader: SubagentStepReader, folder: string, agentID: string, callID: string, alive: StepPassAlive): Promise<string | null> {
    const kept = this.followed.get(agentID) ?? null;
    if (this.finished.has(agentID)) return kept?.step ?? null;
    try {
      const meta = await this.meta(reader, folder, agentID);
      if (!alive(callID) || meta === null) return kept?.step ?? null;
      if (meta.toolUseID !== null && meta.toolUseID !== callID) return null;
      if (meta.toolUseID !== null) this.owners.set(agentID, meta.toolUseID);
      if (meta.finished) {
        this.finished.add(agentID);
        return kept?.step ?? null;
      }
      const path = `${folder}/agent-${agentID}.jsonl`;
      const size = await reader.size(path);
      if (!alive(callID)) return kept?.step ?? null;
      if (kept !== null && kept.size === size) return kept.step;
      const offset = Math.max(0, size - subagentTailBytes);
      const bytes = await reader.read(path, offset, size - offset);
      this.bytesRead += bytes.length;
      if (!alive(callID)) return kept?.step ?? null;
      const step = newestStep(bytes, offset === 0) ?? kept?.step ?? null;
      this.followed.set(agentID, { size, step });
      return step;
    } catch {
      return kept?.step ?? null;
    }
  }
}
