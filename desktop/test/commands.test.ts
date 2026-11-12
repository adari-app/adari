// The remote commands must be CitadelTransport's, byte for byte. The Swift
// literals are read out of Sources/HerdrKit/CitadelTransport.swift at test time
// and assembled in the Swift concatenation order; the TS builders must produce
// the same strings. The Swift tests' own vectors (OfficialCompanionTests,
// OfficialAttachEndingTests) are repeated here too. The public copy holds the
// Mac app only: the comparisons with the Swift file run when that file is in
// the tree and are skipped when it is not; the vectors always run.

import { describe, expect, it } from "vitest";

import {
  attachCommand,
  encodedRequest,
  heldSocketCommand,
  herdrPathResolution,
  maxCommandBytes,
  officialRequestCommand,
  officialSessionName,
  resolvedSocketSetup,
  sessionSocketPath,
  shellQuote,
  socketCommand,
  socketMissingSentinel,
  socketPayload,
} from "../src/main/herdr/commands";
import { HerdrClient } from "../src/main/herdr/client";
import { RequestTooLargeError } from "../src/main/herdr/errors";
import { extractRawString, hasRepoFile, rawStringsBetween, readRepoFile } from "./support/swift-fixtures";

const citadelSource = "Sources/HerdrKit/CitadelTransport.swift";
const hasSwift = hasRepoFile(citadelSource);
const withSwift = it.skipIf(!hasSwift);
const swift = hasSwift ? readRepoFile(citadelSource) : "";

/** `rawStringsBetween`, or nothing when the Swift file is not in the tree. */
function between(from: string, to: string): (string | undefined)[] {
  return hasSwift ? rawStringsBetween(swift, from, to) : [];
}

// The Swift literals, in source order.
const swiftPathResolution = hasSwift ? extractRawString(swift, "static let herdrPathResolution =") : undefined;
const [setupDefault, setupNamedHead, setupNamedTail, setupRoot, setupGuard] = between(
  "static func resolvedSocketSetup(session: String) -> String {",
  "static func heldSocketCommand(",
);
const [heldExec] = between("static func heldSocketCommand(", "static var notificationHelperCommand");
const [requestPrintf, requestPipe] = between("static func officialRequestCommand(", "static func bridgeCommand(");
const [socketHome, socketGuardPrintf, socketPipe] = between(
  "static func socketCommand(for requestLine: String, remoteSocketPath: String)",
  "static func resolvedSocketSetup(",
);
const [attachExec] = between(
  "target: OfficialTerminalAttachmentTarget, session: String, takeover: Bool = false",
  "static func attachCommand(target: String, session: String)",
);

function swiftSetup(session: string): string {
  const location = session === "default" ? setupDefault! : setupNamedHead! + shellQuote(session) + setupNamedTail!;
  return setupRoot! + location + setupGuard!;
}

describe("CitadelTransport's literals", () => {
  withSwift("are all found in the Swift source", () => {
    for (const value of [
      swiftPathResolution,
      setupDefault,
      setupNamedHead,
      setupNamedTail,
      setupRoot,
      setupGuard,
      heldExec,
      requestPrintf,
      requestPipe,
      socketHome,
      socketGuardPrintf,
      socketPipe,
      attachExec,
    ]) {
      expect(value).toBeTypeOf("string");
      expect(value!.length).toBeGreaterThan(0);
    }
    expect(setupRoot).toBe('unset HERDR_SOCKET_PATH; CONFIG_ROOT=${XDG_CONFIG_HOME:-"$HOME/.config"}; ');
  });

  withSwift("herdrPathResolution is the Swift string", () => {
    expect(herdrPathResolution).toBe(swiftPathResolution);
  });
});

