import * as Option from "effect/Option";
import type { StatusName } from "kymo/api";
import { spanStatus, type Span } from "./trace-view.ts";

export const statusColor: Record<StatusName, string> = {
  running: "text-run",
  suspended: "text-sus",
  succeeded: "text-ok",
  failed: "text-fail",
  interrupted: "text-intr",
};

export const spanColor = (span: Span): string =>
  span._tag === "Wait"
    ? span.wait.kind === "Clock"
      ? "text-clock"
      : "text-sus"
    : Option.match(spanStatus(span), {
        onNone: () => "text-fg-4",
        onSome: (status) => statusColor[status],
      });
