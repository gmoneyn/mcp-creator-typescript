/**
 * ui-app-fixture — Remote MCP server (Streamable HTTP), stateless per request.
 * Mirrors the shape ts-mcp-creator emits for hosting=remote (codegen.ts
 * renderRemoteIndex), plus an opt-in CORS allowlist for browser-based hosts.
 */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import type { NextFunction, Request, Response } from "express";
import { createServer } from "./server.js";

// MCP 2026-07-28: no sessions. createMcpHandler takes a factory and serves
// each request independently.
const handler = createMcpHandler(createServer);

const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (allowedHosts.length === 0) {
  // FAIL CLOSED — binding 0.0.0.0 turns off the automatic localhost
  // Host/Origin allowlist, so an unset MCP_ALLOWED_HOSTS means no validation.
  console.error(
    "[mcp] REFUSING TO START: binding 0.0.0.0 requires MCP_ALLOWED_HOSTS " +
    "(comma-separated Host values), otherwise Host/Origin validation is disabled " +
    "and the server is exposed to DNS-rebinding. Example: MCP_ALLOWED_HOSTS=my.host,localhost"
  );
  process.exit(1);
}

// Browser-based MCP hosts (e.g. ext-apps basic-host) call this server
// cross-origin, so they need CORS. Opt-in, exact-origin allowlist only — never
// a wildcard. Unset = no CORS headers at all (server-side hosts don't need them).
const corsOrigins = new Set(
  (process.env.MCP_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });
const nodeHandler = toNodeHandler(handler);

app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && corsOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ?? "content-type, accept, mcp-protocol-version",
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
  }
  next();
});

// createMcpExpressApp installs express.json(), so the request stream is
// already drained; forward the parsed body explicitly (see codegen.ts).
app.all("/mcp", (req, res) => nodeHandler(req, res, req.body));

const port = parseInt(process.env.PORT || "8000");
app.listen(port, "0.0.0.0", () => {
  console.log(`MCP server running on http://0.0.0.0:${port}/mcp`);
});
