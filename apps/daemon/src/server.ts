import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpStaticServer from "effect/http/HttpStaticServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Api, hostname } from "kymo/api";
import * as Root from "kymo/root";
import { Executions } from "./executions.ts";
import { Registry } from "./workflow-sources.ts";

const localOnly = HttpRouter.middleware(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === "UnixPathAddress") {
      return yield* Effect.die(`the daemon is listening on the unix socket ${address.path}`);
    }
    const local = ["127.0.0.1", "localhost"].map(
      (host) => new URL(`http://${host}:${address.port}`),
    );
    const origins = new Set(local.map((url) => url.origin));
    const hosts = new Set(local.map((url) => url.host));
    return (httpEffect) =>
      Effect.gen(function* () {
        const { headers } = yield* HttpServerRequest.HttpServerRequest;
        const host = headers["host"];
        const origin = headers["origin"];
        return host !== undefined &&
          hosts.has(host) &&
          (origin === undefined || origins.has(origin))
          ? yield* httpEffect
          : HttpServerResponse.empty({ status: 403 });
      });
  }),
  { global: true },
);

export const layer = (options: {
  readonly root: string;
  readonly web: string;
  readonly port: number;
}) => {
  const health = HttpApiBuilder.group(Api, "daemon", (handlers) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* Config.option(Root.defaultRoot);
      const defaultRoot = Option.exists(home, (dir) => path.resolve(dir) === options.root);
      return handlers.handle("health", () =>
        Effect.succeed({ pid: process.pid, root: options.root, defaultRoot }),
      );
    }),
  );
  const workflows = HttpApiBuilder.group(Api, "workflows", (handlers) =>
    Effect.map(Registry, (registry) =>
      handlers.handle("list", () =>
        Effect.succeed({ workflows: registry.names.map((name) => ({ name })) }),
      ),
    ),
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
  return HttpRouter.serve(
    Layer.mergeAll(
      HttpApiBuilder.layer(Api).pipe(Layer.provide([health, workflows, executions])),
      HttpStaticServer.layer({ root: options.web, spa: true }),
      HttpRouter.add("*", "/api/*", HttpServerResponse.empty({ status: 404 })),
      localOnly,
    ),
    { disableLogger: true },
  ).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({ hostname, port: options.port, gracefulShutdownTimeout: "1 second" }),
    ),
  );
};
