// Send to… in the page: the open picker, the
// toast, where a box's cursor goes when its pane opens with a hand-off, and
// carrying out a pick. A pick opens the target pane with the text in its
// message box (after any draft there, never over it), or (⌘Return) sends it
// through the main process's bound Send with no pending bubble: a hand-off is
// not your message in the target's chat (the integration seam with the pending
// bubbles). A pick whose pane changed since it was listed is refused: the
// toast says why and the text is copied.

import type { HostView } from "../../shared/ipc-contract";
import {
  fits,
  handoffMacs,
  handoffMessage,
  handoffNotice,
  land,
  paneOf,
  refusalFor,
  sendFailure,
  type HandoffAction,
  type HandoffMac,
  type HandoffPayload,
  type HandoffRecent,
  type HandoffRecents,
  type HandoffRefusal,
  type HandoffTarget,
} from "../../shared/handoff";
import { PaneLife } from "../../shared/pane-life";
import type { SendBinding } from "../../shared/send-binding";
import { draftKey, type ComposerDrafts } from "../components/composer-drafts";

export interface PickerRequest {
  readonly id: number;
  readonly payload: HandoffPayload;
  /** Where the picker points (the click, or the button's corner). */
  readonly x: number;
  readonly y: number;
}

export interface HandoffToast {
  readonly id: number;
  readonly text: string;
  /** Open shows this pane (null: no Open). */
  readonly target: HandoffTarget | null;
}

/** The page's hand-off state, one per window (useSyncExternalStore reads it). */
export class HandoffStore {
  readonly life = new PaneLife();
  private hostsNow: readonly HostView[] = [];
  private seen: Readonly<Record<string, ReadonlySet<string>>> = {};
  private pickerNow: PickerRequest | null = null;
  private toastNow: HandoffToast | null = null;
  private readonly landings = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private next = 1;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Every snapshot: pane life follows it, an open picker refreshes. */
  setHosts(hosts: readonly HostView[]): void {
    this.life.observeHosts(hosts);
    this.hostsNow = hosts;
    this.changed();
  }

  setSeenDone(seen: Readonly<Record<string, ReadonlySet<string>>>): void {
    this.seen = seen;
  }

  hosts(): readonly HostView[] {
    return this.hostsNow;
  }

  /** Every machine's panes as the picker lists them now. */
  macs(nowUnixMs = Date.now()): HandoffMac[] {
    return handoffMacs(this.hostsNow, this.life, { nowUnixMs, seenDone: this.seen });
  }

  picker(): PickerRequest | null {
    return this.pickerNow;
  }

  openPicker(payload: HandoffPayload, x: number, y: number): void {
    this.pickerNow = { id: this.next++, payload, x, y };
    this.changed();
  }

  closePicker(): void {
    if (this.pickerNow === null) return;
    this.pickerNow = null;
    this.changed();
  }

  toast(): HandoffToast | null {
    return this.toastNow;
  }

  showToast(text: string, target: HandoffTarget | null): void {
    this.toastNow = { id: this.next++, text, target };
    this.changed();
  }

  dismissToast(id?: number): void {
    if (this.toastNow === null || (id !== undefined && this.toastNow.id !== id)) return;
    this.toastNow = null;
    this.changed();
  }

  /** The pane's box holds a hand-off from `start`: its cursor goes there when the box next shows. */
  expectLanding(key: string, start: number): void {
    this.landings.set(key, start);
  }

  takeLanding(key: string): number | null {
    const start = this.landings.get(key);
    if (start === undefined) return null;
    this.landings.delete(key);
    return start;
  }

  /** Clears everything (tests). */
  reset(): void {
    this.hostsNow = [];
    this.pickerNow = null;
    this.toastNow = null;
    this.landings.clear();
    this.changed();
  }
}

export const handoffStore = new HandoffStore();

