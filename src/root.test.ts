import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Root from "kymo/root";

describe("Root", () => {
  it("make places every file under the root", () => {
    assert.deepStrictEqual(Root.make("/tmp/kymo"), {
      root: "/tmp/kymo",
      config: "/tmp/kymo/kymo.json",
      db: "/tmp/kymo/kymo.db",
      daemon: "/tmp/kymo/daemon.json",
      log: "/tmp/kymo/daemon.log",
      owner: "/tmp/kymo/owner",
    });
  });

  it.effect("defaultRoot is .kymo under HOME", () =>
    Effect.gen(function* () {
      const root = yield* Root.defaultRoot.parse(
        ConfigProvider.fromEnv({ env: { HOME: "/home/operator" } }),
      );
      assert.strictEqual(root, "/home/operator/.kymo");
    }),
  );

  it("RootConfig accepts a port and workflow sources", () => {
    const decoded = Schema.decodeExit(Root.RootConfig)({
      port: 4100,
      workflows: ["kymo/gh-cli", "~/x/kymo.ts"],
    });
    assert.deepStrictEqual(
      decoded,
      Exit.succeed({ port: 4100, workflows: ["kymo/gh-cli", "~/x/kymo.ts"] }),
    );
  });

  it("RootConfig accepts port 0, which binds an ephemeral port", () => {
    const decoded = Schema.decodeExit(Root.RootConfig)({ port: 0, workflows: [] });
    assert.deepStrictEqual(decoded, Exit.succeed({ port: 0, workflows: [] }));
  });

  it("RootConfig rejects a port above 65535", () => {
    const decoded = Schema.decodeExit(Root.RootConfig)({ port: 65_536, workflows: [] });
    assert.isTrue(Exit.isFailure(decoded));
  });

  it("DaemonFile rejects port 0, because it records the port the daemon bound", () => {
    const decoded = Schema.decodeExit(Root.DaemonFile)({ pid: 42, port: 0 });
    assert.isTrue(Exit.isFailure(decoded));
  });

  it("RootConfig rejects an empty workflow source", () => {
    const decoded = Schema.decodeExit(Root.RootConfig)({ port: 4100, workflows: [""] });
    assert.isTrue(Exit.isFailure(decoded));
  });
});
