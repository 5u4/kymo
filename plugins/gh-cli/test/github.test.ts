import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as GitHub from "../src/github.ts";

const fakeGh = (script: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/gh`, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
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
    return dir;
  });

const live = GitHub.GitHub.layer.pipe(Layer.provideMerge(BunServices.layer));

describe("GitHub", () => {
  it.live("views a pull request through gh pr view", () =>
    Effect.gen(function* () {
      const dir = yield* fakeGh(
        `printf '%s\\n' "$@" > "$(dirname "$0")/args"
echo '{"number":7,"state":"OPEN","title":"Add gh-cli","url":"https://github.com/5u4/kymo/pull/7"}'`,
      );
      const github = yield* GitHub.GitHub;
      const pullRequest = yield* github.viewPullRequest({ repo: "5u4/kymo", number: 7 });
      assert.deepStrictEqual(pullRequest, {
        number: 7,
        title: "Add gh-cli",
        url: "https://github.com/5u4/kymo/pull/7",
        state: "OPEN",
      });
      const fs = yield* FileSystem.FileSystem;
      assert.deepStrictEqual((yield* fs.readFileString(`${dir}/args`)).split("\n"), [
        "pr",
        "view",
        "7",
        "--repo",
        "5u4/kymo",
        "--json",
        "number,title,url,state",
        "",
      ]);
    }).pipe(Effect.provide(live), Effect.scoped),
  );

  it.live("fails with the stderr of a gh that exits non-zero", () =>
    Effect.gen(function* () {
      yield* fakeGh(`echo 'GraphQL: Could not resolve to a PullRequest with the number of 9.' >&2
exit 1`);
      const github = yield* GitHub.GitHub;
      const error = yield* Effect.flip(github.viewPullRequest({ repo: "5u4/kymo", number: 9 }));
      assert.instanceOf(error, GitHub.GhError);
      assert.strictEqual(
        error.stderr,
        "GraphQL: Could not resolve to a PullRequest with the number of 9.\n",
      );
      assert.strictEqual(error.cause, "gh exited with code 1");
    }).pipe(Effect.provide(live), Effect.scoped),
  );

  it.live("fails when gh prints something other than a pull request", () =>
    Effect.gen(function* () {
      yield* fakeGh(`echo '{"number":7,"state":"DRAFT"}'`);
      const github = yield* GitHub.GitHub;
      const error = yield* Effect.flip(github.viewPullRequest({ repo: "5u4/kymo", number: 7 }));
      assert.instanceOf(error, GitHub.GhError);
    }).pipe(Effect.provide(live), Effect.scoped),
  );
});
