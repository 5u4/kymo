import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Workflow from "effect/workflow/Workflow";
import type { Workflows } from "kymo/workflows";

const OddName = Workflow.make("-odd name", {
  payload: { id: Schema.String },
  idempotencyKey: ({ id }) => id,
});

const seed = Effect.forEach(["a", "b"], (id) => OddName.execute({ id }, { discard: true }), {
  discard: true,
});

export default Layer.mergeAll(
  OddName.toLayer(() => Effect.void),
  Layer.effectDiscard(Effect.forkScoped(seed)),
) satisfies Workflows;
