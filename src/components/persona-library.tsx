"use client";

import {
  BadgeCheck,
  Bot,
  BriefcaseBusiness,
  CalendarClock,
  ExternalLink,
  Eye,
  EyeOff,
  FileSearch,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { FormEvent, useMemo, useState, useTransition } from "react";
import type { PersonaEvidenceDetail } from "@/lib/persona-evidence";
import type { PersonaInput, PersonaLibraryItem, PersonaPanelUsage } from "@/lib/studies";

type LibraryData = { personas: PersonaLibraryItem[]; panels: PersonaPanelUsage[] };
type PersonaFormState = Omit<PersonaInput, "age" | "goals" | "painPoints" | "tags"> & {
  age: string;
  goals: string;
  painPoints: string;
  tags: string;
};

const emptyForm: PersonaFormState = {
  name: "", archetype: "", age: "30", city: "", occupation: "", commute: "", budget: "",
  currentSituation: "", goals: "", painPoints: "", decisionStyle: "", tags: "",
  visibility: "workspace", addToPanelPublicIds: [],
};

function formFromPersona(persona: PersonaLibraryItem): PersonaFormState {
  return {
    name: persona.name, archetype: persona.archetype, age: String(persona.profile.age), city: persona.profile.city,
    occupation: persona.profile.occupation, commute: persona.profile.commute, budget: persona.profile.budget,
    currentSituation: persona.profile.currentSituation, goals: persona.profile.goals.join("\n"),
    painPoints: persona.profile.painPoints.join("\n"), decisionStyle: persona.profile.decisionStyle,
    tags: persona.profile.tags.join("、"), visibility: persona.visibility, addToPanelPublicIds: [],
  };
}

function listFromLines(value: string) {
  return value.split(/[\n；;]/).map((item) => item.trim()).filter(Boolean);
}

function tagsFromText(value: string) {
  return value.split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean);
}

const evidenceStatusLabels: Record<PersonaLibraryItem["evidenceStatus"], string> = {
  ungrounded: "未关联",
  unsupported: "无匹配证据",
  synthetic_grounded: "合成证据",
  human_grounded: "真人证据",
  mixed_grounded: "混合证据",
  context_grounded: "来源上下文",
};

const retentionStatusLabels: Record<PersonaLibraryItem["retentionStatus"], string> = {
  pending: "待保留",
  retained: "已保留",
  retired: "已退役",
  expired: "已过期",
};

const confidenceLabels = { low: "低", medium: "中", high: "高" } as const;

