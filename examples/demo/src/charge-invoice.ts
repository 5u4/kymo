import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";

export const InvoiceId = Schema.String.check(Schema.isPattern(/^inv_[a-z0-9]{4}$/));

export const declinedInvoiceId = "inv_0402";
export const gatewayDownInvoiceId = "inv_0503";

export class CardDeclined extends Schema.TaggedError<CardDeclined>()("CardDeclined", {
  code: Schema.String,
}) {}

export class GatewayUnavailable extends Schema.TaggedError<GatewayUnavailable>()(
  "GatewayUnavailable",
  { status: Schema.Int },
) {}

const Charge = Schema.Struct({
  chargeId: Schema.String,
  capturedAt: Schema.DateTimeUtc,
});

export const ChargeInvoice = Workflow.make("ChargeInvoice", {
  payload: {
    invoiceId: InvoiceId,
    amountCents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    currency: Schema.Literals(["USD", "EUR", "GBP"]),
  },
  success: Charge,
  error: Schema.Union([CardDeclined, GatewayUnavailable]),
  idempotencyKey: ({ invoiceId }) => invoiceId,
}).annotate(Workflow.SuspendOnFailure, true);

export const layer = ChargeInvoice.toLayer(
  Effect.fnUntraced(function* ({ invoiceId }) {
    const suffix = invoiceId.slice("inv_".length);
    yield* Effect.log(`charging ${invoiceId}`);
    yield* Activity.make({
      name: "AuthorizeCard",
      success: Schema.Struct({ authorizationId: Schema.String, last4: Schema.String }),
      error: CardDeclined,
      execute: Effect.sleep("300 millis").pipe(
        Effect.andThen(
          invoiceId === declinedInvoiceId
            ? Effect.fail(new CardDeclined({ code: "insufficient_funds" }))
            : Effect.succeed({ authorizationId: `auth_${suffix}`, last4: "4242" }),
        ),
      ),
    });
    const charge = yield* Activity.make({
      name: "CapturePayment",
      success: Charge,
      error: GatewayUnavailable,
      execute: Activity.CurrentAttempt.pipe(
        Effect.flatMap((attempt) => Effect.log(`capturing ${invoiceId}, attempt ${attempt}`)),
        Effect.andThen(Effect.sleep("500 millis")),
        Effect.andThen(
          invoiceId === gatewayDownInvoiceId
            ? Effect.fail(new GatewayUnavailable({ status: 503 }))
            : Effect.map(DateTime.now, (capturedAt) => ({ chargeId: `ch_${suffix}`, capturedAt })),
        ),
      ),
    }).pipe(Activity.retry({ times: 2 }));
    yield* Activity.make({
      name: "MarkInvoicePaid",
      success: Schema.Struct({ invoiceId: Schema.String, status: Schema.Literal("paid") }),
      execute: Effect.sleep("200 millis").pipe(Effect.as({ invoiceId, status: "paid" as const })),
    });
    return charge;
  }),
);
