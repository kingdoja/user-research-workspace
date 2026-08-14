"use client";

import { ArrowRight, Bot, Check, FlaskConical, Gauge, LoaderCircle, MessageCircleMore, Plus, Search, UsersRound, X } from "lucide-react";
import Link from "next/link";
import { FormEvent, useMemo, useState, useTransition } from "react";
import type { InterviewProjectSummary } from "@/lib/interviews";
import type { PersonaLibraryItem, PersonaPanelUsage, StudySummary } from "@/lib/studies";
import { formatStudyDate } from "@/lib/study-display";

type LibraryData = { personas: PersonaLibraryItem[]; panels: PersonaPanelUsage[] };

export function InterviewProjectsWorkspace({ projects, library, studies }: {
  projects: InterviewProjectSummary[];
  library: LibraryData;
  studies: StudySummary[];
}) {
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [panelId, setPanelId] = useState("");
  const [studyId, setStudyId] = useState("");
  const [personaIds, setPersonaIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) => [project.title, project.objective, ...project.personas.map((persona) => persona.name)].some((value) => value.toLowerCase().includes(normalized)));
  }, [projects, query]);

  function selectPanel(publicId: string) {
    setPanelId(publicId);
    if (!publicId) return;
    setPersonaIds(library.personas.filter((persona) => persona.panels.some((panel) => panel.publicId === publicId)).map((persona) => persona.publicId).slice(0, 8));
  }

  function togglePersona(publicId: string) {
    setPersonaIds((current) => current.includes(publicId) ? current.filter((id) => id !== publicId) : current.length < 8 ? [...current, publicId] : current);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    startTransition(async () => {
      try {
        const response = await fetch("/api/interviews", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, objective, personaPublicIds: personaIds, panelPublicId: panelId || null, studyPublicId: studyId || null }),
        });
        const result = await response.json() as { error?: string; redirectTo?: string };
        if (!response.ok || !result.redirectTo) { setError(result.error ?? "暂时无法创建访谈项目"); return; }
        window.location.assign(result.redirectTo);
      } catch { setError("网络连接失败，请稍后重试"); }
    });
  }

  return (
    <div className="interview-projects-page workspace-page">
      <header className="interview-projects-heading">
        <div><h1>访谈项目</h1><p>选择 AI Persona 进行结构化模拟访谈，回放对话并沉淀研究洞察。</p></div>
        <div className="interview-projects-actions"><Link className="button" href="/interview/experiments"><Gauge size={16} />实验对比</Link><button type="button" className="button button-green" onClick={() => setCreateOpen(true)}><Plus size={17} />新建访谈</button></div>
      </header>
      <div className="synthetic-disclosure"><Bot size={16} /><span>本工作区生成的是 AI 合成访谈，用于假设探索与压力测试，不代表真人参与者、真实引语或统计结论。</span></div>
      <div className="interview-project-toolbar"><label><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、目标或 Persona" aria-label="搜索访谈项目" /></label><span>{filtered.length} 个项目</span></div>
      {filtered.length ? <div className="interview-project-list">{filtered.map((project) => (
        <Link href={`/interview/projects/${project.publicId}`} key={project.publicId}>
          <div className="interview-project-icon"><MessageCircleMore size={20} /></div>
          <div className="interview-project-copy"><div><h2>{project.title}</h2><span>{formatStudyDate(project.updatedAt)}</span></div><p>{project.objective}</p><footer><span><UsersRound size={13} />{project.sessionCount} 个 Persona</span>{project.panel ? <span>Panel · {project.panel.title}</span> : null}{project.study ? <span>研究 · {project.study.title}</span> : null}</footer></div>
          <ArrowRight size={18} />
        </Link>
      ))}</div> : <div className="interview-project-empty"><MessageCircleMore size={28} /><h2>还没有访谈项目</h2><p>选择一个或多个 AI Persona，开始第一场结构化模拟访谈。</p><button type="button" onClick={() => setCreateOpen(true)}><Plus size={16} />新建访谈</button></div>}

      {createOpen ? <div className="interview-create-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setCreateOpen(false)}>
        <section className="interview-create-dialog" role="dialog" aria-modal="true" aria-label="新建 AI 访谈项目">
          <header><div><span>AI 合成访谈</span><h2>新建访谈项目</h2></div><button type="button" onClick={() => setCreateOpen(false)} aria-label="关闭新建访谈"><X size={20} /></button></header>
          <form onSubmit={submit}>
            <label>项目名称<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} maxLength={120} required placeholder="例如：城市通勤换购决策访谈" /></label>
            <label>访谈目标<textarea value={objective} onChange={(event) => setObjective(event.target.value)} minLength={12} maxLength={2000} required placeholder="需要了解哪些决策、动机、痛点或反应？" /></label>
            <div className="interview-create-links"><label>关联 Panel<select value={panelId} onChange={(event) => selectPanel(event.target.value)}><option value="">不关联</option>{library.panels.map((panel) => <option value={panel.publicId} key={panel.publicId}>{panel.title}</option>)}</select></label><label>关联研究<select value={studyId} onChange={(event) => setStudyId(event.target.value)}><option value="">不关联</option>{studies.map((study) => <option value={study.publicId} key={study.publicId}>{study.title}</option>)}</select></label></div>
            <fieldset><legend>选择 AI Persona（可选） <span>{personaIds.length} / 8</span></legend><div className="interview-persona-picker">{library.personas.map((persona) => { const selected = personaIds.includes(persona.publicId); return <button type="button" className={selected ? "selected" : ""} onClick={() => togglePersona(persona.publicId)} key={persona.publicId}><i>{selected ? <Check size={14} /> : persona.name.slice(0, 1)}</i><span><strong>{persona.name}</strong><small>{persona.profile.occupation} · {persona.archetype}</small></span></button>; })}</div>{library.personas.length === 0 ? <p className="interview-persona-empty">不选择 Persona 将创建空白真人访谈项目，可在下一步配置问题和邀请链接。</p> : null}</fieldset>
            {error ? <p className="persona-library-error" role="alert">{error}</p> : null}
            <footer><span><FlaskConical size={14} />{personaIds.length ? `将生成 ${personaIds.length} 场独立模拟访谈` : "将创建真人访谈配置项目"}</span><button type="submit" disabled={pending || title.trim().length < 4 || objective.trim().length < 12}>{pending ? <LoaderCircle className="spin" size={16} /> : <MessageCircleMore size={16} />}{pending ? "正在创建..." : (personaIds.length ? "开始生成" : "创建项目")}</button></footer>
          </form>
        </section>
      </div> : null}
    </div>
  );
}
