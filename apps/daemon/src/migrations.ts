import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class SchemaOutdated extends Schema.TaggedError<SchemaOutdated>()("SchemaOutdated", {
  db: Schema.String,
}) {
  override get message() {
    return `${this.db} does not match this kymo's schema; delete it with its -wal and -shm files and run kymo start again`;
  }
}

const migrate = SqliteMigrator.run({
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

const Definitions = Schema.Array(
  Schema.Struct({ type: Schema.String, name: Schema.String, sql: Schema.NullOr(Schema.String) }),
);

const kymoSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT type, name, sql FROM sqlite_master WHERE substr(name, 1, 5) = 'kymo_' ORDER BY name
  `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Definitions)), Effect.orDie);
  return rows
    .map(({ type, name, sql }) => `${type} ${name} ${(sql ?? "").replace(/\s+/g, " ")}`)
    .join("\n");
});

export const layer = (db: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* migrate;
      const actual = yield* kymoSchema;
      const expected = yield* migrate.pipe(
        Effect.andThen(kymoSchema),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      );
      if (actual !== expected) {
        return yield* new SchemaOutdated({ db });
      }
    }),
  );
