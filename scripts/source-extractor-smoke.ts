import assert from "node:assert/strict";
import { collectSourceCandidate, type SourceCandidate } from "../src/lib/source-connectors";

const html = `<!doctype html><html><head><title>Fallback title</title><meta property="og:title" content="Readable title"></head><body>
<nav>Navigation should be removed</nav><article><h1>Readable title</h1><p>${"This is durable public evidence with enough detail for the extractor regression test. ".repeat(5)}</p><script>window.injected = true</script></article><footer>Footer should be removed</footer>
</body></html>`;

const fetchImpl: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /", { status: 200, headers: { "content-type": "text/plain" } });
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
};
const lookupHost = async () => [{ address: "93.184.216.34" }];
const candidate: SourceCandidate = {
  publicId: "src_extractor_smoke",
  provider: "seed",
  query: null,
  rank: 1,
  score: null,
  title: "seed",
  url: "https://example.com/article?utm_source=test&b=2&a=1#section",
};

async function main() {
  const result = await collectSourceCandidate(candidate, { fetchImpl, lookupHost });
  assert.equal(result.status, "collected");
  assert.equal(result.canonicalUrl, "https://example.com/article?a=1&b=2");
  assert.match(result.resolvedTitle, /Readable title/);
  assert.match(result.snapshot?.normalizedText ?? "", /durable public evidence/);
  assert.doesNotMatch(result.snapshot?.normalizedText ?? "", /Navigation|Footer|window\.injected/);
  assert.equal(result.snapshot?.metadata.extractor, "readability-with-cheerio-fallback");
  console.log(JSON.stringify({ status: result.status, canonicalUrl: result.canonicalUrl, extractor: result.snapshot?.metadata.extractor }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
