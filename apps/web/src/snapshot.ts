import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { Api, type ExecutionSummary, type WorkflowList } from "kymo/api";

export type Snapshot =
  | {
      readonly _tag: "Live";
      readonly workflows: WorkflowList["workflows"];
      readonly executions: ReadonlyArray<ExecutionSummary>;
      readonly now: DateTime.Utc;
    }
  | { readonly _tag: "Down"; readonly message: string };

export const snapshot: Effect.Effect<Snapshot> = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api);
  const [{ workflows }, { executions }] = yield* Effect.all(
    [client.workflows.list(), client.executions.list({ query: {} })],
    { concurrency: "unbounded" },
  );
  return { _tag: "Live" as const, workflows, executions, now: yield* DateTime.now };
}).pipe(
  Effect.catch((error) => Effect.succeed({ _tag: "Down" as const, message: error.message })),
  Effect.provide(FetchHttpClient.layer),
);
