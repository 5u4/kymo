import type { ReactNode } from "react";

export const Button = ({
  primary = false,
  onClick,
  children,
}: {
  primary?: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex h-8 items-center justify-center gap-2 rounded-lg px-3 text-[12.5px]/none font-medium whitespace-nowrap transition-[background-color,box-shadow,color] duration-140 ease-g active:scale-96 ${
      primary
        ? "bg-fg text-canvas shadow-[0_1px_0_oklch(0_0_0/.3)] hover:bg-white"
        : "bg-raised text-fg shadow-[0_1px_0_oklch(0_0_0/.25)] inset-ring inset-ring-line hover:bg-hover hover:inset-ring-line-strong"
    }`}
  >
    {children}
  </button>
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
