import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Workflow from "effect/workflow/Workflow";
import type { Workflows } from "kymo/workflows";

export const Double = Workflow.make("Double", {
  payload: { n: Schema.Int },
  success: Schema.Int,
  idempotencyKey: ({ n }) => String(n),
});

export default Double.toLayer(({ n }) => Effect.succeed(n * 2)) satisfies Workflows;
