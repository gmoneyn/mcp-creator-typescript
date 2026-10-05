import { defineConfig } from "tsup";

// clean: true wipes dist/ — which is WHY the UI bundle goes to dist-ui/.
export default defineConfig({
  entry: ["src/index.ts", "src/stdio.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: false,
});
