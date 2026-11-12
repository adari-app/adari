// The app's line icons, 1.6 stroke.

import type { ReactNode } from "react";

function Icon({ size, children, strokeWidth = 1.6 }: { size: number; children: ReactNode; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const FolderOpenIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M3 17.5V7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.8 2h7A1.5 1.5 0 0 1 19 9.5V11" />
    <path d="M3 17.5 5.6 12h16.2l-2.7 6.2a1.5 1.5 0 0 1-1.4.8H4.5A1.5 1.5 0 0 1 3 17.5z" />
  </Icon>
);

export const FolderIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.8 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
  </Icon>
);

export const ChevronDownIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const ChevronRightIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const SearchIcon = ({ size = 17 }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Icon>
);

export const PlusIcon = ({ size = 17 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const MonitorIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16.5V20" />
  </Icon>
);

export const ChatIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.4A8 8 0 1 1 20.5 11.5z" />
  </Icon>
);

export const TerminalIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m5 8 4 4-4 4M12 16h7" />
  </Icon>
);

/** The terminal drawer's button (T3 Code's terminal toggle): a window with a shell along its bottom. */
export const TerminalDrawerIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M3.5 12.5h17M7 15l1.8 1.5L7 18M11 18h3.5" />
  </Icon>
);

export const SendIcon = ({ size = 17 }: { size?: number }) => (
  <Icon size={size} strokeWidth={2.2}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
);

export const SettingsIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
);

export const CloseIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const EyeIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.6" />
  </Icon>
);

export const PencilIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
    <path d="m14 7 3 3" />
  </Icon>
);

export const PromptIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m5 7 5 5-5 5" />
    <path d="M12 17h7" />
  </Icon>
);

export const GlobeIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5s1.1-5.9 3.6-8.5z" />
  </Icon>
);

export const AgentIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="5" y="8" width="14" height="11" rx="3" />
    <path d="M12 4.5V8M9.5 13h.01M14.5 13h.01" />
  </Icon>
);

export const ListIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
  </Icon>
);

export const ToolIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M14.5 6.5a4 4 0 0 0-5 5L4 17v3h3l5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z" />
  </Icon>
);

export const ArrowDownIcon = ({ size = 13 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Icon>
);

export const SparkIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M6.5 17.5 9 15M15 9l2.5-2.5" />
  </Icon>
);

export const ImageIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m20.5 16-5-5-8 8" />
  </Icon>
);

export const FileIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z" />
    <path d="M14 3.5V8h4" />
  </Icon>
);

export const ExternalIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10" />
  </Icon>
);

export const MessageBoxIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="3.5" y="13" width="17" height="7" rx="2.5" />
    <path d="M7 16.5h6M4 9h16M4 5h16" />
  </Icon>
);

export const MoreIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={2.6} />
  </Icon>
);

export const CopyIcon = ({ size = 13 }: { size?: number }) => (
  <Icon size={size} strokeWidth={1.75}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </Icon>
);

export const CheckIcon = ({ size = 13 }: { size?: number }) => (
  <Icon size={size} strokeWidth={2}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const WrapIcon = ({ size = 13 }: { size?: number }) => (
  <Icon size={size} strokeWidth={1.75}>
    <path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4" />
    <path d="m15 16-2 2 2 2M4 18h5" />
  </Icon>
);

export const PaperclipIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size} strokeWidth={1.75}>
    <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
  </Icon>
);

/** Changes (a plus over a minus). */
export const ChangesIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 4v8M8 8h8M8 19h8" />
  </Icon>
);

export const ChevronLeftIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m15 6-6 6 6 6" />
  </Icon>
);

export const RefreshIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Icon>
);

/** A model's star in the picker (filled while it is a favourite). */
export const StarIcon = ({ size = 13, filled = false }: { size?: number; filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
  </svg>
);

/** A pane split in two (a tile's split menu). */
export const SplitIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M12 4.5v15" />
  </Icon>
);
/** Zoom a pane over its tab, and back. */
export const ZoomIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" />
  </Icon>
);

// The Permissions chip's icons, T3 Code's (lucide: Lock, PenLine,
// Sparkles, ShieldOff), a plan icon (ListTodo) and a plain shield while no
// mode reads.
export type ModeIconName = "lock" | "pen" | "sparkles" | "shieldOff" | "plan" | "unknown";

export const ModeIcon = ({ icon, size = 13 }: { icon: ModeIconName; size?: number }) => {
  switch (icon) {
    case "lock":
      return (
        <Icon size={size}>
          <rect width="16" height="10" x="4" y="11" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </Icon>
      );
    case "pen":
      return (
        <Icon size={size}>
          <path d="M12 20h9" />
          <path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.4 18.6a2 2 0 0 1-.9.5l-2.9.8a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.9z" />
        </Icon>
      );
    case "sparkles":
      return (
        <Icon size={size}>
          <path d="M9.9 15.5a2 2 0 0 0-1.4-1.4l-6.1-1.6a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z" />
          <path d="M20 3v4" />
          <path d="M22 5h-4" />
        </Icon>
      );
    case "shieldOff":
      return (
        <Icon size={size}>
          <path d="m2 2 20 20" />
          <path d="M5 5a1 1 0 0 0-1 1v7c0 5 3.5 7.5 7.7 8.9a1 1 0 0 0 .6 0c2.4-.8 4.5-2 5.9-3.7" />
          <path d="M9.3 3.7a12 12 0 0 0 1.9-1.4 1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1v7a9.8 9.8 0 0 1-.1 1.3" />
        </Icon>
      );
    case "plan":
      return (
        <Icon size={size}>
          <rect x="3" y="5" width="6" height="6" rx="1" />
          <path d="m3 17 2 2 4-4" />
          <path d="M13 6h8" />
          <path d="M13 12h8" />
          <path d="M13 18h8" />
        </Icon>
      );
    default:
      return (
        <Icon size={size}>
          <path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z" />
        </Icon>
      );
  }
};
