import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "./ui.tsx";

export type Connection = "wait" | "ok" | "down";

const dotClass: Record<Connection, string> = {
  wait: "bg-fg-4",
  ok: "bg-ok ring-3 ring-ok/18",
  down: "bg-fail ring-3 ring-fail/22",
};

export const AppHeader = ({ connection }: { connection: Connection }) => (
  <header className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-[18px] border-b border-line-soft bg-sunk pr-2.5 pl-4">
    <Link to="/" aria-label="kymo home" className="flex items-center gap-[9px]">
      <svg viewBox="0 0 44 16" aria-hidden="true" className="h-4 w-11 text-fg-3">
        <path
          d="M0 11h9l2-6 3 9 2.5-11 2.5 8h7l1.5-3 1.5 3h6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx="41"
          cy="11"
          r="2"
          className="origin-center animate-stylus fill-fg transform-fill"
        />
      </svg>
      <span className="font-mono text-[15px]/none font-semibold tracking-[-0.04em]">kymo</span>
    </Link>
    <output
      aria-live="polite"
      className="flex min-w-0 items-center gap-2.5 overflow-hidden font-mono text-[11.5px]/none whitespace-nowrap text-fg-3"
    >
      <span className={`size-[7px] flex-none rounded-full ${dotClass[connection]}`} />
      <span
        className={`min-w-0 truncate font-medium ${connection === "down" ? "text-fail" : "text-fg-2"}`}
      >
        daemon
      </span>
      <span className="text-fg-4">·</span>
      <span>{globalThis.location.host}</span>
      {connection === "ok" ? null : (
        <>
          <span className="text-fg-4">·</span>
          <span>{connection === "down" ? "unreachable" : "connecting…"}</span>
        </>
      )}
    </output>
  </header>
);

export const DaemonDown = ({ message }: { message: string }) => {
  const router = useRouter();
  return (
    <section
      aria-live="assertive"
      className="col-span-full grid grid-cols-[minmax(0,1fr)_minmax(0,420px)] content-center gap-12 bg-canvas px-[clamp(28px,6vw,96px)] py-10"
    >
      <div className="max-w-[620px]">
        <div className="font-mono text-xs/none font-medium tracking-[.02em] text-fail">
          error: daemon_unreachable
        </div>
        <h2 className="mt-3.5 text-[44px]/[1.12] font-medium tracking-[-0.03em] text-balance">
          kymo can't reach its daemon.
        </h2>
        <p className="mt-3 max-w-[56ch] text-[13.5px]/[1.6] text-pretty text-fg-3">
          <code className="font-mono text-[12.5px]/none text-fg">{message}</code>. The journal is
          safe in <span className="font-mono">kymo.db</span>. This page reconnects as soon as the
          daemon answers again.
        </p>
        <div className="mt-[22px] flex flex-wrap items-center gap-2.5">
          <Button variant="primary" onClick={() => void router.invalidate()}>
            Retry connection
          </Button>
        </div>
      </div>
      <div className="self-center rounded-[14px] bg-sunk px-[22px] py-5 font-mono text-xs/[1.75] text-fg-3 inset-ring inset-ring-line-soft">
        <div className="text-fg-4"># what kymo tried</div>
        <div>
          <b className="font-medium text-fg">GET</b> {globalThis.location.host}/api/workflows
        </div>
        <div className="text-fail">✕ {message}</div>
        <br />
        <div className="text-fg-4"># worth checking</div>
        <div>
          1 is the daemon running? <b className="font-medium text-fg">kymo</b>
        </div>
        <div>
          2 start it: <b className="font-medium text-fg">kymo start</b>
        </div>
      </div>
    </section>
  );
};
