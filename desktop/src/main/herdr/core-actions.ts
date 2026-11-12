// The app's actions on a herdr-core pane, as herdr-core calls (the Swift
// client's CoreBridgeActions.swift). What the box
// sends goes as the box sends it to Herdr: text and Return (`terminal.send`:
// pasted, then Enter), text alone (typed on a short attach), named keys
// (`terminal.keys`), the stop key (`terminal.interrupt`). An agent-bound Send
// or Return is held to the agent (agentGate): the agent must be in the pane,
// read as the core has it now (`terminal.get`), report a status, be its
// terminal's own program, and say idle or working; then `terminal.send` with
// `if` set to that word, so the core types only while it still says so.
// New tab and New agent start this machine's shell in the space
// (`terminal.run` with `herdr.space` / `herdr.tab` labels, as Herdr App
// labels the terminals it starts). Close is `terminal.kill` then
// `terminal.rm`. A space or tab is renamed in Herdr App's `herdr-app`
// document with its version (a conflict reads it again once).

import { randomUUID } from "node:crypto";

import { CoreTUIWire, type BridgeRequest, type CoreActionHandler } from "./core-bridge";
import { CoreConnectionError, CoreRPCError, type CoreConnection } from "./core-connection";
import { CoreFrames } from "./core-frames";
import type { CoreFollower } from "./core-follower";
import { jsonArray, jsonBool, jsonInt, jsonObject, jsonString, member, type CoreJSON, type CoreObject } from "./core-json";
import { CoreIDs, CoreLayoutDocument } from "./core-model";
import { CoreAgentKind, CoreStatusMapping } from "./core-projection";
import { herdrStartArgs } from "../../shared/codex-start";
import { coreStartWords } from "../../shared/model-choices";
import { decodeCoreAttachResult, decodeCoreTerminal, isLive, type CoreTerminal } from "./core-wire";
import { APIError, type AgentInfo, type TabInfo, type TopologyPaneInfo } from "./wire";

/** Herdr's key names (tmux style, protocol 22) as herdr-core's (`terminal.keys`: "enter, esc, tab, up, ctrl+c, alt+x, f5, a, ..."). */
export function coreKey(key: string): string {
  switch (key) {
    case "Enter":
    case "Return":
    case "C-m":
    case "KPEnter":
      return "enter";
    case "Escape":
    case "Esc":
    case "C-[":
      return "esc";
    case "Tab":
    case "C-i":
      return "tab";
    case "BTab":
      return "shift+tab";
    case "BSpace":
    case "Backspace":
    case "BackSpace":
      return "backspace";
    case "Space":
      return "space";
    case "PageUp":
    case "PgUp":
    case "PPage":
      return "pageup";
    case "PageDown":
    case "PgDn":
    case "NPage":
      return "pagedown";
    case "DC":
    case "Delete":
      return "delete";
    case "IC":
    case "Insert":
      return "insert";
    case "Up":
    case "Down":
    case "Left":
    case "Right":
    case "Home":
    case "End":
      return key.toLowerCase();
    default:
      break;
  }
  const length = [...key].length;
  if (length > 2 && key.startsWith("C-")) return `ctrl+${coreKey(key.slice(2))}`;
  if (length > 2 && key.startsWith("M-")) return `alt+${coreKey(key.slice(2))}`;
  if (length > 2 && key.startsWith("S-")) return `shift+${coreKey(key.slice(2))}`;
  if (length === 1) return key;
  return key.toLowerCase();
}

