# gh-cli

`kymo/gh-cli` is a workflow source with one workflow, `WaitForMerge`. It checks a pull request
with the `gh` CLI, sleeps 2 minutes on a durable clock while the pull request is open, and checks
again.

- `MERGED`: the workflow succeeds with the pull request: `{ number, title, url, state }`.
- `CLOSED`: the workflow fails with `PullRequestClosed`.
- `gh` fails 4 times in a row on one check: the execution dies with a `GhError` that carries the
  stderr of `gh` (empty when running `gh` fails in the platform, for example when it is not found).

## Prerequisites

The daemon runs `gh pr view <number> --repo <repo> --json number,title,url,state`. Put `gh` on the
daemon's `PATH` and log it in with `gh auth login`. kymo does not handle GitHub tokens.

## Install

In project X:

```sh
bun add github:5u4/kymo#<sha> effect@4.1.2
```

These installs serve typechecking. At runtime the daemon loads its own `effect` and `kymo` in place
of the copies in X's `node_modules`, so pin `<sha>` to the kymo commit the daemon runs and `effect`
to the daemon's version.

## Wait for a merge from your own workflow

Run `WaitForMerge` as a child workflow. Its idempotency key is `<repo>#<number>`, so every parent
that waits on the same pull request shares one execution.

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Workflow from "effect/workflow/Workflow";
import * as WaitForMerge from "kymo/gh-cli/wait-for-merge";
import type { Workflows } from "kymo/workflows";

export const Release = Workflow.make("Release", {
  payload: { repo: Schema.String, number: Schema.Int },
  success: Schema.String,
  error: WaitForMerge.PullRequestClosed,
  idempotencyKey: ({ repo, number }) => `${repo}#${number}`,
});

export default Release.toLayer(({ repo, number }) =>
  Effect.map(
    WaitForMerge.WaitForMerge.execute({ repo, number }),
    (pullRequest) => `released after ${pullRequest.url}`,
  ),
) satisfies Workflows;
```

## List both sources in kymo.json

List `kymo/gh-cli` next to your own file in `~/.kymo/kymo.json`. `kymo start`, which reads this
file, is not built yet.

```json
{
  "port": 4419,
  "workflows": ["kymo/gh-cli", "~/Workspaces/x/kymo.ts"]
}
```

If you leave out `kymo/gh-cli`, `Release` dies when it runs `WaitForMerge`, with the message
`workflow WaitForMerge is not registered; add its source to "workflows" in kymo.json`.
