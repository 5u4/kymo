import type { StatusName } from "kymo/api";

export const statusColor: Record<StatusName, string> = {
  running: "text-run",
  suspended: "text-sus",
  succeeded: "text-ok",
  failed: "text-fail",
  interrupted: "text-intr",
};
