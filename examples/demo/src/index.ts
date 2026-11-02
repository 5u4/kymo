import * as Plugin from "kymo/plugin";
import * as Layer from "effect/Layer";
import * as ChargeInvoice from "./charge-invoice.ts";
import * as DunningSequence from "./dunning-sequence.ts";
import * as NightlyExport from "./nightly-export.ts";
import * as ProvisionWorkspace from "./provision-workspace.ts";
import * as RefundRequest from "./refund-request.ts";

export default Plugin.make({
  name: "demo",
  workflows: [
    ProvisionWorkspace.ProvisionWorkspace,
    ChargeInvoice.ChargeInvoice,
    RefundRequest.RefundRequest,
    NightlyExport.NightlyExport,
    DunningSequence.DunningSequence,
  ],
  layer: Layer.mergeAll(
    ProvisionWorkspace.layer,
    ChargeInvoice.layer,
    RefundRequest.layer,
    NightlyExport.layer,
    DunningSequence.layer,
  ),
});
