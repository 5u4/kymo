import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { statusName, type ExecutionDetail, type ExecutionSummary } from "kymo/api";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import { refine } from "./executions-view.ts";
import { Glyph, SpanIcon } from "./glyphs.tsx";
import { Inspector, type InspectorTab } from "./inspector.tsx";
import { logMarks, type LevelFilter, type LogMark } from "./log-view.ts";
import type { Logs } from "./snapshot.ts";
import { spanColor, statusColor } from "./status-color.ts";
import {
  axis,
  defaultExpanded,
  duration,
  endOf,
  expandTo,
  findSpan,
  fitZoom,
  initialSpan,
  isDrawn,
  moveSpan,
  reachOf,
  spanName,
  spanStatus,
  spansOf,
  traceOf,
  viewAt,
  visibleRows,
  waitKind,
  zoomLimit,
  type Axis,
  type Span,
  type View,
} from "./trace-view.ts";
import { useMountEffect } from "./use-mount-effect.ts";

const minTrace = 96;
const minInspector = 140;

const stripes =
  "bg-[repeating-linear-gradient(135deg,color-mix(in_oklch,currentColor_75%,transparent)_0_4px,color-mix(in_oklch,currentColor_26%,transparent)_4px_8px)]";

const typeTag = (span: Span): string => {
  switch (span._tag) {
    case "Activity":
      return span.attempts.length > 1 ? `×${span.attempts.length}` : "";
    case "Wait":
      return waitKind[span.wait.kind];
    case "Child":
      return Option.match(span.summary, {
        onNone: () => "not in the journal",
        onSome: (summary) => summary.workflow,
      });
    case "Execution":
    case "Attempt":
      return "";
  }
};

const future = (span: Span, now: number): Option.Option<number> =>
  span._tag === "Wait" ? Option.filter(span.wakeAt, (wakeAt) => wakeAt > now) : Option.none();

const Bars = ({
  span,
  scale,
  now,
  marks,
}: {
  span: Span;
  scale: Axis;
  now: number;
  marks: ReadonlyArray<LogMark>;
}) => {
  if (!isDrawn(span)) return null;
  const pct = (at: number) => ((at - scale.t0) / scale.span) * 100;
  const color = spanColor(span);
  const end = endOf(span, now);
  const wake = future(span, now);
  const segment = (key: string | number, from: number, to: number, className: string) => (
    <i
      key={key}
      style={{ left: `${pct(from)}%`, width: `${Math.max(pct(to) - pct(from), 0)}%` }}
      className={`absolute min-w-0.5 rounded-xs ${className}`}
    />
  );
  const full = "top-[9px] h-2.5";
  const bars =
    span._tag === "Execution" || span._tag === "Child"
      ? [segment("bar", span.start, end, `top-3 h-1 bg-current opacity-70 ${color}`)]
      : span._tag === "Activity" && span.attempts.length > 1
        ? span.attempts.map((run) =>
            segment(
              run.attempt,
              DateTime.toEpochMillis(run.startedAt),
              Option.match(run.endedAt, { onNone: () => now, onSome: DateTime.toEpochMillis }),
              `${full} bg-current ${statusColor[statusName(run.status)]}`,
            ),
          )
        : span._tag === "Wait"
          ? [
              segment("wait", span.start, now, `${full} ${stripes} ${color}`),
              ...Option.match(wake, {
                onNone: () => [],
                onSome: (wakeAt) => [
                  segment(
                    "future",
                    now,
                    wakeAt,
                    `${full} inset-ring inset-ring-current/70 ${color}`,
                  ),
                ],
              }),
            ]
          : [segment("bar", span.start, end, `${full} bg-current ${color}`)];
  const left = pct(span.start);
  const right = pct(reachOf(span, now));
  const text = Option.match(wake, {
    onNone: () => duration(end - span.start),
    onSome: (wakeAt) => `wakes in ${duration(wakeAt - now)}`,
  });
  const label = "absolute top-[7px] font-mono text-[10.5px]/[14px] whitespace-nowrap text-fg-3";
  return (
    <>
      {bars}
      {marks.map((mark) => (
        <i
          key={mark.seq}
          style={{ left: `${pct(mark.at)}%` }}
          className={`pointer-events-none absolute top-0.5 ml-[-2.5px] size-[5px] rounded-full shadow-[0_0_0_1.5px_var(--color-canvas)] ${mark.level === "Warn" ? "bg-sus" : "bg-fail"}`}
        />
      ))}
      {right <= 80 ? (
        <span style={{ left: `calc(${right}% + 7px)` }} className={label}>
          {text}
        </span>
      ) : left >= 20 ? (
        <span style={{ right: `calc(${100 - left}% + 7px)` }} className={label}>
          {text}
        </span>
      ) : null}
    </>
  );
};

