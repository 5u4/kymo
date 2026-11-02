import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Activity from "effect/workflow/Activity";
import * as DurableClock from "effect/workflow/DurableClock";
import * as Workflow from "effect/workflow/Workflow";

const isCalendarDate = Schema.makeFilter<string>(
  (date) =>
    Option.exists(
      DateTime.make(`${date}T00:00:00Z`),
      (dateTime) => DateTime.formatIsoDateUtc(dateTime) === date,
    ),
  { expected: "a calendar date" },
);

export const NightlyExport = Workflow.make("NightlyExport", {
  payload: {
    date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/), isCalendarDate),
    format: Schema.Literals(["csv", "parquet"]),
  },
  success: Schema.Struct({ objectKey: Schema.String, rows: Schema.Int }),
  idempotencyKey: ({ date, format }) => `${date}:${format}`,
});

const quietHoursAfter = (date: string) =>
  DateTime.add(DateTime.makeUnsafe(`${date}T02:00:00Z`), { days: 1 });

export const layer = NightlyExport.toLayer(
  Effect.fnUntraced(function* ({ date, format }) {
    const now = yield* Clock.currentTimeMillis;
    const wakeAt = DateTime.toEpochMillis(quietHoursAfter(date));
    yield* DurableClock.sleep({
      name: "WaitForQuietHours",
      duration: Duration.millis(Math.max(0, wakeAt - now)),
    });
    const { rows } = yield* Activity.make({
      name: "QueryLedger",
      success: Schema.Struct({ rows: Schema.Int }),
      execute: Effect.sleep("2 seconds").pipe(Effect.as({ rows: 184212 })),
    });
    const path = `/tmp/ledger-${date}.${format}`;
    yield* Activity.make({
      name: "WriteFile",
      success: Schema.Struct({ path: Schema.String, bytes: Schema.Int }),
      execute: Effect.sleep("1 second").pipe(Effect.as({ path, bytes: rows * 227 })),
    });
    return yield* Activity.make({
      name: "UploadToBucket",
      success: Schema.Struct({ objectKey: Schema.String, rows: Schema.Int }),
      execute: Effect.sleep("1 second").pipe(
        Effect.as({ objectKey: `exports/${date.replaceAll("-", "/")}/ledger.${format}`, rows }),
      ),
    });
  }),
);
