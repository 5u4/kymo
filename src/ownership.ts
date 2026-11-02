import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { KymoRoot } from "kymo/root";

export class RootOwned extends Schema.TaggedError<RootOwned>()("RootOwned", {
  root: Schema.String,
  pid: Schema.Int,
}) {
  override get message() {
    return `kymo root ${this.root} is owned by the daemon with pid ${this.pid}`;
  }
}

export class RootContended extends Schema.TaggedError<RootContended>()("RootContended", {
  root: Schema.String,
}) {
  override get message() {
    return `kymo root ${this.root} is being claimed by several daemons at once; try again`;
  }
}

interface Claim {
  readonly epoch: number;
  readonly pid: number;
  readonly alive: boolean;
}

export const isAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return Predicate.hasProperty(error, "code") && error.code === "EPERM";
    }
  });

const positiveInteger = /^[1-9]\d*$/;

const claims = (root: KymoRoot) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs
      .readDirectory(root.owner)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    const found = yield* Effect.forEach(
      names.filter((name) => positiveInteger.test(name)),
      (name) =>
        fs.readLink(`${root.owner}/${name}`).pipe(
          Effect.flatMap((target) => {
            const pid = positiveInteger.test(target) ? Number(target) : 0;
            return Effect.map(
              pid === 0 ? Effect.succeed(false) : isAlive(pid),
              (alive): Option.Option<Claim> => Option.some({ epoch: Number(name), pid, alive }),
            );
          }),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
        ),
    );
    return Arr.getSomes(found);
  });

export const liveOwner = (root: KymoRoot) =>
  Effect.map(claims(root), (found) =>
    Option.map(
      Arr.findFirst(found, (claim) => claim.alive),
      (claim) => claim.pid,
    ),
  );

class Contended extends Schema.TaggedError<Contended>()("Contended", {}) {}

const claim = (root: KymoRoot, pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(root.owner, { recursive: true });
    const before = yield* claims(root);
    const owner = before.find((other) => other.alive && other.pid !== pid);
    if (owner !== undefined) {
      return yield* new RootOwned({ root: root.root, pid: owner.pid });
    }
    const epoch = Math.max(0, ...before.map((other) => other.epoch)) + 1;
    const link = `${root.owner}/${epoch}`;
    yield* fs
      .symlink(String(pid), link)
      .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => new Contended()));
    const after = yield* claims(root);
    if (after.some((other) => other.alive && other.epoch !== epoch && other.pid !== pid)) {
      yield* fs.remove(link);
      return yield* new Contended();
    }
    yield* Effect.forEach(
      after.filter((other) => !other.alive),
      (other) =>
        fs
          .remove(`${root.owner}/${other.epoch}`)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void)),
      { discard: true },
    );
    return link;
  }).pipe(
    Effect.retry({
      while: Predicate.isTagged("Contended"),
      times: 20,
      schedule: Schedule.spaced("10 millis"),
    }),
    Effect.catchTag("Contended", () => new RootContended({ root: root.root })),
  );

export const acquire = (root: KymoRoot, pid: number) =>
  Effect.acquireRelease(claim(root, pid), (link) =>
    FileSystem.FileSystem.use((fs) => fs.remove(link)).pipe(Effect.ignore),
  );
