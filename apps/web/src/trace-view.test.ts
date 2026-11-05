import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type {
  ActivityRun,
  ActivityStatus,
  ExecutionDetail,
  ExecutionStatus,
  ExecutionSummary,
  Wait,
} from "kymo/api";
import {
  axis,
  defaultExpanded,
  findSpan,
  fitZoom,
  initialSpan,
  moveSpan,
  spanStatus,
  stopNote,
  traceOf,
  viewAt,
  visibleRows,
  zoomLimit,
  type Span,
} from "./trace-view.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const ms = (iso: string) => DateTime.toEpochMillis(at(iso));

const succeeded: ActivityStatus = { _tag: "Succeeded" };
const failed: ActivityStatus = { _tag: "Failed", kind: "Fail", message: "declined" };
const running: ActivityStatus = { _tag: "Running" };

const run = (
  name: string,
  attempt: number,
  status: ActivityStatus,
  startedAt: string,
  endedAt?: string,
): ActivityRun => ({
  name,
  attempt,
  status,
  startedAt: at(startedAt),
  endedAt: Option.map(Option.fromUndefinedOr(endedAt), at),
});

const detail = (
  fields: {
    readonly status?: ExecutionStatus;
    readonly startedAt?: string;
    readonly updatedAt?: string;
    readonly activities?: ReadonlyArray<ActivityRun>;
    readonly children?: ReadonlyArray<string>;
    readonly waits?: ReadonlyArray<Wait>;
  } = {},
): ExecutionDetail => ({
  id: "e1",
  workflow: "ChargeInvoice",
  label: Option.none(),
  idempotencyKey: Option.some("inv_1"),
  status: fields.status ?? { _tag: "Succeeded" },
  startedAt: at(fields.startedAt ?? "2026-11-03T10:00:00Z"),
  updatedAt: Option.map(Option.fromUndefinedOr(fields.updatedAt), at),
  parentId: Option.none(),
  payload: { invoiceId: "inv_1" },
  activities: fields.activities ?? [],
  children: fields.children ?? [],
  waits: fields.waits ?? [],
});

const summary = (
  id: string,
  status: ExecutionStatus,
  startedAt: string,
  updatedAt?: string,
): ExecutionSummary => ({
  id,
  workflow: "ChargeInvoice",
  label: Option.none(),
  idempotencyKey: Option.none(),
  status,
  startedAt: at(startedAt),
  updatedAt: Option.map(Option.fromUndefinedOr(updatedAt), at),
  parentId: Option.some("e1"),
});

const none = new Map<string, ExecutionSummary>();

const keys = (spans: ReadonlyArray<Span>) => spans.map((span) => span.key);

const child = (root: Span, key: string): Span => {
  const found = root.children.find((span) => span.key === key);
  if (found === undefined) throw new Error(`no span ${key}`);
  return found;
};