export const Trace = ({
  detail,
  logs,
  summaries,
  now,
  rootFlag,
  height,
  onResize,
}: {
  detail: ExecutionDetail;
  logs: Logs;
  summaries: ReadonlyMap<string, ExecutionSummary>;
  now: DateTime.Utc;
  rootFlag: string | undefined;
  height: Option.Option<number>;
  onResize: (height: number) => void;
}) => {
  const navigate = useNavigate({ from: "/" });
  const root = traceOf(detail, summaries);
  const nowMs = DateTime.toEpochMillis(now);
  const [selected, setSelected] = useState(() => initialSpan(root, detail.status));
  const [expanded, setExpanded] = useState(() =>
    expandTo(root, defaultExpanded(root), initialSpan(root, detail.status)),
  );
  const [view, setView] = useState<View>({ zoom: 1, from: 0, to: 1 });
  const [tab, setTab] = useState<InspectorTab>("Overview");
  const [level, setLevel] = useState<LevelFilter>("all");
  const { zoom } = view;
  const inspector = useRef<HTMLElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const drag = useRef({ y: 0, height: 0, max: 0 });
  const [split, setSplit] = useState<{ readonly now: number; readonly max: number }>();
  const ids = useId();
  const span = Option.getOrElse(findSpan(root, selected), () => root);
  const rows = visibleRows(root, expanded);
  const scale = axis(root, nowMs, zoom, zoom === 1 ? undefined : view);
  const pct = (at: number) => ((at - scale.t0) / scale.span) * 100;
  const open = Option.isNone(root.end);
  const nowAt = pct(nowMs);
  const active = rows.findIndex((row) => row.span.key === span.key);

  const syncView = () => {
    if (box.current === null || tree.current === null || label.current === null) return;
    const scrollLeft = box.current.scrollLeft;
    const visible = box.current.clientWidth - label.current.offsetWidth;
    const width = tree.current.offsetWidth - label.current.offsetWidth;
    setView((current) => {
      const next = viewAt(current.zoom, scrollLeft, visible, width);
      return current.from === next.from && current.to === next.to ? current : next;
    });
  };

  const rezoom = (
    next: (zoom: number) => number,
    place: (width: number, visible: number) => number,
  ) => {
    if (box.current === null || tree.current === null || label.current === null) return;
    const visible = box.current.clientWidth - label.current.offsetWidth;
    flushSync(() =>
      setView((current) => {
        const zoom = Math.min(zoomLimit, Math.max(1, next(current.zoom)));
        return viewAt(zoom, place(visible * zoom, visible), visible, visible * zoom);
      }),
    );
    box.current.scrollLeft = place(tree.current.offsetWidth - label.current.offsetWidth, visible);
    syncView();
  };

  const zoomAround = (next: (zoom: number) => number, offset?: number) => {
    if (box.current === null || tree.current === null || label.current === null) return;
    const anchor = offset ?? (box.current.clientWidth - label.current.offsetWidth) / 2;
    const fraction =
      (box.current.scrollLeft + anchor) / (tree.current.offsetWidth - label.current.offsetWidth);
    rezoom(next, (width) => fraction * width - anchor);
  };

  const zoomToSpan = (target: Span) =>
    rezoom(
      () => fitZoom(target, scale, nowMs),
      (width, visible) => ((target.start - scale.t0) / scale.span) * width - 0.2 * visible,
    );

  const measure = () => {
    if (box.current === null || inspector.current === null) return undefined;
    const now = box.current.getBoundingClientRect().height;
    const room = now + inspector.current.getBoundingClientRect().height - minInspector;
    return { now, max: Math.max(minTrace, room) };
  };

  useMountEffect(() => {
    const element = box.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const offset =
        event.clientX - element.getBoundingClientRect().left - (label.current?.offsetWidth ?? 0);
      zoomAround((zoom) => zoom * Math.exp(-event.deltaY * 0.01), Math.max(0, offset));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    const resized = new ResizeObserver(() => {
      syncView();
      setSplit(measure());
    });
    resized.observe(element);
    if (inspector.current !== null) resized.observe(inspector.current);
    return () => {
      element.removeEventListener("wheel", onWheel);
      resized.disconnect();
    };
  });

  const select = (key: string) => {
    flushSync(() => {
      setSelected(key);
      setExpanded((current) => expandTo(root, current, key));
    });
    tree.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };

  const toggle = (target: Span) => {
    const collapsing = expanded.has(target.key);
    setExpanded((current) =>
      collapsing
        ? new Set([...current].filter((key) => key !== target.key))
        : new Set([...current, target.key]),
    );
    if (collapsing && span.key !== target.key && Option.isSome(findSpan(target, span.key))) {
      setSelected(target.key);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const moved = moveSpan(rows, expanded, span.key, event.key);
    if (Option.isSome(moved)) {
      event.preventDefault();
      flushSync(() => {
        setSelected(moved.value.key);
        setExpanded(moved.value.expanded);
      });
      tree.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
      return;
    }
    switch (event.key) {
      case "+":
      case "=":
        zoomAround((zoom) => zoom * 2);
        break;
      case "-":
      case "_":
        zoomAround((zoom) => zoom / 2);
        break;
      case "0":
        zoomAround(() => 1);
        break;
      case "f":
        zoomToSpan(span);
        break;
      case "Enter":
        if (span._tag !== "Child") return;
        void navigate({ search: (prev) => refine(prev, { exec: span.id }) });
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const resizeTo = (next: number, max: number) =>
    onResize(Math.round(Math.max(minTrace, Math.min(max, next))));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const current = measure();
    if (current === undefined) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, height: current.now, max: current.max };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    resizeTo(drag.current.height + event.clientY - drag.current.y, drag.current.max);
  };

  const onSeparatorKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = measure();
    if (current === undefined) return;
    const step = event.key === "ArrowUp" ? -16 : event.key === "ArrowDown" ? 16 : 0;
    if (step === 0) return;
    event.preventDefault();
    resizeTo(current.now + step, current.max);
  };

  const zoomButton =
    "h-[18px] min-w-5 rounded-[5px] px-[5px] font-mono text-[10.5px]/none text-fg-3 transition-colors duration-140 ease-g enabled:hover:bg-line enabled:hover:text-fg disabled:opacity-40";
  const spanCount = spansOf(root).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        style={Option.match(height, {
          onNone: () => undefined,
          onSome: (px) => ({ flexBasis: px }),
        })}
        className={`relative flex min-h-24 flex-[0_1_auto] flex-col ${Option.isSome(height) ? "" : "max-h-[56%]"}`}
      >
        <div
          ref={box}
          onScroll={zoom === 1 ? undefined : syncView}
          className="peer @container min-h-0 flex-[1_1_auto] overflow-auto overscroll-contain bg-canvas"
        >
          <div
            ref={tree}
            role="tree"
            tabIndex={0}
            aria-label={`Trace of ${detail.id}`}
            aria-activedescendant={active === -1 ? undefined : `${ids}-${active}`}
            onKeyDown={onKeyDown}
            onClick={(event) => {
              if (!(event.target instanceof Element)) return;
              const key = event.target.closest<HTMLElement>("[data-span]")?.dataset["span"];
              if (key !== undefined) select(key);
            }}
            style={{ width: `calc(var(--treew) + (100cqw - var(--treew)) * ${zoom})` }}
            className="relative min-w-[460px] outline-none [--treew:clamp(280px,40cqw,420px)]"
          >
            <div className="sticky top-0 z-3 grid h-7 grid-cols-[var(--treew)_minmax(0,1fr)] border-b border-line-soft bg-sunk font-mono text-[10.5px]/none text-fg-4">
              <div
                ref={label}
                className="sticky left-0 z-1 flex items-center gap-2 border-r border-line-soft bg-sunk pr-2 pl-3.5 font-sans text-[11.5px]/none font-medium text-fg-3"
              >
                Trace
                <span className="font-mono text-[10.5px] font-normal text-fg-4">
                  {spanCount} span{spanCount === 1 ? "" : "s"}
                </span>
                <fieldset
                  aria-label="Zoom"
                  className="ml-auto inline-flex items-center gap-px rounded-md p-px inset-ring inset-ring-line-soft"
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Zoom out"
                    aria-keyshortcuts="-"
                    disabled={zoom <= 1}
                    onClick={() => zoomAround((current) => current / 2)}
                    className={zoomButton}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Fit trace"
                    aria-keyshortcuts="0"
                    title="Fit (0)"
                    onClick={() => zoomAround(() => 1)}
                    className={zoomButton}
                  >
                    {zoom < 10 ? Math.round(zoom * 10) / 10 : Math.round(zoom)}×
                  </button>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Zoom in"
                    aria-keyshortcuts="+"
                    disabled={zoom >= zoomLimit}
                    onClick={() => zoomAround((current) => current * 2)}
                    className={zoomButton}
                  >
                    +
                  </button>
                </fieldset>
              </div>
              <div aria-hidden="true" className="relative overflow-hidden">
                {scale.ticks.map((tick) => {
                  const at = pct(tick.at);
                  const hidden = at > 100 - 8 / zoom || (open && Math.abs(at - nowAt) < 16 / zoom);
                  return (
                    <span
                      key={tick.at}
                      style={{ left: `${at}%` }}
                      className="absolute inset-y-0 border-l border-line-soft pt-[9px] pl-1 whitespace-nowrap"
                    >
                      {hidden ? "" : tick.label}
                    </span>
                  );
                })}
                {open ? (
                  <span
                    style={{ left: `${nowAt}%` }}
                    className={`absolute inset-y-0 border-dashed border-fg-3 pt-[9px] whitespace-nowrap text-fg-2 ${nowAt > 100 - 14 / zoom ? "-translate-x-full border-r pr-1" : "border-l pl-1"}`}
                  >
                    now
                  </span>
                ) : null}
              </div>
            </div>
            <div className="relative pt-1 pb-2">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-0 left-(--treew)"
              >
                {scale.ticks.map((tick) => (
                  <i
                    key={tick.at}
                    style={{ left: `${pct(tick.at)}%` }}
                    className="absolute inset-y-0 border-l border-line-soft/50"
                  />
                ))}
                {open ? (
                  <i
                    style={{ left: `${nowAt}%` }}
                    className="absolute inset-y-0 border-l border-dashed border-fg-3/55"
                  />
                ) : null}
              </div>
              {rows.map((row, index) => {
                const current = row.span.key === span.key;
                const isOpen = expanded.has(row.span.key);
                const name = spanName(row.span);
                const tag = typeTag(row.span);
                const wake = future(row.span, nowMs);
                const status = Option.getOrUndefined(spanStatus(row.span));
                return (
                  <div
                    key={row.span.key}
                    id={`${ids}-${index}`}
                    data-span={row.span.key}
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-selected={current}
                    aria-expanded={row.hasChildren ? isOpen : undefined}
                    className={`group relative grid h-7 cursor-pointer grid-cols-[var(--treew)_minmax(0,1fr)] transition-colors duration-140 ease-g ${current ? "bg-sel" : "hover:bg-hover"}`}
                  >
                    <div
                      style={{ paddingLeft: 8 + row.depth * 16 }}
                      className={`sticky left-0 z-1 flex min-w-0 items-center gap-1.5 border-r border-line-soft pr-2.5 ${current ? "bg-sel shadow-[inset_2px_0_0_var(--color-fg)]" : "bg-canvas group-hover:bg-hover"}`}
                    >
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={`${isOpen ? "Collapse" : "Expand"} ${name}`}
                        aria-expanded={isOpen}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggle(row.span);
                        }}
                        className={`grid size-4 flex-none place-items-center rounded-sm text-fg-4 transition-colors duration-140 ease-g hover:bg-line hover:text-fg ${row.hasChildren ? "" : "invisible"}`}
                      >
                        <Glyph
                          name="chevron"
                          className={`size-3 transition-transform duration-220 ease-g ${isOpen ? "rotate-180" : "rotate-90"}`}
                        />
                      </button>
                      <SpanIcon span={row.span} />
                      <span className="flex h-4 min-w-0 flex-1 flex-wrap content-start items-center gap-x-1.5 overflow-hidden">
                        <span
                          className={`max-w-max min-w-0 flex-1 basis-20 truncate ${row.span._tag === "Attempt" ? "font-mono text-xs/4 text-fg-2" : `text-[12.5px]/4 ${row.span._tag === "Execution" ? "font-semibold" : "font-medium"}`}`}
                        >
                          {name}
                        </span>
                        {status === undefined ? null : <span className="sr-only">{status}</span>}
                        {tag === "" ? null : (
                          <span className="flex-none font-mono text-[10.5px]/4 whitespace-nowrap text-fg-4">
                            {tag}
                          </span>
                        )}
                      </span>
                      <span className="flex-none pl-1.5 font-mono text-[11px]/none whitespace-nowrap text-fg-3">
                        {Option.match(wake, {
                          onNone: () => duration(endOf(row.span, nowMs) - row.span.start),
                          onSome: (wakeAt) => `in ${duration(wakeAt - nowMs)}`,
                        })}
                      </span>
                    </div>
                    <div className="relative overflow-hidden">
                      <Bars
                        span={row.span}
                        scale={scale}
                        now={nowMs}
                        marks={logMarks(row.span, logs.entries)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-5 rounded-md -outline-offset-2 outline-fg peer-has-focus-visible:outline-2"
        />
      </div>
      {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions -- jsx-a11y treats every separator as static, but ARIA makes a focusable one a widget */}
      <hr
        aria-orientation="horizontal"
        aria-label="Resize trace"
        aria-valuemin={minTrace}
        aria-valuemax={split === undefined ? undefined : Math.round(split.max)}
        aria-valuenow={split === undefined ? undefined : Math.round(split.now)}
        tabIndex={0}
        title="Drag to resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onSeparatorKey}
        className="relative z-4 -my-1 h-[9px] flex-none cursor-row-resize touch-none border-0 after:absolute after:inset-x-0 after:top-1 after:h-px after:bg-line after:transition-[background-color,scale] after:duration-140 after:ease-g hover:after:scale-y-200 hover:after:bg-fg-3 focus-visible:after:bg-fg-3"
      />
      {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}
      <section
        ref={inspector}
        aria-label="Selected span"
        className="min-h-[140px] flex-[1_1_0] overflow-auto overscroll-contain bg-panel"
      >
        <Inspector
          span={span}
          root={root}
          summaries={summaries}
          now={now}
          rootFlag={rootFlag}
          logs={logs}
          tab={tab}
          level={level}
          onTab={setTab}
          onLevel={setLevel}
          onSelect={select}
        />
      </section>
    </div>
  );
};
