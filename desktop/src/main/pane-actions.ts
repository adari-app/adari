// The window's actions on a pane of the tab it shows: split it right or down
// (a shell, as Herdr's split makes; Herdr's own focus left where it is), move
// a divider (that split's ratio set with `layout.set_split_ratio`), zoom it or
// end the zoom (`pane.zoom` mode on or off; its reply carries the tab's
// layout, shown at once), close it. Each
// request comes from the one method table (herdr/pane-methods.ts) through
// HerdrClient. After the answer the tab's layout is read again (and, for a
// split or a close, a snapshot taken first so the sidebar has the pane), so
// the window redraws from what Herdr says rather than from what it asked.
//
// Binding and splits:
// - Every action is bound to the pane as the user saw it
//   (shared/pane-binding.ts: the machine's connection, workspace, tab, pane,
//   terminal and agent; a divider's split and its path). It is carried out
//   only while the sender's own window shows that pane in that tab on that
//   machine, and a snapshot asked after the request began and the tab's
//   layout read then still show the same; checked right before the request,
//   nothing awaited between. A changed or unverifiable binding is refused with
//   a plain reason, nothing sent (the bound Send's model: herdr/send.ts).
// - A tile's split and New agent's Where are one guarded split, one
//   at a time per machine and tab (SplitSlots), the tab's pane count read on
//   that fresh state, the slot held through the new pane's creation (and its
//   agent's start) and the refresh.
//
// The binding's connection is the machine's
// entry and the command connection its snapshot came on (the SSH transport's
// epoch), checked after the fresh reads and again right before each request
// (sendBound), so a reconnect between snapshots refuses too. A divider is
// its whole split as shown (its direction and both sides' panes in order),
// compared with the sender's shown layout and Herdr's read now.
//
// A row's Close pane (`from: "row"`) and Rename… (pane.rename, null
// clearing the label) are bound as the sidebar shows the pane (rowBindingOf):
// the window need not show it in a tile, and the rest of the check is the
// same (a fresh snapshot, Herdr's layout of its tab read now, the connection
// right before the request); a rename reads the snapshot again after it.

import type { PaneAction, PaneActionResult, WorkspaceRename } from "../shared/ipc-contract";
import { maxLabelLength } from "../shared/pane-manage";
import {
  bindingRefusal,
  bindingTexts,
  connectionRefusal,
  dividerStands,
  isPaneBinding,
  isWorkspaceBinding,
  isSplitPath,
  isSplitShape,
  type ConnectionNow,
  type PaneBinding,
} from "../shared/pane-binding";
import { isCoreID } from "../shared/core-ids";
import { ratioAtPath, splitRefusal, type PaneLayout } from "../shared/pane-layout";
import type { HerdrHostBackend, PaneLayoutHerdr } from "./herdr/backend";
import { MachineChanged, type NewAgentHerdr, type NewAgentRequest } from "./herdr/new-agent";
import type { SessionTopology } from "./herdr/wire";
import type { ConnectionIdentity } from "./hosts";

/** What the actions read from the machines in the sidebar (HostRegistry has it). */
export interface PaneActionHosts {
  backend(hostId: string): HerdrHostBackend | null;
  topology(hostId: string): SessionTopology | null;
  refresh(hostId: string): Promise<void>;
  /** A snapshot asked for after the call began: true once one came (HostRegistry.fresh). */
  fresh(hostId: string): Promise<boolean>;
  /** The machine's connection while it answers; null while it does not (HostRegistry.connection). */
  connection(hostId: string): number | null;
  /** Its entry and the command connection a request sent now goes on (HostRegistry.connectionIdentity). */
  connectionIdentity(hostId: string): ConnectionIdentity | null;
}

/** The machine's connection now: its answering number, its entry and its command connection. */
function connectionNow(hosts: PaneActionHosts, hostId: string): ConnectionNow {
  const identity = hosts.connectionIdentity(hostId);
  return { connection: hosts.connection(hostId), incarnation: identity?.incarnation ?? null, epoch: identity?.epoch ?? null };
}