/** What the bridge says for core panes, in the app's own words (CoreActionText). */
export const CoreActionText = {
  renameTerminal: "Rename this terminal in Herdr App: herdr-core has no rename for a terminal.",
  renameMachine: "This group is the machine's own terminals; it has no name to change.",
  newSpace: "New spaces are made in Herdr App.",
  /** An agent-bound Send or Return to an agent that reports no status, which herdr-core cannot hold the input to. */
  agentUnverified:
    "Not sent: herdr-core cannot confirm the agent is still the program in this terminal " +
    "when the text arrives (the agent reports no status), so the app does not type into it. Type in its terminal instead.",
  /** The status changed between the app's check and the core's typing. */
  agentChanged:
    "Nothing was typed: the agent's status changed as the text was about to go in " + "(it may have finished or left). Check its terminal, then try again.",
  /** terminal.send's `if` takes only `idle` or `working`, so Return cannot be held to a dialog being open. */
  agentDialog: "Not pressed: herdr-core cannot hold Return to the agent's dialog, " + "so the app does not press it. Answer the dialog in its terminal.",
  /** An agent that is not its terminal's own program. */
  agentUnbound:
    "Not sent: herdr-core can hold a message to an agent only when the agent is " +
    "its terminal's own program. This one runs inside a shell, and if it has left, the shell would get the text, " +
    "so the app does not type into it. Type in its terminal instead.",
  /** A prompt to an agent that says it is waiting for an answer. */
  agentBlocked: "Not sent: the agent is waiting for an answer in its terminal. Answer it there first.",
  /** A status word `if` cannot hold (done, error, or the program's own). */
  agentWord: (word: string): string =>
    "Not sent: herdr-core can hold a message only to an agent that says it is idle or working; " +
    `this one says “${word}”, so the app does not type into it. Type in its terminal instead.`,
  /** Keys other than Return or the stop key, bound to an agent. */
  agentKeys: "herdr-core cannot hold these keys to the agent, so the app does not press them. Press them in its terminal.",
  /** Input to a terminal whose program ended (it stays until closed). */
  ended: "This terminal's program has ended, so it takes no input. Close the pane to remove it.",
  /** A rename that met a layout Herdr App changed at the same moment. */
  renamedAfterConflict: (what: string): string => `Renamed. Herdr App changed its layout at the same moment, so the ${what} was renamed on its newer layout.`,
};

/** The app saw this pane: `herdr.seen=<turn>` when its turn is past what was seen (docs/labels.md: once per turn, only ever raised). */
export const coreSeenMethod = "hc.mark_seen";

/** What an agent-bound send is: a prompt, or Return alone. */
type AgentInput = "prompt" | "returnKey";

const stringsOf = (value: CoreJSON | undefined): string[] => (jsonArray(value) ?? []).flatMap((item) => (typeof item === "string" ? [item] : []));

/** herdr-core's refusal in Herdr's words (`forAgent`: as Herdr refuses an agent call: blocked is "waiting for an answer"). */
export function coreActionError(refusal: CoreRPCError, forAgent: boolean): APIError {
  let code: string;
  switch (refusal.kind) {
    case "blocked":
      code = "agent_input_pending";
      break;
    case "unavailable":
      code = forAgent ? "agent_not_ready" : "pane_unavailable";
      break;
    case "not_found":
    case "machine_unknown":
      code = forAgent ? "agent_not_found" : "pane_not_found";
      break;
    case "status_mismatch":
      // The `if` condition failed: nothing was typed.
      return new APIError(forAgent ? "agent_not_ready" : "status_mismatch", CoreActionText.agentChanged);
    case "finished":
      // The terminal stays (an ended row) until it is closed; say so.
      return forAgent ? new APIError("agent_not_found", CoreActionText.ended) : new APIError("pane_exited", CoreActionText.ended);
    case undefined:
      code = "core_error";
      break;
    default:
      code = refusal.kind;
  }
  return new APIError(code, refusal.description);
}

/** A core pane id's terminal address; Herdr's pane_not_found otherwise. */
export function coreAddress(id: CoreJSON | undefined): string {
  const text = jsonString(id);
  const address = text === undefined ? undefined : CoreIDs.address(text);
  if (address === undefined) throw new APIError("pane_not_found", `not a herdr-core pane: ${text ?? "none"}`);
  return address;
}

