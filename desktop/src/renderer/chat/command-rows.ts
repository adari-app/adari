// A command line you typed in the Chat box (`/model
// opus`) shows in Chat as a small command row, never as a bubble of yours: the
// transcript never shows a command as your message, so a bubble would wait as
// "Queued" for nothing. Per pane, renderer-wide, the newest three, each for
// ten minutes; a refused one leaves no row (the box keeps it with the note).

export const commandRowLimit = 3;
export const commandRowMs = 10 * 60_000;

export interface CommandRow {
  readonly id: string;
  readonly text: string;
  readonly state: "sending" | "sent";
  readonly at: number;
}

export class CommandRows {
  private readonly rows = new Map<string, CommandRow[]>();
  private readonly listeners = new Set<() => void>();
  private next = 0;
  private revision = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  version = (): number => this.revision;

  private changed(): void {
    this.revision += 1;
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** A command on its way: its row's id. */
  add(key: string, text: string, now: number = Date.now()): string {
    this.next += 1;
    const id = `command-${this.next}`;
    const rows = [...(this.rows.get(key) ?? []), { id, text: text.trim(), state: "sending" as const, at: now }];
    this.rows.set(key, rows.slice(-commandRowLimit));
    this.changed();
    return id;
  }

  sent(key: string, id: string): void {
    const rows = this.rows.get(key);
    if (rows === undefined || !rows.some((row) => row.id === id)) return;
    this.rows.set(
      key,
      rows.map((row) => (row.id === id ? { ...row, state: "sent" } : row)),
    );
    this.changed();
  }

  failed(key: string, id: string): void {
    const rows = this.rows.get(key);
    if (rows === undefined) return;
    this.rows.set(
      key,
      rows.filter((row) => row.id !== id),
    );
    this.changed();
  }

  /** The pane's rows shown now, oldest first. */
  forPane(key: string, now: number = Date.now()): CommandRow[] {
    return (this.rows.get(key) ?? []).filter((row) => now - row.at < commandRowMs);
  }

  clear(): void {
    this.rows.clear();
    this.changed();
  }
}

export const commandRows = new CommandRows();

/**
 * Sends a command line through the bound send with its row in Chat in place
 * of your bubble: the row says it is on its way, then that it went; a refusal
 * takes the row away and rejects (the box keeps the text and shows the note).
 */
export function sendCommandRow(
  send: (hostId: string, paneId: string, text: string) => Promise<void>,
  hostId: string,
  paneId: string,
  text: string,
  rows: CommandRows = commandRows,
): Promise<void> {
  const key = `${hostId}/${paneId}`;
  const id = rows.add(key, text);
  return send(hostId, paneId, text).then(
    () => rows.sent(key, id),
    (failure: unknown) => {
      rows.failed(key, id);
      throw failure;
    },
  );
}
