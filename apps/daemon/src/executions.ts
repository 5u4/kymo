import * as MachineId from "effect/cluster/MachineId";
import * as Snowflake from "effect/cluster/Snowflake";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import {
  type ActivityRun,
  AmbiguousExecutionId,
  type ExecuteRequest,
  type Executed,
  type ExecutionDetail,
  type ExecutionList,
  ExecutionNotFound,
  type ExecutionQuery,
  type ExecutionStatus,
  type ExecutionSummary,
  InvalidPayload,
  statusName,
  WorkflowNotFound,
} from "kymo/api";
import { Awaits } from "./awaits.ts";
import { Registry } from "./workflow-sources.ts";

const CauseReason = Schema.Union([
  Schema.TaggedStruct("Fail", { error: Schema.Json }),
  Schema.TaggedStruct("Die", { defect: Schema.Json }),
  Schema.TaggedStruct("Interrupt", {}),
]);
type CauseReason = typeof CauseReason.Type;

const Cause = Schema.Array(CauseReason);

const Outcome = Schema.Union([
  Schema.TaggedStruct("Complete", {
    exit: Schema.Union([
      Schema.TaggedStruct("Success", {}),
      Schema.TaggedStruct("Failure", { cause: Cause }),
    ]),
  }),
  Schema.TaggedStruct("Suspended", {
    cause: Schema.optional(Schema.NullOr(Cause)),
    failed: Schema.optional(Schema.Boolean),
  }),
]);

const Reply = Schema.Union([
  Schema.TaggedStruct("Success", { value: Outcome }),
  Schema.TaggedStruct("Failure", { cause: Cause }),
]);
type Reply = typeof Reply.Type;

const SnowflakeTime = Snowflake.SnowflakeFromString.pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.transform({
      decode: Snowflake.dateTime,
      encode: (time) =>
        Snowflake.make({
          timestamp: DateTime.toEpochMillis(time),
          machineId: MachineId.make(0),
          sequence: 0,
        }),
    }),
  ),
);

const RunRow = Schema.Struct({
  id: Schema.String,
  workflow: Schema.String,
  started: SnowflakeTime,
  payload: Schema.fromJsonString(Schema.Json),
  parent_workflow: Schema.NullOr(Schema.String),
  parent_id: Schema.NullOr(Schema.String),
  detached: Schema.NullOr(Schema.Int),
  replied: Schema.NullOr(SnowflakeTime),
  reply: Schema.NullOr(Schema.fromJsonString(Reply)),
  label: Schema.NullOr(Schema.String),
});
type RunRow = typeof RunRow.Type;

const ClockRow = Schema.Struct({
  execution_id: Schema.String,
  payload: Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      workflowName: Schema.String,
      wakeUp: Schema.DateTimeUtcFromMillis,
    }),
  ),
});

const ActivityRow = Schema.Struct({
  started: SnowflakeTime,
  payload: Schema.fromJsonString(Schema.Struct({ name: Schema.String, attempt: Schema.Int })),
  replied: Schema.NullOr(SnowflakeTime),
  reply: Schema.NullOr(Schema.fromJsonString(Reply)),
});

const JsonText = Schema.fromJsonString(Schema.Json);

const describe = (value: Schema.Json): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Schema.encodeSync(JsonText)(value);
  }
  const { _tag, name, message, stack: _stack, ...rest } = value as Schema.JsonObject;
  const title = typeof _tag === "string" ? _tag : typeof name === "string" ? name : undefined;
  if (title === undefined) {
    return Schema.encodeSync(JsonText)(value);
  }
  if (typeof message === "string" && message.length > 0) {
    return `${title}: ${message}`;
  }
  return Object.keys(rest).length > 0 ? `${title} ${Schema.encodeSync(JsonText)(rest)}` : title;
};

const failure = (cause: ReadonlyArray<CauseReason>) => {
  const reason =
    cause.find((reason) => reason._tag === "Fail") ?? cause.find((reason) => reason._tag === "Die");
  if (reason === undefined) {
    return { kind: "Die" as const, message: "the cause holds no failure" };
  }
  return reason._tag === "Fail"
    ? { kind: "Fail" as const, message: describe(reason.error) }
    : { kind: "Die" as const, message: describe(reason.defect) };
};