/**
 * Sends a request bound to `binding`: the machine's connection is
 * checked again right before `send` is called, with nothing awaited between,
 * so the request goes on the command connection the binding and the fresh
 * reads were on (a dropped or replaced one refuses; nothing sent).
 */
function sendBound<T>(hosts: PaneActionHosts, hostId: string, binding: PaneBinding, send: () => Promise<T>): Promise<T> {
  const refusal = connectionRefusal(binding, connectionNow(hosts, hostId));
  if (refusal !== null) return Promise.reject(new Error(refusal));
  return send();
}

/** The windows' layouts (LayoutService has it). */
export interface PaneActionLayouts {
  reread(hostId: string): Promise<void>;
  /** A layout Herdr sent with a reply: shown at once in the windows showing its tab. */
  accept(hostId: string, layout: PaneLayout): void;
  /** What the window shows: its machine and the tab's layout it was last sent (null: nothing). */
  watched(owner: PaneActionSender): { readonly hostId: string; readonly layout: PaneLayout | null } | null;
}

/** The window that asked (Electron's WebContents fits). */
export interface PaneActionSender {
  readonly id: number;
}

const maxIdLength = 256;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= maxIdLength;
const isFraction = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;

/** A well-formed action from the page, bound to the pane it names (anything else is refused). */
export function isPaneAction(value: unknown): value is PaneAction {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isId(v["paneId"]) || !isPaneBinding(v["binding"]) || v["binding"].paneId !== v["paneId"]) return false;
  switch (v["type"]) {
    case "split":
      return v["direction"] === "right" || v["direction"] === "down";
    case "resize":
      return isId(v["splitId"]) && isSplitPath(v["path"]) && isSplitShape(v["shape"]) && isFraction(v["ratio"]);
    case "zoom":
      return typeof v["zoomed"] === "boolean";
    case "close":
      // A row's close (bound as the sidebar shows the pane), or a tile's.
      return v["from"] === undefined || v["from"] === "row";
    case "rename": {
      // A label (trimmed by the page; Herdr trims too), or null to clear it.
      const label = typeof v["label"] === "string" && v["label"].length > 0 && v["label"].length <= maxLabelLength;
      // A tab's rename names the bound pane's tab and a name (TabRenameParams' label is a string).
      if (v["target"] === "tab") return label && v["tabId"] === v["binding"].tabId;
      return v["target"] === undefined && v["tabId"] === undefined && (v["label"] === null || label);
    }
    default:
      return false;
  }
}

/** How many panes the tab holding `paneId` has, in the snapshot (0: not listed). */
export function tabPaneCount(topology: SessionTopology, paneId: string): number {
  const tabId = topology.panes.find((pane) => pane.paneID === paneId)?.tabID;
  return tabId === undefined ? 0 : topology.panes.filter((pane) => pane.tabID === tabId).length;
}

/** A note written once per run of the app (a reply that disagreed with what was asked). */
export class OnceLog {
  private written = false;

  constructor(private readonly write: (line: string) => void = (line) => console.warn(line)) {}

  note(line: string): void {
    if (this.written) return;
    this.written = true;
    this.write(line);
  }
}

const splitRatioLog = new OnceLog();

/** How far Herdr's ratio may sit from the one asked (its ratio is a 32-bit float). */
const ratioTolerance = 0.001;

/**
 * One split at a time per machine and tab: a split
 * waits until every split asked before on that tab was made and refreshed, or
 * refused, so each counts the panes the one before left.
 */
export class SplitSlots {
  private readonly tails = new Map<string, Promise<void>>();

  hold<T>(hostId: string, tabId: string, work: () => Promise<T>): Promise<T> {
    const key = `${hostId}\n${tabId}`;
    const before = this.tails.get(key) ?? Promise.resolve();
    const run = before.then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }
}

