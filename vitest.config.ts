import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{packages,plugins,apps}/*/src/**/*.test.{ts,tsx}"],
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["{packages,plugins,apps}/*/test/**/*.test.{ts,tsx}"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
