import { createRootRoute, Outlet } from "@tanstack/react-router";

const RootLayout = () => (
  <div className="flex min-h-dvh flex-col">
    <Outlet />
  </div>
);

export const Route = createRootRoute({ component: RootLayout });
