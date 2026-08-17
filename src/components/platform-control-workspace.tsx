"use client";

import { ArrowUpFromLine, Check, ChevronRight, GitBranch, LoaderCircle, Network, Plus, Send, ShieldCheck, X } from "lucide-react";
import { useState, useTransition } from "react";
import type {
  CollaborationDelegation,
  CollaborationPublication,
  RouteDecisionSummary,
  RoutingPolicySummary,
} from "@/lib/platform-control";

type CollaborationData = { publications: CollaborationPublication[]; delegations: CollaborationDelegation[] };
type RoutingData = { policies: RoutingPolicySummary[]; decisions: RouteDecisionSummary[] };

const publicationLabels = { study: "研究", report: "报告", context: "Context", skill: "Skill" } as const;
const statusLabels: Record<string, string> = {
  draft: "草稿", submitted: "待接收", accepted: "已接受", rejected: "已拒绝", revoked: "已撤回",
  proposed: "待响应", in_progress: "执行中", completed: "已完成", cancelled: "已取消",
};
const stageLabels = { plan: "计划", research: "研究", reasoning: "推理", report: "报告", judge: "审核", followup: "追问" } as const;

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "未设置";
}

function ActionButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <button className="button button-small" type="button" onClick={onClick} disabled={disabled}>{disabled ? <LoaderCircle className="spin" size={13} /> : <ChevronRight size={13} />}{label}</button>;
}