describe("traceOf", () => {
  it("groups attempts by activity name and nests Attempt spans only for retried activities", () => {
    const root = traceOf(
      detail({
        updatedAt: "2026-11-03T10:00:05Z",
        activities: [
          run("Capture", 1, failed, "2026-11-03T10:00:01Z", "2026-11-03T10:00:02Z"),
          run("Load", 1, succeeded, "2026-11-03T10:00:00.500Z", "2026-11-03T10:00:00.900Z"),
          run("Capture", 2, succeeded, "2026-11-03T10:00:03Z", "2026-11-03T10:00:04Z"),
        ],
      }),
      none,
    );
    assert.strictEqual(root._tag, "Execution");
    assert.strictEqual(root.key, "exec");
    assert.strictEqual(root.start, ms("2026-11-03T10:00:00Z"));
    assert.deepStrictEqual(root.end, Option.some(ms("2026-11-03T10:00:05Z")));
    assert.deepStrictEqual(keys(root.children), ["a/Load", "a/Capture"]);

    const capture = child(root, "a/Capture");
    assert.strictEqual(capture.start, ms("2026-11-03T10:00:01Z"));
    assert.deepStrictEqual(capture.end, Option.some(ms("2026-11-03T10:00:04Z")));
    assert.strictEqual(capture._tag === "Activity" && capture.status._tag, "Succeeded");
    assert.strictEqual(capture._tag === "Activity" && capture.attempts.length, 2);
    assert.deepStrictEqual(keys(capture.children), ["a/Capture/1", "a/Capture/2"]);
    const first = capture.children[0];
    assert.strictEqual(first?._tag, "Attempt");
    assert.deepStrictEqual(first?.end, Option.some(ms("2026-11-03T10:00:02Z")));

    assert.deepStrictEqual(child(root, "a/Load").children, []);
  });

  it("keeps an activity named like another's attempt apart from that attempt", () => {
    const root = traceOf(
      detail({
        activities: [
          run("Capture", 1, failed, "2026-11-03T10:00:01Z", "2026-11-03T10:00:02Z"),
          run("Capture", 2, succeeded, "2026-11-03T10:00:03Z", "2026-11-03T10:00:04Z"),
          run("Capture/1", 1, succeeded, "2026-11-03T10:00:05Z", "2026-11-03T10:00:06Z"),
        ],
      }),
      none,
    );
    const all = (span: Span): ReadonlyArray<string> => [span.key, ...span.children.flatMap(all)];
    const spanKeys = all(root);
    assert.strictEqual(new Set(spanKeys).size, spanKeys.length, spanKeys.join(" "));
    const named = root.children.find(
      (span) => span._tag === "Activity" && span.name === "Capture/1",
    );
    assert.isDefined(named);
    assert.strictEqual(Option.getOrUndefined(findSpan(root, named?.key ?? "")), named);
    assert.deepStrictEqual(keys(child(root, "a/Capture").children), ["a/Capture/1", "a/Capture/2"]);
  });

  it("leaves running executions, activities and attempts open", () => {
    const root = traceOf(
      detail({
        status: { _tag: "Running" },
        updatedAt: "2026-11-03T10:00:02Z",
        activities: [
          run("Capture", 1, failed, "2026-11-03T10:00:01Z", "2026-11-03T10:00:02Z"),
          run("Capture", 2, running, "2026-11-03T10:00:03Z"),
        ],
      }),
      none,
    );
    assert.isTrue(Option.isNone(root.end));
    const capture = child(root, "a/Capture");
    assert.strictEqual(capture.start, ms("2026-11-03T10:00:01Z"));
    assert.isTrue(Option.isNone(capture.end));
    assert.strictEqual(capture._tag === "Activity" && capture.status._tag, "Running");
    assert.isTrue(Option.isNone(capture.children[1]?.end ?? Option.some(0)));
  });

  it("keeps a suspended execution open", () => {
    const root = traceOf(
      detail({
        status: { _tag: "Suspended", reason: { _tag: "Deferred", name: Option.some("approval") } },
        updatedAt: "2026-11-03T10:00:02Z",
      }),
      none,
    );
    assert.isTrue(Option.isNone(root.end));
  });

  it("opens one Wait span per open wait and takes a clock's wakeAt from the suspend reason", () => {
    const root = traceOf(
      detail({
        status: {
          _tag: "Suspended",
          reason: { _tag: "Clock", name: "quiet", wakeAt: at("2026-11-03T12:00:00Z") },
        },
        waits: [
          {
            kind: "Deferred",
            name: "approval",
            since: at("2026-11-03T10:02:00Z"),
            expected: Option.none(),
          },
          {
            kind: "Clock",
            name: "quiet",
            since: at("2026-11-03T10:01:00Z"),
            expected: Option.none(),
          },
          {
            kind: "Clock",
            name: "other",
            since: at("2026-11-03T10:03:00Z"),
            expected: Option.none(),
          },
        ],
      }),
      none,
    );
    assert.deepStrictEqual(keys(root.children), [
      "w/Clock/quiet",
      "w/Deferred/approval",
      "w/Clock/other",
    ]);
    const wakeAt = (key: string) => {
      const span = child(root, key);
      return span._tag === "Wait" ? span.wakeAt : Option.none();
    };
    assert.deepStrictEqual(wakeAt("w/Clock/quiet"), Option.some(ms("2026-11-03T12:00:00Z")));
    assert.isTrue(Option.isNone(wakeAt("w/Deferred/approval")));
    assert.isTrue(Option.isNone(wakeAt("w/Clock/other")));
    assert.strictEqual(child(root, "w/Clock/quiet").start, ms("2026-11-03T10:01:00Z"));
    assert.isTrue(Option.isNone(child(root, "w/Clock/quiet").end));
  });

  it("reads child spans from the summaries and still shows a child missing from them", () => {
    const root = traceOf(
      detail({
        updatedAt: "2026-11-03T10:10:00Z",
        children: ["c1", "c2", "gone"],
      }),
      new Map([
        [
          "c1",
          summary("c1", { _tag: "Succeeded" }, "2026-11-03T10:02:00Z", "2026-11-03T10:03:00Z"),
        ],
        ["c2", summary("c2", { _tag: "Running" }, "2026-11-03T10:04:00Z", "2026-11-03T10:05:00Z")],
      ]),
    );
    assert.deepStrictEqual(keys(root.children), ["c/gone", "c/c1", "c/c2"]);
    const done = child(root, "c/c1");
    assert.strictEqual(done.start, ms("2026-11-03T10:02:00Z"));
    assert.deepStrictEqual(done.end, Option.some(ms("2026-11-03T10:03:00Z")));
    assert.isTrue(done._tag === "Child" && Option.isSome(done.summary));
    assert.isTrue(Option.isNone(child(root, "c/c2").end));
    const gone = child(root, "c/gone");
    assert.isTrue(gone._tag === "Child" && Option.isNone(gone.summary));
    assert.strictEqual(gone._tag === "Child" && gone.id, "gone");
  });
});

