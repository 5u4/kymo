import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Workflows } from "kymo/workflows";
import statuses, { AwaitGate, FailTyped, Nap, Quick, Succeed } from "./statuses.ts";

const seed = Effect.all(
  [
    Succeed.execute({ id: "s" }, { discard: true }),
    FailTyped.execute({ id: "f" }, { discard: true }),
    AwaitGate.execute({ id: "g" }, { discard: true }),
    Nap.execute({ id: "n" }, { discard: true }),
    ...Array.from({ length: 17 }, (_, index) =>
      Quick.execute({ id: `q${index}` }, { discard: true }),
    ),
  ],
  { discard: true },
);

export default Layer.mergeAll(
  statuses,
  Layer.effectDiscard(Effect.forkScoped(seed)),
) satisfies Workflows;
