import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  statusName,
  type ActivityRun,
  type ActivityStatus,
  type ExecutionDetail,
  type ExecutionStatus,
  type ExecutionSummary,
  type StatusName,
  type Wait,
} from "kymo/api";
import { shortId } from "./executions-view.ts";

interface Timing {
  readonly key: string;
  readonly start: number;
  readonly end: Option.Option<number>;
  readonly children: ReadonlyArray<Span>;
}

export interface ExecutionSpan extends Timing {
  readonly _tag: "Execution";
  readonly detail: ExecutionDetail;
}

export interface ActivitySpan extends Timing {
  readonly _tag: "Activity";
  readonly name: string;
  readonly status: ActivityStatus;
  readonly attempts: ReadonlyArray<ActivityRun>;
}

export interface AttemptSpan extends Timing {
  readonly _tag: "Attempt";
  readonly run: ActivityRun;
  readonly of: number;
}

export interface WaitSpan extends Timing {
  readonly _tag: "Wait";
  readonly wait: Wait;
  readonly wakeAt: Option.Option<number>;
}

export interface ChildSpan extends Timing {
  readonly _tag: "Child";
  readonly id: string;
  readonly summary: Option.Option<ExecutionSummary>;
}

export type Span = ExecutionSpan | ActivitySpan | AttemptSpan | WaitSpan | ChildSpan;

export const waitKind: Record<Wait["kind"], string> = {
  Clock: "DurableClock",
  Deferred: "DurableDeferred",
};

export const spanStatus = (span: Span): Option.Option<StatusName> => {
  switch (span._tag) {
    case "Execution":
      return Option.some(statusName(span.detail.status));
    case "Activity":
      return Option.some(statusName(span.status));
    case "Attempt":
      return Option.some(statusName(span.run.status));
    case "Wait":
      return Option.none();
    case "Child":
      return Option.map(span.summary, (summary) => statusName(summary.status));
  }
};

export const spanName = (span: Span): string => {
  switch (span._tag) {
    case "Execution":
      return span.detail.workflow;
    case "Activity":
      return span.name;
    case "Attempt":
      return `attempt ${span.run.attempt}`;
    case "Wait":
      return span.wait.name;
    case "Child":
      return shortId(span.id);
  }
};

export const isEnded = (status: ExecutionStatus): boolean =>
  status._tag === "Succeeded" || status._tag === "Failed" || status._tag === "Interrupted";

export type StopNote =
  | {
      readonly _tag: "Failure";
      readonly cause: string;
      readonly activity: Option.Option<ActivityRun>;
    }
  | { readonly _tag: "Deferred"; readonly name: Option.Option<string> }
  | { readonly _tag: "Clock"; readonly name: string; readonly wakeAt: DateTime.Utc }
  | { readonly _tag: "Child"; readonly executionId: string }
  | { readonly _tag: "Failed"; readonly kind: "Fail" | "Die"; readonly message: string };

export const stopNote = (detail: ExecutionDetail): Option.Option<StopNote> => {
  const { status } = detail;
  switch (status._tag) {
    case "Failed":
      return Option.some({ _tag: "Failed", kind: status.kind, message: status.message });
    case "Suspended": {
      const { reason } = status;
      switch (reason._tag) {
        case "Failure":
          return Option.some({
            _tag: "Failure",
            cause: reason.cause,
            activity: Option.fromUndefinedOr(
              detail.activities.findLast(
                (run) => run.status._tag === "Failed" || run.status._tag === "Suspended",
              ),
            ),
          });
        case "Deferred":
          return Option.some({ _tag: "Deferred", name: reason.name });
        case "Clock":
          return Option.some({ _tag: "Clock", name: reason.name, wakeAt: reason.wakeAt });
        case "Child":
          return Option.some({ _tag: "Child", executionId: reason.executionId });
      }
    }
    case "Running":
    case "Succeeded":
    case "Interrupted":
      return Option.none();
  }
};