type Ended = Extract<ExecutionStatus, { readonly _tag: "Failed" | "Interrupted" }>;

const ended = (cause: ReadonlyArray<CauseReason>): Ended =>
  cause.length > 0 && cause.every((reason) => reason._tag === "Interrupt")
    ? { _tag: "Interrupted" }
    : { _tag: "Failed", ...failure(cause) };

type Settled =
  | Exclude<ExecutionStatus, { readonly _tag: "Suspended" }>
  | { readonly _tag: "Suspended"; readonly failure: Option.Option<string> };

const settle = (reply: Option.Option<Reply>): Settled => {
  if (Option.isNone(reply)) {
    return { _tag: "Running" };
  }
  if (reply.value._tag === "Failure") {
    return ended(reply.value.cause);
  }
  const outcome = reply.value.value;
  if (outcome._tag === "Suspended") {
    return {
      _tag: "Suspended",
      failure:
        outcome.failed === true ? Option.some(failure(outcome.cause ?? []).message) : Option.none(),
    };
  }
  return outcome.exit._tag === "Success" ? { _tag: "Succeeded" } : ended(outcome.exit.cause);
};

export interface StatusInput {
  readonly reply: Option.Option<Reply>;
  readonly clock: Option.Option<{ readonly name: string; readonly wakeAt: DateTime.Utc }>;
  readonly openChild: Option.Option<string>;
  readonly deferred: Option.Option<string>;
}

export const executionStatus = (input: StatusInput): ExecutionStatus => {
  const settled = settle(input.reply);
  if (settled._tag !== "Suspended") {
    return settled;
  }
  if (Option.isSome(settled.failure)) {
    return { _tag: "Suspended", reason: { _tag: "Failure", cause: settled.failure.value } };
  }
  if (Option.isSome(input.clock)) {
    return { _tag: "Suspended", reason: { _tag: "Clock", ...input.clock.value } };
  }
  if (Option.isSome(input.openChild)) {
    return {
      _tag: "Suspended",
      reason: { _tag: "Child", executionId: input.openChild.value },
    };
  }
  return { _tag: "Suspended", reason: { _tag: "Deferred", name: input.deferred } };
};

const parentKey = "~effect/cluster/ClusterWorkflowEngine/payloadParentKey";

const readRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT
      m.entity_id AS id,
      substr(m.entity_type, length('Workflow/') + 1) AS workflow,
      CAST(m.id AS TEXT) AS started,
      json_remove(m.payload, ${`$."${parentKey}"`}) AS payload,
      json_extract(m.payload, ${`$."${parentKey}".workflowName`}) AS parent_workflow,
      json_extract(m.payload, ${`$."${parentKey}".executionId`}) AS parent_id,
      json_extract(m.payload, ${`$."${parentKey}".detached`}) AS detached,
      CAST(r.id AS TEXT) AS replied,
      r.payload AS reply,
      l.label AS label
    FROM cluster_messages m
    LEFT JOIN cluster_replies r ON r.id = (
      SELECT max(id) FROM cluster_replies WHERE request_id = m.request_id AND kind = 0
    )
    LEFT JOIN kymo_labels l ON l.execution_id = m.entity_id
    WHERE m.kind = 0 AND m.tag = 'run'
      AND m.entity_type LIKE 'Workflow/%' AND m.entity_type <> 'Workflow/-/DurableClock'
    ORDER BY m.id DESC
  `;
  return yield* Schema.decodeUnknownEffect(Schema.Array(RunRow))(rows);
}).pipe(Effect.orDie);

const readClocks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT entity_id AS execution_id, payload FROM cluster_messages
    WHERE entity_type = 'Workflow/-/DurableClock' AND kind = 0 AND processed = 0
  `;
  return yield* Schema.decodeUnknownEffect(Schema.Array(ClockRow))(rows);
}).pipe(Effect.orDie);

