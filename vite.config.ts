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
    // Tests must not depend on the shell they run in: `VITE_AGENT2_API=... make deploy` exports
    // the gateway URL to the test step too, and Agent 2's tests expect same-origin paths.
    // Agent 4 gets the same treatment for VITE_AGENT4_API so its tests never reach the
    // real receiver base.
    env: { VITE_AGENT2_API: "", VITE_AGENT4_API: "" },
    environment: "jsdom",
    setupFiles: ["./shared/test-setup.ts"],
  },
});
