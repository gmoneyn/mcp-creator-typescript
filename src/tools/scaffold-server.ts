/**
 * scaffold_server — Generate a complete, runnable TypeScript MCP server project.
 * This is the core orchestrator: parses inputs → calls codegen → writes files.
 */

import { resolve } from "node:path";
import {
  renderPackageJson,
  renderTsconfig,
  renderTsupConfig,
  renderGitignore,
  renderIndex,
  renderToolModule,
  renderTestServer,
  renderTestTool,
  renderReadme,
  renderEnvExample,
  type ToolDef,
} from "../services/codegen.js";
import { writeProjectFiles } from "../services/file-writer.js";

export async function scaffoldServer(
  packageName: string,
  description: string,
  tools: string,
  outputDir: string = ".",
  envVars?: string,
  paid?: boolean
): Promise<string> {
  // Parse tool definitions
  let toolDefs: ToolDef[];
  try {
    toolDefs = JSON.parse(tools);
    if (!Array.isArray(toolDefs) || toolDefs.length === 0) {
      return JSON.stringify({ error: "tools must be a non-empty JSON array of tool definitions." });
    }
  } catch {
    return JSON.stringify({ error: "tools must be valid JSON. Expected array of { name, description, parameters, returns }." });
  }

  // Parse optional env vars
  let envVarsParsed: Array<{ name: string; description: string; required?: boolean }> | undefined;
  if (envVars) {
    try {
      envVarsParsed = JSON.parse(envVars);
    } catch {
      return JSON.stringify({ error: "envVars must be valid JSON. Expected array of { name, description, required? }." });
    }
  }

  const projectDir = resolve(outputDir, packageName);

  // Generate all files
  const files: Record<string, string> = {};

  // Project config
  files["package.json"] = renderPackageJson(packageName, description, { paid: !!paid });
  files["tsconfig.json"] = renderTsconfig();
  files["tsup.config.ts"] = renderTsupConfig();
  files[".gitignore"] = renderGitignore();

  // Main server
  files["src/index.ts"] = renderIndex(packageName, toolDefs, { paid: !!paid });

  // Tool modules
  for (const tool of toolDefs) {
    const fileName = tool.name.replace(/_/g, "-");
    files[`src/tools/${fileName}.ts`] = renderToolModule(tool);
  }

  // Tests
  files["tests/test-server.ts"] = renderTestServer(packageName, toolDefs);
  for (const tool of toolDefs) {
    const fileName = tool.name.replace(/_/g, "-");
    files[`tests/test-${fileName}.ts`] = renderTestTool(tool);
  }

  // README
  files["README.md"] = renderReadme(packageName, description, toolDefs, { paid: !!paid });

  // .env.example
  const envExample = renderEnvExample(envVarsParsed, { paid: !!paid });
  if (envExample) {
    files[".env.example"] = envExample;
  }

  // Write to disk
  const written = writeProjectFiles(projectDir, files);

  const nextSteps: string[] = [
    `Project scaffolded at ${projectDir}`,
    `cd ${projectDir} && npm install`,
    "Open the src/tools/ folder and replace the TODO stubs with your real logic.",
    "npm run build",
    "npm test",
    "When ready, use build_package to build and publish_package to publish to npm.",
  ];

  return JSON.stringify({
    success: true,
    projectDir,
    filesCreated: written.length,
    fileList: Object.keys(files),
    paid: !!paid,
    nextSteps,
  }, null, 2);
}
