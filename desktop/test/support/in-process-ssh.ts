// A Mac's sshd in this process. ssh2's own Server answers on
// one end of an in-memory duplex pair and the app's ssh2 Client talks on the
// other, so the key exchange, the host-key check and the sign-in are real SSH
// with nothing on the network (no listening port, no address). It records what
// reached it: each sign-in attempt (the method, and a password's text), each
// session, each exec command and each shell. Its execs answer from a LiveHerdr,
// so a snapshot over it is Herdr's own reply.

import { Duplex } from "node:stream";
import type { Socket } from "node:net";

import { Server, utils, type AuthContext, type Connection, type Session } from "ssh2";

import { wireKeyFromOpenSSHLine } from "../../src/main/herdr/host-key-pinning";
import { LiveHerdr } from "./live-herdr";

/** A throwaway ed25519 host key made for the test: its private key for the server, its wire encoding for the checks. */
export interface TestHostKey {
  readonly privateKey: string;
  readonly publicLine: string;
  readonly wire: Buffer;
}

export function makeHostKey(): TestHostKey {
  const pair = utils.generateKeyPairSync("ed25519");
  return { privateKey: pair.private, publicLine: pair.public, wire: wireKeyFromOpenSSHLine(pair.public) };
}

/** What reached the Mac. */
export interface MacSeen {
  /** Every sign-in attempt's method ("none", "password", "publickey", ...), in order. */
  readonly authentications: string[];
  /** The text of every password offered. */
  readonly passwords: string[];
  /** Sessions opened (after a sign-in). */
  sessions: number;
  /** Each exec's command line, in order. */
  readonly execs: string[];
  /** Shells (a terminal attach) asked for. */
  shells: number;
  /** Key exchanges begun (a connection reached the Mac). */
  connections: number;
}

/**
 * Two connected streams that deliver each write on a later turn, as a socket
 * does. (node's duplexPair delivers within the write: ssh2's server then reads
 * the client's NEWKEYS while still sending its key exchange reply, and refuses.)
 */
function socketPair(): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  const end = (other: () => Duplex): Duplex =>
    new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        setImmediate(() => {
          other().push(chunk);
          done();
        });
      },
      final(done) {
        setImmediate(() => {
          other().push(null);
          done();
        });
      },
    });
  ends.push(end(() => ends[1]!), end(() => ends[0]!));
  return [ends[0]!, ends[1]!];
}

/** The Herdr request line inside an exec (officialRequestCommand's base64 payload), or null. */
export function requestOf(command: string): string | null {
  const encoded = /printf '%s' '([^']+)'/.exec(command)?.[1];
  return encoded === undefined ? null : Buffer.from(encoded, "base64").toString("utf8").trim();
}

export class InProcessMac {
  readonly seen: MacSeen = { authentications: [], passwords: [], sessions: 0, execs: [], shells: 0, connections: 0 };
  readonly herdr = new LiveHerdr();
  private server: Server;
  private key: TestHostKey;

  constructor(key: TestHostKey = makeHostKey()) {
    this.key = key;
    this.server = this.makeServer(key);
    this.herdr.addTab("w1:t1", ["w1:p1"], { "w1:p1": "claude" });
  }

  /** The key this Mac presents now. */
  get hostKey(): TestHostKey {
    return this.key;
  }

  /** The Mac presents another key from its next connection on (a reinstall, or someone in between). */
  presentKey(key: TestHostKey): void {
    this.key = key;
    this.server = this.makeServer(key);
  }

  /** The client's end of a new connection; the server takes the other end. */
  socket(): Duplex {
    const [client, server] = socketPair();
    this.seen.connections += 1;
    this.server.injectSocket(server as unknown as Socket);
    return client;
  }

  private makeServer(key: TestHostKey): Server {
    return new Server({ hostKeys: [key.privateKey] }, (connection: Connection) => {
      connection.on("authentication", (context: AuthContext) => {
        this.seen.authentications.push(context.method);
        if (context.method === "password") {
          this.seen.passwords.push(context.password);
          context.accept();
          return;
        }
        context.reject(["password"]);
      });
      connection.on("ready", () => {
        connection.on("session", (accept) => {
          this.seen.sessions += 1;
          this.serve(accept());
        });
      });
      connection.on("error", () => undefined);
    });
  }

  private serve(session: Session): void {
    session.on("exec", (accept, _reject, info) => {
      this.seen.execs.push(info.command);
      const channel = accept();
      const request = requestOf(info.command);
      if (request === null) {
        channel.exit(1);
        channel.end();
        return;
      }
      void this.herdr.roundTrip(request).then(
        (answer) => {
          channel.write(`${answer}\n`);
          channel.exit(0);
          channel.end();
        },
        () => {
          channel.exit(1);
          channel.end();
        },
      );
    });
    session.on("pty", (accept) => accept?.());
    session.on("shell", (accept) => {
      this.seen.shells += 1;
      accept().end();
    });
  }
}
