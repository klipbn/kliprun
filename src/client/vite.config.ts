import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "node:fs";

const rootPackage = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "../../package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPackage.version),
  },
  resolve: {
    alias: {
      "@shared": path.resolve(process.cwd(), "../shared"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8792",
        changeOrigin: true,
      },
    },
  },
});
