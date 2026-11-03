import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

export const ProcessIdentity = Schema.Struct({
  pid: Schema.Int,
  started: Schema.NonEmptyString,
});
export type ProcessIdentity = typeof ProcessIdentity.Type;

export const ProcessIdentityJson = Schema.fromJsonString(ProcessIdentity);

export const identify = (pid: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const started = yield* spawner.string(
      ChildProcess.make("ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { LC_ALL: "C", TZ: "UTC" },
        extendEnv: true,
      }),
    );
    const trimmed = started.trim();
    return trimmed.length === 0
      ? Option.none<ProcessIdentity>()
      : Option.some<ProcessIdentity>({ pid, started: trimmed });
  });

export const isAlive = (identity: ProcessIdentity) =>
  Effect.map(identify(identity.pid), (current) =>
    Option.exists(current, ({ started }) => started === identity.started),
  );