/** What carrying out a pick needs (the page's bridge, drafts and navigation; fakes in tests). */
export interface DeliveryDeps {
  readonly store: HandoffStore;
  readonly drafts: ComposerDrafts;
  readonly recents: HandoffRecents;
  copy(text: string): void;
  /** Shows the pane (Chat for an agent, the terminal with its box for a shell). */
  open(target: HandoffTarget): void;
  /** The main process's bound Send (sendToPane), with no pending bubble. */
  send(hostId: string, paneId: string, text: string, binding: SendBinding): Promise<void>;
}

/** The pick against the panes as they are now: null when it may go, else why not. */
export function checkPick(store: HandoffStore, target: HandoffTarget): HandoffRefusal | null {
  const host = store.hosts().find((candidate) => candidate.id === target.hostId);
  const answering = host !== undefined && host.state === "connected" && host.topology !== null && store.life.isLive(host.id);
  const mac = answering ? store.macs().find((candidate) => candidate.hostId === target.hostId) : undefined;
  const now = mac === undefined ? null : paneOf(mac, target.paneId);
  return refusalFor(target, now, answering ? store.life.connection(target.hostId) : null);
}

/** Puts the text in the pane's box after the draft there; its cursor goes to the text's start when it shows. */
export function landInBox(deps: Pick<DeliveryDeps, "store" | "drafts">, target: HandoffTarget, message: string): boolean {
  const key = draftKey(target.hostId, target.paneId);
  const landing = land(message, deps.drafts.get(key).text);
  // Before the box hears of the text, so a box already showing places its cursor.
  deps.store.expectLanding(key, landing.start);
  deps.drafts.edit(key, landing.text);
  return landing.appended;
}

function refuse(deps: DeliveryDeps, payload: HandoffPayload, target: HandoffTarget, refusal: HandoffRefusal, action: HandoffAction): void {
  deps.copy(handoffMessage(payload));
  deps.store.showToast(handoffNotice.refused(target, refusal, action), null);
}

/** The binding the main process checks the pane against right before it writes: what was picked. */
export function bindingOfPick(target: HandoffTarget): SendBinding {
  const identity = target.identity!;
  return {
    terminalID: identity.terminalID,
    isAgent: identity.agent !== null,
    kind: identity.agent,
    session: identity.session,
    // The main process's connection and run the row showed: its Send refuses when either changed.
    // Always one: without the main process's counts (a fixture), the row's own, which nothing there can confirm.
    run: identity.run ?? { connection: identity.connection, arrival: identity.arrival },
  };
}

/** Carries out one pick. Resolves once the toast for it shows. */
export async function deliverHandoff(
  deps: DeliveryDeps,
  payload: HandoffPayload,
  target: HandoffTarget,
  action: HandoffAction,
): Promise<void> {
  const message = handoffMessage(payload);
  if (!fits(message)) return;
  const refusal = checkPick(deps.store, target);
  if (refusal !== null) {
    refuse(deps, payload, target, refusal, action);
    return;
  }
  const recent: HandoffRecent = { hostId: target.hostId, paneId: target.paneId };
  deps.recents.record(recent);
  if (action === "draft") {
    const appended = landInBox(deps, target, message);
    if (appended) deps.store.showToast(handoffNotice.appended(target), null);
    deps.open(target);
    return;
  }
  try {
    await deps.send(target.hostId, target.paneId, message, bindingOfPick(target));
  } catch (failure) {
    const note = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Not sent";
    let outcome = sendFailure(note);
    // A refusal for a pane the page now sees changed is stale too: never into what is there now.
    if (outcome === "refused" && checkPick(deps.store, target) !== null) outcome = "stale";
    if (outcome === "stale") {
      // Not the pane you picked any more: the text is copied, never put in the box of what is there now.
      deps.copy(message);
      deps.store.showToast(handoffNotice.stale(target, note), null);
    } else if (outcome === "refused") {
      landInBox(deps, target, message);
      deps.store.showToast(handoffNotice.notSent(target, note), target);
    } else {
      deps.store.showToast(handoffNotice.unconfirmed(target, note), target);
    }
    return;
  }
  deps.store.showToast(handoffNotice.sent(target), target);
}
