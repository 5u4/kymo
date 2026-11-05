import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as SqlClient from "effect/sql/SqlClient";
import { type ExecutionQuery, ExecutionStatus, type LogsQuery } from "kymo/api";
import { Awaits } from "../src/awaits.ts";
import { Executions, executionStatus } from "../src/executions.ts";
import * as Runtime from "../src/runtime.ts";
import { Double } from "./fixtures/double.ts";
import { Chatty } from "./fixtures/logs.ts";
import {
  AwaitChild,
  AwaitGate,
  bodyRuns,
  ChildThenGate,
  Defect,
  FailOnce,
  FailTyped,
  Gate,
  Interruptible,
  Nap,
  Quick,
  Stuck,
  Succeed,
  SuspendOnBoom,
} from "./fixtures/statuses.ts";
import { AwaitApproval, observed } from "./fixtures/service-schema.ts";
import { Ticker } from "./fixtures/ticker.ts";

const fixtures = `${import.meta.dirname}/fixtures`;

const tempDb = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return `${yield* fs.makeTempDirectoryScoped()}/kymo.db`;
}).pipe(Effect.provide(BunFileSystem.layer));

const runtime = (db: string, workflows: ReadonlyArray<string> = ["./statuses.ts"]) =>
  Runtime.layer({ root: fixtures, workflows, db }).pipe(Layer.orDie);

const daemon = Layer.unwrap(Effect.map(tempDb, (db) => runtime(db)));

const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, until: (a: A) => boolean) =>
  effect.pipe(
    Effect.repeat({ until, schedule: Schedule.spaced("50 millis") }),
    Effect.timeout("20 seconds"),
  );

const list = (query: ExecutionQuery) =>
  Effect.flatMap(Executions, (service) => service.list(query));

const statusOf = (id: string) =>
  Effect.map(
    Effect.flatMap(Executions, (service) => service.get(id)),
    (detail) => detail.status,
  );

const deferredGate: ExecutionStatus = {
  _tag: "Suspended",
  reason: { _tag: "Deferred", name: Option.some("Gate") },
};

const noWaits = { clock: Option.none(), openChild: Option.none(), deferred: Option.none() };

