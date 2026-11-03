import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type { AmbiguousExecutionId, ExecutionNotFound } from "kymo/api";
import type * as Root from "kymo/root";
import type { Running } from "./daemon-state.ts";
import type { DaemonExited, DaemonSilent } from "./lifecycle.ts";

export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}

export class NotRunning extends Schema.TaggedError<NotRunning>()("NotRunning", {}) {
  override get message() {
    return "the kymo daemon is not running";
  }
}

export interface Invocation {
  readonly root: Root.KymoRoot;
  readonly kymo: (command: string) => string;
  readonly input: Readonly<Record<string, string | true>>;
}

export interface Output {
  readonly body: Record<string, unknown>;
  readonly help: ReadonlyArray<string>;
}

export type Run = Effect.Effect<
  Output,
  | UsageError
  | NotRunning
  | DaemonExited
  | DaemonSilent
  | ExecutionNotFound
  | AmbiguousExecutionId
  | PlatformError.PlatformError
  | HttpClientError.HttpClientError
  | Schema.SchemaError,
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
>;

export interface Argument {
  readonly name: string;
  readonly summary: string;
}

export interface Flag extends Argument {
  readonly value?: string;
}

interface Spec {
  readonly summary: string;
  readonly positionals?: ReadonlyArray<Argument>;
  readonly flags?: ReadonlyArray<Flag>;
}

export type Command =
  | (Spec & {
      readonly _tag: "Lifecycle";
      readonly run: (invocation: Invocation) => Run;
    })
  | (Spec & {
      readonly _tag: "Daemon";
      readonly run: (daemon: Running, invocation: Invocation) => Run;
    });
