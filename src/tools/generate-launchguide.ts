/**
 * generate_launchguide — Generate LAUNCHGUIDE.md for MCP Marketplace submission.
 */

import { resolve, join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { renderLaunchguide } from "../services/codegen.js";

export async function generateLaunchguide(
  projectDir: string,
  packageName: string,
  tagline: string,
  description: string,
  category: string,
  features: string,
  tags: string,
  setupRequirements?: string,
  docsUrl?: string
): Promise<string> {
  const absDir = resolve(projectDir);
  const filePath = join(absDir, "LAUNCHGUIDE.md");

  const content = renderLaunchguide({
    packageName,
    tagline,
    description,
    category,
    features,
    tags,
    setupRequirements,
    docsUrl,
  });

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");

  return JSON.stringify({
    success: true,
    filePath,
    nextSteps: [
      `LAUNCHGUIDE.md written to ${filePath}`,
      "Review the file and submit it to the MCP Marketplace at https://mcpmarketplace.com",
    ],
  }, null, 2);
}
