import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";

export const Pass = Context.Reference<number>("@kymo/daemon/WorkflowLogs/Pass", {
  defaultValue: () => 0,
});

export const CurrentActivity = Context.Reference<string | undefined>(
  "@kymo/daemon/WorkflowLogs/CurrentActivity",
  { defaultValue: () => undefined },
);

type Row = {
  readonly execution_id: string;
  readonly pass: number;
  readonly at: number;
  readonly level: string;
  readonly message: string;
  readonly cause: string | null;
  readonly activity: string | null;
  readonly attempt: number | null;
};

const row = (options: Logger.Options<unknown>): Row => {
  const context = options.fiber.context;
  const activity = Context.get(context, CurrentActivity) ?? null;
  return {
    execution_id: Context.getUnsafe(context, WorkflowEngine.WorkflowInstance).executionId,
    pass: Context.get(context, Pass),
    at: options.date.getTime(),
    level: options.logLevel,
    message: Arr.ensure(options.message)
      .map((part) => (typeof part === "string" ? part : Formatter.format(part)))
      .join(" "),
    cause: options.cause.reasons.length > 0 ? Cause.pretty(options.cause) : null,
    activity,
    attempt:
      activity === null ? null : (Context.getOrUndefined(context, Activity.CurrentAttempt) ?? null),
  };
};

export const logger = Logger.layer([
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stored = yield* Logger.batched(Logger.make(row), {
      window: "100 millis",
      flush: (rows) =>
        Arr.isArrayNonEmpty(rows)
          ? sql`INSERT INTO kymo_logs ${sql.insert(rows)}`.pipe(
              Effect.asVoid,
              Effect.catchCause((cause) =>
                Effect.logError("could not store workflow logs", cause).pipe(
                  Effect.provideService(Logger.CurrentLoggers, new Set([Logger.defaultLogger])),
                ),
              ),
            )
          : Effect.void,
    });
    return Logger.make((options) =>
      Context.getOrUndefined(options.fiber.context, WorkflowEngine.WorkflowInstance) === undefined
        ? Logger.defaultLogger.log(options)
        : stored.log(options),
    );
  }),
]);

const LastPass = Schema.Tuple([Schema.Struct({ pass: Schema.NullOr(Schema.Int) })]);

export const attribution: Layer.Layer<
  WorkflowEngine.WorkflowEngine,
  never,
  WorkflowEngine.WorkflowEngine | SqlClient.SqlClient
> = Layer.effect(
  WorkflowEngine.WorkflowEngine,
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const sql = yield* SqlClient.SqlClient;
    const last = new Map<string, number>();

    return WorkflowEngine.WorkflowEngine.of({
      ...engine,
      register: (workflow, execute) =>
        engine.register(workflow, (payload, executionId) =>
          Effect.gen(function* () {
            const previous =
              last.get(executionId) ??
              (yield* sql`SELECT MAX(pass) AS pass FROM kymo_logs WHERE execution_id = ${executionId}`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(LastPass)),
                Effect.map(([{ pass }]) => pass ?? 0),
                Effect.orDie,
              ));
            const pass = previous + 1;
            last.set(executionId, pass);
            const instance = yield* WorkflowEngine.WorkflowInstance;
            return yield* execute(payload, executionId).pipe(
              Effect.provideService(Pass, pass),
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  // The engine flags failure-suspended, abandoned and cut-off runs after this exits.
                  const final =
                    Exit.isSuccess(exit) ||
                    (!instance.suspended &&
                      !instance.abandoned &&
                      !Context.get(workflow.annotations, Workflow.SuspendOnFailure) &&
                      !Cause.hasInterrupts(exit.cause));
                  if (final) {
                    last.delete(executionId);
                  }
                }),
              ),
            );
          }),
        ),
      activityExecute: (activity, attempt) =>
        engine
          .activityExecute(activity, attempt)
          .pipe(Effect.provideService(CurrentActivity, activity.name)),
    });
  }),
);
