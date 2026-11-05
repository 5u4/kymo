import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type {
  ActivityRun,
  ActivityStatus,
  ExecutionDetail,
  LogEntry,
  LogLevel,
  LogSource,
} from "kymo/api";
import { logMarks, logsView, type LevelFilter, type LogsView } from "./log-view.ts";
import { findSpan, traceOf, type Span } from "./trace-view.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-11-03T10:00:${time}Z`);

const succeeded: ActivityStatus = { _tag: "Succeeded" };
const failed: ActivityStatus = { _tag: "Failed", kind: "Fail", message: "declined" };

const run = (
  name: string,
  attempt: number,
  status: ActivityStatus,
  startedAt: string,
  endedAt: string,
): ActivityRun => ({
  name,
  attempt,
  status,
  startedAt: at(startedAt),
  endedAt: Option.some(at(endedAt)),
});

const detail: ExecutionDetail = {
  id: "e1",
  workflow: "ChargeInvoice",
  label: Option.none(),
  idempotencyKey: Option.some("inv_1"),
  status: { _tag: "Succeeded" },
  startedAt: at("00"),
  updatedAt: Option.some(at("30")),
  parentId: Option.none(),
  payload: {},
  activities: [
    run("Capture/1", 1, succeeded, "01", "02"),
    run("Capture", 1, succeeded, "03", "04"),
    run("Charge", 1, failed, "05", "06"),
    run("Charge", 2, succeeded, "07", "08"),
  ],
  children: ["child1"],
  waits: [{ kind: "Deferred", name: "Approval", since: at("09") }],
};

const root = traceOf(detail, new Map());

const body: LogSource = { _tag: "Body" };
const activity = (name: string, attempt = 1): LogSource => ({ _tag: "Activity", name, attempt });

const entry = (
  seq: number,
  level: LogLevel,
  source: LogSource,
  time: string,
  pass = 1,
): LogEntry => ({
  seq,
  pass,
  at: at(time),
  level,
  message: `line ${seq}`,
  cause: Option.none(),
  source,
});

const entries: ReadonlyArray<LogEntry> = [
  entry(1, "Info", body, "00.100"),
  entry(2, "Info", activity("Capture/1"), "01.200"),
  entry(3, "Warn", activity("Capture/1"), "01.300"),
  entry(4, "Info", activity("Capture"), "03.100"),
  entry(5, "Error", activity("Charge", 1), "05.500"),
  entry(6, "Info", activity("Charge", 2), "07.100"),
  entry(7, "Warn", activity("Charge", 2), "07.400"),
  entry(8, "Info", body, "08.100"),
];

const span = (key: string): Span =>
  Option.getOrThrowWith(findSpan(root, key), () => new Error(`no span ${key}`));

const view = (key: string, filter: LevelFilter = "all", from = entries): LogsView =>
  Option.getOrThrowWith(logsView(span(key), root, from, filter), () => new Error("no Logs tab"));

const seqs = (logs: LogsView) =>
  logs.groups.flatMap((group) => group.lines.map((line) => line.entry.seq));

