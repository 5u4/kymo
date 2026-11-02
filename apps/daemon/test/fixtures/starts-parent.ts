import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Workflows } from "kymo/workflows";
import { Parent } from "./definitions.ts";

export default Layer.effectDiscard(
  Effect.forkScoped(Parent.execute({ id: "startup" }, { discard: true })).pipe(
    Effect.andThen(Effect.sleep("1 second")),
  ),
) satisfies Workflows;
