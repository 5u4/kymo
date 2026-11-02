import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/cluster/SingleRunner";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as DurableClock from "effect/workflow/DurableClock";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Workflow from "effect/workflow/Workflow";
import { Awaits, type Await } from "../src/Awaits.ts";

const ManagerApproval = DurableDeferred.make("ManagerApproval", {
  success: Schema.Struct({ approved: Schema.Boolean }),
});

const Approval = Workflow.make("Approval", {
  payload: { id: Schema.String },
  success: Schema.Boolean,
  idempotencyKey: ({ id }) => id,
});

const Cooldown = Workflow.make("Cooldown", {
  payload: { id: Schema.String },
  idempotencyKey: ({ id }) => id,
});

const RaceThenApprove = Workflow.make("RaceThenApprove", {
  payload: { id: Schema.String },
  idempotencyKey: ({ id }) => id,
});

const Escalation = DurableDeferred.make("Escalation");

const EscalateOrApprove = Workflow.make("EscalateOrApprove", {
  payload: { id: Schema.String },
  idempotencyKey: ({ id }) => id,
});

const Signoff = DurableDeferred.make("Signoff");

const ApproveOrEscalateThenSignoff = Workflow.make("ApproveOrEscalateThenSignoff", {
  payload: { id: Schema.String },
  idempotencyKey: ({ id }) => id,
});

const workflows = Layer.mergeAll(
  Approval.toLayer(() =>
    Effect.map(DurableDeferred.await(ManagerApproval), ({ approved }) => approved),
  ),
  Cooldown.toLayer(() => DurableClock.sleep({ name: "cooldown", duration: "1 hour" })),
  RaceThenApprove.toLayer(() =>
    DurableDeferred.raceAll({
      name: "FirstQuote",
      success: Schema.String,
      error: Schema.Never,
      effects: [Effect.succeed("quote")],
    }).pipe(Effect.andThen(DurableDeferred.await(ManagerApproval))),
  ),
  EscalateOrApprove.toLayer(() =>
    DurableDeferred.raceAll({
      name: "EscalationOrTimeout",
      success: Schema.Void,
      error: Schema.Never,
      effects: [DurableDeferred.await(Escalation), Effect.sleep("100 millis")],
    }).pipe(Effect.andThen(DurableDeferred.await(ManagerApproval))),
  ),
  ApproveOrEscalateThenSignoff.toLayer(() =>
    DurableDeferred.raceAll({
      name: "ApprovalOrEscalation",
      success: Schema.Void,
      error: Schema.Never,
      effects: [
        Effect.asVoid(DurableDeferred.await(ManagerApproval)),
        DurableDeferred.await(Escalation),
      ],
    }).pipe(Effect.andThen(DurableDeferred.await(Signoff))),
  ),
);

const runtime = (filename: string) =>
  workflows.pipe(
    Layer.provideMerge(Awaits.layer),
    Layer.provide(ClusterWorkflowEngine.layer),
    Layer.provide(SingleRunner.layer({ runnerStorage: "memory" })),
    Layer.provide(SqliteClient.layer({ filename })),
    Layer.provide(BunCrypto.layerDigest),
    Layer.orDie,
  );

const tempDb = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  return `${dir}/kymo.db`;
}).pipe(Effect.provide(BunFileSystem.layer));

