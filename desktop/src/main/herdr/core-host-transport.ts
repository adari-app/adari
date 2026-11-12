// Both kinds of Herdr on one host, in one sidebar (the Swift client's
// CoreHostTransport.swift). A host can run Herdr's TUI server, herdr-core
// (Herdr App's engine), or both. This transport is the host's one
// HerdrTransport for HerdrClient: it asks both (the TUI socket answers; `hc`
// is there and `hello` answers) and keeps both when both exist. Reads are
// merged (the TUI's workspaces first, as today, then the core's spaces);
// requests go where their ids say (every core id starts with `hc:`), everything
// else to the TUI server as today. A host with only herdr-core is shown fully
// from the core; a host with only the TUI server reads exactly as before.

import { coreJSONString, jsonArray, jsonInt, jsonObject, jsonString, member, tryParseCoreJSON, type CoreJSON } from "./core-json";
import { CoreBridgeTransport, CoreTUIWire, parseBridgeRequest, type BridgeRequest } from "./core-bridge";
import { isCoreRefusal, type CoreFollower } from "./core-follower";
import { CoreIDs } from "./core-model";
import type { CoreProjection } from "./core-projection";
import { ClosedBeforeResponseError, HerdrNotInstalledError, RemoteSocketFailedError } from "./errors";
import type { HerdrTransport, RoundTripOptions } from "./transport";

/** Where a host's Herdr comes from, as found on connect. */
export type HerdrSourcePresence = { readonly kind: "unknown" } | { readonly kind: "present" } | { readonly kind: "absent"; readonly why: string };

export interface HerdrHostSources {
  readonly tui: HerdrSourcePresence;
  readonly core: HerdrSourcePresence;
}

export interface CoreHostOptions {
  /** After the TUI server answered on connect, how long a core still being found may hold the first snapshot (later, it arrives as a change). */
  readonly coreGraceSeconds?: number;
  /** How often a host whose TUI server was not there asks again. */
  readonly tuiRecheckSeconds?: number;
  /** How often a refresh may look for a herdr-core that was not there. */
  readonly coreRecheckSeconds?: number;
  /** The clock (ms; tests). */
  readonly now?: () => number;
}

export type CoreLook =
  /** `live` false: the line is down and every terminal shows unreachable. */
  | { readonly kind: "shown"; readonly projection: CoreProjection; readonly live: boolean }
  | { readonly kind: "absent"; readonly why: string }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "pending" };

const present: HerdrSourcePresence = { kind: "present" };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

/** The promise's value if it comes within `seconds`, else null (it runs on). */
function within<T>(promise: Promise<T>, seconds: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, seconds) * 1000);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** The fields that name what a request acts on (a pane, agent target, tab or workspace). Text, names, labels and the rest are the person's content and never pick the backend. */
export const identityFields: readonly string[] = ["pane_id", "target", "target_pane_id", "terminal_id", "tab_id", "workspace_id", "source_workspace_id"];

/** Whether the request's target is a herdr-core id (`hc:`). */
export function refersToCore(params: CoreJSON): boolean {
  return identityFields.some((field) => {
    const value = jsonString(member(params, field));
    return value !== undefined && CoreIDs.isCore(value);
  });
}

/** Whether a TUI error means "no TUI server here" (no socket, no herdr), not a host that failed. */
export function meansNoTUI(error: unknown): boolean {
  return error instanceof HerdrNotInstalledError || error instanceof RemoteSocketFailedError;
}

/** The core's view: live, the last one marked unreachable, or why there is none. `mayWait`: with no view yet, wait for the first snapshot (bounded by the follower); else pending. */
export async function lookAtCore(follower: CoreFollower, mayWait: boolean): Promise<CoreLook> {
  const availability = follower.availability();
  switch (availability.kind) {
    case "live":
      return { kind: "shown", projection: availability.projection, live: true };
    case "refused":
      return { kind: "absent", why: availability.reason };
    case "closed":
      return { kind: "absent", why: "closed" };
    case "waiting":
      if (availability.last !== null) return { kind: "shown", projection: availability.last, live: false };
      if (!mayWait) return { kind: "pending" };
      try {
        return { kind: "shown", projection: await follower.snapshot(), live: true };
      } catch (error) {
        if (isCoreRefusal(error)) return { kind: "absent", why: error.message };
        return { kind: "failed", error };
      }
  }
}

