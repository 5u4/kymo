import { statusName } from "kymo/api";
import type { ReactNode } from "react";
import type { ActionError, Actions, Target } from "./actions.ts";
import { shortId } from "./executions-view.ts";
import { Button } from "./ui.tsx";

const code = "font-mono text-[11.5px] text-fg";

const errorCopy = (error: ActionError): { code: string; body: ReactNode } => {
  switch (error._tag) {
    case "ActionNotAllowed":
      return {
        code: "error: not_allowed",
        body: `Can't ${error.action} a ${statusName(error.status)} execution.`,
      };
    case "NotWaiting":
      return {
        code: "error: not_waiting",
        body: (
          <>
            <span className="font-mono">{shortId(error.id)}</span> is not waiting on{" "}
            <code className={code}>{error.deferred}</code>.{" "}
            {error.waiting.length === 0
              ? "It waits on no deferred."
              : `It waits on ${error.waiting.join(", ")}.`}
          </>
        ),
      };
    case "InvalidValue":
      return {
        code: "error: invalid_value",
        body: (
          <>
            {error.issue}
            {error.expected === undefined ? null : (
              <>
                {" "}
                Expected <code className={`${code} wrap-anywhere`}>{error.expected}</code>
              </>
            )}
          </>
        ),
      };
    case "ExecutionNotFound":
      return { code: "error: not_found", body: error.message };
    case "AmbiguousExecutionId":
      return { code: "error: ambiguous_id", body: error.message };
    case "WorkflowNotFound":
      return { code: "error: workflow_not_found", body: error.message };
    case "Unreachable":
      return {
        code: "error: unreachable",
        body: `The daemon did not answer: ${error.message}`,
      };
  }
};

const subject = (target: Target): ReactNode =>
  target.action === "complete" ? (
    <>
      value for <code className={code}>{target.name}</code>
    </>
  ) : (
    target.action
  );

const Alert = ({
  tone,
  code: label,
  children,
  onDismiss,
}: {
  tone: "fail" | "sus";
  code: string | undefined;
  children: ReactNode;
  onDismiss: () => void;
}) => (
  <div
    role={tone === "fail" ? "alert" : "status"}
    className={`mt-3.5 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3.5 gap-y-1.5 rounded-[10px] px-3.5 py-3 ${tone === "fail" ? "bg-[color-mix(in_oklch,var(--color-fail)_7%,var(--color-panel))] inset-ring inset-ring-fail/35" : "bg-[color-mix(in_oklch,var(--color-sus)_6%,var(--color-panel))] inset-ring inset-ring-sus/35"}`}
  >
    {label === undefined ? null : (
      <div
        className={`font-mono text-[12.5px]/[1.3] font-medium ${tone === "fail" ? "text-fail" : "text-sus"}`}
      >
        {label}
      </div>
    )}
    <div className="col-start-1 text-[12.5px]/[1.5] text-pretty text-fg-2">{children}</div>
    <div className="col-start-2 row-span-2 row-start-1 flex gap-1.5">
      <Button variant="ghost" onClick={onDismiss}>
        dismiss
      </Button>
    </div>
  </div>
);

export const ActionAlert = ({
  actions,
  shows,
}: {
  actions: Actions;
  shows: (target: Target) => boolean;
}) => {
  const { phase } = actions;
  if (phase._tag === "Failed" && shows(phase.target)) {
    const failure = errorCopy(phase.error);
    return (
      <Alert tone="fail" code={failure.code} onDismiss={actions.dismiss}>
        {phase.target.action === "complete" ? (
          <>
            Completing <code className={code}>{phase.target.name}</code> failed.{" "}
          </>
        ) : null}
        {failure.body}
      </Alert>
    );
  }
  if (phase._tag === "NoChange" && shows(phase.target)) {
    return (
      <Alert tone="sus" code={undefined} onDismiss={actions.dismiss}>
        No change 10 s after the {subject(phase.target)} was accepted. A running activity may still
        be finishing.
      </Alert>
    );
  }
  return null;
};