const activitySpans = (activities: ReadonlyArray<ActivityRun>): ReadonlyArray<ActivitySpan> =>
  [...Map.groupBy(activities, (run) => run.name)].flatMap(([name, runs]): Array<ActivitySpan> => {
    const attempts = runs.toSorted((a, b) => a.attempt - b.attempt);
    const [first] = attempts;
    const last = attempts.at(-1);
    if (first === undefined || last === undefined) return [];
    const key = `a/${name}`;
    return [
      {
        _tag: "Activity",
        key,
        name,
        start: DateTime.toEpochMillis(first.startedAt),
        end: Option.map(last.endedAt, DateTime.toEpochMillis),
        status: last.status,
        attempts,
        children:
          attempts.length > 1
            ? attempts.map((run) => ({
                _tag: "Attempt",
                key: `${key}/${run.attempt}`,
                start: DateTime.toEpochMillis(run.startedAt),
                end: Option.map(run.endedAt, DateTime.toEpochMillis),
                run,
                of: attempts.length,
                children: [],
              }))
            : [],
      },
    ];
  });

export const traceOf = (
  detail: ExecutionDetail,
  summaries: ReadonlyMap<string, ExecutionSummary>,
): ExecutionSpan => {
  const start = DateTime.toEpochMillis(detail.startedAt);
  const { status } = detail;
  const waits = detail.waits.map((wait): WaitSpan => ({
    _tag: "Wait",
    key: `w/${wait.kind}/${wait.name}`,
    start: DateTime.toEpochMillis(wait.since),
    end: Option.none(),
    wait,
    wakeAt:
      wait.kind === "Clock" &&
      status._tag === "Suspended" &&
      status.reason._tag === "Clock" &&
      status.reason.name === wait.name
        ? Option.some(DateTime.toEpochMillis(status.reason.wakeAt))
        : Option.none(),
    children: [],
  }));
  const children = detail.children.map((id): ChildSpan => {
    const summary = Option.fromUndefinedOr(summaries.get(id));
    return {
      _tag: "Child",
      key: `c/${id}`,
      id,
      summary,
      start: Option.match(summary, {
        onNone: () => start,
        onSome: (found) => DateTime.toEpochMillis(found.startedAt),
      }),
      end: Option.flatMap(summary, (found) =>
        isEnded(found.status)
          ? Option.some(
              DateTime.toEpochMillis(Option.getOrElse(found.updatedAt, () => found.startedAt)),
            )
          : Option.none(),
      ),
      children: [],
    };
  });
  return {
    _tag: "Execution",
    key: "exec",
    detail,
    start,
    end: isEnded(status)
      ? Option.some(
          DateTime.toEpochMillis(Option.getOrElse(detail.updatedAt, () => detail.startedAt)),
        )
      : Option.none(),
    children: [...activitySpans(detail.activities), ...waits, ...children].toSorted(
      (a, b) => a.start - b.start,
    ),
  };
};

export const spansOf = (root: Span): ReadonlyArray<Span> => [
  root,
  ...root.children.flatMap(spansOf),
];

export const findSpan = (root: Span, key: string): Option.Option<Span> =>
  Option.fromUndefinedOr(spansOf(root).find((span) => span.key === key));

export const defaultExpanded = (root: Span): ReadonlySet<string> =>
  new Set([
    root.key,
    ...spansOf(root)
      .filter(
        (span) =>
          span._tag === "Activity" && span.attempts.length > 1 && span.status._tag !== "Succeeded",
      )
      .map((span) => span.key),
  ]);

const ancestorsOf = (root: Span, key: string): ReadonlyArray<string> => {
  if (root.key === key) return [];
  for (const child of root.children) {
    const path = ancestorsOf(child, key);
    if (path.length > 0 || child.key === key) return [root.key, ...path];
  }
  return [];
};

