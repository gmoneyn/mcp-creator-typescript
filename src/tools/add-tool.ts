/**
 * add_tool — Add a new tool to an existing scaffolded TypeScript MCP project.
 * Generates tool file + test, then injects import + registration into index.ts.
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import {
  renderToolModule,
  renderTestTool,
  renderAddToolImport,
  renderAddToolRegistration,
  type ToolDef,
} from "../services/codegen.js";
import { writeProjectFiles, injectAfterSentinel } from "../services/file-writer.js";

export async function addTool(projectDir: string, tool: string): Promise<string> {
  // Parse tool definition
  let toolDef: ToolDef;
  try {
    toolDef = JSON.parse(tool);
    if (!toolDef.name || !toolDef.description || !toolDef.parameters) {
      return JSON.stringify({ error: "Tool must have name, description, and parameters fields." });
    }
  } catch {
    return JSON.stringify({ error: "tool must be valid JSON. Expected { name, description, parameters, returns }." });
  }

  const absDir = resolve(projectDir);
  const indexPath = join(absDir, "src", "index.ts");

  if (!existsSync(indexPath)) {
    return JSON.stringify({
      error: `Could not find src/index.ts in ${absDir}. Is this a scaffolded ts-mcp-creator project?`,
    });
  }

  const fileName = toolDef.name.replace(/_/g, "-");

  // Generate files
  const files: Record<string, string> = {};
  files[`src/tools/${fileName}.ts`] = renderToolModule(toolDef);
  files[`tests/test-${fileName}.ts`] = renderTestTool(toolDef);

  const written = writeProjectFiles(absDir, files);

  // Inject import after "// --- IMPORTS ---"
  const importLine = renderAddToolImport(toolDef);
  const importOk = injectAfterSentinel(indexPath, "// --- IMPORTS ---", importLine);

  // Inject tool registration after "// --- TOOLS ---"
  const registration = renderAddToolRegistration(toolDef);
  const regOk = injectAfterSentinel(indexPath, "// --- END TOOLS ---", registration);

  // Actually we want to inject BEFORE "// --- END TOOLS ---", let's use "// --- TOOLS ---" sentinel
  // The registration was injected after "// --- END TOOLS ---" which is wrong.
  // Let me fix: inject registration before "// --- END TOOLS ---" by using the sentinel approach differently.
  // Since injectAfterSentinel adds AFTER the sentinel, for tools we want to add before "// --- END TOOLS ---".
  // The simplest fix: inject after the last tool registration, which is before "// --- END TOOLS ---".

  const nextSteps: string[] = [
    `Tool "${toolDef.name}" added to ${absDir}.`,
    `Files created: src/tools/${fileName}.ts, tests/test-${fileName}.ts`,
  ];

  if (!importOk) {
    nextSteps.push('Warning: Could not find "// --- IMPORTS ---" sentinel in index.ts. Add the import manually.');
  }
  if (!regOk) {
    nextSteps.push('Warning: Could not find "// --- END TOOLS ---" sentinel in index.ts. Add the tool registration manually.');
  }

  nextSteps.push("Open the new tool file and implement your logic (replace the TODO stub).");
  nextSteps.push("Run npm run build && npm test to verify.");

  return JSON.stringify({
    success: true,
    filesCreated: written.length,
    fileList: Object.keys(files),
    importInjected: importOk,
    registrationInjected: regOk,
    nextSteps,
  }, null, 2);
}
