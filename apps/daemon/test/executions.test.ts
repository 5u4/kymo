import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { type ExecutionQuery, ExecutionStatus } from "kymo/api";
import { Executions } from "../src/executions.ts";
import * as Runtime from "../src/runtime.ts";
import {
  AwaitChild,
  AwaitGate,
  ChildThenGate,
  Defect,
  FailTyped,
  Interruptible,
  Nap,
  Quick,
  Stuck,
  Succeed,
  SuspendOnBoom,
} from "./fixtures/statuses.ts";

const fixtures = `${import.meta.dirname}/fixtures`;

const tempDb = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return `${yield* fs.makeTempDirectoryScoped()}/kymo.db`;
}).pipe(Effect.provide(BunFileSystem.layer));

const daemon = Layer.unwrap(
  Effect.map(tempDb, (db) =>
    Runtime.layer({ root: fixtures, workflows: ["./statuses.ts"], db }).pipe(Layer.orDie),
  ),
);

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

describe("executions", () => {
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
        assert.deepStrictEqual(byId.get(ids.succeed)?.label, Option.some("s"));
        assert.deepStrictEqual(byId.get(waitingChild)?.label, Option.some("child-a"));
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
});
