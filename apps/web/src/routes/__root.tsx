import { createRootRoute, Outlet } from "@tanstack/react-router";

const RootLayout = () => (
  <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
    <Outlet />
  </div>
);

export const Route = createRootRoute({ component: RootLayout });
