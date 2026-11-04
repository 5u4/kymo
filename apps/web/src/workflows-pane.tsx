import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { refine, statuses, type StatusCounts, type WorkflowRow } from "./executions-view.ts";
import { StatusIcon } from "./glyphs.tsx";
import { statusColor } from "./status-color.ts";
import { Pane, Skeleton } from "./ui.tsx";

const Trace = ({ counts, total }: { counts: StatusCounts; total: number }) =>
  total === 0 ? (
    <span
      aria-hidden="true"
      className="col-span-full h-[3px] rounded-xs bg-[repeating-linear-gradient(90deg,var(--color-line)_0_4px,transparent_4px_8px)]"
    />
  ) : (
    <span aria-hidden="true" className="col-span-full flex h-[3px] gap-0.5">
      {statuses
        .filter((status) => counts[status] > 0)
        .map((status) => (
          <i
            key={status}
            style={{ flexGrow: counts[status] }}
            className={`block h-full min-w-[3px] rounded-xs bg-current ${statusColor[status]}`}
          />
        ))}
    </span>
  );

export const WorkflowsPane = ({
  rows,
  selected,
}: {
  rows: ReadonlyArray<WorkflowRow>;
  selected: string | undefined;
}) => (
  <Pane id="workflows-title" title="Workflows" count={String(rows.length - 1)} className="bg-sunk">
    <nav aria-labelledby="workflows-title" className="min-h-0 flex-1 overflow-auto py-1.5">
      <ul>
        {rows.map((row) => {
          const name = Option.getOrUndefined(row.name);
          const current = name === selected;
          const breakdown =
            statuses
              .filter((status) => row.counts[status] > 0)
              .map((status) => `${row.counts[status]} ${status}`)
              .join(", ") || "no executions";
          return (
            <li key={name ?? ""}>
              <Link
                to="/"
                search={(prev) => refine(prev, { workflow: name })}
                aria-current={current ? "page" : undefined}
                aria-label={`${name ?? "All workflows"}: ${breakdown}`}
                className={`mx-1.5 my-px grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-[7px] rounded-[9px] py-2.5 pr-2.5 pl-3 transition-colors duration-140 ease-g focus-visible:-outline-offset-2 ${current ? "bg-sel" : "hover:bg-hover"}`}
              >
                <span
                  className={`truncate text-[13px]/[1.2] font-medium ${name === undefined ? "text-fg-2" : ""}`}
                >
                  {name ?? "All workflows"}
                </span>
                <span className="font-mono text-[11.5px]/none text-fg-3">{row.total}</span>
                <Trace counts={row.counts} total={row.total} />
                <span
                  aria-hidden="true"
                  className="col-span-full flex flex-wrap gap-x-[11px] gap-y-1 font-mono text-[11px]/none text-fg-3"
                >
                  {statuses.map((status) => (
                    <span
                      key={status}
                      title={status}
                      className={`inline-flex items-center gap-1 ${row.counts[status] > 0 ? "" : "text-fg-4"}`}
                    >
                      <StatusIcon
                        status={status}
                        className={`size-[11px] ${row.counts[status] > 0 ? statusColor[status] : ""}`}
                      />
                      {row.counts[status]}
                    </span>
                  ))}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  </Pane>
);

const skeletonWidths = ["w-[52%]", "w-[70%]", "w-[58%]", "w-[64%]", "w-[48%]", "w-[60%]"];

export const WorkflowsPaneSkeleton = () => (
  <Pane id="workflows-title" title="Workflows" count="" className="bg-sunk">
    <div aria-busy="true" className="py-1.5">
      {skeletonWidths.map((width) => (
        <div
          key={width}
          aria-hidden="true"
          className="mx-1.5 my-px grid gap-y-[7px] rounded-[9px] py-2.5 pr-2.5 pl-3"
        >
          <Skeleton className={`h-[11px] rounded-sm ${width}`} />
          <Skeleton className="h-[3px] rounded-sm" />
          <Skeleton className="h-2 w-[70%] rounded-sm" />
        </div>
      ))}
    </div>
  </Pane>
);
