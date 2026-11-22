// A few DOM nodes for Node tests (no DOM library in this project), enough for
// mouse events to travel as Chromium sends them: down the capture path from
// the root, at the target (its capture listeners first, then the others, as
// Chromium does since version 89), then back up; stopPropagation ends the
// trip after the node it was called on, stopImmediatePropagation at once.
// The root stands for the document. `mouse` makes the event a real press,
// move or release carries (button, buttons, client and offset positions,
// modifiers, click count).

type Listener = ((event: Event) => void) | { handleEvent(event: Event): void };

interface Registered {
  readonly type: string;
  readonly listener: Listener;
  readonly capture: boolean;
  readonly once: boolean;
}

function captureOf(options: boolean | AddEventListenerOptions | EventListenerOptions | undefined): boolean {
  return typeof options === "boolean" ? options : options?.capture === true;
}

export class FakeNode {
  parentNode: FakeNode | null = null;
  readonly children: FakeNode[] = [];
  private listeners: Registered[] = [];
  /** A rect for getBoundingClientRect (the canvas's). */
  rect = { left: 0, top: 0, width: 0, height: 0 };
  /** ghostty-web's host takes the keyboard on a press (SelectionManager focuses the canvas's parent). */
  focused = 0;
  /** In the window and laid out (the OSC 52 copy asks). */
  isConnected = true;

  constructor(readonly name: string) {}

  get parentElement(): FakeNode | null {
    return this.parentNode;
  }

  get clientHeight(): number {
    return this.rect.height;
  }

  append<T extends FakeNode>(child: T): T {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  contains(other: unknown): boolean {
    for (let node = other instanceof FakeNode ? other : null; node !== null; node = node.parentNode) if (node === this) return true;
    return false;
  }

  focus(): void {
    this.focused += 1;
  }

  replaceChildren(): void {
    for (const child of this.children.splice(0)) child.parentNode = null;
  }

  getClientRects(): unknown[] {
    return this.isConnected ? [this.getBoundingClientRect()] : [];
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }

  addEventListener(type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions): void {
    if (listener === null) return;
    const capture = captureOf(options);
    if (this.listeners.some((each) => each.type === type && each.listener === listener && each.capture === capture)) return;
    this.listeners.push({ type, listener, capture, once: typeof options === "object" && options.once === true });
  }

  removeEventListener(type: string, listener: Listener | null, options?: boolean | EventListenerOptions): void {
    const capture = captureOf(options);
    this.listeners = this.listeners.filter((each) => !(each.type === type && each.listener === listener && each.capture === capture));
  }

  /** How many listeners of this type are on the node (a test that everything was taken back). */
  listening(type: string): number {
    return this.listeners.filter((each) => each.type === type).length;
  }

  dispatchEvent(event: Event): boolean {
    const path: FakeNode[] = [this];
    for (let node = this.parentNode; node !== null; node = node.parentNode) path.push(node);
    let stopped = false;
    let immediate = false;
    Object.defineProperty(event, "target", { value: this, configurable: true });
    Object.defineProperty(event, "stopPropagation", { value: () => (stopped = true), configurable: true });
    Object.defineProperty(event, "stopImmediatePropagation", {
      value: () => {
        stopped = true;
        immediate = true;
      },
      configurable: true,
    });
    const invoke = (node: FakeNode, capture: boolean): void => {
      if (stopped) return;
      Object.defineProperty(event, "currentTarget", { value: node, configurable: true });
      // The list as it stood (the DOM's snapshot): a listener removed meanwhile is skipped below, one added waits
      // for the next event.
      for (const each of node.listeners.slice()) {
        if (each.type !== event.type || each.capture !== capture || !node.listeners.includes(each)) continue;
        if (each.once) node.removeEventListener(each.type, each.listener, { capture });
        if (typeof each.listener === "function") each.listener.call(node, event);
        else each.listener.handleEvent(event);
        if (immediate) return;
      }
    };
    for (let i = path.length - 1; i >= 1; i -= 1) invoke(path[i]!, true);
    invoke(this, true);
    invoke(this, false);
    if (event.bubbles) for (let i = 1; i < path.length; i += 1) invoke(path[i]!, false);
    return !event.defaultPrevented;
  }
}

export interface MouseInit {
  readonly clientX: number;
  readonly clientY: number;
  readonly button?: number;
  readonly buttons?: number;
  readonly detail?: number;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

/** A mouse event as Chromium makes it; offsetX/Y are against `over`'s rect (the canvas). */
export function mouse(type: string, init: MouseInit, over?: FakeNode): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const rect = over?.rect ?? { left: 0, top: 0 };
  return Object.assign(event, {
    button: 0,
    buttons: 0,
    detail: 1,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...init,
    offsetX: init.clientX - rect.left,
    offsetY: init.clientY - rect.top,
  });
}
