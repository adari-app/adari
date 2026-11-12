// One saved machine's SSH, in process, for HerdrMachineBackend
// tests. Each `connect` makes a fake ssh2 Client; its execs are answered as the
// machine would: a Herdr request (officialRequestCommand) from a LiveHerdr, or
// "the socket is missing" when the TUI is not running there; `hc connect`
// (CoreCommands.connect) bridged to a FakeCore link, or the lookup's
// not-installed marker when there is no herdr-core. Every client made is kept,
// so a test can see that none is left open.

import { EventEmitter } from "node:events";

import type { Client } from "ssh2";

import { socketMissingSentinel } from "../../src/main/herdr/commands";
import { CoreCommands } from "../../src/main/herdr/core-ssh";
import type { FakeCore, FakeCoreLink } from "./fake-core";
import { requestOf } from "./in-process-ssh";
import type { LiveHerdr } from "./live-herdr";

export class FakeExecChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  closed = false;
  onWrite: ((bytes: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;

  write(chunk: Buffer | Uint8Array | string): boolean {
    if (!this.closed) this.onWrite?.(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
    return true;
  }

  /** Ends the channel (exit status first when given), on a later turn as ssh2 does. */
  finish(code: number | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
    setImmediate(() => {
      if (code !== null) this.emit("exit", code);
      this.emit("close");
    });
  }

  close(): void {
    this.finish();
  }

  end(): void {
    this.finish();
  }

  setWindow(): void {}
}

export class FakeHostClient extends EventEmitter {
  ended = false;
  readonly commands: string[] = [];
  readonly channels: FakeExecChannel[] = [];
  /** The fake core links this client's `hc connect` channels opened. */
  readonly coreLinks: FakeCoreLink[] = [];

  constructor(private readonly host: FakeSshHost) {
    super();
  }

  exec(command: string, ...rest: unknown[]): boolean {
    const callback = rest.at(-1) as (error: Error | undefined, channel: FakeExecChannel) => void;
    this.commands.push(command);
    if (this.ended) {
      setImmediate(() => callback(new Error("the connection closed"), new FakeExecChannel()));
      return false;
    }
    const channel = new FakeExecChannel();
    this.channels.push(channel);
    setImmediate(() => {
      callback(undefined, channel);
      this.host.serve(this, command, channel);
    });
    return true;
  }

  end(): this {
    if (this.ended) return this;
    this.ended = true;
    for (const channel of this.channels) channel.finish();
    setImmediate(() => {
      this.emit("end");
      this.emit("close");
    });
    return this;
  }

  destroy(): this {
    return this.end();
  }
}

export class FakeSshHost {
  readonly clients: FakeHostClient[] = [];
  /** `hc connect` is accepted and never answered (an attempt still in flight). */
  holdCore = false;

  constructor(
    /** The Herdr TUI server there (null: not running, its socket missing). */
    public tui: LiveHerdr | null,
    /** herdr-core there (null: not installed). */
    public core: FakeCore | null,
  ) {}

  /** The route's connect seam: a new client. */
  readonly connect = (): Promise<Client> => {
    const client = new FakeHostClient(this);
    this.clients.push(client);
    return Promise.resolve(client as unknown as Client);
  };

  /** Clients made and not ended. */
  get openClients(): FakeHostClient[] {
    return this.clients.filter((client) => !client.ended);
  }

  /** Every exec command run so far, on every client. */
  get commands(): string[] {
    return this.clients.flatMap((client) => client.commands);
  }

  /** Clients that ran `hc connect`. */
  get coreClients(): FakeHostClient[] {
    return this.clients.filter((client) => client.commands.includes(CoreCommands.connect));
  }

  serve(client: FakeHostClient, command: string, channel: FakeExecChannel): void {
    if (command === CoreCommands.connect) {
      const core = this.core;
      if (core === null) {
        channel.stderr.emit("data", Buffer.from(`${CoreCommands.notInstalledMarker}\n`));
        channel.finish(127);
        return;
      }
      if (this.holdCore) return;
      const link = core.makeLink();
      client.coreLinks.push(link);
      channel.onWrite = (bytes) => link.send(bytes);
      channel.onClose = () => link.close();
      void (async () => {
        for await (const chunk of link.inbound) {
          if (channel.closed) break;
          channel.emit("data", Buffer.from(chunk));
        }
        channel.finish(0);
      })();
      return;
    }
    const request = requestOf(command);
    if (request === null) {
      channel.finish(1);
      return;
    }
    const tui = this.tui;
    if (tui === null) {
      channel.stderr.emit("data", Buffer.from(`${socketMissingSentinel}\n`));
      channel.finish(1);
      return;
    }
    void tui.roundTrip(request).then(
      (answer) => {
        if (channel.closed) return;
        channel.emit("data", Buffer.from(`${answer}\n`));
        channel.finish(0);
      },
      () => channel.finish(1),
    );
  }
}
