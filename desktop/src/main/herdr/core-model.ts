// herdr-core's terminals as one event stream describes them, and the ids and
// layout document the projection groups them by (the Swift client's
// CoreModel.swift). Pure: notifications in, a model and an outcome out.

import { jsonArray, jsonBool, jsonInt, jsonObject, jsonString, jsonU64, member, coreJSONString, type CoreJSON } from "./core-json";
import {
  coreMachineOf,
  decodeCoreForeground,
  decodeCoreStatus,
  encodeCoreTerminal,
  tryDecodeCoreTerminal,
  type CoreNotification,
  type CoreStatus,
  type CoreSubscribeResult,
  type CoreTerminal,
} from "./core-wire";
import { coreIDPrefix } from "../../shared/core-ids";
import { wideInt, type WideInt } from "../../shared/wide-int";

/** The app's ids for core things: every one starts with `hc:`, so a request names its backend by its ids alone. */
export const CoreIDs = {
  prefix: coreIDPrefix,

  isCore(id: string): boolean {
    return id.startsWith(CoreIDs.prefix);
  },

  /** A terminal's pane id, which is also its attach target: `hc:t7`, `hc:studio/t7`. */
  pane(address: string): string {
    return CoreIDs.prefix + address;
  },

  /** The terminal address in a core pane (or terminal) id; undefined for a TUI id (or a space, tab or machine group). */
  address(id: string): string | undefined {
    if (!CoreIDs.isCore(id)) return undefined;
    const rest = id.slice(CoreIDs.prefix.length);
    if (rest === "" || rest.startsWith("space:") || rest.startsWith("tab:") || isMachineGroup(rest)) return undefined;
    return rest;
  },

  /** `studio` in `studio/t7`; undefined for this machine's terminals. */
  machine(address: string): string | undefined {
    return coreMachineOf(address);
  },

  /** A Herdr App space on this machine (`machine` undefined) or another. */
  space(id: string, machine?: string): string {
    return `${CoreIDs.prefix}space:${machine === undefined ? "" : `${machine}/`}${id}`;
  },

  tab(id: string, machine?: string): string {
    return `${CoreIDs.prefix}tab:${machine === undefined ? "" : `${machine}/`}${id}`;
  },

  /** The group for terminals in no space: this machine's, or another's. */
  machineGroup(machine?: string): string {
    return `${CoreIDs.prefix}machine${machine === undefined ? "" : `:${machine}`}`;
  },

  machineTab(machine?: string): string {
    return `${CoreIDs.prefix}tab:machine${machine === undefined ? "" : `:${machine}`}`;
  },

  /** The Herdr App space id inside a workspace id from `space()`. */
  spaceID(workspaceID: string): { readonly id: string; readonly machine?: string } | undefined {
    const head = `${CoreIDs.prefix}space:`;
    if (!workspaceID.startsWith(head)) return undefined;
    return split(workspaceID.slice(head.length));
  },

  tabID(tabID: string): { readonly id: string; readonly machine?: string } | undefined {
    const head = `${CoreIDs.prefix}tab:`;
    if (!tabID.startsWith(head)) return undefined;
    const rest = tabID.slice(head.length);
    if (isMachineGroup(rest)) return undefined;
    return split(rest);
  },
};

/** The reserved group forms exactly: `machine` and `machine:<name>`, not a machine whose name only begins with "machine". */
function isMachineGroup(rest: string): boolean {
  return rest === "machine" || rest.startsWith("machine:");
}

function split(rest: string): { readonly id: string; readonly machine?: string } {
  const slash = rest.indexOf("/");
  if (slash < 0) return { id: rest };
  return { id: rest.slice(slash + 1), machine: rest.slice(0, slash) };
}

export interface CoreLayoutSpace {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly tabs: readonly CoreLayoutTab[];
}

export interface CoreLayoutTab {
  readonly id: string;
  readonly name: string;
  /** Terminal addresses in the tab's layout, in tree order. */
  readonly terminals: readonly string[];
}

/** Herdr App's layout document `herdr-app` (spaces, each with tabs whose layout tree names terminals). Read leniently: what it does not know it skips. */
export class CoreLayoutDocument {
  static readonly documentName = "herdr-app";
  static readonly empty = new CoreLayoutDocument([], 0);

  constructor(
    readonly spaces: readonly CoreLayoutSpace[],
    readonly version: WideInt,
  ) {}

  /** From `doc.get`'s `{value, version}` (a null value: no spaces). */
  static from(value: CoreJSON | undefined, version: WideInt): CoreLayoutDocument {
    const spaces: CoreLayoutSpace[] = [];
    for (const space of jsonArray(member(value, "spaces")) ?? []) {
      const id = jsonString(member(space, "id"));
      if (id === undefined || id === "") continue;
      const tabs: CoreLayoutTab[] = [];
      for (const tab of jsonArray(member(space, "tabs")) ?? []) {
        const tabID = jsonString(member(tab, "id"));
        if (tabID === undefined || tabID === "") continue;
        const terminals: string[] = [];
        CoreLayoutDocument.collectTerminals(member(tab, "root"), terminals);
        tabs.push({ id: tabID, name: jsonString(member(tab, "name")) ?? "", terminals });
      }
      spaces.push({ id, name: jsonString(member(space, "name")) ?? "", folder: jsonString(member(space, "folder")) ?? "", tabs });
    }
    return new CoreLayoutDocument(spaces, version);
  }

