import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "{examples,plugins,apps}/*/src/**/*.test.{ts,tsx}"],
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["{examples,plugins,apps}/*/test/**/*.test.{ts,tsx}"],
          testTimeout: 30_000,
          // Vitest inlines .ts files under node_modules, which hides them from Bun.plugin onLoad.
          server: { deps: { external: [/\/node_modules\/kymo\//] } },
        },
      },
    ],
  },
});
