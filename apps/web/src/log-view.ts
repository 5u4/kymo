import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { LogEntry, LogLevel, LogSource } from "kymo/api";
import type { ActivitySpan, ExecutionSpan, Span } from "./trace-view.ts";

export type LogScope =
  | { readonly _tag: "Execution" }
  | { readonly _tag: "Activity"; readonly name: string; readonly byAttempt: boolean }
  | { readonly _tag: "Attempt"; readonly name: string; readonly attempt: number };

export type LevelFilter = "all" | "warn" | "error";

export const levelFilters: ReadonlyArray<LevelFilter> = ["all", "warn", "error"];

const rank: Record<LogLevel, number> = {
  Trace: 0,
  Debug: 1,
  Info: 2,
  Warn: 3,
  Error: 4,
  Fatal: 5,
};

const floor: Record<LevelFilter, number> = { all: rank.Trace, warn: rank.Warn, error: rank.Error };

export type LogOrigin =
  | { readonly _tag: "Body" }
  | {
      readonly _tag: "Activity";
      readonly name: string;
      readonly attempt: Option.Option<number>;
      readonly key: Option.Option<string>;
    };

export interface LogLine {
  readonly entry: LogEntry;
  readonly origin: Option.Option<LogOrigin>;
}

export interface LogGroup {
  readonly attempt: Option.Option<number>;
  readonly lines: ReadonlyArray<LogLine>;
}

export interface LogsView {
  readonly scope: LogScope;
  readonly count: number;
  readonly hasError: boolean;
  readonly counts: Record<LevelFilter, number>;
  readonly showPass: boolean;
  readonly groups: ReadonlyArray<LogGroup>;
}

export interface LogMark {
  readonly seq: number;
  readonly at: number;
  readonly level: LogLevel;
}

const scopeOf = (span: Span): Option.Option<LogScope> => {
  switch (span._tag) {
    case "Execution":
      return Option.some({ _tag: "Execution" });
    case "Activity":
      return Option.some({
        _tag: "Activity",
        name: span.name,
        byAttempt: span.attempts.length > 1,
      });
    case "Attempt":
      return Option.some({ _tag: "Attempt", name: span.run.name, attempt: span.run.attempt });
    case "Wait":
    case "Child":
      return Option.none();
  }
};

const inScope = (scope: LogScope, entries: ReadonlyArray<LogEntry>): ReadonlyArray<LogEntry> =>
  scope._tag === "Execution"
    ? entries
    : entries.filter(
        ({ source }) =>
          source._tag === "Activity" &&
          source.name === scope.name &&
          (scope._tag === "Activity" || source.attempt === scope.attempt),
      );

const atLevel = (filter: LevelFilter, entries: ReadonlyArray<LogEntry>) =>
  entries.filter((entry) => rank[entry.level] >= floor[filter]);

const originOf = (root: ExecutionSpan, source: LogSource): LogOrigin => {
  if (source._tag === "Body") return source;
  const activity = root.children.find(
    (span): span is ActivitySpan => span._tag === "Activity" && span.name === source.name,
  );
  if (activity === undefined) {
    return {
      _tag: "Activity",
      name: source.name,
      attempt: Option.some(source.attempt),
      key: Option.none(),
    };
  }
  if (activity.attempts.length === 1 && activity.attempts[0]?.attempt === source.attempt) {
    return {
      _tag: "Activity",
      name: source.name,
      attempt: Option.none(),
      key: Option.some(activity.key),
    };
  }
  return {
    _tag: "Activity",
    name: source.name,
    attempt: Option.some(source.attempt),
    key: Option.fromUndefinedOr(
      activity.children.find(
        (span) => span._tag === "Attempt" && span.run.attempt === source.attempt,
      )?.key,
    ),
  };
};

const groupsOf = (scope: LogScope, lines: ReadonlyArray<LogLine>): ReadonlyArray<LogGroup> => {
  if (lines.length === 0) return [];
  if (scope._tag !== "Activity" || !scope.byAttempt) return [{ attempt: Option.none(), lines }];
  return [
    ...Map.groupBy(lines, ({ entry }) =>
      entry.source._tag === "Activity" ? entry.source.attempt : 0,
    ),
  ].map(([attempt, group]) => ({ attempt: Option.some(attempt), lines: group }));
};

export const logsView = (
  span: Span,
  root: ExecutionSpan,
  entries: ReadonlyArray<LogEntry>,
  filter: LevelFilter,
): Option.Option<LogsView> =>
  Option.map(scopeOf(span), (scope) => {
    const scoped = inScope(scope, entries);
    const shown = atLevel(filter, scoped);
    const lines = shown.map((entry) => ({
      entry,
      origin:
        scope._tag === "Execution" ? Option.some(originOf(root, entry.source)) : Option.none(),
    }));
    return {
      scope,
      count: scoped.length,
      hasError: scoped.some((entry) => rank[entry.level] >= rank.Error),
      counts: {
        all: scoped.length,
        warn: atLevel("warn", scoped).length,
        error: atLevel("error", scoped).length,
      },
      showPass: new Set(shown.map((entry) => entry.pass)).size > 1,
      groups: groupsOf(scope, lines),
    };
  });

export const logMarks = (span: Span, entries: ReadonlyArray<LogEntry>): ReadonlyArray<LogMark> =>
  Option.match(scopeOf(span), {
    onNone: () => [],
    onSome: (scope) =>
      scope._tag === "Execution"
        ? []
        : atLevel("warn", inScope(scope, entries)).map((entry) => ({
            seq: entry.seq,
            at: DateTime.toEpochMillis(entry.at),
            level: entry.level,
          })),
  });
