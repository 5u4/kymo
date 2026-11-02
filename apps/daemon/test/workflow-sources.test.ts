import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/cluster/SingleRunner";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { RootConfig } from "kymo/root";
import { Awaits } from "../src/awaits.ts";
import * as WorkflowSources from "../src/workflow-sources.ts";
import { Double } from "./fixtures/double.ts";
import { Parent } from "./fixtures/definitions.ts";
import { ReleaseX } from "./fixtures/project-x.ts";

const fixtures = `${import.meta.dirname}/fixtures`;

const daemon = (workflows: ReadonlyArray<string>, root = fixtures) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      return WorkflowSources.layer({ root, workflows }).pipe(
        Layer.provideMerge(Awaits.layer),
        Layer.provide(ClusterWorkflowEngine.layer),
        Layer.provide(SingleRunner.layer({ runnerStorage: "memory" })),
        Layer.provide(SqliteClient.layer({ filename: `${dir}/kymo.db` })),
        Layer.provide(BunCrypto.layerDigest),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: fixtures } }))),
      );
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );

const startupError = (workflows: ReadonlyArray<string>) =>
  Effect.flip(Effect.scoped(Layer.build(daemon(workflows))));

const mergedGh = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(
    `${dir}/gh`,
    `#!/bin/sh\necho '{"number":12,"state":"MERGED","title":"Ship it","url":"https://github.com/5u4/x/pull/12"}'\n`,
    { mode: 0o755 },
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const path = process.env["PATH"];
      process.env["PATH"] = `${dir}:${path}`;
      return path;
    }),
    (path) =>
      Effect.sync(() => {
        process.env["PATH"] = path;
      }),
  );
}).pipe(Effect.provide(BunFileSystem.layer));

const installOwnCopy = (project: string, name: string, entries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const own = Bun.resolveSync(`${name}/package.json`, import.meta.dirname).replace(
      /package\.json$/,
      "",
    );
    const copy = `${project}/node_modules/${name}`;
    yield* fs.makeDirectory(copy, { recursive: true });
    yield* fs.copyFile(`${own}package.json`, `${copy}/package.json`);
    for (const entry of entries) {
      yield* fs.copy(`${own}${entry}`, `${copy}/${entry}`);
    }
  });

