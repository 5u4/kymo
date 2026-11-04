import { Link, useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { statusName, type ExecutionDetail, type ExecutionSummary } from "kymo/api";
import { completeCommand } from "kymo/shell";
import { useState, type ReactNode } from "react";
import { ago, refine, shortId, suspendTag, title } from "./executions-view.ts";
import { StatusGlyph, StatusIcon } from "./glyphs.tsx";
import { ExecutionLink, Note, When } from "./inspector.tsx";
import type { Detail } from "./snapshot.ts";
import { statusColor } from "./status-color.ts";
import { Trace } from "./trace.tsx";
import { duration, isEnded, stopNote, type StopNote } from "./trace-view.ts";
import { Button, Kbd, Pane, Skeleton } from "./ui.tsx";

const Void = ({
  code,
  heading,
  children,
  actions,
}: {
  code: ReactNode;
  heading: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) => (
  <div className="max-w-[620px] px-9 py-14">
    <div className="font-mono text-xs/none font-medium tracking-[.02em]">{code}</div>
    <h3 className="mt-3.5 text-[30px]/[1.12] font-medium tracking-[-0.03em] text-balance">
      {heading}
    </h3>
    <p className="mt-3 max-w-[56ch] text-[13.5px]/[1.6] text-pretty text-fg-3">{children}</p>
    {actions === undefined ? null : (
      <div className="mt-[22px] flex flex-wrap items-center gap-2.5">{actions}</div>
    )}
  </div>
);

const ancestorsOf = (
  execution: ExecutionSummary,
  byId: ReadonlyMap<string, ExecutionSummary>,
): ReadonlyArray<{ readonly id: string; readonly summary: ExecutionSummary | undefined }> => {
  const chain: Array<{ readonly id: string; readonly summary: ExecutionSummary | undefined }> = [];
  let parentId = Option.getOrUndefined(execution.parentId);
  while (parentId !== undefined && chain.length < 8) {
    const summary = byId.get(parentId);
    chain.unshift({ id: parentId, summary });
    parentId = summary === undefined ? undefined : Option.getOrUndefined(summary.parentId);
  }
  return chain;
};

const code = "font-mono text-[11.5px] text-fg";
const strong = "font-medium text-fg";

const StopNoteText = ({
  note,
  detail,
  byId,
  now,
}: {
  note: StopNote;
  detail: ExecutionDetail;
  byId: ReadonlyMap<string, ExecutionSummary>;
  now: DateTime.Utc;
}) => {
  switch (note._tag) {
    case "Failure": {
      const activity = Option.getOrUndefined(note.activity);
      return (
        <>
          SuspendOnFailure parked this execution
          {activity === undefined ? null : (
            <>
              {" "}
              at <b className={strong}>{activity.name}</b>, attempt {activity.attempt}
            </>
          )}
          : <code className={`${code} wrap-anywhere`}>{note.cause}</code>. Fix the cause, then{" "}
          <code className={code}>kymo resume {detail.id}</code> replays the body
          {activity === undefined ? null : (
            <>
              {" "}
              and runs <b className={strong}>{activity.name}</b> again
            </>
          )}
          .
        </>
      );
    }
    case "Deferred": {
      const name = Option.getOrUndefined(note.name);
      return name === undefined ? (
        <>Parked on a DurableDeferred the journal does not name.</>
      ) : (
        <>
          Parked on DurableDeferred <b className={strong}>{name}</b>.{" "}
          <code className={code}>kymo {completeCommand(detail.id, name)}</code> continues it.
        </>
      );
    }
    case "Clock":
      return (
        <>
          Sleeping on DurableClock <b className={strong}>{note.name}</b> until{" "}
          <When at={note.wakeAt} now={now} />.
        </>
      );
    case "Child":
      return (
        <>
          Waiting on child execution <ExecutionLink id={note.executionId} summaries={byId} />.
        </>
      );
    case "Failed":
      return (
        <code className={`${code} wrap-anywhere`}>
          {note.kind}: {note.message}
        </code>
      );
  }
};

const ExecutionHeader = ({
  detail,
  byId,
  now,
}: {
  detail: ExecutionDetail;
  byId: ReadonlyMap<string, ExecutionSummary>;
  now: DateTime.Utc;
}) => {
  const status = statusName(detail.status);
  const heading = title(detail);
  const ended = isEnded(detail.status);
  const tag = Option.getOrUndefined(suspendTag(detail.status));
  const key = Option.getOrUndefined(detail.idempotencyKey);
  const last = Option.getOrElse(detail.updatedAt, () => detail.startedAt);
  const startedMs = DateTime.toEpochMillis(detail.startedAt);
  const note = Option.getOrUndefined(stopNote(detail));
  return (
    <div className="flex-none border-b border-line-soft px-6 pt-[18px] pb-4">
      <nav
        aria-label="Execution path"
        className="flex flex-wrap items-center gap-2 text-[12.5px]/[1.3] text-fg-3"
      >
        {ancestorsOf(detail, byId).map((ancestor) => (
          <span key={ancestor.id} className="contents">
            <Link
              to="/"
              search={(prev) => refine(prev, { exec: ancestor.id })}
              title={ancestor.summary === undefined ? ancestor.id : title(ancestor.summary).text}
              className="mx-[-5px] -my-0.5 inline-flex items-baseline gap-1.5 rounded-[5px] px-[5px] py-0.5 transition-colors duration-140 ease-g hover:bg-hover hover:text-fg"
            >
              {ancestor.summary?.workflow ?? "parent"}
              <span className="font-mono text-[11.5px] text-fg-4">{shortId(ancestor.id)}</span>
            </Link>
            <span aria-hidden="true" className="text-fg-4">
              ›
            </span>
          </span>
        ))}
        <span className="font-medium text-fg-2">{detail.workflow}</span>
      </nav>
      <h3
        className={`mt-2.5 text-[19px]/[1.25] font-medium text-balance wrap-anywhere ${heading.labelled ? "tracking-[-0.018em]" : "font-mono tracking-[-0.03em] text-fg-2"}`}
      >
        {heading.text}
        {heading.labelled && key !== undefined ? (
          <span className="ml-2 font-mono text-[13px] font-normal tracking-normal text-fg-3">
            ({key})
          </span>
        ) : null}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <span
          className={`inline-flex h-6 items-center gap-1.5 rounded-full bg-current/11 pr-2.5 pl-1.5 font-mono text-xs/none font-medium inset-ring inset-ring-current/30 ${statusColor[status]}`}
        >
          <StatusGlyph status={status} className="" />
          <span className="text-fg">{status}</span>
          {tag === undefined ? null : <span className="font-normal text-fg-2">on {tag}</span>}
        </span>
        <span className="font-mono text-xs/none text-fg-3">
          {ended
            ? `ended ${ago(now, last)}`
            : `open for ${duration(DateTime.toEpochMillis(now) - startedMs)}`}
        </span>
        <span title="executionId" className="font-mono text-xs/none text-fg-3">
          {detail.id}
        </span>
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11.5px]/[1.4] text-fg-2">
        <div className="flex gap-1.5">
          <dt className="text-fg-4">started</dt>
          <dd>
            <When at={detail.startedAt} now={now} />
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-fg-4">updated</dt>
          <dd>
            <When at={last} now={now} />
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-fg-4">{ended ? "took" : "elapsed"}</dt>
          <dd>{duration(DateTime.toEpochMillis(ended ? last : now) - startedMs)}</dd>
        </div>
      </dl>
      {note === undefined ? null : (
        <Note>
          <StopNoteText note={note} detail={detail} byId={byId} now={now} />
        </Note>
      )}
    </div>
  );
};

const Candidates = ({
  candidates,
  byId,
}: {
  candidates: ReadonlyArray<string>;
  byId: ReadonlyMap<string, ExecutionSummary>;
}) => (
  <ul aria-label="Matching executions" className="-mt-6 grid max-w-[620px] gap-1 px-9 pb-14">
    {candidates.map((id) => {
      const summary = byId.get(id);
      const status = summary === undefined ? undefined : statusName(summary.status);
      return (
        <li key={id}>
          <Link
            to="/"
            search={(prev) => refine(prev, { exec: id })}
            replace
            className="flex items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] font-mono text-[12.5px]/none text-fg-2 transition-colors duration-140 ease-g hover:bg-hover hover:text-fg"
          >
            {status === undefined ? null : (
              <StatusIcon status={status} className={`size-3.5 ${statusColor[status]}`} />
            )}
            <span>{id}</span>
            {summary === undefined ? null : (
              <span className="font-sans text-fg-3">
                {summary.workflow} · {title(summary).text}
              </span>
            )}
          </Link>
        </li>
      );
    })}
  </ul>
);

export const DetailPane = ({
  detail,
  executions,
  now,
}: {
  detail: Option.Option<Detail>;
  executions: ReadonlyArray<ExecutionSummary>;
  now: DateTime.Utc;
}) => {
  const navigate = useNavigate({ from: "/" });
  const [height, setHeight] = useState<Option.Option<number>>(Option.none());
  const byId = new Map(executions.map((execution) => [execution.id, execution]));
  const selected = Option.getOrUndefined(detail);
  const back = (
    <Button onClick={() => void navigate({ search: (prev) => refine(prev, { exec: undefined }) })}>
      Back to executions
    </Button>
  );
  const scroll = "min-h-0 flex-1 overflow-auto";
  return (
    <Pane
      id="detail-title"
      title="Execution"
      count={selected?._tag === "Loaded" ? shortId(selected.detail.id) : ""}
      className="bg-panel"
    >
      {selected === undefined ? (
        <div className={scroll}>
          {executions.length === 0 ? (
            <Void
              code={<span className="text-fg-3">executions[0]</span>}
              heading="Nothing has run yet."
            >
              kymo draws what the engine journals. Run{" "}
              <code className="font-mono text-[12.5px] text-fg">
                kymo execute &lt;workflow&gt; &lt;payload&gt;
              </code>{" "}
              and its activities, waits and children trace across this pane.
            </Void>
          ) : (
            <Void
              code={<span className="text-fg-3">no selection</span>}
              heading="Pick an execution."
            >
              Move with <Kbd>j</Kbd> <Kbd>k</Kbd> through the executions or click one; its trace
              opens here.
            </Void>
          )}
        </div>
      ) : selected._tag === "NotFound" ? (
        <div className={scroll}>
          <Void
            code={<span className="text-fail">error: not_found</span>}
            heading={
              <>
                No execution <span className="font-mono tracking-[-0.04em]">{selected.id}</span> in
                this journal.
              </>
            }
            actions={back}
          >
            executionIds derive from the workflow name and its idempotencyKey. An id from another
            kymo root, or from a database that was reset, won't resolve here.
          </Void>
        </div>
      ) : selected._tag === "Ambiguous" ? (
        <div className={scroll}>
          <Void
            code={<span className="text-sus">error: ambiguous_id</span>}
            heading={
              <>
                <span className="font-mono tracking-[-0.04em]">{selected.id}</span> matches{" "}
                {selected.candidates.length} executions.
              </>
            }
            actions={back}
          >
            Pick one of them, or use a longer id prefix.
          </Void>
          <Candidates candidates={selected.candidates} byId={byId} />
        </div>
      ) : (
        <article
          aria-label={`Execution ${selected.detail.id}`}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <ExecutionHeader detail={selected.detail} byId={byId} now={now} />
          <Trace
            key={selected.detail.id}
            detail={selected.detail}
            summaries={byId}
            now={now}
            height={height}
            onResize={(next) => setHeight(Option.some(next))}
          />
        </article>
      )}
    </Pane>
  );
};

export const DetailPaneSkeleton = () => (
  <Pane id="detail-title" title="Execution" count="" className="bg-panel">
    <div
      aria-busy="true"
      aria-label="Loading execution"
      className="grid content-start gap-4 px-6 py-[18px]"
    >
      <Skeleton className="h-2.5 w-[120px] rounded-sm" />
      <Skeleton className="h-6 w-[min(440px,80%)] rounded-sm" />
      <Skeleton className="h-[22px] w-[150px] rounded-full" />
      <div aria-hidden="true" className="mt-4 grid gap-3">
        {["w-[57%]", "w-[66%]", "w-[75%]", "w-[84%]", "w-[93%]"].map((width) => (
          <div key={width} className="grid grid-cols-[16px_150px_1fr] items-center gap-2.5">
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className={`h-2.5 rounded-sm ${width}`} />
            <Skeleton className="h-1.5 w-[40%] rounded-sm" />
          </div>
        ))}
      </div>
    </div>
  </Pane>
);
