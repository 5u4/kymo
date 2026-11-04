import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { StatusName, statusName, type ExecutionStatus, type ExecutionSummary } from "kymo/api";

export const Filter = Schema.Struct({
  workflow: Schema.optionalKey(Schema.String),
  status: Schema.optional(
    Schema.UndefinedOr(StatusName).pipe(
      Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
    ),
  ),
  q: Schema.optionalKey(Schema.String),
});
export type Filter = typeof Filter.Type;

export const refine = (
  filter: Filter,
  patch: {
    readonly workflow?: string | undefined;
    readonly status?: StatusName | undefined;
    readonly q?: string | undefined;
  },
): Filter => {
  const next = { ...filter, ...patch };
  return {
    ...(next.workflow ? { workflow: next.workflow } : {}),
    ...(next.status ? { status: next.status } : {}),
    ...(next.q ? { q: next.q } : {}),
  };
};

export const statuses: ReadonlyArray<StatusName> = StatusName.literals;

export type StatusCounts = Readonly<Record<StatusName, number>>;

export const countByStatus = (executions: ReadonlyArray<ExecutionSummary>): StatusCounts => {
  const counts = { running: 0, suspended: 0, succeeded: 0, failed: 0, interrupted: 0 };
  for (const execution of executions) counts[statusName(execution.status)]++;
  return counts;
};

export const matches = (execution: ExecutionSummary, q: string): boolean => {
  const needle = q.trim().toLowerCase();
  const includes = (text: Option.Option<string>) =>
    Option.exists(text, (value) => value.toLowerCase().includes(needle));
  return (
    needle === "" ||
    execution.id.toLowerCase().startsWith(needle) ||
    includes(execution.idempotencyKey) ||
    includes(execution.label)
  );
};

export const lastEntry = (execution: ExecutionSummary): DateTime.Utc =>
  Option.getOrElse(execution.updatedAt, () => execution.startedAt);

export interface Row {
  readonly execution: ExecutionSummary;
  readonly depth: number;
  readonly last: boolean;
  readonly rails: ReadonlyArray<number>;
  readonly hasChildren: boolean;
  readonly parent: Option.Option<ExecutionSummary>;
}

export const nest = (
  visible: ReadonlyArray<ExecutionSummary>,
  all: ReadonlyArray<ExecutionSummary>,
): ReadonlyArray<Row> => {
  const sorted = visible.toSorted(
    (a, b) => DateTime.toEpochMillis(lastEntry(b)) - DateTime.toEpochMillis(lastEntry(a)),
  );
  const shown = new Set(sorted.map((execution) => execution.id));
  const byId = new Map(all.map((execution) => [execution.id, execution]));
  const children = new Map<string, Array<ExecutionSummary>>();
  const roots: Array<ExecutionSummary> = [];
  for (const execution of sorted) {
    const parentId = Option.getOrUndefined(execution.parentId);
    if (parentId !== undefined && shown.has(parentId)) {
      const siblings = children.get(parentId);
      if (siblings === undefined) children.set(parentId, [execution]);
      else siblings.push(execution);
    } else {
      roots.push(execution);
    }
  }
  const rows: Array<Row> = [];
  const walk = (
    execution: ExecutionSummary,
    depth: number,
    last: boolean,
    rails: ReadonlyArray<number>,
  ) => {
    const kids = children.get(execution.id) ?? [];
    rows.push({
      execution,
      depth,
      last,
      rails,
      hasChildren: kids.length > 0,
      parent:
        depth === 0
          ? Option.flatMap(execution.parentId, (id) => Option.fromUndefinedOr(byId.get(id)))
          : Option.none(),
    });
    const kidRails = depth > 0 && !last ? [...rails, depth - 1] : rails;
    kids.forEach((kid, index) => walk(kid, depth + 1, index === kids.length - 1, kidRails));
  };
  for (const root of roots) walk(root, 0, true, []);
  return rows;
};

export type ListState =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Unexecuted"; readonly workflow: string }
  | { readonly _tag: "NoMatch"; readonly scopeTotal: number }
  | { readonly _tag: "Rows"; readonly rows: ReadonlyArray<Row> };

export interface ExecutionsView {
  readonly statusCounts: StatusCounts;
  readonly scopeTotal: number;
  readonly shown: number;
  readonly total: number;
  readonly list: ListState;
}

export const executionsView = (
  executions: ReadonlyArray<ExecutionSummary>,
  filter: Filter,
): ExecutionsView => {
  const scope =
    filter.workflow === undefined
      ? executions
      : executions.filter((execution) => execution.workflow === filter.workflow);
  const visible = scope.filter(
    (execution) =>
      (filter.status === undefined || statusName(execution.status) === filter.status) &&
      matches(execution, filter.q ?? ""),
  );
  const list: ListState =
    executions.length === 0
      ? { _tag: "Empty" }
      : filter.workflow !== undefined && scope.length === 0
        ? { _tag: "Unexecuted", workflow: filter.workflow }
        : visible.length === 0
          ? { _tag: "NoMatch", scopeTotal: scope.length }
          : { _tag: "Rows", rows: nest(visible, executions) };
  return {
    statusCounts: countByStatus(scope),
    scopeTotal: scope.length,
    shown: visible.length,
    total: executions.length,
    list,
  };
};

export interface WorkflowRow {
  readonly name: Option.Option<string>;
  readonly counts: StatusCounts;
  readonly total: number;
}

export const workflowRows = (
  registered: ReadonlyArray<{ readonly name: string }>,
  executions: ReadonlyArray<ExecutionSummary>,
): ReadonlyArray<WorkflowRow> => {
  const names = [
    ...new Set([
      ...registered.map((workflow) => workflow.name),
      ...executions.map((execution) => execution.workflow),
    ]),
  ].toSorted();
  return [
    { name: Option.none(), counts: countByStatus(executions), total: executions.length },
    ...names.map((name) => {
      const scope = executions.filter((execution) => execution.workflow === name);
      return { name: Option.some(name), counts: countByStatus(scope), total: scope.length };
    }),
  ];
};

export const suspendTag = (status: ExecutionStatus): Option.Option<string> => {
  if (status._tag !== "Suspended") return Option.none();
  switch (status.reason._tag) {
    case "Failure":
      return Option.some("SuspendOnFailure");
    case "Deferred":
      return Option.some(Option.getOrElse(status.reason.name, () => "deferred"));
    case "Clock":
      return Option.some("clock");
    case "Child":
      return Option.some("child");
  }
};

export const ago = (now: DateTime.Utc, at: DateTime.Utc): string => {
  const seconds = Math.max(0, Math.floor(Duration.toSeconds(DateTime.distance(at, now))));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
};

export const shortId = (id: string): string => id.slice(0, 8);
