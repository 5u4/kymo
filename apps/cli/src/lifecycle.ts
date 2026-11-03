import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ownership from "kymo/ownership";
import * as ProcessIdentity from "kymo/process-identity";
import type * as Root from "kymo/root";
import { cleanStale, derive, type Running } from "./daemon-state.ts";

const startTimeout = "20 seconds";
const stopTimeout = "10 seconds";
const poll = "50 millis";

export class DaemonExited extends Schema.TaggedError<DaemonExited>()("DaemonExited", {
  code: Schema.NullOr(Schema.Int),
  log: Schema.Array(Schema.String),
}) {
  override get message() {
    return `the kymo daemon exited during startup with code ${this.code ?? "unknown"}`;
  }
}

export class DaemonSilent extends Schema.TaggedError<DaemonSilent>()("DaemonSilent", {
  pid: Schema.Int,
  log: Schema.Array(Schema.String),
}) {
  override get message() {
    return `the kymo daemon (pid ${this.pid}) holds the root but did not answer within ${startTimeout}`;
  }
}

const signal = (target: ProcessIdentity.ProcessIdentity, name: "SIGTERM" | "SIGKILL") =>
  Effect.try(() => process.kill(target.pid, name)).pipe(
    Effect.ignore,
    Effect.when(ProcessIdentity.isAlive(target)),
  );

const awaitExit = (target: ProcessIdentity.ProcessIdentity) =>
  Effect.gen(function* () {
    while (yield* ProcessIdentity.isAlive(target)) {
      yield* Effect.sleep(poll);
    }
  });

const logSince = (root: Root.KymoRoot, offset: number) =>
  FileSystem.FileSystem.use((fs) => fs.readFile(root.log)).pipe(
    Effect.map((bytes) =>
      new TextDecoder()
        .decode(bytes.subarray(offset))
        .split("\n")
        .map((line) => line.trim().replace(/\s*\{$/, ""))
        .filter((line) => line.length > 0 && line !== "}" && !line.startsWith("at "))
        .slice(-20),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

export interface Started {
  readonly daemon: Running;
  readonly started: boolean;
}

export const start = (root: Root.KymoRoot) =>
  Effect.gen(function* () {
    const state = yield* derive(root);
    if (state._tag === "Running") {
      return { daemon: state, started: false } satisfies Started;
    }
    if (state.stale) {
      yield* cleanStale(root);
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(root.root, { recursive: true });
    const offset = yield* fs.stat(root.log).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(0)),
    );
    // Effect's File hides its descriptor and Bun truncates a BunFile used as stdio, so sh appends.
    const child = Bun.spawn({
      cmd: [
        "/bin/sh",
        "-c",
        'log=$1; shift; exec "$@" >>"$log" 2>&1',
        "kymo-daemon",
        root.log,
        process.execPath,
        path.join(import.meta.dirname, "../../daemon/src/main.ts"),
        "--root",
        root.root,
      ],
      cwd: root.root,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    child.unref();
    return yield* Effect.gen(function* () {
      for (;;) {
        const current = yield* derive(root);
        if (current._tag === "Running") {
          return { daemon: current, started: current.pid === child.pid } satisfies Started;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          if (Option.isNone(yield* Ownership.liveOwner(root))) {
            return yield* new DaemonExited({
              code: child.exitCode,
              log: yield* logSince(root, offset),
            });
          }
        }
        yield* Effect.sleep(poll);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: startTimeout,
        orElse: () =>
          Effect.gen(function* () {
            const owner = yield* Ownership.liveOwner(root);
            return yield* new DaemonSilent({
              pid: Option.match(owner, { onNone: () => child.pid, onSome: (live) => live.pid }),
              log: yield* logSince(root, offset),
            });
          }),
      }),
    );
  });

export const stop = (root: Root.KymoRoot) =>
  Effect.gen(function* () {
    const state = yield* derive(root);
    const target: Option.Option<ProcessIdentity.ProcessIdentity> =
      state._tag === "Running" ? Option.some(state) : yield* Ownership.liveOwner(root);
    if (Option.isSome(target)) {
      yield* signal(target.value, "SIGTERM");
      yield* awaitExit(target.value).pipe(
        Effect.timeoutOrElse({
          duration: stopTimeout,
          orElse: () =>
            signal(target.value, "SIGKILL").pipe(Effect.andThen(awaitExit(target.value))),
        }),
      );
    }
    yield* cleanStale(root);
    return target;
  });
