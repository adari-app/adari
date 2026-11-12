// herdr-core's records, as hc.openrpc.json has them (the Swift client's
// CoreWire.swift). Required fields are required here; every other field takes
// the schema's default when absent (or null), so a core that adds fields still
// decodes. u64 fields (ms values, turn, seq) are exact WideInts.

import { jsonArray, jsonBool, jsonObject, jsonSmallInt, jsonString, jsonU64, member, type CoreJSON, type CoreObject } from "./core-json";
import type { WideInt } from "../../shared/wide-int";

export class CoreDecodeError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "CoreDecodeError";
  }
}

/** One OSC 7501 record (`Status`). "Words are the program's own; nothing is translated." */
export interface CoreStatus {
  /** idle, working, done, blocked or error (or a word this build does not know). */
  readonly state: string;
  readonly app?: string;
  /** permission, question or auth (blocked only, when the program said). */
  readonly kind?: string;
  readonly msg?: string;
  readonly progress?: number;
  readonly title?: string;
}

/** What runs in a terminal now (`Foreground`). */
export interface CoreForeground {
  readonly pid: number;
  /** Its name as the OS has it (`node`, `vim`, `sh`). */
  readonly name: string;
  readonly argv: readonly string[];
  /** Its working directory now. */
  readonly cwd: string;
}

/** One terminal (`Terminal`). */
export interface CoreTerminal {
  /** `t7`, or `studio/t7` on a machine this core added. */
  readonly address: string;
  readonly argv: readonly string[];
  readonly cols: number;
  readonly rows: number;
  readonly createdMs: WideInt;
  readonly cwd: string;
  readonly exitCode?: number;
  readonly finishedMs?: WideInt;
  readonly foreground?: CoreForeground;
  readonly keep: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly parent?: string;
  readonly pid?: number;
  readonly reason?: string;
  readonly records: Readonly<Record<string, CoreStatus>>;
  readonly reported: boolean;
  readonly screen: string;
  readonly signal?: number;
  /** "live" or "finished". */
  readonly state: string;
  readonly status?: CoreStatus;
  readonly statusMs?: WideInt;
  readonly title: string;
  /** Goes up each time the status leaves `working`. */
  readonly turn: WideInt;
  readonly template?: string;
}

const int32 = [-2147483648, 2147483647] as const;

function present(object: CoreObject, key: string): boolean {
  return Object.hasOwn(object, key) && object[key] !== null;
}

function need<T>(value: T | undefined, path: string, what: string): T {
  if (value === undefined) throw new CoreDecodeError(path, `expected ${what}`);
  return value;
}

function objectAt(value: CoreJSON | undefined, path: string): CoreObject {
  return need(jsonObject(value), path, "object");
}

function stringAt(object: CoreObject, key: string, path: string): string {
  return need(jsonString(object[key]), `${path}.${key}`, "string");
}

function optionalString(object: CoreObject, key: string, path: string): string | undefined {
  return present(object, key) ? stringAt(object, key, path) : undefined;
}

function strings(value: CoreJSON | undefined, path: string): string[] {
  const array = need(jsonArray(value), path, "array");
  return array.map((item, index) => need(jsonString(item), `${path}[${index}]`, "string"));
}

function smallInt(object: CoreObject, key: string, path: string, min: number, max: number): number {
  return need(jsonSmallInt(object[key], min, max), `${path}.${key}`, `integer in ${min}...${max}`);
}

function optionalSmallInt(object: CoreObject, key: string, path: string, min: number, max: number): number | undefined {
  return present(object, key) ? smallInt(object, key, path, min, max) : undefined;
}

function u64At(object: CoreObject, key: string, path: string): WideInt {
  return need(jsonU64(object[key]), `${path}.${key}`, "unsigned integer");
}

function optionalU64(object: CoreObject, key: string, path: string): WideInt | undefined {
  return present(object, key) ? u64At(object, key, path) : undefined;
}

function optionalBool(object: CoreObject, key: string, path: string): boolean | undefined {
  return present(object, key) ? need(jsonBool(object[key]), `${path}.${key}`, "boolean") : undefined;
}

function withOptional<T extends object>(base: T, extra: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) out[key] = value;
  return out as T;
}

