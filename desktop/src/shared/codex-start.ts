// Every Codex start Adari makes runs without Codex's shared
// background server. Codex 0.167 runs its sessions through one `codex
// app-server`, started by whichever Codex came first; its hooks run there, with
// that first pane's environment, so Herdr's Codex hook reports a new session for
// the first pane (its HERDR_PANE_ID), not the new one. `--no-daemon` ("Run
// without the shared background server, even if it is already running"),
// taken by `codex` and by `codex resume`, keeps the hooks in the pane's own
// process. This is the one place that builds those lines and reads them back:
//
// - Herdr's own start (`agent.start`): `args: ["--no-daemon"]` for Codex, no
//   args for any other kind (herdrStartArgs);
// - a typed start (New agent with a command from ~/.adari/agents.json): the
//   command as written, plus ` --no-daemon` when its program is `codex` and
//   the flag is not there yet (withNoDaemon);
// - Resume and restart: `<start> resume <id> --no-daemon`, Codex's own hint's
//   order ("rerun the same command with --no-daemon (including resume or fork
//   and its arguments)") (codexResumeLine);
// - the parsers: the word after `resume`, `--no-daemon` before or after it
//   (codexResumeArgvID).

/** Codex's flag for a run without the shared background server. */
export const codexNoDaemonFlag = "--no-daemon";

/** A shell's `NAME=value` in front of a command (an environment assignment, not the program). */
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The program a typed command runs: its first word after any `NAME=value`, or null. */
export function commandProgram(command: string): string | null {
  const words = command.trim().split(/\s+/).filter((word) => word !== "");
  const program = words.find((word) => !assignment.test(word));
  return program ?? null;
}

/** The command runs Codex itself: its program is `codex` (or a path ending in `/codex`). */
export function runsCodex(command: string): boolean {
  const program = commandProgram(command);
  if (program === null) return false;
  return (program.split("/").at(-1) ?? "") === "codex";
}

/** The command has `--no-daemon` as one of its words. */
export function hasNoDaemon(command: string): boolean {
  return command.trim().split(/\s+/).includes(codexNoDaemonFlag);
}

/** `command` as written, plus ` --no-daemon` once when it runs Codex and does not carry the flag yet. */
export function withNoDaemon(command: string): string {
  if (!runsCodex(command) || hasNoDaemon(command)) return command;
  return `${command} ${codexNoDaemonFlag}`;
}

/** What Herdr's `agent.start` is given as `args` for `kind`: `["--no-daemon"]` for Codex, none for any other kind. */
export function herdrStartArgs(kind: string): readonly string[] | undefined {
  return kind.toLowerCase() === "codex" ? [codexNoDaemonFlag] : undefined;
}

/** The line that resumes Codex session `id` with `start` (the configured command or `codex`): `<start> resume <id>`, `--no-daemon` once when it runs Codex. */
export function codexResumeLine(start: string, id: string): string {
  return withNoDaemon(`${start} resume ${id}`);
}

/**
 * The session id a Codex argv resumes: the first word after `resume` that is not `--no-daemon` (so
 * `codex resume <id>`, `codex resume --no-daemon <id>`, `codex --no-daemon resume <id>` and
 * `codex resume <id> --no-daemon` all name `<id>`); null when there is no `resume`, nothing after it, or the word
 * there is another flag. The caller still checks the id.
 */
export function codexResumeArgvID(argv: readonly string[]): string | null {
  const at = argv.indexOf("resume");
  if (at < 0) return null;
  for (let index = at + 1; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (word === codexNoDaemonFlag) continue;
    return word.startsWith("-") ? null : word;
  }
  return null;
}
