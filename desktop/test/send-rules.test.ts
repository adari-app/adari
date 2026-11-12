// The Swift app's Send rule as the desktop applies it (src/main/herdr/send.ts):
// CompanionMessageFraming, CompanionMessageRefusal, CompanionMessageRoute and
// CompanionMessageSender.deliver, the Send mode.

import { describe, expect, it } from "vitest";

import { DemoBackend, FixtureTransport, type DemoClock } from "../src/main/demo/demo-backend";
import { HerdrClient } from "../src/main/herdr/client";
import { ConnectTimedOutError, RequestTimedOutError } from "../src/main/herdr/errors";
import {
  agentKind,
  deliver,
  messageRoute,
  needsPaste,
  oneLineNote,
  pasteEnd,
  pasteStart,
  payload,
  planSend,
  promptRefusal,
  refusalText,
  notTakenText,
  unconfirmedText,
  type MessageWriter,
} from "../src/main/herdr/send";
import { APIError } from "../src/main/herdr/wire";

class RecordingWriter implements MessageWriter {
  readonly calls: unknown[][] = [];
  constructor(private readonly failure: Error | null = null) {}
  prompt(paneID: string, text: string): Promise<void> {
    this.calls.push(["prompt", paneID, text]);
    return this.failure === null ? Promise.resolve() : Promise.reject(this.failure);
  }
  sendInput(paneID: string, text: string, keys: readonly string[]): Promise<void> {
    this.calls.push(["input", paneID, text, keys]);
    return this.failure === null ? Promise.resolve() : Promise.reject(this.failure);
  }
}

describe("the Send rule", () => {
  it("sends a Claude or Codex agent's message as agent.prompt, lines and all", () => {
    expect(planSend("Fix it\nthen test", { isAgent: true, kind: "claude" })).toEqual({ kind: "prompt", text: "Fix it\nthen test" });
    expect(planSend("go\ton", { isAgent: true, kind: "codex" })).toEqual({ kind: "prompt", text: "go\ton" });
    expect(messageRoute(true, "claude")).toBe("prompt");
    expect(messageRoute(false, "claude")).toBe("paste");
    expect(messageRoute(true, "opencode")).toBe("paste");
    expect(messageRoute(true, null)).toBe("paste");
  });

  it("pastes another agent's message in paste markers with one Return", () => {
    expect(planSend("line one\nline two", { isAgent: true, kind: "opencode" })).toEqual({
      kind: "input",
      text: pasteStart + "line one\nline two" + pasteEnd,
      keys: ["Enter"],
    });
  });

  it("types a shell's one line plain and refuses lines", () => {
    expect(planSend("ls -la", { isAgent: false, kind: null })).toEqual({ kind: "input", text: "ls -la", keys: ["Enter"] });
    expect(planSend("ls\npwd", { isAgent: false, kind: null })).toEqual({ kind: "refused", reason: oneLineNote });
    expect(planSend("a\tb", { isAgent: false, kind: null })).toEqual({ kind: "refused", reason: oneLineNote });
  });

  it("refuses empty text and control characters, in the route's words", () => {
    expect(planSend("  \n ", { isAgent: true, kind: "claude" })).toEqual({ kind: "refused", reason: "Nothing to send." });
    expect(planSend("bell\u0007", { isAgent: true, kind: "claude" })).toEqual({
      kind: "refused",
      reason: "Not sent: the text has control characters that cannot be sent safely.",
    });
    expect(planSend("esc\u001b[2J", { isAgent: false, kind: null })).toEqual({
      kind: "refused",
      reason: "Not sent: the text has control characters that cannot be pasted safely.",
    });
    expect(planSend("c1\u0085", { isAgent: true, kind: "opencode" }).kind).toBe("refused");
    expect(planSend("del\u007f", { isAgent: true, kind: "opencode" }).kind).toBe("refused");
  });

  it("frames as CompanionMessageFraming.payload does", () => {
    expect(payload("", true)).toEqual({ ok: false, refusal: "empty" });
    expect(payload("a\nb", false)).toEqual({ ok: false, refusal: "noBracketedPaste" });
    expect(payload("a\nb", null)).toEqual({ ok: false, refusal: "terminalNotAttached" });
    expect(payload("one", null)).toEqual({ ok: true, text: "one" });
    expect(payload("one", true)).toEqual({ ok: true, text: pasteStart + "one" + pasteEnd });
    expect(needsPaste("a\rb")).toBe(true);
    expect(needsPaste("ab")).toBe(false);
    expect(refusalText("noBracketedPaste", "paste")).toContain("bracketed paste off");
  });

  it("names the agent kind from Herdr's agent entry, else the pane", () => {
    expect(agentKind({ agent: "Claude" }, { agent: "codex" })).toBe("claude");
    expect(agentKind(null, { agent: "Codex" })).toBe("codex");
    expect(agentKind(null, { agent: "" })).toBeNull();
    expect(agentKind(null, null)).toBeNull();
  });

  it("words Herdr's refusals of a prompt as the Swift app does", () => {
    expect(promptRefusal(new APIError("agent_blocked", "x"))).toBe(
      "Not sent: Herdr says the agent is waiting for an answer in its terminal. The text is kept.",
    );
    expect(promptRefusal(new APIError("agent_input_pending", "x"))).toContain("waiting for an answer");
    expect(promptRefusal(new APIError("agent_not_ready", "x"))).toBe("Not sent: the agent is not ready for a message yet. The text is kept.");
    expect(promptRefusal(new APIError("invalid_request", "unknown variant `agent.prompt`"))).toContain("Update Herdr on the Mac");
    expect(promptRefusal(new APIError("invalid_request", "bad params"))).toBe("Not sent: Herdr refused the message (invalid_request). The text is kept.");
    expect(promptRefusal(new APIError("agent_dialog", "The agent shows a dialog; answer it in its terminal."))).toBe(
      "The agent shows a dialog; answer it in its terminal. The text is kept.",
    );
    expect(promptRefusal(new APIError("weird", "x"))).toBe("Not sent: Herdr refused the message (weird). The text is kept.");
  });
});

