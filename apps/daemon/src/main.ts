import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ownership from "kymo/ownership";
import * as ProcessIdentity from "kymo/process-identity";
import * as Root from "kymo/root";
import * as Runtime from "./runtime.ts";
import * as Server from "./server.ts";

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

const daemon = (
  root: Root.KymoRoot,
  config: Root.RootConfig,
  self: ProcessIdentity.ProcessIdentity,
  web: string,
) => {
  const engine = Runtime.layer({ root: root.root, workflows: config.workflows, db: root.db });
  const served = Server.layer({ root: root.root, web, port: config.port });
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
  return yield* Layer.launch(
    daemon(root, config, self, path.join(import.meta.dirname, "../../web/dist")),
  );
}).pipe(
  Effect.scoped,
  Effect.provide(BunServices.layer),
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Console.error(Cause.pretty(cause)),
  ),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
