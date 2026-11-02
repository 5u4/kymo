import * as Schema from "effect/Schema";
import * as Workflow from "effect/workflow/Workflow";

export const Child = Workflow.make("Child", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

export const Parent = Workflow.make("Parent", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});
