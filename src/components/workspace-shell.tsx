"use client";

import {
  BookOpenText,
  Bot,
  Blocks,
  Coins,
  Database,
  Files,
  FlaskConical,
  Gauge,
  LogOut,
  Menu,
  MessageCircleMore,
  Network,
  PanelLeftClose,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useState, useTransition } from "react";
import { formatTokens } from "@/lib/study-display";

const primaryNavigation = [
  { href: "/newstudy", label: "新研究", icon: FlaskConical },
  { href: "/studies", label: "我的项目", icon: Files },
];

const productNavigation = [
  { href: "/context", label: "Context 资产", icon: Database },
  { href: "/skills", label: "Skills", icon: Blocks },
  { href: "/persona", label: "AI Persona", icon: Bot },
  { href: "/interview", label: "AI 访谈", icon: MessageCircleMore },
  { href: "/interview/experiments", label: "访谈实验", icon: Gauge },
  { href: "/sage", label: "AI Sage", icon: Sparkles },
  { href: "/platform", label: "平台控制", icon: Network },
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
  const [pending, startTransition] = useTransition();
  const initial = viewer.displayName.trim().charAt(0).toUpperCase() || "A";

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

  const navigation = (items: typeof primaryNavigation) =>
    items.map((item) => {
      const Icon = item.icon;
      const active =
        pathname === item.href ||
        (item.href === "/interview"
          ? pathname.startsWith("/interview/projects") || pathname.startsWith("/interview/invite")
          : pathname.startsWith(`${item.href}/`)) ||
        (item.href === "/studies" && pathname.startsWith("/study/"));

      return (
        <Link
          className={active ? "workspace-nav-link active" : "workspace-nav-link"}
          href={item.href}
          key={item.href}
          onClick={() => setMobileOpen(false)}
        >
          <Icon size={19} strokeWidth={1.8} />
          <span>{item.label}</span>
        </Link>
      );
    });

  return (
    <div className="workspace-shell">
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

      <aside className={mobileOpen ? "workspace-sidebar open" : "workspace-sidebar"}>
        <nav aria-label="研究工作区导航">
          {navigation(primaryNavigation)}
          <div className="workspace-nav-divider" />
          {navigation(productNavigation)}
        </nav>
        <div className="workspace-sidebar-foot">
          <Link className="workspace-nav-link" href="/account">
            <BookOpenText size={19} strokeWidth={1.8} />
            <span>账户与设置</span>
          </Link>
          <button className="workspace-nav-link workspace-collapse" type="button" disabled>
            <PanelLeftClose size={19} strokeWidth={1.8} />
            <span>收起</span>
          </button>
        </div>
      </aside>

      <main className="workspace-main">{children}</main>
    </div>
  );
}
