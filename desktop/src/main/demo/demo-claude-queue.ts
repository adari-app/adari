// Captures 175-176, development builds only: a demo Claude pane whose turn runs on while the user's
// messages wait in Claude Code's queue, drawn as Claude Code 2.1.322 draws it: each queued message
// under the running turn with "ctrl+enter to send now", and "Press up to edit queued messages" in
// the box. Its keys act as Claude Code's do there: Up moves the queue into the input row, Ctrl+U empties a row,
// Backspace deletes a character (or joins a row to the one above). A message sent while it is on waits in it.

const width = 100;
const dashes = (count: number): string => "\u{2500}".repeat(count);

export class DemoClaudeQueue {
  private readonly queued: string[] = [];
  private input = "";

  constructor(
    /** The session's name in the box's top rule. */
    private readonly name: string,
    /** The running turn above the box. */
    private readonly above: readonly string[],
  ) {}

  /** The user's message, sent while the turn runs: it waits in the queue. */
  add(text: string): void {
    this.queued.push(text);
  }

  /** Keys as Herdr's agent.send_keys names them. */
  keys(keys: readonly string[]): void {
    for (const key of keys) {
      if (key === "Up") {
        if (this.input === "" && this.queued.length > 0) this.input = this.queued.splice(0).join("\n");
      } else if (key === "ctrl+u") {
        const at = this.input.lastIndexOf("\n");
        this.input = at < 0 ? "" : this.input.slice(0, at + 1);
      } else if (key === "Backspace" || key === "backspace") {
        this.input = this.input.slice(0, -1);
      }
    }
  }

  /** What `pane.read` shows. */
  screen(): string {
    const top = `${dashes(width - [...this.name].length - 6)} ${this.name} ${dashes(3)}`;
    const rows = this.input === "" ? [`\u{276F} ${this.queued.length > 0 ? "Press up to edit queued messages" : ""}`] : this.input.split("\n").map((line, index) => (index === 0 ? `\u{276F} ${line}` : `  ${line}`));
    return [
      ...this.above,
      "",
      "\u{273B} Cogitating\u{2026} (41s \u{00B7} \u{2193} 1.2k tokens \u{00B7} esc to interrupt)",
      ...this.queued.flatMap((text) => text.split("\n").map((line, index) => (index === 0 ? `  \u{23BF} ${line}` : `    ${line}`))),
      ...(this.queued.length > 0 ? ["    ctrl+enter to send now"] : []),
      "",
      top,
      ...rows,
      dashes(width),
      "  \u{23F5}\u{23F5} auto mode on (shift+tab to cycle)",
    ].join("\n");
  }
}
