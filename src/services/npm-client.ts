/**
 * npm-client.ts — Check npm package name availability via the registry API.
 */

interface NpmCheckResult {
  name: string;
  available: boolean | null;
  existingVersion?: string;
  existingDescription?: string;
  suggestion?: string;
  error?: string;
}

const NPM_REGISTRY_URL = "https://registry.npmjs.org";

export async function checkNpmName(name: string): Promise<NpmCheckResult> {
  try {
    const res = await fetch(`${NPM_REGISTRY_URL}/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 404) {
      return {
        name,
        available: true,
      };
    }

    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      const latest = (data["dist-tags"] as Record<string, string>)?.latest;
      const desc = data.description as string | undefined;

      return {
        name,
        available: false,
        existingVersion: latest,
        existingDescription: desc,
        suggestion: `"${name}" is taken. Try "${name}-mcp" or "mcp-${name}".`,
      };
    }

    return {
      name,
      available: null,
      error: `npm registry returned HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      name,
      available: null,
      error: `Failed to check: ${(e as Error).message}`,
    };
  }
}