const retries = detail({
  status: { _tag: "Failed", kind: "Fail", message: "declined" },
  updatedAt: "2026-11-03T10:00:09Z",
  activities: [
    run("A", 1, failed, "2026-11-03T10:00:01Z", "2026-11-03T10:00:02Z"),
    run("A", 2, succeeded, "2026-11-03T10:00:02Z", "2026-11-03T10:00:03Z"),
    run("B", 1, failed, "2026-11-03T10:00:04Z", "2026-11-03T10:00:05Z"),
    run("B", 2, failed, "2026-11-03T10:00:05Z", "2026-11-03T10:00:06Z"),
    run("C", 1, failed, "2026-11-03T10:00:07Z", "2026-11-03T10:00:08Z"),
  ],
});

describe("spanStatus", () => {
  it("reads each attempt's own status apart from its activity's", () => {
    const root = traceOf(retries, none);
    const status = (key: string) => Option.flatMap(findSpan(root, key), spanStatus);
    assert.deepStrictEqual(status("exec"), Option.some("failed"));
    assert.deepStrictEqual(status("a/A"), Option.some("succeeded"));
    assert.deepStrictEqual(status("a/A/1"), Option.some("failed"));
  });

  it("reports a wait as suspended", () => {
    const root = traceOf(
      detail({
        status: { _tag: "Suspended", reason: { _tag: "Deferred", name: Option.some("approval") } },
        waits: [
          {
            kind: "Deferred",
            name: "approval",
            since: at("2026-11-03T10:01:00Z"),
            expected: Option.none(),
          },
        ],
      }),
      none,
    );
    assert.deepStrictEqual(
      spanStatus(child(root, "w/Deferred/approval")),
      Option.some("suspended"),
    );
  });

  it("has no status for a child missing from the journal", () => {
    const root = traceOf(detail({ children: ["c9"] }), none);
    assert.isTrue(Option.isNone(spanStatus(child(root, "c/c9"))));
  });
});

describe("defaultExpanded", () => {
  it("opens the root and every retried activity whose last attempt did not succeed", () => {
    assert.deepStrictEqual([...defaultExpanded(traceOf(retries, none))].toSorted(), [
      "a/B",
      "exec",
    ]);
  });
});

