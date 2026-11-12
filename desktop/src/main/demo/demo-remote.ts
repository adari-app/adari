// The demo machine's read-only commands: no shell runs. A
// command is answered from its intent with the same bytes the real one prints:
// `git log` in a demo agent's folder gives a few fixture commits made in the
// last hour (the away digest's commits), and a search gives grep's
// `#<index>:<path>` and `<path>:<line>:<offset>:<text>` lines over the demo
// transcripts (src/shared/search/command.ts reads them).

import type { DemoTranscript, DemoTranscriptReader } from "./demo-chat";
import type { RemoteCommand, RemoteCommandOutput, RemoteCommandRunner, RemoteSearchTarget } from "../../shared/remote-command";
import { OutputCollector, throwIfCancelled } from "../../shared/remote-command";
import { notARepositoryMarker } from "../../shared/away/readers";
import { isCatalogAgent } from "../../shared/model-catalog";
import { listMarkers } from "../model-catalogs";
import { demoModelLists } from "./demo-model-lists";

export interface DemoCommit {
  readonly hash: string;
  readonly minutesAgo: number;
  readonly subject: string;
}

/** Each demo folder's commits (newest first). */
const demoCommits: Readonly<Record<string, readonly DemoCommit[]>> = {
  "/Users/demo/code/worktrees/aurora-web-mac": [
    { hash: "4f9c2a7d1e3b5c6a8d0f2e4b6c8a0d2f4e6b8c0a", minutesAgo: 9, subject: "Mac app: the sidebar keeps its folds across launches" },
    { hash: "a1c3e5f7092b4d6f8a0c2e4f6a8c0e2f4a6c8e0b", minutesAgo: 24, subject: "Mac app: pane titles follow Herdr's labels" },
  ],
  "/Users/demo/code/worktrees/aurora-web-design": [
    { hash: "0b2d4f6a8c1e3a5c7e9b1d3f5a7c9e1b3d5f7a9c", minutesAgo: 6, subject: "Design: the chat column's spacing on wide windows" },
  ],
};

const encoder = new TextEncoder();

export class DemoRemote implements RemoteCommandRunner {
  private readonly startSeconds: number;

  constructor(
    private readonly transcripts: readonly DemoTranscript[],
    private readonly reader: DemoTranscriptReader,
    nowMs: number,
    /** Each folder's commits (the showcase has its own). */
    private readonly commits: Readonly<Record<string, readonly DemoCommit[]>> = demoCommits,
  ) {
    this.startSeconds = Math.floor(nowMs / 1000);
  }

  /** Capture 202: the agents whose list answers as over SSH with the login keychain locked (none unless a capture says). */
  readonly keychainLocked = new Set<string>();

  async run(command: RemoteCommand, maxOutputBytes: number, signal?: AbortSignal): Promise<RemoteCommandOutput> {
    throwIfCancelled(signal);
    const collector = new OutputCollector(maxOutputBytes);
    const intent = command.intent;
    if (intent.kind === "git-log") {
      collector.append(encoder.encode(this.gitLog(intent.folder, intent.since, intent.maxCount)));
    } else if (intent.kind === "model-list") {
      // The agent's list as the remote script prints it (between its markers); none: missing.
      const list = isCatalogAgent(intent.agent) && intent.agent !== "agy" ? demoModelLists[intent.agent] : null;
      // Framed with the read's own token, as the script frames it.
      const marks = listMarkers(intent.token);
      if (list === null) collector.append(encoder.encode(`${marks.missing}\n`));
      else if (this.keychainLocked.has(intent.agent)) {
        // Capture 202: Cursor Agent's answer over SSH, its login keychain locked.
        collector.append(encoder.encode(`\n${marks.begin}\n\n${marks.exit} 1\n${marks.error} Error: Your macOS login keychain is locked.\n${marks.error} Run security unlock-keychain and try again.\n`));
      } else collector.append(encoder.encode(`\n${marks.begin}\n${list}\n${marks.exit} 0\n`));
    } else {
      for (const target of intent.targets) {
        if (!(await this.search(target, intent.patterns, intent.maxHitsPerFile, collector))) break;
        throwIfCancelled(signal);
      }
    }
    return collector.output;
  }

  private gitLog(folder: string, since: number, maxCount: number): string {
    const commits = this.commits[folder];
    if (commits === undefined) return this.transcripts.some((transcript) => transcript.cwd === folder) ? "" : notARepositoryMarker + "\n";
    return commits
      .map((commit) => ({ ...commit, time: this.startSeconds - commit.minutesAgo * 60 }))
      .filter((commit) => commit.time >= Math.floor(since))
      .slice(0, maxCount)
      .map((commit) => `${commit.hash}\u001f${commit.time}\u001f${commit.subject}\u001e\n`)
      .join("");
  }

  /** grep -F -i -a -H -b -n -m <max> over one target's file, as the search command prints it; false once the cap is reached. */
  private async search(target: RemoteSearchTarget, patterns: readonly string[], maxHits: number, collector: OutputCollector): Promise<boolean> {
    const file = await this.fileFor(target);
    if (file === null) return true;
    if (!collector.append(encoder.encode(`#${target.index}:${file}\n`))) return false;
    const bytes = await this.reader.read(file, 0, await this.reader.size(file));
    const folded = patterns.map((pattern) => asciiLower(encoder.encode(pattern)));
    let offset = 0;
    let lineNumber = 0;
    let hits = 0;
    while (offset < bytes.length && hits < maxHits) {
      let end = bytes.indexOf(10, offset);
      if (end < 0) end = bytes.length;
      lineNumber += 1;
      const line = bytes.subarray(offset, end);
      const lower = asciiLower(line);
      if (folded.some((pattern) => includes(lower, pattern))) {
        hits += 1;
        if (!collector.append(encoder.encode(`${file}:${lineNumber}:${offset}:`))) return false;
        if (!collector.append(line.subarray(0, 200))) return false;
        if (!collector.append(encoder.encode("\n"))) return false;
      }
      offset = end + 1;
    }
    return true;
  }

  private async fileFor(target: RemoteSearchTarget): Promise<string | null> {
    if (target.path !== null) {
      try {
        await this.reader.size(target.path);
        return target.path;
      } catch {
        return null;
      }
    }
    const lookup = target.lookup;
    if (lookup === null) return null;
    if (lookup.kind === "id") return this.transcripts.find((transcript) => transcript.sessionID === lookup.id)?.path ?? null;
    return this.transcripts.find((transcript) => transcript.agent === "claude" && transcript.cwd === lookup.folder)?.path ?? null;
  }
}

function asciiLower(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]!;
    out[i] = byte >= 65 && byte <= 90 ? byte + 32 : byte;
  }
  return out;
}

function includes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