export function PlatformControlWorkspace({ initialCollaboration, initialRouting, canManage }: { initialCollaboration: CollaborationData; initialRouting: RoutingData; canManage: boolean }) {
  const [tab, setTab] = useState<"collaboration" | "routing">("collaboration");
  const [collaboration, setCollaboration] = useState(initialCollaboration);
  const [routing, setRouting] = useState(initialRouting);
  const [publicationOpen, setPublicationOpen] = useState(false);
  const [delegationOpen, setDelegationOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    const [collaborationResponse, routingResponse] = await Promise.all([fetch("/api/platform/collaboration"), fetch("/api/platform/routing")]);
    if (collaborationResponse.ok) setCollaboration(await collaborationResponse.json() as CollaborationData);
    if (routingResponse.ok) setRouting(await routingResponse.json() as RoutingData);
  }

  function mutate(url: string, method: string, body: unknown) {
    setMessage(null);
    startTransition(async () => {
      try {
        const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const result = await response.json() as { error?: string };
        if (!response.ok) { setMessage(result.error ?? "操作失败"); return; }
        setMessage("已更新"); await refresh();
      } catch { setMessage("网络异常，请稍后重试"); }
    });
  }

  return <section className="platform-control">
    <nav className="platform-tabs" aria-label="平台控制视图">
      <button type="button" className={tab === "collaboration" ? "active" : ""} onClick={() => setTab("collaboration")}><Network size={15} />协作流</button>
      <button type="button" className={tab === "routing" ? "active" : ""} onClick={() => setTab("routing")}><GitBranch size={15} />Provider 路由</button>
    </nav>
    {message ? <div className="platform-message" role="status">{message}</div> : null}
    {tab === "collaboration" ? <>
      <div className="platform-toolbar"><div><strong>{collaboration.publications.length} 个发布包</strong><span>{collaboration.delegations.length} 个委托</span></div>{canManage ? <div><button className="button button-small" type="button" onClick={() => setDelegationOpen((value) => !value)}><Send size={13} />新委托</button><button className="button button-green button-small" type="button" onClick={() => setPublicationOpen((value) => !value)}><Plus size={13} />新发布</button></div> : null}</div>
      {publicationOpen ? <PublicationForm pending={pending} onDone={() => { setPublicationOpen(false); void refresh(); }} /> : null}
      {delegationOpen ? <DelegationForm pending={pending} onDone={() => { setDelegationOpen(false); void refresh(); }} /> : null}
      <div className="platform-grid">
        <section className="platform-panel"><header><div><span>OUTGOING / INCOMING</span><h2>发布包</h2></div><ShieldCheck size={18} /></header><div className="platform-list">{collaboration.publications.length ? collaboration.publications.map((item) => <article key={item.publicId}><div className="platform-item-icon"><ArrowUpFromLine size={15} /></div><div className="platform-item-main"><strong>{item.title}</strong><p>{publicationLabels[item.artifactType]} · {item.direction === "outgoing" ? `发往 ${item.recipientWorkspace.name}` : `来自 ${item.publisherWorkspace.name}`}</p><small>{item.publicId} · {item.artifactHash.slice(0, 12)} · {formatDate(item.updatedAt)}</small></div><div className="platform-item-actions"><span className={`platform-status ${item.status}`}>{statusLabels[item.status]}</span>{item.direction === "outgoing" && item.status === "draft" ? <ActionButton label="提交" disabled={pending} onClick={() => mutate(`/api/platform/collaboration/publications/${item.publicId}/status`, "PATCH", { status: "submitted" })} /> : null}{item.direction === "incoming" && item.status === "submitted" ? <><ActionButton label="接受" disabled={pending} onClick={() => mutate(`/api/platform/collaboration/publications/${item.publicId}/status`, "PATCH", { status: "accepted" })} /><ActionButton label="拒绝" disabled={pending} onClick={() => mutate(`/api/platform/collaboration/publications/${item.publicId}/status`, "PATCH", { status: "rejected" })} /></> : null}{item.direction === "outgoing" && ["submitted", "accepted"].includes(item.status) ? <ActionButton label="撤回" disabled={pending} onClick={() => mutate(`/api/platform/collaboration/publications/${item.publicId}/status`, "PATCH", { status: "revoked" })} /> : null}</div></article>) : <EmptyState label="还没有跨工作区发布包" />}</div></section>
        <section className="platform-panel"><header><div><span>ASSIGNMENT QUEUE</span><h2>委托</h2></div><Send size={18} /></header><div className="platform-list">{collaboration.delegations.length ? collaboration.delegations.map((item) => <article key={item.publicId}><div className="platform-item-icon"><Send size={15} /></div><div className="platform-item-main"><strong>{item.title}</strong><p>{item.direction === "outgoing" ? `发往 ${item.recipientWorkspace.name}` : `来自 ${item.senderWorkspace.name}`} · 截止 {formatDate(item.dueAt)}</p><small>{item.instructions || "未附加说明"}</small></div><div className="platform-item-actions"><span className={`platform-status ${item.status}`}>{statusLabels[item.status]}</span>{item.direction === "incoming" && item.status === "proposed" ? <><ActionButton label="接受" disabled={pending} onClick={() => mutate(`/api/platform/collaboration/delegations/${item.publicId}/status`, "PATCH", { status: "accepted" })} /><ActionButton label="拒绝" disabled={pending} onClick={() => mutate(`/api/platform/collaboration/delegations/${item.publicId}/status`, "PATCH", { status: "rejected" })} /></> : null}{item.direction === "incoming" && item.status === "accepted" ? <ActionButton label="开始" disabled={pending} onClick={() => mutate(`/api/platform/collaboration/delegations/${item.publicId}/status`, "PATCH", { status: "in_progress" })} /> : null}{item.direction === "incoming" && item.status === "in_progress" ? <ActionButton label="完成" disabled={pending} onClick={() => mutate(`/api/platform/collaboration/delegations/${item.publicId}/status`, "PATCH", { status: "completed" })} /> : null}</div></article>) : <EmptyState label="还没有跨工作区委托" />}</div></section>
      </div>
    </> : <>
      <div className="platform-toolbar"><div><strong>{routing.policies.length} 个策略</strong><span>{routing.decisions.length} 条近期决策</span></div>{canManage ? <button className="button button-green button-small" type="button" onClick={() => setRoutingOpen((value) => !value)}><Plus size={13} />新策略版本</button> : null}</div>
      {routingOpen ? <RoutingForm pending={pending} onDone={() => { setRoutingOpen(false); void refresh(); }} /> : null}
      <section className="platform-panel routing-panel"><header><div><span>VERSIONED POLICY CONTROL</span><h2>策略版本</h2></div><GitBranch size={18} /></header><div className="routing-policy-list">{routing.policies.length ? routing.policies.map((policy) => <article key={policy.publicId}><div className="routing-policy-heading"><div><strong>{policy.name}</strong><p>{stageLabels[policy.stage]} · <code>{policy.policyKey}</code></p></div><small>{policy.description}</small></div><div className="routing-versions">{policy.versions.map((version) => <div key={version.publicId}><div><span className={`platform-status ${version.status}`}>{version.status === "active" ? "生效" : version.status === "draft" ? "草稿" : "退役"}</span><strong>v{version.version}</strong><small>{version.selectionMode === "weighted" ? "加权" : "优先级"} · {version.routes.length} 条路由 · {version.minimumQualityTier}+</small></div>{canManage && version.status === "draft" ? <ActionButton label="发布" disabled={pending} onClick={() => mutate(`/api/platform/routing/versions/${version.publicId}/activate`, "POST", {})} /> : null}</div>)}</div></article>) : <EmptyState label="还没有 Provider 路由策略" />}</div></section>
      <section className="platform-panel routing-decisions"><header><div><span>DECISION LEDGER</span><h2>最近决策</h2></div><Check size={18} /></header><div className="platform-list">{routing.decisions.length ? routing.decisions.map((decision) => <article key={decision.publicId}><div className="platform-item-icon"><GitBranch size={15} /></div><div className="platform-item-main"><strong>{stageLabels[decision.stage]} · {decision.providerName} / {decision.model}</strong><p>{decision.studyPublicId ?? "Universal Agent"} · {decision.selectionReason}</p><small>{decision.estimatedCostMicros} μ$ 估算 · {decision.actualCostMicros === null ? "尚未结算" : `${decision.actualCostMicros} μ$ 实际`} · {decision.latencyMs === null ? "执行中" : `${decision.latencyMs} ms`}</small></div><span className={`platform-status ${decision.status}`}>{decision.status === "completed" ? "完成" : decision.status === "failed" ? "失败" : "已选择"}</span></article>) : <EmptyState label="还没有运行决策记录" />}</div></section>
    </>}
  </section>;
}

