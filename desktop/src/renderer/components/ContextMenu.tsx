// A small menu at the pointer (Copy in Chat, a sidebar row's actions), drawn in
// the page so it has the app's look and shows in the window's own captures.
// Escape, a click elsewhere, a scroll or the window losing focus closes it.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEscapeOwner } from "./escape-owners";

export interface MenuItem {
  readonly label: string;
  /** Shown greyed, with the reason under it. */
  readonly disabledReason?: string | null;
  readonly shortcut?: string;
  onSelect(): void;
}

export interface ContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
  onClose(): void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  useEscapeOwner();
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = ref.current;
    if (menu === null) return;
    const { width, height } = menu.getBoundingClientRect();
    setPlace({
      left: Math.max(6, Math.min(x, window.innerWidth - width - 6)),
      top: Math.max(6, Math.min(y, window.innerHeight - height - 6)),
    });
  }, [x, y]);

  useEffect(() => {
    const close = (): void => onClose();
    const onDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
    };
  }, [onClose]);

  return (
    <div className="ctx" ref={ref} style={{ left: place.left, top: place.top }} role="menu" onContextMenu={(event) => event.preventDefault()}>
      {items.map((item) => {
        const disabled = item.disabledReason !== undefined && item.disabledReason !== null;
        return (
          <button
            key={item.label}
            role="menuitem"
            className={disabled ? "ctx-i off" : "ctx-i"}
            aria-disabled={disabled}
            title={disabled ? item.disabledReason! : undefined}
            onClick={() => {
              if (disabled) return;
              onClose();
              item.onSelect();
            }}
          >
            <span className="l">
              {item.label}
              {disabled ? <span className="why">{item.disabledReason}</span> : null}
            </span>
            {item.shortcut === undefined ? null : <span className="k">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}