const readActivities = (run: RunRow) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      SELECT CAST(m.id AS TEXT) AS started, m.payload, CAST(r.id AS TEXT) AS replied, r.payload AS reply
      FROM cluster_messages m
      LEFT JOIN cluster_replies r ON r.id = (
        SELECT max(id) FROM cluster_replies WHERE request_id = m.request_id AND kind = 0
      )
      WHERE m.entity_type = ${`Workflow/${run.workflow}`} AND m.entity_id = ${run.id}
        AND m.kind = 0 AND m.tag = 'activity'
      ORDER BY m.id
    `;
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(ActivityRow))(rows);
    return decoded.map((row): ActivityRun => {
      const settled = settle(Option.fromNullOr(row.reply));
      return {
        name: row.payload.name,
        attempt: row.payload.attempt,
        status: settled._tag === "Suspended" ? { _tag: "Suspended" } : settled,
        startedAt: row.started,
        endedAt: Option.fromNullOr(row.replied),
      };
    });
  }).pipe(Effect.orDie);

const entityKey = (workflow: string, executionId: string) => `${workflow}/${executionId}`;

const statuses = Effect.gen(function* () {
  const runs = yield* readRuns;
  const clocks = new Map(
    (yield* readClocks).map(({ execution_id, payload }) => [
      entityKey(payload.workflowName, execution_id),
      { name: payload.name, wakeAt: payload.wakeUp },
    ]),
  );
  const awaits = yield* Effect.flatMap(Awaits, (service) => service.list);
  const waitsByExecution = Map.groupBy(awaits, (wait) =>
    entityKey(wait.workflowName, wait.executionId),
  );
  const childrenByParent = Map.groupBy(
    runs.filter((run) => run.parent_id !== null),
    (run) => entityKey(run.parent_workflow ?? "", run.parent_id ?? ""),
  );
  return runs.map((run) => {
    const key = entityKey(run.workflow, run.id);
    const children = childrenByParent.get(key) ?? [];
    const waits = waitsByExecution.get(key) ?? [];
    const openChild = children.find(
      (child) =>
        child.detached !== 1 &&
        (child.reply === null ||
          (child.reply._tag === "Success" && child.reply.value._tag === "Suspended")),
    );
    const status = executionStatus({
      reply: Option.fromNullOr(run.reply),
      clock: Option.fromUndefinedOr(clocks.get(key)),
      openChild: Option.fromUndefinedOr(openChild?.id),
      deferred: Option.fromUndefinedOr(waits.find((wait) => wait._tag === "Deferred")?.name),
    });
    return { run, children, waits, status };
  });
});

type Entry = Effect.Success<typeof statuses>[number];

export class Executions extends Context.Service<
  Executions,
  {
    readonly list: (query: ExecutionQuery) => Effect.Effect<ExecutionList>;
    readonly get: (
      id: string,
    ) => Effect.Effect<ExecutionDetail, ExecutionNotFound | AmbiguousExecutionId>;
    readonly execute: (
      request: ExecuteRequest,
    ) => Effect.Effect<Executed, WorkflowNotFound | InvalidPayload>;
  }
>()("@kymo/daemon/Executions") {
  static readonly layer: Layer.Layer<
    Executions,
    never,
    SqlClient.SqlClient | Awaits | Registry | WorkflowEngine.WorkflowEngine
  > = Layer.effect(
    Executions,
    Effect.gen(function* () {
      const context = yield* Effect.context<SqlClient.SqlClient | Awaits>();
      const registry = yield* Registry;
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const semaphore = yield* Semaphore.make(1);

      const summarize = ({ run, status }: Entry) =>
        Effect.map(
          Option.match(registry.get(run.workflow), {
            onNone: () => Effect.succeedNone,
            onSome: (workflow) =>
              Schema.decodeEffect(Schema.toCodecJson(workflow.payloadSchema))(run.payload).pipe(
                Effect.flatMap((payload) => Effect.try(() => workflow.idempotencyKey(payload))),
                Effect.option,
              ),
          }),
          (idempotencyKey): ExecutionSummary => ({
            id: run.id,
            workflow: run.workflow,
            label: Option.fromNullOr(run.label),
            idempotencyKey,
            status,
            startedAt: run.started,
            updatedAt: Option.fromNullOr(run.replied),
            parentId: Option.fromNullOr(run.parent_id),
          }),
        );

      const list = Effect.fn("Executions.list")(function* (query: ExecutionQuery) {
        const matching = (yield* statuses).filter(
          ({ run, status }) =>
            (query.workflow === undefined || run.workflow === query.workflow) &&
            (query.status === undefined || statusName(status) === query.status),
        );
        return {
          executions: yield* Effect.forEach(matching.slice(0, query.limit), summarize),
          total: matching.length,
        };
      }, Effect.provideContext(context));

      const get = Effect.fn("Executions.get")(function* (id: string) {
        const [entry, ...others] = (yield* statuses).filter(({ run }) => run.id.startsWith(id));
        if (entry === undefined) {
          return yield* new ExecutionNotFound({ id });
        }
        if (others.length > 0) {
          return yield* new AmbiguousExecutionId({
            id,
            candidates: [entry, ...others].map(({ run }) => run.id),
          });
        }
        return {
          ...(yield* summarize(entry)),
          payload: entry.run.payload,
          activities: yield* readActivities(entry.run),
          children: entry.children.map((child) => child.id),
          waits: entry.waits.map((wait) => ({
            kind: wait._tag,
            name: wait.name,
            since: wait.since,
          })),
        };
      }, Effect.provideContext(context));

      const execute = Effect.fn("Executions.execute")(function* (request: ExecuteRequest) {
        const workflow = yield* Effect.fromOption(registry.get(request.workflow)).pipe(
          Effect.mapError(
            () => new WorkflowNotFound({ workflow: request.workflow, registered: registry.names }),
          ),
        );
        const payload = yield* Schema.decodeEffect(Schema.toCodecJson(workflow.payloadSchema))(
          request.payload,
        ).pipe(
          Effect.mapError(
            (error) =>
              new InvalidPayload({
                workflow: workflow._tag,
                issue: error.message.replace(/\n\s*/g, " "),
              }),
          ),
        );
        const executionId = yield* workflow.executionId(payload).pipe(
          Effect.catchDefect((defect) =>
            Effect.fail(
              new InvalidPayload({
                workflow: workflow._tag,
                issue: defect instanceof Error ? defect.message : String(defect),
              }),
            ),
          ),
        );
        const created = yield* semaphore.withPermit(
          Effect.gen(function* () {
            const existing = yield* sql`
              SELECT 1 FROM cluster_messages
              WHERE entity_type = ${`Workflow/${workflow._tag}`} AND entity_id = ${executionId}
                AND kind = 0 AND tag = 'run'
              LIMIT 1
            `.pipe(Effect.orDie);
            const created = existing.length === 0;
            if (created) {
              yield* (
                request.label === undefined
                  ? sql`DELETE FROM kymo_labels WHERE execution_id = ${executionId}`
                  : sql`
                      INSERT INTO kymo_labels (execution_id, label) VALUES (${executionId}, ${request.label})
                      ON CONFLICT (execution_id) DO UPDATE SET label = excluded.label
                    `
              ).pipe(Effect.orDie);
            }
            yield* Effect.orDie(engine.execute(workflow, { executionId, payload, discard: true }));
            return created;
          }),
        );
        const entry = (yield* statuses).find(({ run }) => run.id === executionId);
        if (entry === undefined) {
          return yield* Effect.die(`${workflow._tag} ${executionId} has no run after execute`);
        }
        return { execution: yield* summarize(entry), created };
      }, Effect.provideContext(context));

      return Executions.of({ list, get, execute });
    }),
  );
}

export const resumeWaiting: Layer.Layer<
  never,
  never,
  SqlClient.SqlClient | Awaits | Registry | WorkflowEngine.WorkflowEngine
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const registry = yield* Registry;
    const waiting = (yield* statuses).filter(
      ({ status }) => status._tag === "Suspended" && status.reason._tag !== "Failure",
    );
    yield* Effect.forEach(
      waiting,
      ({ run }) =>
        Option.match(registry.get(run.workflow), {
          onNone: () => Effect.void,
          onSome: (workflow) =>
            engine
              .resume(workflow, run.id)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(`could not resume ${run.workflow} ${run.id}`, cause),
                ),
              ),
        }),
      { discard: true },
    );
  }),
);