describe("visibleRows", () => {
  it("walks expanded spans depth first", () => {
    const root = traceOf(retries, none);
    assert.deepStrictEqual(
      visibleRows(root, defaultExpanded(root)).map((row) => [
        row.span.key,
        row.depth,
        row.hasChildren,
      ]),
      [
        ["exec", 0, true],
        ["a/A", 1, true],
        ["a/B", 1, true],
        ["a/B/1", 2, false],
        ["a/B/2", 2, false],
        ["a/C", 1, false],
      ],
    );
  });

  it("shows only the root when it is collapsed", () => {
    const root = traceOf(retries, none);
    assert.deepStrictEqual(
      visibleRows(root, new Set()).map((row) => row.span.key),
      ["exec"],
    );
  });
});

describe("initialSpan", () => {
  const waiting = detail({
    status: { _tag: "Suspended", reason: { _tag: "Deferred", name: Option.some("approval") } },
    activities: [run("Load", 1, failed, "2026-11-03T10:00:01Z", "2026-11-03T10:00:02Z")],
    waits: [
      {
        kind: "Deferred",
        name: "approval",
        since: at("2026-11-03T10:00:03Z"),
        expected: Option.none(),
      },
    ],
  });

  it("picks the open wait of a suspended execution before a failed activity", () => {
    const root = traceOf(waiting, none);
    assert.strictEqual(initialSpan(root, waiting.status), "w/Deferred/approval");
  });

  it("picks the last failed activity when nothing waits", () => {
    const root = traceOf(retries, none);
    assert.strictEqual(initialSpan(root, retries.status), "a/C");
  });

  it("picks a failed activity of an execution suspended on failure", () => {
    const suspended = detail({
      status: { _tag: "Suspended", reason: { _tag: "Failure", cause: "declined" } },
      activities: [
        run("Authorize", 1, failed, "2026-11-03T10:00:01Z", "2026-11-03T10:00:02Z"),
        run("Load", 1, succeeded, "2026-11-03T10:00:00Z", "2026-11-03T10:00:01Z"),
      ],
    });
    assert.strictEqual(initialSpan(traceOf(suspended, none), suspended.status), "a/Authorize");
  });

  it("picks the activity the engine suspended on, which the daemon reports as Suspended", () => {
    const suspended = detail({
      status: { _tag: "Suspended", reason: { _tag: "Failure", cause: "GatewayUnavailable" } },
      activities: [
        run("Authorize", 1, succeeded, "2026-11-03T10:00:01Z", "2026-11-03T10:00:02Z"),
        run("Capture", 1, { _tag: "Suspended" }, "2026-11-03T10:00:02Z", "2026-11-03T10:00:03Z"),
      ],
    });
    assert.strictEqual(initialSpan(traceOf(suspended, none), suspended.status), "a/Capture");
  });

  it("picks the root otherwise", () => {
    const root = traceOf(retries, none);
    assert.strictEqual(initialSpan(root, { _tag: "Succeeded" }), "exec");
    assert.strictEqual(
      initialSpan(traceOf(detail(), none), { _tag: "Failed", kind: "Die", message: "x" }),
      "exec",
    );
  });
});

