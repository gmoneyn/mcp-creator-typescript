// End-to-end proof in a real MCP Apps host (ext-apps basic-host).
//
// usage: node scripts/basic-host-e2e.mjs [screenshot-dir]
//   needs: `playwright` resolvable + Google Chrome; basic-host on :8080 with
//   SERVERS='["http://localhost:3001/mcp"]'; this server on :3001 with
//   MCP_CORS_ORIGINS=http://localhost:8080. Starts its own CSP probe target on
//   PROBE_PORT (default 3999). Exits 1 if ANY check fails (all checks run).
import http from "node:http";
import { chromium } from "playwright";

const OUT = process.argv[2] ?? ".";
const PROBE_PORT = Number(process.env.PROBE_PORT ?? 3999);
const PROBE = `http://localhost:${PROBE_PORT}`;
const log = (...a) => console.log(...a);
const failures = [];
function check(name, ok, detail) {
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}

// --- CSP probe target: requests here WOULD succeed without CSP -------------
// CORS-open JSON endpoint + a real 1x1 PNG, so a failure can only come from CSP.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const probeServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/ok") { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); return; }
  if (req.url === "/pixel.png") { res.setHeader("content-type", "image/png"); res.end(PNG); return; }
  res.statusCode = 404; res.end();
});
await new Promise((r) => probeServer.listen(PROBE_PORT, "127.0.0.1", r));

