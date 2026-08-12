"use client";

import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  ChevronRight,
  CircleHelp,
  Coins,
  FlaskConical,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MessageSquareText,
  Quote,
  UsersRound,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { FormEvent, useState, useTransition } from "react";
import type { PanelDetail } from "@/lib/studies";
import { formatStudyDate, studyStatusLabels } from "@/lib/study-display";

const avatarSources = [
  "/assets/avatar-sarah.webp",
  "/assets/avatar-marcus.webp",
  "/assets/avatar-emily.webp",
  "/assets/avatar-david.webp",
  "/assets/avatar-jessica.webp",
];

export function PanelWorkspace({
  panel,
  viewer,
}: {
  panel: PanelDetail;
  viewer: { tokenBalance: number };
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"profile" | "interviews">("profile");
  const [launchOpen, setLaunchOpen] = useState(false);
  const [brief, setBrief] = useState(`基于「${panel.title}」中的 AI 合成 Persona，研究${panel.description}`.slice(0, 4000));
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const selected = panel.personas.find((persona) => persona.publicId === selectedId) ?? null;
  const selectedInterviews = selected
    ? panel.interviews.filter((interview) => interview.personaPublicId === selected.publicId)
    : [];

  function openPersona(publicId: string) {
    setSelectedId(publicId);
    setDetailTab("profile");
  }

  function submitStudy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = brief.trim();
    if (normalized.length < 12) return;
    setError("");

    startTransition(async () => {
      try {
        const response = await fetch("/api/studies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ brief: normalized, sourcePanelPublicId: panel.publicId }),
        });
        const result = await response.json() as { error?: string; redirectTo?: string };
        if (!response.ok || !result.redirectTo) {
          setError(result.error ?? "暂时无法从该 Panel 发起研究");
          return;
        }
        window.location.assign(result.redirectTo);
      } catch {
        setError("网络连接失败，请稍后重试");
      }
    });
  }

  return (
    <div className="panel-page-shell">
      <header className="panel-page-header">
        <Link href="/newstudy" className="panel-page-brand">atypica.AI</Link>
        <nav aria-label="Panel 工具">
          <Link href="/account" title="Token 余额"><Coins size={16} />{Math.round(viewer.tokenBalance / 1000)}k</Link>
          <button type="button" disabled aria-label="帮助"><CircleHelp size={19} /></button>
          <Link href="/studies" aria-label="研究项目"><Menu size={21} /></Link>
        </nav>
      </header>

      <main className="panel-page-main">
        <section className="panel-page-intro">
          <div className="panel-page-title-row">
            <div>
              <Link href={`/study/${panel.sourceStudy.publicId}`}>返回来源研究</Link>
              <h1>{panel.title}</h1>
            </div>
            <span><LockKeyhole size={14} />仅当前工作区可见</span>
          </div>
          <p>{panel.description}</p>
          <dl>
            <div><dt>{panel.personas.length}</dt><dd>AI 合成 Persona</dd></div>
            <div><dt>{panel.interviews.length}</dt><dd>模拟访谈</dd></div>
            <div><dt>{panel.projects.length}</dt><dd>关联研究</dd></div>
          </dl>
          <small><Bot size={13} />本 Panel 和访谈均由 AI 合成，用于假设探索与压力测试，不代表真人样本或统计结论。</small>
        </section>

        <section className="panel-personas-section">
          <div className="panel-section-heading"><div><UsersRound size={19} /><h2>Personas</h2></div><span>{panel.personas.length} 个画像</span></div>
          <div className="panel-page-persona-grid">
            {panel.personas.map((persona, index) => (
              <button type="button" className="panel-persona-card" onClick={() => openPersona(persona.publicId)} key={persona.publicId}>
                <div className="panel-persona-copy">
                  <div className="panel-persona-heading">
                    <Image src={avatarSources[index % avatarSources.length]} alt="" width={48} height={48} />
                    <div><span>AI Persona {String(index + 1).padStart(2, "0")}</span><h3>{persona.name}</h3><strong>{persona.profile.occupation}</strong></div>
                    <ChevronRight size={16} />
                  </div>
                  <p>{persona.profile.currentSituation}</p>
                  <div className="panel-persona-tags"><span>{persona.profile.city}</span><span>{persona.archetype}</span>{persona.profile.tags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}</div>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel-launch-section">
          <div><span>准备开始吗？</span><h2>使用该 Panel 启动研究</h2><p>沿用这组 AI 合成 Persona 的差异化背景，建立新的研究计划和执行记录。</p></div>
          <button type="button" onClick={() => setLaunchOpen(true)}><FlaskConical size={17} />发起研究<ArrowRight size={16} /></button>
        </section>

        <section className="panel-projects-section">
          <div className="panel-section-heading"><div><CalendarDays size={18} /><h2>近期项目</h2></div><Link href="/studies">查看全部</Link></div>
          <div className="panel-project-list">
            {panel.projects.map((project) => (
              <Link href={`/study/${project.publicId}`} key={project.publicId}>
                <div><strong>{project.title}</strong><span>{studyStatusLabels[project.status] ?? project.status} · {formatStudyDate(project.updatedAt)}</span></div>
                <ArrowUpRight size={17} />
              </Link>
            ))}
          </div>
        </section>
      </main>

      {selected ? (
        <div className="panel-detail-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelectedId(null)}>
          <section className="panel-detail-dialog" role="dialog" aria-modal="true" aria-label={`${selected.name} Persona 详情`}>
            <header>
              <div><span>AI 合成 Persona</span><h2>{selected.name}</h2><p>{selected.profile.city} · {selected.profile.age} 岁 · {selected.profile.occupation}</p></div>
              <button type="button" onClick={() => setSelectedId(null)} aria-label="关闭 Persona 详情"><X size={20} /></button>
            </header>
            <nav role="tablist" aria-label="Persona 详情视图">
              <button type="button" role="tab" aria-selected={detailTab === "profile"} className={detailTab === "profile" ? "active" : ""} onClick={() => setDetailTab("profile")}>Persona 画像</button>
              <button type="button" role="tab" aria-selected={detailTab === "interviews"} className={detailTab === "interviews" ? "active" : ""} onClick={() => setDetailTab("interviews")}>模拟访谈 <span>{selectedInterviews.length}</span></button>
            </nav>
            {detailTab === "profile" ? (
              <div className="panel-detail-profile">
                <dl>
                  <div><dt>使用场景</dt><dd>{selected.profile.commute}</dd></div>
                  <div><dt>预算</dt><dd>{selected.profile.budget}</dd></div>
                  <div><dt>当前处境</dt><dd>{selected.profile.currentSituation}</dd></div>
                  <div><dt>决策方式</dt><dd>{selected.profile.decisionStyle}</dd></div>
                  <div><dt>目标</dt><dd>{selected.profile.goals.join("；")}</dd></div>
                  <div><dt>痛点</dt><dd>{selected.profile.painPoints.join("；")}</dd></div>
                </dl>
              </div>
            ) : (
              <div className="panel-detail-interviews">
                {selectedInterviews.length ? selectedInterviews.map((interview) => (
                  <article key={`${interview.personaPublicId}-${interview.batch}`}>
                    <div><span>第 {interview.batch} 批</span><strong>{interview.objective}</strong></div>
                    <p>{interview.content.summary}</p>
                    {interview.content.quotes.map((quote) => <blockquote key={quote}><Quote size={14} />{quote}</blockquote>)}
                    <ul>{interview.content.insights.map((insight) => <li key={insight}>{insight}</li>)}</ul>
                  </article>
                )) : <p>该 Persona 暂无模拟访谈记录。</p>}
                <small><MessageSquareText size={13} />以上内容由结构化 Persona 推演生成，不是现实受访者陈述。</small>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {launchOpen ? (
        <div className="panel-detail-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setLaunchOpen(false)}>
          <section className="panel-launch-dialog" role="dialog" aria-modal="true" aria-label="从 Panel 发起研究">
            <header><div><span>新研究</span><h2>使用该 Panel 启动研究</h2></div><button type="button" onClick={() => setLaunchOpen(false)} aria-label="关闭发起研究"><X size={20} /></button></header>
            <form onSubmit={submitStudy}>
              <label htmlFor="panel-research-brief">研究问题</label>
              <textarea id="panel-research-brief" value={brief} onChange={(event) => setBrief(event.target.value)} maxLength={4000} />
              <div><span>{brief.length} / 4000</span><button type="submit" disabled={pending || brief.trim().length < 12}>{pending ? <LoaderCircle className="spin" size={16} /> : <FlaskConical size={16} />}生成研究计划</button></div>
              {error ? <p role="alert">{error}</p> : null}
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
