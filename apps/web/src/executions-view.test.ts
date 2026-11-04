import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ExecutionStatus, ExecutionSummary } from "kymo/api";
import {
  ago,
  countByStatus,
  executionsView,
  Filter,
  matches,
  nest,
  refine,
  suspendTag,
  workflowRows,
} from "./executions-view.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const execution = (
  id: string,
  fields: {
    readonly workflow?: string;
    readonly status?: ExecutionStatus;
    readonly label?: string;
    readonly key?: string;
    readonly startedAt?: string;
    readonly updatedAt?: string;
    readonly parentId?: string;
  } = {},
): ExecutionSummary => ({
  id,
  workflow: fields.workflow ?? "Deploy",
  label: Option.fromUndefinedOr(fields.label),
  idempotencyKey: Option.fromUndefinedOr(fields.key),
  status: fields.status ?? { _tag: "Running" },
  startedAt: at(fields.startedAt ?? "2026-11-03T10:00:00Z"),
  updatedAt: Option.map(Option.fromUndefinedOr(fields.updatedAt), at),
  parentId: Option.fromUndefinedOr(fields.parentId),
});

const ids = (rows: ReadonlyArray<{ readonly execution: ExecutionSummary }>) =>
  rows.map((row) => row.execution.id);

describe("matches", () => {
  const target = execution("a1b2c3d4e5", { label: "Release v2.4", key: "repo:42" });

  it("matches an id prefix but not an id infix", () => {
    assert.isTrue(matches(target, "A1B2"));
    assert.isFalse(matches(target, "b2c3"));
  });

  it("matches an idempotencyKey substring", () => {
    assert.isTrue(matches(target, "PO:4"));
  });

  it("matches a label substring", () => {
    assert.isTrue(matches(target, "  v2.4 "));
    assert.isFalse(matches(target, "v3"));
  });

  it("matches everything when the query is blank", () => {
    assert.isTrue(matches(execution("x"), "   "));
  });
});

describe("nest", () => {
  it("orders newest first by the last entry, falling back to the start", () => {
    const rows = nest(
      [
        execution("old", { startedAt: "2026-11-03T08:00:00Z" }),
        execution("revived", {
          startedAt: "2026-11-03T07:00:00Z",
          updatedAt: "2026-11-03T12:00:00Z",
        }),
        execution("new", { startedAt: "2026-11-03T11:00:00Z" }),
      ],
      [],
    );
    assert.deepStrictEqual(ids(rows), ["revived", "new", "old"]);
  });

  it("puts a visible child under its visible parent with tree rails", () => {
    const parent = execution("p", { startedAt: "2026-11-03T09:00:00Z" });
    const first = execution("c1", { parentId: "p", startedAt: "2026-11-03T09:10:00Z" });
    const second = execution("c2", { parentId: "p", startedAt: "2026-11-03T09:05:00Z" });
    const grandchild = execution("g", { parentId: "c1", startedAt: "2026-11-03T09:20:00Z" });
    const all = [parent, first, second, grandchild];
    const rows = nest(all, all);
    assert.deepStrictEqual(
      rows.map((row) => [row.execution.id, row.depth, row.last, row.rails, row.hasChildren]),
      [
        ["p", 0, true, [], true],
        ["c1", 1, false, [], true],
        ["g", 2, true, [0], false],
        ["c2", 1, true, [], false],
      ],
    );
    assert.isTrue(rows.every((row) => Option.isNone(row.parent)));
  });

  it("shows a child whose parent is filtered out at the top level, pointing at the parent", () => {
    const parent = execution("p", { workflow: "Nightly" });
    const child = execution("c", { workflow: "Deploy", parentId: "p" });
    const rows = nest([child], [parent, child]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]?.depth, 0);
    assert.deepStrictEqual(rows[0]?.parent, Option.some(parent));
  });
});

describe("countByStatus", () => {
  it("counts every status, including absent ones", () => {
    assert.deepStrictEqual(
      countByStatus([
        execution("a", { status: { _tag: "Succeeded" } }),
        execution("b", { status: { _tag: "Succeeded" } }),
        execution("c", { status: { _tag: "Failed", kind: "Die", message: "boom" } }),
      ]),
      { running: 0, suspended: 0, succeeded: 2, failed: 1, interrupted: 0 },
    );
  });
});

