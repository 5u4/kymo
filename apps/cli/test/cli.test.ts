import * as BunServices from "@effect/platform-bun/BunServices";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { decode } from "@toon-format/toon";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { Api, url } from "kymo/api";
import * as ProcessIdentity from "kymo/process-identity";
import * as Root from "kymo/root";

const repo = `${import.meta.dirname}/../../..`;
const cli = `${repo}/apps/cli/src/main.ts`;
const fixtures = `${repo}/apps/daemon/test/fixtures`;

const services = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const kymo = (root: Root.KymoRoot, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [cli, "--root", root.root, ...args]),
    );
    const [stdout, code] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
      { concurrency: "unbounded" },
    );
    return { stdout, code: Number(code), output: decode(stdout) };
  }).pipe(Effect.scoped);

const DaemonOutput = Schema.Struct({
  daemon: Schema.Struct({ status: Schema.String, pid: Schema.Int }),
});

const daemonIn = (output: unknown) => Schema.decodeUnknownSync(DaemonOutput)(output).daemon;

const daemonPids = (root: Root.KymoRoot) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const lines = yield* spawner.lines(ChildProcess.make("ps", ["-axo", "pid=,args="]));
    return lines
      .filter((line) => line.endsWith(`apps/daemon/src/main.ts --root ${root.root}`))
      .map((line) => Number.parseInt(line.trim(), 10));
  });

const settled = <A, E, R>(effect: Effect.Effect<A, E, R>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = yield* effect;
      if (until(value)) {
        return value;
      }
      yield* Effect.sleep("50 millis");
    }
    return yield* effect;
  });

const tempRoot = (sources: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = Root.make(yield* fs.makeTempDirectoryScoped());
    yield* Effect.addFinalizer(() =>
      daemonPids(root).pipe(
        Effect.flatMap((pids) =>
          Effect.forEach(pids, (pid) =>
            Effect.ignore(Effect.try(() => process.kill(pid, "SIGKILL"))),
          ),
        ),
        Effect.provide(BunServices.layer),
        Effect.orDie,
      ),
    );
    const config = yield* Schema.encodeEffect(Schema.fromJsonString(Root.RootConfig))({
      port: 0,
      workflows: sources.map((source) =>
        path.isAbsolute(source) ? path.relative(root.root, source) : source,
      ),
    });
    yield* fs.writeFileString(root.config, config);
    return root;
  });

const daemonFile = (root: Root.KymoRoot) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(root.daemon)).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Root.DaemonFile))),
  );

const health = (port: number) =>
  HttpApiClient.make(Api, { baseUrl: url(port) }).pipe(Effect.flatMap((client) => client.health()));

