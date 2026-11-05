import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Option from "effect/Option";
import {
  Api,
  type ActionNotAllowed,
  type AmbiguousExecutionId,
  type CompleteRequest,
  type ExecutionAction,
  type ExecutionNotFound,
  type ExecutionSummary,
  type InvalidValue,
  type NotWaiting,
  type WorkflowNotFound,
} from "kymo/api";
import { isEnded } from "./trace-view.ts";

export type Action = ExecutionAction | "complete";

export type ActionRequest =
  | { readonly action: ExecutionAction }
  | ({ readonly action: "complete" } & CompleteRequest);

export type ActionError =
  | ActionNotAllowed
  | NotWaiting
  | InvalidValue
  | ExecutionNotFound
  | AmbiguousExecutionId
  | WorkflowNotFound
  | { readonly _tag: "NotJson"; readonly issue: string }
  | { readonly _tag: "Unreachable"; readonly message: string };

export type ActionState = Data.TaggedEnum<{
  Idle: {};
  Confirming: {};
  Submitting: { readonly action: Action };
  Requested: {
    readonly action: Action;
    readonly baseline: Option.Option<DateTime.Utc>;
    readonly at: DateTime.Utc;
  };
  Failed: { readonly action: Action; readonly error: ActionError };
}>;
export const ActionState = Data.taggedEnum<ActionState>();

export type Phase = Data.TaggedEnum<{
  Ready: {};
  Confirming: {};
  Busy: { readonly action: Action };
  NoChange: { readonly action: Action };
  Failed: { readonly action: Action; readonly error: ActionError };
}>;
export const Phase = Data.taggedEnum<Phase>();

export interface Actions {
  readonly phase: Phase;
  readonly confirm: () => void;
  readonly dismiss: () => void;
  readonly submit: (request: ActionRequest) => void;
  readonly complete: (name: string, text: string) => void;
}

const noChangeAfterMs = 10_000;

const sameUpdate = Option.makeEquivalence(DateTime.Equivalence);

export const phase = (
  state: ActionState,
  updatedAt: Option.Option<DateTime.Utc>,
  now: DateTime.Utc,
): Phase => {
  switch (state._tag) {
    case "Idle":
      return Phase.Ready();
    case "Confirming":
      return Phase.Confirming();
    case "Submitting":
      return Phase.Busy({ action: state.action });
    case "Failed":
      return Phase.Failed({ action: state.action, error: state.error });
    case "Requested":
      if (!sameUpdate(state.baseline, updatedAt)) return Phase.Ready();
      return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(state.at) >= noChangeAfterMs
        ? Phase.NoChange({ action: state.action })
        : Phase.Busy({ action: state.action });
  }
};

export const unfinishedChildren = (
  children: ReadonlyArray<string>,
  summaries: ReadonlyMap<string, ExecutionSummary>,
): number =>
  children.filter((id) => {
    const summary = summaries.get(id);
    return summary !== undefined && !isEnded(summary.status);
  }).length;

export const requestAction = (id: string, request: ActionRequest): Effect.Effect<ActionState> => {
  const failed = (error: ActionError) =>
    Effect.succeed(ActionState.Failed({ action: request.action, error }));
  return Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Api);
    const params = { id };
    const summary =
      request.action === "complete"
        ? yield* client.executions.complete({
            params,
            payload: { name: request.name, value: request.value },
          })
        : request.action === "resume"
          ? yield* client.executions.resume({ params })
          : yield* client.executions.interrupt({ params });
    return ActionState.Requested({
      action: request.action,
      baseline: summary.updatedAt,
      at: yield* DateTime.now,
    });
  }).pipe(
    Effect.catchTags({
      ActionNotAllowed: failed,
      NotWaiting: failed,
      InvalidValue: failed,
      ExecutionNotFound: failed,
      AmbiguousExecutionId: failed,
      WorkflowNotFound: failed,
    }),
    Effect.catch((error) => failed({ _tag: "Unreachable", message: error.message })),
    Effect.provide(FetchHttpClient.layer),
  );
};