  /** Every `{"terminal": "<address>"}` in a layout tree (untagged leaves), in order. */
  static collectTerminals(node: CoreJSON | undefined, out: string[]): void {
    if (Array.isArray(node)) {
      for (const item of node as readonly CoreJSON[]) CoreLayoutDocument.collectTerminals(item, out);
      return;
    }
    const object = jsonObject(node);
    if (object === undefined) return;
    const terminal = jsonString(object["terminal"]);
    if (terminal !== undefined && !out.includes(terminal)) out.push(terminal);
    for (const key of Object.keys(object).sort()) {
      if (key !== "terminal") CoreLayoutDocument.collectTerminals(object[key], out);
    }
  }

  space(id: string): CoreLayoutSpace | undefined {
    return this.spaces.find((space) => space.id === id);
  }

  /** The space and tab whose layout holds `address` (a local address on that machine). */
  placement(address: string): { readonly space: CoreLayoutSpace; readonly tab: CoreLayoutTab } | undefined {
    for (const space of this.spaces) {
      for (const tab of space.tabs) if (tab.terminals.includes(address)) return { space, tab };
    }
    return undefined;
  }
}

export type CoreModelOutcome =
  /** The event was applied; `changed` names the terminal it changed (undefined: nothing visible changed). */
  | { readonly kind: "applied"; readonly changed?: string }
  /** Not above the current seq: already in the snapshot. */
  | { readonly kind: "stale" }
  /** A seq was skipped (`expected` was next): take a fresh snapshot. */
  | { readonly kind: "gap"; readonly expected: WideInt; readonly got: WideInt }
  /** A `missed` snapshot replaced everything: read the documents again. */
  | { readonly kind: "replaced" }
  /** A layout document changed on `machine` (undefined: this one): read it again. */
  | { readonly kind: "document"; readonly name: string; readonly machine?: string }
  /** A heartbeat at the current seq. */
  | { readonly kind: "alive" };

function plusOne(value: WideInt): WideInt {
  return wideInt(BigInt(value) + 1n);
}

function int32(value: WideInt | undefined): number | undefined {
  return value === undefined ? undefined : Number(BigInt.asIntN(32, BigInt(value)));
}

function sameTerminal(a: CoreTerminal, b: CoreTerminal): boolean {
  return coreJSONString(encodeCoreTerminal(a)) === coreJSONString(encodeCoreTerminal(b));
}

function labelsOf(json: CoreJSON | undefined): Record<string, string> | undefined {
  const object = jsonObject(json);
  if (object === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(object)) if (typeof value === "string") out[key] = value;
  return out;
}

function withField<K extends keyof CoreTerminal>(terminal: CoreTerminal, key: K, value: CoreTerminal[K] | undefined): CoreTerminal {
  const out: Record<string, unknown> = { ...terminal };
  if (value === undefined) delete out[key];
  else out[key] = value;
  return out as unknown as CoreTerminal;
}

/** The terminals one event stream describes. */
export class CoreModel {
  seq: WideInt;
  /** In the stream's order (this machine's, then each connected machine's). */
  terminals: CoreTerminal[];
  /** The seq of the event that last changed each terminal (its revision). */
  revisions: Map<string, WideInt>;

  constructor(seq: WideInt, terminals: readonly CoreTerminal[]) {
    this.seq = seq;
    this.terminals = [...terminals];
    this.revisions = new Map(terminals.map((terminal) => [terminal.address, seq]));
  }

  static fromSnapshot(snapshot: CoreSubscribeResult): CoreModel {
    return new CoreModel(snapshot.seq, snapshot.terminals);
  }

  terminal(address: string): CoreTerminal | undefined {
    return this.terminals.find((terminal) => terminal.address === address);
  }

  apply(notification: CoreNotification): CoreModelOutcome {
    switch (notification.kind) {
      case "missed": {
        const fresh = new CoreModel(notification.seq, notification.terminals);
        this.seq = fresh.seq;
        this.terminals = fresh.terminals;
        this.revisions = fresh.revisions;
        return { kind: "replaced" };
      }
      case "heartbeat":
        return notification.seq > this.seq ? { kind: "gap", expected: plusOne(this.seq), got: notification.seq } : { kind: "alive" };
      case "other":
        return { kind: "applied" };
      case "event": {
        const eventSeq = notification.seq;
        if (!(eventSeq > this.seq)) return { kind: "stale" };
        const expected = plusOne(this.seq);
        if (eventSeq !== expected) return { kind: "gap", expected, got: eventSeq };
        this.seq = eventSeq;
        if (notification.type === "doc") {
          const name = jsonString(member(notification.data, "name")) ?? CoreLayoutDocument.documentName;
          return notification.machine === undefined ? { kind: "document", name } : { kind: "document", name, machine: notification.machine };
        }
        const address = notification.terminal;
        if (address === undefined) return { kind: "applied" };
        const changed = this.applyEvent(notification.type, address, notification.data);
        if (changed) this.revisions.set(address, eventSeq);
        if (notification.type === "removed") this.revisions.delete(address);
        return changed ? { kind: "applied", changed: address } : { kind: "applied" };
      }
    }
  }