export function decodeCoreStatus(value: CoreJSON | undefined, path = "$"): CoreStatus {
  const object = objectAt(value, path);
  return withOptional<CoreStatus>(
    { state: stringAt(object, "state", path) },
    {
      app: optionalString(object, "app", path),
      kind: optionalString(object, "kind", path),
      msg: optionalString(object, "msg", path),
      progress: optionalSmallInt(object, "progress", path, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      title: optionalString(object, "title", path),
    },
  );
}

export function decodeCoreForeground(value: CoreJSON | undefined, path = "$"): CoreForeground {
  const object = objectAt(value, path);
  return {
    pid: smallInt(object, "pid", path, int32[0], int32[1]),
    name: stringAt(object, "name", path),
    argv: strings(object["argv"], `${path}.argv`),
    cwd: stringAt(object, "cwd", path),
  };
}

export function decodeCoreTerminal(value: CoreJSON | undefined, path = "$"): CoreTerminal {
  const object = objectAt(value, path);
  const labelsObject = objectAt(object["labels"], `${path}.labels`);
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(labelsObject)) labels[key] = need(jsonString(label), `${path}.labels.${key}`, "string");
  const records: Record<string, CoreStatus> = {};
  if (present(object, "records")) {
    for (const [key, record] of Object.entries(objectAt(object["records"], `${path}.records`))) {
      records[key] = decodeCoreStatus(record, `${path}.records.${key}`);
    }
  }
  return withOptional<CoreTerminal>(
    {
      address: stringAt(object, "address", path),
      argv: strings(object["argv"], `${path}.argv`),
      cols: smallInt(object, "cols", path, 0, 65535),
      rows: smallInt(object, "rows", path, 0, 65535),
      createdMs: u64At(object, "created_ms", path),
      cwd: stringAt(object, "cwd", path),
      labels,
      screen: stringAt(object, "screen", path),
      state: stringAt(object, "state", path),
      keep: optionalBool(object, "keep", path) ?? false,
      records,
      reported: optionalBool(object, "reported", path) ?? false,
      title: optionalString(object, "title", path) ?? "",
      turn: optionalU64(object, "turn", path) ?? 0,
    },
    {
      exitCode: optionalSmallInt(object, "exit_code", path, int32[0], int32[1]),
      finishedMs: optionalU64(object, "finished_ms", path),
      foreground: present(object, "foreground") ? decodeCoreForeground(object["foreground"], `${path}.foreground`) : undefined,
      name: optionalString(object, "name", path),
      parent: optionalString(object, "parent", path),
      pid: optionalSmallInt(object, "pid", path, 0, 4294967295),
      reason: optionalString(object, "reason", path),
      signal: optionalSmallInt(object, "signal", path, int32[0], int32[1]),
      status: present(object, "status") ? decodeCoreStatus(object["status"], `${path}.status`) : undefined,
      statusMs: optionalU64(object, "status_ms", path),
      template: optionalString(object, "template", path),
    },
  );
}

/** A terminal, or undefined when the value is not one. */
export function tryDecodeCoreTerminal(value: CoreJSON | undefined): CoreTerminal | undefined {
  try {
    return decodeCoreTerminal(value);
  } catch {
    return undefined;
  }
}

/** The terminal's JSON, as the core sends it (the model applies event fields over it). */
export function encodeCoreTerminal(terminal: CoreTerminal): CoreObject {
  const out: Record<string, CoreJSON> = {
    address: terminal.address,
    argv: [...terminal.argv],
    cols: terminal.cols,
    rows: terminal.rows,
    created_ms: terminal.createdMs,
    cwd: terminal.cwd,
    keep: terminal.keep,
    labels: { ...terminal.labels },
    records: Object.fromEntries(Object.entries(terminal.records).map(([key, status]) => [key, encodeCoreStatus(status)])),
    reported: terminal.reported,
    screen: terminal.screen,
    state: terminal.state,
    title: terminal.title,
    turn: terminal.turn,
  };
  if (terminal.exitCode !== undefined) out["exit_code"] = terminal.exitCode;
  if (terminal.finishedMs !== undefined) out["finished_ms"] = terminal.finishedMs;
  if (terminal.foreground !== undefined) out["foreground"] = encodeCoreForeground(terminal.foreground);
  if (terminal.name !== undefined) out["name"] = terminal.name;
  if (terminal.parent !== undefined) out["parent"] = terminal.parent;
  if (terminal.pid !== undefined) out["pid"] = terminal.pid;
  if (terminal.reason !== undefined) out["reason"] = terminal.reason;
  if (terminal.signal !== undefined) out["signal"] = terminal.signal;
  if (terminal.status !== undefined) out["status"] = encodeCoreStatus(terminal.status);
  if (terminal.statusMs !== undefined) out["status_ms"] = terminal.statusMs;
  if (terminal.template !== undefined) out["template"] = terminal.template;
  return out;
}

export function encodeCoreStatus(status: CoreStatus): CoreObject {
  const out: Record<string, CoreJSON> = { state: status.state };
  if (status.app !== undefined) out["app"] = status.app;
  if (status.kind !== undefined) out["kind"] = status.kind;
  if (status.msg !== undefined) out["msg"] = status.msg;
  if (status.progress !== undefined) out["progress"] = status.progress;
  if (status.title !== undefined) out["title"] = status.title;
  return out;
}

