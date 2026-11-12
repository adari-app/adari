// A tiny React hooks host for Node tests (no DOM library in this project): it
// runs a function component, keeps its hook state between renders, runs
// effects after each render and re-renders synchronously when state or a
// subscribed store changes. The test mocks "react" with `fakeReact`, renders,
// then calls the returned elements' handlers (onChange, onKeyDown, onClick)
// directly. Enough for components built from useState, useEffect,
// useSyncExternalStore, useMemo, useCallback and useRef.

type Deps = readonly unknown[] | undefined;

interface EffectSlot {
  deps: Deps;
  cleanup: (() => void) | undefined;
}

function sameDeps(a: Deps, b: Deps): boolean {
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

let current: HookHost<never> | null = null;

function host(): HookHost<never> {
  if (current === null) throw new Error("a hook was called outside a HookHost render");
  return current;
}

export class HookHost<P> {
  private readonly slots: unknown[] = [];
  private index = 0;
  private effects: (() => void)[] = [];
  private rendering = false;
  private dirty = false;
  /** Slots holding an effect (or a store subscription's unsubscribe), for unmount. */
  private readonly cleanups = new Set<number>();
  tree: unknown = null;

  constructor(
    private readonly component: (props: P) => unknown,
    private props: P,
  ) {}

  render(props?: P): unknown {
    if (props !== undefined) this.props = props;
    this.rendering = true;
    try {
      do {
        this.dirty = false;
        this.index = 0;
        this.effects = [];
        const previous = current;
        current = this as unknown as HookHost<never>;
        try {
          this.tree = this.component(this.props);
        } finally {
          current = previous;
        }
        for (const effect of this.effects) effect();
      } while (this.dirty);
    } finally {
      this.rendering = false;
    }
    return this.tree;
  }

  /** Runs every effect's cleanup and drops store subscriptions (intervals, listeners). */
  unmount(): void {
    for (const i of this.cleanups) {
      const slot = this.slots[i];
      if (typeof slot === "function") (slot as () => void)();
      else (slot as EffectSlot | undefined)?.cleanup?.();
    }
  }

  private invalidate(): void {
    if (this.rendering) this.dirty = true;
    else this.render();
  }

  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
    const i = this.index++;
    if (!(i in this.slots)) this.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    const set = (next: T | ((previous: T) => T)): void => {
      const value = typeof next === "function" ? (next as (previous: T) => T)(this.slots[i] as T) : next;
      if (Object.is(value, this.slots[i])) return;
      this.slots[i] = value;
      this.invalidate();
    };
    return [this.slots[i] as T, set];
  }

  useEffect(effect: () => void | (() => void), deps?: Deps): void {
    const i = this.index++;
    this.cleanups.add(i);
    const slot = this.slots[i] as EffectSlot | undefined;
    if (slot !== undefined && sameDeps(slot.deps, deps)) return;
    this.effects.push(() => {
      slot?.cleanup?.();
      const cleanup = effect();
      this.slots[i] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined } satisfies EffectSlot;
    });
  }

  useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T): T {
    const i = this.index++;
    this.cleanups.add(i);
    if (!(i in this.slots)) this.slots[i] = subscribe(() => this.invalidate());
    return getSnapshot();
  }

  useMemo<T>(make: () => T, deps: Deps): T {
    const i = this.index++;
    const slot = this.slots[i] as { deps: Deps; value: T } | undefined;
    if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.value;
    const value = make();
    this.slots[i] = { deps, value };
    return value;
  }

  useRef<T>(initial: T): { current: T } {
    const i = this.index++;
    if (!(i in this.slots)) this.slots[i] = { current: initial };
    return this.slots[i] as { current: T };
  }
}

export const fakeReact = {
  useState: <T>(initial: T | (() => T)) => host().useState(initial),
  useEffect: (effect: () => void | (() => void), deps?: Deps) => host().useEffect(effect, deps),
  // Run as an effect here (there is no paint to come before).
  useLayoutEffect: (effect: () => void | (() => void), deps?: Deps) => host().useEffect(effect, deps),
  useSyncExternalStore: <T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T) =>
    host().useSyncExternalStore(subscribe, getSnapshot),
  useMemo: <T>(make: () => T, deps: Deps) => host().useMemo(make, deps),
  useCallback: <T>(callback: T, deps: Deps) => host().useMemo(() => callback, deps),
  useRef: <T>(initial: T) => host().useRef(initial),
};

interface Element {
  readonly type: unknown;
  readonly props: Record<string, unknown> & { children?: unknown };
}

function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

/** The host elements (not nested components) in a rendered tree, depth first. */
export function elements(tree: unknown): Element[] {
  const found: Element[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isElement(node)) return;
    found.push(node);
    walk(node.props.children);
  };
  walk(tree);
  return found;
}

/** The first host element of `type` (and class, when given). */
export function find(tree: unknown, type: string, className?: string): Element | undefined {
  return elements(tree).find((e) => e.type === type && (className === undefined || e.props["className"] === className));
}
