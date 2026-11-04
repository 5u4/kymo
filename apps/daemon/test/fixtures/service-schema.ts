import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Workflow from "effect/workflow/Workflow";
import type { Workflows } from "kymo/workflows";

export class Prefix extends Context.Service<Prefix, string>()("@kymo/test/Prefix") {}

const Prefixed = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformEffect((value: string) =>
      Effect.map(Effect.service(Prefix), (prefix) => `${prefix}${value}`),
    ),
    encode: SchemaGetter.transformEffect((value: string) =>
      Effect.map(Effect.service(Prefix), (prefix) => value.slice(prefix.length)),
    ),
  }),
);

export const Approval = DurableDeferred.make("Approval", { success: Prefixed });

export const AwaitApproval = Workflow.make("AwaitApproval", {
  payload: { id: Schema.String },
  idempotencyKey: ({ id }) => id,
});

const Greet = Workflow.make("Greet", {
  payload: { name: Prefixed },
  idempotencyKey: ({ name }) => name,
});

export const observed = new Map<string, string>();

export default Layer.mergeAll(
  AwaitApproval.toLayer(({ id }) =>
    Effect.map(DurableDeferred.await(Approval), (value) => {
      observed.set(id, value);
    }),
  ),
  Greet.toLayer(({ name }) =>
    Effect.sync(() => {
      observed.set("greet", name);
    }),
  ),
).pipe(Layer.provide(Layer.succeed(Prefix, "svc:"))) satisfies Workflows;
