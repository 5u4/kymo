import { createFileRoute, useRouter } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { AppHeader, DaemonDown } from "../connection.tsx";
import { DetailPane, DetailPaneSkeleton } from "../detail-pane.tsx";
import { ExecutionsPane, ExecutionsPaneSkeleton } from "../executions-pane.tsx";
import { executionsView, Filter, workflowRows } from "../executions-view.ts";
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

const Executions = () => {
  const loaded = Route.useLoaderData();
  const filter = Route.useSearch();
  const router = useRouter();
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
  return (
    <>
      <AppHeader connection="ok" />
      <main className={panes}>
        <WorkflowsPane
          rows={workflowRows(loaded.workflows, loaded.executions)}
          selected={filter.workflow}
        />
        <ExecutionsPane
          view={executionsView(loaded.executions, filter)}
          filter={filter}
          now={loaded.now}
          selected={Option.getOrUndefined(
            Option.flatMap(loaded.detail, (detail) =>
              detail._tag === "Loaded" ? Option.some(detail.detail.id) : Option.none(),
            ),
          )}
          rootFlag={loaded.rootFlag}
        />
        <DetailPane
          detail={loaded.detail}
          executions={loaded.executions}
          now={loaded.now}
          rootFlag={loaded.rootFlag}
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
