import type * as Layer from "effect/Layer";
import type * as Workflow from "effect/workflow/Workflow";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";

export interface Plugin<E = never> {
  readonly name: string;
  readonly workflows: ReadonlyArray<Workflow.Any>;
  readonly layer: Layer.Layer<never, E, WorkflowEngine.WorkflowEngine>;
}

export const make = <E>(plugin: Plugin<E>): Plugin<E> => plugin;
