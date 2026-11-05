import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { statusName } from "kymo/api";
import { kymoCommand } from "kymo/shell";
import { useRef, type ReactNode } from "react";
import {
  ago,
  lastEntry,
  refine,
  shortId,
  statuses,
  suspendTag,
  title,
  type ExecutionsView,
  type Filter,
  type ListState,
  type Row,
} from "./executions-view.ts";
import { ParentIcon, StatusGlyph, StatusIcon } from "./glyphs.tsx";
import { statusColor } from "./status-color.ts";
import { Button, Kbd, Pane, Skeleton } from "./ui.tsx";
import { useMountEffect } from "./use-mount-effect.ts";

const railLeft = (level: number) => 14 + 7.5 + level * 26;

const Rails = ({ row }: { row: Row }) => {
  const rail = "pointer-events-none absolute border-l border-line-strong";
  return (
    <>
      {row.rails.map((level) => (
        <i
          key={level}
          aria-hidden="true"
          style={{ left: railLeft(level) }}
          className={`${rail} -inset-y-px`}
        />
      ))}
      {row.depth > 0 ? (
        <i
          aria-hidden="true"
          style={{ left: railLeft(row.depth - 1) }}
          className={`${rail} -top-px h-[calc(50%+1px)] w-[15px] rounded-bl-md border-b`}
        />
      ) : null}
      {row.depth > 0 && !row.last ? (
        <i
          aria-hidden="true"
          style={{ left: railLeft(row.depth - 1) }}
          className={`${rail} -inset-y-px`}
        />
      ) : null}
      {row.hasChildren ? (
        <i
          aria-hidden="true"
          style={{ left: railLeft(row.depth) }}
          className={`${rail} top-[calc(50%+11px)] -bottom-px`}
        />
      ) : null}
    </>
  );
};

