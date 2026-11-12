// The Model chip says the model. Claude Code now
// confirms /model with "Set model to 'Fable 5.2' and saved as your default for
// new sessions"; the chip reads the name alone, from old and new lines alike:
// a quoted name ends at its closing quote, an unquoted one before " and ",
// " for ", "(" or the end of the line, and a "name" longer than 40 characters
// is not one (the chip keeps the label it had).

import { describe, expect, it } from "vitest";

import { AgentSettingsReader, maxModelLabelLength, setModelLabel } from "../src/shared/agent-settings";

const session = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";

function assistant(model: string, second: number): string {
  return JSON.stringify({
    isSidechain: false,
    message: { content: [{ text: "Done.", type: "text" }], id: `msg_${second}`, model, role: "assistant", stop_reason: "end_turn", type: "message" },
    sessionId: session,
    timestamp: `2026-11-10T02:00:${String(second).padStart(2, "0")}.000Z`,
    type: "assistant",
    uuid: `a-${second}`,
  });
}

/** What /model printed, as Claude Code writes it in a user line. */
function printed(stdout: string, second: number): string {
  return JSON.stringify({
    isSidechain: false,
    message: { content: `<local-command-stdout>${stdout}</local-command-stdout>`, role: "user" },
    sessionId: session,
    timestamp: `2026-11-10T02:00:${String(second).padStart(2, "0")}.000Z`,
    type: "user",
    uuid: `o-${second}`,
  });
}

function chipAfter(lines: readonly string[]): string | null {
  const reader = new AgentSettingsReader("claude");
  let offset = 0;
  for (const line of lines) {
    reader.line(line, offset);
    offset += line.length + 1;
  }
  return reader.settings.modelLabel;
}

const fable = "Set model to 'Fable 5.2' and saved as your default for new sessions";

describe("the Model chip's name from Claude Code's /model line", () => {
  it("reads each confirmation, old and new", () => {
    expect(setModelLabel("Set model to Opus 5.5 (default)")).toBe("Opus 5.5");
    expect(setModelLabel("Set model to Default (Opus 5.5)")).toBe("Opus 5.5");
    expect(setModelLabel(fable)).toBe("Fable 5.2");
  });

  it("a quoted name ends at its closing quote, straight or curly", () => {
    expect(setModelLabel("Set model to 'Sonnet 5.5 (1M)' for this session")).toBe("Sonnet 5.5 (1M)");
    expect(setModelLabel('Set model to "Haiku 5.5" and saved')).toBe("Haiku 5.5");
    expect(setModelLabel("Set model to ‘Opus 5.5’ and saved as your default")).toBe("Opus 5.5");
    expect(setModelLabel("Set model to “Fable 5.2”")).toBe("Fable 5.2");
  });

  it("an unquoted name ends before ' and ', ' for ', '(' or the end of the line", () => {
    expect(setModelLabel("Set model to Fable 5.2 and saved as your default for new sessions")).toBe("Fable 5.2");
    expect(setModelLabel("Set model to Opus 5.5 for this session only")).toBe("Opus 5.5");
    expect(setModelLabel("Set model to Sonnet 5.5(1M context)")).toBe("Sonnet 5.5");
    expect(setModelLabel("Set model to Haiku 5.5\nsomething else")).toBe("Haiku 5.5");
    expect(setModelLabel("Set model to Haiku 5.5.")).toBe("Haiku 5.5");
    expect(setModelLabel("Set model to claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(setModelLabel("Set model to Default (claude-opus-5-5) and saved")).toBe("Opus 5.5");
  });

  it("a label longer than 40 characters is not accepted", () => {
    expect(maxModelLabelLength).toBe(40);
    const forty = "M".repeat(40);
    const fortyOne = "M".repeat(41);
    expect(setModelLabel(`Set model to ${forty}`)).toBe(forty);
    expect(setModelLabel(`Set model to ${fortyOne}`)).toBeNull();
    expect(setModelLabel(`Set model to '${fortyOne}' and saved as your default for new sessions`)).toBeNull();
    expect(setModelLabel("Set model to ")).toBeNull();
    expect(setModelLabel("Model unchanged")).toBeNull();
  });

  it("the chip reads Fable 5.2 after the new line, and keeps its label when a line names no model", () => {
    expect(chipAfter([assistant("claude-opus-5-5", 1), printed(fable, 2)])).toBe("Fable 5.2");
    expect(chipAfter([assistant("claude-opus-5-5", 1), printed("Set model to Default (Opus 5.5)", 2)])).toBe("Opus 5.5");
    expect(chipAfter([assistant("claude-opus-5-5", 1), printed(`Set model to ${"x".repeat(41)}`, 2)])).toBe("Opus 5.5");
    expect(chipAfter([printed(fable, 1), printed(`Set model to '${"y".repeat(41)}'`, 2)])).toBe("Fable 5.2");
  });

  it("never the old parse's whole tail", () => {
    const old = "'Fable 5.2' and saved as your default for new sessions";
    expect(old.length).toBeGreaterThan(maxModelLabelLength);
    expect(chipAfter([printed(fable, 1)])).not.toContain("saved");
  });
});