describe("workflow sources", () => {
  it.live("loads relative and ~/ sources, and a parent runs a child from another source", () =>
    Effect.gen(function* () {
      const result = yield* Parent.execute({ id: "a" });
      assert.strictEqual(result, "child:a");
    }).pipe(Effect.provide(daemon(["./parent.ts", "~/child.ts"])), Effect.scoped),
  );

  it.live("runs a source on the daemon's effect when its project installs its own copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* fs.makeTempDirectoryScoped();
      yield* installOwnCopy(project, "effect", ["dist"]);
      yield* fs.copyFile(`${fixtures}/double.ts`, `${project}/kymo.ts`);
      const result = yield* Double.execute({ n: 21 }).pipe(
        Effect.provide(daemon(["./kymo.ts"], project)),
      );
      assert.strictEqual(result, 42);
    }).pipe(Effect.provide(BunFileSystem.layer), Effect.scoped),
  );

  it.live("gives a source the daemon's kymo when its project installs its own copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* fs.makeTempDirectoryScoped();
      yield* installOwnCopy(project, "effect", ["dist"]);
      yield* installOwnCopy(project, "kymo", ["src", "plugins"]);
      yield* fs.writeFileString(
        `${project}/kymo.ts`,
        `${yield* fs.readFileString(`${fixtures}/double.ts`)}export { RootConfig } from "kymo/root";\n`,
      );
      const source = yield* Effect.promise(
        (): Promise<{ readonly RootConfig: unknown }> => import(`${project}/kymo.ts`),
      ).pipe(Effect.provide(daemon(["./kymo.ts"], project)));
      assert.strictEqual(source.RootConfig, RootConfig);
    }).pipe(Effect.provide(BunFileSystem.layer), Effect.scoped),
  );

  it.live("fails startup when two sources register the same workflow", () =>
    Effect.gen(function* () {
      const error = yield* startupError(["./child.ts", "./duplicate-child.ts"]);
      assert.instanceOf(error, WorkflowSources.DuplicateWorkflow);
      assert.strictEqual(
        error.message,
        "workflow Child is registered by both ./child.ts and ./duplicate-child.ts",
      );
    }),
  );

  it.live("fails startup naming a source whose default export is not a Layer", () =>
    Effect.gen(function* () {
      const error = yield* startupError(["./child.ts", "./not-a-layer.ts"]);
      assert.instanceOf(error, WorkflowSources.WorkflowSourceError);
      assert.strictEqual(
        error.message,
        "workflow source ./not-a-layer.ts does not default-export a Layer",
      );
    }),
  );

  it.live("fails startup naming a source that cannot be imported", () =>
    Effect.gen(function* () {
      const error = yield* startupError(["./child.ts", "./missing.ts"]);
      assert.instanceOf(error, WorkflowSources.WorkflowSourceError);
      assert.strictEqual(error.message, "workflow source ./missing.ts could not be imported");
    }),
  );

  it.live("fails a parent at once when its child workflow has no source", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Parent.execute({ id: "u" }).pipe(Effect.timeout("5 seconds")),
      );
      assert(Exit.isFailure(exit));
      const defect = Cause.squash(exit.cause);
      assert.strictEqual(
        defect instanceof Error && defect.message,
        'workflow Child is not registered; add its source to "workflows" in kymo.json',
      );
    }).pipe(Effect.provide(daemon(["./parent.ts"])), Effect.scoped),
  );

  for (const workflows of [
    ["./parent.ts", "./starts-parent.ts", "./child.ts"],
    ["./starts-parent.ts", "./parent.ts", "./child.ts"],
  ]) {
    it.live(`runs nothing until every source is loaded: ${workflows.join(", ")}`, () =>
      Effect.gen(function* () {
        const result = yield* Parent.poll(yield* Parent.executionId({ id: "startup" })).pipe(
          Effect.repeat({
            until: (result) => Option.isSome(result) && result.value._tag === "Complete",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        assert.deepStrictEqual(
          Option.map(result, (r) => r._tag === "Complete" && r.exit),
          Option.some(Exit.succeed("child:startup")),
        );
      }).pipe(Effect.provide(daemon(workflows)), Effect.scoped),
    );
  }

  it.live("fails startup when a source starts a workflow no source registers", () =>
    Effect.gen(function* () {
      const error = yield* startupError(["./starts-parent.ts", "./child.ts"]);
      assert.instanceOf(error, WorkflowSources.WorkflowNotRegistered);
      assert.strictEqual(
        error.message,
        'workflow Parent is not registered; add its source to "workflows" in kymo.json',
      );
    }),
  );
});

describe("kymo/gh-cli as a workflow source", () => {
  it.live("lets project X wait for a merge through a child WaitForMerge", () =>
    Effect.gen(function* () {
      yield* mergedGh;
      const result = yield* ReleaseX.execute({ repo: "5u4/x", number: 12 });
      assert.strictEqual(result, "released after https://github.com/5u4/x/pull/12");
    }).pipe(Effect.provide(daemon(["kymo/gh-cli", "./project-x.ts"])), Effect.scoped),
  );

  it.live("fails project X at once when kymo/gh-cli is not a source", () =>
    Effect.gen(function* () {
      yield* mergedGh;
      const exit = yield* Effect.exit(
        ReleaseX.execute({ repo: "5u4/x", number: 12 }).pipe(Effect.timeout("5 seconds")),
      );
      assert(Exit.isFailure(exit));
      const defect = Cause.squash(exit.cause);
      assert.strictEqual(
        defect instanceof Error && defect.message,
        'workflow WaitForMerge is not registered; add its source to "workflows" in kymo.json',
      );
    }).pipe(Effect.provide(daemon(["./project-x.ts"])), Effect.scoped),
  );
});
