import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Activity from "effect/workflow/Activity";
import * as DurableClock from "effect/workflow/DurableClock";
import * as Workflow from "effect/workflow/Workflow";
import * as ChargeInvoice from "./charge-invoice.ts";

const rounds = [1, 2, 3] as const;

export const DunningSequence = Workflow.make("DunningSequence", {
  payload: {
    customerId: Schema.String.check(Schema.isPattern(/^cus_[0-9]+$/)),
    invoiceId: ChargeInvoice.InvoiceId,
  },
  success: Schema.Struct({ outcome: Schema.Literals(["paid", "escalated"]) }),
  idempotencyKey: ({ customerId }) => customerId,
});

export const layer = DunningSequence.toLayer(
  Effect.fnUntraced(function* ({ customerId, invoiceId }) {
    const paidInRound = Number(invoiceId.at(-1));
    for (const round of rounds) {
      yield* Activity.make({
        name: `SendReminder-${round}`,
        success: Schema.Struct({ messageId: Schema.String }),
        execute: Effect.sleep("300 millis").pipe(
          Effect.as({ messageId: `msg_${customerId}_${round}` }),
        ),
      });
      yield* DurableClock.sleep({ name: `wait-round-${round}`, duration: "3 days" });
      const { paid } = yield* Activity.make({
        name: `CheckPaid-${round}`,
        success: Schema.Struct({ paid: Schema.Boolean }),
        execute: Effect.sleep("200 millis").pipe(Effect.as({ paid: round === paidInRound })),
      });
      if (paid) {
        return { outcome: "paid" as const };
      }
    }
    return { outcome: "escalated" as const };
  }),
);
