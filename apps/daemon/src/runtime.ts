import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/cluster/SingleRunner";
import * as Layer from "effect/Layer";
import { Awaits } from "./awaits.ts";
import { Executions, resumeWaiting } from "./executions.ts";
import * as Migrations from "./migrations.ts";
import * as WorkflowLogs from "./workflow-logs.ts";
import * as WorkflowSources from "./workflow-sources.ts";

export const layer = (options: {
  readonly root: string;
  readonly workflows: ReadonlyArray<string>;
  readonly db: string;
}) =>
  Layer.mergeAll(Executions.layer, resumeWaiting).pipe(
    Layer.provideMerge(
      WorkflowSources.layer({ root: options.root, workflows: options.workflows }).pipe(
        Layer.provideMerge(Awaits.layer),
        Layer.provide(WorkflowLogs.attribution),
        Layer.provide(ClusterWorkflowEngine.layer),
        Layer.provide(SingleRunner.layer({ runnerStorage: "memory" })),
        Layer.provide(WorkflowLogs.logger),
        Layer.provideMerge(
          Migrations.layer(options.db).pipe(
            Layer.provideMerge(SqliteClient.layer({ filename: options.db })),
          ),
        ),
        Layer.provide(BunCrypto.layerDigest),
      ),
    ),
  );
