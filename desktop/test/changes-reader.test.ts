// Changes' git reads (HerdrKit AgentChangesGitTests: the gate, the timeout,
// cancellation, the bounds): the commands on one Mac run through its gate (3 at
// once), each with its 5 s timeout and its bound; a cancel stops a waiting one
// and ends a running one; a failed runner reads as a failure, never as a clean
// folder.

import { describe, expect, it } from "vitest";

import { defaultChangesLimits, changesLimits, gitFileChange } from "../src/shared/changes/git";
import { AgentChangesGitReader, ChangesCancelled, CommandGate, type ReadOnlyCommandRunner } from "../src/shared/changes/reader";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Answers `output` after `delayMs`, or rejects at once when its signal aborts. */
class FakeGit implements ReadOnlyCommandRunner {
  aborted = 0;
  constructor(
    private readonly output: string,
    private readonly delayMs: number,
  ) {}

  runReadOnlyCommand(_command: string, _max: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(this.output), this.delayMs);
      signal?.addEventListener(
        "abort",
        () => {
          this.aborted += 1;
          clearTimeout(timer);
          reject(new Error("closed"));
        },
        { once: true },
      );
    });
  }
}

class FailingRunner implements ReadOnlyCommandRunner {
  runs = 0;
  runReadOnlyCommand(): Promise<string> {
    this.runs += 1;
    return Promise.reject(new Error("cannot connect"));
  }
}

class RecordingRunner implements ReadOnlyCommandRunner {
  readonly asked: { command: string; max: number }[] = [];
  runReadOnlyCommand(command: string, max: number): Promise<string> {
    this.asked.push({ command, max });
    return Promise.resolve("");
  }
}

describe("the gate", () => {
  it("runs three at once and frees every permit", async () => {
    const gate = new CommandGate(3);
    let inFlight = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        gate.run(async () => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          await sleep(20);
          inFlight -= 1;
        }),
      ),
    );
    expect(most).toBe(3);
    expect(gate.available).toBe(3);
  });

  it("takes a command waiting its turn out of the line when it is cancelled", async () => {
    const gate = new CommandGate(1);
    const holder = new AbortController();
    const held = gate.run(() => sleep(200), holder.signal);
    await sleep(10);
    const waiter = new AbortController();
    let ran = false;
    const waiting = gate.run(async () => {
      ran = true;
      return "ran";
    }, waiter.signal);
    await sleep(10);
    waiter.abort();
    await expect(waiting).rejects.toBeInstanceOf(ChangesCancelled);
    await held;
    expect(ran).toBe(false);
    expect(gate.available).toBe(1);
  });
});

describe("the reader", () => {
  it("times a command out that does not answer, and ends it", async () => {
    const runner = new FakeGit("", 10_000);
    const reader = new AgentChangesGitReader(runner, new CommandGate(3), changesLimits({ timeoutMs: 50 }));
    const started = Date.now();
    expect(await reader.status("/r")).toEqual({ kind: "timedOut" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await reader.fileDiff("/r", gitFileChange("a", " ", "M"))).toEqual({ kind: "timedOut" });
    expect(await reader.commits("/r", -Infinity)).toEqual({ kind: "timedOut" });
    expect(runner.aborted, "each timed-out exec is closed").toBe(3);
  });

  it("throws ChangesCancelled when cancelled, and a failed runner fails", async () => {
    const runner = new FakeGit("", 10_000);
    const reader = new AgentChangesGitReader(runner, new CommandGate(3), defaultChangesLimits);
    const cancel = new AbortController();
    const read = reader.status("/r", cancel.signal);
    await sleep(20);
    cancel.abort();
    await expect(read).rejects.toBeInstanceOf(ChangesCancelled);
    expect(runner.aborted).toBe(1);
    const done = new AbortController();
    done.abort();
    await expect(reader.status("/r", done.signal), "cancelled before it starts").rejects.toBeInstanceOf(ChangesCancelled);

    const failing = new AgentChangesGitReader(new FailingRunner(), new CommandGate(3), defaultChangesLimits);
    expect(await failing.status("/r")).toEqual({ kind: "failed" });
    expect(await failing.commits("/r", -Infinity)).toEqual({ kind: "failed" });
    expect(await failing.show("/r", "a".repeat(40))).toEqual({ kind: "failed" });
    expect(await failing.show("/r", "HEAD"), "not a hash: nothing runs").toEqual({ kind: "failed" });
  });

  it("asks the runner for a little more than the bound (the Mac's head -c cuts there)", async () => {
    const runner = new RecordingRunner();
    const reader = new AgentChangesGitReader(runner, new CommandGate(3), defaultChangesLimits);
    await reader.status("/r");
    await reader.fileDiff("/r", gitFileChange("a", "M", " "));
    await reader.show("/r", "a".repeat(40));
    await reader.commits("/r", -Infinity);
    expect(runner.asked.map((a) => a.max)).toEqual([262_144 + 4_096, 262_144 + 4_096, 524_288 + 4_096, 64 * 1_024 + 4_096]);
    expect(runner.asked[0]!.command).toContain("head -c 262144");
    expect(runner.asked[2]!.command).toContain("head -c 524288");
    expect(defaultChangesLimits.folders).toBe(20);
    expect(defaultChangesLimits.commandsAtOnce).toBe(3);
    expect(defaultChangesLimits.timeoutMs).toBe(5_000);
    expect(defaultChangesLimits.statusBytes).toBe(256 * 1_024);
    expect(defaultChangesLimits.fileDiffBytes).toBe(256 * 1_024);
    expect(defaultChangesLimits.commitBytes).toBe(512 * 1_024);
  });

  it("does not read an untracked folder (git lists the folder, not its files)", async () => {
    const runner = new RecordingRunner();
    const reader = new AgentChangesGitReader(runner, new CommandGate(3), defaultChangesLimits);
    expect(await reader.fileDiff("/r", gitFileChange("dir/", "?", "?"))).toEqual({ kind: "text", text: { parts: [], cut: false } });
    expect(runner.asked).toEqual([]);
  });
});
