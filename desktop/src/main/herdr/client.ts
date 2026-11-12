// The protocol 22 client (HerdrKit `HerdrClient`, Sources/HerdrKit/HerdrClient.swift):
// request ids `herdrkit:<method>:<n>`, one round trip per call, a server
// `error` object surfaced as a thrown APIError. Only the calls the desktop
// shell makes are ported: the session snapshot, the agent list, typing into a
// pane, and an agent prompt.

import { requestLine } from "./commands";
import { paneMethods, type SplitParams } from "./pane-methods";
import type { HerdrTransport, RoundTripOptions } from "./transport";
import { promptRoundTripTimeoutMs } from "./commands";
import type { PaneLayout } from "../../shared/pane-layout";
import {
  decodeAgentListResult,
  decodeAgentStartedResult,
  decodeIntegrationInstallResult,
  decodeIntegrationListResult,
  decodePaneInfoResult,
  decodePaneLayoutResult,
  decodePaneTextResult,
  decodePaneZoomResult,
  decodeSplitRatioResult,
  decodeReply,
  decodeTabCreationResult,
  decodeSessionSnapshotResult,
  decodeWorkspaceCreationResult,
  ignoreResult,
  type AgentInfo,
  type IntegrationInfo,
  type PaneZoom,
  type SessionTopology,
  type SplitRatioLayout,
  type TabCreation,
  type TopologyPaneInfo,
  type WorkspaceCreation,
} from "./wire";

/** One install's deadline (Herdr writes the agent's hook files). */
export const integrationInstallTimeoutMs = 30_000;

export class HerdrClient {
  private sequence = 0;

  constructor(private readonly transport: HerdrTransport) {}

  private nextID(method: string): string {
    this.sequence += 1;
    return `herdrkit:${method}:${this.sequence}`;
  }

  /** The exact line a call sends (exposed for the request-builder tests). */
  encodeRequest(method: string, params: Readonly<Record<string, unknown>>): string {
    return requestLine(this.nextID(method), method, params);
  }

