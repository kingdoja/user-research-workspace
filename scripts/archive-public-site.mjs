import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const ORIGIN = "https://atypica.ai";
const OUTPUT_ROOT = path.resolve("recovery/reference/refresh");

const CORE_PATHS = [
  "/",
  "/pricing",
  "/technology",
  "/usecases",
  "/featured-studies",
  "/insight-radio",
  "/persona",
  "/interview",
  "/sage",
  "/about",
  "/enterprise",
  "/persona-simulation",
  "/features",
  "/faq",
  "/guides",
  "/glossary",
  "/docs/api",
  "/auth/signin",
  "/auth/signup",
  "/startup-owners",
  "/product-managers",
  "/marketers",
  "/influencers",
  "/creators",
  "/consultants",
];

function routeFilename(route) {
  if (route === "/") return "home.html";
  return `${route.slice(1).replaceAll("/", "--")}.html`;
}

function assetFilename(url) {
  const parsed = new URL(url);
  const base = path.basename(parsed.pathname) || "asset";
  const suffix = createHash("sha1").update(url).digest("hex").slice(0, 10);
  return `${suffix}-${base}`;
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "atypica-recovery-archiver/1.0" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type"),
    finalUrl: response.url,
    status: response.status,
  };
}

await mkdir(path.join(OUTPUT_ROOT, "pages"), { recursive: true });
await mkdir(path.join(OUTPUT_ROOT, "assets"), { recursive: true });

const routeRecords = [];
const assetUrls = new Set();

for (const route of CORE_PATHS) {
  const url = new URL(route, ORIGIN).href;
  try {
    const result = await fetchBuffer(url);
    const html = result.body.toString("utf8");
    const filename = routeFilename(route);
    await writeFile(path.join(OUTPUT_ROOT, "pages", filename), result.body);

    const $ = cheerio.load(html);
    $("script[src], link[href]").each((_, element) => {
      const value = $(element).attr("src") ?? $(element).attr("href");
      if (!value) return;
      const asset = new URL(value, result.finalUrl);
      if (asset.origin !== ORIGIN) return;
      if (!asset.pathname.startsWith("/_next/static/") && !asset.pathname.startsWith("/_public/")) return;
      assetUrls.add(asset.href);
    });

    routeRecords.push({
      route,
      requestedUrl: url,
      finalUrl: result.finalUrl,
      status: result.status,
      title: $("title").first().text().trim(),
      headings: $("h1,h2,h3").map((_, element) => $(element).text().trim()).get().filter(Boolean),
      file: `pages/${filename}`,
      bytes: result.body.length,
    });
  } catch (error) {
    routeRecords.push({ route, requestedUrl: url, error: String(error) });
  }
}

const assetRecords = [];
for (const url of [...assetUrls].sort()) {
  try {
    const result = await fetchBuffer(url);
    const filename = assetFilename(url);
    await writeFile(path.join(OUTPUT_ROOT, "assets", filename), result.body);
    assetRecords.push({
      url,
      finalUrl: result.finalUrl,
      contentType: result.contentType,
      bytes: result.body.length,
      file: `assets/${filename}`,
    });
  } catch (error) {
    assetRecords.push({ url, error: String(error) });
  }
}

const evidenceFiles = ["/sitemap.xml", "/robots.txt", "/manifest.json"];
for (const route of evidenceFiles) {
  const result = await fetchBuffer(new URL(route, ORIGIN).href);
  await writeFile(path.join(OUTPUT_ROOT, path.basename(route)), result.body);
}

const manifest = {
  capturedAt: new Date().toISOString(),
  origin: ORIGIN,
  privacyBoundary: "Core public product pages only. Report, study, podcast, and other user-generated share URLs are excluded.",
  routes: routeRecords,
  assets: assetRecords,
};

await writeFile(path.join(OUTPUT_ROOT, "archive-manifest.json"), JSON.stringify(manifest, null, 2));

const successfulRoutes = routeRecords.filter((record) => !record.error).length;
const successfulAssets = assetRecords.filter((record) => !record.error).length;
console.log(`Archived ${successfulRoutes}/${routeRecords.length} routes and ${successfulAssets}/${assetRecords.length} static assets.`);
