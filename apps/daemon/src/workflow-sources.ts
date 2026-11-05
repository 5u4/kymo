import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type { Workflows } from "kymo/workflows";
import { expectedShape } from "./expected-shape.ts";

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

const KymoCopy = Schema.Struct({ path: Schema.String, digest: Schema.String });

export class KymoVersionMismatch extends Schema.TaggedError<KymoVersionMismatch>()(
  "KymoVersionMismatch",
  { source: Schema.String, daemon: KymoCopy, resolved: KymoCopy },
) {
  override get message() {
    return `workflow source ${this.source} resolves kymo at ${this.resolved.path} (content ${this.resolved.digest.slice(0, 12)}), but the daemon runs kymo at ${this.daemon.path} (content ${this.daemon.digest.slice(0, 12)}); install the daemon's kymo commit in that project`;
  }
}

const EffectCopy = Schema.Struct({ path: Schema.String, version: Schema.String });

export class EffectVersionMismatch extends Schema.TaggedError<EffectVersionMismatch>()(
  "EffectVersionMismatch",
  { source: Schema.String, daemon: EffectCopy, resolved: EffectCopy },
) {
  override get message() {
    return `workflow source ${this.source} resolves effect ${this.resolved.version} at ${this.resolved.path}, but the daemon runs effect ${this.daemon.version} at ${this.daemon.path}; install effect ${this.daemon.version} in that project`;
  }
}

export type Registered = {
  readonly workflow: RegisteredWorkflow;
  readonly source: string;
  readonly expected: Option.Option<string>;
  readonly context: Context.Context<never>;
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

const packageDir = (name: string, from: string) =>
  Bun.resolveSync(`${name}/package.json`, from).slice(0, -"/package.json".length);

const own = {
  effect: packageDir("effect", import.meta.dirname),
  kymo: packageDir("kymo", import.meta.dirname),
};

Bun.plugin({
  name: "kymo-single-copy",
  setup: (build) => {
    for (const [name, dir] of Object.entries(own)) {
      const prefix = `${dir}/`;
      const segment = `/node_modules/${name}/`;
      // Bun's runtime onResolve does not fire for bare specifiers; onLoad does, on realpaths.
      build.onLoad(
        { filter: new RegExp(`^(?!${RegExp.escape(prefix)}).*${segment}(?!.*/node_modules/)`) },
        async ({ path }) => ({
          exports: await import(prefix + path.slice(path.lastIndexOf(segment) + segment.length)),
          loader: "object",
        }),
      );
    }
  },
});

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    exports: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  }),
);

const readManifest = (dir: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(`${dir}/package.json`)).pipe(
    Effect.flatMap(Schema.decodeEffect(Manifest)),
  );

const kymoDigest = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const digest = yield* Digest.Digest;
    const manifest = yield* readManifest(dir);
    const reached = yield* Effect.forEach(
      Object.values(manifest.exports ?? {}).filter(Predicate.isNotNull),
      (target) => fs.glob(target.replace(/^\.\//, "").replace("*", "**/*"), { root: dir }),
    );
    const files = Array.from(new Set(reached.flat()))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .toSorted();
    const hashes = yield* Effect.forEach(files, (file) =>
      fs.readFile(`${dir}/${file}`).pipe(
        Effect.flatMap((bytes) => digest.digestHex(Digest.sha256, bytes)),
        Effect.map((hash) => `${file} ${hash}`),
      ),
    );
    return yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(hashes.join("\n")));
  });

