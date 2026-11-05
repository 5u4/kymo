import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { AppHeader, DaemonDown } from "../connection.tsx";
import { DetailPane, DetailPaneSkeleton } from "../detail-pane.tsx";
import {
  emptyDraft,
  ExecuteState,
  labelToSend,
  parsePayload,
  requestExecute,
  type Draft,
  type Existed,
} from "../execute.ts";
import { ExecuteForm } from "../execute-form.tsx";
import { ExecutionsPane, ExecutionsPaneSkeleton } from "../executions-pane.tsx";
import { executionsView, Filter, refine, workflowRows } from "../executions-view.ts";
import { snapshot } from "../snapshot.ts";
import { useMountEffect } from "../use-mount-effect.ts";
import { WorkflowsPane, WorkflowsPaneSkeleton } from "../workflows-pane.tsx";

const panes = "grid min-h-0 grid-cols-[272px_minmax(360px,416px)_minmax(0,1fr)]";

const Loading = () => (
  <>
    <AppHeader connection="wait" />
    <main className={panes}>
      <WorkflowsPaneSkeleton />
      <ExecutionsPaneSkeleton />
      <DetailPaneSkeleton />
    </main>
  </>
);

interface Open {
  readonly workflow: string;
  readonly over: string | undefined;
}

const idle = ExecuteState.Editing();

const Executions = () => {
  const loaded = Route.useLoaderData();
  const filter = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: "/" });
  const [open, setOpen] = useState<Option.Option<Open>>(Option.none());
  const opened = useRef(open);
  const show = (next: Option.Option<Open>) => {
    opened.current = next;
    setOpen(next);
  };
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(new Map());
  const [states, setStates] = useState<ReadonlyMap<string, ExecuteState>>(new Map());
  const settle = (workflow: string, state: ExecuteState) =>
    setStates((prev) => new Map(prev).set(workflow, state));
  const [existed, setExisted] = useState<Option.Option<Existed>>(Option.none());
  useMountEffect(() => {
    const poll = Effect.runFork(
      Effect.schedule(
        Effect.promise(() => router.invalidate()),
        Schedule.spaced("2 seconds"),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(poll));
    };
  });
  if (loaded._tag === "Down") {
    return (
      <>
        <AppHeader connection="down" />
        <main className="grid min-h-0">
          <DaemonDown message={loaded.message} />
        </main>
      </>
    );
  }
  const shown = Option.getOrUndefined(
    Option.flatMap(loaded.detail, (detail) =>
      detail._tag === "Loaded" ? Option.some(detail.detail.id) : Option.none(),
    ),
  );
  const note = Option.getOrUndefined(existed);
  if (note !== undefined && note.id !== filter.exec) {
    setExisted(Option.none());
  }
  const execute = (workflow: string) => show(Option.some({ workflow, over: filter.exec }));
  const submit = (workflow: string) => {
    if (states.get(workflow)?._tag === "Submitting") return;
    const draft = drafts.get(workflow) ?? emptyDraft;
    const payload = parsePayload(draft.payload);
    if (Result.isFailure(payload)) {
      settle(workflow, ExecuteState.NotJson({ message: payload.failure }));
      return;
    }
    const label = labelToSend(draft.label);
    const over = filter.exec;
    settle(workflow, ExecuteState.Submitting());
    void Effect.runPromise(
      requestExecute({
        workflow,
        payload: payload.success,
        ...(label === undefined ? {} : { label }),
      }),
    ).then((result) => {
      if (Result.isFailure(result)) {
        settle(workflow, ExecuteState.Failed({ error: result.failure }));
        return;
      }
      settle(workflow, idle);
      setDrafts((prev) => {
        if (prev.get(workflow) !== draft) return prev;
        const next = new Map(prev);
        next.delete(workflow);
        return next;
      });
      const followed = Option.exists(
        opened.current,
        (current) => current.workflow === workflow && current.over === over,
      );
      if (!followed || router.state.location.search.exec !== over) return;
      const { execution, created } = result.success;
      show(Option.none());
      void navigate({ search: (prev) => refine(prev, { exec: execution.id }) }).then(() => {
        if (created || router.state.location.search.exec !== execution.id) return;
        setExisted(Option.some({ id: execution.id, labelled: label !== undefined }));
      });
    });
  };
  const registered = loaded.workflows.map((workflow) => workflow.name);
  const preselect =
    filter.workflow !== undefined && registered.includes(filter.workflow)
      ? filter.workflow
      : registered[0];
  const form = Option.getOrUndefined(Option.filter(open, ({ over }) => over === filter.exec));
  return (
    <>
      <AppHeader connection="ok" />
      <main className={panes}>
        <WorkflowsPane
          rows={workflowRows(loaded.workflows, loaded.executions)}
          selected={filter.workflow}
          registered={new Set(registered)}
          onExecute={execute}
        />
        <ExecutionsPane
          view={executionsView(loaded.executions, filter)}
          filter={filter}
          now={loaded.now}
          selected={shown}
          rootFlag={loaded.rootFlag}
        />
        <DetailPane
          detail={loaded.detail}
          executions={loaded.executions}
          now={loaded.now}
          rootFlag={loaded.rootFlag}
          existed={note}
          onExecute={preselect === undefined ? undefined : () => execute(preselect)}
          form={
            form === undefined ? undefined : (
              <ExecuteForm
                workflows={loaded.workflows}
                workflow={form.workflow}
                draft={drafts.get(form.workflow) ?? emptyDraft}
                state={states.get(form.workflow) ?? idle}
                rootFlag={loaded.rootFlag}
                onWorkflow={(workflow) => show(Option.some({ ...form, workflow }))}
                onDraft={(draft) => setDrafts((prev) => new Map(prev).set(form.workflow, draft))}
                onSubmit={() => submit(form.workflow)}
                onCancel={() => show(Option.none())}
                onDismiss={() => settle(form.workflow, idle)}
              />
            )
          }
        />
      </main>
    </>
  );
};

export const Route = createFileRoute("/")({
  validateSearch: Schema.toStandardSchemaV1(Filter),
  loaderDeps: ({ search }) => ({ exec: search.exec }),
  loader: ({ deps }) => Effect.runPromise(snapshot(deps.exec)),
  staleTime: Number.POSITIVE_INFINITY,
  pendingComponent: Loading,
  component: Executions,
});