/** The reply line with the core's workspaces, tabs, panes and agents after the TUI server's (or the core's alone). The TUI server's JSON is kept; the core's workspaces are numbered after its. */
export function combine(request: BridgeRequest, tuiLine: string | null, core: CoreProjection): string {
  const coreWire = CoreTUIWire.topology(core.topology);
  const coreList = (key: string): readonly CoreJSON[] => jsonArray(member(coreWire, key)) ?? [];
  const envelope = tuiLine === null ? undefined : jsonObject(tryParseCoreJSON(tuiLine));
  const result = jsonObject(member(envelope, "result"));
  if (envelope === undefined || result === undefined) {
    // The TUI server is not there (or answered an error: kept as is).
    if (tuiLine !== null) return tuiLine;
    const answer = request.method === "agent.list" ? { agents: coreList("agents") } : { snapshot: coreWire };
    return coreJSONString({ id: request.id, result: answer });
  }
  const merged: Record<string, CoreJSON> = { ...result };
  if (request.method === "agent.list") {
    merged["agents"] = [...(jsonArray(result["agents"]) ?? []), ...coreList("agents")];
  } else {
    const snapshot = jsonObject(result["snapshot"]);
    if (snapshot !== undefined) {
      const tuiWorkspaces = jsonArray(snapshot["workspaces"]) ?? [];
      const numbers = tuiWorkspaces.flatMap((workspace) => {
        const number = jsonInt(member(workspace, "number"));
        return number === undefined ? [] : [Number(number)];
      });
      const offset = numbers.length > 0 ? Math.max(...numbers) : tuiWorkspaces.length;
      const coreWorkspaces = coreList("workspaces").map((workspace) => {
        const object = jsonObject(workspace);
        if (object === undefined) return workspace;
        return { ...object, number: Number(jsonInt(object["number"]) ?? 0) + offset };
      });
      const next: Record<string, CoreJSON> = { ...snapshot, workspaces: [...tuiWorkspaces, ...coreWorkspaces] };
      for (const key of ["tabs", "panes", "agents"]) next[key] = [...(jsonArray(snapshot[key]) ?? []), ...coreList(key)];
      merged["snapshot"] = next;
    }
  }
  return coreJSONString({ ...envelope, result: merged });
}

class HostState {
  tui: HerdrSourcePresence = { kind: "unknown" };
  core: HerdrSourcePresence = { kind: "unknown" };
  tuiError: unknown = null;
  private tuiCheckedAt: number | null = null;
  private looked = false;
  private coreLookedAt: number | null = null;

  /** True once: the first snapshot on connect. */
  takeFirstLook(): boolean {
    const first = !this.looked;
    this.looked = true;
    return first;
  }

  setTUI(presence: HerdrSourcePresence, at: number | null = null): void {
    this.tui = presence;
    if (presence.kind === "present") this.tuiError = null;
    this.tuiCheckedAt = at;
  }

  /** A herdr-core that was not there is looked for again on a refresh at most once per `recheck` seconds (the first refusal starts the clock). */
  shouldLookForCore(now: number, recheckSeconds: number): boolean {
    if (this.coreLookedAt === null) {
      this.coreLookedAt = now;
      return false;
    }
    if (now - this.coreLookedAt < recheckSeconds * 1000) return false;
    this.coreLookedAt = now;
    return true;
  }

  /** The TUI server is asked every time while it is there (or unknown); when it was not there, again after `recheck` seconds. */
  shouldAskTUI(now: number, recheckSeconds: number): boolean {
    if (this.tui.kind !== "absent" || this.tuiCheckedAt === null) return true;
    return now - this.tuiCheckedAt >= recheckSeconds * 1000;
  }
}

export class CoreHostTransport implements HerdrTransport {
  private readonly state = new HostState();
  private readonly coreGrace: number;
  private readonly tuiRecheck: number;
  private readonly coreRecheck: number;
  private readonly now: () => number;
  private epochKey: string | null = null;
  private epochCount = 0;

  constructor(
    readonly tui: HerdrTransport,
    readonly core: CoreBridgeTransport,
    options: CoreHostOptions = {},
  ) {
    this.coreGrace = options.coreGraceSeconds ?? 3;
    this.tuiRecheck = options.tuiRecheckSeconds ?? 30;
    this.coreRecheck = options.coreRecheckSeconds ?? 60;
    this.now = options.now ?? (() => Date.now());
  }

  get follower(): CoreFollower {
    return this.core.follower;
  }

