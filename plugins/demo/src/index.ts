import * as Plugin from "@kymo/contract/Plugin";
import * as Layer from "effect/Layer";
import * as ChargeInvoice from "./ChargeInvoice.ts";
import * as DunningSequence from "./DunningSequence.ts";
import * as NightlyExport from "./NightlyExport.ts";
import * as ProvisionWorkspace from "./ProvisionWorkspace.ts";
import * as RefundRequest from "./RefundRequest.ts";

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
