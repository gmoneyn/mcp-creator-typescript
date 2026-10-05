/**
 * generate_launchguide — Generate LAUNCHGUIDE.md for MCP Marketplace submission.
 */

import { resolve } from "node:path";
import { renderLaunchguide, MARKETPLACE_SUBMIT_URL } from "../services/codegen.js";
import { forbiddenDirReason, resolveInside } from "../services/path-guard.js";
import { writeProjectFiles } from "../services/file-writer.js";
import { validateText } from "../services/validate.js";

export async function generateLaunchguide(
  projectDir: string,
  packageName: string,
  tagline: string,
  description: string,
  category: string,
  features: string,
  tags: string,
  setupRequirements?: string,
  docsUrl?: string,
  useCases?: string,
  gettingStarted?: string
): Promise<string> {
  // Every field ends up in a file the marketplace reads. Each must be a string of a
  // sane length; what the text may contain is handled where it is written (markdown.ts).
  const LINE = 500;
  const BLOCK = 10_000;
  const fields: Array<[string, unknown, boolean, number]> = [
    ["package_name", packageName, true, 214],
    ["tagline", tagline, true, LINE],
    ["description", description, true, BLOCK],
    ["category", category, true, LINE],
    ["features", features, true, BLOCK],
    ["tags", tags, true, 2000],
    ["setup_requirements", setupRequirements, false, BLOCK],
    ["docs_url", docsUrl, false, 2000],
    ["use_cases", useCases, false, 2000],
    ["getting_started", gettingStarted, false, BLOCK],
  ];
  for (const [name, value, required, max] of fields) {
    const check = validateText(value, name, required, max);
    if (!check.ok) {
      return JSON.stringify({ success: false, error: `generate_launchguide refused: ${check.error}` });
    }
  }

  const absDir = resolve(projectDir);

  let filePath: string;
  try {
    const forbidden = forbiddenDirReason(absDir);
    if (forbidden) {
      return JSON.stringify({ success: false, error: `generate_launchguide refused: ${forbidden}` });
    }
    // Refuses when LAUNCHGUIDE.md is a link that leads out of the project.
    filePath = resolveInside(absDir, "LAUNCHGUIDE.md");
  } catch (e) {
    return JSON.stringify({ success: false, error: (e as Error).message });
  }

  const content = renderLaunchguide({
    packageName,
    tagline,
    description,
    category,
    features,
    tags,
    setupRequirements,
    docsUrl,
    useCases,
    gettingStarted,
  });

  // Through the same writer as every other generated file: confined, never through a
  // link, never over a file that has a second name somewhere else.
  try {
    writeProjectFiles(absDir, { "LAUNCHGUIDE.md": content });
  } catch (e) {
    return JSON.stringify({ success: false, error: `generate_launchguide refused: ${(e as Error).message}` });
  }

  return JSON.stringify({
    success: true,
    filePath,
    nextSteps: [
      `LAUNCHGUIDE.md written to ${filePath}`,
      `Review the file and submit it to the MCP Marketplace at ${MARKETPLACE_SUBMIT_URL}`,
    ],
  }, null, 2);
}
