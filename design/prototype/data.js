// Shared fixture for kymo UI prototypes.
// kymo = UI shell + AXI CLI over Effect v4 durable workflows
// (effect/unstable/workflow on SingleRunner + ClusterWorkflowEngine + SQLite).
// Terms are Effect's: Workflow, execution (executionId), Activity, DurableDeferred,
// DurableClock, Cause, compensation. Operations in the MVP: execute, resume, interrupt.
// Everything is in-memory; prototypes mutate a deep copy via KYMO.api.*.

(function () {
  const NOW = "2026-11-01T15:00:00.000Z";

  const server = {
    url: "http://127.0.0.1:4400",
    app: "ledgerly-api",
    effect: "4.1.1",
    runner: "SingleRunner",
    storage: "sqlite ./data/ledgerly.db (cluster_messages, cluster_replies)",
    status: "up", // "up" | "down"  — prototypes must design the "down" state too
    uptime: "6h 12m",
  };

  // payload schemas are JSON Schema converted from Effect Schema
  const workflows = [
    {
      name: "ProvisionWorkspace",
      description: "Create the tenant database, seed defaults, charge the first invoice, send welcome mail.",
      idempotencyKey: "payload.workspaceId",
      payload: {
        type: "object",
        required: ["workspaceId", "plan", "ownerEmail"],
        properties: {
          workspaceId: { type: "string", pattern: "^ws_[a-z0-9]{4}$", examples: ["ws_9b14"] },
          plan: { type: "string", enum: ["free", "team", "enterprise"] },
          ownerEmail: { type: "string", format: "email" },
        },
      },
      success: "{ databaseUrl: string, invoiceId: string | null }",
      error: "ProvisionError | ChargeError",
      annotations: [],
    },
    {
      name: "ChargeInvoice",
      description: "Authorize and capture a card payment, then mark the invoice paid.",
      idempotencyKey: "payload.invoiceId",
      payload: {
        type: "object",
        required: ["invoiceId", "amountCents", "currency"],
        properties: {
          invoiceId: { type: "string", pattern: "^inv_[0-9]{4}$" },
          amountCents: { type: "integer", minimum: 1 },
          currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
        },
      },
      success: "{ chargeId: string, capturedAt: DateTime }",
      error: "CardDeclined | GatewayUnavailable",
      annotations: ["SuspendOnFailure"],
    },
    {
      name: "RefundRequest",
      description: "Load the order, wait for manager approval (DurableDeferred), issue the refund, notify the customer.",
      idempotencyKey: "payload.orderId",
      payload: {
        type: "object",
        required: ["orderId", "amountCents", "reason"],
        properties: {
          orderId: { type: "string", pattern: "^ord_[0-9]{5}$" },
          amountCents: { type: "integer", minimum: 1 },
          reason: { type: "string", enum: ["damaged", "late", "duplicate", "other"] },
          note: { type: "string", maxLength: 280 },
        },
      },
      success: "{ refundId: string }",
      error: "RefundRejected",
      annotations: [],
    },
    {
      name: "NightlyExport",
      description: "Sleep until quiet hours (DurableClock), query the ledger, write and upload the export.",
      idempotencyKey: "payload.date + payload.format",
      payload: {
        type: "object",
        required: ["date", "format"],
        properties: {
          date: { type: "string", format: "date" },
          format: { type: "string", enum: ["csv", "parquet"] },
        },
      },
      success: "{ objectKey: string, rows: number }",
      error: "ExportError",
      annotations: [],
    },
    {
      name: "DunningSequence",
      description: "Remind a customer with an overdue invoice every 3 days, up to 3 rounds.",
      idempotencyKey: "payload.customerId",
      payload: {
        type: "object",
        required: ["customerId", "invoiceId"],
        properties: {
          customerId: { type: "string", pattern: "^cus_[0-9]+$" },
          invoiceId: { type: "string", pattern: "^inv_[0-9]{4}$" },
        },
      },
      success: "{ outcome: 'paid' | 'escalated' }",
      error: "never",
      annotations: [],
    },
  ];

  const ok = (value) => ({ _tag: "Success", value });
  const fail = (error) => ({ _tag: "Failure", cause: { _tag: "Fail", error } });

  // Execution labels: a kymo registration option, derived from the payload at read time.
  //   Kymo.layer({ workflows: [Kymo.workflow(RefundRequest, { label: (p) => `Refund ...` })] })
  // Nothing extra is stored; old executions get labels too. Workflows without one fall back to idempotencyKey.
  const money = (c, cur = "USD") => new Intl.NumberFormat("en", { style: "currency", currency: cur }).format(c / 100);
  const labels = {
    ProvisionWorkspace: (p) => `${p.workspaceId} · ${p.plan} plan · ${p.ownerEmail}`,
    ChargeInvoice: (p) => `Charge ${money(p.amountCents, p.currency)} · ${p.invoiceId}`,
    RefundRequest: (p) => `Refund ${money(p.amountCents)} on ${p.orderId} · ${p.reason}`,
    NightlyExport: (p) => `Ledger export ${p.date} → ${p.format}`,
    // DunningSequence registers no label on purpose: the list falls back to its idempotencyKey
  };
  const labelOf = (workflow, payload) => {
    const f = labels[workflow];
    if (!f || !payload) return null;
    try { const s = f(payload); return /undefined|NaN/.test(s) ? null : s; } catch { return null; }
  };
  const labelSource = (workflow) => (labels[workflow] ? labels[workflow].toString() : null);

  // Activity logs: Effect.log* emitted inside an Activity, captured by kymo's Logger layer
  // (span = Activity name, CurrentAttempt, WorkflowInstance.executionId) into its own table.
  // Keyed `${executionId}/${activity}/${attempt}`.
  const L = (at, level, message, annotations) => ({ at, level, message, ...(annotations ? { annotations } : {}) });
  const logs = {
    "7f3a9c1e04b2d8a6/CreateDatabase/1": [
      L("2026-11-01T14:58:10.251Z", "Info", "provisioning tenant database", { host: "pg-3.internal", plan: "team" }),
      L("2026-11-01T14:58:10.262Z", "Debug", "CREATE DATABASE ws_8f21 TEMPLATE tenant_v14"),
      L("2026-11-01T14:58:13.880Z", "Info", "database ready", { ms: 3618 }),
    ],
    "7f3a9c1e04b2d8a6/SeedDefaults/1": [
      L("2026-11-01T14:58:13.930Z", "Info", "seeding defaults", { tables: 14 }),
      L("2026-11-01T14:58:15.040Z", "Info", "inserted 212 rows"),
    ],
    "c41d0e7b9a2f3518/AuthorizeCard/1": [
      L("2026-11-01T14:58:15.120Z", "Info", "authorizing card", { invoiceId: "inv_5531", amountCents: 4900 }),
      L("2026-11-01T14:58:16.010Z", "Info", "authorized", { authorizationId: "auth_Q8x2", last4: "4242" }),
    ],
    "c41d0e7b9a2f3518/CapturePayment/1": [
      L("2026-11-01T14:58:16.040Z", "Info", "capturing payment", { authorizationId: "auth_Q8x2" }),
      L("2026-11-01T14:58:31.040Z", "Warning", "gateway slow, still waiting", { elapsedMs: 15000 }),
      L("2026-11-01T14:58:46.020Z", "Error", "gateway timed out", { after: "30s", gateway: "stripe-eu" }),
    ],
    "c41d0e7b9a2f3518/CapturePayment/2": [
      L("2026-11-01T14:58:48.110Z", "Info", "capturing payment", { authorizationId: "auth_Q8x2" }),
      L("2026-11-01T14:58:48.115Z", "Debug", "gateway p99 latency 28.4s over the last 5m"),
    ],
    "e2b81f6c3d907a45/LoadOrder/1": [
      L("2026-11-01T13:12:04.600Z", "Debug", "SELECT * FROM orders WHERE id = 'ord_10442'"),
      L("2026-11-01T13:12:04.905Z", "Info", "order loaded", { customer: "cus_2210", totalCents: 12900, items: 3 }),
    ],
    "e2b81f6c3d907a45/NotifyApprover/1": [
      L("2026-11-01T13:12:05.370Z", "Info", "approval requested in #refunds", { approvers: "dana, li" }),
    ],
    "b6f0c38e2a1d7954/AuthorizeCard/1": [
      L("2026-11-01T11:40:23.100Z", "Info", "authorized", { authorizationId: "auth_M1v7", last4: "0005" }),
    ],
    "b6f0c38e2a1d7954/CapturePayment/1": [
      L("2026-11-01T11:40:23.140Z", "Info", "capturing payment", { amountCents: 29900, currency: "EUR" }),
      L("2026-11-01T11:40:23.890Z", "Error", "gateway answered 503 Service Unavailable", { retryAfter: "2s", requestId: "req_8Kd1" }),
    ],
    "b6f0c38e2a1d7954/CapturePayment/2": [
      L("2026-11-01T11:40:25.920Z", "Info", "capturing payment", { amountCents: 29900, currency: "EUR" }),
      L("2026-11-01T11:40:26.630Z", "Error", "gateway answered 503 Service Unavailable", { retryAfter: "4s", requestId: "req_8Kd7" }),
    ],
    "b6f0c38e2a1d7954/CapturePayment/3": [
      L("2026-11-01T11:40:30.660Z", "Info", "capturing payment", { amountCents: 29900, currency: "EUR" }),
      L("2026-11-01T11:40:31.190Z", "Error", "gateway answered 503 Service Unavailable", { retryAfter: "8s", requestId: "req_8KdQ" }),
      L("2026-11-01T11:40:31.200Z", "Warning", "retry budget exhausted (3 attempts)"),
    ],
    "91e4d7a02c5b6f3d/AuthorizeCard/1": [
      L("2026-11-01T10:05:11.040Z", "Info", "authorizing card", { invoiceId: "inv_5528", amountCents: 1500 }),
      L("2026-11-01T10:05:12.460Z", "Warning", "card declined", { code: "insufficient_funds", last4: "9995" }),
    ],
    "3d8a6b1f0e7c2945/LoadOrder/1": [
      L("2026-11-01T09:47:30.730Z", "Debug", "SELECT * FROM orders WHERE id = 'ord_10437'"),
      L("2026-11-01T09:47:31.030Z", "Warning", "order not found, returning null", { orderId: "ord_10437" }),
    ],
    "6e2c9f4a8b0d1735/SeedDefaults/1": [
      L("2026-11-01T08:20:04.140Z", "Info", "seeding defaults", { tables: 31 }),
      L("2026-11-01T08:22:10.500Z", "Warning", "slow insert into audit_events", { rows: 180000, ms: 126300 }),
    ],
    "a05f7d3c9e18b246/SendWelcomeEmail/1": [
      L("2026-11-01T07:02:52.910Z", "Info", "welcome mail queued", { to: "jun@paperkite.co", messageId: "msg_w19" }),
    ],
    "f17b2e8d4c06a93e/QueryLedger/1": [
      L("2026-11-01T02:00:00.420Z", "Info", "querying ledger", { date: "2026-10-31" }),
      L("2026-11-01T02:00:58.000Z", "Debug", "scanned 60,000 rows"),
      L("2026-11-01T02:01:55.000Z", "Debug", "scanned 120,000 rows"),
      L("2026-11-01T02:02:51.010Z", "Info", "query done", { rows: 184212 }),
    ],
    "f17b2e8d4c06a93e/UploadToBucket/1": [
      L("2026-11-01T02:03:09.720Z", "Info", "uploading", { bucket: "ledgerly-exports", bytes: 41877504 }),
      L("2026-11-01T02:03:18.640Z", "Info", "upload complete", { objectKey: "exports/2026/10/31/ledger.parquet" }),
    ],
    "48c0a6e9f2d71b53/IssueRefund/1": [
      L("2026-10-31T17:41:31.910Z", "Info", "issuing refund", { approver: "dana@ledgerly.io", amountCents: 5400 }),
      L("2026-10-31T17:41:32.870Z", "Info", "refund issued", { refundId: "re_7Hd1" }),
    ],
  };

  // status: running | suspended | succeeded | failed | interrupted
  // suspended.reason: "deferred" | "clock" | "failure" (SuspendOnFailure) | "child"
  // activities: one row per attempt, in journal order. status: success | failure | running
  // waits: DurableDeferred / DurableClock journal entries
  const executions = [
    {
      id: "7f3a9c1e04b2d8a6", workflow: "ProvisionWorkspace", status: "running",
      payload: { workspaceId: "ws_8f21", plan: "team", ownerEmail: "mara@northwind.dev" },
      idempotencyKey: "ws_8f21", parent: null, children: ["c41d0e7b9a2f3518"],
      startedAt: "2026-11-01T14:58:10.214Z", endedAt: null,
      activities: [
        { name: "CreateDatabase", attempt: 1, startedAt: "2026-11-01T14:58:10.240Z", endedAt: "2026-11-01T14:58:13.902Z", status: "success", exit: ok({ databaseUrl: "postgres://pg-3.internal/ws_8f21" }) },
        { name: "SeedDefaults", attempt: 1, startedAt: "2026-11-01T14:58:13.915Z", endedAt: "2026-11-01T14:58:15.051Z", status: "success", exit: ok({ tables: 14, rows: 212 }) },
      ],
      waits: [],
      childCalls: [{ name: "ChargeFirstInvoice", execution: "c41d0e7b9a2f3518", startedAt: "2026-11-01T14:58:15.070Z" }],
      compensations: [{ activity: "CreateDatabase", name: "DropDatabase", registered: true, ran: false }],
      result: null,
    },
    {
      id: "c41d0e7b9a2f3518", workflow: "ChargeInvoice", status: "running",
      payload: { invoiceId: "inv_5531", amountCents: 4900, currency: "USD" },
      idempotencyKey: "inv_5531", parent: "7f3a9c1e04b2d8a6", children: [],
      startedAt: "2026-11-01T14:58:15.081Z", endedAt: null,
      activities: [
        { name: "AuthorizeCard", attempt: 1, startedAt: "2026-11-01T14:58:15.100Z", endedAt: "2026-11-01T14:58:16.020Z", status: "success", exit: ok({ authorizationId: "auth_Q8x2", last4: "4242" }) },
        { name: "CapturePayment", attempt: 1, startedAt: "2026-11-01T14:58:16.031Z", endedAt: "2026-11-01T14:58:46.031Z", status: "failure", exit: fail({ _tag: "GatewayTimeout", after: "30s" }) },
        { name: "CapturePayment", attempt: 2, startedAt: "2026-11-01T14:58:48.100Z", endedAt: null, status: "running", exit: null },
      ],
      waits: [], childCalls: [], compensations: [], result: null,
    },
    {
      id: "e2b81f6c3d907a45", workflow: "RefundRequest", status: "suspended", suspendedReason: "deferred",
      payload: { orderId: "ord_10442", amountCents: 12900, reason: "damaged", note: "Box arrived crushed, photos attached in ticket #8812" },
      idempotencyKey: "ord_10442", parent: null, children: [],
      startedAt: "2026-11-01T13:12:04.551Z", endedAt: null,
      activities: [
        { name: "LoadOrder", attempt: 1, startedAt: "2026-11-01T13:12:04.580Z", endedAt: "2026-11-01T13:12:04.912Z", status: "success", exit: ok({ orderId: "ord_10442", customer: "cus_2210", totalCents: 12900 }) },
        { name: "NotifyApprover", attempt: 1, startedAt: "2026-11-01T13:12:04.920Z", endedAt: "2026-11-01T13:12:05.377Z", status: "success", exit: ok({ channel: "#refunds", messageTs: "1761995525.0021" }) },
      ],
      waits: [{ kind: "deferred", name: "ManagerApproval", since: "2026-11-01T13:12:05.390Z", status: "waiting", schema: "{ approved: boolean, approver: string }" }],
      childCalls: [], compensations: [], result: null,
    },
    {
      id: "0a9d5e3f71c2b864", workflow: "NightlyExport", status: "suspended", suspendedReason: "clock",
      payload: { date: "2026-11-01", format: "parquet" },
      idempotencyKey: "2026-11-01:parquet", parent: null, children: [],
      startedAt: "2026-11-01T00:00:01.004Z", endedAt: null,
      activities: [],
      waits: [{ kind: "clock", name: "WaitForQuietHours", since: "2026-11-01T00:00:01.020Z", wakeAt: "2026-11-02T02:00:00.000Z", status: "waiting" }],
      childCalls: [], compensations: [], result: null,
    },
    {
      id: "5c7e2a90d1f4b3e8", workflow: "DunningSequence", status: "suspended", suspendedReason: "clock",
      payload: { customerId: "cus_77", invoiceId: "inv_5479" },
      idempotencyKey: "cus_77", parent: null, children: [],
      startedAt: "2026-10-28T09:30:00.120Z", endedAt: null,
      activities: [
        { name: "SendReminder-1", attempt: 1, startedAt: "2026-10-28T09:30:00.140Z", endedAt: "2026-10-28T09:30:01.002Z", status: "success", exit: ok({ messageId: "msg_a81" }) },
        { name: "CheckPaid-1", attempt: 1, startedAt: "2026-10-31T09:30:00.210Z", endedAt: "2026-10-31T09:30:00.480Z", status: "success", exit: ok({ paid: false }) },
        { name: "SendReminder-2", attempt: 1, startedAt: "2026-10-31T09:30:00.490Z", endedAt: "2026-10-31T09:30:01.310Z", status: "success", exit: ok({ messageId: "msg_b02" }) },
      ],
      waits: [
        { kind: "clock", name: "wait-round-1", since: "2026-10-28T09:30:01.010Z", wakeAt: "2026-10-31T09:30:00.000Z", status: "done" },
        { kind: "clock", name: "wait-round-2", since: "2026-10-31T09:30:01.320Z", wakeAt: "2026-11-03T09:30:00.000Z", status: "waiting" },
      ],
      childCalls: [], compensations: [], result: null,
    },
    {
      id: "b6f0c38e2a1d7954", workflow: "ChargeInvoice", status: "suspended", suspendedReason: "failure",
      payload: { invoiceId: "inv_5527", amountCents: 29900, currency: "EUR" },
      idempotencyKey: "inv_5527", parent: null, children: [],
      startedAt: "2026-11-01T11:40:22.300Z", endedAt: null,
      activities: [
        { name: "AuthorizeCard", attempt: 1, startedAt: "2026-11-01T11:40:22.330Z", endedAt: "2026-11-01T11:40:23.115Z", status: "success", exit: ok({ authorizationId: "auth_M1v7", last4: "0005" }) },
        { name: "CapturePayment", attempt: 1, startedAt: "2026-11-01T11:40:23.130Z", endedAt: "2026-11-01T11:40:23.902Z", status: "failure", exit: fail({ _tag: "GatewayUnavailable", status: 503 }) },
        { name: "CapturePayment", attempt: 2, startedAt: "2026-11-01T11:40:25.910Z", endedAt: "2026-11-01T11:40:26.640Z", status: "failure", exit: fail({ _tag: "GatewayUnavailable", status: 503 }) },
        { name: "CapturePayment", attempt: 3, startedAt: "2026-11-01T11:40:30.650Z", endedAt: "2026-11-01T11:40:31.207Z", status: "failure", exit: fail({ _tag: "GatewayUnavailable", status: 503 }) },
      ],
      waits: [], childCalls: [], compensations: [],
      result: { _tag: "Suspended", cause: { _tag: "Fail", error: { _tag: "GatewayUnavailable", status: 503 } } },
    },
    {
      id: "91e4d7a02c5b6f3d", workflow: "ChargeInvoice", status: "failed",
      payload: { invoiceId: "inv_5528", amountCents: 1500, currency: "USD" },
      idempotencyKey: "inv_5528", parent: null, children: [],
      startedAt: "2026-11-01T10:05:11.010Z", endedAt: "2026-11-01T10:05:12.480Z",
      activities: [
        { name: "AuthorizeCard", attempt: 1, startedAt: "2026-11-01T10:05:11.030Z", endedAt: "2026-11-01T10:05:12.470Z", status: "failure", exit: fail({ _tag: "CardDeclined", code: "insufficient_funds" }) },
      ],
      waits: [], childCalls: [], compensations: [],
      result: { _tag: "Complete", exit: { _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "CardDeclined", code: "insufficient_funds" } } } },
    },
    {
      id: "3d8a6b1f0e7c2945", workflow: "RefundRequest", status: "failed",
      payload: { orderId: "ord_10437", amountCents: 2300, reason: "late" },
      idempotencyKey: "ord_10437", parent: null, children: [],
      startedAt: "2026-11-01T09:47:30.700Z", endedAt: "2026-11-01T09:47:31.044Z",
      activities: [
        { name: "LoadOrder", attempt: 1, startedAt: "2026-11-01T09:47:30.720Z", endedAt: "2026-11-01T09:47:31.040Z", status: "success", exit: ok(null) },
      ],
      waits: [], childCalls: [], compensations: [],
      result: { _tag: "Complete", exit: { _tag: "Failure", cause: { _tag: "Die", defect: {
        name: "TypeError",
        message: "Cannot read properties of null (reading 'totalCents')",
        stack: "TypeError: Cannot read properties of null (reading 'totalCents')\n    at RefundRequest.run (src/workflows/refund.ts:41:38)\n    at Effect.gen (src/workflows/refund.ts:36:5)",
      } } } },
    },
    {
      id: "6e2c9f4a8b0d1735", workflow: "ProvisionWorkspace", status: "interrupted",
      payload: { workspaceId: "ws_7c02", plan: "enterprise", ownerEmail: "ops@helio.io" },
      idempotencyKey: "ws_7c02", parent: null, children: [],
      startedAt: "2026-11-01T08:20:00.000Z", endedAt: "2026-11-01T08:24:41.882Z",
      activities: [
        { name: "CreateDatabase", attempt: 1, startedAt: "2026-11-01T08:20:00.030Z", endedAt: "2026-11-01T08:20:04.120Z", status: "success", exit: ok({ databaseUrl: "postgres://pg-1.internal/ws_7c02" }) },
        { name: "SeedDefaults", attempt: 1, startedAt: "2026-11-01T08:20:04.130Z", endedAt: "2026-11-01T08:24:41.700Z", status: "failure", exit: { _tag: "Failure", cause: { _tag: "Interrupt", fiberId: "#4127" } } },
      ],
      waits: [], childCalls: [],
      compensations: [{ activity: "CreateDatabase", name: "DropDatabase", registered: true, ran: true, at: "2026-11-01T08:24:41.860Z", exit: ok({ dropped: "ws_7c02" }) }],
      interruptedBy: "kymo interrupt 6e2c9f4a8b0d1735 (ui · 127.0.0.1)",
      result: { _tag: "Complete", exit: { _tag: "Failure", cause: { _tag: "Interrupt", fiberId: "#4127" } } },
    },
    {
      id: "a05f7d3c9e18b246", workflow: "ProvisionWorkspace", status: "succeeded",
      payload: { workspaceId: "ws_6a90", plan: "free", ownerEmail: "jun@paperkite.co" },
      idempotencyKey: "ws_6a90", parent: null, children: ["d8b3e6f19c4a0725"],
      startedAt: "2026-11-01T07:02:41.500Z", endedAt: "2026-11-01T07:02:52.931Z",
      activities: [
        { name: "CreateDatabase", attempt: 1, startedAt: "2026-11-01T07:02:41.520Z", endedAt: "2026-11-01T07:02:45.004Z", status: "success", exit: ok({ databaseUrl: "postgres://pg-2.internal/ws_6a90" }) },
        { name: "SeedDefaults", attempt: 1, startedAt: "2026-11-01T07:02:45.010Z", endedAt: "2026-11-01T07:02:46.240Z", status: "success", exit: ok({ tables: 14, rows: 212 }) },
        { name: "SendWelcomeEmail", attempt: 1, startedAt: "2026-11-01T07:02:52.400Z", endedAt: "2026-11-01T07:02:52.920Z", status: "success", exit: ok({ messageId: "msg_w19" }) },
      ],
      waits: [],
      childCalls: [{ name: "ChargeFirstInvoice", execution: "d8b3e6f19c4a0725", startedAt: "2026-11-01T07:02:46.250Z", endedAt: "2026-11-01T07:02:52.390Z" }],
      compensations: [{ activity: "CreateDatabase", name: "DropDatabase", registered: true, ran: false }],
      result: { _tag: "Complete", exit: ok({ databaseUrl: "postgres://pg-2.internal/ws_6a90", invoiceId: "inv_5520" }) },
    },
    {
      id: "d8b3e6f19c4a0725", workflow: "ChargeInvoice", status: "succeeded",
      payload: { invoiceId: "inv_5520", amountCents: 0, currency: "USD" },
      idempotencyKey: "inv_5520", parent: "a05f7d3c9e18b246", children: [],
      startedAt: "2026-11-01T07:02:46.260Z", endedAt: "2026-11-01T07:02:52.380Z",
      activities: [
        { name: "AuthorizeCard", attempt: 1, startedAt: "2026-11-01T07:02:46.280Z", endedAt: "2026-11-01T07:02:47.100Z", status: "success", exit: ok({ authorizationId: "auth_free", last4: null }) },
        { name: "CapturePayment", attempt: 1, startedAt: "2026-11-01T07:02:47.110Z", endedAt: "2026-11-01T07:02:51.900Z", status: "success", exit: ok({ chargeId: "ch_3Pz9", capturedAt: "2026-11-01T07:02:51.890Z" }) },
        { name: "MarkInvoicePaid", attempt: 1, startedAt: "2026-11-01T07:02:51.910Z", endedAt: "2026-11-01T07:02:52.370Z", status: "success", exit: ok({ invoiceId: "inv_5520", status: "paid" }) },
      ],
      waits: [], childCalls: [], compensations: [],
      result: { _tag: "Complete", exit: ok({ chargeId: "ch_3Pz9", capturedAt: "2026-11-01T07:02:51.890Z" }) },
    },
    {
      id: "f17b2e8d4c06a93e", workflow: "NightlyExport", status: "succeeded",
      payload: { date: "2026-10-31", format: "parquet" },
      idempotencyKey: "2026-10-31:parquet", parent: null, children: [],
      startedAt: "2026-10-31T00:00:01.002Z", endedAt: "2026-11-01T02:03:18.664Z",
      activities: [
        { name: "QueryLedger", attempt: 1, startedAt: "2026-11-01T02:00:00.410Z", endedAt: "2026-11-01T02:02:51.020Z", status: "success", exit: ok({ rows: 184212 }) },
        { name: "WriteFile", attempt: 1, startedAt: "2026-11-01T02:02:51.030Z", endedAt: "2026-11-01T02:03:09.700Z", status: "success", exit: ok({ path: "/tmp/ledger-2026-10-31.parquet", bytes: 41877504 }) },
        { name: "UploadToBucket", attempt: 1, startedAt: "2026-11-01T02:03:09.710Z", endedAt: "2026-11-01T02:03:18.650Z", status: "success", exit: ok({ objectKey: "exports/2026/10/31/ledger.parquet" }) },
      ],
      waits: [{ kind: "clock", name: "WaitForQuietHours", since: "2026-10-31T00:00:01.010Z", wakeAt: "2026-11-01T02:00:00.000Z", status: "done" }],
      childCalls: [], compensations: [],
      result: { _tag: "Complete", exit: ok({ objectKey: "exports/2026/10/31/ledger.parquet", rows: 184212 }) },
    },
    {
      id: "48c0a6e9f2d71b53", workflow: "RefundRequest", status: "succeeded",
      payload: { orderId: "ord_10431", amountCents: 5400, reason: "duplicate" },
      idempotencyKey: "ord_10431", parent: null, children: [],
      startedAt: "2026-10-31T16:20:09.800Z", endedAt: "2026-10-31T17:41:33.290Z",
      activities: [
        { name: "LoadOrder", attempt: 1, startedAt: "2026-10-31T16:20:09.820Z", endedAt: "2026-10-31T16:20:10.110Z", status: "success", exit: ok({ orderId: "ord_10431", customer: "cus_1984", totalCents: 5400 }) },
        { name: "NotifyApprover", attempt: 1, startedAt: "2026-10-31T16:20:10.120Z", endedAt: "2026-10-31T16:20:10.540Z", status: "success", exit: ok({ channel: "#refunds", messageTs: "1761927610.0007" }) },
        { name: "IssueRefund", attempt: 1, startedAt: "2026-10-31T17:41:31.900Z", endedAt: "2026-10-31T17:41:32.880Z", status: "success", exit: ok({ refundId: "re_7Hd1" }) },
        { name: "NotifyCustomer", attempt: 1, startedAt: "2026-10-31T17:41:32.890Z", endedAt: "2026-10-31T17:41:33.280Z", status: "success", exit: ok({ messageId: "msg_r44" }) },
      ],
      waits: [{ kind: "deferred", name: "ManagerApproval", since: "2026-10-31T16:20:10.550Z", status: "done", doneAt: "2026-10-31T17:41:31.880Z", exit: ok({ approved: true, approver: "dana@ledgerly.io" }) }],
      childCalls: [], compensations: [],
      result: { _tag: "Complete", exit: ok({ refundId: "re_7Hd1" }) },
    },
  ];

  executions.forEach((e) => e.activities.forEach((a) => { a.logs = logs[`${e.id}/${a.name}/${a.attempt}`] || []; }));

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const state = { server: clone(server), workflows: clone(workflows), executions: clone(executions) };
  state.workflows.forEach((w) => { w.label = labelSource(w.name); });
  const byId = (id) => state.executions.find((e) => e.id === id);
  const hex = () => Array.from({ length: 16 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  const keyOf = (wf, p) => {
    const w = state.workflows.find((x) => x.name === wf);
    if (!w) return null;
    if (wf === "NightlyExport") return `${p.date}:${p.format}`;
    const field = w.idempotencyKey.replace("payload.", "");
    return p[field];
  };

  // Simulated HTTP API. Each call resolves after a short latency; set KYMO.api.fail = true
  // to make the next call reject (prototypes should design the error state).
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = {
    fail: false,
    latency: 450,
    async call(fn) {
      await delay(api.latency);
      if (api.fail) { api.fail = false; throw { error: "server_unreachable", message: `connect ECONNREFUSED ${state.server.url}` }; }
      return fn();
    },
    listExecutions: (filter = {}) => api.call(() => state.executions.filter((e) =>
      (!filter.workflow || e.workflow === filter.workflow) && (!filter.status || e.status === filter.status))),
    getExecution: (id) => api.call(() => { const e = byId(id); if (!e) throw { error: "not_found", message: `no execution ${id}` }; return e; }),
    // Effect semantics: executionId derives from idempotencyKey; same key => existing execution is returned, not re-run.
    execute: (workflow, payload, { discard = false } = {}) => api.call(() => {
      const key = keyOf(workflow, payload);
      const existing = state.executions.find((e) => e.workflow === workflow && e.idempotencyKey === key);
      if (existing) return { executionId: existing.id, deduplicated: true, discard };
      const e = { id: hex(), workflow, status: "running", payload, idempotencyKey: key, parent: null, children: [],
        startedAt: new Date().toISOString(), endedAt: null, activities: [], waits: [], childCalls: [], compensations: [], result: null };
      state.executions.unshift(e);
      return { executionId: e.id, deduplicated: false, discard };
    }),
    resume: (id) => api.call(() => {
      const e = byId(id);
      if (!e || e.status !== "suspended") throw { error: "not_suspended", message: `execution ${id} is ${e ? e.status : "missing"}; only suspended executions can be resumed` };
      e.status = "running"; delete e.suspendedReason; e.result = null;
      return { executionId: id, status: "running" };
    }),
    // interrupt is terminal and runs registered compensations in reverse order.
    interrupt: (id) => api.call(() => {
      const e = byId(id);
      if (!e || !["running", "suspended"].includes(e.status)) throw { error: "not_interruptible", message: `execution ${id} is ${e ? e.status : "missing"}` };
      const at = new Date().toISOString();
      e.status = "interrupted"; e.endedAt = at; delete e.suspendedReason;
      e.compensations.forEach((c) => { c.ran = true; c.at = at; c.exit = { _tag: "Success", value: null }; });
      e.result = { _tag: "Complete", exit: { _tag: "Failure", cause: { _tag: "Interrupt", fiberId: "#" + Math.floor(Math.random() * 9000 + 1000) } } };
      e.children.forEach((c) => { const ch = byId(c); if (ch && ["running", "suspended"].includes(ch.status)) { ch.status = "interrupted"; ch.endedAt = at; } });
      return { executionId: id, status: "interrupted" };
    }),
  };

  // AXI CLI equivalents for every UI operation (show these next to actions)
  const cli = {
    home: () => "kymo",
    list: (f = {}) => ["kymo executions", f.workflow && `--workflow ${f.workflow}`, f.status && `--status ${f.status}`].filter(Boolean).join(" "),
    show: (id) => `kymo execution ${id}`,
    execute: (wf, discard) => `kymo execute ${wf} --payload-file payload.json${discard ? " --discard" : ""}`,
    resume: (id) => `kymo resume ${id}`,
    interrupt: (id) => `kymo interrupt ${id}`,
  };

  window.KYMO = { NOW, state, api, cli, labelOf, initial: { server, workflows, executions } };
})();
