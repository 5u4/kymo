import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Option from "effect/Option";
import { Api, type ExecutionDetail, type ExecutionSummary, type WorkflowList } from "kymo/api";

export type Detail = Data.TaggedEnum<{
  Loaded: { readonly detail: ExecutionDetail };
  NotFound: { readonly id: string };
  Ambiguous: { readonly id: string; readonly candidates: ReadonlyArray<string> };
}>;
export const Detail = Data.taggedEnum<Detail>();

export type Snapshot =
  | {
      readonly _tag: "Live";
      readonly workflows: WorkflowList["workflows"];
      readonly executions: ReadonlyArray<ExecutionSummary>;
      readonly detail: Option.Option<Detail>;
      readonly now: DateTime.Utc;
      readonly rootFlag: string | undefined;
    }
  | { readonly _tag: "Down"; readonly message: string };

export const snapshot = (exec: string | undefined): Effect.Effect<Snapshot> =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Api);
    const [health, { workflows }, { executions }, detail] = yield* Effect.all(
      [
        client.health(),
        client.workflows.list(),
        client.executions.list({ query: {} }),
        exec === undefined
          ? Effect.succeedNone
          : client.executions.get({ params: { id: exec } }).pipe(
              Effect.map((detail) => Detail.Loaded({ detail })),
              Effect.catchTags({
                ExecutionNotFound: (error) => Effect.succeed(Detail.NotFound({ id: error.id })),
                AmbiguousExecutionId: (error) =>
                  Effect.succeed(Detail.Ambiguous({ id: error.id, candidates: error.candidates })),
              }),
              Effect.asSome,
            ),
      ],
      { concurrency: "unbounded" },
    );
    return {
      _tag: "Live" as const,
      workflows,
      executions,
      detail,
      now: yield* DateTime.now,
      rootFlag: health.defaultRoot ? undefined : health.root,
    };
  }).pipe(
    Effect.catch((error) => Effect.succeed({ _tag: "Down" as const, message: error.message })),
    Effect.provide(FetchHttpClient.layer),
  );
