import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type ActivityStatus,
  Api,
  type ExecutionStatus,
  type ExecutionSummary,
  StatusName,
  statusName,
  url,
} from "kymo/api";
import { type Command, UsageError } from "./command.ts";
import type { Running } from "./daemon-state.ts";

const defaultLimit = 20;
const textLimit = 120;
const activityLimit = 10;

const ExtraField = Schema.Literals(["started", "updated", "parent"]);
type ExtraField = typeof ExtraField.Type;

const extraFields: Record<ExtraField, (execution: ExecutionSummary) => string | null> = {
  started: (execution) => DateTime.formatIso(execution.startedAt),
  updated: (execution) => Option.getOrNull(Option.map(execution.updatedAt, DateTime.formatIso)),
  parent: (execution) => Option.getOrNull(execution.parentId),
};

const ListInput = Schema.Struct({
  status: Schema.optional(StatusName),
  workflow: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
  fields: Schema.optional(Schema.String),
});

const DetailInput = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  full: Schema.optional(Schema.Literal(true)),
});

const decodeInput =
  <S extends Schema.Decoder<unknown>>(schema: S, name?: string) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((error) => {
        const message = error.message.replace(/\n\s*/g, " ");
        const [, problem = message, key = name] =
          /^(.*?) at \[(?:"(\w+)"|\d+)\]$/.exec(message) ?? [];
        return new UsageError({ reason: `invalid ${key ?? "input"}: ${problem}` });
      }),
    );

const client = (daemon: Running) => HttpApiClient.make(Api, { baseUrl: url(daemon.port) });

const truncate = (text: string, full: boolean) =>
  full || text.length <= textLimit ? text : `${text.slice(0, textLimit - 1)}…`;

const statusText = (status: ExecutionStatus | ActivityStatus): string => {
  if (status._tag === "Failed") {
    return `failed (${status.kind}: ${status.message})`;
  }
  if (status._tag !== "Suspended" || !("reason" in status)) {
    return statusName(status);
  }
  const reason = status.reason;
  switch (reason._tag) {
    case "Failure":
      return `suspended (failed: ${reason.cause})`;
    case "Clock":
      return `suspended (clock ${reason.name} until ${DateTime.formatIso(reason.wakeAt)})`;
    case "Child":
      return `suspended (child ${reason.executionId})`;
    case "Deferred":
      return Option.match(reason.name, {
        onNone: () => "suspended (deferred)",
        onSome: (name) => `suspended (deferred ${name})`,
      });
  }
};

export const executions: Command = {
  _tag: "Daemon",
  summary: "List executions, newest first",
  flags: [
    {
      name: "status",
      value: "<status>",
      summary: `Only this status: ${StatusName.literals.join(", ")}`,
    },
    { name: "workflow", value: "<name>", summary: "Only this workflow" },
    { name: "limit", value: "<n>", summary: `Show at most n executions (default ${defaultLimit})` },
    {
      name: "fields",
      value: "<list>",
      summary: `Add comma-separated columns: ${ExtraField.literals.join(", ")}`,
    },
  ],
  run: (daemon, { input, kymo }) =>
    Effect.gen(function* () {
      const {
        fields: fieldList,
        limit = defaultLimit,
        ...filters
      } = yield* decodeInput(ListInput)(input);
      const fields =
        fieldList === undefined
          ? []
          : yield* decodeInput(Schema.Array(ExtraField), "fields")(fieldList.split(","));
      const { executions, total } = yield* Effect.flatMap(client(daemon), (api) =>
        api.executions.list({ query: { ...filters, limit } }),
      );
      const filtered = filters.status !== undefined || filters.workflow !== undefined;
      if (total === 0) {
        return {
          body: { executions: [], total },
          help: [
            filtered
              ? `No executions match; run \`${kymo("executions")}\` to list every execution`
              : "No executions yet; they appear once a workflow starts",
          ],
        };
      }
      return {
        body: {
          executions: executions.map((execution) => ({
            id: execution.id,
            workflow: execution.workflow,
            label: Option.getOrNull(execution.label),
            status: truncate(statusText(execution.status), false),
            ...Object.fromEntries(fields.map((field) => [field, extraFields[field](execution)])),
          })),
          shown: executions.length,
          total,
        },
        help: [
          `Run \`${kymo("execution <id>")}\` to see one execution; a unique id prefix works`,
          ...(executions.length < total
            ? [`Run \`${kymo(`executions --limit ${total}`)}\` to see all ${total}`]
            : []),
          ...(fields.length === 0
            ? [`Add \`--fields ${ExtraField.literals.join(",")}\` for more columns`]
            : []),
        ],
      };
    }),
};

export const execution: Command = {
  _tag: "Daemon",
  summary: "Show one execution by id or unique id prefix",
  positionals: [{ name: "id", summary: "Execution id or a unique prefix of it" }],
  flags: [{ name: "full", summary: `Show every activity and untruncated text` }],
  run: (daemon, { input, kymo }) =>
    Effect.gen(function* () {
      const { id, full = false } = yield* decodeInput(DetailInput)(input);
      const detail = yield* Effect.flatMap(client(daemon), (api) =>
        api.executions.get({ params: { id } }),
      );
      const activities = full ? detail.activities : detail.activities.slice(-activityLimit);
      const parent = Option.getOrNull(detail.parentId);
      return {
        body: {
          execution: {
            id: detail.id,
            workflow: detail.workflow,
            label: Option.getOrNull(detail.label),
            status: truncate(statusText(detail.status), full),
            started: DateTime.formatIso(detail.startedAt),
            updated: Option.getOrNull(Option.map(detail.updatedAt, DateTime.formatIso)),
            parent,
            payload: detail.payload,
          },
          activities: activities.map((activity) => ({
            name: activity.name,
            attempt: activity.attempt,
            status: truncate(statusText(activity.status), full),
            started: DateTime.formatIso(activity.startedAt),
            ended: Option.getOrNull(Option.map(activity.endedAt, DateTime.formatIso)),
          })),
          ...(activities.length < detail.activities.length
            ? { activitiesShown: `${activities.length} of ${detail.activities.length}` }
            : {}),
          children: detail.children,
          waits: detail.waits.map((wait) => ({
            kind: wait.kind,
            name: wait.name,
            since: DateTime.formatIso(wait.since),
          })),
        },
        help: [
          ...(activities.length < detail.activities.length
            ? [
                `Run \`${kymo(`execution ${detail.id} --full`)}\` to see all ${detail.activities.length} activities`,
              ]
            : []),
          ...(parent === null ? [] : [`Run \`${kymo(`execution ${parent}`)}\` to see its parent`]),
          ...(detail.children.length > 0
            ? [`Run \`${kymo("execution <child id>")}\` to see a child`]
            : []),
          `Run \`${kymo("executions")}\` to list executions`,
        ],
      };
    }),
};
