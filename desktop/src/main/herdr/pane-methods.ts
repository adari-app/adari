// The one table of every Herdr method and param the split panes use.
// HerdrClient builds each request from it, so a name or a param that a live
// check corrects is changed here and nowhere else.
//
// "confirmed": this repo already sends it and its tests pin it (HerdrKit
// HerdrClient.swift, WorkspaceActionsTests, ShellCoreCallTests, the desktop
// client), or Herdr 0.9.5's own API schema names it (`herdr api schema --json`,
// protocol 22). "inferred": the name from the CLI's id (`cli:pane:<verb>`) and
// the params from the CLI's options (the fixtures' `herdr pane <verb> --help`),
// not yet seen on Herdr's socket.

/** Where a split's new pane goes: Herdr splits right or down only (HerdrClient.SplitDirection). */
export type HerdrSplitDirection = "right" | "down";
/** The CLI's resize and focus directions. */
export type HerdrMoveDirection = "left" | "right" | "up" | "down";

export interface SplitParams {
  readonly workspaceId: string;
  readonly targetPaneId: string;
  readonly direction: HerdrSplitDirection;
  /** The new pane's folder; null follows the split pane's. */
  readonly cwd: string | null;
  /** False: Herdr's own focus stays where it is (the Swift app's explicit split). */
  readonly focus: boolean;
}

