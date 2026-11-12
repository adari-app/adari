// The sidebar footer's update pill, shown only
// while a newer Adari is out: Download (a click downloads it), a progress ring
// while it downloads, then Restart (a click asks first, in the main process's
// dialog). Nothing downloads or installs without a click on it.
//
// Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.; read at
// 09a54f01): apps/web/src/components/sidebar/SidebarUpdatePill.tsx (the pill
// in the sidebar's foot, its action per state) and DesktopUpdateStatusIcon.tsx
// (the download arrow, the progress ring drawn with a dash offset, the restart
// arrow). Not taken: T3's dismiss button, release-notes link and architecture
// warning.

import type { UpdatePill as UpdatePillView } from "../../shared/updates";

const ringRadius = 6;
const ringCircumference = 2 * Math.PI * ringRadius;

/** The dash offset that shows `percent` of the ring (0: empty, 100: full). */
export function ringOffset(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  return Number((ringCircumference * (1 - clamped / 100)).toFixed(2));
}

/** The pill's icon: the download arrow, the progress ring, or the restart arrow (drawn in the pill's own tree). */
function pillIcon(pill: UpdatePillView) {
  if (pill.icon === "progress") {
    return (
      <svg className="upd-ic upd-ring" width={14} height={14} viewBox="0 0 16 16" aria-hidden="true">
        <circle className="upd-ring-t" cx="8" cy="8" r={ringRadius} fill="none" strokeWidth={2} />
        <circle
          className="upd-ring-v"
          cx="8"
          cy="8"
          r={ringRadius}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={ringCircumference.toFixed(2)}
          strokeDashoffset={ringOffset(pill.percent ?? 0)}
          transform="rotate(-90 8 8)"
        />
      </svg>
    );
  }
  if (pill.icon === "restart") {
    return (
      <svg className="upd-ic" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 11a8 8 0 1 0-2.3 5.7" />
        <path d="M20 4v7h-7" />
      </svg>
    );
  }
  return (
    <svg className="upd-ic" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M5 19.5h14" />
    </svg>
  );
}

/** The pill for `pill` (null: no pill). `onAction` runs Download or Restart, only on a click. */
export function UpdatePill({ pill, onAction }: { pill: UpdatePillView | null; onAction: (action: "download" | "install") => void }) {
  if (pill === null) return null;
  const action = pill.action;
  return (
    <button
      type="button"
      className={`upd-pill upd-${pill.icon}${pill.busy ? " busy" : ""}`}
      data-update-pill={pill.icon === "progress" ? "downloading" : pill.action === "none" ? "installing" : pill.action}
      title={pill.title}
      aria-label={pill.title}
      aria-busy={pill.busy || undefined}
      disabled={action === "none"}
      onClick={() => {
        if (action !== "none") onAction(action);
      }}
    >
      {pillIcon(pill)}
      <span className="upd-l">{pill.label}</span>
    </button>
  );
}
