// The Mac's start commands as the main process reads them (HerdrClient's
// agentStartCommands): once per backend (one per connection): every caller
// after the first, also one that arrives while the read runs, gets that read's
// result; a read that failed (unreadable) is asked again by the next caller.
// A backend that cannot read files has none (absent), with no request.
//
// Settings › Chat saves one kind's command
// (`saveStartCommandOf`): one save at a time per backend; the saved file, as
// the reader reads it, becomes that backend's start commands, so New agent,
// Resume and restart use it from then on (no read again needed).
// A save that waited behind another
// asks again, right before it writes, whether its machine may still be
// written (`ready`): the same machine, listed and connected. One queue per
// backend still.

import { absentStartCommands, parseStartCommands, startCommandsWith, type AgentStartCommands } from "../shared/start-commands";

export interface StartCommandsSource {
  /** The file's bytes (at most the limit plus one), or null when there is none; throws when the machine did not answer. */
  readStartCommandsFile?(): Promise<Uint8Array | null>;
  /** Writes `kind`'s command (empty: none) into the file; the file as read after. */
  saveStartCommand?(kind: string, command: string): Promise<AgentStartCommands>;
}

const loads = new WeakMap<StartCommandsSource, Promise<AgentStartCommands>>();
const saves = new WeakMap<StartCommandsSource, Promise<unknown>>();

export const cannotSaveText = "This machine cannot save start commands from here.";

export function startCommandsOf(source: StartCommandsSource): Promise<AgentStartCommands> {
  const running = loads.get(source);
  if (running !== undefined) return running;
  const read = source.readStartCommandsFile;
  if (read === undefined) return Promise.resolve(absentStartCommands);
  const load = read.call(source).then(parseStartCommands, (error: unknown) =>
    startCommandsWith({ type: "unreadable", reason: error instanceof Error ? error.message : String(error) }),
  );
  loads.set(source, load);
  void load.then((loaded) => {
    if (loaded.status.type === "unreadable" && loads.get(source) === load) loads.delete(source);
  });
  return load;
}

/**
 * Saves `kind`'s start command on the machine `source` reaches (after any save still running there),
 * and keeps what was saved as its start commands. Rejects with the reason when it did not save (nothing kept then).
 * `ready` runs when its turn comes, right before the write; it throws (the reason) when the machine may no
 * longer be written, and then nothing is written.
 */
export function saveStartCommandOf(source: StartCommandsSource, kind: string, command: string, ready?: () => void): Promise<AgentStartCommands> {
  const save = source.saveStartCommand;
  if (save === undefined) return Promise.reject(new Error(cannotSaveText));
  const before = saves.get(source) ?? Promise.resolve();
  const run = before
    .catch(() => undefined)
    .then(() => {
      ready?.();
      return save.call(source, kind, command);
    })
    .then((saved) => {
      loads.set(source, Promise.resolve(saved));
      return saved;
    });
  saves.set(source, run);
  void run.then(
    () => (saves.get(source) === run ? saves.delete(source) : undefined),
    () => (saves.get(source) === run ? saves.delete(source) : undefined),
  );
  return run;
}
