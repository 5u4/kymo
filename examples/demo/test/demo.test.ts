import { assert, describe, it } from "@effect/vitest";
import demo from "../src/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import * as ChargeInvoice from "../src/charge-invoice.ts";
import * as NightlyExport from "../src/nightly-export.ts";
import * as ProvisionWorkspace from "../src/provision-workspace.ts";
import * as RefundRequest from "../src/refund-request.ts";

const engine = demo.layer.pipe(Layer.provideMerge(WorkflowEngine.layerMemory));

const settle = Effect.fnUntraced(function* <A, E, R, Tag extends "Complete" | "Suspended">(
  poll: Effect.Effect<Option.Option<Workflow.Result<A, E>>, never, R>,
  tag: Tag,
) {
  for (let step = 0; step < 200; step++) {
    const result = yield* poll;
    if (Option.isSome(result) && result.value._tag === tag) {
      return result.value as Extract<Workflow.Result<A, E>, { readonly _tag: Tag }>;
    }
    yield* TestClock.adjust("100 millis");
  }
  return yield* Effect.die(`execution never reached ${tag}`);
});

describe("demo plugin", () => {
  it("registers the five demo workflows", () => {
    assert.deepStrictEqual(
      demo.workflows.map((workflow) => workflow._tag),
      ["ProvisionWorkspace", "ChargeInvoice", "RefundRequest", "NightlyExport", "DunningSequence"],
    );
  });

  it.effect("ChargeInvoice captures the payment", () =>
    Effect.gen(function* () {
      const executionId = yield* ChargeInvoice.ChargeInvoice.execute(
        { invoiceId: "inv_5520", amountCents: 4900, currency: "USD" },
        { discard: true },
      );
      const result = yield* settle(ChargeInvoice.ChargeInvoice.poll(executionId), "Complete");
      assert(Exit.isSuccess(result.exit));
      assert.strictEqual(result.exit.value.chargeId, "ch_5520");
    }).pipe(Effect.provide(engine)),
  );

  for (const [invoiceId, error] of [
    [
      ChargeInvoice.declinedInvoiceId,
      Schema.encodeSync(ChargeInvoice.CardDeclined)(
        new ChargeInvoice.CardDeclined({ code: "insufficient_funds" }),
      ),
    ],
    [
      ChargeInvoice.gatewayDownInvoiceId,
      Schema.encodeSync(ChargeInvoice.GatewayUnavailable)(
        new ChargeInvoice.GatewayUnavailable({ status: 503 }),
      ),
    ],
  ] as const) {
    it.effect(`ChargeInvoice suspends on ${error._tag}`, () =>
      Effect.gen(function* () {
        const executionId = yield* ChargeInvoice.ChargeInvoice.execute(
          { invoiceId, amountCents: 1500, currency: "EUR" },
          { discard: true },
        );
        const result = yield* settle(ChargeInvoice.ChargeInvoice.poll(executionId), "Suspended");
        assert.isTrue(result.failed);
        assert.deepStrictEqual(result.cause && Cause.squash(result.cause), error);
      }).pipe(Effect.provide(engine)),
    );
  }

  it.effect("ProvisionWorkspace charges each workspace its own invoice through a child", () =>
    Effect.gen(function* () {
      const workspaces = [
        { workspaceId: "ws_8f21", plan: "team", amountCents: 4900 },
        { workspaceId: "ws_8521", plan: "enterprise", amountCents: 29900 },
      ] as const;
      const executions = yield* Effect.forEach(workspaces, (workspace) =>
        ProvisionWorkspace.ProvisionWorkspace.execute(
          {
            workspaceId: workspace.workspaceId,
            plan: workspace.plan,
            ownerEmail: "mara@northwind.dev",
          },
          { discard: true },
        ).pipe(Effect.map((executionId) => ({ ...workspace, executionId }))),
      );
      const childIds = new Set<string>();
      for (const { workspaceId, amountCents, executionId } of executions) {
        const result = yield* settle(
          ProvisionWorkspace.ProvisionWorkspace.poll(executionId),
          "Complete",
        );
        const invoiceId = `inv_${workspaceId.slice("ws_".length)}`;
        assert.deepStrictEqual(
          result.exit,
          Exit.succeed({ databaseUrl: `postgres://pg-1.internal/${workspaceId}`, invoiceId }),
        );
        const childId = yield* ChargeInvoice.ChargeInvoice.executionId({
          invoiceId,
          amountCents,
          currency: "USD",
        });
        childIds.add(childId);
        const child = yield* settle(ChargeInvoice.ChargeInvoice.poll(childId), "Complete");
        assert(Exit.isSuccess(child.exit));
        assert.strictEqual(child.exit.value.chargeId, `ch_${workspaceId.slice("ws_".length)}`);
      }
      assert.strictEqual(childIds.size, workspaces.length);
    }).pipe(Effect.provide(engine)),
  );

  it.effect("RefundRequest waits for ManagerApproval before refunding", () =>
    Effect.gen(function* () {
      const executionId = yield* RefundRequest.RefundRequest.execute(
        { orderId: "ord_10442", amountCents: 12900, reason: "damaged" },
        { discard: true },
      );
      const suspended = yield* settle(RefundRequest.RefundRequest.poll(executionId), "Suspended");
      assert.isUndefined(suspended.failed);
      yield* TestClock.adjust("1 hour");
      yield* settle(RefundRequest.RefundRequest.poll(executionId), "Suspended");

      yield* DurableDeferred.succeed(RefundRequest.ManagerApproval, {
        token: DurableDeferred.tokenFromExecutionId(RefundRequest.ManagerApproval, {
          workflow: RefundRequest.RefundRequest,
          executionId,
        }),
        value: { approved: true, approver: "dana@ledgerly.io" },
      });
      const result = yield* settle(RefundRequest.RefundRequest.poll(executionId), "Complete");
      assert.deepStrictEqual(result.exit, Exit.succeed({ refundId: "re_10442" }));
    }).pipe(Effect.provide(engine)),
  );

  it.effect("NightlyExport sleeps until 02:00 UTC the next day", () =>
    Effect.gen(function* () {
      const executionId = yield* NightlyExport.NightlyExport.execute(
        { date: "1970-01-01", format: "csv" },
        { discard: true },
      );
      yield* settle(NightlyExport.NightlyExport.poll(executionId), "Suspended");
      yield* TestClock.adjust("25 hours");
      yield* settle(NightlyExport.NightlyExport.poll(executionId), "Suspended");

      yield* TestClock.adjust("1 hour");
      const result = yield* settle(NightlyExport.NightlyExport.poll(executionId), "Complete");
      assert.deepStrictEqual(
        result.exit,
        Exit.succeed({ objectKey: "exports/1970/01/01/ledger.csv", rows: 184212 }),
      );
    }).pipe(Effect.provide(engine)),
  );

  it("NightlyExport rejects dates that are not on the calendar", () => {
    const decode = Schema.decodeUnknownExit(NightlyExport.NightlyExport.payloadSchema);
    for (const date of ["2026-99-99", "2026-13-01", "2026-02-30", "2025-02-29"]) {
      const exit = decode({ date, format: "csv" });
      assert(Exit.isFailure(exit), `${date} decoded`);
      assert(
        Schema.isSchemaError(Cause.squash(exit.cause)),
        `${date} failed without a SchemaError`,
      );
    }
    assert.deepStrictEqual(
      decode({ date: "2024-02-29", format: "csv" }),
      Exit.succeed({ date: "2024-02-29", format: "csv" }),
    );
  });
});
