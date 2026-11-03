import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Activity from "effect/workflow/Activity";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Workflow from "effect/workflow/Workflow";
import type { Workflows } from "kymo/workflows";

export const Approval = DurableDeferred.make("Approval", { success: Schema.String });

export const Chatty = Workflow.make("Chatty", {
  payload: { id: Schema.String },
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
});

const bodyHelper = Effect.fn("bodyHelper")(function* (message: string) {
  yield* Effect.log(message);
});

const helper = Effect.fn("helper")(function* (attempt: number) {
  yield* Effect.log(`flaky attempt ${attempt}`);
});

export default Chatty.toLayer(() =>
  Effect.gen(function* () {
    yield* bodyHelper("body start");
    yield* Activity.make({
      name: "Chatty.flaky",
      error: Schema.String,
      execute: Effect.gen(function* () {
        const attempt = yield* Activity.CurrentAttempt;
        yield* helper(attempt);
        if (attempt === 1) {
          return yield* Effect.fail("first attempt fails");
        }
      }),
    }).pipe(Activity.retry({ times: 2 }));
    yield* Effect.logWarning("waiting for approval");
    const approval = yield* DurableDeferred.await(Approval);
    yield* Effect.logError(`approved by ${approval}`, Cause.fail("audit"));
  }),
) satisfies Workflows;
