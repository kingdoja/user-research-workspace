"use client";

import {
  ArrowRight,
  ArrowUp,
  Check,
  FileText,
  ListChecks,
  LoaderCircle,
  Paperclip,
  Plus,
  Quote,
  UsersRound,
  Workflow,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState, useTransition } from "react";
import type { StudyDetail } from "@/lib/studies";

export type StudyProgressItem = {
  key: string;
  label: string;
  status: "done" | "active" | "waiting" | "failed";
};

function getArtifactPersonas(study: StudyDetail): StudyDetail["personas"] {
  if (study.personas.length) return study.personas;
  const artifact = study.artifacts.findLast((item) => item.type === "persona_set");
  if (!artifact || Array.isArray(artifact.content) || !Array.isArray(artifact.content.personas)) return [];
  return artifact.content.personas.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const profile = item as StudyDetail["personas"][number]["profile"];
    return typeof profile.name === "string" && typeof profile.archetype === "string"
      ? [{ publicId: `${artifact.publicId}-${index}`, name: profile.name, archetype: profile.archetype, profile }]
      : [];
  });
}

function getArtifactPanel(study: StudyDetail): StudyDetail["panel"] {
  if (study.panel) return study.panel;
  const artifact = study.artifacts.findLast((item) => item.type === "panel");
  if (!artifact || Array.isArray(artifact.content)) return null;
  const title = typeof artifact.content.title === "string" ? artifact.content.title : artifact.title;
  const description = typeof artifact.content.description === "string" ? artifact.content.description : "由 AI 合成 Persona 组成的研究 Panel。";
  return { publicId: artifact.publicId, title, description };
}

function ProgressPanel({ items, onClose }: { items: StudyProgressItem[]; onClose: () => void }) {
  const visibleItems = items.filter((item) => item.status !== "waiting");
  const upcomingCount = items.length - visibleItems.length;
  return (
    <section className="agent-status-popover agent-progress-popover" aria-label="研究进度">
      <header><div><ListChecks size={20} /><h2>进度</h2></div><strong>{items.filter((item) => item.status === "done").length}/{items.length}</strong><button type="button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>
      <ol>
        {visibleItems.map((item) => (
          <li className={`progress-item-${item.status}`} key={item.key}>
            <span>{item.status === "done" ? <Check size={13} /> : null}</span>
            <p>{item.label}</p>
          </li>
        ))}
        {upcomingCount > 0 ? <li className="progress-item-upcoming"><span>...</span><p>后续 {upcomingCount} 个阶段将在前序任务完成后由 Agent 按依赖和证据状态推进</p></li> : null}
      </ol>
    </section>
  );
}

function OutputPanel({ study, onClose }: { study: StudyDetail; onClose: () => void }) {
  const outputCount = study.report ? 1 : 0;
  return (
    <section className="agent-status-popover agent-output-popover" aria-label="研究产出">
      <header><div><FileText size={20} /><h2>研究产出</h2></div><strong>{outputCount}</strong><button type="button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>
      {study.report ? (
        <button type="button" className="output-report-card" onClick={() => { document.getElementById("research-output")?.scrollIntoView({ behavior: "smooth" }); onClose(); }}>
          <span className="output-report-cover"><small>RESEARCH</small><strong>{study.title.slice(0, 18)}</strong></span>
          <span className="output-report-meta"><strong>{study.report.title}</strong><small>{new Date(study.report.generatedAt).toLocaleDateString("zh-CN")}</small></span>
          <ArrowRight size={18} />
        </button>
      ) : <p className="status-empty">最终报告生成后会出现在这里；Persona、Panel、访谈与讨论过程通过对应工具卡查看。</p>}
    </section>
  );
}