const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, until: (a: A) => boolean) =>
  effect.pipe(
    Effect.repeat({ until, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("10 seconds"),
  );

const listFor = (executionId: string) =>
  Effect.flatMap(Awaits, (awaits) =>
    Effect.map(awaits.list, (all) => all.filter((entry) => entry.executionId === executionId)),
  );

const completed = (executionId: string) =>
  eventually(
    Approval.poll(executionId),
    (result) => Option.isSome(result) && result.value._tag === "Complete",
  );

const summary = (entry: Await) => ({
  _tag: entry._tag,
  executionId: entry.executionId,
  workflowName: entry.workflowName,
  name: entry.name,
});

describe("Awaits", () => {
  it.live("records a pending DurableDeferred and clears it when the deferred completes", () =>
    Effect.gen(function* () {
      const executionId = yield* Approval.execute({ id: "a" }, { discard: true });

      const pending = yield* eventually(listFor(executionId), (entries) => entries.length > 0);
      assert.deepStrictEqual(pending.map(summary), [
        { _tag: "Deferred", executionId, workflowName: "Approval", name: "ManagerApproval" },
      ]);
      const [entry] = pending;
      assert.strictEqual(entry?._tag === "Deferred" && entry.deferred.name, "ManagerApproval");

      yield* DurableDeferred.succeed(ManagerApproval, {
        token: DurableDeferred.tokenFromExecutionId(ManagerApproval, {
          workflow: Approval,
          executionId,
        }),
        value: { approved: true },
      });

      const result = yield* completed(executionId);
      assert.deepStrictEqual(
        Option.map(result, (r) => r._tag === "Complete" && r.exit),
        Option.some(Exit.succeed(true)),
      );
      assert.deepStrictEqual(yield* listFor(executionId), []);
    }).pipe(Effect.provide(Layer.unwrap(Effect.map(tempDb, runtime))), Effect.scoped),
  );

  it.live("records a durable clock under its unprefixed name", () =>
    Effect.gen(function* () {
      const executionId = yield* Cooldown.execute({ id: "c" }, { discard: true });

      const pending = yield* eventually(listFor(executionId), (entries) => entries.length > 0);
      assert.deepStrictEqual(pending.map(summary), [
        { _tag: "Clock", executionId, workflowName: "Cooldown", name: "cooldown" },
      ]);
    }).pipe(Effect.provide(Layer.unwrap(Effect.map(tempDb, runtime))), Effect.scoped),
  );

  it.live("keeps a wait after the cluster evicts the idle workflow entity", () =>
    Effect.gen(function* () {
      const executionId = yield* Approval.execute({ id: "e" }, { discard: true });
      yield* eventually(listFor(executionId), (entries) => entries.length > 0);

      yield* Effect.sleep("12 seconds");

      assert.deepStrictEqual((yield* listFor(executionId)).map(summary), [
        { _tag: "Deferred", executionId, workflowName: "Approval", name: "ManagerApproval" },
      ]);
    }).pipe(Effect.provide(Layer.unwrap(Effect.map(tempDb, runtime))), Effect.scoped),
  );

  it.live("does not report a durable race lookup as a wait", () =>
    Effect.gen(function* () {
      const executionId = yield* RaceThenApprove.execute({ id: "q" }, { discard: true });

      const pending = yield* eventually(listFor(executionId), (entries) => entries.length > 0);
      assert.deepStrictEqual(pending.map(summary), [
        { _tag: "Deferred", executionId, workflowName: "RaceThenApprove", name: "ManagerApproval" },
      ]);
    }).pipe(Effect.provide(Layer.unwrap(Effect.map(tempDb, runtime))), Effect.scoped),
  );

  it.live("drops a wait from a race branch that lost", () =>
    Effect.gen(function* () {
      const executionId = yield* EscalateOrApprove.execute({ id: "l" }, { discard: true });

      const pending = yield* eventually(listFor(executionId), (entries) =>
        entries.some((entry) => entry.name === "ManagerApproval"),
      );
      assert.deepStrictEqual(pending.map(summary), [
        {
          _tag: "Deferred",
          executionId,
          workflowName: "EscalateOrApprove",
          name: "ManagerApproval",
        },
      ]);
    }).pipe(Effect.provide(Layer.unwrap(Effect.map(tempDb, runtime))), Effect.scoped),
  );

  it.live("drops a wait from a race branch that lost once a completion resumes the run", () =>
    Effect.gen(function* () {
      const executionId = yield* ApproveOrEscalateThenSignoff.execute(
        { id: "x" },
        { discard: true },
      );
      yield* eventually(listFor(executionId), (entries) => entries.length === 2);

      yield* DurableDeferred.succeed(ManagerApproval, {
        token: DurableDeferred.tokenFromExecutionId(ManagerApproval, {
          workflow: ApproveOrEscalateThenSignoff,
          executionId,
        }),
        value: { approved: true },
      });

      const pending = yield* eventually(listFor(executionId), (entries) =>
        entries.some((entry) => entry.name === "Signoff"),
      );
      assert.deepStrictEqual(pending.map(summary), [
        {
          _tag: "Deferred",
          executionId,
          workflowName: "ApproveOrEscalateThenSignoff",
          name: "Signoff",
        },
      ]);
    }).pipe(Effect.provide(Layer.unwrap(Effect.map(tempDb, runtime))), Effect.scoped),
  );

  it.live("forgets a waiting execution once it is interrupted", () =>
    Effect.gen(function* () {
      const executionId = yield* Approval.execute({ id: "i" }, { discard: true });
      yield* eventually(listFor(executionId), (entries) => entries.length > 0);

      yield* Approval.interrupt(executionId);

      const result = yield* completed(executionId);
      assert.isTrue(
        Option.isSome(result) &&
          result.value._tag === "Complete" &&
          Exit.hasInterrupts(result.value.exit),
      );
      assert.deepStrictEqual(yield* listFor(executionId), []);
    }).pipe(Effect.provide(Layer.unwrap(Effect.map(tempDb, runtime))), Effect.scoped),
  );

  it.live("after a restart the wait reappears only once the execution is resumed", () =>
    Effect.gen(function* () {
      const filename = yield* tempDb;

      const first = yield* Scope.make();
      const executionId = yield* Effect.gen(function* () {
        const id = yield* Approval.execute({ id: "r" }, { discard: true });
        yield* eventually(listFor(id), (entries) => entries.length > 0);
        return id;
      }).pipe(Effect.provide(runtime(filename)), Scope.provide(first));
      yield* Scope.close(first, Exit.void);

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        const beforeResume = yield* listFor(executionId);
        assert.deepStrictEqual(beforeResume, []);

        yield* Approval.resume(executionId);
        const afterResume = yield* eventually(
          listFor(executionId),
          (entries) => entries.length > 0,
        );
        assert.deepStrictEqual(afterResume.map(summary), [
          { _tag: "Deferred", executionId, workflowName: "Approval", name: "ManagerApproval" },
        ]);

        yield* DurableDeferred.succeed(ManagerApproval, {
          token: DurableDeferred.tokenFromExecutionId(ManagerApproval, {
            workflow: Approval,
            executionId,
          }),
          value: { approved: false },
        });
        const result = yield* completed(executionId);
        assert.deepStrictEqual(
          Option.map(result, (r) => r._tag === "Complete" && r.exit),
          Option.some(Exit.succeed(false)),
        );
        assert.deepStrictEqual(yield* listFor(executionId), []);
      }).pipe(Effect.provide(runtime(filename)), Effect.scoped);
    }).pipe(Effect.scoped),
  );
});
