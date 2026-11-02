import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";

export type Workflows = Layer.Layer<
  never,
  unknown,
  | WorkflowEngine.WorkflowEngine
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
>;
