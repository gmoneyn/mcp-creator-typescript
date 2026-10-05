import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // examples/ui-app is a separate project with its own dependencies and its own
    // `npm test`. Its tests cannot load in a clean checkout of the root, where
    // those dependencies are not installed.
    exclude: [...configDefaults.exclude, "examples/**"],
  },
});