function EmptyState({ label }: { label: string }) { return <div className="platform-empty"><Network size={20} /><span>{label}</span></div>; }

function PublicationForm({ pending, onDone }: { pending: boolean; onDone: () => void }) {
  const [recipient, setRecipient] = useState(""); const [type, setType] = useState<"study" | "report" | "context" | "skill">("report"); const [artifact, setArtifact] = useState(""); const [capabilities, setCapabilities] = useState(["view", "import"]); const [error, setError] = useState<string | null>(null);
  function submit(event: React.FormEvent) { event.preventDefault(); setError(null); void fetch("/api/platform/collaboration", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "publication", recipientWorkspacePublicId: recipient, artifactType: type, artifactPublicId: artifact, capabilities }) }).then(async (response) => { const result = await response.json() as { error?: string }; if (!response.ok) setError(result.error ?? "创建失败"); else onDone(); }); }
  return <form className="platform-form" onSubmit={submit}><header><strong>创建发布包</strong><button type="button" onClick={onDone}><X size={15} /></button></header><div className="platform-form-grid"><label><span>接收工作区 Public ID</span><input value={recipient} onChange={(event) => setRecipient(event.target.value)} required placeholder="wsp_..." /></label><label><span>资产类型</span><select value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="report">报告</option><option value="study">研究</option><option value="context">Context</option><option value="skill">Skill</option></select></label><label><span>资产 Public ID</span><input value={artifact} onChange={(event) => setArtifact(event.target.value)} required placeholder="rpt_..." /></label></div><fieldset><legend>接收能力</legend><div className="platform-checks">{["view", "import", "delegate"].map((capability) => <label key={capability}><input type="checkbox" checked={capabilities.includes(capability)} onChange={() => setCapabilities((current) => current.includes(capability) ? current.filter((item) => item !== capability) : [...current, capability])} /><span>{capability === "view" ? "查看" : capability === "import" ? "导入待审核引用" : "允许委托"}</span></label>)}</div></fieldset>{error ? <p className="platform-form-error">{error}</p> : null}<button className="button button-green" type="submit" disabled={pending}><ArrowUpFromLine size={14} />保存草稿</button></form>;
}

function DelegationForm({ pending, onDone }: { pending: boolean; onDone: () => void }) {
  const [recipient, setRecipient] = useState(""); const [publication, setPublication] = useState(""); const [title, setTitle] = useState(""); const [instructions, setInstructions] = useState(""); const [dueAt, setDueAt] = useState(""); const [error, setError] = useState<string | null>(null);
  function submit(event: React.FormEvent) { event.preventDefault(); setError(null); void fetch("/api/platform/collaboration", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "delegation", recipientWorkspacePublicId: recipient, publicationPublicId: publication || null, title, instructions, dueAt: dueAt ? new Date(dueAt).toISOString() : null }) }).then(async (response) => { const result = await response.json() as { error?: string }; if (!response.ok) setError(result.error ?? "创建失败"); else onDone(); }); }
  return <form className="platform-form" onSubmit={submit}><header><strong>创建委托</strong><button type="button" onClick={onDone}><X size={15} /></button></header><div className="platform-form-grid"><label><span>接收工作区 Public ID</span><input value={recipient} onChange={(event) => setRecipient(event.target.value)} required placeholder="wsp_..." /></label><label><span>关联发布包（可选）</span><input value={publication} onChange={(event) => setPublication(event.target.value)} placeholder="pub_..." /></label><label><span>截止时间</span><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label><label><span>委托标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} required /></label></div><label><span>工作说明</span><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={3} /></label>{error ? <p className="platform-form-error">{error}</p> : null}<button className="button button-green" type="submit" disabled={pending}><Send size={14} />发送委托</button></form>;
}

