import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Activity from "effect/workflow/Activity";
import * as DurableClock from "effect/workflow/DurableClock";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Workflow from "effect/workflow/Workflow";
import type { Workflows } from "kymo/workflows";

export class Boom extends Schema.TaggedError<Boom>()("Boom", { reason: Schema.String }) {}

export const Gate = DurableDeferred.make("Gate", { success: Schema.String });

const make = <const Name extends string>(name: Name) =>
  Workflow.make(name, {
    payload: { id: Schema.String },
    error: Boom,
    idempotencyKey: ({ id }) => id,
  });

export const Succeed = make("Succeed");
export const FailTyped = make("FailTyped");
export const Defect = make("Defect");
export const Interruptible = make("Interruptible");
export const SuspendOnBoom = make("SuspendOnBoom").annotate(Workflow.SuspendOnFailure, true);
export const AwaitGate = make("AwaitGate");
export const Nap = make("Nap");
export const AwaitChild = make("AwaitChild");
export const ChildThenGate = make("ChildThenGate");
export const Stuck = make("Stuck");
export const Quick = make("Quick");
export const FailOnce = make("FailOnce").annotate(Workflow.SuspendOnFailure, true);

export const bodyRuns = new Map<string, number>();

const body = (name: string) =>
  Effect.sync(() => {
    bodyRuns.set(name, (bodyRuns.get(name) ?? 0) + 1);
  });

const failOnceRuns = new Map<string, number>();

const step = (name: string) => Activity.make({ name, execute: Effect.void });

export default Layer.mergeAll(
  Succeed.toLayer(() => body("Succeed").pipe(Effect.andThen(step("Succeed.step")))),
  FailTyped.toLayer(() =>
    body("FailTyped").pipe(Effect.andThen(Effect.fail(new Boom({ reason: "typed" })))),
  ),
  Defect.toLayer(() => body("Defect").pipe(Effect.andThen(Effect.die(new Error("kaboom"))))),
  Interruptible.toLayer(() =>
    body("Interruptible").pipe(Effect.andThen(DurableDeferred.await(Gate)), Effect.asVoid),
  ),
  SuspendOnBoom.toLayer(() =>
    body("SuspendOnBoom").pipe(
      Effect.andThen(step("SuspendOnBoom.step")),
      Effect.andThen(Effect.fail(new Boom({ reason: "suspend" }))),
    ),
  ),
  AwaitGate.toLayer(() =>
    body("AwaitGate").pipe(
      Effect.andThen(step("AwaitGate.step")),
      Effect.andThen(DurableDeferred.await(Gate)),
      Effect.asVoid,
    ),
  ),
  Nap.toLayer(() =>
    body("Nap").pipe(
      Effect.andThen(DurableClock.sleep({ name: "nap", duration: "2 hours" })),
      Effect.asVoid,
    ),
  ),
  AwaitChild.toLayer(({ id }) =>
    body("AwaitChild").pipe(Effect.andThen(AwaitGate.execute({ id: `child-${id}` }))),
  ),
  ChildThenGate.toLayer(({ id }) =>
    body("ChildThenGate").pipe(
      Effect.andThen(Quick.execute({ id: `child-${id}` })),
      Effect.andThen(DurableDeferred.await(Gate)),
      Effect.asVoid,
    ),
  ),
  Stuck.toLayer(() =>
    body("Stuck").pipe(
      Effect.andThen(Activity.make({ name: "Stuck.never", execute: Effect.never })),
    ),
  ),
  Quick.toLayer(() => body("Quick")),
  FailOnce.toLayer(({ id }) =>
    Effect.suspend(() => {
      const runs = (failOnceRuns.get(id) ?? 0) + 1;
      failOnceRuns.set(id, runs);
      return runs === 1 ? Effect.fail(new Boom({ reason: "first run" })) : Effect.void;
    }),
  ),
) satisfies Workflows;
