import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { ExecutionStatus, ExecutionSummary } from "kymo/api";
import { ActionState, Phase, phase, unfinishedChildren } from "./actions.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-11-03T10:00:${time}Z`);
const later = (base: DateTime.Utc, millis: number) =>
  DateTime.makeUnsafe(DateTime.toEpochMillis(base) + millis);

const summary = (id: string, status: ExecutionStatus): ExecutionSummary => ({
  id,
  workflow: "Child",
  label: Option.none(),
  idempotencyKey: Option.none(),
  status,
  startedAt: at("00"),
  updatedAt: Option.none(),
  parentId: Option.some("parent"),
});

describe("phase", () => {
  it("is ready once the execution moved past the baseline, even while it stays suspended", () => {
    const state = ActionState.Requested({
      target: { action: "complete", name: "A" },
      baseline: Option.some(at("01")),
      at: at("03"),
    });
    assert.deepStrictEqual(
      phase(state, { updatedAt: Option.some(at("02")), requestedAt: at("04") }, at("04")),
      Phase.Ready(),
    );
  });

  it("ignores a detail requested before the POST answered, even when its updatedAt differs", () => {
    const state = ActionState.Requested({
      target: { action: "resume" },
      baseline: Option.some(at("02")),
      at: at("03"),
    });
    assert.deepStrictEqual(
      phase(state, { updatedAt: Option.some(at("01")), requestedAt: at("01") }, at("03")),
      Phase.Busy({ target: { action: "resume" } }),
    );
  });

  it("stays busy until 10 s after the request was accepted without a change", () => {
    const accepted = at("05");
    const state = ActionState.Requested({
      target: { action: "interrupt" },
      baseline: Option.none(),
      at: accepted,
    });
    assert.deepStrictEqual(
      phase(
        state,
        { updatedAt: Option.none(), requestedAt: later(accepted, 9_000) },
        later(accepted, 9_900),
      ),
      Phase.Busy({ target: { action: "interrupt" } }),
    );
    assert.deepStrictEqual(
      phase(
        state,
        { updatedAt: Option.none(), requestedAt: later(accepted, 9_900) },
        later(accepted, 10_000),
      ),
      Phase.NoChange({ target: { action: "interrupt" } }),
    );
  });

  it("counts an updatedAt that disappears as a change", () => {
    const state = ActionState.Requested({
      target: { action: "resume" },
      baseline: Option.some(at("01")),
      at: at("02"),
    });
    assert.deepStrictEqual(
      phase(state, { updatedAt: Option.none(), requestedAt: at("03") }, at("03")),
      Phase.Ready(),
    );
  });

  it("stays busy while the same updatedAt is still reported", () => {
    const state = ActionState.Requested({
      target: { action: "resume" },
      baseline: Option.some(at("01")),
      at: at("02"),
    });
    assert.deepStrictEqual(
      phase(state, { updatedAt: Option.some(at("01")), requestedAt: at("03") }, at("03")),
      Phase.Busy({ target: { action: "resume" } }),
    );
  });
});

describe("unfinishedChildren", () => {
  it("counts only listed children that have not ended", () => {
    const summaries = new Map(
      [
        summary("running", { _tag: "Running" }),
        summary("parked", { _tag: "Suspended", reason: { _tag: "Child", executionId: "x" } }),
        summary("done", { _tag: "Succeeded" }),
        summary("broke", { _tag: "Failed", kind: "Fail", message: "boom" }),
        summary("stopped", { _tag: "Interrupted" }),
      ].map((child) => [child.id, child]),
    );
    assert.strictEqual(
      unfinishedChildren(["running", "parked", "done", "broke", "stopped", "missing"], summaries),
      2,
    );
  });
});
