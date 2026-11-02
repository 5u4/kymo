import * as Layer from "effect/Layer";
import type { Workflows } from "kymo/workflows";
import * as GitHub from "./github.ts";
import * as WaitForMerge from "./wait-for-merge.ts";

export default WaitForMerge.layer.pipe(Layer.provide(GitHub.GitHub.layer)) satisfies Workflows;