describe("moveSpan", () => {
  const root = traceOf(retries, none);
  const expanded = defaultExpanded(root);
  const rows = visibleRows(root, expanded);
  const move = (current: string, key: string) =>
    Option.map(moveSpan(rows, expanded, current, key), (next) => ({
      key: next.key,
      expanded: [...next.expanded].toSorted(),
    }));
  const unchanged = [...expanded].toSorted();

  it("steps down and up through visible rows with arrows and j/k", () => {
    assert.deepStrictEqual(
      move("exec", "ArrowDown"),
      Option.some({ key: "a/A", expanded: unchanged }),
    );
    assert.deepStrictEqual(move("a/B", "j"), Option.some({ key: "a/B/1", expanded: unchanged }));
    assert.deepStrictEqual(move("a/B/1", "k"), Option.some({ key: "a/B", expanded: unchanged }));
    assert.deepStrictEqual(
      move("exec", "ArrowUp"),
      Option.some({ key: "exec", expanded: unchanged }),
    );
    assert.deepStrictEqual(
      move("a/C", "ArrowDown"),
      Option.some({ key: "a/C", expanded: unchanged }),
    );
  });

  it("jumps to the first and last rows with Home and End", () => {
    assert.deepStrictEqual(
      move("a/B/2", "Home"),
      Option.some({ key: "exec", expanded: unchanged }),
    );
    assert.deepStrictEqual(move("exec", "End"), Option.some({ key: "a/C", expanded: unchanged }));
  });

  it("expands a collapsed span with ArrowRight, then enters its first child", () => {
    assert.deepStrictEqual(
      move("a/A", "ArrowRight"),
      Option.some({ key: "a/A", expanded: ["a/A", "a/B", "exec"] }),
    );
    assert.deepStrictEqual(
      move("a/B", "ArrowRight"),
      Option.some({ key: "a/B/1", expanded: unchanged }),
    );
    assert.deepStrictEqual(
      move("a/C", "ArrowRight"),
      Option.some({ key: "a/C", expanded: unchanged }),
    );
  });

  it("collapses an expanded span with ArrowLeft, otherwise goes to its parent", () => {
    assert.deepStrictEqual(
      move("a/B", "ArrowLeft"),
      Option.some({ key: "a/B", expanded: ["exec"] }),
    );
    assert.deepStrictEqual(
      move("a/B/2", "ArrowLeft"),
      Option.some({ key: "a/B", expanded: unchanged }),
    );
    assert.deepStrictEqual(
      move("a/C", "ArrowLeft"),
      Option.some({ key: "exec", expanded: unchanged }),
    );
  });

  it("ignores other keys", () => {
    assert.isTrue(Option.isNone(moveSpan(rows, expanded, "exec", "x")));
  });
});

describe("axis", () => {
  const labels = (ticks: ReadonlyArray<{ readonly at: number; readonly label: string }>) =>
    ticks.map((tick) => tick.label);

  it("labels a sub-second trace in milliseconds", () => {
    const root = traceOf(detail({ updatedAt: "2026-11-03T10:00:01Z" }), none);
    const scale = axis(root, ms("2026-11-03T10:00:05Z"), 1);
    assert.strictEqual(scale.t0, ms("2026-11-03T10:00:00Z"));
    assert.strictEqual(scale.span, 1040);
    assert.deepStrictEqual(labels(scale.ticks), ["0", "200ms", "400ms", "600ms", "800ms", "1s"]);
    assert.strictEqual(scale.ticks[1]?.at, ms("2026-11-03T10:00:00.200Z"));
  });

  it("labels a trace of minutes in minutes, reaching a waiting clock's wakeAt", () => {
    const root = traceOf(
      detail({
        status: {
          _tag: "Suspended",
          reason: { _tag: "Clock", name: "quiet", wakeAt: at("2026-11-03T10:25:00Z") },
        },
        waits: [
          {
            kind: "Clock",
            name: "quiet",
            since: at("2026-11-03T10:01:00Z"),
            expected: Option.none(),
          },
        ],
      }),
      none,
    );
    const scale = axis(root, ms("2026-11-03T10:10:00Z"), 1);
    assert.strictEqual(scale.span, 1_560_000);
    assert.deepStrictEqual(labels(scale.ticks), ["0", "5m", "10m", "15m", "20m", "25m"]);
  });

  it("draws an open trace to now", () => {
    const root = traceOf(detail({ status: { _tag: "Running" } }), none);
    const scale = axis(root, ms("2026-11-03T10:25:00Z"), 1);
    assert.strictEqual(scale.span, 1_560_000);
  });

  it("ends a finished trace at its recorded end when a child is missing from the summaries", () => {
    const root = traceOf(detail({ updatedAt: "2026-11-03T10:00:01Z", children: ["gone"] }), none);
    assert.strictEqual(axis(root, ms("2026-11-03T10:00:05Z"), 1).span, 1040);
    assert.strictEqual(axis(root, ms("2026-11-04T10:00:00Z"), 1).span, 1040);
  });

  it("labels a trace of days in days and hours", () => {
    const root = traceOf(detail({ updatedAt: "2026-11-05T22:00:00Z" }), none);
    const scale = axis(root, ms("2026-11-06T00:00:00Z"), 1);
    assert.deepStrictEqual(labels(scale.ticks), ["0", "12h", "1d", "1d 12h", "2d", "2d 12h"]);
  });

  it("narrows the step when zoomed and keeps only ticks in the window", () => {
    const root = traceOf(detail({ updatedAt: "2026-11-03T10:00:01Z" }), none);
    const scale = axis(root, ms("2026-11-03T10:00:05Z"), 4, { from: 0.5, to: 0.75 });
    assert.deepStrictEqual(labels(scale.ticks), [
      "500ms",
      "550ms",
      "600ms",
      "650ms",
      "700ms",
      "750ms",
    ]);
  });
});

