import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { completeCommand, shellArg } from "kymo/shell";

const argv = (command: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.lines(
      ChildProcess.make("sh", ["-c", `kymo() { printf '%s\\n' "$@"; }; ${command}`]),
    );
  });

describe("shell", () => {
  it.effect("shellArg keeps plain words and quotes everything else for sh", () =>
    Effect.gen(function* () {
      assert.strictEqual(shellArg("ManagerApproval"), "ManagerApproval");
      for (const arg of ["Manager Approval", "-odd name", "it's", "$HOME", "a;b"]) {
        assert.deepStrictEqual(yield* argv(`kymo ${shellArg(arg)}`), [arg]);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "completeCommand gives a sh one deferred name, after -- when it starts with a dash",
    () =>
      Effect.gen(function* () {
        const run = (name: string) =>
          argv(`kymo ${completeCommand("e1", name).replace("<json>", `'{"ok":true}'`)}`);
        assert.deepStrictEqual(yield* run("ManagerApproval"), [
          "complete",
          "e1",
          "ManagerApproval",
          '{"ok":true}',
        ]);
        assert.deepStrictEqual(yield* run("Manager Approval"), [
          "complete",
          "e1",
          "Manager Approval",
          '{"ok":true}',
        ]);
        assert.deepStrictEqual(yield* run("-odd name"), [
          "complete",
          "--",
          "e1",
          "-odd name",
          '{"ok":true}',
        ]);
      }).pipe(Effect.provide(BunServices.layer)),
  );
});
