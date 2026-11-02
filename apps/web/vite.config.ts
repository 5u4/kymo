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
});