const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const eras = new Set();
  page.on("request", (r) => {
    if (r.url().includes(":3001") && r.method() === "POST")
      eras.add(`${r.headers()["mcp-protocol-version"] ?? "(no header)"} ${JSON.parse(r.postData() ?? "{}").method}`);
  });

  // Race harness: delay the "grain" filter call so it resolves AFTER a newer one.
  let grainDone;
  const grainFinished = new Promise((r) => (grainDone = r));
  await page.route("http://localhost:3001/mcp", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes('"filter_harvest"') && body.includes('"grain"')) {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
      return;
    }
    await route.continue();
  });
  page.on("requestfinished", (r) => {
    const b = r.postData() ?? "";
    if (b.includes('"filter_harvest"') && b.includes('"grain"')) grainDone();
  });

  await page.goto("http://localhost:8080/index.html");
  const selects = page.locator("select");
  await page.waitForFunction(() => document.querySelectorAll("select")[1]?.options.length > 0, null, { timeout: 15000 });
  check("host has server + tool selects", (await selects.count()) === 2, await selects.count());
  const toolSelect = selects.nth(1); // index.tsx form order: [0]=server, [1]=tool
  const toolOptions = await toolSelect.locator("option").allTextContents();
  check("host lists only the model-visible tool", JSON.stringify(toolOptions) === '["show_harvest"]', toolOptions);
  await toolSelect.selectOption("show_harvest");
  await page.locator("textarea").fill('{"category":"fruit"}');
  await page.getByRole("button", { name: "Call Tool" }).click();

  let app;
  for (let i = 0; i < 100 && !app; i++) {
    for (const f of page.frames()) {
      if (await f.locator("#root[data-source]").count().catch(() => 0)) { app = f; break; }
    }
    if (!app) await page.waitForTimeout(200);
  }
  if (!app) throw new Error("app frame never rendered a tool result");

  // 1. Render from the model-visible tool
  check("renders show_harvest result", (await app.locator("#rows tr").count()) === 3 && (await app.locator("#total").textContent()) === "695",
    await app.locator("#status").textContent());
  await page.screenshot({ path: `${OUT}/01-rendered-show_harvest.png`, fullPage: true });

  // 2. UI -> app-only tool
  await app.locator("#category").selectOption("all");
  await app.locator("#min-crates").fill("200");
  await app.locator("#apply").click();
  await app.locator('#root[data-source="filter_harvest"]').waitFor({ timeout: 10000 });
  const rows2 = await app.locator("#rows tr td:first-child").allTextContents();
  check("UI called filter_harvest and re-rendered", JSON.stringify(rows2) === '["Wheat","Apples","Carrots","Squash"]', rows2);
  await page.screenshot({ path: `${OUT}/02-ui-called-filter_harvest.png`, fullPage: true });

  // 3. UI -> app-only tool with invalid input: the SERVER rejects it
  await app.locator("#min-crates").fill("-5");
  await app.locator("#apply").click();
  await app.locator("#status", { hasText: "rejected" }).waitFor({ timeout: 10000 });
  const st3 = await app.locator("#status").textContent();
  check("server rejection of minCrates -5 shown in UI", /Input validation error.*minCrates/.test(st3), st3);
  await page.screenshot({ path: `${OUT}/03-ui-invalid-rejected.png`, fullPage: true });

  // 4. Race: older "grain" request resolves after newer "fruit" one; fruit must win.
  await app.locator("#min-crates").fill("0");
  await app.locator("#category").selectOption("grain");
  await app.locator("#apply").click(); // older, delayed 1500ms by the route
  await app.locator("#category").selectOption("fruit");
  await app.locator("#apply").click(); // newer, immediate
  await app.locator("#status", { hasText: "3 rows" }).waitFor({ timeout: 10000 });
  await grainFinished; // the stale response has now reached the page
  await page.waitForTimeout(300); // let the app frame process it (bounded; the event above is the real gate)
  const rows4 = await app.locator("#rows tr td:first-child").allTextContents();
  const sel4 = await app.locator("#category").inputValue();
  check("race: superseded grain response dropped, fruit stays", JSON.stringify(rows4) === '["Apples","Pears","Cherries"]' && sel4 === "fruit", { rows: rows4, select: sel4 });

  // 5. CSP. Positive control first: from the HOST page (no app CSP) the probe
  //    target is reachable, so a failure inside the app frame cannot be "target down".
  const ctlFetch = await page.evaluate((u) => fetch(u).then((r) => `ALLOWED ${r.status}`, (e) => `failed: ${e}`), `${PROBE}/ok`);
  const ctlImg = await page.evaluate((u) => new Promise((res) => { const i = new Image(); i.onload = () => res("ALLOWED"); i.onerror = () => res("failed"); i.src = u; }), `${PROBE}/pixel.png`);
  check("control: probe fetch succeeds outside the app frame", ctlFetch === "ALLOWED 200", ctlFetch);
  check("control: probe image loads outside the app frame", ctlImg === "ALLOWED", ctlImg);

  await app.evaluate(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__cspViolations.push({ blockedURI: e.blockedURI, directive: e.effectiveDirective, policy: e.originalPolicy.slice(0, 60) }));
  });
  const appFetch = await app.evaluate((u) => fetch(u).then((r) => `ALLOWED ${r.status}`, (e) => `failed: ${e}`), `${PROBE}/ok`);
  const appImg = await app.evaluate((u) => new Promise((res) => { const i = new Image(); i.onload = () => res("ALLOWED"); i.onerror = () => res("failed"); i.src = u; }), `${PROBE}/pixel.png`);
  await page.waitForTimeout(200); // violation events are dispatched async
  const violations = await app.evaluate(() => window.__cspViolations);
  log("app-frame probe:", { appFetch, appImg });
  log("securitypolicyviolation events:", JSON.stringify(violations, null, 1));
  const hit = (dir) => violations.some((v) => v.directive === dir && v.blockedURI.startsWith(PROBE));
  check("CSP: app-frame fetch to probe blocked by a connect-src violation", appFetch.startsWith("failed") && hit("connect-src"), appFetch);
  check("CSP: app-frame image from probe blocked by an img-src violation", appImg === "failed" && hit("img-src"), appImg);

  log("protocol version header x method seen from host:", [...eras].join(" | "));
} finally {
  await browser.close();
  probeServer.close();
}
if (failures.length) { log(`E2E FAIL (${failures.length}): ${failures.join("; ")}`); process.exitCode = 1; }
else log("E2E PASS");