describe("executions", () => {
  it("reports the failure in a cause that also holds an interrupt", () => {
    assert.deepStrictEqual(
      executionStatus({
        ...noWaits,
        reply: Option.some({
          _tag: "Failure",
          cause: [{ _tag: "Interrupt" }, { _tag: "Fail", error: { _tag: "Boom", message: "x" } }],
        }),
      }),
      { _tag: "Failed", kind: "Fail", message: "Boom: x" },
    );
    assert.deepStrictEqual(
      executionStatus({
        ...noWaits,
        reply: Option.some({ _tag: "Failure", cause: [{ _tag: "Interrupt" }] }),
      }),
      { _tag: "Interrupted" },
    );
  });

  it.live(
    "derives every status, looks executions up by prefix and filters the list",
    () =>
      Effect.gen(function* () {
        const before = yield* DateTime.now;
        const ids = {
          succeed: yield* Succeed.execute({ id: "s" }, { discard: true }),
          failTyped: yield* FailTyped.execute({ id: "f" }, { discard: true }),
          defect: yield* Defect.execute({ id: "d" }, { discard: true }),
          interruptible: yield* Interruptible.execute({ id: "i" }, { discard: true }),
          suspendOnBoom: yield* SuspendOnBoom.execute({ id: "b" }, { discard: true }),
          awaitGate: yield* AwaitGate.execute({ id: "g" }, { discard: true }),
          nap: yield* Nap.execute({ id: "n" }, { discard: true }),
          awaitChild: yield* AwaitChild.execute({ id: "a" }, { discard: true }),
          childThenGate: yield* ChildThenGate.execute({ id: "t" }, { discard: true }),
          stuck: yield* Stuck.execute({ id: "r" }, { discard: true }),
        };
        const waitingChild = yield* AwaitGate.executionId({ id: "child-a" });
        const quickChild = yield* Quick.executionId({ id: "child-t" });

        yield* eventually(statusOf(ids.interruptible), (status) => status._tag === "Suspended");
        yield* Interruptible.interrupt(ids.interruptible);

        const expected = new Map<string, ExecutionStatus>([
          [ids.succeed, { _tag: "Succeeded" }],
          [ids.failTyped, { _tag: "Failed", kind: "Fail", message: 'Boom {"reason":"typed"}' }],
          [ids.defect, { _tag: "Failed", kind: "Die", message: "Error: kaboom" }],
          [ids.interruptible, { _tag: "Interrupted" }],
          [ids.suspendOnBoom, { _tag: "Suspended", reason: { _tag: "Failure", cause: "Boom" } }],
          [ids.awaitGate, deferredGate],
          [
            ids.awaitChild,
            { _tag: "Suspended", reason: { _tag: "Child", executionId: waitingChild } },
          ],
          [waitingChild, deferredGate],
          [ids.childThenGate, deferredGate],
          [quickChild, { _tag: "Succeeded" }],
          [ids.stuck, { _tag: "Running" }],
        ]);
        const encode = Schema.encodeSync(
          Schema.fromJsonString(Schema.UndefinedOr(ExecutionStatus)),
        );
        const settled = yield* eventually(list({}), ({ executions }) =>
          executions.every(
            (execution) =>
              execution.id === ids.nap ||
              encode(execution.status) === encode(expected.get(execution.id)),
          ),
        );
        const after = yield* DateTime.now;

        assert.strictEqual(settled.total, 12);
        assert.strictEqual(settled.executions.length, 12);
        for (const execution of settled.executions) {
          if (execution.id === ids.nap) {
            assert.strictEqual(execution.status._tag, "Suspended");
            const reason = execution.status._tag === "Suspended" ? execution.status.reason : null;
            assert.strictEqual(reason?._tag, "Clock");
            if (reason?._tag === "Clock") {
              assert.strictEqual(reason.name, "nap");
              const wakeAt = DateTime.toEpochMillis(reason.wakeAt);
              assert.isAtLeast(wakeAt, DateTime.toEpochMillis(before) + 2 * 60 * 60 * 1000);
              assert.isAtMost(wakeAt, DateTime.toEpochMillis(after) + 2 * 60 * 60 * 1000);
            }
          } else {
            assert.deepStrictEqual(
              execution.status,
              expected.get(execution.id),
              execution.workflow,
            );
          }
        }

        const byId = new Map(settled.executions.map((execution) => [execution.id, execution]));
        assert.deepStrictEqual(byId.get(ids.succeed)?.idempotencyKey, Option.some("s"));
        assert.deepStrictEqual(byId.get(waitingChild)?.idempotencyKey, Option.some("child-a"));
        assert.deepStrictEqual(byId.get(waitingChild)?.parentId, Option.some(ids.awaitChild));
        assert.deepStrictEqual(byId.get(ids.awaitChild)?.parentId, Option.none());
        assert.deepStrictEqual(byId.get(ids.stuck)?.updatedAt, Option.none());
        assert.strictEqual(byId.get(ids.succeed)?.updatedAt._tag, "Some");
        const startedAt = settled.executions.map((execution) =>
          DateTime.toEpochMillis(execution.startedAt),
        );
        assert.deepStrictEqual(
          startedAt,
          startedAt.toSorted((a, b) => b - a),
          "newest first",
        );
        for (const time of startedAt) {
          assert.isAtLeast(time, DateTime.toEpochMillis(before));
          assert.isAtMost(time, DateTime.toEpochMillis(after));
        }

        const executions = yield* Executions;
        const gate = yield* executions.get(ids.awaitGate);
        assert.deepStrictEqual(gate.payload, { id: "g" });
        assert.deepStrictEqual(
          gate.activities.map(({ name, attempt, status }) => ({ name, attempt, status })),
          [{ name: "AwaitGate.step", attempt: 1, status: { _tag: "Succeeded" } }],
        );
        assert.isTrue(Option.isSome(gate.activities[0]?.endedAt ?? Option.none()));
        assert.deepStrictEqual(
          gate.waits.map(({ kind, name }) => ({ kind, name })),
          [{ kind: "Deferred", name: "Gate" }],
        );
        assert.deepStrictEqual(gate.children, []);
        assert.deepStrictEqual((yield* executions.get(ids.awaitChild)).children, [waitingChild]);
        assert.deepStrictEqual(
          (yield* executions.get(waitingChild)).payload,
          { id: "child-a" },
          "the parent key is dropped from the payload",
        );
        const stuck = yield* executions.get(ids.stuck);
        assert.deepStrictEqual(
          stuck.activities.map(({ name, status, endedAt }) => ({ name, status, endedAt })),
          [{ name: "Stuck.never", status: { _tag: "Running" }, endedAt: Option.none() }],
        );

        const quick = [];
        for (let index = 0; index < 17; index++) {
          quick.push(yield* Quick.execute({ id: `q${index}` }, { discard: true }));
        }
        const all = yield* eventually(list({}), ({ total }) => total === 29);
        const allIds = all.executions.map((execution) => execution.id);

        const shortest = Array.from({ length: ids.succeed.length }, (_, index) =>
          ids.succeed.slice(0, index + 1),
        ).find((prefix) => allIds.filter((id) => id.startsWith(prefix)).length === 1);
        assert.isDefined(shortest);
        assert.isBelow(shortest?.length ?? Infinity, ids.succeed.length);
        assert.strictEqual((yield* executions.get(shortest ?? "")).id, ids.succeed);
        assert.strictEqual((yield* executions.get(ids.succeed)).id, ids.succeed);

        const shared = "0123456789abcdef"
          .split("")
          .find((digit) => allIds.filter((id) => id.startsWith(digit)).length > 1);
        assert.isDefined(shared, "17 or more hex ids share a first digit");
        const ambiguous = yield* Effect.flip(executions.get(shared ?? ""));
        assert.strictEqual(ambiguous._tag, "AmbiguousExecutionId");
        if (ambiguous._tag === "AmbiguousExecutionId") {
          assert.deepStrictEqual(
            ambiguous.candidates.toSorted(),
            allIds.filter((id) => id.startsWith(shared ?? "")).toSorted(),
          );
        }
        const missing = yield* Effect.flip(executions.get("not-an-id"));
        assert.strictEqual(missing._tag, "ExecutionNotFound");

        const quickList = yield* list({ workflow: "Quick" });
        assert.strictEqual(quickList.total, 18);
        const limited = yield* list({ workflow: "Quick", limit: 3 });
        assert.strictEqual(limited.total, 18);
        assert.deepStrictEqual(
          limited.executions.map((execution) => execution.id),
          quick.slice(-3).toReversed(),
        );

        const suspended = yield* list({ status: "suspended" });
        assert.deepStrictEqual(
          suspended.executions.map((execution) => execution.id).toSorted(),
          [
            ids.suspendOnBoom,
            ids.awaitGate,
            ids.nap,
            ids.awaitChild,
            waitingChild,
            ids.childThenGate,
          ].toSorted(),
        );
        assert.strictEqual(suspended.total, 6);
        assert.deepStrictEqual(
          (yield* list({ status: "failed" })).executions
            .map((execution) => execution.id)
            .toSorted(),
          [ids.failTyped, ids.defect].toSorted(),
        );
        assert.deepStrictEqual(
          (yield* list({ workflow: "AwaitGate", status: "suspended" })).executions
            .map((execution) => execution.id)
            .toSorted(),
          [ids.awaitGate, waitingChild].toSorted(),
        );
      }).pipe(Effect.provide(daemon), Effect.scoped),
    60_000,
  );

  it.live(
    "concurrent executes of one idempotency key create it once with the creator's label",
    () =>
      Effect.gen(function* () {
        const executions = yield* Executions;
        const requests = [undefined, "l1", "l2", "l3", "l4"].map((label) => ({
          workflow: "AwaitGate",
          payload: { id: "race" },
          label,
        }));
        const results = yield* Effect.forEach(requests, (request) => executions.execute(request), {
          concurrency: "unbounded",
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8));
        const creators = requests.filter((_, index) => results[index]?.created === true);
        assert.strictEqual(creators.length, 1, results.map(({ created }) => created).join(","));
        const detail = yield* executions.get(yield* AwaitGate.executionId({ id: "race" }));
        assert.deepStrictEqual(detail.label, Option.fromUndefinedOr(creators[0]?.label));
      }).pipe(Effect.provide(daemon), Effect.scoped),
    60_000,
  );

  it.live(
    "a created execution replaces a label orphaned by an execute that never persisted its run",
    () =>
      Effect.gen(function* () {
        const executions = yield* Executions;
        const sql = yield* SqlClient.SqlClient;
        const relabeled = yield* AwaitGate.executionId({ id: "relabeled" });
        const unlabeled = yield* AwaitGate.executionId({ id: "unlabeled" });
        yield* sql`
          INSERT INTO kymo_labels (execution_id, label)
          VALUES (${relabeled}, 'orphan'), (${unlabeled}, 'orphan')
        `;
        const first = yield* executions.execute({
          workflow: "AwaitGate",
          payload: { id: "relabeled" },
          label: "fresh",
        });
        assert.strictEqual(first.created, true);
        assert.deepStrictEqual(first.execution.label, Option.some("fresh"));
        const second = yield* executions.execute({
          workflow: "AwaitGate",
          payload: { id: "unlabeled" },
        });
        assert.strictEqual(second.created, true);
        assert.deepStrictEqual(second.execution.label, Option.none());
      }).pipe(Effect.provide(daemon), Effect.scoped),
    60_000,
  );

  it.live(
    "startup resumes waiting executions and leaves failed suspends and finished runs alone",
    () =>
      Effect.gen(function* () {
        const db = yield* tempDb;
        const first = yield* Scope.make();
        const { ids, before } = yield* Effect.gen(function* () {
          const ids = {
            awaitGate: yield* AwaitGate.execute({ id: "g" }, { discard: true }),
            nap: yield* Nap.execute({ id: "n" }, { discard: true }),
            awaitChild: yield* AwaitChild.execute({ id: "a" }, { discard: true }),
            suspendOnBoom: yield* SuspendOnBoom.execute({ id: "b" }, { discard: true }),
            succeed: yield* Succeed.execute({ id: "s" }, { discard: true }),
            double: yield* Double.execute({ n: 2 }, { discard: true }),
          };
          const before = yield* eventually(
            list({}),
            ({ executions, total }) =>
              total === 7 && executions.every((execution) => execution.status._tag !== "Running"),
          );
          return { ids, before };
        }).pipe(
          Effect.provide(runtime(db, ["./statuses.ts", "./double.ts"])),
          Scope.provide(first),
        );
        yield* Scope.close(first, Exit.void);
        const waitingChild = yield* AwaitGate.executionId({ id: "child-a" });
        const runsBefore = new Map(bodyRuns);
        const updatedBefore = new Map(
          before.executions.map((execution) => [execution.id, execution.updatedAt]),
        );

        yield* Effect.gen(function* () {
          const waits = yield* eventually(
            Effect.flatMap(Awaits, (awaits) => awaits.list),
            (entries) => entries.length === 3,
          );
          assert.deepStrictEqual(
            waits
              .map(({ _tag, executionId, name }) => ({ _tag, executionId, name }))
              .toSorted((a, b) => a.executionId.localeCompare(b.executionId)),
            [
              { _tag: "Deferred", executionId: ids.awaitGate, name: "Gate" },
              { _tag: "Clock", executionId: ids.nap, name: "nap" },
              { _tag: "Deferred", executionId: waitingChild, name: "Gate" },
            ].toSorted((a, b) => a.executionId.localeCompare(b.executionId)),
          );
          assert.strictEqual(bodyRuns.get("AwaitGate"), (runsBefore.get("AwaitGate") ?? 0) + 2);
          assert.strictEqual(bodyRuns.get("Nap"), (runsBefore.get("Nap") ?? 0) + 1);
          assert.strictEqual(bodyRuns.get("SuspendOnBoom"), runsBefore.get("SuspendOnBoom"));
          assert.strictEqual(bodyRuns.get("Succeed"), runsBefore.get("Succeed"));

          const after = yield* list({});
          const byId = new Map(after.executions.map((execution) => [execution.id, execution]));
          assert.deepStrictEqual(byId.get(ids.suspendOnBoom)?.status, {
            _tag: "Suspended",
            reason: { _tag: "Failure", cause: "Boom" },
          });
          for (const id of [ids.suspendOnBoom, ids.succeed, ids.double]) {
            assert.deepStrictEqual(byId.get(id)?.updatedAt, updatedBefore.get(id), id);
          }
          assert.deepStrictEqual(byId.get(ids.double)?.status, { _tag: "Succeeded" });
          assert.deepStrictEqual(byId.get(ids.double)?.idempotencyKey, Option.none());
          assert.deepStrictEqual(byId.get(ids.awaitChild)?.status, {
            _tag: "Suspended",
            reason: { _tag: "Child", executionId: waitingChild },
          });

          yield* DurableDeferred.succeed(Gate, {
            token: DurableDeferred.tokenFromExecutionId(Gate, {
              workflow: AwaitGate,
              executionId: waitingChild,
            }),
            value: "open",
          });
          yield* eventually(statusOf(ids.awaitChild), (status) => status._tag === "Succeeded");
        }).pipe(Effect.provide(runtime(db)), Effect.scoped);
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "complete continues a waiting execution, resume reruns a failed suspend, interrupt ends a wait",
    () =>
      Effect.gen(function* () {
        const executions = yield* Executions;
        const ids = {
          gate: yield* AwaitGate.execute({ id: "complete" }, { discard: true }),
          nap: yield* Nap.execute({ id: "nap" }, { discard: true }),
          failOnce: yield* FailOnce.execute({ id: "resume" }, { discard: true }),
          interrupted: yield* AwaitGate.execute({ id: "interrupt" }, { discard: true }),
        };
        yield* eventually(list({}), ({ executions }) =>
          executions.every(({ status }) => status._tag === "Suspended"),
        );

        const notGate = yield* Effect.flip(
          executions.complete(ids.gate, { name: "Other", value: "x" }),
        );
        assert.deepInclude(notGate, { _tag: "NotWaiting", waiting: ["Gate"] });
        const clock = yield* Effect.flip(
          executions.complete(ids.nap, { name: "nap", value: null }),
        );
        assert.deepInclude(clock, { _tag: "NotWaiting", waiting: [] });
        const invalid = yield* Effect.flip(
          executions.complete(ids.gate, { name: "Gate", value: 1 }),
        );
        assert.strictEqual(invalid._tag, "InvalidValue");
        const resumeWaiting = yield* Effect.flip(executions.resume(ids.gate));
        assert.deepInclude(resumeWaiting, { _tag: "ActionNotAllowed", action: "resume" });

        const completed = yield* executions.complete(ids.gate.slice(0, 12), {
          name: "Gate",
          value: "open",
        });
        assert.strictEqual(completed.id, ids.gate);
        yield* eventually(statusOf(ids.gate), (status) => status._tag === "Succeeded");
        const again = yield* Effect.flip(
          executions.complete(ids.gate, { name: "Gate", value: "again" }),
        );
        assert.deepInclude(again, { _tag: "NotWaiting", waiting: [] });

        yield* executions.resume(ids.failOnce);
        yield* eventually(statusOf(ids.failOnce), (status) => status._tag === "Succeeded");

        yield* executions.interrupt(ids.interrupted);
        yield* eventually(statusOf(ids.interrupted), (status) => status._tag === "Interrupted");
        const ended = yield* Effect.flip(executions.interrupt(ids.interrupted));
        assert.deepInclude(ended, {
          _tag: "ActionNotAllowed",
          action: "interrupt",
          status: { _tag: "Interrupted" },
        });
      }).pipe(Effect.provide(daemon), Effect.scoped),
    60_000,
  );

  it.live(
    "complete decodes a value whose schema needs a service only the workflow source provides",
    () =>
      Effect.gen(function* () {
        const executions = yield* Executions;
        const id = yield* AwaitApproval.execute({ id: "approval" }, { discard: true });
        yield* eventually(statusOf(id), (status) => status._tag === "Suspended");

        yield* executions.complete(id, { name: "Approval", value: "yes" });
        yield* eventually(statusOf(id), (status) => status._tag === "Succeeded");
        assert.strictEqual(observed.get("approval"), "svc:yes");
      }).pipe(
        Effect.provide(
          Layer.unwrap(Effect.map(tempDb, (db) => runtime(db, ["./service-schema.ts"]))),
        ),
        Effect.scoped,
      ),
    60_000,
  );

  it.live(
    "execute, list and get decode a payload whose schema needs a service only the workflow source provides",
    () =>
      Effect.gen(function* () {
        const executions = yield* Executions;
        const { execution, created } = yield* executions.execute({
          workflow: "Greet",
          payload: { name: "bob" },
        });
        assert.isTrue(created);
        assert.deepStrictEqual(execution.idempotencyKey, Option.some("svc:bob"));
        yield* eventually(statusOf(execution.id), (status) => status._tag === "Succeeded");
        assert.strictEqual(observed.get("greet"), "svc:bob");

        const listed = yield* list({ workflow: "Greet" });
        assert.deepStrictEqual(
          listed.executions.map(({ idempotencyKey }) => idempotencyKey),
          [Option.some("svc:bob")],
        );
        assert.deepStrictEqual(
          (yield* executions.get(execution.id)).idempotencyKey,
          Option.some("svc:bob"),
        );
      }).pipe(
        Effect.provide(
          Layer.unwrap(Effect.map(tempDb, (db) => runtime(db, ["./service-schema.ts"]))),
        ),
        Effect.scoped,
      ),
    60_000,
  );

  it.live(
    "stores body and activity logs per pass, numbering passes on across a restart",
    () =>
      Effect.gen(function* () {
        const db = yield* tempDb;
        const logsOf = (id: string, query: LogsQuery = {}) =>
          Effect.map(
            Effect.flatMap(Executions, (service) => service.logs(id, query)),
            ({ counts, logs }) => ({
              total: counts.reduce((sum, { count }) => sum + count, 0),
              seqs: logs.map(({ seq }) => seq),
              causes: logs.map(({ cause }) => cause),
              lines: logs.map(({ pass, level, message, source }) => ({
                pass,
                level,
                message,
                source: source._tag === "Body" ? "body" : `${source.name}#${source.attempt}`,
              })),
            }),
          );
        const firstPass = [
          { pass: 1, level: "Info", message: "body start", source: "body" },
          { pass: 1, level: "Info", message: "flaky attempt 1", source: "Chatty.flaky#1" },
          { pass: 1, level: "Info", message: "flaky attempt 2", source: "Chatty.flaky#2" },
          { pass: 1, level: "Warn", message: "waiting for approval", source: "body" },
        ];

        const first = yield* Scope.make();
        const restarted = yield* Effect.gen(function* () {
          const executions = yield* Executions;
          const completed = yield* Chatty.execute({ id: "completed" }, { discard: true });
          const restarted = yield* Chatty.execute({ id: "restarted" }, { discard: true });
          for (const id of [completed, restarted]) {
            const waiting = yield* eventually(logsOf(id), ({ total }) => total >= 4);
            assert.deepStrictEqual(waiting.lines, firstPass, id);
          }

          yield* executions.complete(completed, { name: "Approval", value: "ann" });
          yield* eventually(statusOf(completed), (status) => status._tag === "Succeeded");
          const done = yield* eventually(logsOf(completed), ({ total }) => total >= 7);
          assert.deepStrictEqual(done.lines, [
            ...firstPass,
            { pass: 2, level: "Info", message: "body start", source: "body" },
            { pass: 2, level: "Warn", message: "waiting for approval", source: "body" },
            { pass: 2, level: "Error", message: "approved by ann", source: "body" },
          ]);
          assert.deepStrictEqual(
            done.seqs,
            done.seqs.toSorted((a, b) => a - b),
          );
          assert.match(
            Option.getOrElse(done.causes[6] ?? Option.none(), () => ""),
            /audit/,
          );
          assert.deepStrictEqual(done.causes.slice(0, 6), Array(6).fill(Option.none()));

          const last = yield* logsOf(completed.slice(0, 10), { limit: 2 });
          assert.strictEqual(last.total, 7);
          assert.deepStrictEqual(last.lines, done.lines.slice(-2));
          const missing = yield* Effect.flip(
            Effect.flatMap(Executions, (service) => service.logs("not-an-id", {})),
          );
          assert.strictEqual(missing._tag, "ExecutionNotFound");
          return restarted;
        }).pipe(Effect.provide(runtime(db, ["./logs.ts"])), Scope.provide(first));
        yield* Scope.close(first, Exit.void);

        yield* Effect.gen(function* () {
          const executions = yield* Executions;
          const replayed = yield* eventually(logsOf(restarted), ({ total }) => total >= 6);
          assert.deepStrictEqual(replayed.lines.slice(4), [
            { pass: 2, level: "Info", message: "body start", source: "body" },
            { pass: 2, level: "Warn", message: "waiting for approval", source: "body" },
          ]);
          yield* executions.complete(restarted, { name: "Approval", value: "bob" });
          const done = yield* eventually(logsOf(restarted), ({ total }) => total >= 9);
          assert.deepStrictEqual(done.lines.slice(6), [
            { pass: 3, level: "Info", message: "body start", source: "body" },
            { pass: 3, level: "Warn", message: "waiting for approval", source: "body" },
            { pass: 3, level: "Error", message: "approved by bob", source: "body" },
          ]);
        }).pipe(Effect.provide(runtime(db, ["./logs.ts"])), Effect.scoped);
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "counts every log line per source and level, including lines outside the limit",
    () =>
      Effect.gen(function* () {
        const executions = yield* Executions;
        const id = yield* Chatty.execute({ id: "counted" }, { discard: true });
        yield* eventually(
          Effect.map(executions.logs(id, {}), ({ logs }) => logs.length),
          (lines) => lines >= 4,
        );
        yield* executions.complete(id, { name: "Approval", value: "ann" });
        yield* eventually(
          Effect.map(executions.logs(id, {}), ({ logs }) => logs.length),
          (lines) => lines >= 7,
        );
        const { counts, logs } = yield* executions.logs(id, { limit: 2 });
        assert.strictEqual(logs.length, 2);
        assert.deepStrictEqual(counts, [
          { source: { _tag: "Body" }, level: "Error", count: 1 },
          { source: { _tag: "Body" }, level: "Info", count: 2 },
          { source: { _tag: "Body" }, level: "Warn", count: 2 },
          {
            source: { _tag: "Activity", name: "Chatty.flaky", attempt: 1 },
            level: "Info",
            count: 1,
          },
          {
            source: { _tag: "Activity", name: "Chatty.flaky", attempt: 2 },
            level: "Info",
            count: 1,
          },
        ]);
      }).pipe(
        Effect.provide(Layer.unwrap(Effect.map(tempDb, (db) => runtime(db, ["./logs.ts"])))),
        Effect.scoped,
      ),
    60_000,
  );

  it.live(
    "reports log counts that sum to the lines it returns while the execution keeps logging",
    () =>
      Effect.gen(function* () {
        const executions = yield* Executions;
        const id = yield* Ticker.executionId({ id: "ticker" });
        let ticking = true;
        yield* Ticker.execute({ id: "ticker" }).pipe(
          Effect.ensuring(Effect.sync(() => (ticking = false))),
          Effect.forkChild,
        );
        const mismatches: Array<string> = [];
        yield* Effect.forEach(
          Array.from({ length: 16 }, (_, reader) => reader),
          () =>
            Effect.gen(function* () {
              while (ticking) {
                const { counts, logs } = yield* executions.logs(id, {});
                const total = counts.reduce((sum, { count }) => sum + count, 0);
                if (logs.length !== total) {
                  mismatches.push(`${logs.length} lines, total ${total}`);
                }
              }
            }),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8));
        assert.deepStrictEqual(mismatches, []);
      }).pipe(
        Effect.provide(Layer.unwrap(Effect.map(tempDb, (db) => runtime(db, ["./ticker.ts"])))),
        Effect.scoped,
      ),
    60_000,
  );
});
