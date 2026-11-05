import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  statusName,
  type ExecutionDetail,
  type ActivityRun,
  type ExecutionSummary,
  type LogLevel,
} from "kymo/api";
import { completeCommand, kymoCommand, shellArg } from "kymo/shell";
import type { ReactNode } from "react";
import { ago, coarse, refine, shortId, suspendTag } from "./executions-view.ts";
import { Glyph, SpanIcon, StatusIcon } from "./glyphs.tsx";
import {
  levelFilters,
  logsView,
  type LevelFilter,
  type LogLine,
  type LogOrigin,
  type LogsView,
} from "./log-view.ts";
import type { Logs } from "./snapshot.ts";
import { statusColor } from "./status-color.ts";
import {
  duration,
  isEnded,
  spanName,
  waitKind,
  type ActivitySpan,
  type AttemptSpan,
  type ChildSpan,
  type ExecutionSpan,
  type Span,
  type WaitSpan,
} from "./trace-view.ts";

const prettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json, { space: 2 }));

const muted = "text-fg-4";

export const When = ({ at, now }: { at: DateTime.Utc; now: DateTime.Utc }) => {
  const iso = DateTime.formatIso(at);
  const today = iso.slice(0, 10) === DateTime.formatIso(now).slice(0, 10);
  return (
    <>
      <time dateTime={iso} title={iso}>
        {today ? `${iso.slice(11, 23)}Z` : `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`}
      </time>{" "}
      <span className={muted}>
        {DateTime.isGreaterThan(at, now) ? `in ${coarse(now, at)}` : ago(now, at)}
      </span>
    </>
  );
};

export const ExecutionLink = ({
  id,
  summaries,
}: {
  id: string;
  summaries: ReadonlyMap<string, ExecutionSummary>;
}) => {
  const workflow = summaries.get(id)?.workflow;
  return (
    <Link
      to="/"
      search={(prev) => refine(prev, { exec: id })}
      className="font-mono underline decoration-line-strong underline-offset-3 transition-[text-decoration-color] duration-140 ease-g hover:decoration-fg"
    >
      {shortId(id)}
      {workflow === undefined ? null : (
        <span className="ml-1.5 font-sans text-fg-3">{workflow}</span>
      )}
    </Link>
  );
};

const Pairs = ({ children }: { children: ReactNode }) => (
  <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[22px] gap-y-[7px] font-mono text-[12.5px]/[1.45]">
    {children}
  </dl>
);

const Pair = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="contents">
    <dt className="text-fg-3">{term}</dt>
    <dd className="wrap-anywhere text-fg">{children}</dd>
  </div>
);