export function encodeCoreForeground(foreground: CoreForeground): CoreObject {
  return { pid: foreground.pid, name: foreground.name, argv: [...foreground.argv], cwd: foreground.cwd };
}

export function isLive(terminal: CoreTerminal): boolean {
  return terminal.state === "live";
}

/** `studio` in `studio/t7`; undefined for this machine's terminals. */
export function coreMachineOf(address: string): string | undefined {
  const slash = address.indexOf("/");
  if (slash < 0) return undefined;
  const name = address.slice(0, slash);
  return name === "" ? undefined : name;
}

/** `events.subscribe`'s reply (`SubscribeResult`). */
export interface CoreSubscribeResult {
  /** Framed mode: the channel events arrive on (JSON lines, with credit). */
  readonly channel?: number;
  readonly seq: WideInt;
  readonly terminals: readonly CoreTerminal[];
}

export function decodeCoreSubscribeResult(value: CoreJSON | undefined, path = "$"): CoreSubscribeResult {
  const object = objectAt(value, path);
  const terminals = need(jsonArray(object["terminals"]), `${path}.terminals`, "array").map((item, index) =>
    decodeCoreTerminal(item, `${path}.terminals[${index}]`),
  );
  return withOptional<CoreSubscribeResult>(
    { seq: u64At(object, "seq", path), terminals },
    { channel: optionalSmallInt(object, "channel", path, 0, 4294967295) },
  );
}

/** `terminal.attach`'s reply (`AttachResult`). */
export interface CoreAttachResult {
  readonly channel: number;
  readonly terminal: CoreTerminal;
  readonly resizeNotifications?: boolean;
}

export function decodeCoreAttachResult(value: CoreJSON | undefined, path = "$"): CoreAttachResult {
  const object = objectAt(value, path);
  return withOptional<CoreAttachResult>(
    { channel: smallInt(object, "channel", path, 0, 4294967295), terminal: decodeCoreTerminal(object["terminal"], `${path}.terminal`) },
    { resizeNotifications: optionalBool(object, "resize_notifications", path) },
  );
}

/** A machine and its line (`MachineView`). */
export interface CoreMachineView {
  readonly name: string;
  readonly host: string;
  /** connecting, connected, needs_login or unreachable. */
  readonly state: string;
  readonly temporary?: boolean;
}

export function decodeCoreMachineView(value: CoreJSON | undefined, path = "$"): CoreMachineView {
  const object = objectAt(value, path);
  return withOptional<CoreMachineView>(
    { name: stringAt(object, "name", path), host: stringAt(object, "host", path), state: stringAt(object, "state", path) },
    { temporary: optionalBool(object, "temporary", path) },
  );
}

/** One notification on the event stream (herdr-core schema/README.md "Events"). */
export type CoreNotification =
  /** `{"method":"event","params":{"seq","type","terminal","data"}}` (doc events carry `machine` and no terminal). */
  | {
      readonly kind: "event";
      readonly seq: WideInt;
      readonly type: string;
      readonly terminal?: string;
      readonly machine?: string;
      readonly data: CoreJSON;
    }
  /** `{"method":"heartbeat","params":{"seq"}}`, every 15 s. */
  | { readonly kind: "heartbeat"; readonly seq: WideInt }
  /** `{"method":"missed","params":{"seq","terminals"}}`: a fresh snapshot. */
  | { readonly kind: "missed"; readonly seq: WideInt; readonly terminals: readonly CoreTerminal[] }
  | { readonly kind: "other"; readonly method: string };

export function parseCoreNotification(json: CoreJSON): CoreNotification | null {
  const method = jsonString(member(json, "method"));
  if (method === undefined) return null;
  const params = member(json, "params") ?? {};
  switch (method) {
    case "event": {
      const seq = jsonU64(member(params, "seq"));
      const type = jsonString(member(params, "type"));
      if (seq === undefined || type === undefined) return null;
      const terminal = jsonString(member(params, "terminal"));
      const machine = jsonString(member(params, "machine"));
      return {
        kind: "event",
        seq,
        type,
        ...(terminal === undefined ? {} : { terminal }),
        ...(machine === undefined ? {} : { machine }),
        data: member(params, "data") ?? null,
      };
    }
    case "heartbeat": {
      const seq = jsonU64(member(params, "seq"));
      return seq === undefined ? null : { kind: "heartbeat", seq };
    }
    case "missed": {
      const seq = jsonU64(member(params, "seq"));
      if (seq === undefined) return null;
      const terminals = (jsonArray(member(params, "terminals")) ?? []).flatMap((item) => {
        const terminal = tryDecodeCoreTerminal(item);
        return terminal === undefined ? [] : [terminal];
      });
      return { kind: "missed", seq, terminals };
    }
    default:
      return { kind: "other", method };
  }
}