  /** One row of the README's table. Returns whether a terminal changed. */
  private applyEvent(type: string, address: string, data: CoreJSON): boolean {
    const index = this.terminals.findIndex((terminal) => terminal.address === address);
    switch (type) {
      case "created":
      case "restarted": {
        // created: "the whole Terminal record: add it" (a machine coming back sends changed terminals as created
        // again: replace); restarted: "replace it; reattach to the new shell".
        const record = tryDecodeCoreTerminal(data);
        if (record === undefined) return false;
        if (index >= 0) this.terminals[index] = record;
        else this.terminals.push(record);
        return true;
      }
      case "removed":
        if (index < 0) return false;
        this.terminals.splice(index, 1);
        return true;
      case "labels": {
        // "replace labels; with record, add it".
        const whole = tryDecodeCoreTerminal(member(data, "record"));
        const labels = labelsOf(member(data, "labels"));
        if (whole !== undefined) {
          if (index >= 0) this.terminals[index] = whole;
          else this.terminals.push(whole);
          if (labels !== undefined) {
            const at = this.terminals.findIndex((terminal) => terminal.address === address);
            if (at >= 0) this.terminals[at] = { ...(this.terminals[at] as CoreTerminal), labels };
          }
          return true;
        }
        if (index < 0 || labels === undefined) return false;
        this.terminals[index] = { ...(this.terminals[index] as CoreTerminal), labels };
        return true;
      }
      default:
        break;
    }
    if (index < 0) return false;
    const before = this.terminals[index] as CoreTerminal;
    let terminal: CoreTerminal = before;
    switch (type) {
      case "lost":
        // "kept terminal remains live; set these, clear pid and drop foreground".
        terminal = withField(terminal, "reason", jsonString(member(data, "reason")));
        terminal = withField(terminal, "exitCode", int32(jsonInt(member(data, "exit_code"))));
        terminal = withField(terminal, "signal", int32(jsonInt(member(data, "signal"))));
        terminal = withField(terminal, "finishedMs", jsonU64(member(data, "finished_ms")));
        terminal = withField(terminal, "pid", undefined);
        terminal = withField(terminal, "foreground", undefined);
        break;
      case "finished":
        // "set state finished and these, and drop foreground".
        terminal = { ...terminal, state: "finished" };
        terminal = withField(terminal, "reason", jsonString(member(data, "reason")));
        terminal = withField(terminal, "exitCode", int32(jsonInt(member(data, "exit_code"))));
        terminal = withField(terminal, "signal", int32(jsonInt(member(data, "signal"))));
        terminal = withField(terminal, "finishedMs", jsonU64(member(data, "finished_ms")));
        terminal = withField(terminal, "foreground", undefined);
        break;
      case "keep":
        terminal = { ...terminal, keep: jsonBool(member(data, "keep")) ?? terminal.keep };
        break;
      case "status": {
        // "replace all three": status (null when cleared), records, reported.
        const raw = member(data, "status");
        let status: CoreStatus | undefined;
        try {
          status = raw === undefined || raw === null ? undefined : decodeCoreStatus(raw);
        } catch {
          status = undefined;
        }
        terminal = withField(terminal, "status", status);
        const records: Record<string, CoreStatus> = {};
        try {
          for (const [key, record] of Object.entries(jsonObject(member(data, "records") ?? {}) ?? {})) records[key] = decodeCoreStatus(record);
        } catch {
          for (const key of Object.keys(records)) delete records[key];
        }
        terminal = { ...terminal, records, reported: jsonBool(member(data, "reported")) ?? terminal.reported };
        break;
      }
      case "turn": {
        // `{turn, state}`: "set turn" (state is the word the turn ended on).
        const turn = jsonU64(member(data, "turn"));
        if (turn === undefined) return false;
        terminal = { ...terminal, turn };
        break;
      }
      case "title":
        terminal = { ...terminal, title: jsonString(member(data, "title")) ?? "" };
        break;
      case "size": {
        const cols = jsonInt(member(data, "cols"));
        const rows = jsonInt(member(data, "rows"));
        if (cols === undefined || rows === undefined) return false;
        const clamp = (value: WideInt): number => Number(value < 0 ? 0 : value > 65535 ? 65535 : value);
        terminal = { ...terminal, cols: clamp(cols), rows: clamp(rows) };
        break;
      }
      case "foreground": {
        let foreground;
        try {
          foreground = data === null ? undefined : decodeCoreForeground(data);
        } catch {
          foreground = undefined;
        }
        terminal = withField(terminal, "foreground", foreground);
        break;
      }
      default:
        return false;
    }
    if (sameTerminal(terminal, before)) return false;
    this.terminals[index] = terminal;
    return true;
  }
}
