/**
 * In-process protocol tests: drives the SAME createMcpHandler(createServer)
 * the HTTP entry mounts, with raw 2026-07-28 JSON-RPC requests (no client SDK),
 * so what is asserted is the wire shape a host sees.
 * The resources/read test needs the UI bundle: run `npm run build:ui` first
 * (`npm run build` does).
 */
import { readFileSync } from "node:fs";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { describe, expect, it } from "vitest";
import { RESOURCE_URI, createServer } from "../src/server.js";

const handler = createMcpHandler(createServer);

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const name = (params.name ?? params.uri) as string | undefined;
  const res = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  return (await res.json()) as { result?: any; error?: any };
}

describe("ui-app fixture", () => {
  it("links the UI tool to its ui:// resource and marks the helper app-only", async () => {
    const { result } = await rpc("tools/list");
    const byName = Object.fromEntries(result.tools.map((t: any) => [t.name, t]));
    expect(byName.show_harvest._meta.ui.resourceUri).toBe(RESOURCE_URI);
    expect(byName.show_harvest._meta.ui.visibility).toBeUndefined();
    expect(byName.filter_harvest._meta.ui.visibility).toEqual(["app"]);
  });

  it("serves the UI resource as a single HTML file with the MCP Apps mime type and no-network CSP", async () => {
    const { result, error } = await rpc("resources/read", { uri: RESOURCE_URI });
    expect(error).toBeUndefined();
    const c = result.contents[0];
    expect(c.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(c.text).toMatch(/^<!doctype html>/i);
    expect(c.text).not.toMatch(/<script[^>]+src=/i); // everything inlined
    expect(c.text).toContain("connect-src 'none'");
    expect(c._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
  });

  it("returns text content AND structuredContent (text-only hosts still get an answer)", async () => {
    const { result } = await rpc("tools/call", { name: "show_harvest", arguments: { category: "grain" } });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Wheat (grain): 510 crates");
    expect(result.structuredContent).toEqual({
      category: "grain",
      minCrates: 0,
      rows: [
        { name: "Wheat", category: "grain", crates: 510 },
        { name: "Oats", category: "grain", crates: 150 },
      ],
      totalCrates: 660,
    });
  });

  it("accepts a valid call to the app-only tool", async () => {
    const { result } = await rpc("tools/call", { name: "filter_harvest", arguments: { category: "all", minCrates: 300 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.rows.map((r: any) => r.name)).toEqual(["Wheat", "Apples", "Carrots"]);
  });

  it.each([
    [{ category: "meat", minCrates: 1 }],
    [{ category: "fruit", minCrates: -5 }],
    [{ category: "fruit", minCrates: 1.5 }],
    [{ category: "fruit", minCrates: 10_001 }],
    [{ category: "fruit" }],
    [{ category: "fruit", minCrates: 1, extra: "x" }],
  ])("rejects invalid app-only input server-side: %j", async (args) => {
    const { result } = await rpc("tools/call", { name: "filter_harvest", arguments: args });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Input validation error/);
    expect(result.structuredContent).toBeUndefined();
  });

  it("UI source uses no HTML-string sinks", () => {
    const src = readFileSync(new URL("../ui/mcp-app.ts", import.meta.url), "utf-8");
    expect(src).not.toMatch(/\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
  });
});
