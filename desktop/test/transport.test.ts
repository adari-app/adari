// One exec's output to one reply, as CitadelTransport.parseBridgeOutput does
// it (OfficialCompanionTests.testOfficialSocketResponseLineIsBounded and the
// bridge-output rules): first newline-terminated line, UTF-8 decoded at line
// boundaries only, bounded; the socket-missing sentinel classified.

import { describe, expect, it } from "vitest";

import { maxDiagnosticBytes, maxResponseLineBytes } from "../src/main/herdr/commands";
import { ClosedBeforeResponseError, RemoteSocketFailedError, ResponseTooLargeError } from "../src/main/herdr/errors";
import { ReplyCollector, classifySocketFailure } from "../src/main/herdr/transport";

const socket = ".config/herdr/herdr.sock";

describe("ReplyCollector", () => {
  it("returns the first complete line, even split mid-character across packets", () => {
    const collector = new ReplyCollector(socket);
    const line = Buffer.from('{"id":"x","result":{"text":"héllo — ✓"}}\n{"second":true}\n', "utf8");
    const split = line.indexOf(Buffer.from("é")) + 1; // inside the two-byte é
    expect(collector.stdout(line.subarray(0, split))).toBeNull();
    expect(collector.stdout(line.subarray(split))).toBe('{"id":"x","result":{"text":"héllo — ✓"}}');
    expect(collector.finish(0)).toBe('{"id":"x","result":{"text":"héllo — ✓"}}');
  });

  it("accepts a reply without its newline when the channel ends", () => {
    const collector = new ReplyCollector(socket);
    expect(collector.stdout(Buffer.from('{"id":"x","result":{}}'))).toBeNull();
    expect(collector.finish(0)).toBe('{"id":"x","result":{}}');
    const failed = new ReplyCollector(socket);
    failed.stdout(Buffer.from('{"partial":true}'));
    expect(failed.finish(1)).toBe('{"partial":true}');
  });

  it("refuses an oversized unterminated line", () => {
    const collector = new ReplyCollector(socket);
    expect(() => collector.stdout(Buffer.alloc(maxResponseLineBytes + 1, 0x78))).toThrow(ResponseTooLargeError);
  });

  it("refuses an oversized terminated line", () => {
    const collector = new ReplyCollector(socket);
    const data = Buffer.concat([Buffer.alloc(maxResponseLineBytes + 1, 0x78), Buffer.from("\n")]);
    expect(() => collector.stdout(data)).toThrow(ResponseTooLargeError);
  });

  it("names a missing socket from the sentinel on a non-zero exit", () => {
    const collector = new ReplyCollector(socket);
    collector.stderrChunk(Buffer.from("__HERDR_SOCKET_MISSING__\n"));
    expect(() => collector.finish(66)).toThrow(RemoteSocketFailedError);
    try {
      collector.finish(66);
    } catch (error) {
      expect((error as Error).message).toBe(
        "couldn't reach the official Herdr socket at ~/.config/herdr/herdr.sock: the session is not running or the socket path is wrong",
      );
    }
  });

  it("reports the remote diagnostic, else the exit code", () => {
    expect(classifySocketFailure("  nc: connection refused \n", 1, socket).message).toContain("nc: connection refused");
    expect(classifySocketFailure("", 3, socket).message).toContain("remote command exited 3");
  });

  it("surfaces stderr on an empty exit-0 reply, else says the peer closed", () => {
    const withStderr = new ReplyCollector(socket);
    withStderr.stderrChunk(Buffer.from("something odd"));
    expect(() => withStderr.finish(0)).toThrow(RemoteSocketFailedError);
    expect(() => new ReplyCollector(socket).finish(0)).toThrow(ClosedBeforeResponseError);
    expect(() => new ReplyCollector(socket).finish(null)).toThrow(ClosedBeforeResponseError);
  });

  it("bounds the diagnostic", () => {
    const collector = new ReplyCollector(socket);
    for (let i = 0; i < 4; i += 1) collector.stderrChunk(Buffer.alloc(maxDiagnosticBytes, 0x65));
    try {
      collector.finish(2);
    } catch (error) {
      const detail = (error as RemoteSocketFailedError).detail;
      expect(detail.length).toBeLessThanOrEqual(maxDiagnosticBytes);
    }
  });
});
