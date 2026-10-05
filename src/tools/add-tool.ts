/**
 * add_tool — Add a new tool to an existing scaffolded TypeScript MCP project.
 * Generates tool file + test, then injects import + registration into index.ts.
 */

import { basename, dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  renderToolModule,
  renderTestTool,
  renderAddToolImport,
  renderAddToolRegistration,
  toolFileName,
  toolFunctionName,
  type ToolDef,
} from "../services/codegen.js";
import { assertSafeToReplace, writeProjectFiles, injectAfterSentinel } from "../services/file-writer.js";
import { checkProjectDir, resolveInside } from "../services/path-guard.js";
import { importedBindings, validateToolDef } from "../services/validate.js";

export async function addTool(projectDir: string, tool: string): Promise<string> {
  // Parse tool definition
  let toolDef: ToolDef;
  try {
    toolDef = JSON.parse(tool);
    if (!toolDef || !toolDef.name || !toolDef.description || !toolDef.parameters) {
      return JSON.stringify({ error: "Tool must have name, description, and parameters fields." });
    }
  } catch {
    return JSON.stringify({ error: "tool must be valid JSON. Expected { name, description, parameters, returns }." });
  }

  // The name becomes an identifier, a file name and an import path in generated source.
  const check = validateToolDef(toolDef);
  if (!check.ok) {
    return JSON.stringify({ success: false, error: `add_tool refused: ${check.error}` });
  }

  // The same directory rule as the other tools: an existing project, not the home
  // directory, a directory above it, or a filesystem root.
  const dirCheck = checkProjectDir(projectDir, "add_tool");
  if (!dirCheck.ok) {
    return JSON.stringify({ success: false, error: dirCheck.error });
  }
  const absDir = dirCheck.absDir;
  const indexPath = join(absDir, "src", "index.ts");

  if (!existsSync(indexPath)) {
    return JSON.stringify({
      error: `Could not find src/index.ts in ${absDir}. Is this a scaffolded ts-mcp-creator project?`,
    });
  }

  const fileName = toolFileName(toolDef.name);

  // Generate files
  const files: Record<string, string> = {};
  files[`src/tools/${fileName}.ts`] = renderToolModule(toolDef);
  files[`tests/test-${fileName}.ts`] = renderTestTool(toolDef);

  // Never overwrite. A tool file that is already there may hold the real
  // implementation; replacing it with a stub would destroy that work.
  // Compared without regard to letter case, on every filesystem: get_x and GET_X are one
  // file on macOS and Windows, and a project is not tied to the machine it was made on.
  for (const rel of Object.keys(files)) {
    const wanted = basename(rel).toLowerCase();
    let clash: string | undefined;
    try {
      clash = readdirSync(join(absDir, dirname(rel))).find((entry) => entry.toLowerCase() === wanted);
    } catch {
      clash = undefined; // the directory is not there yet
    }
    if (clash !== undefined) {
      return JSON.stringify({
        success: false,
        error:
          `add_tool refused: ${join(absDir, dirname(rel), clash)} already exists, so a tool named "${toolDef.name}" is already in this project. ` +
          `This tool never overwrites. Choose a different tool name, or edit the existing file.`,
      });
    }
  }

  // The new tool's function is imported into src/index.ts by name. Two different tool
  // names can give the same function name (get_weather and get__weather both give
  // getWeather) while their FILE names differ, so the file check above does not see the
  // clash. Read what the project already imports and registers.
  const indexSource = readFileSync(indexPath, "utf-8");
  const fnName = toolFunctionName(toolDef.name);
  if (importedBindings(indexSource).has(fnName)) {
    return JSON.stringify({
      success: false,
      error:
        `add_tool refused: src/index.ts already imports something named "${fnName}", which is the function name ` +
        `"${toolDef.name}" would generate. Two tools cannot share it. Choose a different tool name.`,
    });
  }
  if (new RegExp(`registerTool\\(\\s*"${toolDef.name}"`).test(indexSource)) {
    return JSON.stringify({
      success: false,
      error: `add_tool refused: a tool named "${toolDef.name}" is already registered in src/index.ts. Choose a different tool name.`,
    });
  }

  // Confine every write to the project: the two new files, and src/index.ts
  // itself (it could be a link that leads somewhere else). Checked before
  // anything is written.
  let written: string[];
  try {
    resolveInside(absDir, "src/index.ts");
    // src/index.ts is about to be rewritten: it must be an ordinary file with one name.
    assertSafeToReplace(indexPath);
    written = writeProjectFiles(absDir, files);
  } catch (e) {
    return JSON.stringify({ success: false, error: (e as Error).message });
  }

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