const handshake = (source: string, file: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const from = path.dirname(file);
    const kymo = yield* Effect.option(Effect.try(() => packageDir("kymo", from)));
    if (Option.isSome(kymo) && kymo.value !== own.kymo) {
      const daemon = { path: own.kymo, digest: yield* Effect.orDie(kymoDigest(own.kymo)) };
      const resolved = {
        path: kymo.value,
        digest: yield* kymoDigest(kymo.value).pipe(Effect.orElseSucceed(() => "unreadable")),
      };
      if (resolved.digest !== daemon.digest) {
        return yield* new KymoVersionMismatch({ source, daemon, resolved });
      }
    }
    const effect = yield* Effect.option(Effect.try(() => packageDir("effect", from)));
    if (Option.isSome(effect) && effect.value !== own.effect) {
      const daemon = {
        path: own.effect,
        version: (yield* Effect.orDie(readManifest(own.effect))).version,
      };
      const resolved = {
        path: effect.value,
        version: yield* readManifest(effect.value).pipe(
          Effect.map((manifest) => manifest.version),
          Effect.orElseSucceed(() => "unreadable"),
        ),
      };
      if (resolved.version !== daemon.version) {
        return yield* new EffectVersionMismatch({ source, daemon, resolved });
      }
    }
  });

const load = (root: string, source: string) =>
  Effect.gen(function* () {
    let specifier = yield* resolve(root, source);
    if ((yield* Path.Path).isAbsolute(specifier)) {
      specifier = yield* FileSystem.FileSystem.use((fs) => fs.realPath(specifier));
      yield* handshake(source, specifier);
    }
    const module = yield* Effect.tryPromise((): Promise<unknown> => import(specifier));
    const exported = Predicate.hasProperty(module, "default") ? module.default : undefined;
    if (!Layer.isLayer(exported)) {
      return yield* new WorkflowSourceError({ source, reason: "NotALayer", cause: exported });
    }
    return exported as Workflows;
  }).pipe(
    Effect.catchTag(["ConfigError", "UnknownError", "PlatformError"], (cause) =>
      Effect.fail(new WorkflowSourceError({ source, reason: "Import", cause })),
    ),
  );

type Serviceless = Schema.Codec<unknown, unknown>;

export type RegisteredWorkflow = Workflow.Workflow<
  string,
  Workflow.AnyStructSchema & Serviceless,
  Serviceless,
  Serviceless
>;

export class Registry extends Context.Service<
  Registry,
  {
    readonly get: (workflow: string) => Option.Option<Registered>;
    readonly names: ReadonlyArray<string>;
  }
>()("@kymo/daemon/Registry") {}

export const layer = (options: {
  readonly root: string;
  readonly workflows: ReadonlyArray<string>;
}): Layer.Layer<
  Registry,
  | WorkflowSourceError
  | DuplicateWorkflow
  | WorkflowNotRegistered
  | KymoVersionMismatch
  | EffectVersionMismatch,
  WorkflowEngine.WorkflowEngine
> =>
  Layer.effect(
    Registry,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const registered = new Map<string, Registered>();
      let startedWhileLoading: Set<string> | undefined = new Set<string>();

      const execute: WorkflowEngine.WorkflowEngine["Service"]["execute"] = (workflow, execution) =>
        Effect.suspend(() => {
          if (startedWhileLoading !== undefined) {
            startedWhileLoading.add(workflow._tag);
            return engine.execute(workflow, execution);
          }
          return registered.has(workflow._tag)
            ? engine.execute(workflow, execution)
            : Effect.die(new WorkflowNotRegistered({ workflow: workflow._tag }));
        });

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
                          workflow: workflow as unknown as RegisteredWorkflow,
                          source,
                          expected: expectedShape(workflow.payloadSchema),
                          context,
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
      const missing = [...startedWhileLoading].find((workflow) => !registered.has(workflow));
      if (missing !== undefined) {
        return yield* new WorkflowNotRegistered({ workflow: missing });
      }
      startedWhileLoading = undefined;
      yield* Effect.forEach(registered.values(), ({ register }) => register, { discard: true });
      return Registry.of({
        get: (workflow) => Option.fromUndefinedOr(registered.get(workflow)),
        names: [...registered.keys()].toSorted(),
      });
    }),
  ).pipe(Layer.provide([BunServices.layer, BunCrypto.layerDigest]));