describe("logsView", () => {
  it("shows every line, body and activities, on the execution span", () => {
    const logs = view("exec");
    assert.deepStrictEqual(seqs(logs), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.strictEqual(logs.count, 8);
  });

  it("scopes an activity by its name, not its encoded span key", () => {
    assert.deepStrictEqual(seqs(view("a/Capture%2F1")), [2, 3]);
    assert.deepStrictEqual(seqs(view("a/Capture")), [4]);
  });

  it("scopes an activity with several attempts to all of them and an attempt to its own", () => {
    assert.deepStrictEqual(seqs(view("a/Charge")), [5, 6, 7]);
    assert.deepStrictEqual(seqs(view("a/Charge/2")), [6, 7]);
    assert.deepStrictEqual(seqs(view("a/Charge/1")), [5]);
  });

  it("has no Logs tab on waits and children", () => {
    assert.isTrue(Option.isNone(logsView(span("w/Deferred/Approval"), root, entries, "all")));
    assert.isTrue(Option.isNone(logsView(span("c/child1"), root, entries, "all")));
  });

  it("filters by minimum level and counts each filter over the span's lines", () => {
    const warn = view("exec", "warn");
    assert.deepStrictEqual(seqs(warn), [3, 5, 7]);
    assert.deepStrictEqual(warn.counts, { all: 8, warn: 3, error: 1 });
    assert.deepStrictEqual(seqs(view("exec", "error")), [5]);
    assert.deepStrictEqual(view("a/Charge/2", "error").counts, { all: 2, warn: 1, error: 0 });
    assert.strictEqual(view("exec", "error").count, 8);
  });

  it("keeps Fatal under the error filter", () => {
    const logs = view("exec", "error", [
      entry(1, "Fatal", body, "00"),
      entry(2, "Warn", body, "01"),
    ]);
    assert.deepStrictEqual(seqs(logs), [1]);
  });

  it("flags an error only when the span has an Error or Fatal line", () => {
    assert.isTrue(view("exec").hasError);
    assert.isTrue(view("a/Charge").hasError);
    assert.isFalse(view("a/Charge/2").hasError);
    assert.isFalse(view("a/Capture%2F1").hasError);
    assert.isTrue(view("exec", "all", [entry(1, "Fatal", body, "00")]).hasError);
  });

  it("shows the pass only when the shown lines span more than one pass", () => {
    assert.isFalse(view("exec").showPass);
    const replayed = [
      entry(1, "Info", body, "00", 1),
      entry(2, "Warn", activity("Capture"), "03", 1),
      entry(3, "Info", body, "10", 2),
    ];
    assert.isTrue(view("exec", "all", replayed).showPass);
    assert.isFalse(view("exec", "warn", replayed).showPass);
    assert.isFalse(view("a/Capture", "all", replayed).showPass);
  });

  it("names each line's source on the execution span, with the attempt when there are several", () => {
    const origins = view("exec").groups.flatMap((group) =>
      group.lines.map((line) => Option.getOrUndefined(line.origin)),
    );
    assert.deepStrictEqual(origins, [
      { _tag: "Body" },
      {
        _tag: "Activity",
        name: "Capture/1",
        attempt: Option.none(),
        key: Option.some("a/Capture%2F1"),
      },
      {
        _tag: "Activity",
        name: "Capture/1",
        attempt: Option.none(),
        key: Option.some("a/Capture%2F1"),
      },
      { _tag: "Activity", name: "Capture", attempt: Option.none(), key: Option.some("a/Capture") },
      { _tag: "Activity", name: "Charge", attempt: Option.some(1), key: Option.some("a/Charge/1") },
      { _tag: "Activity", name: "Charge", attempt: Option.some(2), key: Option.some("a/Charge/2") },
      { _tag: "Activity", name: "Charge", attempt: Option.some(2), key: Option.some("a/Charge/2") },
      { _tag: "Body" },
    ]);
  });

  it("leaves a line from an activity missing in the journal without a span to jump to", () => {
    const [line] =
      view("exec", "all", [entry(1, "Info", activity("Later", 3), "00")]).groups[0]?.lines ?? [];
    assert.deepStrictEqual(Option.getOrUndefined(line?.origin ?? Option.none()), {
      _tag: "Activity",
      name: "Later",
      attempt: Option.some(3),
      key: Option.none(),
    });
  });

  it("keeps a retry's attempt and no jump target while the detail still shows one attempt", () => {
    const [line] =
      view("exec", "all", [entry(1, "Info", activity("Capture", 2), "00")]).groups[0]?.lines ?? [];
    assert.deepStrictEqual(Option.getOrUndefined(line?.origin ?? Option.none()), {
      _tag: "Activity",
      name: "Capture",
      attempt: Option.some(2),
      key: Option.none(),
    });
  });

  it("names no source inside an activity", () => {
    const lines = view("a/Charge").groups.flatMap((group) => group.lines);
    assert.isTrue(lines.every((line) => Option.isNone(line.origin)));
  });

  it("groups an activity with several attempts by attempt and leaves others ungrouped", () => {
    const groups = view("a/Charge").groups.map((group) => ({
      attempt: group.attempt,
      seqs: group.lines.map((line) => line.entry.seq),
    }));
    assert.deepStrictEqual(groups, [
      { attempt: Option.some(1), seqs: [5] },
      { attempt: Option.some(2), seqs: [6, 7] },
    ]);
    assert.deepStrictEqual(
      view("a/Charge", "warn").groups.map((group) => group.attempt),
      [Option.some(1), Option.some(2)],
    );
    assert.deepStrictEqual(
      view("a/Charge", "error").groups.map((group) => group.attempt),
      [Option.some(1)],
    );
    assert.deepStrictEqual(
      view("a/Charge/2").groups.map((group) => group.attempt),
      [Option.none()],
    );
    assert.deepStrictEqual(view("exec").groups.length, 1);
  });

  it("has no groups when nothing is at the chosen level", () => {
    const logs = view("a/Capture", "warn");
    assert.deepStrictEqual(logs.groups, []);
    assert.strictEqual(logs.count, 1);
  });
});

describe("logMarks", () => {
  const ms = (time: string) => DateTime.toEpochMillis(at(time));

  it("marks Warn and above on an activity across its attempts and on each attempt", () => {
    assert.deepStrictEqual(logMarks(span("a/Charge"), entries), [
      { seq: 5, at: ms("05.500"), level: "Error" },
      { seq: 7, at: ms("07.400"), level: "Warn" },
    ]);
    assert.deepStrictEqual(logMarks(span("a/Charge/2"), entries), [
      { seq: 7, at: ms("07.400"), level: "Warn" },
    ]);
    assert.deepStrictEqual(logMarks(span("a/Capture%2F1"), entries), [
      { seq: 3, at: ms("01.300"), level: "Warn" },
    ]);
    assert.deepStrictEqual(logMarks(span("a/Capture"), entries), []);
  });

  it("marks nothing on the execution, waits and children", () => {
    assert.deepStrictEqual(logMarks(span("exec"), entries), []);
    assert.deepStrictEqual(logMarks(span("w/Deferred/Approval"), entries), []);
    assert.deepStrictEqual(logMarks(span("c/child1"), entries), []);
  });
});
