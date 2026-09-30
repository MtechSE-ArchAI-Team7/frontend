import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "agent3/backend/site",
    emptyOutDir: true,
  },
  server: {
    // Agent 2's gateway (log-ui/backend/dev_server.py in the diagnosis-agent repo). Only its
    // own route is proxied, so Agent 3's /api/runs is untouched.
    proxy: { "/api/cases": "http://127.0.0.1:8787" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./shared/test-setup.ts"],
  },
});
