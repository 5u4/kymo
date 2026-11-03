#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { encode } from "@toon-format/toon";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { url } from "kymo/api";
import * as Root from "kymo/root";
import { derive, type Running } from "./daemon-state.ts";
import { type DaemonExited, type DaemonSilent, start, type Started, stop } from "./lifecycle.ts";

const description = "kymo runs durable Effect workflows in a local daemon";

class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}

class NotRunning extends Schema.TaggedError<NotRunning>()("NotRunning", {}) {
  override get message() {
    return "the kymo daemon is not running";
  }
}

interface Invocation {
  readonly root: Root.KymoRoot;
  readonly kymo: (command: string) => string;
}

interface Output {
  readonly body: Record<string, unknown>;
  readonly help: ReadonlyArray<string>;
}

type Run = Effect.Effect<
  Output,
  NotRunning | DaemonExited | DaemonSilent | PlatformError.PlatformError,
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
>;

type Command =
  | {
      readonly _tag: "Lifecycle";
      readonly summary: string;
      readonly run: (invocation: Invocation) => Run;
    }
  | {
      readonly _tag: "Daemon";
      readonly summary: string;
      readonly run: (daemon: Running, invocation: Invocation) => Run;
    };

const daemonView = (daemon: Running, root: Root.KymoRoot, status: string) => ({
  daemon: { status, pid: daemon.pid, url: url(daemon.port), root: root.root },
});

const startOutput = ({ daemon, started }: Started, { root, kymo }: Invocation): Output => ({
  body: daemonView(daemon, root, started ? "started" : "running"),
  help: [`Run \`${kymo("")}\` to see the daemon`, `Run \`${kymo("stop")}\` to stop it`],
});

const home: Command = {
  _tag: "Daemon",
  summary: "Show the running daemon",
  run: (daemon, { root, kymo }) =>
    Effect.succeed({
      body: {
        bin: (process.argv[1] ?? "kymo").replace(
          new RegExp(`^${RegExp.escape(process.env["HOME"] ?? "\0")}/`),
          "~/",
        ),
        description,
        ...daemonView(daemon, root, "running"),
      },
      help: [
        `Run \`${kymo("stop")}\` to stop the daemon`,
        `Run \`${kymo("restart")}\` to reload kymo.json`,
      ],
    }),
};

const commands: Record<string, Command> = {
  start: {
    _tag: "Lifecycle",
    summary: "Start the daemon for the root unless it is running",
    run: (invocation) =>
      Effect.map(start(invocation.root), (started) => startOutput(started, invocation)),
  },
  stop: {
    _tag: "Lifecycle",
    summary: "Stop the daemon for the root",
    run: ({ root, kymo }) =>
      Effect.map(stop(root), (stopped) => ({
        body: {
          daemon: Option.match(stopped, {
            onNone: () => ({ status: "not running", root: root.root }),
            onSome: ({ pid }) => ({ status: "stopped", pid, root: root.root }),
          }),
        },
        help: [`Run \`${kymo("start")}\` to start it`],
      })),
  },
  restart: {
    _tag: "Lifecycle",
    summary: "Stop the daemon, then start it",
    run: (invocation) =>
      stop(invocation.root).pipe(
        Effect.andThen(start(invocation.root)),
        Effect.map((started) => startOutput(started, invocation)),
      ),
  },
};

const run = (command: Command, invocation: Invocation): Run =>
  command._tag === "Lifecycle"
    ? command.run(invocation)
    : Effect.flatMap(derive(invocation.root), (state) =>
        state._tag === "Running" ? command.run(state, invocation) : new NotRunning(),
      );

const usage = (name: string | undefined, command: Command): Output =>
  name === undefined
    ? {
        body: {
          usage: "kymo [<command>] [--root <dir>]",
          description,
          commands: Object.entries(commands).map(([name, { summary }]) => ({ name, summary })),
        },
        help: ["Run `kymo <command> --help` for one command"],
      }
    : { body: { usage: `kymo ${name} [--root <dir>]`, summary: command.summary }, help: [] };

const parse = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let name: string | undefined;
    let root: string | undefined;
    let help = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index] ?? "";
      if (arg === "--help" || arg === "-h") {
        help = true;
      } else if (arg === "--root") {
        root = args[++index];
        if (root === undefined) {
          return yield* new UsageError({ reason: "--root needs a directory" });
        }
      } else if (arg.startsWith("--root=")) {
        root = arg.slice("--root=".length);
      } else if (arg.startsWith("-")) {
        return yield* new UsageError({ reason: `unknown flag ${arg}` });
      } else if (name === undefined) {
        name = arg;
      } else {
        return yield* new UsageError({ reason: `unexpected argument ${arg}` });
      }
    }
    const command =
      name === undefined ? home : Object.hasOwn(commands, name) ? commands[name] : undefined;
    if (command === undefined) {
      return yield* new UsageError({ reason: `unknown command ${name}` });
    }
    return { name, command, root, help };
  });

const failure = (body: Record<string, unknown>, help: ReadonlyArray<string>, code: 1 | 2) =>
  Effect.succeed({ output: { body, help }, code });

Effect.gen(function* () {
  const { name, command, root: rootFlag, help } = yield* parse(process.argv.slice(2));
  if (help) {
    return { output: usage(name, command), code: 0 };
  }
  const path = yield* Path.Path;
  const root = Root.make(path.resolve(rootFlag ?? (yield* Root.defaultRoot)));
  const invocation: Invocation = {
    root,
    kymo: (command) =>
      ["kymo", command, rootFlag === undefined ? "" : `--root ${root.root}`]
        .filter((part) => part.length > 0)
        .join(" "),
  };
  return yield* run(command, invocation).pipe(
    Effect.map((output) => ({ output, code: 0 })),
    Effect.catchTags({
      NotRunning: (error) =>
        failure(
          { error: error.message, root: root.root },
          [`Run \`${invocation.kymo("start")}\` to start it`],
          1,
        ),
      DaemonExited: (error) =>
        failure(
          { error: error.message, log: error.log },
          [
            `Fix the error in the log, then run \`${invocation.kymo("start")}\``,
            `Read the whole log at ${root.log}`,
          ],
          1,
        ),
      DaemonSilent: (error) =>
        failure(
          { error: error.message, log: error.log },
          [`Run \`${invocation.kymo("stop")}\` to stop it`, `Read the whole log at ${root.log}`],
          1,
        ),
    }),
  );
}).pipe(
  Effect.catchTags({
    UsageError: (error) => failure({ error: error.message }, ["Run `kymo --help`"], 2),
  }),
  Effect.catch((error) => failure({ error: error.message }, [], 1)),
  Effect.flatMap(({ output, code }) =>
    Effect.as(Console.log(encode({ ...output.body, help: output.help })), code),
  ),
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain({
    teardown: (exit, onExit) =>
      Exit.isSuccess(exit) && Predicate.isNumber(exit.value)
        ? onExit(exit.value)
        : Runtime.defaultTeardown(exit, onExit),
  }),
);
