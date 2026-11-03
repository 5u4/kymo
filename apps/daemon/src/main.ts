import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Api, hostname } from "kymo/api";
import * as Ownership from "kymo/ownership";
import * as ProcessIdentity from "kymo/process-identity";
import * as Root from "kymo/root";
import { Executions } from "./executions.ts";
import * as Runtime from "./runtime.ts";

class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  args: Schema.Array(Schema.String),
}) {
  override get message() {
    return `usage: bun apps/daemon/src/main.ts [--root <dir>], got: ${this.args.join(" ")}`;
  }
}

class RootConfigInvalid extends Schema.TaggedError<RootConfigInvalid>()("RootConfigInvalid", {
  path: Schema.String,
  issue: Schema.String,
}) {
  override get message() {
    return `${this.path} is not a valid kymo.json: ${this.issue}`;
  }
}

const rootDir = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const [flag, dir, ...rest] = args;
  if (flag === undefined) {
    return yield* Root.defaultRoot;
  }
  if (flag !== "--root" || dir === undefined || rest.length > 0) {
    return yield* new UsageError({ args });
  }
  return dir;
});

const RootConfigJson = Schema.fromJsonString(Root.RootConfig, { space: 2 });

const readConfig = (root: Root.KymoRoot) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(root.root, { recursive: true });
    if (!(yield* fs.exists(root.config))) {
      const temp = `${root.config}.${process.pid}.tmp`;
      yield* fs.writeFileString(
        temp,
        `${yield* Schema.encodeEffect(RootConfigJson)(Root.defaultConfig)}\n`,
      );
      yield* fs.link(temp, root.config).pipe(
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
        Effect.ensuring(Effect.ignore(fs.remove(temp))),
      );
    }
    return yield* fs.readFileString(root.config).pipe(
      Effect.flatMap(Schema.decodeEffect(RootConfigJson)),
      Effect.catchTag(
        "SchemaError",
        (error) => new RootConfigInvalid({ path: root.config, issue: error.message }),
      ),
    );
  });

const sameOrigin = HttpRouter.middleware(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === "UnixPathAddress") {
      return yield* Effect.die(`the daemon is listening on the unix socket ${address.path}`);
    }
    const allowed = new Set(
      ["127.0.0.1", "localhost"].map((host) => new URL(`http://${host}:${address.port}`).origin),
    );
    return (httpEffect) =>
      Effect.gen(function* () {
        const origin = (yield* HttpServerRequest.HttpServerRequest).headers["origin"];
        return origin === undefined || allowed.has(origin)
          ? yield* httpEffect
          : HttpServerResponse.empty({ status: 403 });
      });
  }),
  { global: true },
);

const daemon = (
  root: Root.KymoRoot,
  config: Root.RootConfig,
  self: ProcessIdentity.ProcessIdentity,
) => {
  const engine = Runtime.layer({ root: root.root, workflows: config.workflows, db: root.db });
  const health = HttpApiBuilder.group(Api, "daemon", (handlers) =>
    handlers.handle("health", () => Effect.succeed({ pid: process.pid, root: root.root })),
  );
  const executions = HttpApiBuilder.group(Api, "executions", (handlers) =>
    Effect.map(Executions, (service) =>
      handlers
        .handle("list", ({ query }) => service.list(query))
        .handle("get", ({ params }) => service.get(params.id))
        .handle("logs", ({ params, query }) => service.logs(params.id, query))
        .handle("execute", ({ payload }) => service.execute(payload))
        .handle("complete", ({ params, payload }) => service.complete(params.id, payload))
        .handle("resume", ({ params }) => service.resume(params.id))
        .handle("interrupt", ({ params }) => service.interrupt(params.id)),
    ),
  );
  const served = HttpRouter.serve(
    Layer.merge(HttpApiBuilder.layer(Api).pipe(Layer.provide([health, executions])), sameOrigin),
    { disableLogger: true },
  ).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({ hostname, port: config.port, gracefulShutdownTimeout: "1 second" }),
    ),
  );
  const published = Layer.effectDiscard(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { address } = yield* HttpServer.HttpServer;
      if (address._tag === "UnixPathAddress") {
        return yield* Effect.die(`the daemon is listening on the unix socket ${address.path}`);
      }
      const file = yield* Schema.encodeEffect(Schema.fromJsonString(Root.DaemonFile))({
        ...self,
        port: address.port,
      });
      const temp = `${root.daemon}.${process.pid}.tmp`;
      yield* Effect.acquireRelease(
        fs.writeFileString(temp, file).pipe(Effect.andThen(fs.rename(temp, root.daemon))),
        () => Effect.ignore(fs.remove(root.daemon)),
      );
    }),
  );
  return published.pipe(Layer.provide(served), Layer.provide(engine));
};

Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = Root.make(path.resolve(yield* rootDir));
  const config = yield* readConfig(root);
  const self = yield* ProcessIdentity.identify(process.pid).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.orDie,
  );
  yield* Ownership.acquire(root, self);
  return yield* Layer.launch(daemon(root, config, self));
}).pipe(
  Effect.scoped,
  Effect.provide(BunServices.layer),
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Console.error(Cause.pretty(cause)),
  ),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