export const Note = ({ children }: { children: ReactNode }) => (
  <p className="mt-3.5 rounded-[10px] bg-canvas px-3.5 py-3 text-[12.5px]/[1.55] text-pretty text-fg-2 inset-ring inset-ring-line-soft">
    {children}
  </p>
);

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const ExecutionOverview = ({
  detail,
  summaries,
  now,
}: {
  detail: ExecutionDetail;
  summaries: ReadonlyMap<string, ExecutionSummary>;
  now: DateTime.Utc;
}) => {
  const { status } = detail;
  const name = statusName(status);
  const ended = isEnded(status);
  const tag = Option.getOrUndefined(suspendTag(status));
  const label = Option.getOrUndefined(detail.label);
  const key = Option.getOrUndefined(detail.idempotencyKey);
  const parent = Option.getOrUndefined(detail.parentId);
  const updated = Option.getOrUndefined(detail.updatedAt);
  const activities = new Set(detail.activities.map((run) => run.name)).size;
  return (
    <Pairs>
      <Pair term="status">
        <span className={statusColor[name]}>{name}</span>
        {tag === undefined ? null : <span className={muted}> on {tag}</span>}
      </Pair>
      {status._tag === "Failed" ? (
        <Pair term="failure">
          {status.kind}: {status.message}
        </Pair>
      ) : null}
      {status._tag === "Suspended" && status.reason._tag === "Failure" ? (
        <Pair term="cause">{status.reason.cause}</Pair>
      ) : null}
      <Pair term="label">{label ?? <span className={muted}>none</span>}</Pair>
      <Pair term="executionId">{detail.id}</Pair>
      <Pair term="idempotencyKey">{key ?? <span className={muted}>none</span>}</Pair>
      <Pair term="workflow">{detail.workflow}</Pair>
      {parent === undefined ? null : (
        <Pair term="parent">
          <ExecutionLink id={parent} summaries={summaries} />
        </Pair>
      )}
      {detail.children.length === 0 ? null : (
        <Pair term="children">
          <span className="flex flex-wrap gap-x-3.5 gap-y-1">
            {detail.children.map((id) => (
              <ExecutionLink key={id} id={id} summaries={summaries} />
            ))}
          </span>
        </Pair>
      )}
      <Pair term="started">
        <When at={detail.startedAt} now={now} />
      </Pair>
      {updated === undefined ? null : (
        <Pair term={ended ? "ended" : "updated"}>
          <When at={updated} now={now} />
        </Pair>
      )}
      <Pair term={ended ? "took" : "elapsed"}>
        {duration(
          DateTime.toEpochMillis(ended ? (updated ?? detail.startedAt) : now) -
            DateTime.toEpochMillis(detail.startedAt),
        )}
      </Pair>
      <Pair term="journal">
        {[
          plural(detail.activities.length, "attempt", "attempts"),
          plural(activities, "activity", "activities"),
          plural(detail.waits.length, "open wait", "open waits"),
          plural(detail.children.length, "child", "children"),
        ].join(" · ")}
      </Pair>
    </Pairs>
  );
};

const levelLabel: Record<LogLevel, string> = {
  Trace: "TRACE",
  Debug: "DEBUG",
  Info: "INFO",
  Warn: "WARN",
  Error: "ERROR",
  Fatal: "FATAL",
};

const levelColor: Record<LogLevel, string> = {
  Trace: "text-fg-4",
  Debug: "text-fg-4",
  Info: "text-fg-3",
  Warn: "text-sus",
  Error: "text-fail",
  Fatal: "text-fail",
};

const filterLabel: Record<LevelFilter, string> = { all: "all", warn: "warn+", error: "error+" };

