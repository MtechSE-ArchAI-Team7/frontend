import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "agent3/backend/site",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./shared/test-setup.ts"],
  },
});
