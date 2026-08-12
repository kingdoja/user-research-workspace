import * as cheerio from "cheerio";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type PublicWebSource = {
  title: string;
  url: string;
  excerpt: string;
};

export type PublicWebSearchMetadata = {
  primaryProvider: "tavily" | "bing";
  fallbackUsed: boolean;
  seedSourceCount: number;
  searchSourceCount: number;
  finalSourceCount: number;
};

const SEARCH_RESULT_LIMIT = 12;
const PAGE_TEXT_LIMIT = 5000;
const RESPONSE_BYTE_LIMIT = 1_500_000;

export function getPublicWebSearchStatus() {
  const tavilyConfigured = Boolean(process.env.TAVILY_API_KEY?.trim());

  return {
    tavilyConfigured,
    primaryProvider: tavilyConfigured ? "tavily" : "bing",
    fallbackProvider: "bing",
  } as const;
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase();

  if (normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }

  const parts = normalized.split(".").map(Number);

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }

  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

async function assertPublicUrl(value: string) {
  const url = new URL(value);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("UNSAFE_SOURCE_URL");
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("UNSAFE_SOURCE_URL");
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("UNSAFE_SOURCE_URL");
    }
  } else {
    const addresses = await lookup(hostname, { all: true });

    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("UNSAFE_SOURCE_URL");
    }
  }

  return url;
}

async function readLimitedText(response: Response) {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  while (bytesRead < RESPONSE_BYTE_LIMIT) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    bytesRead += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }

  await reader.cancel().catch(() => undefined);
  return text + decoder.decode();
}

async function fetchPublicPage(value: string) {
  let url = await assertPublicUrl(value);

  for (let redirectCount = 0; redirectCount < 4; redirectCount += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; atypica-research/1.0)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");

      if (!location) {
        throw new Error("SOURCE_REDIRECT_MISSING");
      }

      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw new Error(`SOURCE_HTTP_${response.status}`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      throw new Error("SOURCE_NOT_TEXT");
    }

    return { url: url.toString(), html: await readLimitedText(response) };
  }

  throw new Error("SOURCE_TOO_MANY_REDIRECTS");
}

function extractPageText(html: string) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, nav, footer, form").remove();
  const root = $("article").first().length > 0
    ? $("article").first()
    : $("main").first().length > 0
      ? $("main").first()
      : $("body");

  return root.text().replace(/\s+/g, " ").trim().slice(0, PAGE_TEXT_LIMIT);
}

function extractPageTitle(html: string, fallbackUrl: string) {
  const $ = cheerio.load(html);
  return $("meta[property='og:title']").attr("content")?.trim()
    || $("title").first().text().replace(/\s+/g, " ").trim()
    || $("h1").first().text().replace(/\s+/g, " ").trim()
    || new URL(fallbackUrl).hostname;
}

async function collectSeedSources(seedUrls: string[]) {
  const results = await Promise.all(seedUrls.slice(0, 16).map(async (seedUrl) => {
    try {
      const page = await fetchPublicPage(seedUrl);
      const excerpt = extractPageText(page.html);

      if (excerpt.length < 120) {
        return null;
      }

      return {
        title: extractPageTitle(page.html, page.url),
        url: page.url,
        excerpt,
      } satisfies PublicWebSource;
    } catch {
      return null;
    }
  }));

  return results.filter((source): source is PublicWebSource => source !== null);
}

async function searchBing(query: string) {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("setlang", "zh-hans");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; atypica-research/1.0)",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
    },
  });

  if (!response.ok) {
    throw new Error(`SEARCH_HTTP_${response.status}`);
  }

  const $ = cheerio.load(await response.text());
  const results: PublicWebSource[] = [];

  $("li.b_algo").each((_, element) => {
    const link = $(element).find("h2 a").first();
    const title = link.text().replace(/\s+/g, " ").trim();
    const href = link.attr("href");
    const excerpt = $(element).find(".b_caption p").first().text().replace(/\s+/g, " ").trim();

    if (!title || !href || !excerpt) {
      return;
    }

    try {
      const resultUrl = new URL(href);

      if (resultUrl.protocol !== "https:" && resultUrl.protocol !== "http:") {
        return;
      }
    } catch {
      return;
    }

    results.push({ title, url: href, excerpt });
  });

  return results.slice(0, 6);
}

async function searchTavily(query: string, apiKey: string) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "advanced",
      max_results: 6,
      include_answer: false,
      include_raw_content: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`TAVILY_HTTP_${response.status}`);
  }

  const payload = await response.json() as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      raw_content?: string | null;
    }>;
  };

  return (payload.results ?? []).flatMap((result) => {
    const title = result.title?.replace(/\s+/g, " ").trim();
    const url = result.url?.trim();
    const excerpt = (result.raw_content || result.content || "").replace(/\s+/g, " ").trim().slice(0, PAGE_TEXT_LIMIT);

    if (!title || !url || !excerpt) {
      return [];
    }

    try {
      const parsedUrl = new URL(url);

      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        return [];
      }
    } catch {
      return [];
    }

    return [{ title, url, excerpt }];
  });
}

function deduplicateSources(groups: PublicWebSource[][]) {
  const unique = new Map<string, PublicWebSource>();

  for (const result of groups.flat()) {
    if (!unique.has(result.url)) {
      unique.set(result.url, result);
    }
  }

  return [...unique.values()].slice(0, SEARCH_RESULT_LIMIT);
}

export async function collectPublicWebSources(queries: string[], seedUrls: string[]) {
  const seedSources = deduplicateSources([await collectSeedSources(seedUrls)]);
  const tavilyApiKey = process.env.TAVILY_API_KEY?.trim();

  if (tavilyApiKey) {
    const tavilyGroups = await Promise.all(queries.map(async (query) => {
      try {
        return await searchTavily(query, tavilyApiKey);
      } catch {
        return [];
      }
    }));
    const tavilySources = deduplicateSources([seedSources, ...tavilyGroups]);

    if (tavilySources.length >= 6) {
      return {
        sources: tavilySources,
        metadata: {
          primaryProvider: "tavily",
          fallbackUsed: false,
          seedSourceCount: seedSources.length,
          searchSourceCount: Math.max(0, tavilySources.length - seedSources.length),
          finalSourceCount: tavilySources.length,
        } satisfies PublicWebSearchMetadata,
      };
    }
  }

  if (seedSources.length >= 6) {
    return {
      sources: seedSources,
      metadata: {
        primaryProvider: tavilyApiKey ? "tavily" : "bing",
        fallbackUsed: false,
        seedSourceCount: seedSources.length,
        searchSourceCount: 0,
        finalSourceCount: seedSources.length,
      } satisfies PublicWebSearchMetadata,
    };
  }

  const searchGroups = await Promise.all(queries.map(async (query) => {
    try {
      return await searchBing(query);
    } catch {
      return [];
    }
  }));
  const candidates = deduplicateSources([seedSources, ...searchGroups]);
  const enriched = await Promise.all(candidates.map(async (source) => {
    try {
      const page = await fetchPublicPage(source.url);
      const pageText = extractPageText(page.html);

      return pageText.length >= 120
        ? { ...source, url: page.url, excerpt: pageText }
        : source;
    } catch {
      return source;
    }
  }));

  return {
    sources: enriched,
    metadata: {
      primaryProvider: tavilyApiKey ? "tavily" : "bing",
      fallbackUsed: Boolean(tavilyApiKey),
      seedSourceCount: seedSources.length,
      searchSourceCount: Math.max(0, enriched.length - seedSources.length),
      finalSourceCount: enriched.length,
    } satisfies PublicWebSearchMetadata,
  };
}