const ExecutionRow = ({
  row,
  now,
  selected,
}: {
  row: Row;
  now: DateTime.Utc;
  selected: boolean;
}) => {
  const { execution } = row;
  const heading = title(execution);
  const tag = Option.getOrUndefined(suspendTag(execution.status));
  const parent = Option.getOrUndefined(row.parent);
  const status = statusName(execution.status);
  const at = lastEntry(execution);
  return (
    <li>
      <Link
        to="/"
        search={(prev) => refine(prev, { exec: execution.id })}
        replace
        data-execution={execution.id}
        aria-current={selected ? "page" : undefined}
        style={{ paddingLeft: 14 + row.depth * 26 }}
        className={`relative grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-[3px] border-b border-line-soft pt-2.5 pr-3.5 pb-[11px] transition-colors duration-140 ease-g focus-visible:rounded-none focus-visible:-outline-offset-2 ${selected ? "bg-sel before:absolute before:inset-y-[9px] before:left-0 before:w-0.5 before:rounded-r-xs before:bg-fg" : "hover:bg-hover"}`}
      >
        <Rails row={row} />
        <StatusGlyph status={status} className="row-span-2" />
        <span
          className={`min-w-0 truncate ${heading.labelled ? "text-[13px]/[1.3] font-medium" : "font-mono text-[12.5px]/[1.3] text-fg-2"}`}
        >
          {heading.text}
        </span>
        <time
          dateTime={DateTime.formatIso(at)}
          title="last journal entry"
          className="font-mono text-[11px]/none whitespace-nowrap text-fg-3"
        >
          {ago(now, at)}
        </time>
        <span className="col-span-2 flex min-w-0 items-center gap-2 text-xs/[1.2] text-fg-2">
          <span className="sr-only">{status}</span>
          <span className="flex-none">{execution.workflow}</span>
          <span className="flex-none font-mono text-[11px]/[1.2] text-fg-4">
            {shortId(execution.id)}
          </span>
          {tag === undefined ? null : (
            <span className="inline-flex h-[17px] flex-none items-center rounded-[5px] bg-sus/12 px-1.5 font-mono text-[10.5px]/none font-medium text-sus">
              {tag}
            </span>
          )}
          {parent === undefined ? null : (
            <span
              title={`child of ${parent.id}`}
              className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-[11px]/[1.2] text-fg-3"
            >
              <ParentIcon />
              <span className="sr-only">child of</span>
              {parent.workflow} {shortId(parent.id)}
            </span>
          )}
          {row.depth > 0 ? (
            <span className="sr-only">
              child of {shortId(Option.getOrElse(execution.parentId, () => ""))}
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
};

const Blank = ({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) => (
  <div className="grid max-w-[420px] justify-items-start gap-3 px-6 py-11">
    <span className="text-[15px]/[1.35] font-medium text-balance">{title}</span>
    <p className="text-[12.5px]/[1.55] text-pretty text-fg-3">{children}</p>
    {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
  </div>
);

const ListBody = ({
  list,
  filter,
  now,
  selected,
  rootFlag,
}: {
  list: ListState;
  filter: Filter;
  now: DateTime.Utc;
  selected: string | undefined;
  rootFlag: string | undefined;
}) => {
  const navigate = useNavigate({ from: "/" });
  const command = "font-mono text-fg";
  switch (list._tag) {
    case "Empty":
      return (
        <Blank title="The journal is empty.">
          No workflow has been executed yet. Run{" "}
          <code className={command}>{kymoCommand(rootFlag, "execute <workflow> <payload>")}</code>{" "}
          and the execution appears here the moment the engine journals it.
        </Blank>
      );
    case "Unexecuted":
      return (
        <Blank title={`${list.workflow} has never been executed.`}>
          Nothing in the journal for this workflow yet. Run{" "}
          <code className={command}>
            {kymoCommand(rootFlag, `execute ${list.workflow} <payload>`)}
          </code>{" "}
          and the first execution lands here.
        </Blank>
      );
    case "NoMatch": {
      const what = [filter.status, filter.workflow].filter((part) => part !== undefined).join(" ");
      const q = filter.q?.trim() ?? "";
      return (
        <Blank
          title={`No ${what === "" ? "" : `${what} `}executions${q === "" ? "" : ` match “${q}”`}.`}
          actions={
            <>
              <Button
                onClick={() => void navigate({ search: (prev) => refine({}, { exec: prev.exec }) })}
              >
                Clear filters
              </Button>
              {filter.status === undefined ? null : (
                <Button
                  onClick={() =>
                    void navigate({ search: (prev) => refine(prev, { status: undefined }) })
                  }
                >
                  Any status
                </Button>
              )}
            </>
          }
        >
          The journal holds {list.scopeTotal}{" "}
          {filter.workflow === undefined ? "" : `${filter.workflow} `}
          execution{list.scopeTotal === 1 ? "" : "s"}; none pass this filter.
        </Blank>
      );
    }
    case "Rows":
      return (
        <ul aria-label="Executions">
          {list.rows.map((row) => (
            <ExecutionRow
              key={row.execution.id}
              row={row}
              now={now}
              selected={row.execution.id === selected}
            />
          ))}
        </ul>
      );
  }
};

const sortHint = (
  <span
    title="Newest first, by each execution's most recent journal entry"
    className="font-mono text-[11.5px]/none text-fg-4"
  >
    by last entry ↓
  </span>
);

export const ExecutionsPane = ({
  view,
  filter,
  now,
  selected,
  rootFlag,
}: {
  view: ExecutionsView;
  filter: Filter;
  now: DateTime.Utc;
  selected: string | undefined;
  rootFlag: string | undefined;
}) => {
  const navigate = useNavigate({ from: "/" });
  // Route.useSearch only updates after the async route load, which moves the caret to the end.
  const q = useRouterState({ select: (state) => state.location.search.q });
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLElement>(null);
  useMountEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        search.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        void navigate({ search: (prev) => refine(prev, { exec: undefined }), replace: true });
        return;
      }
      if (
        (event.key !== "j" && event.key !== "k") ||
        (event.target instanceof Element && event.target.closest('[role="tree"]') !== null)
      ) {
        return;
      }
      const rows = [
        ...(list.current?.querySelectorAll<HTMLAnchorElement>("a[data-execution]") ?? []),
      ];
      const current = rows.findIndex((row) => row.getAttribute("aria-current") === "page");
      const next =
        rows[
          current === -1
            ? 0
            : Math.min(rows.length - 1, Math.max(0, current + (event.key === "j" ? 1 : -1)))
        ];
      if (next === undefined) return;
      event.preventDefault();
      next.click();
      next.scrollIntoView({ block: "nearest" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const chips = [
    { status: undefined, label: "all", count: view.scopeTotal },
    ...statuses.map((status) => ({ status, label: status, count: view.statusCounts[status] })),
  ];
  return (
    <Pane
      id="executions-title"
      title="Executions"
      count={view.shown === view.total ? String(view.shown) : `${view.shown} of ${view.total}`}
      aside={sortHint}
      className="bg-canvas"
    >
      <div className="grid flex-none gap-[9px] border-b border-line-soft py-2.5 pr-3 pl-3.5">
        <div className="relative flex items-center">
          <label htmlFor="execution-filter" className="sr-only">
            Filter executions by label, id prefix or idempotencyKey
          </label>
          <input
            ref={search}
            id="execution-filter"
            type="search"
            autoComplete="off"
            spellCheck={false}
            aria-keyshortcuts="/"
            placeholder="filter by label, id prefix or key"
            value={q ?? ""}
            onChange={(event) =>
              void navigate({
                search: (prev) => refine(prev, { q: event.target.value }),
                replace: true,
              })
            }
            className="h-[30px] w-full rounded-[7px] bg-sunk pr-[34px] pl-[11px] font-mono text-[12.5px]/none inset-ring inset-ring-line-soft transition-shadow duration-140 ease-g placeholder:text-fg-4 focus-visible:ring-3 focus-visible:ring-fg/8 focus-visible:inset-ring-fg-3 focus-visible:outline-none"
          />
          <span aria-hidden="true" className="pointer-events-none absolute right-[7px] inline-flex">
            <Kbd>/</Kbd>
          </span>
        </div>
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">Filter by status</legend>
          {chips.map((chip) => {
            const pressed = chip.status === filter.status;
            return (
              <button
                key={chip.label}
                type="button"
                aria-pressed={pressed}
                onClick={() =>
                  void navigate({ search: (prev) => refine(prev, { status: chip.status }) })
                }
                className={`inline-flex h-6 flex-none items-center gap-[5px] rounded-[7px] px-[7px] font-mono text-[11.5px]/none transition-[background-color,color,box-shadow] duration-140 ease-g active:scale-96 ${pressed ? "bg-sel text-fg inset-ring inset-ring-line" : "text-fg-3 hover:bg-hover hover:text-fg"}`}
              >
                {chip.status === undefined ? null : (
                  <StatusIcon
                    status={chip.status}
                    className={`size-[11px] ${statusColor[chip.status]}`}
                  />
                )}
                {chip.label}
                <b className={`font-normal ${pressed ? "text-fg-3" : "text-fg-4"}`}>{chip.count}</b>
              </button>
            );
          })}
        </fieldset>
      </div>
      <section
        ref={list}
        tabIndex={0}
        aria-label="Execution list"
        className="min-h-0 flex-1 overflow-auto overscroll-contain focus-visible:-outline-offset-2"
      >
        <ListBody
          list={view.list}
          filter={filter}
          now={now}
          selected={selected}
          rootFlag={rootFlag}
        />
      </section>
    </Pane>
  );
};

export const ExecutionsPaneSkeleton = () => (
  <Pane id="executions-title" title="Executions" count="" aside={sortHint} className="bg-canvas">
    <div className="grid flex-none gap-[9px] border-b border-line-soft py-2.5 pr-3 pl-3.5">
      <Skeleton className="h-[30px] rounded-[7px]" />
      <Skeleton className="h-[22px] w-[84%] rounded-sm" />
    </div>
    <div aria-busy="true" className="min-h-0 flex-1 overflow-hidden">
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="grid grid-cols-[16px_1fr_44px] gap-x-2.5 gap-y-2 border-b border-line-soft px-3.5 py-[13px]"
        >
          <Skeleton className="row-span-2 size-3 self-center rounded-full" />
          <Skeleton className="h-2.5 w-[62%] rounded-sm" />
          <Skeleton className="h-2.5 rounded-sm" />
          <Skeleton className="col-span-2 h-2 w-[44%] rounded-sm" />
        </div>
      ))}
    </div>
  </Pane>
);