describe("delivering", () => {
  it("writes exactly one request per Send", async () => {
    const writer = new RecordingWriter();
    await deliver(writer, "w1:p1", planSend("hello", { isAgent: true, kind: "claude" }));
    await deliver(writer, "w1:p2", planSend("ls", { isAgent: false, kind: null }));
    expect(writer.calls).toEqual([
      ["prompt", "w1:p1", "hello"],
      ["input", "w1:p2", "ls", ["Enter"]],
    ]);
  });

  it("writes nothing for a refused plan and rejects with its note", async () => {
    const writer = new RecordingWriter();
    await expect(deliver(writer, "w1:p1", planSend("a\nb", { isAgent: false, kind: null }))).rejects.toThrow(oneLineNote);
    expect(writer.calls).toEqual([]);
  });

  it("maps failures: Herdr's refusal, nothing written, or not confirmed", async () => {
    const plan = planSend("hello", { isAgent: true, kind: "claude" });
    await expect(deliver(new RecordingWriter(new APIError("agent_not_ready", "x")), "p", plan)).rejects.toThrow("not ready");
    await expect(deliver(new RecordingWriter(new ConnectTimedOutError("box")), "p", plan)).rejects.toThrow(/^Not sent: couldn't reach box/);
    // A prompt out of time is not claimed as sent; a paste with no answer may have landed.
    await expect(deliver(new RecordingWriter(new RequestTimedOutError(10)), "p", plan)).rejects.toThrow(notTakenText("the agent"));
    await expect(deliver(new RecordingWriter(new RequestTimedOutError(10)), "p", plan, "claude")).rejects.toThrow(
      "Not sent: Claude Code did not take the message. It is still in the box.",
    );
    const paste = planSend("hello", { isAgent: false, kind: null });
    await expect(deliver(new RecordingWriter(new RequestTimedOutError(10)), "p", paste)).rejects.toThrow(unconfirmedText);
    // A reply lost after the prompt went out (a closed channel) may have landed: not called "Not sent".
    await expect(deliver(new RecordingWriter(new Error("channel closed")), "p", plan, "claude")).rejects.toThrow(unconfirmedText);
  });

  it("encodes agent.prompt as the Swift client does", () => {
    const client = new HerdrClient(new FixtureTransport({}));
    expect(JSON.parse(client.encodeRequest("agent.prompt", { target: "w1:p1", text: "hi" }))).toEqual({
      id: "herdrkit:agent.prompt:1",
      method: "agent.prompt",
      params: { target: "w1:p1", text: "hi" },
    });
  });

  it("answers a demo prompt and writes it into the demo transcript a moment later", async () => {
    const scheduled: (() => void)[] = [];
    const clock: DemoClock = {
      schedule(run) {
        scheduled.push(run);
        return () => undefined;
      },
    };
    const { demoHosts } = await import("../src/main/demo/demo-hosts");
    const { bundledFixturesForTests } = await import("./support/demo-fixtures");
    const [mac] = demoHosts(bundledFixturesForTests(), Date.UTC(2026, 10, 2, 5, 0, 0));
    const backend = new DemoBackend(mac!, bundledFixturesForTests(), clock, () => Date.UTC(2026, 10, 2, 5, 1, 0));
    const reader = backend.transcripts();
    const path = (await reader.locate({ format: "claude", lookup: { kind: "id", id: mac!.transcripts[0]!.sessionID } }))!;
    const before = await reader.size(path);
    await backend.prompt("w7:p1G", "also the phone");
    expect(JSON.parse(backend.transport.requests.at(-1)!)).toMatchObject({ method: "agent.prompt", params: { target: "w7:p1G", text: "also the phone" } });
    expect(await reader.size(path)).toBe(before);
    scheduled.forEach((run) => run());
    const after = await reader.size(path);
    const added = new TextDecoder().decode(await reader.read(path, before, after - before));
    expect(JSON.parse(added)).toMatchObject({ type: "attachment", attachment: { type: "queued_command", prompt: "also the phone" } });
  });
});
