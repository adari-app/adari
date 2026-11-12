// The app's own update state in the page, as
// the main process sends it (src/main/updates.ts UpdateController, every
// change on IPC.updateChanged). The sidebar's pill and Settings › Updates read
// it; App shows the "Update downloaded" toast once for each download that
// finishes while this page is open (a page loaded after one finished, or
// reloaded, never shows it again).

import type { HerdrDesktopBridge } from "../../shared/ipc-contract";
import type { UpdateView } from "../../shared/updates";

type Bridge = Pick<HerdrDesktopBridge, "updateState" | "onUpdateState">;

export class UpdateStore {
  private current: UpdateView | null = null;
  /** The finished downloads the page has already seen (null: no state yet; the first one sets it). */
  private seenDownloads: number | null = null;
  private toastDue = false;
  private pushed = false;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  view = (): UpdateView | null => this.current;

  /** Follows the main process's state (an older bridge without it: no state, so no pill). */
  attach(bridge: Bridge): () => void {
    const off = typeof bridge.onUpdateState === "function" ? bridge.onUpdateState((view) => this.receive(view, true)) : () => undefined;
    if (typeof bridge.updateState === "function") {
      void bridge.updateState().then(
        (view) => {
          // A change pushed while this was on its way is newer.
          if (!this.pushed) this.receive(view, false);
        },
        () => undefined,
      );
    }
    return off;
  }

  receive(view: UpdateView, pushed: boolean): void {
    if (pushed) this.pushed = true;
    if (this.seenDownloads === null) {
      this.seenDownloads = view.downloads;
    } else if (view.downloads > this.seenDownloads) {
      this.seenDownloads = view.downloads;
      this.toastDue = true;
    }
    this.current = view;
    for (const listener of this.listeners) listener();
  }

  /** True once for each download that finished while the page was open: the toast's turn. */
  takeToast(): boolean {
    const due = this.toastDue;
    this.toastDue = false;
    return due;
  }

  /** Tests: as a fresh page. */
  reset(): void {
    this.current = null;
    this.seenDownloads = null;
    this.toastDue = false;
    this.pushed = false;
    this.listeners.clear();
  }
}

export const updateStore = new UpdateStore();
