import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const layer = SqliteMigrator.layer({
  table: "kymo_migrations",
  loader: SqliteMigrator.fromRecord({
    "0001_labels": Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`
        CREATE TABLE kymo_labels (
          execution_id TEXT PRIMARY KEY,
          label TEXT NOT NULL
        )
      `,
    ),
  }),
});
