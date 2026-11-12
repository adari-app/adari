// Each pane's Terminal input on this
// machine, counted. A Cursor or Grok chip pick notes its pane's count when it
// begins and checks it before every key it writes: any Terminal input
// meanwhile (the user's typing, a paste, a click's report) stops the pick, so its
// Enter never lands on text that is not the pick's own. Input from another
// device, or typed into Herdr on the Mac, is not seen here (a known limit).

export class PaneInputs {
  private readonly counts = new Map<string, number>();

  /** One more input written to the pane's Terminal. */
  bump(hostId: string, paneId: string): void {
    const key = `${hostId}\u0000${paneId}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** How many inputs this app has written to the pane's Terminal so far. */
  generation(hostId: string, paneId: string): number {
    return this.counts.get(`${hostId}\u0000${paneId}`) ?? 0;
  }
}