const splitSlots = new SplitSlots();

/** Why the sender's window does not show the bound pane in its tab on that machine (null: it does). */
function shownRefusal(layouts: PaneActionLayouts, sender: PaneActionSender, hostId: string, binding: PaneBinding): string | null {
  const watch = layouts.watched(sender);
  const layout = watch?.layout ?? null;
  if (watch === null || watch.hostId !== hostId || layout === null) return bindingTexts.notShown;
  if (layout.tabId !== binding.tabId || !layout.panes.some((pane) => pane.paneId === binding.paneId)) return bindingTexts.notShown;
  return null;
}

/** Why the machine's snapshot does not list the row's pane (null: it does): a row's action. */
function rowRefusal(hosts: PaneActionHosts, hostId: string, binding: PaneBinding): string | null {
  return hosts.topology(hostId)?.panes.some((pane) => pane.paneID === binding.paneId) === true ? null : bindingTexts.gone;
}

/**
 * Reads what the binding is checked against: a snapshot asked after the
 * request began and the tab's layout now; then checks the binding (and that
 * the window still shows the pane). Throws the reason when the binding no
 * longer holds or cannot be checked. Returns the layout read; the caller sends
 * its request with nothing awaited in between.
 */
async function checkedNow(
  hosts: PaneActionHosts,
  layouts: PaneActionLayouts,
  herdr: PaneLayoutHerdr,
  sender: PaneActionSender,
  hostId: string,
  binding: PaneBinding,
  /** False for a row's action: the window need not show the pane in a tile. */
  shown = true,
): Promise<PaneLayout> {
  const unchecked = "The machine did not answer, so the pane could not be checked.";
  if (!(await hosts.fresh(hostId))) throw new Error(unchecked);
  const listed = hosts.topology(hostId)?.panes.some((pane) => pane.paneID === binding.paneId) === true;
  if (!listed) throw new Error(bindingTexts.gone);
  let layout: PaneLayout;
  try {
    // herdr-core keeps no tile layout (no pane.layout); its pane's tab is where the
    // snapshot just read places it, so that tab stands for the layout read now.
    layout = isCoreID(binding.paneId) ? coreTabLayout(hosts.topology(hostId), binding.paneId) : await herdr.paneLayout(binding.paneId);
  } catch {
    throw new Error("Herdr's layout of the tab could not be read, so the pane could not be checked.");
  }
  // The connection read after the fresh reads: a reconnect during them refuses.
  const refusal =
    (shown ? shownRefusal(layouts, sender, hostId, binding) : null) ?? bindingRefusal(binding, { ...connectionNow(hosts, hostId), topology: hosts.topology(hostId), layout });
  if (refusal !== null) throw new Error(refusal);
  return layout;
}

/**
 * A herdr-core pane's tab as `topology` has it (herdr-core's own placement, from its
 * document and labels): the tab and its panes, no tiles (herdr-core has no split tree). Throws when it is not there.
 */
function coreTabLayout(topology: SessionTopology | null, paneId: string): PaneLayout {
  const pane = topology?.panes.find((candidate) => candidate.paneID === paneId);
  if (topology === null || pane === undefined) throw new Error(bindingTexts.gone);
  const none = { x: 0, y: 0, width: 0, height: 0 };
  return {
    tabId: pane.tabID,
    workspaceId: pane.workspaceID,
    area: none,
    focusedPaneId: null,
    panes: topology.panes.filter((candidate) => candidate.tabID === pane.tabID).map((candidate) => ({ paneId: candidate.paneID, rect: none, focused: false })),
    splits: [],
    zoomed: false,
  };
}

