import * as BunServices from "@effect/platform-bun/BunServices";
import * as Config from "effect/Config";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type { Workflows } from "kymo/workflows";

export class WorkflowSourceError extends Schema.TaggedError<WorkflowSourceError>()(
  "WorkflowSourceError",
  {
    source: Schema.String,
    reason: Schema.Literals(["Import", "NotALayer", "Build"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    switch (this.reason) {
      case "Import":
        return `workflow source ${this.source} could not be imported`;
      case "NotALayer":
        return `workflow source ${this.source} does not default-export a Layer`;
      case "Build":
        return `workflow source ${this.source} failed to build`;
    }
  }
}

export class DuplicateWorkflow extends Schema.TaggedError<DuplicateWorkflow>()(
  "DuplicateWorkflow",
  {
    workflow: Schema.String,
    first: Schema.String,
    second: Schema.String,
  },
) {
  override get message() {
    return `workflow ${this.workflow} is registered by both ${this.first} and ${this.second}`;
  }
}

export class WorkflowNotRegistered extends Schema.TaggedError<WorkflowNotRegistered>()(
  "WorkflowNotRegistered",
  { workflow: Schema.String },
) {
  override get message() {
    return `workflow ${this.workflow} is not registered; add its source to "workflows" in kymo.json`;
  }
}

type Registered = {
  readonly workflow: Workflow.Any;
  readonly source: string;
  readonly register: Effect.Effect<void>;
};

const resolve = (root: string, source: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (source.startsWith("~/")) {
      const home = yield* Config.NonEmptyString("HOME");
      return path.join(home, source.slice("~/".length));
    }
    if (source.startsWith("./") || source.startsWith("../")) {
      return path.resolve(root, source);
    }
    return source;
  });

Bun.plugin({
  name: "kymo-single-copy",
  setup: (build) => {
    for (const name of ["effect", "kymo"]) {
      const own = Bun.resolveSync(`${name}/package.json`, import.meta.dirname).replace(
        /package\.json$/,
        "",
      );
      const dir = `/node_modules/${name}/`;
      // Bun's runtime onResolve does not fire for bare specifiers; onLoad does, on realpaths.
      build.onLoad(
        { filter: new RegExp(`^(?!${RegExp.escape(own)}).*${dir}(?!.*/node_modules/)`) },
        async ({ path }) => ({
          exports: await import(own + path.slice(path.lastIndexOf(dir) + dir.length)),
          loader: "object",
        }),
      );
    }
  },
});

const load = (root: string, source: string) =>
  Effect.gen(function* () {
    const specifier = yield* resolve(root, source);
    const module = yield* Effect.tryPromise((): Promise<unknown> => import(specifier));
    const exported = Predicate.hasProperty(module, "default") ? module.default : undefined;
    if (!Layer.isLayer(exported)) {
      return yield* new WorkflowSourceError({ source, reason: "NotALayer", cause: exported });
    }
    return exported as Workflows;
  }).pipe(
    Effect.catchTag(["ConfigError", "UnknownError"], (cause) =>
      Effect.fail(new WorkflowSourceError({ source, reason: "Import", cause })),
    ),
  );

export const layer = (options: {
  readonly root: string;
  readonly workflows: ReadonlyArray<string>;
}): Layer.Layer<never, WorkflowSourceError | DuplicateWorkflow, WorkflowEngine.WorkflowEngine> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const registered = new Map<string, Registered>();

      const execute: WorkflowEngine.WorkflowEngine["Service"]["execute"] = (workflow, execution) =>
        Effect.suspend(() =>
          registered.has(workflow._tag)
            ? engine.execute(workflow, execution)
            : Effect.die(new WorkflowNotRegistered({ workflow: workflow._tag })),
        );

      const sources = yield* Effect.forEach(options.workflows, (source) =>
        Effect.map(load(options.root, source), (workflows) => ({ source, workflows })),
      );
      yield* Effect.forEach(
        sources,
        ({ source, workflows }) =>
          Layer.build(
            Layer.provide(
              workflows,
              Layer.succeed(
                WorkflowEngine.WorkflowEngine,
                WorkflowEngine.WorkflowEngine.of({
                  ...engine,
                  execute,
                  register: (workflow, run) => {
                    const registration = engine.register(workflow, run);
                    return Effect.contextWith(
                      (context: Context.Context<Effect.Services<typeof registration>>) => {
                        const existing = registered.get(workflow._tag);
                        if (existing !== undefined) {
                          return Effect.die(
                            new DuplicateWorkflow({
                              workflow: workflow._tag,
                              first: existing.source,
                              second: source,
                            }),
                          );
                        }
                        registered.set(workflow._tag, {
                          workflow,
                          source,
                          register: Effect.provideContext(registration, context),
                        });
                        return Effect.void;
                      },
                    );
                  },
                }),
              ),
            ),
          ).pipe(
            Effect.mapError((cause) => new WorkflowSourceError({ source, reason: "Build", cause })),
            Effect.catchDefect((defect) =>
              defect instanceof DuplicateWorkflow ? Effect.fail(defect) : Effect.die(defect),
            ),
          ),
        { discard: true },
      );
      yield* Effect.forEach(registered.values(), ({ register }) => register, { discard: true });
    }),
  ).pipe(Layer.provide(BunServices.layer));
