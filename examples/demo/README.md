# demo

A kymo workflow source with five fake workflows for a SaaS business. It exercises activities, retries,
compensation, child workflows, `DurableDeferred` and `DurableClock`. Each activity sleeps for at
most 2 seconds and returns made-up values instead of calling a real service.

| Workflow             | Path                | Trigger                                                                                                                                                                                                |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ChargeInvoice`      | card declined       | `invoiceId: "inv_0402"`. `AuthorizeCard` fails with `CardDeclined` and the execution suspends (`SuspendOnFailure`).                                                                                    |
| `ChargeInvoice`      | gateway unavailable | `invoiceId: "inv_0503"`. `CapturePayment` fails with `GatewayUnavailable` on all 3 attempts and the execution suspends.                                                                                |
| `ProvisionWorkspace` | child charge        | `plan: "team"` or `"enterprise"` runs `ChargeInvoice` as a child on the matching invoice (`ws_8f21` charges `inv_8f21`). `plan: "free"` skips it. A failing child suspends the parent too.             |
| `RefundRequest`      | waits for approval  | Always suspends on the `ManagerApproval` deferred. Complete it with `{ approved: true, approver }` to refund, or `approved: false` to fail with `RefundRejected`.                                      |
| `NightlyExport`      | waits for the clock | `WaitForQuietHours` sleeps until 02:00 UTC on the day after `date`. A `date` whose quiet hours have passed runs at once. A `date` not on the calendar, such as `2026-02-30`, fails payload validation. |
| `DunningSequence`    | paid or escalated   | Waits 3 days per round. The last character of `invoiceId` (1, 2 or 3) is the round whose `CheckPaid` reports paid. Any other character escalates after 3 rounds.                                       |
