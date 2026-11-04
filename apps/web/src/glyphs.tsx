import type { StatusName } from "kymo/api";
import type { ReactNode } from "react";
import { statusColor } from "./status-color.ts";

const statusPaths: Record<StatusName, ReactNode> = {
  running: <circle cx="8" cy="8" r="3.6" fill="currentColor" />,
  suspended: (
    <>
      <rect x="4.6" y="4" width="2.3" height="8" rx=".7" fill="currentColor" />
      <rect x="9.1" y="4" width="2.3" height="8" rx=".7" fill="currentColor" />
    </>
  ),
  succeeded: (
    <path
      d="M3.8 8.6l2.7 2.6 5.7-6.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  failed: (
    <path
      d="M4.7 4.7l6.6 6.6M11.3 4.7l-6.6 6.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  ),
  interrupted: (
    <>
      <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.6 11.4l6.8-6.8" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
};

export const StatusIcon = ({ status, className }: { status: StatusName; className: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className={`block shrink-0 ${className}`}>
    {statusPaths[status]}
  </svg>
);

export const StatusGlyph = ({ status, className }: { status: StatusName; className: string }) => (
  <span
    aria-hidden="true"
    className={`relative inline-grid size-4 shrink-0 place-items-center ${statusColor[status]} ${status === "running" ? "after:absolute after:inset-px after:animate-ping-ring after:rounded-full after:border after:border-current motion-reduce:after:hidden" : ""} ${className}`}
  >
    <StatusIcon status={status} className="size-3.5" />
  </span>
);

export const ParentIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="block size-3 shrink-0">
    <path
      d="M11.5 13V6.5h-7M6.8 4.2L4.5 6.5l2.3 2.3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
