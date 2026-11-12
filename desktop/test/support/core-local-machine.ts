// A saved machine on this computer for the Chat, relay and upload
// tests on a herdr-core host. Every connection is This Mac's local session
// (connectLocal: exec under /bin/sh and SFTP on a temp home, this-mac-fake.ts's
// FakeMac, never this Mac's own home or Herdr socket), except `hc connect`,
// which goes to the fake core (core-host-ssh.ts): no herdr-core lookup ever
// runs here.

import { EventEmitter } from "node:events";

import type { Client } from "ssh2";

import { CoreCommands } from "../../src/main/herdr/core-ssh";
import { connectLocal } from "../../src/main/herdr/local";
import { FakeHostClient, FakeSshHost } from "./core-host-ssh";
import type { FakeCore } from "./fake-core";
import type { FakeMac } from "./this-mac-fake";

type Callback = (...args: unknown[]) => void;

interface LocalLike extends EventEmitter {
  exec(command: string, ...rest: unknown[]): boolean;
  shell(...rest: unknown[]): boolean;
  sftp(done: Callback): boolean;
  end(): unknown;
}

export class LocalCoreClient extends EventEmitter {
  readonly commands: string[] = [];
  ended = false;
  sftpSessions = 0;
  private readonly core: FakeHostClient;

  constructor(
    private readonly local: LocalLike,
    host: FakeSshHost,
  ) {
    super();
    this.core = new FakeHostClient(host);
    local.on("end", () => this.emit("end"));
    local.on("close", () => this.emit("close"));
  }

  exec(command: string, ...rest: unknown[]): boolean {
    this.commands.push(command);
    if (command === CoreCommands.connect) return this.core.exec(command, ...rest);
    return this.local.exec(command, ...rest);
  }

  shell(...rest: unknown[]): boolean {
    return this.local.shell(...rest);
  }

  sftp(done: Callback): boolean {
    this.sftpSessions += 1;
    return this.local.sftp(done);
  }

  end(): this {
    if (this.ended) return this;
    this.ended = true;
    this.core.end();
    this.local.end();
    return this;
  }
}

export class CoreLocalMachine {
  readonly clients: LocalCoreClient[] = [];
  private readonly coreHost: FakeSshHost;

  constructor(
    readonly mac: FakeMac,
    core: FakeCore | null,
  ) {
    this.coreHost = new FakeSshHost(null, core);
  }

  readonly connect = async (): Promise<Client> => {
    const local = (await connectLocal(this.mac.options())) as unknown as LocalLike;
    const client = new LocalCoreClient(local, this.coreHost);
    this.clients.push(client);
    return client as unknown as Client;
  };

  get commands(): string[] {
    return this.clients.flatMap((client) => client.commands);
  }

  get openClients(): LocalCoreClient[] {
    return this.clients.filter((client) => !client.ended);
  }
}