/** Throws why a split cannot be made on the tab as just read (it has 4 panes by the layout or the snapshot). */
function checkRoom(hosts: PaneActionHosts, hostId: string, binding: PaneBinding, layout: PaneLayout): void {
  const topology = hosts.topology(hostId);
  const refusal = splitRefusal(Math.max(layout.panes.length, topology === null ? 0 : tabPaneCount(topology, binding.paneId)));
  if (refusal !== null) throw new Error(refusal);
}

/**
 * New agent's Herdr with its pane.split checked first (`check`), then sent through `send` (sendBound).
 * Every other request (the name's agent.list, each agent.start, the typed command,
 * the look's reads, the cleanup close) goes through `refusal` right before it is sent, nothing awaited between: on
 * the command connection the binding was on, or not at all (MachineChanged, so New agent stops and closes nothing).
 */
function checkedSplits(
  herdr: NewAgentHerdr,
  check: () => Promise<void>,
  send: <T>(request: () => Promise<T>) => Promise<T>,
  refusal: () => string | null,
): NewAgentHerdr {
  const split = herdr.splitPane?.bind(herdr);
  const bound = <T>(request: () => Promise<T>): Promise<T> => {
    const why = refusal();
    return why === null ? request() : Promise.reject(new MachineChanged(why));
  };
  return {
    agentList: () => bound(() => herdr.agentList()),
    createTerminalTab: (workspaceID, label, cwd) => bound(() => herdr.createTerminalTab(workspaceID, label, cwd)),
    startAgent: (name, kind, paneID, args) => bound(() => (args === undefined ? herdr.startAgent(name, kind, paneID) : herdr.startAgent(name, kind, paneID, args))),
    closePane: (paneID) => bound(() => herdr.closePane(paneID)),
    sendInput: (pane, text, keys) => bound(() => herdr.sendInput(pane, text, keys)),
    ...(herdr.paneText === undefined ? {} : { paneText: (pane: string, lines: number) => bound(() => herdr.paneText!(pane, lines)) }),
    ...(split === undefined
      ? {}
      : {
          splitPane: async (params) => {
            await check();
            return send(() => split(params));
          },
        }),
  };
}

/**
 * New agent's Where as a split: bound to the pane the sender's
 * window shows and the same guarded split as a tile's (refused when the machine's panes are not known, the binding no longer holds
 * or the tab is full by a fresh read right before pane.split), `start` run with
 * it in the tab's slot, held until the snapshot and the shown layouts were read again.
 */
export async function newAgentInSplit<T>(
  hosts: PaneActionHosts,
  layouts: PaneActionLayouts,
  sender: PaneActionSender,
  hostId: string,
  request: NewAgentRequest,
  workspace: NewAgentHerdr,
  start: (herdr: NewAgentHerdr) => Promise<T>,
): Promise<T> {
  const where = request.where;
  if (where === undefined || where.type !== "split" || where.binding === undefined || where.binding.paneId !== where.targetPaneId) throw new Error("bad request");
  const binding = where.binding;
  const herdr = hosts.backend(hostId)?.paneActions?.();
  if (herdr === undefined) throw new Error("This machine cannot split a pane from here.");
  const topology = hosts.topology(hostId);
  if (topology === null) throw new Error("The machine's panes are not known yet, so the split could not be checked; nothing was split.");
  const refusal = shownRefusal(layouts, sender, hostId, binding) ?? newAgentSplitRefusal(topology, request);
  if (refusal !== null) throw new Error(refusal);
  if (binding.workspaceId !== request.workspaceId) throw new Error("The pane to split is in another workspace.");
  return splitSlots.hold(hostId, binding.tabId, async () => {
    const guarded = checkedSplits(
      workspace,
      async () => {
        const layout = await checkedNow(hosts, layouts, herdr, sender, hostId, binding);
        checkRoom(hosts, hostId, binding, layout);
      },
      (request) => sendBound(hosts, hostId, binding, request),
      () => connectionRefusal(binding, connectionNow(hosts, hostId)),
    );
    try {
      return await start(guarded);
    } finally {
      await hosts.refresh(hostId).catch(() => undefined);
      await layouts.reread(hostId);
    }
  });
}

