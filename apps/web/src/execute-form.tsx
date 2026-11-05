import * as Option from "effect/Option";
import type { WorkflowList } from "kymo/api";
import { useRef, type KeyboardEvent } from "react";
import { Alert } from "./action-alert.tsx";
import { EscapeCancels } from "./escape-cancels.tsx";
import { executeHint, type Draft, type ExecuteState } from "./execute.ts";
import { Note } from "./inspector.tsx";
import { Button, Kbd, Spinner } from "./ui.tsx";
import { useMountEffect } from "./use-mount-effect.ts";

const field =
  "w-full rounded-lg bg-sunk px-[11px] font-mono text-[12.5px] text-fg transition-shadow duration-140 ease-g placeholder:text-fg-4 focus-visible:outline-0";
const calm =
  "inset-ring inset-ring-line hover:inset-ring-line-strong focus-visible:inset-ring-fg-3";
const invalid = "inset-ring inset-ring-fail/70 focus-visible:inset-ring-fail";
const caption = "text-[12.5px]/[1.3] font-medium";

export const ExecuteForm = ({
  workflows,
  workflow,
  draft,
  state,
  rootFlag,
  onWorkflow,
  onDraft,
  onSubmit,
  onCancel,
  onDismiss,
}: {
  workflows: WorkflowList["workflows"];
  workflow: string;
  draft: Draft;
  state: ExecuteState;
  rootFlag: string | undefined;
  onWorkflow: (workflow: string) => void;
  onDraft: (draft: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) => {
  const payload = useRef<HTMLTextAreaElement>(null);
  useMountEffect(() => payload.current?.focus());
  const busy = state._tag === "Submitting";
  const registered = workflows.find((candidate) => candidate.name === workflow);
  const names = workflows.map((candidate) => candidate.name);
  const error = state._tag === "Failed" ? state.error : undefined;
  const issue =
    state._tag === "NotJson"
      ? `Not JSON: ${state.message}`
      : error?._tag === "InvalidPayload"
        ? error.issue
        : undefined;
  const expected =
    error?._tag === "InvalidPayload" && error.expected !== undefined
      ? error.expected
      : registered === undefined
        ? undefined
        : Option.getOrUndefined(registered.expected);
  const submitOnModEnter = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    onSubmit();
  };
  return (
    <article aria-labelledby="execute-heading" className="max-w-[680px] px-6 pt-[18px] pb-8">
      <EscapeCancels onCancel={onCancel} />
      <div className="text-[12.5px]/[1.3] text-fg-3">Execute</div>
      <h3
        id="execute-heading"
        className="mt-2.5 text-[19px]/[1.25] font-medium tracking-[-0.018em] text-balance wrap-anywhere"
      >
        {workflow}
      </h3>
      <div className="mt-[18px] grid gap-[18px]">
        <div className="grid gap-1.5">
          <label htmlFor="execute-workflow" className={caption}>
            Workflow
          </label>
          <select
            id="execute-workflow"
            value={workflow}
            onChange={(event) => onWorkflow(event.target.value)}
            className={`${field} h-8 ${calm}`}
          >
            {(registered === undefined ? [workflow, ...names] : names).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="execute-payload" className={caption}>
            Payload (JSON)
          </label>
          <textarea
            ref={payload}
            id="execute-payload"
            value={draft.payload}
            onChange={(event) => onDraft({ ...draft, payload: event.target.value })}
            onKeyDown={submitOnModEnter}
            spellCheck={false}
            aria-invalid={issue !== undefined}
            aria-describedby="execute-payload-hint"
            className={`${field} min-h-[120px] resize-y py-[9px] leading-normal ${issue === undefined ? calm : invalid}`}
          />
          <div
            id="execute-payload-hint"
            className="min-h-[15px] font-mono text-[11.5px]/[1.35] text-fg-4"
          >
            {issue === undefined ? null : <p className="font-sans text-fail">{issue}</p>}
            {expected === undefined ? null : (
              <p>
                <span className="font-sans">Expected</span>{" "}
                <code className="wrap-anywhere text-fg-2">{expected}</code>
              </p>
            )}
          </div>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="execute-label" className={caption}>
            Label <span className="font-normal text-fg-3">(optional)</span>
          </label>
          <input
            id="execute-label"
            type="text"
            autoComplete="off"
            value={draft.label}
            onChange={(event) => onDraft({ ...draft, label: event.target.value })}
            onKeyDown={submitOnModEnter}
            aria-describedby="execute-label-hint"
            className={`${field} h-8 font-sans ${calm}`}
          />
          <p id="execute-label-hint" className="text-[11.5px]/[1.35] text-fg-4">
            Names a new execution. One that already exists keeps its label.
          </p>
        </div>
      </div>
      <Note>
        From the CLI:{" "}
        <code className="font-mono text-[11.5px] wrap-anywhere text-fg">
          {executeHint(rootFlag, workflow, draft.payload, draft.label)}
        </code>
      </Note>
      {error?._tag === "WorkflowNotFound" ? (
        <Alert tone="fail" code="error: workflow_not_found" onDismiss={onDismiss}>
          No workflow named{" "}
          <code className="font-mono text-[11.5px] text-fg">{error.workflow}</code>.{" "}
          {error.registered.length === 0
            ? "No workflow is registered."
            : `Registered: ${error.registered.join(", ")}.`}
        </Alert>
      ) : error?._tag === "Unreachable" ? (
        <Alert tone="fail" code="error: unreachable" onDismiss={onDismiss}>
          The daemon did not answer: {error.message}. Executing again is safe because the same
          payload resolves to the same execution.
        </Alert>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line-soft pt-3.5">
        <Button onClick={onCancel}>
          Cancel <Kbd>esc</Kbd>
        </Button>
        <Button variant="primary" disabled={busy} onClick={onSubmit}>
          {busy ? (
            <>
              <Spinner />
              Executing…
            </>
          ) : (
            <>
              Execute <Kbd>⌘↵</Kbd>
            </>
          )}
        </Button>
      </div>
    </article>
  );
};
