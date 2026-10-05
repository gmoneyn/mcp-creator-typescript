#!/bin/bash
# Raw JSON-RPC contract check against a RUNNING server (MCP 2026-07-28, stateless).
# usage: scripts/smoke.sh [url]   (default http://localhost:3001/mcp)
# Exits non-zero on the first response that breaks the contract.
set -euo pipefail
URL="${1:-http://localhost:3001/mcp}"
URI="ui://harvest/mcp-app.html"
MIME="text/html;profile=mcp-app"
ENV='{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}}'

rpc() { # rpc <method> <params-json> [mcp-name]  -> raw JSON-RPC response on stdout
  local body
  body=$(node -e 'const [m,p,e]=process.argv.slice(1);const o=JSON.parse(p);o._meta=JSON.parse(e);console.log(JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:o}))' "$1" "$2" "$ENV")
  curl -sS --fail-with-body -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -H 'mcp-protocol-version: 2026-07-28' -H "mcp-method: $1" ${3:+-H "mcp-name: $3"} "$URL" -d "$body"
}

# check <label> <js-predicate-body over `r` (the JSON-RPC response)> <<< response
# Prints PASS/FAIL with the evidence; exits 1 on FAIL.
check() {
  node -e '
    const [label, pred] = process.argv.slice(1);
    const raw = require("fs").readFileSync(0, "utf8");
    let r; try { r = JSON.parse(raw); } catch { console.log(`FAIL ${label}: not JSON: ${raw.slice(0, 200)}`); process.exit(1); }
    let ok = false, why = "";
    try { const out = new Function("r", pred)(r); ok = out === true || (Array.isArray(out) && out[0] === true); why = Array.isArray(out) ? out[1] : ""; }
    catch (e) { why = String(e); }
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${why ? " :: " + why : ""}`);
    if (!ok) { console.log("  response: " + raw.slice(0, 400)); process.exit(1); }
  ' "$1" "$2"
}

rpc tools/list '{}' | check "tools/list: show_harvest links $URI; filter_harvest is app-only" "
  const t = Object.fromEntries(r.result.tools.map(x => [x.name, x]));
  return [t.show_harvest?._meta?.ui?.resourceUri === '$URI'
    && t.filter_harvest?._meta?.ui?.resourceUri === '$URI'
    && JSON.stringify(t.filter_harvest?._meta?.ui?.visibility) === '[\"app\"]',
    JSON.stringify({show: t.show_harvest?._meta, filter: t.filter_harvest?._meta})];"

rpc resources/read "{\"uri\":\"$URI\"}" "$URI" | check "resources/read: $MIME html bundle" "
  const c = r.result.contents[0];
  return [c.uri === '$URI' && c.mimeType === '$MIME' && /^<!doctype html>/i.test(c.text) && c.text.length > 1000,
    c.mimeType + ' ' + c.text.length + ' chars'];"

rpc tools/call '{"name":"show_harvest","arguments":{"category":"fruit"}}' show_harvest | check "tools/call show_harvest: text content + structuredContent" "
  const x = r.result;
  return [!x.isError && x.content?.[0]?.type === 'text' && x.content[0].text.includes('Apples (fruit): 420 crates')
    && x.structuredContent?.totalCrates === 695 && x.structuredContent.rows.length === 3,
    JSON.stringify(x.structuredContent)];"

rpc tools/call '{"name":"filter_harvest","arguments":{"category":"all","minCrates":300}}' filter_harvest | check "tools/call filter_harvest (valid) accepted" "
  const x = r.result;
  return [!x.isError && JSON.stringify(x.structuredContent?.rows?.map(r => r.name)) === '[\"Wheat\",\"Apples\",\"Carrots\"]',
    JSON.stringify(x.structuredContent?.rows?.map(r => r.name))];"

rpc tools/call '{"name":"filter_harvest","arguments":{"category":"fruit","minCrates":-5}}' filter_harvest | check "tools/call filter_harvest (minCrates -5) rejected server-side" "
  const x = r.result;
  return [x.isError === true && /Input validation error.*minCrates/.test(x.content?.[0]?.text ?? '') && x.structuredContent === undefined,
    x.content?.[0]?.text];"

rpc tools/call '{"name":"filter_harvest","arguments":{"category":"fruit","minCrates":1,"extra":"x"}}' filter_harvest | check "tools/call filter_harvest (unknown key) rejected server-side" "
  const x = r.result;
  return [x.isError === true && /Unrecognized key/.test(x.content?.[0]?.text ?? ''), x.content?.[0]?.text];"

echo "SMOKE PASS"