/** Why New agent's split cannot be made (the pane gone, another workspace's, its tab full), or null. */
export function newAgentSplitRefusal(topology: SessionTopology, request: NewAgentRequest): string | null {
  const where = request.where;
  if (where === undefined || where.type !== "split") return null;
  const pane = topology.panes.find((candidate) => candidate.paneID === where.targetPaneId);
  if (pane === undefined) return "The pane to split is no longer listed.";
  if (pane.workspaceID !== request.workspaceId) return "The pane to split is in another workspace.";
  return splitRefusal(tabPaneCount(topology, pane.paneID));
}

/**
 * Carries out the action `sender` asked on `hostId`'s Herdr, while its binding
 * holds; resolves once the shown layouts were read again (or, for a zoom, its
 * reply's shown).
 */
export async function runPaneAction(
  hosts: PaneActionHosts,
  layouts: PaneActionLayouts,
  sender: PaneActionSender,
  hostId: string,
  action: PaneAction,
  log: OnceLog = splitRatioLog,
): Promise<PaneActionResult> {
  const backend = hosts.backend(hostId);
  if (backend === null) throw new Error("That machine is no longer listed.");
  const herdr = backend.paneActions?.();
  if (herdr === undefined) throw new Error("This machine cannot change its panes from here.");
  const binding = action.binding;
  if (binding.paneId !== action.paneId) throw new Error("bad request");
  // Only a pane this window shows (a forged request for another is refused before anything is read);
  // a row's close only a pane the machine's snapshot lists, as the sidebar shows it.
  const fromRow = (action.type === "close" && action.from === "row") || action.type === "rename";
  const shown = fromRow ? rowRefusal(hosts, hostId, binding) : shownRefusal(layouts, sender, hostId, binding);
  if (shown !== null) throw new Error(shown);
  switch (action.type) {
    case "split": {
      // Refused at once when the cached snapshot already has 4; then the guarded split (fresh state, one at a time per tab).
      const cached = hosts.topology(hostId);
      const refusal = cached === null ? null : splitRefusal(tabPaneCount(cached, binding.paneId));
      if (refusal !== null) throw new Error(refusal);
      return splitSlots.hold(hostId, binding.tabId, async () => {
        const layout = await checkedNow(hosts, layouts, herdr, sender, hostId, binding);
        checkRoom(hosts, hostId, binding, layout);
        const created = await sendBound(hosts, hostId, binding, () =>
          herdr.splitPane({ workspaceId: binding.workspaceId, targetPaneId: binding.paneId, direction: action.direction, cwd: null, focus: false }),
        );
        await hosts.refresh(hostId).catch(() => undefined);
        await layouts.reread(hostId);
        return { paneId: created.paneID };
      });
    }
    case "resize": {
      // The divider as it was dragged: the same split with the same direction and both sides, at the
      // same place, the bound pane on its first side, in the sender's shown layout and in Herdr's read now.
      const stands = (layout: PaneLayout | null): boolean =>
        layout !== null && dividerStands(layout, action.splitId, action.path, action.shape, binding.paneId);
      if (!stands(layouts.watched(sender)?.layout ?? null)) throw new Error(bindingTexts.divider);
      const layout = await checkedNow(hosts, layouts, herdr, sender, hostId, binding);
      if (!stands(layouts.watched(sender)?.layout ?? null) || !stands(layout)) throw new Error(bindingTexts.divider);
      const set = await sendBound(hosts, hostId, binding, () => herdr.setSplitRatio(layout.tabId, action.path, action.ratio));
      const kept = ratioAtPath(set.root, action.path);
      if (kept === null || Math.abs(kept - action.ratio) > ratioTolerance) {
        // Settle to Herdr's layout (read again below); say so once.
        log.note(
          `layout.set_split_ratio: asked ${action.ratio} for ${action.splitId} (path [${action.path.join(", ")}]) in ${layout.tabId}; Herdr has ${kept ?? "no split there"}. Showing Herdr's layout. (Logged once.)`,
        );
      }
      break;
    }
    case "zoom": {
      await checkedNow(hosts, layouts, herdr, sender, hostId, binding);
      // Herdr's reply has the tab's layout after the zoom: shown as it is, no second read.
      const zoom = await sendBound(hosts, hostId, binding, () => herdr.zoomPane(binding.paneId, action.zoomed));
      layouts.accept(hostId, zoom.layout);
      return { paneId: null };
    }
    case "rename": {
      // One pane.rename, bound as the sidebar shows the pane; the snapshot read after it shows the name.
      // Or one tab.rename of the bound pane's tab (the pane still in it, so a moved pane
      // cannot change what is renamed), when the row's shown name was its tab's label.
      if (action.target === "tab") {
        const renameTab = herdr.renameTab?.bind(herdr);
        const label = action.label;
        if (renameTab === undefined) throw new Error("This machine cannot rename its tabs from here.");
        if (label === null || action.tabId !== binding.tabId) throw new Error("bad request");
        await checkedNow(hosts, layouts, herdr, sender, hostId, binding, false);
        await sendBound(hosts, hostId, binding, () => renameTab(binding.tabId, label));
        await hosts.refresh(hostId).catch(() => undefined);
        return { paneId: null };
      }
      const rename = herdr.renamePane?.bind(herdr);
      if (rename === undefined) throw new Error("This machine cannot rename its panes from here.");
      await checkedNow(hosts, layouts, herdr, sender, hostId, binding, false);
      await sendBound(hosts, hostId, binding, () => rename(binding.paneId, action.label));
      await hosts.refresh(hostId).catch(() => undefined);
      return { paneId: null };
    }
    case "close":
      await checkedNow(hosts, layouts, herdr, sender, hostId, binding, !fromRow);
      await sendBound(hosts, hostId, binding, () => herdr.closePane(binding.paneId));
      await hosts.refresh(hostId).catch(() => undefined);
      break;
  }
  await layouts.reread(hostId);
  return { paneId: null };
}

