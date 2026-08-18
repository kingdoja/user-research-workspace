"use client";

import {
  BookOpenText,
  Bot,
  Blocks,
  Coins,
  Command,
  Database,
  Files,
  FlaskConical,
  Gauge,
  LogOut,
  Menu,
  MessageCircleMore,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useState, useTransition } from "react";
import { formatTokens } from "@/lib/study-display";

type NavigationItem = {
  href: string;
  label: string;
  icon: typeof FlaskConical;
};

const navigationSections: Array<{ label: string; items: NavigationItem[] }> = [
  {
    label: "研究",
    items: [
      { href: "/newstudy", label: "新研究", icon: FlaskConical },
      { href: "/studies", label: "我的项目", icon: Files },
    ],
  },
  {
    label: "AI 工作台",
    items: [
      { href: "/agent", label: "Universal Agent", icon: Command },
      { href: "/sage", label: "AI Sage", icon: Sparkles },
    ],
  },
  {
    label: "研究执行",
    items: [
      { href: "/interview", label: "AI 访谈", icon: MessageCircleMore },
      { href: "/interview/experiments", label: "访谈实验", icon: Gauge },
    ],
  },
  {
    label: "资产与能力",
    items: [
      { href: "/context", label: "Context 资产", icon: Database },
      { href: "/skills", label: "Skills", icon: Blocks },
      { href: "/persona", label: "AI Persona", icon: Bot },
    ],
  },
  {
    label: "管理",
    items: [{ href: "/platform", label: "平台控制", icon: Network }],
  },
];

type WorkspaceShellProps = {
  children: ReactNode;
  viewer: {
    displayName: string;
    workspaceName: string;
    tokenBalance: number;
  };
};

export function WorkspaceShell({ children, viewer }: WorkspaceShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pending, startTransition] = useTransition();
  const initial = viewer.displayName.trim().charAt(0).toUpperCase() || "A";
  const accountActive = pathname === "/account" || pathname.startsWith("/account/");

  function signOut() {
    startTransition(async () => {
      try {
        const response = await fetch("/api/auth/signout", { method: "POST" });
        const result = (await response.json()) as { redirectTo?: string };
        router.replace(result.redirectTo ?? "/auth/signin");
        router.refresh();
      } catch {
        router.replace("/auth/signin");
      }
    });
  }

  function isActive(item: NavigationItem) {
    return (
      pathname === item.href ||
      (item.href === "/interview"
        ? pathname.startsWith("/interview/projects") || pathname.startsWith("/interview/invite")
        : pathname.startsWith(`${item.href}/`)) ||
      (item.href === "/studies" && pathname.startsWith("/study/"))
    );
  }

  const navigation = (items: NavigationItem[]) =>
    items.map((item) => {
      const Icon = item.icon;
      const active = isActive(item);

      return (
        <Link
          className={`workspace-nav-link${active ? " active" : ""}${item.href === "/newstudy" ? " workspace-nav-link-create" : ""}`}
          href={item.href}
          title={sidebarCollapsed ? item.label : undefined}
          key={item.href}
          onClick={() => setMobileOpen(false)}
        >
          <Icon size={19} strokeWidth={1.8} />
          <span>{item.label}</span>
        </Link>
      );
    });

  return (
    <div className={`workspace-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <header className="workspace-topbar">
        <Link className="workspace-brand" href="/" aria-label="atypica.AI 首页">
          atypica.AI
        </Link>
        <div className="workspace-switcher">
          <span>{viewer.workspaceName}</span>
        </div>
        <div className="workspace-account">
          <Link className="token-balance" href="/account" title="Token 余额">
            <Coins size={17} />
            <span>{formatTokens(viewer.tokenBalance)}</span>
          </Link>
          <span className="workspace-avatar" aria-label={viewer.displayName}>{initial}</span>
          <button className="workspace-icon-button" type="button" onClick={signOut} disabled={pending} title="退出登录">
            <LogOut size={18} />
            <span className="sr-only">退出登录</span>
          </button>
          <button
            className="workspace-icon-button workspace-mobile-menu"
            type="button"
            aria-label={mobileOpen ? "关闭工作区菜单" : "打开工作区菜单"}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((value) => !value)}
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </header>

      {mobileOpen ? <button className="workspace-sidebar-backdrop" type="button" aria-label="关闭工作区菜单" onClick={() => setMobileOpen(false)} /> : null}
      <aside className={mobileOpen ? "workspace-sidebar open" : "workspace-sidebar"}>
        <div className="workspace-sidebar-scroll">
          <nav aria-label="研究工作区导航">
            {navigationSections.map((section) => (
              <div className="workspace-nav-group" key={section.label}>
                <div className="workspace-nav-section-label">{section.label}</div>
                {navigation(section.items)}
              </div>
            ))}
          </nav>
        </div>
        <div className="workspace-sidebar-foot">
          <Link className={`workspace-nav-link${accountActive ? " active" : ""}`} href="/account" title={sidebarCollapsed ? "账户与设置" : undefined} onClick={() => setMobileOpen(false)}>
            <BookOpenText size={19} strokeWidth={1.8} />
            <span>账户与设置</span>
          </Link>
          <button
            className="workspace-nav-link workspace-collapse"
            type="button"
            aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={19} strokeWidth={1.8} /> : <PanelLeftClose size={19} strokeWidth={1.8} />}
            <span>{sidebarCollapsed ? "展开" : "收起"}</span>
          </button>
        </div>
      </aside>

      <main className="workspace-main">{children}</main>
    </div>
  );
}
