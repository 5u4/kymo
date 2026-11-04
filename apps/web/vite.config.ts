import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      addExtensions: true,
      generatedRouteTree: "./src/route-tree.gen.ts",
    }),
    tailwindcss(),
    react(),
  ],
  publicDir: false,
  server: {
    proxy: {
      "/api": {
        target: process.env["KYMO_DAEMON"] ?? "http://127.0.0.1:4419",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => request.removeHeader("origin"));
        },
      },
    },
  },
});