/** The agent in front is the terminal's own program (its foreground pid is the terminal's), so its status ends with it. */
export function agentIsTheProgram(terminal: CoreTerminal): boolean {
  const foreground = terminal.foreground;
  if (foreground === undefined || terminal.pid === undefined || foreground.pid !== terminal.pid) return false;
  return CoreAgentKind.detectProcess(foreground.name, foreground.argv) !== undefined;
}

/** The box's paste markers off: `terminal.send` pastes by itself. */
export function unframed(text: string): string {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  if (!text.startsWith(start) || !text.endsWith(end) || text.length < start.length + end.length) return text;
  return text.slice(start.length, text.length - end.length);
}

/** Where a core workspace's terminals start: the machine, the space. */
export function corePlacement(workspaceID: string): { readonly machine?: string; readonly space?: string } | undefined {
  const space = CoreIDs.spaceID(workspaceID);
  if (space !== undefined) return space.machine === undefined ? { space: space.id } : { machine: space.machine, space: space.id };
  if (workspaceID === CoreIDs.machineGroup()) return {};
  const head = `${CoreIDs.machineGroup()}:`;
  if (workspaceID.startsWith(head)) return { machine: workspaceID.slice(head.length) };
  return undefined;
}

/** A name herdr-core takes (1-32 of a-z 0-9 - _ .), or undefined. */
export function coreTerminalName(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const lower = label.toLowerCase();
  return /^[a-z0-9\-_.]{1,32}$/.test(lower) ? lower : undefined;
}

/** The document with one space's or tab's `name` changed; undefined when it has none such. */
export function renamedDocument(document: CoreJSON, spaceID: string | undefined, tabID: string | undefined, name: string): CoreJSON | undefined {
  const root = jsonObject(document);
  const spaces = jsonArray(root?.["spaces"]);
  if (root === undefined || spaces === undefined) return undefined;
  let found = false;
  const changed = spaces.map((entry) => {
    const space = jsonObject(entry);
    if (space === undefined) return entry;
    if (spaceID !== undefined && jsonString(space["id"]) === spaceID) {
      found = true;
      return { ...space, name };
    }
    if (tabID !== undefined) {
      const tabs = jsonArray(space["tabs"]);
      if (tabs === undefined) return entry;
      return {
        ...space,
        tabs: tabs.map((each) => {
          const tab = jsonObject(each);
          if (tab === undefined || jsonString(tab["id"]) !== tabID) return each;
          found = true;
          return { ...tab, name };
        }),
      };
    }
    return entry;
  });
  if (!found) return undefined;
  return { ...root, spaces: changed };
}

