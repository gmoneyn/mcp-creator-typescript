import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is ui/ (the browser bundle).
export default defineConfig({ test: { root: ".", include: ["tests/**/*.test.ts"] } });
