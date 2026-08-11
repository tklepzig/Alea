// Runtime offline smoke test — the actual "100% offline" guarantee.
//
// Serves the built app, waits for the service worker to report "✓ Offline
// ready", then KILLS the server (real offline — network emulation doesn't
// reliably apply to service-worker fetches) and reloads. The app must come
// back entirely from the cache: hub renders, both games open, and not a single
// network request may fail.
//
// Run after `npm run build`: node scripts/offline-smoke.mjs

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { chromium } from "playwright";

const ROOT = process.cwd();
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const server = createServer(async (request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relative = urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath;
  const filePath = normalize(join(ROOT, relative));
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

const sockets = new Set();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;

const failures = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("requestfailed", (request) => {
  failures.push(`${request.failure()?.errorText} ${request.url()}`);
});
page.on("response", (response) => {
  if (response.status() >= 400) failures.push(`HTTP ${response.status()} ${response.url()}`);
});

async function expectVisible(selector, label) {
  try {
    await page.waitForSelector(selector, { state: "visible", timeout: 5000 });
    console.log(`  ✓ ${label}`);
  } catch {
    throw new Error(`OFFLINE SMOKE FAILED: ${label} (${selector} not visible)`);
  }
}

try {
  console.log(`Serving ${ROOT} at ${baseUrl}`);
  await page.goto(baseUrl);

  console.log("Waiting for '✓ Offline ready' …");
  await page.waitForSelector(".offline-status.ready", { timeout: 20000 });

  if (failures.length > 0) {
    throw new Error(`OFFLINE SMOKE FAILED: requests failed while online:\n${failures.join("\n")}`);
  }

  console.log("Going offline (stopping the server) and reloading …");
  await new Promise((resolve) => server.close(resolve));
  for (const socket of sockets) socket.destroy();

  await page.reload();
  await expectVisible("#card-quadra", "hub renders offline");

  await page.click("#card-quadra");
  await expectVisible("#q-btn-ai", "Quadra opens offline");
  await page.click("#q-btn-ai");
  await expectVisible("#q-btn-start-ai", "Quadra setup opens offline");

  await page.goto(`${baseUrl}#/ciphra`);
  await expectVisible("#c-btn-new", "Ciphra opens offline");

  await page.goto(`${baseUrl}#/dame`);
  await expectVisible("#d-btn-ai", "Dame opens offline");

  await page.goto(`${baseUrl}#/muehle`);
  await expectVisible("#m-btn-ai", "Mühle opens offline");

  await page.goto(`${baseUrl}#/halma`);
  await expectVisible("#h-btn-ai", "Halma opens offline");

  await page.goto(`${baseUrl}#/solohalma`);
  await expectVisible("#s-btn-new", "Solo-Halma opens offline");

  await page.goto(`${baseUrl}#/schach`);
  await expectVisible("#x-btn-ai", "Schach opens offline");

  // The SW itself and every asset must have come from the cache.
  if (failures.length > 0) {
    throw new Error(`OFFLINE SMOKE FAILED: requests failed while offline:\n${failures.join("\n")}`);
  }

  console.log("Offline smoke passed: app is fully usable without network.");
} finally {
  await browser.close();
  server.close();
  for (const socket of sockets) socket.destroy();
}
