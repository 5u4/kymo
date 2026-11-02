import type { Workflows } from "kymo/workflows";
import { Child, Parent } from "./definitions.ts";

export default Parent.toLayer(({ id }) => Child.execute({ id })) satisfies Workflows;