function RoutingForm({ pending, onDone }: { pending: boolean; onDone: () => void }) {
  const [policyKey, setPolicyKey] = useState("research-default"); const [name, setName] = useState("Research routing"); const [stage, setStage] = useState<keyof typeof stageLabels>("research"); const [providerName, setProviderName] = useState("openai"); const [model, setModel] = useState("gpt-5.6-terra"); const [qualityTier, setQualityTier] = useState<"basic" | "standard" | "high" | "premium">("standard"); const [selectionMode, setSelectionMode] = useState<"weighted" | "priority">("weighted"); const [inputPrice, setInputPrice] = useState("0"); const [outputPrice, setOutputPrice] = useState("0"); const [pricingSource, setPricingSource] = useState(""); const [pricingEffectiveAt, setPricingEffectiveAt] = useState(new Date().toISOString().slice(0, 10)); const [error, setError] = useState<string | null>(null);
  function submit(event: React.FormEvent) { event.preventDefault(); setError(null); void fetch("/api/platform/routing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policyKey, name, stage, description: "", selectionMode, maxEstimatedCostMicros: null, maxLatencyMs: null, minimumQualityTier: qualityTier, estimatedInputTokens: 10000, estimatedOutputTokens: 2000, changeNote: "平台控制台创建", routes: [{ routeKey: "primary", providerName, model, protocol: "responses", priority: 1, weight: 1, qualityTier, expectedLatencyMs: null, inputPriceMicrosPerMillion: Number(inputPrice), outputPriceMicrosPerMillion: Number(outputPrice), pricingSource, pricingEffectiveAt }] }) }).then(async (response) => { const result = await response.json() as { error?: string }; if (!response.ok) setError(result.error ?? "创建失败"); else onDone(); }); }
  return <form className="platform-form" onSubmit={submit}><header><strong>创建路由策略版本</strong><button type="button" onClick={onDone}><X size={15} /></button></header><div className="platform-form-grid"><label><span>策略 Key</span><input value={policyKey} onChange={(event) => setPolicyKey(event.target.value)} required /></label><label><span>策略名称</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label><label><span>运行阶段</span><select value={stage} onChange={(event) => setStage(event.target.value as typeof stage)}>{Object.entries(stageLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><label><span>Provider</span><input value={providerName} onChange={(event) => setProviderName(event.target.value)} required /></label><label><span>Model</span><input value={model} onChange={(event) => setModel(event.target.value)} required /></label><label><span>选择模式</span><select value={selectionMode} onChange={(event) => setSelectionMode(event.target.value as typeof selectionMode)}><option value="weighted">加权</option><option value="priority">优先级</option></select></label><label><span>最低质量</span><select value={qualityTier} onChange={(event) => setQualityTier(event.target.value as typeof qualityTier)}><option value="basic">Basic</option><option value="standard">Standard</option><option value="high">High</option><option value="premium">Premium</option></select></label><label><span>输入价 μ$ / 1M tokens</span><input type="number" min="0" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} required /></label><label><span>输出价 μ$ / 1M tokens</span><input type="number" min="0" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} required /></label><label><span>价格来源</span><input value={pricingSource} onChange={(event) => setPricingSource(event.target.value)} minLength={2} required placeholder="账单或内部价格表版本" /></label><label><span>价格生效日</span><input type="date" value={pricingEffectiveAt} onChange={(event) => setPricingEffectiveAt(event.target.value)} required /></label></div><p className="platform-form-note">价格按每百万输入/输出 token 记录在版本中；没有真实账单数据时请不要发布策略。</p>{error ? <p className="platform-form-error">{error}</p> : null}<button className="button button-green" type="submit" disabled={pending || pricingSource.trim().length < 2}><GitBranch size={14} />保存草稿</button></form>;
}