/** The agent `agent.start` reports: starting, not ready yet. */
function starting(kind: string, paneID: string, name: string | undefined): AgentInfo {
  return {
    agent: kind,
    agentStatus: "unknown",
    ...(name === undefined ? {} : { name }),
    paneID,
    terminalID: paneID,
    focused: false,
    interactiveReady: false,
    launchPending: true,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The actions for one core (CoreBridgeTransport's `coreAction`). */
export class CoreActions {
  /** How long a new pane is waited for in the stream, and how often it is looked for. */
  shownTries = 60;
  shownIntervalMs = 50;

  constructor(private readonly follower: CoreFollower) {}

  /** The handler the bridge calls. */
  get handler(): CoreActionHandler {
    return (request) => this.act(request);
  }

  /** The action for `request`, or null when it is not one this bridge does. */
  async act(request: BridgeRequest): Promise<CoreJSON | null> {
    const params = request.params;
    const p = (key: string): CoreJSON | undefined => member(params, key);
    switch (request.method) {
      case "agent.prompt": {
        // Typed only while the agent's status is still the one checked: herdr-core holds the
        // send to it as it types.
        const address = coreAddress(p("target"));
        const word = await this.agentGate(address, "prompt");
        const sent = await this.call("terminal.send", { terminal: address, text: p("text") ?? "", if: word }, true);
        const result: Record<string, CoreJSON> = { type: "agent_prompted" };
        // `started`: it went working (a turn began); null: it doesn't say.
        const started = jsonBool(member(sent, "started"));
        if (started === true) result["delivery"] = "submitted";
        else if (started === false) result["delivery"] = "written_to_pty";
        return result;
      }
      case "pane.send_input": {
        const address = coreAddress(p("pane_id"));
        const text = jsonString(p("text")) ?? "";
        const keys = stringsOf(p("keys"));
        if (keys.length === 1 && keys[0] === "Enter" && text !== "") {
          // The box's Send: pasted, then Enter.
          await this.call("terminal.send", { terminal: address, text: unframed(text) });
          return {};
        }
        if (text !== "") await this.type(address, new TextEncoder().encode(text));
        if (keys.length > 0) await this.pressKeys(address, keys);
        return {};
      }
      case "pane.send_text": {
        const address = coreAddress(p("pane_id"));
        await this.type(address, new TextEncoder().encode(jsonString(p("text")) ?? ""));
        return {};
      }
      case "pane.send_keys": {
        const address = coreAddress(p("pane_id"));
        await this.pressKeys(address, stringsOf(p("keys")));
        return {};
      }
      case "agent.send_keys": {
        // Gated as Herdr gates it: never into a pane whose agent left.
        const address = coreAddress(p("target"));
        const keys = stringsOf(p("keys"));
        const mapped = keys.map(coreKey);
        if (mapped.length === 1 && mapped[0] === "esc") {
          // The stop key (terminal.interrupt for a program that reports status); a shell does nothing with it.
          await this.requireAgent(address);
          await this.pressKeys(address, keys);
          return {};
        }
        if (mapped.length !== 1 || mapped[0] !== "enter") {
          // terminal.keys takes no condition: keys bound to an agent could land in the shell that replaced it.
          await this.requireAgent(address);
          throw new APIError("unsupported", CoreActionText.agentKeys);
        }
        // Return (the box's after an Insert): an empty terminal.send under the same condition as a prompt. A
        // dialog's Return is refused (no condition can hold it).
        const word = await this.agentGate(address, "returnKey");
        await this.call("terminal.send", { terminal: address, text: "", if: word }, true);
        return {};
      }
      case "pane.read":
      case "agent.read": {
        const paneID = jsonString(p("pane_id")) ?? jsonString(p("target")) ?? "";
        const address = coreAddress(paneID);
        const read: Record<string, CoreJSON> = { terminal: address };
        const lines = jsonInt(p("lines"));
        if (lines !== undefined) read["lines"] = lines;
        const answer = await this.call("terminal.read", read);
        return {
          read: {
            pane_id: paneID,
            text: member(answer, "text") ?? "",
            truncated: !(jsonBool(member(answer, "complete")) ?? true),
            source: p("source") ?? "recent",
            format: p("format") ?? "text",
          },
        };
      }
      case "pane.close": {
        // Closing removes the pane, as Herdr's pane.close does: end the program if it still runs, then drop the
        // record, so no ended row stays behind (a finished terminal stays until removed).
        const address = coreAddress(p("pane_id"));
        const terminal = this.follower.terminal(address);
        if (terminal === undefined || isLive(terminal)) await this.call("terminal.kill", { terminal: address });
        await this.call("terminal.rm", { terminal: address }, false, true);
        return {};
      }
      case "tab.create":
        return this.newTab(jsonString(p("workspace_id")) ?? "", jsonString(p("cwd")), jsonString(p("label")));
      case "pane.split":
        return this.split(jsonString(p("target_pane_id")), jsonString(p("cwd")));
      case "agent.start": {
        // Herdr's default start for a kind, typed into the pane's shell as `exec <kind>`: the agent
        // becomes the terminal's own program, so herdr-core resets its status when it ends and prompts can be
        // held to it.
        const address = coreAddress(p("pane_id"));
        const kind = jsonString(p("kind")) ?? "";
        // Never `exec cursor` (the editor's launcher, not its agent).
        if (!CoreAgentKind.known.includes(kind) || kind === "cursor") throw new APIError("invalid_request", `unknown agent kind ${kind}`);
        // The args Adari's start gives (Codex's `--no-daemon`, codex-start.ts herdrStartArgs), and the model and
        // effort flags (each a kind's own flag and a value of its pattern, quoted): any other word is refused,
        // never typed.
        const args = jsonArray(p("args"))?.map((word) => jsonString(word)) ?? [];
        const words = args.every((word): word is string => word !== undefined) ? coreStartWords(kind, herdrStartArgs(kind) ?? [], args) : null;
        if (words === null) throw new APIError("invalid_request", `unsupported args for ${kind}`);
        await this.call("terminal.send", { terminal: address, text: [`exec ${kind}`, ...words].join(" ") });
        return { agent: CoreTUIWire.agent(starting(kind, CoreIDs.pane(address), jsonString(p("name")))) };
      }
      case "workspace.rename": {
        const id = jsonString(p("workspace_id")) ?? "";
        const notice = await this.renameInDocument(id, undefined, jsonString(p("label")) ?? "");
        return { workspace: { workspace_id: id }, ...(notice === null ? {} : { notice }) };
      }
      case "tab.rename": {
        const id = jsonString(p("tab_id")) ?? "";
        const notice = await this.renameInDocument(undefined, id, jsonString(p("label")) ?? "");
        return { tab: { tab_id: id }, ...(notice === null ? {} : { notice }) };
      }
      case "pane.rename":
      case "agent.rename":
        throw new APIError("unsupported", CoreActionText.renameTerminal);
      case "workspace.create":
        throw new APIError("unsupported", CoreActionText.newSpace);
      case coreSeenMethod: {
        await this.markSeen(coreAddress(p("pane_id")));
        return {};
      }
      default:
        return null;
    }
  }

  async markSeen(address: string): Promise<void> {
    const terminal = this.follower.terminal(address);
    if (terminal === undefined || !isLive(terminal)) return;
    const seen = CoreStatusMapping.seenTurn(terminal);
    if (seen !== undefined && seen >= terminal.turn) return;
    await this.call("terminal.label", { terminal: address, labels: { "herdr.seen": String(terminal.turn) } });
  }

  // MARK: - Calls

  private async connection(): Promise<CoreConnection> {
    try {
      return await this.follower.connection();
    } catch (error) {
      throw new APIError("server_unavailable", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * One herdr-core call, its refusal in Herdr's words (`forAgent`: as Herdr refuses an agent call). `absentIsDone`:
   * a `not_found` answer means it is already as asked (a removal another client or `run --rm` did first).
   */
  async call(method: string, params: CoreObject, forAgent = false, absentIsDone = false): Promise<CoreJSON> {
    const connection = await this.connection();
    try {
      return await connection.call(method, params);
    } catch (error) {
      if (error instanceof CoreRPCError) {
        if (absentIsDone && error.kind === "not_found") return null;
        throw coreActionError(error, forAgent);
      }
      if (error instanceof CoreConnectionError) throw new APIError("server_unavailable", error.message);
      throw error;
    }
  }

  /**
   * The condition an agent-bound Send or Return types under. The agent
   * must be in the pane (requireAgent); the terminal is read as the core has it now (`terminal.get`, not the
   * event-fed model); it must report a status (agent_unverified), its foreground must be an agent whose pid is the
   * terminal's own (agent_unbound: the core resets the status only when the terminal's own program ends, so `if`
   * holds the text to the agent only then), and the word must be one `if` takes: idle or working. Blocked is
   * refused as waiting for an answer (a prompt: agent_blocked) or as a dialog no condition can hold (Return:
   * agent_dialog); any other word is agent_word. Nothing is sent before every check passes.
   */
  async agentGate(address: string, input: AgentInput): Promise<string> {
    await this.requireAgent(address);
    const now = await this.call("terminal.get", { terminal: address }, true);
    let terminal: CoreTerminal | undefined;
    try {
      terminal = decodeCoreTerminal(now);
    } catch {
      terminal = undefined;
    }
    if (terminal === undefined || !isLive(terminal)) throw new APIError("agent_not_found", CoreActionText.ended);
    const word = terminal.status?.state;
    if (!terminal.reported || word === undefined || word === "") throw new APIError("agent_unverified", CoreActionText.agentUnverified);
    if (!agentIsTheProgram(terminal)) throw new APIError("agent_unbound", CoreActionText.agentUnbound);
    // As the Swift client's agentGate: a kept terminal's own-program agent goes too, held by
    // its status word like any other. This is status-gated, not an atomic run guarantee: herdr-core gen 1's
    // terminal.send takes `if` with a status word and no pid or run, so an agent exec'd in a kept terminal's
    // replacement shell (after a signal death and the core's recovery delay) that says the same word inside the
    // terminal.get-to-terminal.send interval would get it. Only an expected-run condition upstream would close that.
    switch (word) {
      case "idle":
      case "working":
        return word;
      case "blocked":
        if (input === "returnKey") throw new APIError("agent_dialog", CoreActionText.agentDialog);
        throw new APIError("agent_blocked", CoreActionText.agentBlocked);
      default:
        throw new APIError("agent_word", CoreActionText.agentWord(word));
    }
  }

  /** Refuses (as Herdr does, `agent_not_found`) when no agent runs in the pane now. */
  async requireAgent(address: string): Promise<void> {
    const projection = await this.follower.snapshot();
    const paneID = CoreIDs.pane(address);
    if (!projection.agents.some((agent) => agent.paneID === paneID)) throw new APIError("agent_not_found", `no agent runs in ${paneID} now`);
  }

  /** Named keys; a lone Escape to a program that reports status is the stop key, as `terminal.interrupt` presses it (esc). */
  async pressKeys(address: string, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    if (keys.length === 1 && keys[0] === "Escape" && this.follower.terminal(address)?.reported === true) {
      await this.call("terminal.interrupt", { terminal: address, timeout: 5 });
      return;
    }
    await this.call("terminal.keys", { terminal: address, keys: keys.map(coreKey) });
  }

  /** Text with nothing pressed after it: typed as keys on a short attach (DATA, then CLOSE) at the terminal's own size, so nothing resizes. */
  async type(address: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    const connection = await this.connection();
    const terminal = this.follower.terminal(address);
    let channel: number;
    try {
      const attach = decodeCoreAttachResult(await connection.call("terminal.attach", { terminal: address, cols: terminal?.cols ?? 80, rows: terminal?.rows ?? 24 }));
      channel = attach.channel;
    } catch (error) {
      if (error instanceof CoreRPCError) throw coreActionError(error, false);
      if (error instanceof CoreConnectionError) throw new APIError("server_unavailable", error.message);
      throw error;
    }
    let sent = true;
    for (let offset = 0; offset < bytes.length; offset += 1 << 20) {
      sent = connection.send(CoreFrames.data(channel, bytes.subarray(offset, Math.min(bytes.length, offset + (1 << 20))))) && sent;
    }
    connection.send(CoreFrames.close(channel));
    connection.forget(channel);
    if (!sent) throw new APIError("server_unavailable", "the connection to herdr-core closed");
  }

  // MARK: - New terminals

  static newTabID(): string {
    return `c${randomUUID().replaceAll("-", "").slice(0, 10).toLowerCase()}`;
  }

  /** This machine's shell in a new terminal (`terminal.run` without argv). */
  async runShell(machine: string | undefined, labels: Record<string, string>, cwd: string | undefined, name: string | undefined): Promise<string> {
    const params: Record<string, CoreJSON> = {
      labels,
      keep: true,
      // The terminal identity this app's screen gives (as the TUI's attach PTY does).
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
    };
    if (cwd !== undefined) params["cwd"] = cwd;
    if (machine !== undefined) params["on"] = machine;
    if (name !== undefined) params["name"] = name;
    let record: CoreJSON;
    try {
      record = await this.call("terminal.run", params);
    } catch (error) {
      if (!(error instanceof APIError) || error.code !== "name_taken" || name === undefined) throw error;
      delete params["name"];
      record = await this.call("terminal.run", params);
    }
    let address = jsonString(member(record, "address"));
    if (address === undefined) throw new APIError("core_error", "terminal.run gave no address");
    if (machine !== undefined && !address.startsWith(`${machine}/`)) address = `${machine}/${address}`;
    return address;
  }

  /** The new pane as the projection shows it (waits briefly for its `created` event), with its tab. */
  async shown(address: string): Promise<{ readonly pane: TopologyPaneInfo; readonly tab: TabInfo } | null> {
    const paneID = CoreIDs.pane(address);
    for (let attempt = 0; attempt < this.shownTries; attempt += 1) {
      const projection = await this.follower.snapshot();
      const pane = projection.topology.panes.find((each) => each.paneID === paneID);
      const tab = pane === undefined ? undefined : projection.topology.tabs.find((each) => each.tabID === pane.tabID);
      if (pane !== undefined && tab !== undefined) return { pane, tab };
      await sleep(this.shownIntervalMs);
    }
    return null;
  }

  async newTab(workspaceID: string, cwd: string | undefined, label: string | undefined): Promise<CoreJSON> {
    const place = corePlacement(workspaceID);
    if (place === undefined) throw new APIError("workspace_not_found", `not a herdr-core space: ${workspaceID}`);
    let labels: Record<string, string> = {};
    let tabID = CoreIDs.machineTab(place.machine);
    if (place.space !== undefined) {
      const id = CoreActions.newTabID();
      labels = { "herdr.space": place.space, "herdr.tab": id };
      tabID = CoreIDs.tab(id, place.machine);
    }
    const name = coreTerminalName(label);
    const address = await this.runShell(place.machine, labels, cwd, name);
    const shown = await this.shown(address);
    if (shown !== null) return { tab: CoreTUIWire.tab(shown.tab), root_pane: CoreTUIWire.pane(shown.pane) };
    // Not in the stream yet: the ids it will have.
    const pane: TopologyPaneInfo = {
      paneID: CoreIDs.pane(address),
      terminalID: CoreIDs.pane(address),
      workspaceID,
      tabID,
      focused: false,
      ...(cwd === undefined ? {} : { cwd }),
      ...(name === undefined ? {} : { label: name }),
      agentStatus: "unknown",
      revision: 0,
    };
    const tab: TabInfo = { tabID, workspaceID, number: 1, label: label ?? "Tab", focused: false, paneCount: 1, agentStatus: "unknown" };
    return { tab: CoreTUIWire.tab(tab), root_pane: CoreTUIWire.pane(pane) };
  }

  /** A new terminal beside `target`: the same space and tab. */
  async split(target: string | undefined, cwd: string | undefined): Promise<CoreJSON> {
    const projection = await this.follower.snapshot();
    const pane = target === undefined ? undefined : projection.topology.panes.find((each) => each.paneID === target);
    const place = pane === undefined ? undefined : corePlacement(pane.workspaceID);
    if (target === undefined || pane === undefined || place === undefined) throw new APIError("pane_not_found", `no herdr-core pane ${target ?? "none"}`);
    const targetAddress = CoreIDs.address(target);
    const machine = (targetAddress === undefined ? undefined : CoreIDs.machine(targetAddress)) ?? place.machine;
    const labels = this.splitLabels(target, pane, place, machine);
    const address = await this.runShell(machine, labels, cwd ?? pane.foregroundCWD ?? pane.cwd, undefined);
    const shown = await this.shown(address);
    if (shown !== null) return { pane: CoreTUIWire.pane(shown.pane) };
    const fresh: TopologyPaneInfo = {
      paneID: CoreIDs.pane(address),
      terminalID: CoreIDs.pane(address),
      workspaceID: pane.workspaceID,
      tabID: pane.tabID,
      focused: false,
      ...(cwd === undefined ? {} : { cwd }),
      agentStatus: "unknown",
      revision: 0,
    };
    return { pane: CoreTUIWire.pane(fresh) };
  }

  /**
   * The space and tab a split's new terminal joins: the target terminal's own, read from
   * its herdr.space/herdr.tab labels, else from its machine's herdr-app document, else from the space workspace it
   * shows in. A terminal on another machine shows in that machine's group, so its workspace alone cannot say.
   */
  splitLabels(target: string, pane: TopologyPaneInfo, place: { readonly machine?: string; readonly space?: string }, machine: string | undefined): Record<string, string> {
    let space: string | undefined;
    let tab: string | undefined;
    const address = CoreIDs.address(target);
    if (address !== undefined) {
      const terminal = this.follower.terminal(address);
      if (terminal !== undefined) {
        const labelSpace = terminal.labels["herdr.space"];
        const labelTab = terminal.labels["herdr.tab"];
        space = labelSpace === undefined || labelSpace === "" ? undefined : labelSpace;
        tab = labelTab === undefined || labelTab === "" ? undefined : labelTab;
      }
      const document = space === undefined || tab === undefined ? this.follower.layoutDocument(machine) : undefined;
      if (document !== undefined) {
        const local = machine === undefined ? address : address.slice(machine.length + 1);
        const placed = document.placement(local);
        if (placed !== undefined) {
          space ??= placed.space.id;
          if (tab === undefined && space === placed.space.id) tab = placed.tab.id;
        }
      }
    }
    space ??= place.space;
    if (tab === undefined && space !== undefined && space === place.space) tab = CoreIDs.tabID(pane.tabID)?.id;
    if (space === undefined || tab === undefined) return {};
    return { "herdr.space": space, "herdr.tab": tab };
  }

  // MARK: - Rename (Herdr App's document)

  /**
   * Renames a space (`workspaceID`) or a tab (`tabID`) in `herdr-app` on its machine: read, change that one name,
   * write with the version read. Everything else in the document is written back as read. A conflict (Herdr App
   * wrote meanwhile) reads it again, once. Returns what to say when it went through on a re-read (null: first time).
   */
  async renameInDocument(workspaceID: string | undefined, tabID: string | undefined, name: string): Promise<string | null> {
    const trimmed = name.trim();
    if (trimmed === "") throw new APIError("invalid_request", "empty name");
    let target: { readonly id: string; readonly machine?: string };
    if (workspaceID !== undefined) {
      const space = CoreIDs.spaceID(workspaceID);
      if (space === undefined) throw new APIError("unsupported", CoreActionText.renameMachine);
      target = space;
    } else {
      const tab = tabID === undefined ? undefined : CoreIDs.tabID(tabID);
      if (tab === undefined) throw new APIError("unsupported", CoreActionText.renameMachine);
      target = tab;
    }
    const what = workspaceID === undefined ? "tab" : "space";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const get: Record<string, CoreJSON> = { name: CoreLayoutDocument.documentName };
      if (target.machine !== undefined) get["on"] = target.machine;
      const current = await this.call("doc.get", get);
      const version = member(current, "version") ?? 0;
      const renamed = renamedDocument(member(current, "value") ?? null, workspaceID === undefined ? undefined : target.id, workspaceID === undefined ? target.id : undefined, trimmed);
      if (renamed === undefined) {
        throw new APIError(
          workspaceID === undefined ? "tab_not_found" : "workspace_not_found",
          `Herdr App's layout has no such ${what} (it may be made only by a label). Rename it in Herdr App.`,
        );
      }
      const set: Record<string, CoreJSON> = { name: CoreLayoutDocument.documentName, value: renamed, version };
      if (target.machine !== undefined) set["on"] = target.machine;
      try {
        await this.call("doc.set", set);
        return attempt > 0 ? CoreActionText.renamedAfterConflict(what) : null;
      } catch (error) {
        if (error instanceof APIError && error.code === "conflict" && attempt === 0) continue;
        throw error;
      }
    }
    return null;
  }
}

/** The bridge's actions for a follower (HerdrCoreBackendOptions.act's default). */
export function coreActions(follower: CoreFollower): CoreActionHandler {
  return new CoreActions(follower).handler;
}
