import * as Layer from "effect/Layer";
import type { Workflows } from "kymo/workflows";
import * as ChargeInvoice from "./charge-invoice.ts";
import * as DunningSequence from "./dunning-sequence.ts";
import * as NightlyExport from "./nightly-export.ts";
import * as ProvisionWorkspace from "./provision-workspace.ts";
import * as RefundRequest from "./refund-request.ts";

export default Layer.mergeAll(
  ProvisionWorkspace.layer,
  ChargeInvoice.layer,
  RefundRequest.layer,
  NightlyExport.layer,
  DunningSequence.layer,
) satisfies Workflows;
