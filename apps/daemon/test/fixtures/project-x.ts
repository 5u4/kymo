import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Workflow from "effect/workflow/Workflow";
import * as WaitForMerge from "kymo/gh-cli/wait-for-merge";
import type { Workflows } from "kymo/workflows";

export const ReleaseX = Workflow.make("ReleaseX", {
  payload: { repo: Schema.String, number: Schema.Int },
  success: Schema.String,
  error: WaitForMerge.PullRequestClosed,
  idempotencyKey: ({ repo, number }) => `${repo}#${number}`,
});

export default ReleaseX.toLayer(({ repo, number }) =>
  Effect.map(
    WaitForMerge.WaitForMerge.execute({ repo, number }),
    (pullRequest) => `released after ${pullRequest.url}`,
  ),
) satisfies Workflows;
