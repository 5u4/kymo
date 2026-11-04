import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { statusName, type ExecutionDetail, type ExecutionSummary } from "kymo/api";
import { completeCommand, kymoCommand } from "kymo/shell";
import { useState, type ReactNode } from "react";
import { ago, coarse, refine, shortId, suspendTag } from "./executions-view.ts";
import { Glyph, SpanIcon, StatusIcon } from "./glyphs.tsx";
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

const tabs = ["Overview", "Payload"] as const;

const ExecutionInspector = ({
  detail,
  summaries,
  now,
  header,
}: {
  detail: ExecutionDetail;
  summaries: ReadonlyMap<string, ExecutionSummary>;
  now: DateTime.Utc;
  header: ReactNode;
}) => {
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  return (
    <>
      <div className="sticky top-0 z-2 border-b border-line-soft bg-panel px-6 pt-3.5">
        {header}
        <div role="tablist" aria-label="Execution" className="mt-2 flex gap-[18px]">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`inspector-tab-${name}`}
              aria-selected={tab === name}
              aria-controls="inspector-panel"
              onClick={() => setTab(name)}
              className={`-mb-px border-b-2 pt-1.5 pb-[9px] text-[12.5px]/none font-medium transition-colors duration-140 ease-g ${tab === name ? "border-fg text-fg" : "border-transparent text-fg-3 hover:text-fg-2"}`}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div
        id="inspector-panel"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${tab}`}
        className="max-w-[780px] px-6 pt-4 pb-7"
      >
        {tab === "Overview" ? (
          <ExecutionOverview detail={detail} summaries={summaries} now={now} />
        ) : (
          <pre className="overflow-x-auto font-mono text-xs/[1.6] text-fg-2">
            {prettyJson(detail.payload)}
          </pre>
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

export const Inspector = ({
  span,
  root,
  summaries,
  now,
  rootFlag,
  onSelect,
}: {
  span: Span;
  root: ExecutionSpan;
  summaries: ReadonlyMap<string, ExecutionSummary>;
  now: DateTime.Utc;
  rootFlag: string | undefined;
  onSelect: (key: string) => void;
}) => {
  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <SpanIcon span={span} />
      <span className="truncate text-sm/[1.3] font-medium">{spanName(span)}</span>
      <span className="font-mono text-[11px]/none whitespace-nowrap text-fg-3">
        {span._tag === "Wait" ? waitKind[span.wait.kind] : kinds[span._tag]}
      </span>
    </div>
  );
  if (span._tag === "Execution") {
    return (
      <ExecutionInspector detail={span.detail} summaries={summaries} now={now} header={header} />
    );
  }
  const activity =
    span._tag === "Attempt"
      ? root.children.find(
          (candidate): candidate is ActivitySpan =>
            candidate._tag === "Activity" && candidate.name === span.run.name,
        )
      : undefined;
  return (
    <>
      <div className="sticky top-0 z-2 border-b border-line-soft bg-panel px-6 pt-3.5 pb-3">
        {header}
      </div>
      <div className="max-w-[780px] px-6 pt-4 pb-7">
        {span._tag === "Activity" ? (
          <ActivityInspector span={span} activity={span} now={now} onSelect={onSelect} />
        ) : span._tag === "Attempt" ? (
          activity === undefined ? null : (
            <ActivityInspector span={span} activity={activity} now={now} onSelect={onSelect} />
          )
        ) : span._tag === "Wait" ? (
          <WaitInspector span={span} detail={root.detail} now={now} rootFlag={rootFlag} />
        ) : (
          <ChildInspector span={span} now={now} />
        )}
      </div>
    </>
  );
};
