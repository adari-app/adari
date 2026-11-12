// The command channel to the page: a command goes out on IPC.appCommand, and
// the page answers with its id once the change is painted (two animation
// frames later). It lives apart from capture.ts so the shipped app, which
// answers the page through it, carries none of the demo's captures.

import type { WebContents } from "electron";

import { IPC, RENDERER_READY, type AppCommand } from "../shared/ipc-contract";

export type CommandBody = AppCommand extends infer C ? (C extends AppCommand ? Omit<C, "id"> : never) : never;

export class AppCommands {
  private readonly waiters = new Map<string, () => void>();
  private readonly done = new Set<string>();
  private next = 1;

  /** The page's answer for `id` (a command, or RENDERER_READY). */
  answered(id: string): void {
    const waiter = this.waiters.get(id);
    if (waiter === undefined) {
      this.done.add(id);
      return;
    }
    this.waiters.delete(id);
    waiter();
  }

  /** Resolves once the page has answered `id`, or rejects after `timeoutMs`. */
  wait(id: string, timeoutMs: number): Promise<void> {
    if (this.done.delete(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`the page did not answer ${id} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  ready(timeoutMs: number): Promise<void> {
    return this.wait(RENDERER_READY, timeoutMs);
  }

  /** Sends one command and resolves once the page has painted it. */
  send(contents: WebContents, body: CommandBody, timeoutMs = 10_000): Promise<void> {
    const id = `command-${this.next++}`;
    const answer = this.wait(id, timeoutMs);
    contents.send(IPC.appCommand, { ...body, id } as AppCommand);
    return answer;
  }
}
