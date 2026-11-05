import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  actionsFor,
  statusName,
  type ExecutionAction,
  type ExecutionDetail,
  type ExecutionSummary,
} from "kymo/api";
import { completeCommand, kymoCommand } from "kymo/shell";
import { useRef, useState, type ReactNode } from "react";
import {
  ActionState,
  phase,
  requestAction,
  unfinishedChildren,
  type ActionRequest,
  type Actions,
} from "./actions.ts";
import { ActionAlert } from "./action-alert.tsx";
import { ago, refine, shortId, suspendTag, title } from "./executions-view.ts";
import { StatusGlyph, StatusIcon } from "./glyphs.tsx";
import { ExecutionLink, Note, When } from "./inspector.tsx";
import type { Detail, Logs } from "./snapshot.ts";
import { statusColor } from "./status-color.ts";
import { Trace } from "./trace.tsx";
import { duration, isEnded, stopNote, type StopNote } from "./trace-view.ts";
import { useMountEffect } from "./use-mount-effect.ts";
import { Button, Kbd, Pane, Skeleton, Spinner } from "./ui.tsx";

const decodeJson = Schema.decodeResult(Schema.fromJsonString(Schema.Json));

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
  rootFlag,
}: {
  note: StopNote;
  detail: ExecutionDetail;
  byId: ReadonlyMap<string, ExecutionSummary>;
  now: DateTime.Utc;
  rootFlag: string | undefined;
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
          <code className={code}>{kymoCommand(rootFlag, `resume ${detail.id}`)}</code> replays the
          body
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
          <code className={code}>{kymoCommand(rootFlag, completeCommand(detail.id, name))}</code>{" "}
          continues it.
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

const EscapeCancels = ({ onCancel }: { onCancel: () => void }) => {
  useMountEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  });
  return null;
};

