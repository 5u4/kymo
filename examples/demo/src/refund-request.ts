import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Activity from "effect/workflow/Activity";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Workflow from "effect/workflow/Workflow";

export class RefundRejected extends Schema.TaggedError<RefundRejected>()("RefundRejected", {
  approver: Schema.String,
}) {}

export const ManagerApproval = DurableDeferred.make("ManagerApproval", {
  success: Schema.Struct({ approved: Schema.Boolean, approver: Schema.String }),
});

export const RefundRequest = Workflow.make("RefundRequest", {
  payload: {
    orderId: Schema.String.check(Schema.isPattern(/^ord_[0-9]{5}$/)),
    amountCents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    reason: Schema.Literals(["damaged", "late", "duplicate", "other"]),
    note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(280))),
  },
  success: Schema.Struct({ refundId: Schema.String }),
  error: RefundRejected,
  idempotencyKey: ({ orderId }) => orderId,
});

export const layer = RefundRequest.toLayer(
  Effect.fnUntraced(function* ({ orderId, amountCents }) {
    const digits = orderId.slice("ord_".length);
    yield* Effect.log(`refund of ${amountCents} cents requested for ${orderId}`);
    yield* Activity.make({
      name: "LoadOrder",
      success: Schema.Struct({
        orderId: Schema.String,
        customer: Schema.String,
        totalCents: Schema.Int,
      }),
      execute: Effect.log(`loading ${orderId}`).pipe(
        Effect.andThen(Effect.sleep("300 millis")),
        Effect.as({ orderId, customer: `cus_${digits}`, totalCents: amountCents }),
      ),
    });
    yield* Activity.make({
      name: "NotifyApprover",
      success: Schema.Struct({ channel: Schema.String, messageTs: Schema.String }),
      execute: Effect.sleep("400 millis").pipe(
        Effect.as({ channel: "#refunds", messageTs: `${digits}.0001` }),
      ),
    });
    const approval = yield* DurableDeferred.await(ManagerApproval);
    yield* Effect.log(`approval from ${approval.approver}: ${approval.approved}`);
    if (!approval.approved) {
      return yield* new RefundRejected({ approver: approval.approver });
    }
    const refund = yield* Activity.make({
      name: "IssueRefund",
      success: Schema.Struct({ refundId: Schema.String }),
      execute: Effect.log(`issuing refund of ${amountCents} cents`).pipe(
        Effect.andThen(Effect.sleep("900 millis")),
        Effect.as({ refundId: `re_${digits}` }),
      ),
    });
    yield* Activity.make({
      name: "NotifyCustomer",
      success: Schema.Struct({ messageId: Schema.String }),
      execute: Effect.sleep("400 millis").pipe(Effect.as({ messageId: `msg_${digits}` })),
    });
    return refund;
  }),
);
