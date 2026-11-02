import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import * as GitHub from "../src/github.ts";
import * as WaitForMerge from "../src/wait-for-merge.ts";

const pullRequest = (state: GitHub.PullRequest["state"]): GitHub.PullRequest => ({
  number: 12,
  title: "Ship it",
  url: "https://github.com/5u4/kymo/pull/12",
  state,
});

const answering = (answers: ReadonlyArray<Effect.Effect<GitHub.PullRequest, GitHub.GhError>>) =>
  WaitForMerge.layer.pipe(
    Layer.provide(
      Layer.effect(
        GitHub.GitHub,
        Effect.map(Ref.make(0), (calls) =>
          GitHub.GitHub.of({
            viewPullRequest: () =>
              Effect.flatMap(
                Ref.getAndUpdate(calls, (n) => n + 1),
                (n) => answers[Math.min(n, answers.length - 1)] ?? Effect.die("no answers"),
              ),
          }),
        ),
      ),
    ),
    Layer.provideMerge(WorkflowEngine.layerMemory),
  );

const completed = Effect.fnUntraced(function* (executionId: string) {
  for (let step = 0; step < 100; step++) {
    const result = yield* WaitForMerge.WaitForMerge.poll(executionId);
    if (Option.isSome(result) && result.value._tag === "Complete") {
      return result.value.exit;
    }
    yield* TestClock.adjust("10 seconds");
  }
  return yield* Effect.die("WaitForMerge never completed");
});

const wait = WaitForMerge.WaitForMerge.execute(
  { repo: "5u4/kymo", number: 12 },
  { discard: true },
).pipe(Effect.flatMap(completed));

describe("WaitForMerge", () => {
  it.effect("polls an open pull request until it merges", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* wait, Exit.succeed(pullRequest("MERGED")));
    }).pipe(
      Effect.provide(
        answering([
          Effect.succeed(pullRequest("OPEN")),
          Effect.succeed(pullRequest("OPEN")),
          Effect.succeed(pullRequest("MERGED")),
        ]),
      ),
    ),
  );

  it.effect("fails when the pull request is closed without merging", () =>
    Effect.gen(function* () {
      const exit = yield* wait;
      assert(Exit.isFailure(exit));
      assert.deepStrictEqual(
        Cause.squash(exit.cause),
        new WaitForMerge.PullRequestClosed({
          repo: "5u4/kymo",
          number: 12,
          url: "https://github.com/5u4/kymo/pull/12",
        }),
      );
    }).pipe(
      Effect.provide(
        answering([Effect.succeed(pullRequest("OPEN")), Effect.succeed(pullRequest("CLOSED"))]),
      ),
    ),
  );

  it.effect("rides out a gh failure that clears on retry", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* wait, Exit.succeed(pullRequest("MERGED")));
    }).pipe(
      Effect.provide(
        answering([
          Effect.fail(new GitHub.GhError({ stderr: "connection reset", cause: "exit 1" })),
          Effect.succeed(pullRequest("MERGED")),
        ]),
      ),
    ),
  );
});