describe.concurrent("kymo start, stop and home", () => {
  it.live(
    "start runs a daemon that answers with the pid in daemon.json; start again reports it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* tempRoot([]);
        const first = yield* kymo(root, "start");
        assert.strictEqual(first.code, 0, first.stdout);
        const file = yield* daemonFile(root);
        assert.deepStrictEqual(yield* health(file.port), {
          pid: file.pid,
          root: root.root,
          defaultRoot: false,
        });
        assert.deepStrictEqual(daemonIn(first.output), { status: "started", pid: file.pid });

        const second = yield* kymo(root, "start");
        assert.strictEqual(second.code, 0, second.stdout);
        assert.deepStrictEqual(daemonIn(second.output), { status: "running", pid: file.pid });
        assert.deepStrictEqual(yield* settled(daemonPids(root), (found) => found.length <= 1), [
          file.pid,
        ]);
        assert.notInclude(
          yield* fs.readFileString(root.log),
          "is owned by",
          "a second start must not spawn another daemon",
        );
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("stop ends the daemon and removes daemon.json; stop again succeeds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* tempRoot([]);
      const started = yield* kymo(root, "start");
      const { pid } = daemonIn(started.output);

      const stopped = yield* kymo(root, "stop");
      assert.strictEqual(stopped.code, 0, stopped.stdout);
      assert.deepStrictEqual(daemonIn(stopped.output), { status: "stopped", pid });
      assert.isFalse(alive(pid), "the daemon process is gone");
      assert.isFalse(yield* fs.exists(root.daemon), "daemon.json is removed");
      assert.deepStrictEqual(
        yield* fs.readDirectory(root.owner),
        [],
        "the ownership marker is removed",
      );

      const again = yield* kymo(root, "stop");
      assert.strictEqual(again.code, 0, again.stdout);
      assert.include(again.stdout, "status: not running");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("start after the daemon was killed with SIGKILL starts a new daemon", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot([]);
      const killed = daemonIn((yield* kymo(root, "start")).output).pid;
      process.kill(killed, "SIGKILL");
      yield* settled(
        Effect.sync(() => alive(killed)),
        (isAlive) => !isAlive,
      );

      const restarted = yield* kymo(root, "start");
      assert.strictEqual(restarted.code, 0, restarted.stdout);
      const { pid } = daemonIn(restarted.output);
      assert.notStrictEqual(pid, killed);
      assert.isTrue(alive(pid));
      assert.strictEqual((yield* health((yield* daemonFile(root)).port)).pid, pid);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("stop after the daemon was killed with SIGKILL removes the stale daemon.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* tempRoot([]);
      const killed = daemonIn((yield* kymo(root, "start")).output).pid;
      process.kill(killed, "SIGKILL");
      yield* settled(
        Effect.sync(() => alive(killed)),
        (isAlive) => !isAlive,
      );

      const stopped = yield* kymo(root, "stop");
      assert.strictEqual(stopped.code, 0, stopped.stdout);
      assert.include(stopped.stdout, "status: not running");
      assert.isFalse(yield* fs.exists(root.daemon), "the stale daemon.json is removed");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("stop ends a daemon that holds the root but no longer answers", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot([]);
      const hung = daemonIn((yield* kymo(root, "start")).output).pid;
      process.kill(hung, "SIGSTOP");

      const stopped = yield* kymo(root, "stop");
      assert.strictEqual(stopped.code, 0, stopped.stdout);
      assert.deepStrictEqual(daemonIn(stopped.output), { status: "stopped", pid: hung });
      assert.isFalse(alive(hung), "the hung daemon is gone");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live(
    "stop and start leave alone an unrelated process that reuses a leftover claim's pid",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* tempRoot([]);
        const unrelated = yield* spawner.spawn(ChildProcess.make("sleep", ["60"]));
        const leftover = { pid: Number(unrelated.pid), started: "Thu Jan  1 00:00:00 1970" };
        yield* fs.makeDirectory(root.owner);
        yield* fs.symlink(
          yield* Schema.encodeEffect(ProcessIdentity.ProcessIdentityJson)(leftover),
          `${root.owner}/1`,
        );
        yield* fs.writeFileString(
          root.daemon,
          yield* Schema.encodeEffect(Schema.fromJsonString(Root.DaemonFile))({
            ...leftover,
            port: 1,
          }),
        );

        const stopped = yield* kymo(root, "stop");
        assert.strictEqual(stopped.code, 0, stopped.stdout);
        assert.isTrue(yield* unrelated.isRunning, "stop must not signal the unrelated process");

        const started = yield* kymo(root, "start");
        assert.strictEqual(started.code, 0, started.stdout);
        assert.notStrictEqual(daemonIn(started.output).pid, leftover.pid);
        assert.isTrue(yield* unrelated.isRunning, "start must not signal the unrelated process");
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live(
    "start fails with the daemon's error when a source cannot be imported, ignoring older log",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* tempRoot(["./missing.ts"]);
        yield* fs.writeFileString(root.log, "an earlier run wrote this line\n".repeat(200_000));
        const result = yield* kymo(root, "start");
        assert.strictEqual(result.code, 1, result.stdout);
        assert.include(result.stdout, "workflow source ./missing.ts could not be imported");
        assert.notInclude(result.stdout, "an earlier run");
        assert.deepStrictEqual(yield* daemonPids(root), []);
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("start fails and says to delete kymo.db when it has an older kymo schema", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* tempRoot([`${repo}/examples/demo/src/index.ts`]);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          CREATE TABLE kymo_migrations (
            migration_id integer PRIMARY KEY NOT NULL,
            created_at datetime NOT NULL DEFAULT current_timestamp,
            name VARCHAR(255) NOT NULL
          )
        `;
        yield* sql`INSERT INTO kymo_migrations (migration_id, name) VALUES (1, 'labels')`;
        yield* sql`
          CREATE TABLE kymo_labels (execution_id TEXT PRIMARY KEY, label TEXT NOT NULL)
        `;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: root.db })));

      const result = yield* kymo(root, "start");
      assert.strictEqual(result.code, 1, result.stdout);
      assert.include(result.stdout, `${root.db} does not match this kymo's schema; delete it`);
      assert.deepStrictEqual(yield* daemonPids(root), []);

      yield* Effect.forEach(["", "-wal", "-shm"], (suffix) =>
        fs.remove(`${root.db}${suffix}`, { force: true }),
      );
      const restarted = yield* kymo(root, "start");
      assert.strictEqual(restarted.code, 0, restarted.stdout);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("start fails when two sources register the same workflow", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot([`${fixtures}/child.ts`, `${fixtures}/duplicate-child.ts`]);
      const result = yield* kymo(root, "start");
      assert.strictEqual(result.code, 1, result.stdout);
      assert.match(
        result.stdout,
        /workflow Child is registered by both \.\.\/\S*\/child\.ts and \.\.\/\S*\/duplicate-child\.ts/,
      );
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("names inherited from Object.prototype are unknown commands", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot([]);
      for (const name of ["constructor", "toString", "__proto__"]) {
        for (const args of [[name], [name, "--help"]]) {
          const result = yield* kymo(root, ...args);
          assert.strictEqual(result.code, 2, result.stdout);
          assert.deepStrictEqual(result.output, {
            error: `unknown command ${name}`,
            help: ["Run `kymo --help`"],
          });
        }
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("kymo while stopped prints an error that points at kymo start", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot([]);
      const result = yield* kymo(root);
      assert.strictEqual(result.code, 1, result.stdout);
      assert.deepStrictEqual(result.output, {
        error: "the kymo daemon is not running",
        root: root.root,
        help: [`Run \`kymo --root ${root.root} start\` to start it`],
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("kymo while running shows the daemon", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot([]);
      const { pid } = daemonIn((yield* kymo(root, "start")).output);
      const result = yield* kymo(root);
      assert.strictEqual(result.code, 0, result.stdout);
      assert.deepStrictEqual(daemonIn(result.output), { status: "running", pid });
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("two concurrent starts leave one daemon and report the same pid", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot([]);
      const [a, b] = yield* Effect.all([kymo(root, "start"), kymo(root, "start")], {
        concurrency: 2,
      });
      assert.strictEqual(a.code, 0, a.stdout);
      assert.strictEqual(b.code, 0, b.stdout);
      const pid = daemonIn(a.output).pid;
      assert.strictEqual(daemonIn(b.output).pid, pid);
      const pids = yield* settled(daemonPids(root), (found) => found.length <= 1);
      assert.deepStrictEqual(pids, [pid]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

const ExecutionsOutput = Schema.Struct({
  executions: Schema.Array(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  total: Schema.Int,
  shown: Schema.optional(Schema.Int),
  help: Schema.Array(Schema.String),
});

const listIn = (output: unknown) => Schema.decodeUnknownSync(ExecutionsOutput)(output);

const DetailOutput = Schema.Struct({
  execution: Schema.Struct({
    id: Schema.String,
    workflow: Schema.String,
    label: Schema.String,
    status: Schema.String,
    payload: Schema.Struct({ id: Schema.String }),
  }),
  activities: Schema.Array(
    Schema.Struct({ name: Schema.String, attempt: Schema.Int, status: Schema.String }),
  ),
  children: Schema.Array(Schema.String),
  waits: Schema.Array(Schema.Struct({ kind: Schema.String, name: Schema.String })),
});

const AmbiguousOutput = Schema.Struct({
  error: Schema.String,
  candidates: Schema.Array(Schema.String),
  help: Schema.Array(Schema.String),
});

const seeded = Effect.gen(function* () {
  const root = yield* tempRoot([`${fixtures}/seeded.ts`]);
  const started = yield* kymo(root, "start");
  assert.strictEqual(started.code, 0, started.stdout);
  const listed = yield* settled(
    Effect.map(kymo(root, "executions", "--limit", "50"), (result) => listIn(result.output)),
    ({ executions, total }) =>
      total === 21 &&
      executions.some((row) => row["status"] === "suspended (deferred Gate)") &&
      executions.every((row) => row["status"] !== "running"),
  );
  return {
    root,
    ids: listed.executions.map((row) => row["id"] ?? ""),
    gate: listed.executions.find((row) => row["label"] === "g")?.["id"] ?? "",
  };
});

describe.concurrent("kymo executions and execution", () => {
  it.live("lists executions with default and extra fields, a limit and a status filter", () =>
    Effect.gen(function* () {
      const { root } = yield* seeded;

      const all = yield* kymo(root, "executions", "--limit", "50");
      assert.strictEqual(all.code, 0, all.stdout);
      const listed = listIn(all.output);
      assert.strictEqual(listed.total, 21);
      for (const row of listed.executions) {
        assert.deepStrictEqual(Object.keys(row).toSorted(), ["id", "label", "status", "workflow"]);
      }
      const byLabel = new Map(listed.executions.map((row) => [row["label"], row]));
      assert.deepInclude(byLabel.get("s"), { workflow: "Succeed", status: "succeeded" });
      assert.deepInclude(byLabel.get("f"), {
        workflow: "FailTyped",
        status: 'failed (Fail: Boom {"reason":"typed"})',
      });
      assert.deepInclude(byLabel.get("g"), {
        workflow: "AwaitGate",
        status: "suspended (deferred Gate)",
      });
      assert.match(
        byLabel.get("n")?.["status"] ?? "",
        /^suspended \(clock nap until \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\)$/,
      );

      const limited = yield* kymo(root, "executions");
      assert.strictEqual(limited.code, 0, limited.stdout);
      const page = listIn(limited.output);
      assert.strictEqual(page.shown, 20);
      assert.strictEqual(page.total, 21);
      assert.include(page.help.join("\n"), "--limit 21");

      const quick = yield* kymo(
        root,
        "executions",
        "--status",
        "succeeded",
        "--workflow",
        "Quick",
        "--limit",
        "5",
      );
      assert.strictEqual(quick.code, 0, quick.stdout);
      const quickPage = listIn(quick.output);
      assert.strictEqual(quickPage.shown, 5);
      assert.strictEqual(quickPage.total, 17);
      assert.include(
        quickPage.help,
        `Run \`kymo --root ${root.root} executions --status succeeded --workflow Quick --limit 17\` to see all 17`,
      );

      const wide = yield* kymo(root, "executions", "--fields", "started,parent", "--limit", "1");
      assert.strictEqual(wide.code, 0, wide.stdout);
      const [row] = listIn(wide.output).executions;
      assert.deepStrictEqual(Object.keys(row ?? {}).toSorted(), [
        "id",
        "label",
        "parent",
        "started",
        "status",
        "workflow",
      ]);
      assert.match(row?.["started"] ?? "", /^\d{4}-\d\d-\d\dT/);
      assert.isNull(row?.["parent"]);

      const failed = yield* kymo(root, "executions", "--status", "failed");
      assert.strictEqual(failed.code, 0, failed.stdout);
      assert.deepStrictEqual(
        listIn(failed.output).executions.map((row) => row["label"]),
        ["f"],
      );

      const badStatus = yield* kymo(root, "executions", "--status", "bogus");
      assert.strictEqual(badStatus.code, 2, badStatus.stdout);
      const badField = yield* kymo(root, "executions", "--fields", "payload");
      assert.strictEqual(badField.code, 2, badField.stdout);
      const unknownFlag = yield* kymo(root, "executions", "--full");
      assert.strictEqual(unknownFlag.code, 2, unknownFlag.stdout);
      const swallowed = yield* kymo(root, "executions", "--workflow", "--full");
      assert.strictEqual(swallowed.code, 2, swallowed.stdout);
      assert.deepStrictEqual(swallowed.output, {
        error: "--workflow needs <name>",
        help: ["Run `kymo --help`"],
      });
      const dashedRoot = yield* kymo(root, "executions", "--root", "--full");
      assert.strictEqual(dashedRoot.code, 2, dashedRoot.stdout);
      assert.deepStrictEqual(dashedRoot.output, {
        error: "--root needs a directory",
        help: ["Run `kymo --help`"],
      });
      const inline = yield* kymo(root, "executions", "--workflow=-x");
      assert.strictEqual(inline.code, 0, inline.stdout);
      assert.strictEqual(listIn(inline.output).total, 0);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("prints a --limit hint that a shell runs with the same filters", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot([`${fixtures}/odd-name.ts`]);
      const started = yield* kymo(root, "start");
      assert.strictEqual(started.code, 0, started.stdout);
      const page = yield* settled(
        Effect.map(kymo(root, "executions", "--workflow=-odd name", "--limit", "1"), (result) =>
          listIn(result.output),
        ),
        ({ total }) => total === 2,
      );
      const hint = page.help
        .map((line) => /^Run `(kymo --root \S+ executions .*)` to see all 2$/.exec(line)?.[1])
        .find((command) => command !== undefined);
      assert.isDefined(hint, page.help.join("\n"));

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", `kymo() { '${process.execPath}' '${cli}' "$@"; }; ${hint}`]),
      );
      const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
      const followed = listIn(decode(stdout));
      assert.strictEqual(followed.total, 2, stdout);
      assert.strictEqual(followed.shown, 2, stdout);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("shows one execution by full id or unique prefix and rejects other ids", () =>
    Effect.gen(function* () {
      const { root, ids, gate } = yield* seeded;

      const full = yield* kymo(root, "execution", gate);
      assert.strictEqual(full.code, 0, full.stdout);
      assert.deepStrictEqual(Schema.decodeUnknownSync(DetailOutput)(full.output), {
        execution: {
          id: gate,
          workflow: "AwaitGate",
          label: "g",
          status: "suspended (deferred Gate)",
          payload: { id: "g" },
        },
        activities: [{ name: "AwaitGate.step", attempt: 1, status: "succeeded" }],
        children: [],
        waits: [{ kind: "Deferred", name: "Gate" }],
      });

      const prefix = Array.from({ length: gate.length }, (_, index) =>
        gate.slice(0, index + 1),
      ).find((candidate) => ids.filter((id) => id.startsWith(candidate)).length === 1);
      assert.isBelow(prefix?.length ?? Infinity, gate.length);
      const byPrefix = yield* kymo(root, "execution", prefix ?? "");
      assert.strictEqual(byPrefix.code, 0, byPrefix.stdout);
      assert.strictEqual(
        Schema.decodeUnknownSync(DetailOutput)(byPrefix.output).execution.id,
        gate,
      );

      const shared = "0123456789abcdef"
        .split("")
        .find((digit) => ids.filter((id) => id.startsWith(digit)).length > 1);
      assert.isDefined(shared, "21 hex ids share a first digit");
      const ambiguous = yield* kymo(root, "execution", shared ?? "");
      assert.strictEqual(ambiguous.code, 1, ambiguous.stdout);
      const candidates = ids.filter((id) => id.startsWith(shared ?? ""));
      const reported = Schema.decodeUnknownSync(AmbiguousOutput)(ambiguous.output);
      assert.deepStrictEqual(
        { ...reported, candidates: reported.candidates.toSorted() },
        {
          error: `${shared} matches ${candidates.length} executions`,
          candidates: candidates.toSorted(),
          help: [`Run \`kymo --root ${root.root} execution <id>\` with a longer prefix`],
        },
      );

      const unknown = yield* kymo(root, "execution", "nope");
      assert.strictEqual(unknown.code, 1, unknown.stdout);
      assert.deepStrictEqual(unknown.output, {
        error: "no execution matches nope",
        help: [`Run \`kymo --root ${root.root} executions\` to list executions`],
      });

      const missing = yield* kymo(root, "execution");
      assert.strictEqual(missing.code, 2, missing.stdout);
      assert.deepStrictEqual(missing.output, {
        error: "kymo execution needs <id>",
        help: ["Run `kymo --help`"],
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("reports a stopped daemon, then an explicit empty list once it runs", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot([]);
      const stopped = yield* kymo(root, "executions");
      assert.strictEqual(stopped.code, 1, stopped.stdout);
      assert.deepStrictEqual(stopped.output, {
        error: "the kymo daemon is not running",
        root: root.root,
        help: [`Run \`kymo --root ${root.root} start\` to start it`],
      });

      yield* kymo(root, "start");
      const empty = yield* kymo(root, "executions");
      assert.strictEqual(empty.code, 0, empty.stdout);
      assert.deepStrictEqual(empty.output, {
        executions: [],
        total: 0,
        help: ["No executions yet; they appear once a workflow starts"],
      });

      const usage = yield* kymo(root, "execution", "--help");
      assert.strictEqual(usage.code, 0, usage.stdout);
      assert.strictEqual(
        Schema.decodeUnknownSync(Schema.Struct({ usage: Schema.String }))(usage.output).usage,
        "kymo execution <id> [--full] [--logs] [--root <dir>]",
      );
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

const ExecutedOutput = Schema.Struct({
  execution: Schema.Struct({
    id: Schema.String,
    workflow: Schema.String,
    label: Schema.NullOr(Schema.String),
    status: Schema.String,
  }),
  created: Schema.Boolean,
  help: Schema.Array(Schema.String),
});

const executedIn = (output: unknown) => Schema.decodeUnknownSync(ExecutedOutput)(output);

const running = (sources: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const root = yield* tempRoot(sources);
    const started = yield* kymo(root, "start");
    assert.strictEqual(started.code, 0, started.stdout);
    return root;
  });

describe.concurrent("kymo execute", () => {
  it.live("starts a workflow with a label that executions and execution show", () =>
    Effect.gen(function* () {
      const root = yield* running([`${fixtures}/statuses.ts`]);

      const labeled = yield* kymo(
        root,
        "execute",
        "AwaitGate",
        '{"id":"k1"}',
        "--label",
        "nightly",
      );
      assert.strictEqual(labeled.code, 0, labeled.stdout);
      const first = executedIn(labeled.output);
      assert.deepInclude(first.execution, { workflow: "AwaitGate", label: "nightly (k1)" });
      assert.isTrue(first.created);
      assert.deepStrictEqual(first.help, [
        `Run \`kymo --root ${root.root} execution ${first.execution.id}\` to see it`,
      ]);

      const bare = yield* kymo(root, "execute", "AwaitGate", '{"id":"k2"}');
      assert.strictEqual(bare.code, 0, bare.stdout);
      const second = executedIn(bare.output);
      assert.strictEqual(second.execution.label, "k2");
      assert.isTrue(second.created);

      const listed = listIn((yield* kymo(root, "executions")).output);
      assert.deepStrictEqual(
        Object.fromEntries(listed.executions.map((row) => [row["id"], row["label"]])),
        { [first.execution.id]: "nightly (k1)", [second.execution.id]: "k2" },
      );
      const detail = yield* kymo(root, "execution", first.execution.id);
      assert.strictEqual(detail.code, 0, detail.stdout);
      assert.strictEqual(
        Schema.decodeUnknownSync(DetailOutput)(detail.output).execution.label,
        "nightly (k1)",
      );
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("repeating an idempotency key returns the existing execution and keeps its label", () =>
    Effect.gen(function* () {
      const root = yield* running([`${fixtures}/statuses.ts`]);
      const first = executedIn(
        (yield* kymo(root, "execute", "AwaitGate", '{"id":"same"}', "--label", "first")).output,
      );

      const again = yield* kymo(root, "execute", "AwaitGate", '{"id":"same"}', "--label", "second");
      assert.strictEqual(again.code, 0, again.stdout);
      const repeated = executedIn(again.output);
      assert.isFalse(repeated.created);
      assert.strictEqual(repeated.execution.id, first.execution.id);
      assert.strictEqual(repeated.execution.label, "first (same)");
      assert.include(repeated.help, "The execution already existed; its label was not changed");
      assert.strictEqual(listIn((yield* kymo(root, "executions")).output).total, 1);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("rejects an unknown workflow, a payload the workflow refuses, and malformed JSON", () =>
    Effect.gen(function* () {
      const root = yield* running([`${fixtures}/double.ts`, `${fixtures}/child.ts`]);

      const unknown = yield* kymo(root, "execute", "Triple", '{"n":1}');
      assert.strictEqual(unknown.code, 1, unknown.stdout);
      assert.deepStrictEqual(unknown.output, {
        error: "no workflow named Triple",
        registered: ["Child", "Double"],
        help: [
          `Run \`kymo --root ${root.root} execute Child <payload>\` to start a registered workflow`,
        ],
      });

      const refused = yield* kymo(root, "execute", "Double", '{"n":"one"}');
      assert.strictEqual(refused.code, 1, refused.stdout);
      assert.deepStrictEqual(refused.output, {
        error: 'invalid payload for Double: Expected number at ["n"]',
        expected: '{ readonly "n": number }',
        help: [
          `Run \`kymo --root ${root.root} execute Double <payload>\` with a payload of the expected shape`,
        ],
      });

      const malformed = yield* kymo(root, "execute", "Double", "{n:1}");
      assert.strictEqual(malformed.code, 2, malformed.stdout);
      const emptyLabel = yield* kymo(root, "execute", "Double", '{"n":1}', "--label=");
      assert.strictEqual(emptyLabel.code, 2, emptyLabel.stdout);
      assert.strictEqual(listIn((yield* kymo(root, "executions")).output).total, 0);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("starts a workflow whose name begins with a dash after --", () =>
    Effect.gen(function* () {
      const root = yield* running([`${fixtures}/odd-name.ts`]);

      const bare = yield* kymo(root, "execute", "--", "-odd name", '{"id":"c"}');
      assert.strictEqual(bare.code, 0, bare.stdout);
      assert.deepInclude(executedIn(bare.output), { created: true });

      const labeled = yield* kymo(root, "execute", "--label", "x", "--", "-odd name", '{"id":"d"}');
      assert.strictEqual(labeled.code, 0, labeled.stdout);
      const executed = executedIn(labeled.output);
      assert.isTrue(executed.created);
      assert.deepInclude(executed.execution, { workflow: "-odd name", label: "x (d)" });

      const unknown = yield* kymo(root, "execute", "Triple", '{"id":"e"}');
      assert.strictEqual(unknown.code, 1, unknown.stdout);
      assert.deepStrictEqual(unknown.output, {
        error: "no workflow named Triple",
        registered: ["-odd name"],
        help: [
          `Run \`kymo --root ${root.root} execute -- '-odd name' <payload>\` to start a registered workflow`,
        ],
      });
      const [line] = Schema.decodeUnknownSync(Schema.Struct({ help: Schema.Array(Schema.String) }))(
        unknown.output,
      ).help;
      const hint = /^Run `(.*)` to start a registered workflow$/
        .exec(line ?? "")?.[1]
        ?.replace("<payload>", `'{"id":"e"}'`);
      assert.isDefined(hint);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", `kymo() { '${process.execPath}' '${cli}' "$@"; }; ${hint}`]),
      );
      const [stdout, code] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(Number(code), 0, stdout);
      assert.isTrue(executedIn(decode(stdout)).created);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

const LogsOutput = Schema.Struct({
  execution: Schema.Struct({ id: Schema.String }),
  logs: Schema.Array(
    Schema.Struct({
      pass: Schema.Int,
      at: Schema.String,
      level: Schema.String,
      source: Schema.String,
      message: Schema.String,
    }),
  ),
  help: Schema.Array(Schema.String),
});

describe.concurrent("kymo execution --logs", () => {
  it.live("shows an execution's workflow logs, which never reach daemon.log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* running([`${fixtures}/logs.ts`]);
      const { id } = executedIn(
        (yield* kymo(root, "execute", "Chatty", '{"id":"cli"}')).output,
      ).execution;

      const plain = yield* kymo(root, "execution", id);
      assert.strictEqual(plain.code, 0, plain.stdout);
      assert.include(
        Schema.decodeUnknownSync(Schema.Struct({ help: Schema.Array(Schema.String) }))(plain.output)
          .help,
        `Run \`kymo --root ${root.root} execution ${id} --logs\` to see its logs`,
      );

      const shown = yield* settled(
        Effect.map(kymo(root, "execution", id.slice(0, 12), "--logs"), (result) =>
          Schema.decodeUnknownSync(LogsOutput)(result.output),
        ),
        ({ logs }) => logs.length >= 4,
      );
      assert.strictEqual(shown.execution.id, id);
      assert.deepStrictEqual(
        shown.logs.map(({ at: _at, ...line }) => line),
        [
          { pass: 1, level: "info", source: "body", message: "body start" },
          { pass: 1, level: "info", source: "Chatty.flaky#1", message: "flaky attempt 1" },
          { pass: 1, level: "info", source: "Chatty.flaky#2", message: "flaky attempt 2" },
          { pass: 1, level: "warn", source: "body", message: "waiting for approval" },
        ],
      );
      assert.notInclude(shown.help.join("\n"), "--logs`", "no --logs hint once logs are shown");

      const daemonLog = yield* fs.readFileString(root.log);
      for (const message of ["body start", "flaky attempt", "waiting for approval"]) {
        assert.notInclude(daemonLog, message);
      }

      const unknown = yield* kymo(root, "execution", "nope", "--logs");
      assert.strictEqual(unknown.code, 1, unknown.stdout);
      assert.deepStrictEqual(unknown.output, {
        error: "no execution matches nope",
        help: [`Run \`kymo --root ${root.root} executions\` to list executions`],
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

const Requested = Schema.Struct({
  execution: Schema.Struct({ id: Schema.String, workflow: Schema.String }),
  requested: Schema.String,
  help: Schema.Array(Schema.String),
});

const Failure = Schema.Struct({
  error: Schema.String,
  expected: Schema.optionalKey(Schema.String),
  waiting: Schema.optional(Schema.Array(Schema.String)),
  help: Schema.Array(Schema.String),
});

const statusOf = (root: Root.KymoRoot, id: string) =>
  Effect.map(kymo(root, "execution", id), (result) =>
    Schema.decodeUnknownSync(
      Schema.Struct({
        execution: Schema.Struct({ status: Schema.String }),
        help: Schema.Array(Schema.String),
      }),
    )(result.output),
  );

const refund = (root: Root.KymoRoot, orderId: string) =>
  Effect.gen(function* () {
    const payload = `{"orderId":"${orderId}","amountCents":500,"reason":"damaged"}`;
    const { id } = executedIn(
      (yield* kymo(root, "execute", "RefundRequest", payload)).output,
    ).execution;
    const waiting = yield* settled(
      statusOf(root, id),
      ({ execution }) => execution.status === "suspended (deferred ManagerApproval)",
    );
    assert.strictEqual(waiting.execution.status, "suspended (deferred ManagerApproval)");
    return { id, help: waiting.help };
  });

describe.concurrent("kymo complete, resume and interrupt", () => {
  it.live("complete continues a waiting execution and rejects a value it cannot take", () =>
    Effect.gen(function* () {
      const root = yield* running([`${repo}/examples/demo/src/index.ts`]);
      const { id, help } = yield* refund(root, "ord_00001");
      const kymoHint = `kymo --root ${root.root}`;
      assert.isTrue(
        help.some((line) => line.includes(`\`${kymoHint} complete ${id} ManagerApproval <json>\``)),
        help.join("\n"),
      );
      assert.isTrue(
        help.some((line) => line.includes(`\`${kymoHint} interrupt ${id}\``)),
        help.join("\n"),
      );
      assert.isFalse(
        help.some((line) => line.includes(" resume ")),
        help.join("\n"),
      );

      const malformed = yield* kymo(root, "complete", id, "ManagerApproval", "{approved");
      assert.strictEqual(malformed.code, 2, malformed.stdout);

      const invalid = yield* kymo(root, "complete", id, "ManagerApproval", '{"approved":"yes"}');
      assert.strictEqual(invalid.code, 1, invalid.stdout);
      assert.deepStrictEqual(Schema.decodeUnknownSync(Failure)(invalid.output), {
        error:
          'invalid value for ManagerApproval: Expected boolean at ["approved"] Missing key at ["approver"]',
        expected: '{ readonly "approved": boolean, readonly "approver": string }',
        help: [
          `Run \`${kymoHint} complete ${id} ManagerApproval <json>\` with a value of the expected shape`,
        ],
      });

      const other = yield* kymo(root, "complete", id, "Other", "{}");
      assert.strictEqual(other.code, 1, other.stdout);
      assert.deepStrictEqual(Schema.decodeUnknownSync(Failure)(other.output).waiting, [
        "ManagerApproval",
      ]);

      const resumed = yield* kymo(root, "resume", id);
      assert.strictEqual(resumed.code, 1, resumed.stdout);
      assert.isTrue(
        Schema.decodeUnknownSync(Failure)(resumed.output).help.some((line) =>
          line.includes(`\`${kymoHint} complete ${id} ManagerApproval <json>\``),
        ),
        resumed.stdout,
      );

      const completed = yield* kymo(
        root,
        "complete",
        id.slice(0, 12),
        "ManagerApproval",
        '{"approved":true,"approver":"alice"}',
      );
      assert.strictEqual(completed.code, 0, completed.stdout);
      const requested = Schema.decodeUnknownSync(Requested)(completed.output);
      assert.deepStrictEqual(
        { id: requested.execution.id, requested: requested.requested },
        { id, requested: "complete" },
      );
      const done = yield* settled(
        statusOf(root, id),
        ({ execution }) => execution.status === "succeeded",
      );
      assert.strictEqual(done.execution.status, "succeeded");

      const again = yield* kymo(
        root,
        "complete",
        id,
        "ManagerApproval",
        '{"approved":true,"approver":"eve"}',
      );
      assert.strictEqual(again.code, 1, again.stdout);
      assert.deepStrictEqual(Schema.decodeUnknownSync(Failure)(again.output).waiting, []);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("interrupt ends a waiting execution; an ended one refuses resume and interrupt", () =>
    Effect.gen(function* () {
      const root = yield* running([`${repo}/examples/demo/src/index.ts`]);
      const { id } = yield* refund(root, "ord_00002");

      const interrupted = yield* kymo(root, "interrupt", id);
      assert.strictEqual(interrupted.code, 0, interrupted.stdout);
      assert.strictEqual(
        Schema.decodeUnknownSync(Requested)(interrupted.output).requested,
        "interrupt",
      );
      const ended = yield* settled(
        statusOf(root, id),
        ({ execution }) => execution.status === "interrupted",
      );
      assert.strictEqual(ended.execution.status, "interrupted");

      for (const action of ["interrupt", "resume"]) {
        const refused = yield* kymo(root, action, id);
        assert.strictEqual(refused.code, 1, refused.stdout);
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("rejects a foreign Origin before any handler runs and accepts the daemon's own", () =>
    Effect.gen(function* () {
      const root = yield* running([`${repo}/examples/demo/src/index.ts`]);
      const { port } = yield* daemonFile(root);
      const client = yield* HttpClient.HttpClient;
      const interrupt = (id: string, origin?: string) =>
        client.execute(
          HttpClientRequest.post(`${url(port)}/api/executions/${id}/interrupt`).pipe(
            origin === undefined
              ? (request) => request
              : HttpClientRequest.setHeader("origin", origin),
          ),
        );

      const foreign = yield* refund(root, "ord_00010");
      for (const origin of ["http://evil.example", `http://evil.example:${port}`, "null"]) {
        assert.strictEqual((yield* interrupt(foreign.id, origin)).status, 403, origin);
      }
      assert.strictEqual(
        (yield* statusOf(root, foreign.id)).execution.status,
        "suspended (deferred ManagerApproval)",
      );

      for (const [orderId, origin] of [
        ["ord_00011", `http://127.0.0.1:${port}`],
        ["ord_00012", `http://localhost:${port}`],
        ["ord_00013", undefined],
      ] as const) {
        const { id } = yield* refund(root, orderId);
        assert.strictEqual((yield* interrupt(id, origin)).status, 200, String(origin));
        const ended = yield* settled(
          statusOf(root, id),
          ({ execution }) => execution.status === "interrupted",
        );
        assert.strictEqual(ended.execution.status, "interrupted");
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("rejects a foreign Host before any handler runs and accepts the daemon's own", () =>
    Effect.gen(function* () {
      const root = yield* running([`${repo}/examples/demo/src/index.ts`]);
      const { port } = yield* daemonFile(root);
      const client = yield* HttpClient.HttpClient;
      const withHost = (request: HttpClientRequest.HttpClientRequest, host: string) =>
        client.execute(request.pipe(HttpClientRequest.setHeader("host", host)));

      for (const host of [
        `attacker.example:${port}`,
        "attacker.example",
        `127.0.0.1:${port + 1}`,
      ]) {
        const listed = yield* withHost(HttpClientRequest.get(`${url(port)}/api/executions`), host);
        assert.strictEqual(listed.status, 403, host);
      }
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
        const listed = yield* withHost(HttpClientRequest.get(`${url(port)}/api/executions`), host);
        assert.strictEqual(listed.status, 200, host);
      }

      const { id } = yield* refund(root, "ord_00014");
      const interrupted = yield* withHost(
        HttpClientRequest.post(`${url(port)}/api/executions/${id}/interrupt`),
        `attacker.example:${port}`,
      );
      assert.strictEqual(interrupted.status, 403);
      assert.strictEqual(
        (yield* statusOf(root, id)).execution.status,
        "suspended (deferred ManagerApproval)",
      );
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("resume runs a failure-suspended execution again", () =>
    Effect.gen(function* () {
      const root = yield* running([`${fixtures}/statuses.ts`]);
      const { id } = executedIn(
        (yield* kymo(root, "execute", "FailOnce", '{"id":"r"}')).output,
      ).execution;
      const failed = yield* settled(statusOf(root, id), ({ execution }) =>
        execution.status.startsWith("suspended (failed"),
      );
      assert.isTrue(
        failed.help.some((line) => line.includes(`kymo --root ${root.root} resume ${id}\``)),
        failed.help.join("\n"),
      );

      const resumed = yield* kymo(root, "resume", id);
      assert.strictEqual(resumed.code, 0, resumed.stdout);
      const done = yield* settled(
        statusOf(root, id),
        ({ execution }) => execution.status === "succeeded",
      );
      assert.strictEqual(done.execution.status, "succeeded");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

describe.concurrent("version handshake", () => {
  const project = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${dir}/node_modules`);
    yield* fs.copyFile(`${fixtures}/double.ts`, `${dir}/kymo.ts`);
    return { dir, root: yield* tempRoot([`${dir}/kymo.ts`]) };
  });

  it.live(
    "starts a source whose project installs the daemon's kymo, and refuses a different kymo",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { dir, root } = yield* project;
        const kymoCopy = `${dir}/node_modules/kymo`;
        yield* fs.makeDirectory(`${kymoCopy}/plugins/gh-cli`, { recursive: true });
        yield* fs.copyFile(`${repo}/package.json`, `${kymoCopy}/package.json`);
        yield* fs.copy(`${repo}/src`, `${kymoCopy}/src`);
        yield* fs.copy(`${repo}/plugins/gh-cli/src`, `${kymoCopy}/plugins/gh-cli/src`);
        yield* fs.symlink(
          Bun.resolveSync("effect/package.json", repo).slice(0, -"/package.json".length),
          `${dir}/node_modules/effect`,
        );

        const same = yield* kymo(root, "start");
        assert.strictEqual(same.code, 0, same.stdout);
        assert.strictEqual((yield* kymo(root, "stop")).code, 0);

        yield* fs.writeFileString(`${kymoCopy}/src/workflows.ts`, "export const drift = 1;\n", {
          flag: "a",
        });
        const drifted = yield* kymo(root, "start");
        assert.strictEqual(drifted.code, 1, drifted.stdout);
        assert.match(
          drifted.stdout,
          /resolves kymo at \S*node_modules\/kymo \(content \w{12}\), but the daemon runs kymo at /,
        );
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("refuses a source whose project installs another effect version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, root } = yield* project;
      yield* fs.makeDirectory(`${dir}/node_modules/effect`);
      yield* fs.writeFileString(
        `${dir}/node_modules/effect/package.json`,
        '{ "name": "effect", "version": "4.0.0" }\n',
      );
      const result = yield* kymo(root, "start");
      assert.strictEqual(result.code, 1, result.stdout);
      assert.match(
        result.stdout,
        /resolves effect 4\.0\.0 at \S*node_modules\/effect, but the daemon runs effect 4\.1\.2 at /,
      );
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
