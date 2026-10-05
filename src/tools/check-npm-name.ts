/**
 * check_npm_name — Check if an npm package name is available.
 */

import { checkNpmName } from "../services/npm-client.js";

export async function checkNpmNameTool(packageName: string): Promise<string> {
  const result = await checkNpmName(packageName);

  const nextSteps: string[] = [];
  if (result.available === true) {
    nextSteps.push(`"${packageName}" is available on npm! Use scaffold_server to create your project.`);
  } else if (result.available === false) {
    nextSteps.push(result.suggestion ?? `Try a different name.`);
  } else {
    nextSteps.push("Could not determine availability. Check your network and try again.");
  }

  return JSON.stringify({
    ...result,
    nextSteps,
  }, null, 2);
}
