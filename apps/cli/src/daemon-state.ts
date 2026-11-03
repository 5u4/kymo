import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Api, url } from "kymo/api";
import * as ProcessIdentity from "kymo/process-identity";
import * as Root from "kymo/root";

export type DaemonState = Data.TaggedEnum<{
  Stopped: { readonly stale: boolean };
  Running: Root.DaemonFile;
}>;
export const DaemonState = Data.taggedEnum<DaemonState>();
export type Running = Data.TaggedEnum.Value<DaemonState, "Running">;

const readDaemonFile = (path: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(path)).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Root.DaemonFile))),
    Effect.option,
  );

export const derive = (root: Root.KymoRoot) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(root.daemon))) {
      return DaemonState.Stopped({ stale: false });
    }
    const file = yield* readDaemonFile(root.daemon);
    if (Option.isNone(file) || !(yield* ProcessIdentity.isAlive(file.value))) {
      return DaemonState.Stopped({ stale: true });
    }
    const { pid, port } = file.value;
    const health = yield* HttpApiClient.make(Api, { baseUrl: url(port) }).pipe(
      Effect.flatMap((client) => client.health()),
      Effect.timeout("1 second"),
      Effect.option,
    );
    return Option.isSome(health) && health.value.pid === pid
      ? DaemonState.Running(file.value)
      : DaemonState.Stopped({ stale: true });
  });

export const cleanStale = (root: Root.KymoRoot) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const taken = `${root.daemon}.${process.pid}.stale`;
    // POSIX has no conditional unlink, so rename first and inspect exactly the file we took.
    const took = yield* fs.rename(root.daemon, taken).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
    );
    if (!took) {
      return;
    }
    const file = yield* readDaemonFile(taken);
    const live = Option.isSome(file) && (yield* ProcessIdentity.isAlive(file.value));
    const restore = live
      ? fs
          .link(taken, root.daemon)
          .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void))
      : Effect.void;
    yield* restore.pipe(Effect.ensuring(Effect.ignore(fs.remove(taken))));
  });
