#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { encode } from "@toon-format/toon";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Runtime from "effect/Runtime";
import { url } from "kymo/api";
import * as Root from "kymo/root";
import {
  type Command,
  type Invocation,
  NotRunning,
  type Output,
  type Run,
  UsageError,
} from "./command.ts";
import { derive, type Running } from "./daemon-state.ts";
import { execution, executions } from "./executions.ts";
import { start, type Started, stop } from "./lifecycle.ts";

const description = "kymo runs durable Effect workflows in a local daemon";

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
        `Run \`${kymo("executions")}\` to list executions`,
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
  executions,
  execution,
};

const run = (command: Command, invocation: Invocation): Run =>
  command._tag === "Lifecycle"
    ? command.run(invocation)
    : Effect.flatMap(derive(invocation.root), (state) =>
        state._tag === "Running" ? command.run(state, invocation) : new NotRunning(),
      );

const usage = (name: string | undefined, command: Command): Output => {
  if (name === undefined) {
    return {
      body: {
        usage: "kymo [<command>] [--root <dir>]",
        description,
        commands: Object.entries(commands).map(([name, { summary }]) => ({ name, summary })),
      },
      help: ["Run `kymo <command> --help` for one command"],
    };
  }
  const positionals = command.positionals ?? [];
  const flags = command.flags ?? [];
  return {
    body: {
      usage: [
        `kymo ${name}`,
        ...positionals.map((positional) => `<${positional.name}>`),
        ...flags.map(
          (flag) => `[--${flag.name}${flag.value === undefined ? "" : ` ${flag.value}`}]`,
        ),
        "[--root <dir>]",
      ].join(" "),
      summary: command.summary,
      ...(positionals.length > 0 ? { arguments: positionals } : {}),
      ...(flags.length > 0
        ? { flags: flags.map(({ name, summary }) => ({ name: `--${name}`, summary })) }
        : {}),
    },
    help: [],
  };
};

const parse = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let name: string | undefined;
    let command: Command | undefined;
    let root: string | undefined;
    let help = false;
    const positionals: Array<string> = [];
    const flags: Record<string, string | true> = {};
    for (let index = 0; index < args.length; index++) {
      const arg = args[index] ?? "";
      if (arg === "--help" || arg === "-h") {
        help = true;
      } else if (arg.startsWith("--")) {
        const equals = arg.indexOf("=");
        const flagName = arg.slice(2, equals === -1 ? undefined : equals);
        const inline = equals === -1 ? undefined : arg.slice(equals + 1);
        if (flagName === "root") {
          root = inline ?? args[++index];
          if (root === undefined || (inline === undefined && root.startsWith("-"))) {
            return yield* new UsageError({ reason: "--root needs a directory" });
          }
          continue;
        }
        const flag = (command ?? home).flags?.find((candidate) => candidate.name === flagName);
        if (flag === undefined) {
          return yield* new UsageError({ reason: `unknown flag --${flagName}` });
        }
        if (flag.value === undefined) {
          if (inline !== undefined) {
            return yield* new UsageError({ reason: `--${flagName} takes no value` });
          }
          flags[flagName] = true;
        } else {
          const value = inline ?? args[++index];
          if (value === undefined || (inline === undefined && value.startsWith("-"))) {
            return yield* new UsageError({ reason: `--${flagName} needs ${flag.value}` });
          }
          flags[flagName] = value;
        }
      } else if (arg.startsWith("-")) {
        return yield* new UsageError({ reason: `unknown flag ${arg}` });
      } else if (command === undefined) {
        name = arg;
        command = Object.hasOwn(commands, arg) ? commands[arg] : undefined;
        if (command === undefined) {
          return yield* new UsageError({ reason: `unknown command ${arg}` });
        }
      } else {
        positionals.push(arg);
      }
    }
    const resolved = command ?? home;
    const declared = resolved.positionals ?? [];
    if (!help && positionals.length > declared.length) {
      return yield* new UsageError({
        reason: `unexpected argument ${positionals[declared.length]}`,
      });
    }
    const missing = declared[positionals.length];
    if (!help && missing !== undefined) {
      return yield* new UsageError({ reason: `kymo ${name} needs <${missing.name}>` });
    }
    const input: Record<string, string | true> = { ...flags };
    for (const [index, positional] of declared.entries()) {
      const value = positionals[index];
      if (value !== undefined) {
        input[positional.name] = value;
      }
    }
    return { name, command: resolved, root, help, input };
  });

const failure = (body: Record<string, unknown>, help: ReadonlyArray<string>, code: 1 | 2) =>
  Effect.succeed({ output: { body, help }, code });

Effect.gen(function* () {
  const { name, command, root: rootFlag, help, input } = yield* parse(process.argv.slice(2));
  if (help) {
    return { output: usage(name, command), code: 0 };
  }
  const path = yield* Path.Path;
  const root = Root.make(path.resolve(rootFlag ?? (yield* Root.defaultRoot)));
  const invocation: Invocation = {
    root,
    input,
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
      ExecutionNotFound: (error) =>
        failure(
          { error: error.message },
          [`Run \`${invocation.kymo("executions")}\` to list executions`],
          1,
        ),
      AmbiguousExecutionId: (error) =>
        failure(
          { error: error.message, candidates: error.candidates },
          [`Run \`${invocation.kymo("execution <id>")}\` with a longer prefix`],
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