describe("fitZoom", () => {
  it("fits a waiting clock through its wakeAt into the middle 60% of the viewport", () => {
    const root = traceOf(
      detail({
        status: {
          _tag: "Suspended",
          reason: { _tag: "Clock", name: "quiet", wakeAt: at("2026-11-03T10:01:00Z") },
        },
        waits: [
          {
            kind: "Clock",
            name: "quiet",
            since: at("2026-11-03T10:00:01Z"),
            expected: Option.none(),
          },
        ],
      }),
      none,
    );
    const now = ms("2026-11-03T10:00:02Z");
    const scale = axis(root, now, 1);
    const wait = child(root, "w/Clock/quiet");
    const zoom = fitZoom(wait, scale, now);
    assert.closeTo(((ms("2026-11-03T10:01:00Z") - wait.start) / scale.span) * zoom, 0.6, 1e-9);
  });

  it("fits a finished activity from its start to its end", () => {
    const root = traceOf(
      detail({
        updatedAt: "2026-11-03T10:01:00Z",
        activities: [run("Charge", 1, succeeded, "2026-11-03T10:00:10Z", "2026-11-03T10:00:20Z")],
      }),
      none,
    );
    const now = ms("2026-11-03T10:05:00Z");
    const scale = axis(root, now, 1);
    const charge = child(root, "a/Charge");
    assert.closeTo((10_000 / scale.span) * fitZoom(charge, scale, now), 0.6, 1e-9);
  });
});

describe("viewAt", () => {
  it("renders from the page before the scrolled one through the page after it", () => {
    assert.deepStrictEqual(viewAt(10, 2500, 800, 8000), { zoom: 10, from: 0.2, to: 0.5 });
  });

  it("reads the scroll position the browser clamps to", () => {
    assert.deepStrictEqual(viewAt(10, -300, 800, 8000), { zoom: 10, from: -0.1, to: 0.2 });
    assert.deepStrictEqual(viewAt(10, 9000, 800, 8000), { zoom: 10, from: 0.8, to: 1.1 });
  });

  it("keeps a 1ms span fitted in a minute-long trace to a few pages of ticks", () => {
    const quick = "2026-11-03T10:00:20.000Z";
    const root = traceOf(
      detail({
        updatedAt: "2026-11-03T10:01:00Z",
        activities: [run("Quick", 1, succeeded, quick, "2026-11-03T10:00:20.001Z")],
      }),
      none,
    );
    const now = ms("2026-11-03T10:01:00Z");
    const visible = 800;
    const width = visible * zoomLimit;
    const { span } = axis(root, now, 1);
    const scrollLeft = ((ms(quick) - root.start) / span) * width - 0.2 * visible;
    const { ticks } = axis(root, now, zoomLimit, viewAt(zoomLimit, scrollLeft, visible, width));
    assert.isAtMost(ticks.length, 20);
    assert.isAtMost(ticks[0]?.at ?? Infinity, ms(quick));
    assert.isAtLeast(ticks.at(-1)?.at ?? -Infinity, ms(quick));
  });
});

