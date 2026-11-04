import { createFileRoute, useRouter } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { AppHeader, DaemonDown } from "../connection.tsx";
import { ExecutionsPane, ExecutionsPaneSkeleton } from "../executions-pane.tsx";
import { executionsView, Filter, workflowRows } from "../executions-view.ts";
import { snapshot } from "../snapshot.ts";
import { useMountEffect } from "../use-mount-effect.ts";
import { WorkflowsPane, WorkflowsPaneSkeleton } from "../workflows-pane.tsx";

const panes = "grid min-h-0 grid-cols-[272px_minmax(360px,1fr)]";

const Loading = () => (
  <>
    <AppHeader connection="wait" />
    <main className={panes}>
      <WorkflowsPaneSkeleton />
      <ExecutionsPaneSkeleton />
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