  /** What was found on this host so far. */
  sources(): HerdrHostSources {
    return { tui: this.state.tui, core: this.state.core };
  }

  /** A host with herdr-core and no TUI server: everything goes to the core. */
  routesToCoreOnly(): boolean {
    return this.state.tui.kind === "absent" && this.state.core.kind === "present";
  }

  /** The TUI's connection close (the follower is closed by its backend). */
  close(): void {
    this.tui.close();
  }

  /**
   * A number for the pair of connections requests go on now (the TUI's command connection and the core's):
   * a new number whenever either changes; null while neither is held.
   */
  connectionEpoch(): number | null {
    const tui = this.tui.connectionEpoch?.() ?? null;
    const core = this.core.connectionEpoch();
    if (tui === null && core === null) return null;
    const key = `${tui}:${core}`;
    if (key !== this.epochKey) {
      this.epochKey = key;
      this.epochCount += 1;
    }
    return this.epochCount;
  }

  async roundTrip(requestLine: string, options?: RoundTripOptions): Promise<string> {
    let request: BridgeRequest;
    try {
      request = parseBridgeRequest(requestLine);
    } catch {
      return this.askTUI(requestLine, options);
    }
    switch (request.method) {
      case "session.snapshot":
      case "agent.list":
        return this.merged(request, requestLine, options);
      default:
        if (refersToCore(request.params)) return this.core.roundTrip(requestLine);
        if (this.routesToCoreOnly()) return this.core.roundTrip(requestLine);
        return this.askTUI(requestLine, options);
    }
  }

  private askTUI(line: string, options: RoundTripOptions | undefined): Promise<string> {
    return options === undefined ? this.tui.roundTrip(line) : this.tui.roundTrip(line, options);
  }

  /** `session.snapshot` or `agent.list`: the TUI server's answer, then the core's. */
  private async merged(request: BridgeRequest, line: string, options: RoundTripOptions | undefined): Promise<string> {
    const now = this.now();
    const tuiCheck = this.state.shouldAskTUI(now, this.tuiRecheck);
    const tuiTask = tuiCheck ? settle(this.askTUI(line, options)) : null;
    const follower = this.follower;
    // The first look on connect may wait for the core's first snapshot; later ones read what is there (a change
    // refreshes again).
    const firstLook = this.state.takeFirstLook();
    const tuiThere = this.state.tui.kind === "present";
    const coreTask = lookAtCore(follower, firstLook || (!tuiThere && !tuiCheck));

    let tuiLine: string | null = null;
    if (tuiTask !== null) {
      const answer = await tuiTask;
      if (answer.ok) {
        this.state.setTUI(present);
        tuiLine = answer.value;
      } else {
        // The host itself failed (SSH, auth, a changed key): as today.
        if (!meansNoTUI(answer.error)) throw answer.error;
        this.state.setTUI({ kind: "absent", why: describe(answer.error) }, this.now());
        this.state.tuiError = answer.error;
      }
      // The TUI side got through over SSH, so a core refused for the host key or the sign-in (the
      // machine's own question settles those on the Mac) is looked for again now.
      if (follower.session.recoverableRefusal === "credentials") follower.rediscover();
    }
    // With the TUI server there, a core still being found waits only a little.
    let look: CoreLook;
    if (tuiLine !== null && firstLook) {
      look = (await within(coreTask, this.coreGrace)) ?? { kind: "pending" };
    } else if (tuiLine === null && !firstLook && (await coreTask).kind === "pending") {
      // No TUI server and no core view yet: wait for the core's snapshot.
      look = await lookAtCore(follower, true);
    } else {
      look = await coreTask;
    }
    switch (look.kind) {
      case "shown":
        this.state.core = present;
        return combine(request, tuiLine, look.projection);
      case "absent":
        this.state.core = { kind: "absent", why: look.why };
        // herdr-core may have been installed since: look again, at most once per `coreRecheck`; what it finds
        // comes as a change.
        if (this.state.shouldLookForCore(this.now(), this.coreRecheck)) follower.rediscover();
        break;
      default:
        break;
    }
    if (tuiLine !== null) return tuiLine;
    // Neither answered: the TUI server's error, as today (or the core's when that is all this host has).
    if (look.kind === "failed" && this.state.core.kind === "present") throw look.error;
    if (this.state.tuiError !== null) throw this.state.tuiError;
    if (look.kind === "failed") throw look.error;
    throw new ClosedBeforeResponseError();
  }
}
