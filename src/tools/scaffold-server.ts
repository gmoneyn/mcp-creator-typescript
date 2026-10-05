/**
 * scaffold_server — Generate a complete, runnable TypeScript MCP server project.
 * This is the core orchestrator: parses inputs → calls codegen → writes files.
 */

import { resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import {
  renderPackageJson,
  renderTsconfig,
  renderTsupConfig,
  renderGitignore,
  renderIndex,
  renderToolModule,
  renderTestServer,
  renderVitestConfig,
  renderTestTool,
  renderReadme,
  renderEnvExample,
  renderDockerfile,
  ALLOWED_HOSTS_VAR,
  dockerImageName,
  toolFileName,
  type ToolDef,
} from "../services/codegen.js";
import { writeProjectFiles } from "../services/file-writer.js";
import { forbiddenDirReason, resolveInside } from "../services/path-guard.js";
import { validateEnvVars, validatePackageName, validateText, validateToolDefs } from "../services/validate.js";

export async function scaffoldServer(
  packageName: string,
  description: string,
  tools: string,
  outputDir: string = ".",
  envVars?: string,
  paid?: boolean,
  hosting: string = "local"
): Promise<string> {
  // Parse tool definitions
  let toolDefs: ToolDef[];
  try {
    toolDefs = JSON.parse(tools);
  } catch {
    return JSON.stringify({ error: "tools must be valid JSON. Expected array of { name, description, parameters, returns }." });
  }

  // Names end up in generated source as identifiers, file names and import paths.
  // They are checked before anything is generated; nothing is written on a refusal.
  for (const check of [validatePackageName(packageName), validateText(description, "description", true), validateToolDefs(toolDefs)]) {
    if (!check.ok) {
      return JSON.stringify({ success: false, error: `scaffold_server refused: ${check.error}` });
    }
  }

  // Parse optional env vars
  let envVarsParsed: Array<{ name: string; description: string; required?: boolean }> | undefined;
  if (envVars) {
    try {
      envVarsParsed = JSON.parse(envVars);
    } catch {
      return JSON.stringify({ error: "envVars must be valid JSON. Expected array of { name, description, required? }." });
    }
    const envCheck = validateEnvVars(envVarsParsed);
    if (!envCheck.ok) {
      return JSON.stringify({ success: false, error: `scaffold_server refused: ${envCheck.error}` });
    }
  }

  // The caller picks output_dir; package_name only names the new folder inside it.
  // A package_name such as "../x" or an absolute path must not move the project elsewhere.
  let projectDir: string;
  try {
    projectDir = resolveInside(resolve(outputDir), packageName);
    const forbidden = forbiddenDirReason(projectDir);
    if (forbidden) {
      return JSON.stringify({ success: false, error: `scaffold_server refused: ${forbidden}` });
    }
  } catch (e) {
    return JSON.stringify({
      success: false,
      error: `scaffold_server refused: package_name ${JSON.stringify(packageName)} does not name a folder inside ${resolve(outputDir)}. ${(e as Error).message}`,
    });
  }

  // Never overwrite. An existing folder may be a finished project (re-running would
  // replace implemented tools with stubs) or not a project at all.
  if (existsSync(projectDir)) {
    const empty = statSync(projectDir).isDirectory() && readdirSync(projectDir).length === 0;
    if (!empty) {
      return JSON.stringify({
        success: false,
        error:
          `scaffold_server refused: ${projectDir} already exists and is not empty. This tool never overwrites. ` +
          `Scaffold into a new directory (a different package_name or output_dir), or use add_tool to extend the existing project.`,
      });
    }
  }

  // Generate all files
  const files: Record<string, string> = {};

  // Project config
  files["package.json"] = renderPackageJson(packageName, description, { paid: !!paid, hosting });
  files["tsconfig.json"] = renderTsconfig();
  files["tsup.config.ts"] = renderTsupConfig({ hosting });
  files[".gitignore"] = renderGitignore();

  // Main server
  files["src/index.ts"] = renderIndex(packageName, toolDefs, { paid: !!paid, hosting });

  // Tool modules
  for (const tool of toolDefs) {
    const fileName = toolFileName(tool.name);
    files[`src/tools/${fileName}.ts`] = renderToolModule(tool);
  }

  // Tests
  files["vitest.config.ts"] = renderVitestConfig();
  files["tests/test-server.ts"] = renderTestServer(packageName, toolDefs);
  for (const tool of toolDefs) {
    const fileName = toolFileName(tool.name);
    files[`tests/test-${fileName}.ts`] = renderTestTool(tool);
  }

  // README
  files["README.md"] = renderReadme(packageName, description, toolDefs, { paid: !!paid, hosting });

  // .env.example
  const envExample = renderEnvExample(envVarsParsed, { paid: !!paid, hosting });
  if (envExample) {
    files[".env.example"] = envExample;
  }

  // Dockerfile (remote hosting only)
  if (hosting === "remote") {
    files["Dockerfile"] = renderDockerfile(packageName);
  }

  // Write to disk. Confined to projectDir: a tool name such as "../../x" is refused
  // before any file is written.
  let written: string[];
  try {
    written = writeProjectFiles(projectDir, files);
  } catch (e) {
    return JSON.stringify({ success: false, error: `scaffold_server refused: ${(e as Error).message}` });
  }

  const nextSteps: string[] = [
    `Project scaffolded at ${projectDir}`,
    `cd ${projectDir} && npm install`,
    "Open the src/tools/ folder and replace the TODO stubs with your real logic.",
    "npm run build",
    "npm test",
  ];

  if (hosting === "remote") {
    nextSteps.push(
      `${ALLOWED_HOSTS_VAR} is required: the server refuses to start without it. Local test: ${ALLOWED_HOSTS_VAR}=localhost node dist/index.js`
    );
    const keyFlag = paid ? " -e MCP_LICENSE_KEY=your-license-key-here" : "";
    const image = dockerImageName(packageName);
    nextSteps.push(`docker build -t ${image} . && docker run -p 8000:8000 -e ${ALLOWED_HOSTS_VAR}=localhost${keyFlag} ${image}`);
    nextSteps.push("Test by pointing your MCP client at http://localhost:8000/mcp");
    nextSteps.push("Deploy to Railway, Fly.io, AWS, or any cloud provider.");
  } else {
    nextSteps.push("When ready, use build_package to build and publish_package to publish to npm.");
  }

  if (paid && hosting === "remote") {
    nextSteps.push(
      "License gating is enabled. Set MCP_LICENSE_KEY on the server. This scaffold checks the server's own key and does not yet tell one caller from another (see README: Known limitation)."
    );
  } else if (paid) {
    nextSteps.push("License gating is enabled. Users need MCP_LICENSE_KEY to use paid tools.");
  }

  return JSON.stringify({
    success: true,
    projectDir,
    filesCreated: written.length,
    fileList: Object.keys(files),
    paid: !!paid,
    hosting,
    nextSteps,
  }, null, 2);
}
