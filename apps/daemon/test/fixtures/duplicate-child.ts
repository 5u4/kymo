import * as Effect from "effect/Effect";
import type { Workflows } from "kymo/workflows";
import { Child } from "./definitions.ts";

export default Child.toLayer(({ id }) => Effect.succeed(`duplicate:${id}`)) satisfies Workflows;
