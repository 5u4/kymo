import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import { url } from "kymo/api";
import * as Runtime from "../src/runtime.ts";
import * as Server from "../src/server.ts";

const fixtures = `${import.meta.dirname}/fixtures`;
const index = "<!doctype html><title>kymo</title>";

const serving = (options: { readonly workflows: ReadonlyArray<string>; readonly web: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const web = `${dir}/web`;
    if (options.web) {
      yield* fs.makeDirectory(`${web}/assets`, { recursive: true });
      yield* fs.writeFileString(`${web}/index.html`, index);
      yield* fs.writeFileString(`${web}/assets/app.js`, "export {};\n");
    }
    const context = yield* Layer.build(
      Server.layer({ root: fixtures, web, port: 0 }).pipe(
        Layer.provide(
          Runtime.layer({ root: fixtures, workflows: options.workflows, db: `${dir}/kymo.db` }),
        ),
      ),
    );
    const { address } = yield* HttpServer.HttpServer.pipe(Effect.provide(context));
    if (address._tag === "UnixPathAddress") {
      return yield* Effect.die(`listening on the unix socket ${address.path}`);
    }
    const client = yield* HttpClient.HttpClient;
    return (path: string, headers: Record<string, string> = {}) =>
      client.execute(
        HttpClientRequest.get(`${url(address.port)}${path}`).pipe(
          HttpClientRequest.setHeaders({ host: `127.0.0.1:${address.port}`, ...headers }),
        ),
      );
  });

const services = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);
const html = { accept: "text/html,application/xhtml+xml" };

describe("daemon http server", () => {
  it.live("lists every registered workflow sorted by name", () =>
    Effect.gen(function* () {
      const get = yield* serving({
        workflows: ["./parent.ts", "./double.ts", "./child.ts"],
        web: false,
      });
      const response = yield* get("/api/workflows");
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* response.json, {
        workflows: [{ name: "Child" }, { name: "Double" }, { name: "Parent" }],
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("serves index.html at / and at a deep path a browser asks for", () =>
    Effect.gen(function* () {
      const get = yield* serving({ workflows: [], web: true });
      for (const path of ["/", "/x/y"]) {
        const response = yield* get(path, html);
        assert.strictEqual(response.status, 200, path);
        assert.include(response.headers["content-type"], "text/html", path);
        assert.strictEqual(yield* response.text, index, path);
      }
      const asset = yield* get("/assets/app.js");
      assert.strictEqual(asset.status, 200);
      assert.strictEqual(yield* asset.text, "export {};\n");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("answers an unknown /api path with 404 and no html", () =>
    Effect.gen(function* () {
      const get = yield* serving({ workflows: [], web: true });
      for (const path of ["/api/nope", "/api/executions/x/nope"]) {
        const response = yield* get(path, html);
        assert.strictEqual(response.status, 404, path);
        assert.notInclude(yield* response.text, index, path);
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("answers 403 on static paths to a foreign Host or Origin", () =>
    Effect.gen(function* () {
      const get = yield* serving({ workflows: [], web: true });
      for (const headers of [{ host: "attacker.example" }, { origin: "http://attacker.example" }]) {
        for (const path of ["/", "/x/y", "/assets/app.js"]) {
          const response = yield* get(path, { ...html, ...headers });
          assert.strictEqual(response.status, 403, `${path} ${Object.values(headers).join(" ")}`);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("serves the api and 404s pages when the web build is missing", () =>
    Effect.gen(function* () {
      const get = yield* serving({ workflows: ["./double.ts"], web: false });
      assert.deepStrictEqual(yield* (yield* get("/api/workflows")).json, {
        workflows: [{ name: "Double" }],
      });
      assert.strictEqual((yield* get("/", html)).status, 404);
      assert.strictEqual((yield* get("/x/y", html)).status, 404);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