describe("executionsView", () => {
  const journal = [
    execution("d1", { workflow: "Deploy", status: { _tag: "Succeeded" } }),
    execution("d2", { workflow: "Deploy", status: { _tag: "Interrupted" } }),
    execution("n1", { workflow: "Nightly", status: { _tag: "Succeeded" } }),
  ];

  it("scopes status counts to the selected workflow and ignores the status filter", () => {
    const view = executionsView(journal, { workflow: "Deploy", status: "interrupted" });
    assert.deepStrictEqual(view.statusCounts, {
      running: 0,
      suspended: 0,
      succeeded: 1,
      failed: 0,
      interrupted: 1,
    });
    assert.strictEqual(view.shown, 1);
    assert.strictEqual(view.total, 3);
  });

  it("reports an empty journal", () => {
    assert.deepStrictEqual(executionsView([], { q: "x" }).list, { _tag: "Empty" });
  });

  it("reports a workflow that was never executed", () => {
    assert.deepStrictEqual(executionsView(journal, { workflow: "Backup" }).list, {
      _tag: "Unexecuted",
      workflow: "Backup",
    });
  });

  it("reports no match with the size of the workflow scope", () => {
    assert.deepStrictEqual(executionsView(journal, { workflow: "Deploy", status: "failed" }).list, {
      _tag: "NoMatch",
      scopeTotal: 2,
    });
  });
});

describe("workflowRows", () => {
  it("lists all workflows first, then every workflow by name including unexecuted ones", () => {
    const rows = workflowRows(
      [{ name: "Nightly" }, { name: "Backup" }],
      [execution("a", { workflow: "Nightly", status: { _tag: "Succeeded" } })],
    );
    assert.deepStrictEqual(
      rows.map((row) => [Option.getOrNull(row.name), row.total, row.counts.succeeded]),
      [
        [null, 1, 1],
        ["Backup", 0, 0],
        ["Nightly", 1, 1],
      ],
    );
  });
});

describe("refine", () => {
  it("drops keys whose value becomes empty", () => {
    assert.deepStrictEqual(refine({ workflow: "Deploy", q: "ab" }, { q: "", status: "failed" }), {
      workflow: "Deploy",
      status: "failed",
    });
  });
});

describe("suspendTag", () => {
  it("names each suspend reason", () => {
    const tag = (reason: Extract<ExecutionStatus, { _tag: "Suspended" }>["reason"]) =>
      Option.getOrNull(suspendTag({ _tag: "Suspended", reason }));
    assert.strictEqual(tag({ _tag: "Failure", cause: "boom" }), "SuspendOnFailure");
    assert.strictEqual(tag({ _tag: "Deferred", name: Option.some("approval") }), "approval");
    assert.strictEqual(tag({ _tag: "Deferred", name: Option.none() }), "deferred");
    assert.strictEqual(
      tag({ _tag: "Clock", name: "wait", wakeAt: at("2026-11-03T12:00:00Z") }),
      "clock",
    );
    assert.strictEqual(tag({ _tag: "Child", executionId: "c" }), "child");
    assert.isTrue(Option.isNone(suspendTag({ _tag: "Running" })));
  });
});

describe("Filter", () => {
  it("clears a status the URL names that does not exist", () => {
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(Filter)({ workflow: "Deploy", status: "bogus" }),
      { workflow: "Deploy", status: undefined },
    );
    assert.deepStrictEqual(Schema.decodeUnknownSync(Filter)({ status: "failed" }), {
      status: "failed",
    });
  });
});

describe("ago", () => {
  it("formats coarse elapsed time", () => {
    const now = at("2026-11-03T12:00:00Z");
    assert.strictEqual(ago(now, at("2026-11-03T11:59:15Z")), "45s ago");
    assert.strictEqual(ago(now, at("2026-11-03T11:30:00Z")), "30m ago");
    assert.strictEqual(ago(now, at("2026-11-03T09:15:00Z")), "2h 45m ago");
    assert.strictEqual(ago(now, at("2026-11-01T10:00:00Z")), "2d 2h ago");
    assert.strictEqual(ago(now, at("2026-11-03T12:00:05Z")), "0s ago");
  });
});
