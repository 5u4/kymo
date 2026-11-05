import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  Api,
  type ExecuteRequest,
  type Executed,
  type InvalidPayload,
  type WorkflowNotFound,
} from "kymo/api";
import { kymoCommand, shellArg } from "kymo/shell";

export type ExecuteError =
  | WorkflowNotFound
  | InvalidPayload
  | { readonly _tag: "Unreachable"; readonly message: string };

export type ExecuteState = Data.TaggedEnum<{
  Editing: {};
  NotJson: { readonly message: string };
  Submitting: {};
  Failed: { readonly error: ExecuteError };
}>;
export const ExecuteState = Data.taggedEnum<ExecuteState>();

export interface Draft {
  readonly payload: string;
  readonly label: string;
}

export const emptyDraft: Draft = { payload: "", label: "" };

export interface Existed {
  readonly id: string;
  readonly labelled: boolean;
}

const decodeJson = Schema.decodeResult(Schema.fromJsonString(Schema.Json));

const compactJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

export const parsePayload = (text: string): Result.Result<Schema.Json, string> =>
  Result.mapError(decodeJson(text), (error) => error.message);

export const labelToSend = (label: string): string | undefined =>
  label.trim() === "" ? undefined : label;

export const executeHint = (
  rootFlag: string | undefined,
  workflow: string,
  payloadText: string,
  label: string,
): string => {
  const sent = labelToSend(label);
  const payload = Result.match(parsePayload(payloadText), {
    onSuccess: (json) => shellArg(compactJson(json)),
    onFailure: () => "<payload>",
  });
  const flag =
    sent === undefined
      ? ""
      : sent.startsWith("-")
        ? `--label=${shellArg(sent)} `
        : `--label ${shellArg(sent)} `;
  const terminator = workflow.startsWith("-") || payload.startsWith("-") ? "-- " : "";
  return kymoCommand(rootFlag, `execute ${flag}${terminator}${shellArg(workflow)} ${payload}`);
};

export const requestExecute = (
  request: ExecuteRequest,
): Effect.Effect<Result.Result<Executed, ExecuteError>> => {
  const failed = (error: ExecuteError) => Effect.succeed(Result.fail(error));
  return Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Api);
    return Result.succeed(yield* client.executions.execute({ payload: request }));
  }).pipe(
    Effect.catchTags({ WorkflowNotFound: failed, InvalidPayload: failed }),
    Effect.catch((error) => failed({ _tag: "Unreachable", message: error.message })),
    Effect.provide(FetchHttpClient.layer),
  );
};
