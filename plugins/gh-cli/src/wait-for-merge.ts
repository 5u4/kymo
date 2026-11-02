import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Activity from "effect/workflow/Activity";
import * as DurableClock from "effect/workflow/DurableClock";
import * as Workflow from "effect/workflow/Workflow";
import * as GitHub from "./github.ts";

export class PullRequestClosed extends Schema.TaggedError<PullRequestClosed>()(
  "PullRequestClosed",
  { repo: Schema.String, number: Schema.Int, url: Schema.String },
) {}

export const WaitForMerge = Workflow.make("WaitForMerge", {
  payload: { repo: Schema.String, number: Schema.Int },
  success: GitHub.PullRequest,
  error: PullRequestClosed,
  idempotencyKey: ({ repo, number }) => `${repo}#${number}`,
});

const pollInterval = "2 minutes";

export const layer = WaitForMerge.toLayer(
  Effect.fnUntraced(function* ({ repo, number }) {
    const github = yield* GitHub.GitHub;
    for (let check = 1; ; check++) {
      const pullRequest = yield* Activity.make({
        name: `CheckPullRequest/${check}`,
        success: GitHub.PullRequest,
        error: GitHub.GhError,
        execute: github
          .viewPullRequest({ repo, number })
          .pipe(Effect.retry({ times: 3, schedule: Schedule.exponential("1 second") })),
      }).pipe(Effect.orDie);
      if (pullRequest.state === "MERGED") {
        return pullRequest;
      }
      if (pullRequest.state === "CLOSED") {
        return yield* new PullRequestClosed({ repo, number, url: pullRequest.url });
      }
      yield* DurableClock.sleep({ name: `Poll/${check}`, duration: pollInterval });
    }
  }),
);
