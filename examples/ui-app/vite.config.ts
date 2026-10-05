import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const uiDir = fileURLToPath(new URL("./ui", import.meta.url));

// Single self-contained HTML (inlined JS + CSS): the host renders it in a
// sandboxed iframe with no origin to load sibling assets from.
// Output goes to dist-ui/, NOT dist/ — the server build (tsup clean) owns dist/.
export default defineConfig({
  root: uiDir,
  plugins: [viteSingleFile()],
  build: {
    outDir: fileURLToPath(new URL("./dist-ui", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: { input: `${uiDir}/mcp-app.html` },
  },
});
