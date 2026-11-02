import { assert, describe, it } from "@effect/vitest";
import demo from "@kymo/plugin-demo";
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
import * as ChargeInvoice from "../src/ChargeInvoice.ts";
import * as NightlyExport from "../src/NightlyExport.ts";
import * as ProvisionWorkspace from "../src/ProvisionWorkspace.ts";
import * as RefundRequest from "../src/RefundRequest.ts";

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

  it.effect("ProvisionWorkspace charges the first invoice through a child execution", () =>
    Effect.gen(function* () {
      const executionId = yield* ProvisionWorkspace.ProvisionWorkspace.execute(
        { workspaceId: "ws_8f21", plan: "team", ownerEmail: "mara@northwind.dev" },
        { discard: true },
      );
      const result = yield* settle(
        ProvisionWorkspace.ProvisionWorkspace.poll(executionId),
        "Complete",
      );
      assert.deepStrictEqual(
        result.exit,
        Exit.succeed({ databaseUrl: "postgres://pg-1.internal/ws_8f21", invoiceId: "inv_8521" }),
      );
      const childId = yield* ChargeInvoice.ChargeInvoice.executionId({
        invoiceId: "inv_8521",
        amountCents: 4900,
        currency: "USD",
      });
      const child = yield* settle(ChargeInvoice.ChargeInvoice.poll(childId), "Complete");
      assert(Exit.isSuccess(child.exit));
      assert.strictEqual(child.exit.value.chargeId, "ch_8521");
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
});
