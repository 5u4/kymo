import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { createRouter, RouterProvider, stringifySearchWith } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeTree } from "./route-tree.gen.ts";
import "./styles.css";

const router = createRouter({
  routeTree,
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: stringifySearchWith(String),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