/** A well-formed Rename workspace… from the page (anything else is refused). */
export function isWorkspaceRename(value: unknown): value is WorkspaceRename {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isId(v["workspaceId"]) &&
    typeof v["label"] === "string" &&
    v["label"].length > 0 &&
    v["label"].length <= maxLabelLength &&
    isWorkspaceBinding(v["binding"]) &&
    v["binding"].workspaceId === v["workspaceId"]
  );
}

/**
 * One workspace.rename on `hostId`'s Herdr while the
 * binding holds: a snapshot asked after the request began still lists the
 * workspace, and the machine's connection (its entry and command connection)
 * is the one the page saw, checked right before the request with nothing
 * awaited between; then the snapshot is read again so the header shows it.
 */
export async function runWorkspaceRename(hosts: PaneActionHosts, hostId: string, request: WorkspaceRename): Promise<void> {
  const herdr = hosts.backend(hostId)?.paneActions?.();
  if (herdr === undefined) throw new Error("That machine is no longer listed.");
  const rename = herdr.renameWorkspace?.bind(herdr);
  if (rename === undefined) throw new Error("This machine cannot rename its workspaces from here.");
  if (!(await hosts.fresh(hostId))) throw new Error("The machine did not answer, so the workspace could not be checked.");
  if (hosts.topology(hostId)?.workspaces.some((workspace) => workspace.workspaceID === request.workspaceId) !== true) throw new Error(bindingTexts.workspaceGone);
  const refusal = connectionRefusal(request.binding, connectionNow(hosts, hostId));
  if (refusal !== null) throw new Error(refusal);
  await rename(request.workspaceId, request.label);
  await hosts.refresh(hostId).catch(() => undefined);
}
