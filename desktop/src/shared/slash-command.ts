// A line you typed that starts with `/` and a command
// name is a command for Claude Code or Codex (`/model opus`, `/compact keep
// the plan`, `/plugin:skill args`). One line only; a path ("/Users/…", "/tmp/x")
// is a message: its first word has another "/" in it.

const commandLine = /^\/[A-Za-z][A-Za-z0-9_:.-]*(?:[ \t]+[^\n\r]*)?$/;

export function isSlashCommand(text: string): boolean {
  const line = text.trim();
  if (line === "" || /[\n\r]/.test(line)) return false;
  return commandLine.test(line);
}

/** The agents that take a typed command line (the prompt route's kinds). */
export function takesCommands(kind: string | null | undefined): boolean {
  return kind === "claude" || kind === "codex";
}
