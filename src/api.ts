import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

export const hostname = "127.0.0.1";

export const url = (port: number) => `http://${hostname}:${port}`;

export const Health = Schema.Struct({
  pid: Schema.Int,
  root: Schema.String,
});
export type Health = typeof Health.Type;

export const SuspendReason = Schema.Union([
  Schema.TaggedStruct("Failure", { cause: Schema.String }),
  Schema.TaggedStruct("Clock", { name: Schema.String, wakeAt: Schema.DateTimeUtc }),
  Schema.TaggedStruct("Child", { executionId: Schema.String }),
  Schema.TaggedStruct("Deferred", { name: Schema.OptionFromNullOr(Schema.String) }),
]);
export type SuspendReason = typeof SuspendReason.Type;

const Running = Schema.TaggedStruct("Running", {});
const Succeeded = Schema.TaggedStruct("Succeeded", {});
const Failed = Schema.TaggedStruct("Failed", {
  kind: Schema.Literals(["Fail", "Die"]),
  message: Schema.String,
});
const Interrupted = Schema.TaggedStruct("Interrupted", {});

export const ExecutionStatus = Schema.Union([
  Running,
  Schema.TaggedStruct("Suspended", { reason: SuspendReason }),
  Succeeded,
  Failed,
  Interrupted,
]);
export type ExecutionStatus = typeof ExecutionStatus.Type;

export const ActivityStatus = Schema.Union([
  Running,
  Schema.TaggedStruct("Suspended", {}),
  Succeeded,
  Failed,
  Interrupted,
]);
export type ActivityStatus = typeof ActivityStatus.Type;

export const StatusName = Schema.Literals([
  "running",
  "suspended",
  "succeeded",
  "failed",
  "interrupted",
]);
export type StatusName = typeof StatusName.Type;

const statusNames: Record<ExecutionStatus["_tag"], StatusName> = {
  Running: "running",
  Suspended: "suspended",
  Succeeded: "succeeded",
  Failed: "failed",
  Interrupted: "interrupted",
};

export const statusName = (status: ExecutionStatus | ActivityStatus): StatusName =>
  statusNames[status._tag];

export const ExecutionSummary = Schema.Struct({
  id: Schema.String,
  workflow: Schema.String,
  label: Schema.OptionFromNullOr(Schema.String),
  idempotencyKey: Schema.OptionFromNullOr(Schema.String),
  status: ExecutionStatus,
  startedAt: Schema.DateTimeUtc,
  updatedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  parentId: Schema.OptionFromNullOr(Schema.String),
});
export type ExecutionSummary = typeof ExecutionSummary.Type;

export const ActivityRun = Schema.Struct({
  name: Schema.String,
  attempt: Schema.Int,
  status: ActivityStatus,
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
});
export type ActivityRun = typeof ActivityRun.Type;

export const Wait = Schema.Struct({
  kind: Schema.Literals(["Deferred", "Clock"]),
  name: Schema.String,
  since: Schema.DateTimeUtc,
});
export type Wait = typeof Wait.Type;

export const ExecutionDetail = Schema.Struct({
  ...ExecutionSummary.fields,
  payload: Schema.Json,
  activities: Schema.Array(ActivityRun),
  children: Schema.Array(Schema.String),
  waits: Schema.Array(Wait),
});
export type ExecutionDetail = typeof ExecutionDetail.Type;

export const ExecutionQuery = Schema.Struct({
  workflow: Schema.optional(Schema.String),
  status: Schema.optional(StatusName),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type ExecutionQuery = typeof ExecutionQuery.Type;

export const ExecutionList = Schema.Struct({
  executions: Schema.Array(ExecutionSummary),
  total: Schema.Int,
});
export type ExecutionList = typeof ExecutionList.Type;

export class ExecutionNotFound extends Schema.TaggedError<ExecutionNotFound>()(
  "ExecutionNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `no execution matches ${this.id}`;
  }
}

export class AmbiguousExecutionId extends Schema.TaggedError<AmbiguousExecutionId>()(
  "AmbiguousExecutionId",
  { id: Schema.String, candidates: Schema.Array(Schema.String) },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `${this.id} matches ${this.candidates.length} executions`;
  }
}

export const ExecuteRequest = Schema.Struct({
  workflow: Schema.String,
  payload: Schema.Json,
  label: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
});
export type ExecuteRequest = typeof ExecuteRequest.Type;

export const Executed = Schema.Struct({
  execution: ExecutionSummary,
  created: Schema.Boolean,
});
export type Executed = typeof Executed.Type;

export class WorkflowNotFound extends Schema.TaggedError<WorkflowNotFound>()(
  "WorkflowNotFound",
  { workflow: Schema.String, registered: Schema.Array(Schema.String) },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `no workflow named ${this.workflow}`;
  }
}

export class InvalidPayload extends Schema.TaggedError<InvalidPayload>()(
  "InvalidPayload",
  { workflow: Schema.String, issue: Schema.String },
  { httpApiStatus: 400 },
) {
  override get message() {
    return `invalid payload for ${this.workflow}: ${this.issue}`;
  }
}

export class Api extends HttpApi.make("kymo")
  .add(
    HttpApiGroup.make("daemon", { topLevel: true }).add(
      HttpApiEndpoint.get("health", "/api/health", { success: Health }),
    ),
  )
  .add(
    HttpApiGroup.make("executions")
      .add(
        HttpApiEndpoint.get("list", "/api/executions", {
          query: ExecutionQuery.fields,
          success: ExecutionList,
        }),
      )
      .add(
        HttpApiEndpoint.get("get", "/api/executions/:id", {
          params: { id: Schema.String },
          success: ExecutionDetail,
          error: [ExecutionNotFound, AmbiguousExecutionId],
        }),
      )
      .add(
        HttpApiEndpoint.post("execute", "/api/executions", {
          payload: ExecuteRequest,
          success: Executed,
          error: [WorkflowNotFound, InvalidPayload],
        }),
      ),
  ) {}
