/**
 * MCP server factory for the ui-app fixture.
 *
 * One factory, called per request by createMcpHandler (stateless 2026-07-28
 * model) and per connection by serveStdio. No per-session state, no
 * `oninitialized` capability sniffing: every tool result carries BOTH a text
 * `content` answer and `structuredContent`, so a host that ignores UI still
 * gets a complete answer.
 */
import { McpServer } from "@modelcontextprotocol/server";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CategoryFilter, HarvestResult, filterHarvest, harvestToText } from "./data.js";

export const RESOURCE_URI = "ui://harvest/mcp-app.html";

// The UI bundle lives in dist-ui/, a SIBLING of dist/, because tsup's
// `clean: true` wipes dist/ on every server build. Resolved relative to this
// module, so it works from src/ (tests) and from dist/ (built server) alike.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const UI_HTML_PATH = path.resolve(MODULE_DIR, "..", "dist-ui", "mcp-app.html");

async function readUiHtml(): Promise<string> {
  try {
    return await fs.readFile(UI_HTML_PATH, "utf-8");
  } catch (e) {
    // Fail loud — never serve an empty resource. Full path + cause go to the
    // server log only; the client gets the fix, not our filesystem layout.
    console.error(`[mcp] cannot read UI bundle at ${UI_HTML_PATH}:`, e);
    throw new Error("UI bundle not built (run `npm run build:ui`)");
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "ui-app-fixture", version: "1.0.0" });

  // --- Model-visible tool with a UI -------------------------------------
  registerAppTool(
    server,
    "show_harvest",
    {
      title: "Show harvest",
      description:
        "Show crate counts from a fixed sample harvest dataset, optionally filtered by category. Renders an interactive bar chart in hosts that support MCP Apps; returns a text table otherwise.",
      inputSchema: z.object({
        category: CategoryFilter.default("all").describe(
          'Category to show: "all", "fruit", "vegetable" or "grain".',
        ),
      }),
      outputSchema: HarvestResult,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ category }) => {
      const result = filterHarvest(category);
      return {
        content: [{ type: "text", text: harvestToText(result) }],
        structuredContent: result,
      };
    },
  );

  // --- App-only helper tool ---------------------------------------------
  // visibility: ["app"] asks the HOST to hide this tool from the model. It is
  // NOT access control: any client can still call it over the wire, so the
  // input is validated server-side by this zod schema exactly like any other
  // tool (.strict() also rejects unknown keys).
  registerAppTool(
    server,
    "filter_harvest",
    {
      title: "Filter harvest (app-only)",
      description: "Re-filter the harvest dataset. Called by the harvest UI, not by the model.",
      inputSchema: z
        .object({
          category: CategoryFilter,
          minCrates: z.number().int().min(0).max(10_000),
        })
        .strict(),
      outputSchema: HarvestResult,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async ({ category, minCrates }) => {
      const result = filterHarvest(category, minCrates);
      return {
        content: [{ type: "text", text: harvestToText(result) }],
        structuredContent: result,
      };
    },
  );

  // --- UI resource ---------------------------------------------------------
  registerAppResource(
    server,
    "Harvest chart UI",
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Bar chart + table for show_harvest." },
    async () => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readUiHtml(),
          // No network: empty domain allowlists. The host's CSP therefore
          // permits no fetch/XHR/WebSocket and no external scripts/styles.
          // The HTML also carries its own `connect-src 'none'` meta CSP.
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }),
  );

  return server;
}