export const expandTo = (
  root: Span,
  expanded: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> => new Set([...expanded, ...ancestorsOf(root, key)]);

export interface TraceRow {
  readonly span: Span;
  readonly depth: number;
  readonly hasChildren: boolean;
}

export const visibleRows = (root: Span, expanded: ReadonlySet<string>): ReadonlyArray<TraceRow> => {
  const rows: Array<TraceRow> = [];
  const walk = (span: Span, depth: number) => {
    rows.push({ span, depth, hasChildren: span.children.length > 0 });
    if (expanded.has(span.key)) for (const child of span.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return rows;
};

export const initialSpan = (root: Span, status: ExecutionStatus): string => {
  if (status._tag !== "Suspended" && status._tag !== "Failed") return root.key;
  const spans = spansOf(root);
  const wait = spans.find((span) => span._tag === "Wait");
  const failed = spans.findLast(
    (span) =>
      span._tag === "Activity" &&
      (span.status._tag === "Failed" || span.status._tag === "Suspended"),
  );
  return (wait ?? failed ?? root).key;
};

export const moveSpan = (
  rows: ReadonlyArray<TraceRow>,
  expanded: ReadonlySet<string>,
  current: string,
  key: string,
): Option.Option<{ readonly key: string; readonly expanded: ReadonlySet<string> }> => {
  const index = Math.max(
    0,
    rows.findIndex((row) => row.span.key === current),
  );
  const row = rows[index];
  if (row === undefined) return Option.none();
  const to = (target: number) =>
    Option.some({
      key: rows[Math.min(Math.max(target, 0), rows.length - 1)]?.span.key ?? current,
      expanded,
    });
  const open = expanded.has(row.span.key);
  switch (key) {
    case "ArrowDown":
    case "j":
      return to(index + 1);
    case "ArrowUp":
    case "k":
      return to(index - 1);
    case "Home":
      return to(0);
    case "End":
      return to(rows.length - 1);
    case "ArrowRight":
      if (!row.hasChildren) return to(index);
      return open
        ? to(index + 1)
        : Option.some({ key: row.span.key, expanded: new Set([...expanded, row.span.key]) });
    case "ArrowLeft": {
      if (row.hasChildren && open) {
        return Option.some({
          key: row.span.key,
          expanded: new Set([...expanded].filter((open) => open !== row.span.key)),
        });
      }
      const parent = rows.findLastIndex(
        (candidate, at) => at < index && candidate.depth === row.depth - 1,
      );
      return to(parent === -1 ? index : parent);
    }
    default:
      return Option.none();
  }
};

export const zoomLimit = 10_000;

const steps = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5,
  36e5, 72e5, 108e5, 216e5, 432e5, 864e5, 1728e5,
];

const day = 864e5;

const niceStep = (span: number): number =>
  steps.find((step) => span / step <= 6) ?? Math.ceil(span / 6 / day) * day;

const units: ReadonlyArray<readonly [number, string]> = [
  [day, "d"],
  [36e5, "h"],
  [6e4, "m"],
  [1e3, "s"],
  [1, "ms"],
];

const offsetLabel = (offset: number, step: number): string => {
  if (offset === 0) return "0";
  let rest = Math.round(offset);
  const parts: Array<string> = [];
  for (const [unit, suffix] of units) {
    if (rest >= unit) {
      const count = Math.floor(rest / unit);
      rest -= count * unit;
      parts.push(`${count}${suffix}`);
    }
    if (unit <= step && parts.length > 0) break;
  }
  return parts.join(" ");
};

export const endOf = (span: Span, now: number): number => Option.getOrElse(span.end, () => now);

export interface Axis {
  readonly t0: number;
  readonly span: number;
  readonly ticks: ReadonlyArray<{ readonly at: number; readonly label: string }>;
}

export const axis = (
  root: Span,
  now: number,
  zoom: number,
  window: { readonly from: number; readonly to: number } = { from: 0, to: 1 },
): Axis => {
  const t0 = root.start;
  const t1 = Math.max(
    ...spansOf(root).map((span) =>
      Math.max(endOf(span, now), span._tag === "Wait" ? Option.getOrElse(span.wakeAt, () => 0) : 0),
    ),
  );
  const span = Math.max(t1 - t0, 1) * 1.04;
  const step = niceStep(span / zoom);
  const ticks: Array<{ at: number; label: string }> = [];
  const last = Math.min(span, window.to * span);
  for (
    let offset = Math.max(0, Math.floor((window.from * span) / step) * step);
    offset < last;
    offset += step
  ) {
    ticks.push({ at: t0 + offset, label: offsetLabel(offset, step) });
  }
  return { t0, span, ticks };
};

export const duration = (ms: number): string => {
  const rounded = Math.max(0, Math.round(ms));
  if (rounded < 1000) return `${rounded}ms`;
  const seconds = rounded / 1000;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};