describe("stopNote", () => {
  it("names the cause and the activity a SuspendOnFailure stopped at", () => {
    const authorize = run("AuthorizeCard", 1, { _tag: "Suspended" }, "2026-11-03T10:00:02Z");
    const note = stopNote(
      detail({
        status: {
          _tag: "Suspended",
          reason: { _tag: "Failure", cause: 'CardDeclined {"code":"insufficient_funds"}' },
        },
        activities: [
          run("Reserve", 1, succeeded, "2026-11-03T10:00:01Z", "2026-11-03T10:00:02Z"),
          authorize,
        ],
      }),
    );
    assert.deepStrictEqual(
      note,
      Option.some({
        _tag: "Failure",
        cause: 'CardDeclined {"code":"insufficient_funds"}',
        activity: Option.some(authorize),
      }),
    );
  });

  it("picks the last failed or suspended activity", () => {
    const second = run("Capture", 2, failed, "2026-11-03T10:00:03Z", "2026-11-03T10:00:04Z");
    const note = stopNote(
      detail({
        status: { _tag: "Suspended", reason: { _tag: "Failure", cause: "boom" } },
        activities: [
          run("Capture", 1, failed, "2026-11-03T10:00:01Z", "2026-11-03T10:00:02Z"),
          second,
          run("Notify", 1, succeeded, "2026-11-03T10:00:05Z", "2026-11-03T10:00:06Z"),
        ],
      }),
    );
    assert.deepStrictEqual(
      note,
      Option.some({ _tag: "Failure", cause: "boom", activity: Option.some(second) }),
    );
  });

  it("ignores an activity whose latest attempt succeeded", () => {
    const note = stopNote(
      detail({
        status: { _tag: "Suspended", reason: { _tag: "Failure", cause: "boom" } },
        activities: [
          run("Capture", 1, failed, "2026-11-03T10:00:01Z", "2026-11-03T10:00:02Z"),
          run("Capture", 2, succeeded, "2026-11-03T10:00:03Z", "2026-11-03T10:00:04Z"),
          run("Notify", 1, succeeded, "2026-11-03T10:00:05Z", "2026-11-03T10:00:06Z"),
        ],
      }),
    );
    assert.deepStrictEqual(
      note,
      Option.some({ _tag: "Failure", cause: "boom", activity: Option.none() }),
    );
  });

  it("has no activity when a failure stopped the body outside one", () => {
    assert.deepStrictEqual(
      stopNote(
        detail({ status: { _tag: "Suspended", reason: { _tag: "Failure", cause: "boom" } } }),
      ),
      Option.some({ _tag: "Failure", cause: "boom", activity: Option.none() }),
    );
  });

  it("names the deferred the execution is parked on", () => {
    assert.deepStrictEqual(
      stopNote(
        detail({
          status: {
            _tag: "Suspended",
            reason: { _tag: "Deferred", name: Option.some("ManagerApproval") },
          },
        }),
      ),
      Option.some({ _tag: "Deferred", name: Option.some("ManagerApproval") }),
    );
  });

  it("names the clock and when it wakes", () => {
    assert.deepStrictEqual(
      stopNote(
        detail({
          status: {
            _tag: "Suspended",
            reason: { _tag: "Clock", name: "Nightly", wakeAt: at("2026-11-04T02:00:00Z") },
          },
        }),
      ),
      Option.some({ _tag: "Clock", name: "Nightly", wakeAt: at("2026-11-04T02:00:00Z") }),
    );
  });

  it("names the child execution it waits on", () => {
    assert.deepStrictEqual(
      stopNote(
        detail({ status: { _tag: "Suspended", reason: { _tag: "Child", executionId: "c1" } } }),
      ),
      Option.some({ _tag: "Child", executionId: "c1" }),
    );
  });

  it("states a failure's kind and message", () => {
    assert.deepStrictEqual(
      stopNote(detail({ status: { _tag: "Failed", kind: "Die", message: "out of memory" } })),
      Option.some({ _tag: "Failed", kind: "Die", message: "out of memory" }),
    );
  });

  it("has nothing to say while running, after success or after an interrupt", () => {
    for (const status of [
      { _tag: "Running" },
      { _tag: "Succeeded" },
      { _tag: "Interrupted" },
    ] satisfies ReadonlyArray<ExecutionStatus>) {
      assert.deepStrictEqual(stopNote(detail({ status })), Option.none());
    }
  });
});