function PanelView({ study, onClose }: { study: StudyDetail; onClose: () => void }) {
  const personas = getArtifactPersonas(study);
  const panel = getArtifactPanel(study);
  const [selectedId, setSelectedId] = useState(personas[0]?.publicId ?? "");
  const [view, setView] = useState<"profile" | "interviews">("profile");
  const selected = personas.find((persona) => persona.publicId === selectedId);
  const interviews = study.interviews.filter((item) => item.personaPublicId === selectedId);

  return (
    <section className="agent-status-popover agent-panel-popover" aria-label="AI 合成 Panel">
      <header><div><UsersRound size={21} /><h2>Panel</h2></div><strong>{study.personas.length}</strong><button type="button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>
      {panel ? (
        <>
          <div className="panel-intro"><h3>{panel.title}</h3><p>{panel.description}</p><small>AI 合成参与者，不代表真人样本或统计结论</small></div>
          <div className="panel-view-tabs" role="tablist" aria-label="Panel 详情视图">
            <button type="button" role="tab" aria-selected={view === "profile"} className={view === "profile" ? "active" : ""} onClick={() => setView("profile")}>Persona 画像</button>
            <button type="button" role="tab" aria-selected={view === "interviews"} className={view === "interviews" ? "active" : ""} onClick={() => setView("interviews")}>模拟访谈 <span>{study.interviews.length}</span></button>
          </div>
          <div className="panel-persona-layout">
            <nav aria-label="选择 Persona">
              {personas.map((persona, index) => (
                <button type="button" className={persona.publicId === selectedId ? "active" : ""} onClick={() => setSelectedId(persona.publicId)} key={persona.publicId}>
                  <span>{index + 1}</span><div><strong>{persona.name}</strong><small>{persona.archetype}</small></div>
                </button>
              ))}
            </nav>
            {selected && view === "profile" ? (
              <article className="persona-detail">
                <header><div><span>{selected.profile.city}</span><h3>{selected.name}</h3><p>{selected.profile.age} 岁 · {selected.profile.occupation}</p></div></header>
                <dl>
                  <div><dt>使用场景</dt><dd>{selected.profile.commute}</dd></div>
                  <div><dt>预算</dt><dd>{selected.profile.budget}</dd></div>
                  <div><dt>当前处境</dt><dd>{selected.profile.currentSituation}</dd></div>
                  <div><dt>决策方式</dt><dd>{selected.profile.decisionStyle}</dd></div>
                </dl>
                <div className="persona-tags">{selected.profile.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
              </article>
            ) : null}
            {selected && view === "interviews" ? (
              <article className="persona-interview-detail">
                <header><div><span>AI 合成 Persona</span><h3>{selected.name}</h3><p>{selected.archetype} · 共 {interviews.length} 份模拟访谈</p></div></header>
                {interviews.length ? interviews.map((interview) => (
                  <section key={`${interview.personaPublicId}-${interview.batch}`}>
                    <div className="interview-batch-heading"><span>第 {interview.batch} 批</span><strong>{interview.objective}</strong></div>
                    <p>{interview.content.summary}</p>
                    <div className="interview-quotes">{interview.content.quotes.map((quote) => <blockquote key={quote}><Quote size={14} />{quote}</blockquote>)}</div>
                    <div className="interview-insights"><strong>结构化洞察</strong><ul>{interview.content.insights.map((insight) => <li key={insight}>{insight}</li>)}</ul></div>
                  </section>
                )) : <p className="status-empty">该 Persona 暂无模拟访谈记录。</p>}
                <small>以上内容由结构化 Persona 推演生成，不是现实受访者陈述。</small>
              </article>
            ) : null}
          </div>
        </>
      ) : <p className="status-empty">Panel 会在 Persona 生成完成后建立。</p>}
    </section>
  );
}

export function StudyAgentControls({
  study,
  progressItems,
}: {
  study: StudyDetail;
  progressItems: StudyProgressItem[];
}) {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"progress" | "output" | "panel" | null>(null);
  const [pending, startTransition] = useTransition();
  const completedSteps = progressItems.filter((item) => item.status === "done").length;
  const outputCount = study.report ? 1 : 0;
  const panelCount = getArtifactPersonas(study).length;
  const clarificationPending = study.clarification.status === "pending";

  useEffect(() => {
    function useSuggestion(event: Event) {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === "string") setBrief(detail);
    }
    window.addEventListener("atypica:followup", useSuggestion);
    return () => window.removeEventListener("atypica:followup", useSuggestion);
  }, []);

  useEffect(() => {
    function openPanel() {
      setActiveTab("panel");
    }
    window.addEventListener("atypica:panel", openPanel);
    return () => window.removeEventListener("atypica:panel", openPanel);
  }, []);

  function toggleTab(tab: "progress" | "output" | "panel") {
    setActiveTab((current) => current === tab ? null : tab);
  }

  function submitStudy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (clarificationPending) return;
    const normalized = brief.trim();
    if (normalized.length < 12) return;
    setError("");

    startTransition(async () => {
      try {
        const followup = Boolean(study.report);
        const response = await fetch(followup ? `/api/studies/${study.publicId}/followup` : "/api/studies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(followup ? { question: normalized } : { brief: normalized }),
        });
        const result = (await response.json()) as { error?: string; redirectTo?: string };
        if (!response.ok) {
          setError(result.error ?? (followup ? "暂时无法回答该问题" : "暂时无法开始新研究"));
          return;
        }
        if (followup) {
          setBrief("");
          router.refresh();
        } else if (result.redirectTo) {
          router.push(result.redirectTo);
        } else {
          setError("暂时无法开始新研究");
        }
      } catch {
        setError("网络连接失败，请稍后重试");
      }
    });
  }

  return (
    <div className="agent-workspace-controls">
      {activeTab === "progress" ? <ProgressPanel items={progressItems} onClose={() => setActiveTab(null)} /> : null}
      {activeTab === "output" ? <OutputPanel study={study} onClose={() => setActiveTab(null)} /> : null}
      {activeTab === "panel" ? <PanelView study={study} onClose={() => setActiveTab(null)} /> : null}
      <nav className="agent-status-tabs" aria-label="研究状态">
        <button type="button" className={activeTab === "progress" ? "active" : ""} onClick={() => toggleTab("progress")}>
          <ListChecks size={17} />进度 <strong>{completedSteps}/{progressItems.length}</strong><span>›</span>
        </button>
        <button type="button" className={activeTab === "output" ? "active" : ""} onClick={() => toggleTab("output")}>
          <Workflow size={17} />研究产出 <strong>{outputCount}</strong><span>›</span>
        </button>
        <button type="button" className={activeTab === "panel" ? "active" : ""} onClick={() => toggleTab("panel")}>
          <UsersRound size={17} />Panel <strong>{panelCount}</strong><span>›</span>
        </button>
      </nav>
      <form className="agent-followup-composer" onSubmit={submitStudy}>
        {clarificationPending ? (
          <div className="agent-composer-blocked" role="status">
            <ListChecks size={18} />
            <div><strong>等待澄清答案</strong><span>完成当前问题后生成研究计划</span></div>
            <button type="button" onClick={() => document.querySelector(".agent-clarification-form")?.scrollIntoView({ behavior: "smooth", block: "center" })}>查看问题</button>
          </div>
        ) : (
          <textarea value={brief} onChange={(event) => setBrief(event.target.value)} placeholder={study.report ? "基于当前报告继续追问" : "提出后续问题或开始一项新研究"} maxLength={study.report ? 1000 : 4000} aria-label="后续研究问题" />
        )}
        <div className="agent-composer-actions">
          <button type="button" className="agent-new-study" onClick={() => study.report ? router.push("/newstudy") : setBrief("")}><Plus size={15} />开始新研究</button>
          <button type="button" className="agent-attach" disabled title="附件功能尚未开放"><Paperclip size={17} /><span className="sr-only">添加附件</span></button>
          <button className="agent-send" type="submit" disabled={clarificationPending || pending || brief.trim().length < 12}>{pending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={18} />}<span className="sr-only">提交</span></button>
        </div>
      </form>
      {error ? <p className="agent-composer-error" role="alert">{error}</p> : null}
    </div>
  );
}
