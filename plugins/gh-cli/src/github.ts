import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export const PullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
});
export type PullRequest = typeof PullRequest.Type;

export class GhError extends Schema.TaggedError<GhError>()("GhError", {
  stderr: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `gh failed: ${this.stderr.trim() || String(this.cause)}`;
  }
}

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly viewPullRequest: (pullRequest: {
      readonly repo: string;
      readonly number: number;
    }) => Effect.Effect<PullRequest, GhError>;
  }
>()("kymo/gh-cli/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return GitHub.of({
        viewPullRequest: ({ repo, number }) =>
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("gh", [
                "pr",
                "view",
                String(number),
                "--repo",
                repo,
                "--json",
                "number,title,url,state",
              ]),
            );
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
              return yield* new GhError({ stderr, cause: `gh exited with code ${exitCode}` });
            }
            return yield* Schema.decodeEffect(Schema.fromJsonString(PullRequest))(stdout).pipe(
              Effect.mapError((cause) => new GhError({ stderr, cause })),
            );
          }).pipe(
            Effect.scoped,
            Effect.catchTag("PlatformError", (cause) =>
              Effect.fail(new GhError({ stderr: "", cause })),
            ),
          ),
      });
    }),
  );
}
