// The host-level fixtures the action, boundary and send tests share:
// a CoreHostTransport over the TUI fixture and the fake core, with the
// bridge's actions on (core-actions.ts), as HerdrMachineBackend builds it.

import { CoreBridgeTransport } from "../../src/main/herdr/core-bridge";
import { coreActions } from "../../src/main/herdr/core-actions";
import type { CoreLink } from "../../src/main/herdr/core-connection";
import { CoreFollower, type CoreFollowerOptions } from "../../src/main/herdr/core-follower";
import { CoreHostTransport, type CoreHostOptions } from "../../src/main/herdr/core-host-transport";
import { CoreBackoff, CoreSession } from "../../src/main/herdr/core-session";
import { CoreLinkError } from "../../src/main/herdr/core-ssh";
import { RemoteSocketFailedError } from "../../src/main/herdr/errors";
import { socketMissingDetail } from "../../src/main/herdr/transport";
import { FakeCore } from "./fake-core";
import type { TUIFixtureTransport } from "./tui-fixture";

export const fastFollower: CoreFollowerOptions = { heartbeatSilenceSeconds: 0.4, watchdogIntervalSeconds: 0.05, machinePollSeconds: 60, snapshotWaitSeconds: 2 };

export const noSocket = (): RemoteSocketFailedError => new RemoteSocketFailedError(".config/herdr/herdr.sock", socketMissingDetail);

/** A follower on the fake core (CoreModelTests.backend). */
export function coreFollower(core: FakeCore | null, options: CoreFollowerOptions = fastFollower, makeLink?: () => CoreLink | Promise<CoreLink>): CoreFollower {
  const session = new CoreSession({
    backoff: new CoreBackoff(0.01, 0.02),
    helloTimeoutSeconds: 2,
    makeLink:
      makeLink ??
      (() => {
        if (core === null) throw new CoreLinkError({ kind: "notInstalled" });
        return core.makeLink();
      }),
  });
  return new CoreFollower(session, options);
}

/** The bridge with its actions (CoreBridgeTransport(backend:)). */
export function actingBridge(follower: CoreFollower): CoreBridgeTransport {
  return new CoreBridgeTransport(follower, coreActions(follower));
}

/** CoreHostTests.host: the TUI fixture and the core on one host. */
export function coreHost(tui: TUIFixtureTransport, core: FakeCore | null, options: CoreHostOptions = { coreGraceSeconds: 2 }, follower?: CoreFollower): CoreHostTransport {
  return new CoreHostTransport(tui, actingBridge(follower ?? coreFollower(core)), options);
}

/** The core with an agent as its terminal's own program (the iPhone app's core tests' ownAgent). */
export function ownAgent(status: ReturnType<typeof FakeCore.status> | undefined, keep = false): FakeCore {
  return new FakeCore([
    FakeCore.terminal("t1", {
      argv: ["claude"],
      ...(status === undefined ? {} : { status }),
      foreground: FakeCore.foreground("claude", ["claude"], "/tmp", 5151),
      keep,
      pid: 5151,
    }),
  ]);
}

/** An agent started from its terminal's shell (the iPhone app's core tests' shellAgent): the terminal's own program (4242) is the shell. */
export function shellAgent(status: ReturnType<typeof FakeCore.status> | undefined): FakeCore {
  return new FakeCore([
    FakeCore.terminal("t1", {
      argv: ["/bin/zsh", "-l"],
      ...(status === undefined ? {} : { status }),
      foreground: FakeCore.foreground("claude", ["claude"], "/tmp", 5151),
      pid: 4242,
    }),
  ]);
}
