import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import * as ChargeInvoice from "./ChargeInvoice.ts";

const Plan = Schema.Literals(["free", "team", "enterprise"]);

const planPriceCents: Record<typeof Plan.Type, number | null> = {
  free: null,
  team: 4900,
  enterprise: 29900,
};

export const ProvisionWorkspace = Workflow.make("ProvisionWorkspace", {
  payload: {
    workspaceId: Schema.String.check(Schema.isPattern(/^ws_[a-z0-9]{4}$/)),
    plan: Plan,
    ownerEmail: Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/)),
  },
  success: Schema.Struct({
    databaseUrl: Schema.String,
    invoiceId: Schema.NullOr(Schema.String),
  }),
  error: Schema.Union([ChargeInvoice.CardDeclined, ChargeInvoice.GatewayUnavailable]),
  idempotencyKey: ({ workspaceId }) => workspaceId,
});

const invoiceIdFor = (workspaceId: string): string => `inv_${workspaceId.slice("ws_".length)}`;

const chargeFirstInvoice = (invoiceId: string, amountCents: number) =>
  ChargeInvoice.ChargeInvoice.execute({ invoiceId, amountCents, currency: "USD" }).pipe(
    Effect.as(invoiceId),
  );

export const layer = ProvisionWorkspace.toLayer(
  Effect.fnUntraced(function* ({ workspaceId, plan }) {
    const { databaseUrl } = yield* Activity.make({
      name: "CreateDatabase",
      success: Schema.Struct({ databaseUrl: Schema.String }),
      execute: Effect.sleep("800 millis").pipe(
        Effect.as({ databaseUrl: `postgres://pg-1.internal/${workspaceId}` }),
      ),
    }).pipe(ProvisionWorkspace.withCompensation(() => Effect.sleep("300 millis")));
    yield* Activity.make({
      name: "SeedDefaults",
      success: Schema.Struct({ tables: Schema.Int, rows: Schema.Int }),
      execute: Effect.sleep("400 millis").pipe(Effect.as({ tables: 14, rows: 212 })),
    });
    const amountCents = planPriceCents[plan];
    const invoiceId =
      amountCents === null
        ? null
        : yield* chargeFirstInvoice(invoiceIdFor(workspaceId), amountCents);
    yield* Activity.make({
      name: "SendWelcomeEmail",
      success: Schema.Struct({ messageId: Schema.String }),
      execute: Effect.sleep("200 millis").pipe(Effect.as({ messageId: `msg_${workspaceId}` })),
    });
    return { databaseUrl, invoiceId };
  }),
);