const Source = ({ origin, onSelect }: { origin: LogOrigin; onSelect: (key: string) => void }) => {
  if (origin._tag === "Body") return <span className="text-fg-4">body</span>;
  const attempt = Option.getOrUndefined(origin.attempt);
  const label = (
    <>
      {origin.name}
      {attempt === undefined ? null : <span className="ml-1 text-fg-4">#{attempt}</span>}
    </>
  );
  const key = Option.getOrUndefined(origin.key);
  const name = attempt === undefined ? origin.name : `${origin.name}#${attempt}`;
  return key === undefined ? (
    <span title={name} className="truncate text-fg-2">
      {label}
    </span>
  ) : (
    <button
      type="button"
      title={name}
      onClick={() => onSelect(key)}
      className="max-w-full justify-self-start truncate text-left text-fg-2 underline decoration-line-strong underline-offset-3 transition-[text-decoration-color] duration-140 ease-g hover:decoration-fg"
    >
      {label}
    </button>
  );
};

const LogRow = ({
  line,
  columns,
  showPass,
  onSelect,
}: {
  line: LogLine;
  columns: string;
  showPass: boolean;
  onSelect: (key: string) => void;
}) => {
  const { entry, origin } = line;
  const iso = DateTime.formatIso(entry.at);
  const cause = Option.getOrUndefined(entry.cause);
  const severe = entry.level === "Error" || entry.level === "Fatal";
  const loud = severe || entry.level === "Warn";
  return (
    <div
      style={{ gridTemplateColumns: columns }}
      className={`-mx-2 grid items-baseline gap-x-3 border-b border-line-soft px-2 py-1.5 ${severe ? "bg-[color-mix(in_oklch,var(--color-fail)_6%,transparent)]" : ""}`}
    >
      <time dateTime={iso} title={iso} className="text-fg-4">
        {iso.slice(11, 23)}
      </time>
      <span className={`text-[10.5px] tracking-[.02em] ${levelColor[entry.level]}`}>
        {levelLabel[entry.level]}
      </span>
      {showPass ? (
        <span title={`body pass ${entry.pass}`} className="text-[10.5px] text-fg-4">
          p{entry.pass}
        </span>
      ) : null}
      {Option.isSome(origin) ? <Source origin={origin.value} onSelect={onSelect} /> : null}
      <span
        className={`min-w-0 wrap-anywhere whitespace-pre-wrap ${loud ? "text-fg" : "text-fg-2"}`}
      >
        {entry.message}
      </span>
      {cause === undefined ? null : (
        <details className="col-span-full mt-1">
          <summary className="w-max cursor-pointer text-[11px] text-fg-3 transition-colors duration-140 ease-g hover:text-fg">
            cause
          </summary>
          <pre className="mt-1 overflow-x-auto text-[11.5px]/[1.5] text-fg-2">{cause}</pre>
        </details>
      )}
    </div>
  );
};

const LogsPanel = ({
  view,
  attempts,
  logs,
  executionId,
  rootFlag,
  level,
  onLevel,
  onSelect,
}: {
  view: LogsView;
  attempts: ReadonlyArray<ActivityRun>;
  logs: Logs;
  executionId: string;
  rootFlag: string | undefined;
  level: LevelFilter;
  onLevel: (level: LevelFilter) => void;
  onSelect: (key: string) => void;
}) => {
  const fullCommand = (
    <code className="font-mono text-[11.5px] text-fg">
      {kymoCommand(rootFlag, `execution ${shellArg(executionId)} --logs --full`)}
    </code>
  );
  if (view.count === 0) {
    return (
      <p className="text-[12.5px]/[1.55] text-fg-3">
        No logs. <code className="font-mono text-[11.5px]">Effect.log</code> calls inside{" "}
        {view.scope._tag === "Execution" ? "the workflow and its activities" : "this Activity"} show
        up here.
      </p>
    );
  }
  const older = view.groups.length === 0 && view.counts[level] > 0;
  const source = view.scope._tag === "Execution";
  const columns = [
    "90px 42px",
    view.showPass ? "max-content" : "",
    source ? "minmax(0,140px)" : "",
    "minmax(0,1fr)",
  ]
    .filter((column) => column !== "")
    .join(" ");
  return (
    <>
      <fieldset aria-label="Minimum level" className="flex gap-1">
        {levelFilters.map((filter) => (
          <button
            key={filter}
            type="button"
            aria-pressed={level === filter}
            onClick={() => onLevel(filter)}
            className={`h-6 rounded-md px-[9px] font-mono text-[11.5px]/none transition-colors duration-140 ease-g ${level === filter ? "bg-sel text-fg inset-ring inset-ring-line" : "text-fg-3 inset-ring inset-ring-line-soft hover:text-fg"}`}
          >
            {filterLabel[filter]}
            <b className="ml-[3px] font-normal text-fg-4">{view.counts[filter]}</b>
          </button>
        ))}
      </fieldset>
      {!older && view.fetched < view.count ? (
        <Note>
          Showing the last {view.fetched} of {view.count} lines. All lines: {fullCommand}
        </Note>
      ) : null}
      <div className="mt-3 font-mono text-xs/normal">
        {older ? (
          <p className="font-sans text-[12.5px]/[1.55] text-fg-3">
            Its {plural(view.counts[level], "line is", "lines are")} older than the last{" "}
            {logs.entries.length} fetched. {fullCommand}
          </p>
        ) : view.groups.length === 0 ? (
          <p className="font-sans text-[12.5px]/[1.55] text-fg-3">Nothing at this level.</p>
        ) : (
          view.groups.map((group, index) => {
            const attempt = Option.getOrUndefined(group.attempt);
            const run = attempts.find((candidate) => candidate.attempt === attempt);
            const status = run === undefined ? undefined : statusName(run.status);
            return (
              <div key={attempt ?? "all"}>
                {attempt === undefined ? null : (
                  <div
                    className={`mb-1 flex items-center gap-1.5 font-sans text-[11.5px]/none text-fg-3 ${index === 0 ? "" : "mt-3.5"}`}
                  >
                    {status === undefined ? null : (
                      <StatusIcon status={status} className={`size-3.5 ${statusColor[status]}`} />
                    )}
                    attempt {attempt}
                  </div>
                )}
                {group.lines.map((line) => (
                  <LogRow
                    key={line.entry.seq}
                    line={line}
                    columns={columns}
                    showPass={view.showPass}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>
    </>
  );
};

const ActivityInspector = ({
  span,
  activity,
  now,
  onSelect,
}: {
  span: ActivitySpan | AttemptSpan;
  activity: ActivitySpan;
  now: DateTime.Utc;
  onSelect: (key: string) => void;
}) => {
  const run = span._tag === "Attempt" ? span.run : activity.attempts.at(-1);
  const first = span._tag === "Attempt" ? span.run : activity.attempts[0];
  if (run === undefined || first === undefined) return null;
  const status = statusName(run.status);
  const ended = Option.getOrUndefined(run.endedAt);
  const runFor = (startedAt: DateTime.Utc, endedAt: Option.Option<DateTime.Utc>) =>
    duration(
      DateTime.toEpochMillis(Option.getOrElse(endedAt, () => now)) -
        DateTime.toEpochMillis(startedAt),
    );
  return (
    <>
      <Pairs>
        <Pair term="status">
          <span className={statusColor[status]}>{status}</span>
        </Pair>
        <Pair term="Activity">{activity.name}</Pair>
        {span._tag === "Attempt" ? (
          <Pair term="attempt">
            {span.run.attempt} <span className={muted}>of {span.of}</span>
          </Pair>
        ) : (
          <Pair term="attempts">{activity.attempts.length}</Pair>
        )}
        {run.status._tag === "Failed" ? (
          <Pair term="failure">
            {run.status.kind}: {run.status.message}
          </Pair>
        ) : null}
        <Pair term="started">
          <When at={first.startedAt} now={now} />
        </Pair>
        {ended === undefined ? null : (
          <Pair term="ended">
            <When at={ended} now={now} />
          </Pair>
        )}
        <Pair term={ended === undefined ? "running for" : "took"}>
          {runFor(first.startedAt, run.endedAt)}
        </Pair>
      </Pairs>
      {activity.attempts.length > 1 ? (
        <div className="mt-[18px] grid gap-0.5">
          <div className="mb-1.5 text-[11.5px]/none text-fg-3">Attempts</div>
          {activity.attempts.map((attempt) => {
            const attemptStatus = statusName(attempt.status);
            const current = span._tag === "Attempt" && span.run.attempt === attempt.attempt;
            return (
              <button
                key={attempt.attempt}
                type="button"
                aria-current={current ? "true" : undefined}
                onClick={() => onSelect(`${activity.key}/${attempt.attempt}`)}
                className={`grid grid-cols-[16px_76px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[7px] px-2 py-[7px] text-left font-mono text-xs/[1.2] transition-colors duration-140 ease-g ${current ? "bg-sel text-fg" : "text-fg-2 hover:bg-hover hover:text-fg"}`}
              >
                <StatusIcon
                  status={attemptStatus}
                  className={`size-3.5 ${statusColor[attemptStatus]}`}
                />
                <span>attempt {attempt.attempt}</span>
                <span className="truncate">
                  {attempt.status._tag === "Failed" ? attempt.status.message : attemptStatus}
                </span>
                <span className="text-fg-3">{runFor(attempt.startedAt, attempt.endedAt)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
};

const WaitInspector = ({
  span,
  detail,
  now,
  rootFlag,
}: {
  span: WaitSpan;
  detail: ExecutionDetail;
  now: DateTime.Utc;
  rootFlag: string | undefined;
}) => {
  const { wait } = span;
  const wakeAt = Option.getOrUndefined(Option.map(span.wakeAt, DateTime.makeUnsafe));
  return (
    <>
      <Pairs>
        <Pair term="status">
          <span className={wait.kind === "Clock" ? "text-clock" : "text-sus"}>waiting</span>
        </Pair>
        <Pair term="kind">{waitKind[wait.kind]}</Pair>
        <Pair term="name">{wait.name}</Pair>
        <Pair term="since">
          <When at={wait.since} now={now} />
        </Pair>
        <Pair term="waited">{coarse(wait.since, now)}</Pair>
        {wakeAt === undefined ? null : (
          <Pair term="wakes at">
            <When at={wakeAt} now={now} />
          </Pair>
        )}
      </Pairs>
      {wait.kind === "Deferred" ? (
        <Note>
          The execution waits until something completes this deferred. From the CLI:{" "}
          <code className="font-mono text-[11.5px] text-fg">
            {kymoCommand(rootFlag, completeCommand(detail.id, wait.name))}
          </code>
        </Note>
      ) : (
        <Note>The engine wakes the execution when the clock fires.</Note>
      )}
    </>
  );
};

const ChildInspector = ({ span, now }: { span: ChildSpan; now: DateTime.Utc }) => {
  const summary = Option.getOrUndefined(span.summary);
  if (summary === undefined) {
    return (
      <>
        <Pairs>
          <Pair term="executionId">{span.id}</Pair>
        </Pairs>
        <Note>This child is not in the journal kymo can read.</Note>
      </>
    );
  }
  const status = statusName(summary.status);
  const ended = isEnded(summary.status);
  const label = Option.getOrUndefined(summary.label);
  const key = Option.getOrUndefined(summary.idempotencyKey);
  return (
    <>
      <Pairs>
        <Pair term="workflow">{summary.workflow}</Pair>
        {label === undefined ? null : <Pair term="label">{label}</Pair>}
        <Pair term="idempotencyKey">{key ?? <span className={muted}>none</span>}</Pair>
        <Pair term="executionId">{summary.id}</Pair>
        <Pair term="status">
          <span className={statusColor[status]}>{status}</span>
        </Pair>
        <Pair term="started">
          <When at={summary.startedAt} now={now} />
        </Pair>
        <Pair term={ended ? "took" : "elapsed"}>
          {duration(
            DateTime.toEpochMillis(
              ended ? Option.getOrElse(summary.updatedAt, () => summary.startedAt) : now,
            ) - DateTime.toEpochMillis(summary.startedAt),
          )}
        </Pair>
      </Pairs>
      <Link
        to="/"
        search={(prev) => refine(prev, { exec: summary.id })}
        className="mt-4 inline-flex h-8 items-center gap-2 rounded-lg bg-raised px-3 text-[12.5px]/none font-medium shadow-[0_1px_0_oklch(0_0_0/.25)] inset-ring inset-ring-line transition-[background-color,box-shadow] duration-140 ease-g hover:bg-hover hover:inset-ring-line-strong active:scale-96"
      >
        <Glyph name="child" className="size-3.5" />
        Open {shortId(summary.id)}
      </Link>
    </>
  );
};

const kinds: Record<Exclude<Span["_tag"], "Wait">, string> = {
  Execution: "Execution",
  Activity: "Activity",
  Attempt: "Activity attempt",
  Child: "child execution",
};

export type InspectorTab = "Overview" | "Payload" | "Logs";

export const Inspector = ({
  span,
  root,
  summaries,
  now,
  rootFlag,
  logs,
  tab,
  level,
  onTab,
  onLevel,
  onSelect,
}: {
  span: Span;
  root: ExecutionSpan;
  summaries: ReadonlyMap<string, ExecutionSummary>;
  now: DateTime.Utc;
  rootFlag: string | undefined;
  logs: Logs;
  tab: InspectorTab;
  level: LevelFilter;
  onTab: (tab: InspectorTab) => void;
  onLevel: (level: LevelFilter) => void;
  onSelect: (key: string) => void;
}) => {
  const view = logsView(span, root, logs, level);
  const tabs: ReadonlyArray<InspectorTab> = [
    "Overview",
    ...(span._tag === "Execution" ? (["Payload"] as const) : []),
    ...(Option.isSome(view) ? (["Logs"] as const) : []),
  ];
  const shown = tabs.includes(tab) ? tab : "Overview";
  const activity =
    span._tag === "Activity"
      ? span
      : span._tag === "Attempt"
        ? root.children.find(
            (candidate): candidate is ActivitySpan =>
              candidate._tag === "Activity" && candidate.name === span.run.name,
          )
        : undefined;
  const overview =
    span._tag === "Execution" ? (
      <ExecutionOverview detail={span.detail} summaries={summaries} now={now} />
    ) : span._tag === "Activity" || span._tag === "Attempt" ? (
      activity === undefined ? null : (
        <ActivityInspector span={span} activity={activity} now={now} onSelect={onSelect} />
      )
    ) : span._tag === "Wait" ? (
      <WaitInspector span={span} detail={root.detail} now={now} rootFlag={rootFlag} />
    ) : (
      <ChildInspector span={span} now={now} />
    );
  const kind = span._tag === "Wait" ? waitKind[span.wait.kind] : kinds[span._tag];
  return (
    <>
      <div
        className={`sticky top-0 z-2 border-b border-line-soft bg-panel px-6 pt-3.5 ${tabs.length > 1 ? "" : "pb-3"}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <SpanIcon span={span} />
          <span className="truncate text-sm/[1.3] font-medium">{spanName(span)}</span>
          <span className="font-mono text-[11px]/none whitespace-nowrap text-fg-3">{kind}</span>
        </div>
        {tabs.length > 1 ? (
          <div role="tablist" aria-label={kind} className="mt-2 flex gap-[18px]">
            {tabs.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                id={`inspector-tab-${name}`}
                aria-selected={shown === name}
                aria-controls="inspector-panel"
                onClick={() => onTab(name)}
                className={`-mb-px border-b-2 pt-1.5 pb-[9px] text-[12.5px]/none font-medium transition-colors duration-140 ease-g ${shown === name ? "border-fg text-fg" : "border-transparent text-fg-3 hover:text-fg-2"}`}
              >
                {name}
                {name === "Logs" && Option.isSome(view) && view.value.count > 0 ? (
                  <span
                    className={`ml-[5px] font-mono text-[11px]/none font-normal ${view.value.hasError ? "text-fail" : "text-fg-4"}`}
                  >
                    {view.value.count}
                    {view.value.hasError ? <span className="sr-only"> with errors</span> : null}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div
        id="inspector-panel"
        role={tabs.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={tabs.length > 1 ? `inspector-tab-${shown}` : undefined}
        className="max-w-[780px] px-6 pt-4 pb-7"
      >
        {shown === "Logs" && Option.isSome(view) ? (
          <LogsPanel
            view={view.value}
            attempts={span._tag === "Activity" ? span.attempts : []}
            logs={logs}
            executionId={root.detail.id}
            rootFlag={rootFlag}
            level={level}
            onLevel={onLevel}
            onSelect={onSelect}
          />
        ) : shown === "Payload" ? (
          <pre className="overflow-x-auto font-mono text-xs/[1.6] text-fg-2">
            {prettyJson(root.detail.payload)}
          </pre>
        ) : (
          overview
        )}
      </div>
    </>
  );
};