describe("the request command", () => {
  const sessions = ["default", "work-2", "mobile_test.1"];
  const lines = [
    '{"id":"herdrkit:session.snapshot:1","method":"session.snapshot","params":{}}',
    '{"id":"herdrkit:pane.send_input:2","method":"pane.send_input","params":{"pane_id":"w1:p1","text":"héllo \' $(id) `x`\\nnext","keys":["Enter"]}}',
  ];

  withSwift("resolvedSocketSetup matches CitadelTransport for the default and named sessions", () => {
    for (const session of sessions) expect(resolvedSocketSetup(session)).toBe(swiftSetup(session));
  });

  withSwift("officialRequestCommand matches CitadelTransport byte for byte", () => {
    for (const session of sessions) {
      for (const line of lines) {
        const expected =
          swiftSetup(session) + requestPrintf! + shellQuote(encodedRequest(socketPayload(line))) + requestPipe!;
        expect(officialRequestCommand(line, session)).toBe(expected);
      }
    }
  });

  it("carries the request as base64 of the line plus its newline, never raw JSON", () => {
    const line = '{"id":"1","method":"agent.list","params":{"text":"\' $(touch /tmp/nope); `id`"}}';
    const command = officialRequestCommand(line, "default");
    expect(command).not.toContain("touch /tmp/nope");
    const quoted = /printf '%s' '([A-Za-z0-9+/=]+)' \| \/usr\/bin\/base64 -D \| \/usr\/bin\/nc -U "\$SOCKET"$/.exec(command);
    expect(quoted).not.toBeNull();
    expect(Buffer.from(quoted![1]!, "base64").toString("utf8")).toBe(line + "\n");
  });

  it("the client's real request line goes through unchanged", () => {
    const client = new HerdrClient({ roundTrip: () => Promise.reject(new Error("unused")), close: () => undefined });
    const line = client.encodeRequest("pane.send_input", { pane_id: "w1:p2", text: "ship it", keys: ["Enter"] });
    expect(line).toBe(
      '{"id":"herdrkit:pane.send_input:1","method":"pane.send_input","params":{"pane_id":"w1:p2","text":"ship it","keys":["Enter"]}}',
    );
    expect(officialRequestCommand(line, "default")).toContain(shellQuote(encodedRequest(line + "\n")));
  });

  const socketRequest = '{"id":"1","method":"agent.list","params":{"text":"\' $(touch /tmp/nope); `id`"}}';
  const socketPath = ".config/herdr/sessions/work/herdr.sock";

  withSwift("socketCommand matches CitadelTransport", () => {
    expect(socketCommand(socketRequest, socketPath)).toBe(
      socketHome! + shellQuote(socketPath) + socketGuardPrintf! + shellQuote(encodedRequest(socketPayload(socketRequest))) + socketPipe!,
    );
  });

  it("socketCommand keeps the Swift test's vectors", () => {
    const command = socketCommand(socketRequest, socketPath);
    expect(command).toContain("/usr/bin/nc -U");
    expect(command).toContain("/usr/bin/base64 -D");
    expect(command).not.toContain("api-bridge");
    expect(command).not.toContain("touch /tmp/nope");
    expect(socketCommand("{}", "")).toContain(shellQuote(".config/herdr/herdr.sock"));
  });

  it("refuses a command over the byte budget", () => {
    expect(() => socketCommand("x".repeat(maxCommandBytes), ".config/herdr/herdr.sock")).toThrow(RequestTooLargeError);
    expect(() => officialRequestCommand("x".repeat(maxCommandBytes), "default")).toThrow(RequestTooLargeError);
  });

  it("frames the payload with exactly one newline", () => {
    expect(socketPayload("{}")).toBe("{}\n");
    expect(socketPayload("{}\n")).toBe("{}\n");
  });
});

describe("quoting and sessions", () => {
  it("single-quotes like the Swift shellQuote", () => {
    expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
    expect(shellQuote("")).toBe("''");
  });

  withSwift("the held subscription command matches CitadelTransport", () => {
    expect(heldSocketCommand("work'; unsafe")).toBe(swiftSetup("work'; unsafe") + heldExec!);
  });

  it("the held subscription command quotes the session and ends in nc", () => {
    const command = heldSocketCommand("work'; unsafe");
    expect(command.endsWith('exec /usr/bin/nc -U "$SOCKET"')).toBe(true);
    expect(command).toContain(shellQuote("work'; unsafe"));
    expect(command).toContain("XDG_CONFIG_HOME");
    expect(command).toContain(socketMissingSentinel);
  });

  it("validates session names like OfficialHerdrSession", () => {
    expect(officialSessionName(" work-2 ")).toBe("work-2");
    expect(officialSessionName("default")).toBe("default");
    for (const bad of ["", "   ", ".", "..", "../other", "has space", "x".repeat(65), "naïve"]) {
      expect(officialSessionName(bad)).toBeNull();
    }
    expect(officialSessionName("x".repeat(64))).toBe("x".repeat(64));
    expect(sessionSocketPath("default")).toBe(".config/herdr/herdr.sock");
    expect(sessionSocketPath("work")).toBe(".config/herdr/sessions/work/herdr.sock");
  });
});

describe("the attach command", () => {
  withSwift("matches CitadelTransport for agent and terminal targets", () => {
    const agent = attachCommand({ kind: "agent", paneID: "pane'; echo unsafe" }, "default");
    expect(agent).toBe(swiftPathResolution + attachExec! + shellQuote("default") + " agent attach " + shellQuote("pane'; echo unsafe"));
    const terminal = attachCommand({ kind: "terminal", terminalID: "term'; echo unsafe" }, "mobile-test");
    expect(terminal).toBe(
      swiftPathResolution + attachExec! + shellQuote("mobile-test") + " terminal attach " + shellQuote("term'; echo unsafe"),
    );
  });

  it("quotes the target and never takes over unless asked (OfficialCompanionTests, OfficialAttachEndingTests)", () => {
    const target = "pane'; echo unsafe";
    const command = attachCommand({ kind: "agent", paneID: target }, "default");
    expect(command).toContain("/opt/homebrew/bin/herdr");
    expect(command.startsWith("unset HERDR_SOCKET_PATH;")).toBe(true);
    expect(command.endsWith("--session 'default' agent attach " + shellQuote(target))).toBe(true);
    expect(command).not.toContain("--takeover");

    expect(attachCommand({ kind: "agent", paneID: "w7:p1" }, "default", true).endsWith(
      "--session 'default' agent attach 'w7:p1' --takeover",
    )).toBe(true);
    expect(attachCommand({ kind: "terminal", terminalID: "term'; echo x" }, "mobile", true).endsWith(
      "--session 'mobile' terminal attach " + shellQuote("term'; echo x") + " --takeover",
    )).toBe(true);
    expect(attachCommand({ kind: "terminal", terminalID: "t1" }, "default", false)).not.toContain("--takeover");
  });
});
