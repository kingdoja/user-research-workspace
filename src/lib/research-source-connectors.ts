import { getBlueskyPublicConnectorStatus } from "@/lib/bluesky-social-connector";

export type ResearchConnectorRegistration = {
  key: "public-web" | "bluesky-public";
  label: string;
  provider: "tavily" | "bing" | "bluesky";
  mode: "public_web" | "official_api";
  enabled: boolean;
  official: boolean;
  supportedPlatforms: string[];
  limitations: string[];
};

export function listResearchSourceConnectors(): ResearchConnectorRegistration[] {
  const bluesky = getBlueskyPublicConnectorStatus();
  return [
    {
      key: "public-web",
      label: "公开网页搜索",
      provider: process.env.TAVILY_API_KEY?.trim() ? "tavily" : "bing",
      mode: "public_web",
      enabled: true,
      official: false,
      supportedPlatforms: ["小红书", "抖音", "微博", "B站", "知乎"],
      limitations: ["只能使用搜索引擎收录的公开页面", "不访问登录内容，不执行站内爬虫"],
    },
    {
      key: "bluesky-public",
      label: "Bluesky 公开 API",
      provider: "bluesky",
      mode: "official_api",
      enabled: bluesky.enabled,
      official: true,
      supportedPlatforms: ["Bluesky"],
      limitations: ["仅返回公开帖子和公开互动字段", "受上游 API 限流和可用性影响"],
    },
  ];
}