export const paneMethods = {
  layout: {
    method: "pane.layout",
    status: "confirmed",
    basis: "Herdr 0.9.5 schema: PaneLayoutParams { pane_id }, answered pane_layout { layout: PaneLayoutSnapshot } (as the CLI's `herdr pane layout --pane <ID>` prints it)",
    params: (paneId: string) => ({ pane_id: paneId }),
  },
  split: {
    method: "pane.split",
    status: "confirmed",
    basis: "HerdrKit HerdrClient.splitPane(workspaceID:targetPaneID:cwd:direction:) and WorkspaceActionsTests: workspace_id, target_pane_id, direction right|down, cwd, focus; result pane_info { pane }",
    params: (split: SplitParams) => ({
      workspace_id: split.workspaceId,
      target_pane_id: split.targetPaneId,
      direction: split.direction,
      ...(split.cwd === null ? {} : { cwd: split.cwd }),
      focus: split.focus,
    }),
  },
  resize: {
    method: "pane.resize",
    status: "confirmed",
    basis: "Herdr 0.9.5 schema: PaneResizeParams { pane_id, direction left|right|up|down, amount: float }; the schema gives no unit for amount, so a drag sets the split's ratio instead (setSplitRatio)",
    /** Unused: a divider drag sends layout.set_split_ratio. */
    used: false,
    /** The schema says float and nothing more. */
    amountUnit: "unknown",
    params: (paneId: string, direction: HerdrMoveDirection, amount: number) => ({ pane_id: paneId, direction, amount }),
  },
  setSplitRatio: {
    method: "layout.set_split_ratio",
    status: "confirmed",
    basis: "Herdr 0.9.5 schema: LayoutSetSplitRatioParams { tab_id?, pane_id?, path: [bool], ratio: float }, answered layout_split_ratio_set { layout: LayoutDescription { workspace_id, tab_id, zoomed, focused_pane_id, root: LayoutNode } }; sent once when a divider is let go",
    /** The method and its params are the schema's; what the path means is not. */
    pathEncoding:
      "inferred: the sides from the root to the split, false the first and true the second (shared/pane-layout splitPath); Herdr's split ids split_<n>_root, split_<n>_0, split_<n>_1 agree with the last step in every captured layout",
    params: (tabId: string, path: readonly boolean[], ratio: number) => ({ tab_id: tabId, path: [...path], ratio }),
  },
  zoom: {
    method: "pane.zoom",
    status: "confirmed",
    basis: "Herdr 0.9.5 schema: PaneZoomParams { pane_id, mode: toggle | on | off (default toggle) }, answered pane_zoom { zoom: PaneZoomResult { changed, zoom_changed, focus_changed, pane_id, focused_pane_id, zoomed, layout } }; sent as on or off from the zoom the layout shows, never toggle, so a repeat does not flip it back",
    params: (paneId: string, zoomed: boolean) => ({ pane_id: paneId, mode: zoomed ? "on" : "off" }),
  },
  close: {
    method: "pane.close",
    status: "confirmed",
    basis: "HerdrKit closePane and the desktop client (New agent's failed start): pane_id",
    params: (paneId: string) => ({ pane_id: paneId }),
  },
  focus: {
    method: "pane.focus",
    status: "confirmed",
    basis: "Herdr 0.9.5 schema: pane.focus takes PaneTarget { pane_id }; not sent: a tile click, ⌘1–⌘4 and ⌃⌘ arrows focus the tile in the app only (Herdr's focus could follow the focused tile: not done yet)",
    /** Off: a tile click focuses the tile here only. */
    sentOnTileClick: false,
    params: (paneId: string) => ({ pane_id: paneId }),
  },
  focusDirection: {
    method: "pane.focus_direction",
    status: "confirmed",
    basis: "Herdr 0.9.5 schema: PaneFocusDirectionParams { pane_id, direction left|right|up|down } (the CLI's `herdr pane focus --direction`); unused: ⌃⌘ arrows move the focus between tiles here only",
    used: false,
    params: (paneId: string, direction: HerdrMoveDirection) => ({ pane_id: paneId, direction }),
  },
  rename: {
    method: "pane.rename",
    status: "confirmed",
    basis: "Herdr 0.9.5 schema: PaneRenameParams { pane_id, label (string or null) }, answered pane_info { pane } (HerdrKit renamePane; the reply's pane is not read); a row's Rename… and the pane header's (null clears the label, so Herdr's own name returns). Split right and Split down still leave the new shell unlabelled",
    used: true,
    params: (paneId: string, label: string | null) => ({ pane_id: paneId, label }),
  },
  renameTab: {
    method: "tab.rename",
    status: "confirmed",
    basis: "Herdr 0.9.5 schema: TabRenameParams { tab_id, label } (both required: a string, never null), answered tab_info { tab } (HerdrKit renameTab, the sidebar's .tab renameTarget); for a row whose shown name is its tab's label. The reply's tab is not read",
    used: true,
    params: (tabId: string, label: string) => ({ tab_id: tabId, label }),
  },
  subscribe: {
    method: "events.subscribe",
    status: "confirmed",
    basis: "HerdrKit HerdrClient.subscribe and SidebarRefresh.subscriptions: { subscriptions: [{ type }] }, global kinds without pane_id; its own held exec (CitadelTransport.stream)",
    params: (kinds: readonly string[], panes: readonly { readonly type: string; readonly paneId: string }[] = []) => ({
      subscriptions: [...kinds.map((type) => ({ type })), ...panes.map(({ type, paneId }) => ({ type, pane_id: paneId }))],
    }),
  },
} as const;

/**
 * The events that re-read a shown tab's layout (confirmed: SubscriptionType in
 * HerdrKit Wire.swift, the 0.9.5 schema list in ShellCoreCallTests). The
 * stream may spell them dotted or snake case; both are read.
 */
export const layoutEventKinds: readonly string[] = ["layout.updated", "pane.created", "pane.closed", "pane.moved"];

/**
 * The events that change what the sidebar shows, the desktop's copy of the iOS app's
 * (HerdrKit Wire.swift SidebarRefresh.kinds and .subscriptions): the global kinds, and the agent status,
 * which Herdr scopes to one pane (`pane_id` required), so one subscription per agent pane.
 */
export const sidebarEventKinds: readonly string[] = [
  "workspace.created",
  "workspace.renamed",
  "workspace.closed",
  "workspace.reordered",
  "workspace.moved",
  "tab.created",
  "tab.renamed",
  "tab.closed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.moved",
  "pane.updated",
];
export const sidebarPaneEventKind = "pane.agent_status_changed";

/** Of those, the ones that change which panes a tab has (they bring a snapshot too). */
export const paneSetEventKinds: readonly string[] = ["pane.created", "pane.closed", "pane.moved"];
