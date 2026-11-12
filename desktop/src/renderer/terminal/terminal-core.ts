// Every terminal gets its
// own Ghostty engine, a WebAssembly instance of its own, so a new terminal
// never shows a closed one's text.
//
// ghostty-web 0.4.0's init() loads one instance for the whole window, and each
// Terminal not given one is built on it. Closing a terminal frees its core into
// that instance's memory without clearing it, and the next core is laid out on
// that same memory and reads what is left there as its own. Shared, the new
// terminal draws the closed pane's cells before its own port attaches, and its
// first short output keeps the rest (`https://b.invalid/a` reads
// `https://b.invalid/ad/a`, on screen and to the link provider). Clearing the
// new screen with escape codes would hide the cells, but anything else the old
// core left in that memory (row flags, styles, graphemes, links) could still
// be read as the new one's. A fresh instance starts on zeroed memory, so
// nothing of another pane can be in it.
//
// The module is compiled once for the window (ghostty-vt.wasm from the app's
// own files, byte for byte the copy ghostty-web embeds); each terminal only
// instantiates it. Nothing here keeps an instance: the Terminal holds it until
// it is disposed, then the whole memory (about 7 MB at the app's 80x24 grid
// and 10,000-line scrollback) goes with it, so memory follows the terminals
// that are open, never the ones that were. For that, openTerminal takes back
// what 0.4.0's open leaves listening on the document after dispose (below):
// one of those listeners holds the closed terminal's core, and with it the
// whole instance.

import { Ghostty, type Terminal } from "ghostty-web";
import engineUrl from "ghostty-web/ghostty-vt.wasm?url";

let compiled: Promise<WebAssembly.Module | null> | null = null;

/** The engine compiled once; null when the file could not be read or compiled (ghostty-web's own copy is used then). */
function engineModule(): Promise<WebAssembly.Module | null> {
  compiled ??= (async () => {
    try {
      const response = await fetch(engineUrl);
      if (!response.ok) return null;
      return await WebAssembly.compile(await response.arrayBuffer());
    } catch {
      return null;
    }
  })();
  return compiled;
}

/** A Ghostty engine of its own for one new terminal (pass it as the Terminal's `ghostty`). */
export async function newTerminalCore(): Promise<Ghostty> {
  const module = await engineModule();
  // ghostty-web's own loader makes a new instance on each call too, from its embedded copy.
  if (module === null) return Ghostty.load();
  let memory: WebAssembly.Memory | undefined;
  const instance = await WebAssembly.instantiate(module, {
    env: {
      // The engine's one import, as ghostty-web's loader gives it.
      log: (at: number, length: number) => {
        if (memory !== undefined) console.log("[ghostty-vt]", new TextDecoder().decode(new Uint8Array(memory.buffer, at, length)));
      },
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  return new Ghostty(instance);
}

type Listening = [target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options: boolean | AddEventListenerOptions | undefined];

/**
 * `terminal.open(host)`, keeping each listener it adds to the document and the
 * host; the returned function, called after `terminal.dispose()`, removes them.
 * ghostty-web 0.4.0's dispose misses some: Terminal's own document mouseup (it
 * clears `isOpen` before the check that removes it) and its SelectionManager's
 * document mousedown (an unnamed one it never removes), which holds the core.
 * Removing one dispose already removed does nothing.
 */
export function openTerminal(terminal: Terminal, host: HTMLElement): () => void {
  const added: Listening[] = [];
  const targets: EventTarget[] = [document, host];
  const own = targets.map((target) => Object.prototype.hasOwnProperty.call(target, "addEventListener"));
  const originals = targets.map((target) => target.addEventListener);
  targets.forEach((target, i) => {
    const original = originals[i]!;
    target.addEventListener = function (this: EventTarget, type, listener, options) {
      if (listener !== null) added.push([target, type, listener, options]);
      original.call(this, type, listener, options);
    };
  });
  try {
    terminal.open(host);
  } finally {
    targets.forEach((target, i) => {
      if (own[i]) target.addEventListener = originals[i]!;
      else delete (target as { addEventListener?: unknown }).addEventListener;
    });
  }
  return () => {
    for (const [target, type, listener, options] of added.splice(0)) target.removeEventListener(type, listener, options);
  };
}
