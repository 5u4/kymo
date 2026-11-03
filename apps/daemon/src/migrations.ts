import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const layer = SqliteMigrator.layer({
  table: "kymo_migrations",
  loader: SqliteMigrator.fromRecord({
    "0001_kymo": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE kymo_labels (
          execution_id TEXT PRIMARY KEY,
          label TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE kymo_logs (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          execution_id TEXT NOT NULL,
          pass INTEGER NOT NULL,
          at INTEGER NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          cause TEXT,
          activity TEXT,
          attempt INTEGER
        )
      `;
      yield* sql`CREATE INDEX kymo_logs_execution ON kymo_logs (execution_id, seq)`;
    }),
  }),
});