const InterruptConfirm = ({
  detail,
  byId,
  actions,
}: {
  detail: ExecutionDetail;
  byId: ReadonlyMap<string, ExecutionSummary>;
  actions: Actions;
}) => {
  const busy = actions.phase._tag === "Busy";
  const children = unfinishedChildren(detail.children, byId);
  const keep = useRef<HTMLButtonElement>(null);
  useMountEffect(() => keep.current?.focus());
  return (
    <div
      role="alertdialog"
      aria-labelledby="interrupt-confirm-heading"
      aria-describedby="interrupt-confirm-body"
      className="mt-[18px] rounded-xl bg-canvas px-[18px] py-4 shadow-[0_12px_32px_oklch(0_0_0/.35)] inset-ring inset-ring-fail/40"
    >
      {actions.phase._tag === "Confirming" ? <EscapeCancels onCancel={actions.dismiss} /> : null}
      <h4 id="interrupt-confirm-heading" className="text-[15px]/[1.35] font-medium text-balance">
        Interrupt <span className="font-mono">{shortId(detail.id)}</span>? There is no undo.
      </h4>
      <div id="interrupt-confirm-body" className="mt-1 text-[12.5px]/[1.5] text-fg-3">
        <p>
          The fiber is interrupted, registered compensations run, and the execution can never be
          resumed.
        </p>
        {children === 0 ? null : (
          <p className="mt-1">
            {children === 1
              ? "1 child execution stops with it."
              : `${children} child executions stop with it.`}
          </p>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line-soft pt-3.5">
        <Button ref={keep} disabled={busy} onClick={actions.dismiss}>
          Keep {statusName(detail.status)} <Kbd>esc</Kbd>
        </Button>
        <Button
          variant="dangerSolid"
          disabled={busy}
          onClick={() => actions.submit({ action: "interrupt" })}
        >
          {busy ? (
            <>
              <Spinner />
              Interrupting…
            </>
          ) : (
            "Interrupt execution"
          )}
        </Button>
      </div>
    </div>
  );
};

const headerActions: Record<
  ExecutionAction,
  { label: string; busy: string; variant: "primary" | "danger" }
> = {
  resume: { label: "Resume", busy: "Resuming…", variant: "primary" },
  interrupt: { label: "Interrupt", busy: "Interrupting…", variant: "danger" },
};

const ActionsBar = ({
  detail,
  byId,
  actions,
}: {
  detail: ExecutionDetail;
  byId: ReadonlyMap<string, ExecutionSummary>;
  actions: Actions;
}) => {
  const { phase: current } = actions;
  const allowed = actionsFor(detail.status);
  const busy = current._tag === "Busy";
  return (
    <>
      {allowed.length === 0 ? null : (
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {allowed.map((action) => (
            <Button
              key={action}
              variant={headerActions[action].variant}
              disabled={busy}
              onClick={() =>
                action === "interrupt" ? actions.confirm() : actions.submit({ action })
              }
            >
              {busy && current.action === action ? (
                <>
                  <Spinner />
                  {headerActions[action].busy}
                </>
              ) : (
                headerActions[action].label
              )}
            </Button>
          ))}
        </div>
      )}
      {current._tag === "Confirming" || (busy && current.action === "interrupt") ? (
        <InterruptConfirm detail={detail} byId={byId} actions={actions} />
      ) : null}
      <ActionAlert actions={actions} complete={false} />
    </>
  );
};

const ExecutionHeader = ({
  detail,
  byId,
  now,
  rootFlag,
  actions,
}: {
  detail: ExecutionDetail;
  byId: ReadonlyMap<string, ExecutionSummary>;
  now: DateTime.Utc;
  rootFlag: string | undefined;
  actions: Actions;
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
    <section
      tabIndex={0}
      aria-label="Execution summary"
      className="max-h-1/2 flex-none overflow-y-auto overscroll-contain border-b border-line-soft px-6 pt-[18px] pb-4 focus-visible:-outline-offset-2"
    >
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
      <ActionsBar detail={detail} byId={byId} actions={actions} />
      {note === undefined ? null : (
        <Note>
          <StopNoteText note={note} detail={detail} byId={byId} now={now} rootFlag={rootFlag} />
        </Note>
      )}
    </section>
  );
};

const idle = ActionState.Idle();

const ExecutionView = ({
  detail,
  logs,
  byId,
  now,
  rootFlag,
  height,
  onResize,
}: {
  detail: ExecutionDetail;
  logs: Logs;
  byId: ReadonlyMap<string, ExecutionSummary>;
  now: DateTime.Utc;
  rootFlag: string | undefined;
  height: Option.Option<number>;
  onResize: (height: number) => void;
}) => {
  const router = useRouter();
  const [state, setState] = useState<ActionState>(idle);
  const submit = (request: ActionRequest) => {
    setState(ActionState.Submitting({ action: request.action }));
    void Effect.runPromise(requestAction(detail.id, request)).then((next) => {
      setState(next);
      void router.invalidate();
    });
  };
  const actions: Actions = {
    phase: phase(state, detail.updatedAt, now),
    confirm: () => setState(ActionState.Confirming()),
    dismiss: () => setState(idle),
    submit,
    complete: (name, text) => {
      const value = decodeJson(text);
      if (Result.isSuccess(value)) {
        submit({ action: "complete", name, value: value.success });
        return;
      }
      setState(
        ActionState.Failed({
          action: "complete",
          error: { _tag: "NotJson", issue: value.failure.message },
        }),
      );
    },
  };
  return (
    <article
      aria-label={`Execution ${detail.id}`}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <ExecutionHeader
        detail={detail}
        byId={byId}
        now={now}
        rootFlag={rootFlag}
        actions={actions}
      />
      <Trace
        detail={detail}
        logs={logs}
        summaries={byId}
        now={now}
        rootFlag={rootFlag}
        height={height}
        onResize={onResize}
        actions={actions}
      />
    </article>
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
  rootFlag,
}: {
  detail: Option.Option<Detail>;
  executions: ReadonlyArray<ExecutionSummary>;
  now: DateTime.Utc;
  rootFlag: string | undefined;
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
                {kymoCommand(rootFlag, "execute <workflow> <payload>")}
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
        <ExecutionView
          key={selected.detail.id}
          detail={selected.detail}
          logs={selected.logs}
          byId={byId}
          now={now}
          rootFlag={rootFlag}
          height={height}
          onResize={(next) => setHeight(Option.some(next))}
        />
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