function dateInputValue(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

export function PersonaLibrary({ initialData }: { initialData: LibraryData }) {
  const [data, setData] = useState(initialData);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<PersonaLibraryItem | null | undefined>(undefined);
  const [form, setForm] = useState<PersonaFormState>(emptyForm);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const [evidencePersona, setEvidencePersona] = useState<PersonaLibraryItem | null>(null);
  const [evidenceDetail, setEvidenceDetail] = useState<PersonaEvidenceDetail | null>(null);
  const [evidenceError, setEvidenceError] = useState("");
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [governancePending, startGovernanceTransition] = useTransition();
  const [retentionStatus, setRetentionStatus] = useState<"retained" | "retired">("retained");
  const [validUntil, setValidUntil] = useState("");
  const [retentionNote, setRetentionNote] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return data.personas;
    return data.personas.filter((persona) => [
      persona.name,
      persona.archetype,
      persona.profile.city,
      persona.profile.occupation,
      evidenceStatusLabels[persona.evidenceStatus],
      retentionStatusLabels[persona.retentionStatus],
      ...persona.profile.tags,
    ].some((value) => value.toLowerCase().includes(normalized)));
  }, [data.personas, query]);

  async function reload() {
    const response = await fetch("/api/personas");
    if (response.ok) setData(await response.json() as LibraryData);
  }

  function openCreate() {
    setEditing(null); setForm(emptyForm); setError("");
  }

  function openEdit(persona: PersonaLibraryItem) {
    setEditing(persona); setForm(formFromPersona(persona)); setError("");
  }

  function update<K extends keyof PersonaFormState>(key: K, value: PersonaFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const payload: PersonaInput = {
      ...form, age: Number(form.age), goals: listFromLines(form.goals), painPoints: listFromLines(form.painPoints), tags: tagsFromText(form.tags),
    };
    startTransition(async () => {
      try {
        const response = await fetch(editing ? `/api/personas/${editing.publicId}` : "/api/personas", {
          method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        });
        const result = await response.json() as { error?: string };
        if (!response.ok) { setError(result.error ?? "暂时无法保存 Persona"); return; }
        await reload(); setEditing(undefined);
      } catch { setError("网络连接失败，请稍后重试"); }
    });
  }

  function remove(persona: PersonaLibraryItem) {
    setError("");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/personas/${persona.publicId}`, { method: "DELETE" });
        const result = await response.json() as { error?: string };
        if (!response.ok) { setError(result.error ?? "暂时无法删除 Persona"); return; }
        await reload(); setEditing(undefined);
      } catch { setError("网络连接失败，请稍后重试"); }
    });
  }

  async function loadEvidence(persona: PersonaLibraryItem) {
    setEvidenceLoading(true);
    setEvidenceError("");
    try {
      const response = await fetch(`/api/personas/${persona.publicId}/evidence`, { cache: "no-store" });
      const result = await response.json() as PersonaEvidenceDetail & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "暂时无法加载 Persona 证据");
      setEvidenceDetail(result);
      setRetentionStatus(result.retentionStatus === "retired" ? "retired" : "retained");
      setValidUntil(dateInputValue(result.validUntil));
      setRetentionNote(result.retentionNote ?? "");
    } catch (loadError) {
      setEvidenceError(loadError instanceof Error ? loadError.message : "暂时无法加载 Persona 证据");
    } finally {
      setEvidenceLoading(false);
    }
  }

  function openEvidence(persona: PersonaLibraryItem) {
    setEvidencePersona(persona);
    setEvidenceDetail(null);
    void loadEvidence(persona);
  }

  function closeEvidence() {
    setEvidencePersona(null);
    setEvidenceDetail(null);
    setEvidenceError("");
  }

  function saveRetention(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!evidencePersona) return;
    setEvidenceError("");
    startGovernanceTransition(async () => {
      try {
        const response = await fetch(`/api/personas/${evidencePersona.publicId}/evidence`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            retentionStatus,
            validUntil: retentionStatus === "retained" && validUntil ? new Date(`${validUntil}T23:59:59.000Z`).toISOString() : null,
            note: retentionNote,
          }),
        });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "暂时无法保存保留策略");
        await Promise.all([reload(), loadEvidence(evidencePersona)]);
      } catch (saveError) {
        setEvidenceError(saveError instanceof Error ? saveError.message : "暂时无法保存保留策略");
      }
    });
  }

  return (
    <div className="persona-library-page">
      <header className="persona-library-heading">
        <div><h1>AI Persona</h1><p>管理研究生成与手动创建的合成画像，并在不同 Panel 中复用。</p></div>
        <button type="button" onClick={openCreate}><Plus size={17} />新增 Persona</button>
      </header>
      <div className="persona-library-toolbar">
        <label><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名、职业、城市或标签" aria-label="搜索 Persona" /></label>
        <span>{filtered.length} / {data.personas.length}</span>
      </div>
      {error && editing === undefined ? <p className="persona-library-error" role="alert">{error}</p> : null}
      {filtered.length ? (
        <div className="persona-library-grid">
          {filtered.map((persona, index) => (
            <article className={`persona-library-card retention-${persona.retentionStatus}`} key={persona.publicId}>
              <header><span>{String(index + 1).padStart(2, "0")}</span><div className="persona-card-states"><span>{persona.visibility === "workspace" ? <Eye size={13} /> : <EyeOff size={13} />}{persona.visibility === "workspace" ? "工作区可见" : "仅自己可见"}</span><span data-evidence-status={persona.evidenceStatus}>{evidenceStatusLabels[persona.evidenceStatus]}</span></div></header>
              <div className="persona-library-identity"><i>{persona.name.slice(0, 1)}</i><div><h2>{persona.name}</h2><p>{persona.profile.occupation} · {persona.profile.city}</p></div></div>
              <strong>{persona.archetype}</strong>
              <p>{persona.profile.currentSituation}</p>
              <div className="persona-library-tags">{persona.profile.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>
              <button type="button" className="persona-evidence-open" onClick={() => openEvidence(persona)}><FileSearch size={15} /><span><strong>{persona.groundingSummary.claimCount}</strong> Claims · <strong>{persona.groundingSummary.evidenceCount}</strong> Evidence</span><small>{confidenceLabels[persona.evidenceConfidence]}置信度</small></button>
              <dl><div><dt><UsersRound size={13} />Panel</dt><dd>{persona.panels.length}</dd></div><div><dt><BriefcaseBusiness size={13} />模拟访谈</dt><dd>{persona.interviewCount}</dd></div></dl>
              <footer><span data-retention-status={persona.retentionStatus}><CalendarClock size={12} />{retentionStatusLabels[persona.retentionStatus]}</span>{persona.canEdit ? <button type="button" onClick={() => openEdit(persona)} aria-label={`编辑 ${persona.name}`}><Pencil size={15} /></button> : null}</footer>
            </article>
          ))}
        </div>
      ) : <div className="persona-library-empty"><Bot size={28} /><h2>没有匹配的 Persona</h2><p>调整搜索词，或创建一个新的合成画像。</p></div>}

      {editing !== undefined ? (
        <div className="persona-editor-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setEditing(undefined)}>
          <section className="persona-editor" role="dialog" aria-modal="true" aria-label={editing ? `编辑 ${editing.name}` : "新增 Persona"}>
            <header><div><span>{editing ? "编辑合成画像" : "创建合成画像"}</span><h2>{editing ? editing.name : "新增 Persona"}</h2></div><button type="button" onClick={() => setEditing(undefined)} aria-label="关闭 Persona 编辑器"><X size={20} /></button></header>
            <form onSubmit={submit}>
              <div className="persona-editor-grid">
                <label>姓名<input value={form.name} onChange={(event) => update("name", event.target.value)} required minLength={2} /></label>
                <label>画像类型<input value={form.archetype} onChange={(event) => update("archetype", event.target.value)} required minLength={2} /></label>
                <label>年龄<input type="number" value={form.age} onChange={(event) => update("age", event.target.value)} min={18} max={90} required /></label>
                <label>城市<input value={form.city} onChange={(event) => update("city", event.target.value)} required minLength={2} /></label>
                <label>职业<input value={form.occupation} onChange={(event) => update("occupation", event.target.value)} required minLength={2} /></label>
                <label>预算<input value={form.budget} onChange={(event) => update("budget", event.target.value)} required /></label>
              </div>
              <label>使用场景<textarea value={form.commute} onChange={(event) => update("commute", event.target.value)} required minLength={5} /></label>
              <label>当前处境<textarea value={form.currentSituation} onChange={(event) => update("currentSituation", event.target.value)} required minLength={10} /></label>
              <label>决策方式<textarea value={form.decisionStyle} onChange={(event) => update("decisionStyle", event.target.value)} required minLength={8} /></label>
              <div className="persona-editor-grid"><label>目标（每行一项）<textarea value={form.goals} onChange={(event) => update("goals", event.target.value)} required /></label><label>痛点（每行一项）<textarea value={form.painPoints} onChange={(event) => update("painPoints", event.target.value)} required /></label></div>
              <label>标签（使用顿号或逗号分隔）<input value={form.tags} onChange={(event) => update("tags", event.target.value)} required /></label>
              <fieldset><legend>可见范围</legend><label><input type="radio" checked={form.visibility === "workspace"} onChange={() => update("visibility", "workspace")} />工作区成员</label><label><input type="radio" checked={form.visibility === "private"} onChange={() => update("visibility", "private")} />仅自己</label></fieldset>
              {data.panels.length ? <fieldset><legend>添加到 Panel</legend>{data.panels.map((panel) => <label key={panel.publicId}><input type="checkbox" checked={form.addToPanelPublicIds.includes(panel.publicId)} onChange={(event) => update("addToPanelPublicIds", event.target.checked ? [...form.addToPanelPublicIds, panel.publicId] : form.addToPanelPublicIds.filter((id) => id !== panel.publicId))} />{panel.title}</label>)}</fieldset> : null}
              {editing?.panels.length || editing?.interviewCount ? <div className="persona-in-use"><ShieldAlert size={15} /><span>当前被 {editing.panels.length} 个 Panel 和 {editing.interviewCount} 份模拟访谈使用，不能删除。</span></div> : null}
              {error ? <p className="persona-library-error" role="alert">{error}</p> : null}
              <div className="persona-editor-actions">{editing ? <button type="button" className="persona-delete" disabled={pending || editing.panels.length > 0 || editing.interviewCount > 0} onClick={() => remove(editing)}><Trash2 size={15} />删除</button> : <span />}<button type="submit" disabled={pending}>{pending ? <LoaderCircle className="spin" size={16} /> : null}{editing ? "保存修改" : "创建 Persona"}</button></div>
            </form>
          </section>
        </div>
      ) : null}

      {evidencePersona ? (
        <div className="persona-editor-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeEvidence()}>
          <section className="persona-evidence-panel" role="dialog" aria-modal="true" aria-label={`${evidencePersona.name} 的证据与保留策略`}>
            <header><div><span>EVIDENCE GROUNDING</span><h2>{evidencePersona.name}</h2></div><button type="button" onClick={closeEvidence} aria-label="关闭 Persona 证据"><X size={20} /></button></header>
            {evidenceLoading ? <div className="persona-evidence-loading"><LoaderCircle className="spin" size={22} />加载证据</div> : null}
            {!evidenceLoading && evidenceDetail ? <div className="persona-evidence-body">
              <section className="persona-evidence-metrics" aria-label="Persona 证据统计">
                <div><span>Claims</span><strong>{evidenceDetail.groundingSummary.claimCount}</strong></div>
                <div><span>Evidence</span><strong>{evidenceDetail.groundingSummary.evidenceCount}</strong></div>
                <div><span>Human</span><strong>{evidenceDetail.groundingSummary.humanEvidenceCount}</strong></div>
                <div><span>Synthetic</span><strong>{evidenceDetail.groundingSummary.syntheticEvidenceCount}</strong></div>
              </section>
              <section className="persona-grounding-state"><div><BadgeCheck size={17} /><span>{evidenceStatusLabels[evidenceDetail.evidenceStatus]}</span></div><strong>{confidenceLabels[evidenceDetail.evidenceConfidence]}置信度</strong></section>
              {evidenceDetail.canGovern ? <form className="persona-retention-form" onSubmit={saveRetention}>
                <header><CalendarClock size={16} /><strong>保留策略</strong></header>
                <div><label>状态<select value={retentionStatus} onChange={(event) => setRetentionStatus(event.target.value as typeof retentionStatus)}><option value="retained">保留并允许复用</option><option value="retired">退役并停止复用</option></select></label><label>有效期<input type="date" value={validUntil} disabled={retentionStatus === "retired"} onChange={(event) => setValidUntil(event.target.value)} /></label></div>
                <label>审核备注<textarea value={retentionNote} maxLength={1000} onChange={(event) => setRetentionNote(event.target.value)} /></label>
                <button type="submit" disabled={governancePending}>{governancePending ? <LoaderCircle className="spin" size={15} /> : <BadgeCheck size={15} />}保存策略</button>
              </form> : null}
              <section className="persona-evidence-list"><header><FileSearch size={16} /><strong>关联证据</strong><span>{evidenceDetail.evidence.length}</span></header>{evidenceDetail.evidence.length ? evidenceDetail.evidence.map((evidence) => <article key={evidence.publicId}><header><div><span>{evidence.evidenceType}</span><strong>{evidence.title}</strong></div>{evidence.sourceUri ? <a href={evidence.sourceUri} target="_blank" rel="noreferrer" aria-label={`打开来源 ${evidence.title}`}><ExternalLink size={14} /></a> : null}</header><p>{evidence.content}</p>{evidence.claims.length ? <ul>{evidence.claims.map((claim) => <li key={claim.publicId}><span>{claim.claimType} · {claim.confidence}</span><strong>{claim.statement}</strong></li>)}</ul> : <small>当前证据尚未绑定报告 Claim</small>}</article>) : <div className="persona-evidence-empty"><ShieldAlert size={20} /><span>没有 locator 精确匹配的证据</span></div>}</section>
              {evidenceDetail.events.length ? <details className="persona-governance-events"><summary>治理记录 · {evidenceDetail.events.length}</summary><ol>{evidenceDetail.events.map((event) => <li key={event.publicId}><strong>{event.eventType}</strong><span>{event.actorName ?? "System"} · {new Date(event.createdAt).toLocaleString("zh-CN")}</span></li>)}</ol></details> : null}
            </div> : null}
            {evidenceError ? <p className="persona-library-error persona-evidence-error" role="alert">{evidenceError}</p> : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
