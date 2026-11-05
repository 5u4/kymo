import type { ReactNode, Ref } from "react";

const buttonVariants = {
  secondary:
    "bg-raised text-fg shadow-[0_1px_0_oklch(0_0_0/.25)] inset-ring inset-ring-line enabled:hover:bg-hover enabled:hover:inset-ring-line-strong",
  primary: "bg-fg text-canvas shadow-[0_1px_0_oklch(0_0_0/.3)] enabled:hover:bg-white",
  danger:
    "bg-raised text-fail shadow-[0_1px_0_oklch(0_0_0/.25)] inset-ring inset-ring-fail/40 enabled:hover:bg-[color-mix(in_oklch,var(--color-fail)_10%,var(--color-raised))] enabled:hover:inset-ring-fail/60",
  dangerSolid: "bg-fail text-[oklch(0.16_0.02_28)] enabled:hover:bg-[oklch(0.76_0.17_28)]",
  ghost: "h-7 px-2.5 text-fg-3 enabled:hover:bg-hover enabled:hover:text-fg",
} as const;

export const Button = ({
  variant = "secondary",
  disabled = false,
  ref,
  onClick,
  children,
}: {
  variant?: keyof typeof buttonVariants;
  disabled?: boolean;
  ref?: Ref<HTMLButtonElement>;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    disabled={disabled}
    ref={ref}
    onClick={onClick}
    className={`inline-flex h-8 items-center justify-center gap-2 rounded-lg px-3 text-[12.5px]/none font-medium whitespace-nowrap transition-[background-color,box-shadow,color,opacity] duration-140 ease-g enabled:active:scale-96 disabled:cursor-default disabled:opacity-55 ${buttonVariants[variant]}`}
  >
    {children}
  </button>
);

export const Spinner = () => (
  <span
    aria-hidden="true"
    className="size-3 flex-none animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
  />
);

export const Pane = ({
  id,
  title,
  count,
  aside,
  className,
  children,
}: {
  id: string;
  title: string;
  count: string;
  aside?: ReactNode;
  className: string;
  children: ReactNode;
}) => (
  <section
    aria-labelledby={id}
    className={`flex min-h-0 min-w-0 flex-col border-r border-line-soft last:border-r-0 ${className}`}
  >
    <div className="flex h-10 flex-none items-center gap-2 border-b border-line-soft pr-3.5 pl-4">
      <h2 id={id} className="text-xs/none font-medium tracking-[.01em]">
        {title}
      </h2>
      <span className="font-mono text-[11.5px]/none text-fg-4">{count}</span>
      <span className="flex-1" />
      {aside}
    </div>
    {children}
  </section>
);

export const Skeleton = ({ className }: { className: string }) => (
  <span
    className={`relative block overflow-hidden bg-raised after:absolute after:inset-0 after:animate-shimmer after:bg-linear-to-r after:from-transparent after:via-white/5 after:to-transparent ${className}`}
  />
);

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[5px] bg-sunk px-[5px] font-mono text-[10.5px]/none font-medium text-fg-3 shadow-[0_1px_0_var(--color-line-soft)] inset-ring inset-ring-line">
    {children}
  </kbd>
);
