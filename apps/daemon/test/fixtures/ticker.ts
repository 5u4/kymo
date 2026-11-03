import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Workflow from "effect/workflow/Workflow";
import type { Workflows } from "kymo/workflows";

export const Ticker = Workflow.make("Ticker", {
  payload: { id: Schema.String },
  idempotencyKey: ({ id }) => id,
});

export default Ticker.toLayer(() =>
  Effect.log("tick").pipe(Effect.andThen(Effect.sleep("10 millis")), Effect.repeat({ times: 199 })),
) satisfies Workflows;