  private async call<R>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    decode: (result: unknown, path: string) => R,
    options?: RoundTripOptions,
  ): Promise<R> {
    const line = this.encodeRequest(method, params);
    const reply = await (options === undefined ? this.transport.roundTrip(line) : this.transport.roundTrip(line, options));
    return decodeReply(reply, decode);
  }

  /** Every agent the server knows about (`agent.list`). */
  agentList(): Promise<AgentInfo[]> {
    return this.call("agent.list", {}, decodeAgentListResult);
  }

  /** Every workspace, tab, pane and agent in one atomic view (`session.snapshot`); `options` (This Mac's deadline) go to the transport. */
  sessionTopology(options?: RoundTripOptions): Promise<SessionTopology> {
    return this.call("session.snapshot", {}, decodeSessionSnapshotResult, options);
  }

  /**
   * A pane's last `lines` lines as plain text (`pane.read`, source recent, ANSI
   * stripped: HerdrKit `paneText`); the update mark reads the update line off it.
   */
  paneText(pane: string, lines: number): Promise<string> {
    return this.call("pane.read", { pane_id: pane, source: "recent", lines, format: "text", strip_ansi: true }, decodePaneTextResult);
  }

  /** Types literal characters into a pane without submitting (`pane.send_text`). */
  sendText(pane: string, text: string): Promise<void> {
    return this.call("pane.send_text", { pane_id: pane, text }, ignoreResult);
  }

  /**
   * Writes `text` in one write, then presses `keys` (`pane.send_input`): one
   * request, so a multi-line message is one paste followed by exactly the keys
   * given, never a Return per line.
   */
  sendInput(pane: string, text: string, keys: readonly string[]): Promise<void> {
    return this.call("pane.send_input", { pane_id: pane, text, keys }, ignoreResult);
  }

  /**
   * Presses named keys for the pane's agent (`agent.send_keys`): Herdr refuses
   * them (agent_not_found) for a pane whose process is not an agent, so a
   * Return sent this way never reaches a bare shell.
   */
  agentSendKeys(pane: string, keys: readonly string[]): Promise<void> {
    return this.call("agent.send_keys", { target: pane, keys }, ignoreResult);
  }

  /** Types `text` and presses Return. */
  sendLine(pane: string, text: string): Promise<void> {
    return this.sendInput(pane, text, ["Enter"]);
  }

  /**
   * A pane's last `lines` lines as plain text (`pane.read`, source recent,
   * format text, strip_ansi): the Swift app's `paneText(pane:lines:)`, the
   * screen its prompt matcher reads.
   */
  paneRead(pane: string, lines: number): Promise<string> {
    return this.call("pane.read", { pane_id: pane, source: "recent", lines, format: "text", strip_ansi: true }, decodePaneTextResult);
  }

  /**
   * Presses named keys in the pane (`pane.send_keys`): the Swift app's
   * `sendPaneKeys`, the path its answerer takes, since Herdr refuses
   * agent-level input while the agent is blocked on a question.
   */
  paneSendKeys(pane: string, keys: readonly string[]): Promise<void> {
    return this.call("pane.send_keys", { pane_id: pane, keys }, ignoreResult);
  }

  /**
   * Submits `text` to the pane's agent as a prompt (`agent.prompt`, no `wait`:
   * the Swift app's `client.prompt(pane:text:)`); throws Herdr's APIError when
   * it refuses (agent_not_ready, agent_input_pending, …).
   */
  prompt(pane: string, text: string): Promise<void> {
    // Its own deadline (commands.ts promptRoundTripTimeoutMs): the reply can be slower than the 10 s default
    // while the agent works, and the default would cut it short and end the SSH client under it.
    return this.call("agent.prompt", { target: pane, text }, ignoreResult, { timeoutMs: promptRoundTripTimeoutMs });
  }

  /**
   * A terminal tab in one workspace, without changing the desktop's focus
   * (`tab.create`, focus false); `label` and `cwd` left out when null.
   */
  createTerminalTab(workspaceID: string, label: string | null, cwd: string | null): Promise<TabCreation> {
    const params: Record<string, unknown> = { workspace_id: workspaceID, focus: false };
    if (cwd !== null) params["cwd"] = cwd;
    if (label !== null) params["label"] = label;
    return this.call("tab.create", params, decodeTabCreationResult);
  }

  /**
   * A workspace at `cwd` named `label`, without moving the desktop's focus
   * (`workspace.create`, focus false; HerdrClient.createWorkspace): Herdr
   * makes it with one tab holding a shell at the folder.
   */
  createWorkspace(label: string, cwd: string | null): Promise<WorkspaceCreation> {
    const params: Record<string, unknown> = {};
    if (cwd !== null) params["cwd"] = cwd;
    params["focus"] = false;
    params["label"] = label;
    return this.call("workspace.create", params, decodeWorkspaceCreationResult);
  }

  /**
   * Renames a workspace (`workspace.rename`, Herdr 0.9.5 schema: WorkspaceRenameParams { workspace_id, label },
   * both required, answered workspace_info { workspace }; HerdrKit renameWorkspace): the Rename workspace…
   * action. The reply is not read; the snapshot read after it shows the name.
   */
  renameWorkspace(workspaceID: string, label: string): Promise<void> {
    return this.call("workspace.rename", { workspace_id: workspaceID, label }, ignoreResult);
  }

  /**
   * Starts an agent of `kind` named `name` in a pane (`agent.start`). `args` (Herdr 0.9.5 schema
   * AgentStartParams `args: string[]`) go only when given and not empty (Codex's `--no-daemon`, codex-start.ts).
   */
  startAgent(name: string, kind: string, paneID: string, args?: readonly string[]): Promise<AgentInfo> {
    const params: Record<string, unknown> = { name, kind, pane_id: paneID };
    if (args !== undefined && args.length > 0) params["args"] = [...args];
    return this.call("agent.start", params, decodeAgentStartedResult);
  }

  /**
   * Herdr's agent integrations and their state on the machine
   * (`integration.list`, Herdr 0.9.5 schema: IntegrationInfo { target, label, command, available, state }). Read only.
   */
  integrationList(): Promise<IntegrationInfo[]> {
    return this.call("integration.list", {}, decodeIntegrationListResult);
  }

  /**
   * Asks Herdr to install (or update) one agent integration
   * (`integration.install`, IntegrationInstallParams { target }); Herdr's messages (IntegrationInstallResult). Only
   * on a person's click (src/main/integrations.ts), never on its own. Herdr's lines are its `details.messages`;
   * a reply in another shape, or naming another target, is a DecodingError.
   */
  integrationInstall(target: string): Promise<string[]> {
    return this.call("integration.install", { target }, (result, path) => decodeIntegrationInstallResult(result, path, target), { timeoutMs: integrationInstallTimeoutMs });
  }

  /** Closes a pane (`pane.close`): the pane a failed start left behind. */
  closePane(paneID: string): Promise<void> {
    return this.call(paneMethods.close.method, paneMethods.close.params(paneID), ignoreResult);
  }

  /**
   * Sets the pane's label (`pane.rename`; null clears it, so Herdr's own name
   * returns): the Rename… action. Herdr's reply (the pane) is not read; the
   * snapshot read after it shows the name.
   */
  renamePane(paneID: string, label: string | null): Promise<void> {
    return this.call(paneMethods.rename.method, paneMethods.rename.params(paneID, label), ignoreResult);
  }

  /**
   * Renames a tab (`tab.rename`, Herdr 0.9.5 schema: TabRenameParams { tab_id, label }, both required, answered
   * tab_info { tab }; HerdrKit renameTab): for a row whose shown name is its tab's label (the Swift
   * renameTarget). The reply is not read; the snapshot read after it shows the name.
   */
  renameTab(tabID: string, label: string): Promise<void> {
    return this.call(paneMethods.renameTab.method, paneMethods.renameTab.params(tabID, label), ignoreResult);
  }

  /** The layout of the pane's tab (`pane.layout`: pane-methods.ts). */
  paneLayout(paneID: string): Promise<PaneLayout> {
    return this.call(paneMethods.layout.method, paneMethods.layout.params(paneID), decodePaneLayoutResult);
  }

  /** Splits a pane right or down (`pane.split`); the new pane. */
  splitPane(split: SplitParams): Promise<TopologyPaneInfo> {
    return this.call(paneMethods.split.method, paneMethods.split.params(split), decodePaneInfoResult);
  }

  /** Sets the ratio of the tab's split at `path` (`layout.set_split_ratio`); the tab's layout tree after it. */
  setSplitRatio(tabID: string, path: readonly boolean[], ratio: number): Promise<SplitRatioLayout> {
    return this.call(paneMethods.setSplitRatio.method, paneMethods.setSplitRatio.params(tabID, path, ratio), decodeSplitRatioResult);
  }

  /** Zooms the pane in its tab, or ends the zoom (`pane.zoom` mode on or off); Herdr's zoom and the tab's layout after it. */
  zoomPane(paneID: string, zoomed: boolean): Promise<PaneZoom> {
    return this.call(paneMethods.zoom.method, paneMethods.zoom.params(paneID, zoomed), decodePaneZoomResult);
  }
}
