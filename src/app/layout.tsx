import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Cognara AI - 证据驱动的智能研究",
    template: "%s | Cognara AI",
  },
  description: "AI 驱动的商业研究、用户访谈和消费者洞察平台。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
