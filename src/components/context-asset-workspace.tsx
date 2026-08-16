"use client";

import {
  Archive,
  ArrowUpRight,
  Beaker,
  BrainCircuit,
  Check,
  CircleAlert,
  Database,
  FileCheck2,
  FileClock,
  FileJson,
  FileText,
  Link2,
  LoaderCircle,
  Plus,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import type {
  getContextMemoryDetail,
  listContextAssets,
  listContextEvaluationSets,
  listContextEvaluationSourceChunks,
  listContextMemoryPolicies,
} from "@/lib/context-system";
import type { listAgentEvalSuites } from "@/lib/agent-evals";

type ContextAsset = Awaited<ReturnType<typeof listContextAssets>>[number];
type MemoryPolicy = Awaited<ReturnType<typeof listContextMemoryPolicies>>[number];
type MemoryDetailResult = Awaited<ReturnType<typeof getContextMemoryDetail>>;
type MemoryDetail = Exclude<MemoryDetailResult, "not_found">;
type AgentEvalSuite = Awaited<ReturnType<typeof listAgentEvalSuites>>[number];
type ContextEvaluationSet = Awaited<ReturnType<typeof listContextEvaluationSets>>[number];
type ContextEvaluationSource = Awaited<ReturnType<typeof listContextEvaluationSourceChunks>>[number];
type ContextEvaluationCaseDraft = {
  query: string;
  assetTypes: ["research_sample"];
  scopes: ["workspace"];
  topK: number;
  expectedChunkPublicIds: [string];
  labelNote: string;
  sourceTitle: string;
  sourcePreview: string;
};
type Notice = { kind: "success" | "error"; text: string } | null;
type Filter = "all" | "memory" | "pending" | "active" | "attention";

const assetTypeLabels: Record<string, string> = {
  core_memory: "Core Memory",
  working_memory: "Working Memory",
  team_memory: "Team Memory",
  document: "Document",
  research_sample: "Research Sample",
  persona: "Persona",
  study_context: "Study Context",
};

const purposeLabels: Record<string, string> = {
  general: "通用",
  intent_planning: "意图规划",
  research_execution: "研究执行",
  realtime_interview: "实时访谈",
  report_generation: "报告生成",
  skill_execution: "Skill 执行",
};

const relationLabels: Record<string, string> = {
  derived_from: "Derived from",
  supports: "Supports",
  contradicts: "Contradicts",
  mentions: "Mentions",
  supersedes: "Supersedes",
  related_to: "Related to",
};

function assetIcon(assetType: string) {
  if (assetType === "persona") return <UserRound size={17} />;
  if (assetType.endsWith("memory")) return <Database size={17} />;
  if (assetType === "research_sample") return <FileJson size={17} />;
  return <FileText size={17} />;
}

function statusLabel(asset: ContextAsset) {
  if (asset.status === "tombstoned") return "已下架";
  if (asset.reviewStatus === "pending") return "待审核";
  if (asset.reviewStatus === "rejected") return "已拒绝";
  return "可检索";
}

function governanceAttention(asset: ContextAsset) {
  return asset.consentStatus === "unknown" || asset.piiStatus === "not_reviewed" || asset.piiStatus === "present";
}

function evaluationMetric(metrics: Record<string, unknown>, key: string) {
  const value = Number(metrics[key]);
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function evaluationGate(metrics: Record<string, unknown>) {
  const gate = metrics.gate;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return null;
  return gate as { eligibleForIndexTrial?: boolean; reasons?: string[] };
}

export function ContextAssetWorkspace({
  initialAssets,
  initialPolicies,
  initialAgentEvalSuites,
  initialEvaluationSets,
  initialEvaluationSources,
  canCreate,
  canReview,
}: {
  initialAssets: ContextAsset[];
  initialPolicies: MemoryPolicy[];
  initialAgentEvalSuites: AgentEvalSuite[];
  initialEvaluationSets: ContextEvaluationSet[];
  initialEvaluationSources: ContextEvaluationSource[];
  canCreate: boolean;
  canReview: boolean;
}) {
  const [assets, setAssets] = useState(initialAssets);
  const [policies, setPolicies] = useState(initialPolicies);
  const [evaluationSets, setEvaluationSets] = useState(initialEvaluationSets);
  const [evaluationSources, setEvaluationSources] = useState(initialEvaluationSources);
  const [evaluationCases, setEvaluationCases] = useState<ContextEvaluationCaseDraft[]>([]);
  const [evaluationBuilderOpen, setEvaluationBuilderOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [selectedId, setSelectedId] = useState(initialAssets[0]?.publicId ?? null);
  const [importOpen, setImportOpen] = useState(initialAssets.length === 0 && canCreate);
  const [assetType, setAssetType] = useState("document");
  const [scope, setScope] = useState<"user" | "workspace" | "study">("workspace");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [relationTarget, setRelationTarget] = useState("");
  const [relation, setRelation] = useState("related_to");
  const [relationNote, setRelationNote] = useState("");
  const [memoryDetail, setMemoryDetail] = useState<MemoryDetail | null>(null);
  const [promotionTarget, setPromotionTarget] = useState<"core" | "team">("core");

  const visibleAssets = useMemo(() => assets.filter((asset) => {
    if (filter === "memory" && !asset.memoryKind) return false;
    if (filter === "pending" && asset.reviewStatus !== "pending") return false;
    if (filter === "active" && asset.status !== "active") return false;
    if (filter === "attention" && !governanceAttention(asset)) return false;
    if (!deferredSearch) return true;
    return `${asset.title} ${asset.description} ${asset.sourceName ?? ""} ${asset.assetType}`.toLowerCase().includes(deferredSearch);
  }), [assets, deferredSearch, filter]);

  const selected = assets.find((asset) => asset.publicId === selectedId) ?? null;
  const metrics = useMemo(() => ({
    memory: assets.filter((asset) => asset.memoryKind && asset.status !== "tombstoned").length,
    pending: assets.filter((asset) => asset.reviewStatus === "pending").length,
    active: assets.filter((asset) => asset.status === "active").length,
    attention: assets.filter((asset) => governanceAttention(asset) && asset.status !== "tombstoned").length,
  }), [assets]);

  const loadMemoryDetail = useCallback(async (publicId: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/context/${publicId}/memory`, { cache: "no-store", signal });
    const body = await response.json() as { memory?: MemoryDetail; error?: string };
    if (!response.ok || !body.memory) throw new Error(body.error ?? "Memory 详情加载失败");
    return body.memory;
  }, []);

  useEffect(() => {
    if (!selected?.memoryKind) return;
    const controller = new AbortController();
    void loadMemoryDetail(selected.publicId, controller.signal)
      .then((detail) => setMemoryDetail(detail))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setNotice({ kind: "error", text: error instanceof Error ? error.message : "Memory 详情加载失败" });
      });
    return () => controller.abort();
  }, [loadMemoryDetail, selected?.memoryKind, selected?.publicId]);

  async function reloadAssets(preferredId?: string) {
    const response = await fetch("/api/context", { cache: "no-store" });
    const body = await response.json() as { assets?: ContextAsset[]; error?: string };
    if (!response.ok || !body.assets) throw new Error(body.error ?? "Context 资产刷新失败");
    setAssets(body.assets);
    const nextId = preferredId ?? selectedId;
    setSelectedId(nextId && body.assets.some((asset) => asset.publicId === nextId) ? nextId : body.assets[0]?.publicId ?? null);
  }

  async function reloadPolicies() {
    const response = await fetch("/api/context/memory/policies", { cache: "no-store" });
    const body = await response.json() as { policies?: MemoryPolicy[]; error?: string };
    if (!response.ok || !body.policies) throw new Error(body.error ?? "Memory policy 刷新失败");
    setPolicies(body.policies);
  }

  async function reloadEvaluations() {
    const [setsResponse, sourcesResponse] = await Promise.all([
      fetch("/api/context/evaluations", { cache: "no-store" }),
      fetch("/api/context/evaluation-sources", { cache: "no-store" }),
    ]);
    const setsBody = await setsResponse.json() as { evaluationSets?: ContextEvaluationSet[]; error?: string };
    const sourcesBody = await sourcesResponse.json() as { sources?: ContextEvaluationSource[]; error?: string };
    if (!setsResponse.ok || !setsBody.evaluationSets) throw new Error(setsBody.error ?? "检索评估集刷新失败");
    if (!sourcesResponse.ok || !sourcesBody.sources) throw new Error(sourcesBody.error ?? "评估样本刷新失败");
    setEvaluationSets(setsBody.evaluationSets);
    setEvaluationSources(sourcesBody.sources);
  }

  function addEvaluationCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const sourcePublicId = String(data.get("sourcePublicId") ?? "");
    const source = evaluationSources.find((item) => item.publicId === sourcePublicId);
    if (!source) {
      setNotice({ kind: "error", text: "请选择已授权的真实研究样本 chunk" });
      return;
    }
    const query = String(data.get("query") ?? "").trim();
    const labelNote = String(data.get("labelNote") ?? "").trim();
    setEvaluationCases((current) => [...current, {
      query,
      assetTypes: ["research_sample"],
      scopes: ["workspace"],
      topK: Number(data.get("topK") ?? 8),
      expectedChunkPublicIds: [source.publicId],
      labelNote,
      sourceTitle: source.title,
      sourcePreview: source.contentPreview,
    }]);
    form.reset();
    setNotice(null);
  }

  async function createEvaluationSet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!evaluationCases.length) return;
    setBusy("evaluation:create");
    setNotice(null);
    try {
      const data = new FormData(event.currentTarget);
      const response = await fetch("/api/context/evaluations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          description: data.get("description"),
          labelingProtocol: "human_relevance_v1",
          cases: evaluationCases.map((item) => ({
            query: item.query,
            assetTypes: item.assetTypes,
            scopes: item.scopes,
            topK: item.topK,
            expectedChunkPublicIds: item.expectedChunkPublicIds,
            labelNote: item.labelNote,
          })),
        }),
      });
      const body = await response.json() as { caseCount?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? "检索评估集创建失败");
      setEvaluationCases([]);
      setEvaluationBuilderOpen(false);
      await reloadEvaluations();
      setNotice({ kind: "success", text: `已保存 ${body.caseCount ?? 0} 条人工相关性标签` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "检索评估集创建失败" });
    } finally {
      setBusy(null);
    }
  }

  async function runEvaluation(publicId: string, provider: "baseline" | "openai") {
    setBusy(`evaluation:${publicId}:${provider}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/context/evaluations/${publicId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const body = await response.json() as { gate?: { eligibleForIndexTrial?: boolean }; error?: string };
      if (!response.ok) throw new Error(body.error ?? "检索评估运行失败");
      await reloadEvaluations();
      const status = provider === "baseline"
        ? "基线评估已完成"
        : body.gate?.eligibleForIndexTrial ? "候选已通过 shadow index 试验门槛" : "候选未通过 shadow index 试验门槛";
      setNotice({ kind: "success", text: status });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "检索评估运行失败" });
    } finally {
      setBusy(null);
    }
  }

  async function refreshMemory(publicId: string) {
    setMemoryDetail(await loadMemoryDetail(publicId));
  }

  async function updatePolicy(event: FormEvent<HTMLFormElement>, policy: MemoryPolicy) {
    event.preventDefault();
    setBusy(`policy:${policy.publicId}`);
    setNotice(null);
    try {
      const data = new FormData(event.currentTarget);
      const optionalNumber = (name: string) => {
        const value = String(data.get(name) ?? "").trim();
        return value ? Number(value) : null;
      };
      const response = await fetch(`/api/context/memory/policies/${policy.publicId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          allowedPurposes: data.getAll("allowedPurposes").map(String),
          reviewRequired: data.get("reviewRequired") === "on",
          defaultRetentionDays: optionalNumber("defaultRetentionDays"),
          decayDays: optionalNumber("decayDays"),
          promotionMinObservations: Number(data.get("promotionMinObservations")),
          conflictStrategy: data.get("conflictStrategy"),
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Memory policy 更新失败");
      await Promise.all([reloadPolicies(), reloadAssets(selectedId ?? undefined)]);
      setNotice({ kind: "success", text: `${policy.name} 已发布为新的不可变版本` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Memory policy 更新失败" });
    } finally {
      setBusy(null);
    }
  }

  async function submitObservation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(`observation:${selected.publicId}`);
    setNotice(null);
    try {
      const form = event.currentTarget;
      const data = new FormData(form);
      const validUntil = String(data.get("validUntil") ?? "");
      const response = await fetch(`/api/context/${selected.publicId}/memory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceAssetPublicId: data.get("sourceAssetPublicId"),
          observationType: data.get("observationType"),
          statement: data.get("statement"),
          evidenceKind: data.get("evidenceKind"),
          confidence: data.get("confidence"),
          observedAt: new Date(String(data.get("observedAt"))).toISOString(),
          validUntil: validUntil ? new Date(`${validUntil}T23:59:59.000Z`).toISOString() : null,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "行为观察提交失败");
      form.reset();
      await refreshMemory(selected.publicId);
      setNotice({ kind: "success", text: "行为观察已进入待审核队列" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "行为观察提交失败" });
    } finally {
      setBusy(null);
    }
  }

  async function reviewObservation(observationPublicId: string, action: "approve" | "reject") {
    if (!selected) return;
    const note = action === "reject" ? window.prompt("填写拒绝原因")?.trim() ?? "" : "";
    if (action === "reject" && note.length < 2) return;
    setBusy(`observation-review:${observationPublicId}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/context/${selected.publicId}/memory`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ observationPublicId, action, note }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "行为观察审核失败");
      await Promise.all([refreshMemory(selected.publicId), reloadAssets(selected.publicId)]);
      setNotice({ kind: "success", text: action === "approve" ? "观察已批准" : "观察已拒绝" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "行为观察审核失败" });
    } finally {
      setBusy(null);
    }
  }

  async function promoteMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(`promote:${selected.publicId}`);
    setNotice(null);
    try {
      const data = new FormData(event.currentTarget);
      const response = await fetch(`/api/context/${selected.publicId}/memory`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "promote", targetMemoryKind: promotionTarget, note: data.get("note") }),
      });
      const body = await response.json() as { publicId?: string; error?: string };
      if (!response.ok || !body.publicId) throw new Error(body.error ?? "Memory 晋升失败");
      await reloadAssets(body.publicId);
      setNotice({ kind: "success", text: "晋升候选已创建，批准后才会进入长期检索" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Memory 晋升失败" });
    } finally {
      setBusy(null);
    }
  }

  async function submitImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    setBusy("import");
    try {
      const form = event.currentTarget;
      const data = new FormData(form);
      const file = data.get("file");
      let content = String(data.get("content") ?? "").trim();
      let sourceName = String(data.get("sourceName") ?? "").trim() || null;
      let sourceMimeType: string | null = null;
      let ingestionMethod: "manual" | "file" = "manual";
      let title = String(data.get("title") ?? "").trim();
      if (file instanceof File && file.size > 0) {
        if (file.size > 512_000) throw new Error("单个文件不能超过 500 KB");
        content = await file.text();
        if (file.name.toLowerCase().endsWith(".json")) {
          try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { throw new Error("JSON 文件格式无效"); }
        }
        sourceName = file.name;
        sourceMimeType = file.type || "text/plain";
        ingestionMethod = "file";
        if (!title) title = file.name.replace(/\.[^.]+$/, "");
      }
      if (!content.trim()) throw new Error("请选择文件或填写资产内容");
      if (content.length > 200_000) throw new Error("资产内容不能超过 200,000 字符");
      const retentionDate = String(data.get("retentionExpiresAt") ?? "");
      const response = await fetch("/api/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assetType,
          scope,
          studyPublicId: scope === "study" ? String(data.get("studyPublicId") ?? "").trim() : null,
          title,
          description: String(data.get("description") ?? ""),
          sourceUri: String(data.get("sourceUri") ?? "").trim() || null,
          content,
          changeNote: "Imported for review",
          ingestionMethod,
          sourceName,
          sourceMimeType,
          evidenceKind: data.get("evidenceKind"),
          consentStatus: data.get("consentStatus"),
          piiStatus: data.get("piiStatus"),
          retentionExpiresAt: retentionDate ? new Date(`${retentionDate}T23:59:59.000Z`).toISOString() : null,
          memoryConfidence: data.get("memoryConfidence"),
          reviewStatus: "pending",
        }),
      });
      const body = await response.json() as { publicId?: string; error?: string };
      if (!response.ok || !body.publicId) throw new Error(body.error ?? "Context 资产导入失败");
      form.reset();
      setAssetType("document");
      setScope("workspace");
      setImportOpen(false);
      await reloadAssets(body.publicId);
      setNotice({ kind: "success", text: "资产已进入待审核队列" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Context 资产导入失败" });
    } finally {
      setBusy(null);
    }
  }

  async function review(action: "approve" | "reject") {
    if (!selected) return;
    setBusy(`review:${selected.publicId}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/context/${selected.publicId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, note: reviewNote }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "审核失败");
      await reloadAssets(selected.publicId);
      setReviewNote("");
      setNotice({ kind: "success", text: action === "approve" ? "资产已批准并进入检索" : "资产已拒绝" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "审核失败" });
    } finally {
      setBusy(null);
    }
  }

  async function reindex() {
    if (!selected) return;
    setBusy(`reindex:${selected.publicId}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/context/${selected.publicId}/reindex`, { method: "POST" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "重建索引失败");
      await reloadAssets(selected.publicId);
      setNotice({ kind: "success", text: "资产索引已重建" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "重建索引失败" });
    } finally {
      setBusy(null);
    }
  }

  async function tombstone() {
    if (!selected) return;
    setBusy(`delete:${selected.publicId}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/context/${selected.publicId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reviewNote || "由工作区用户下架该资产" }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "下架失败");
      await reloadAssets(selected.publicId);
      setReviewNote("");
      setNotice({ kind: "success", text: "资产已下架，历史检索快照保留" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "下架失败" });
    } finally {
      setBusy(null);
    }
  }

  async function linkAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !relationTarget) return;
    setBusy(`link:${selected.publicId}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/context/${selected.publicId}/edges`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetPublicId: relationTarget, relation, note: relationNote }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "资产关联失败");
      setRelationTarget("");
      setRelationNote("");
      await reloadAssets(selected.publicId);
      setNotice({ kind: "success", text: "资产关系已保存" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "资产关联失败" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="context-asset-workspace">
      <section className="context-asset-metrics" aria-label="Context 资产状态">
        <div><Database size={18} /><span>全部资产</span><strong>{assets.length}</strong></div>
        <div><BrainCircuit size={18} /><span>Memory</span><strong>{metrics.memory}</strong></div>
        <div><FileClock size={18} /><span>待审核</span><strong>{metrics.pending}</strong></div>
        <div><FileCheck2 size={18} /><span>可检索</span><strong>{metrics.active}</strong></div>
        <div><ShieldAlert size={18} /><span>治理待处理</span><strong>{metrics.attention}</strong></div>
      </section>
      {notice ? <div className={`context-notice ${notice.kind}`} role="status">{notice.kind === "success" ? <Check size={15} /> : <CircleAlert size={15} />}<span>{notice.text}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div> : null}

      <section className="context-retrieval-evals" aria-label="检索评估">
        <header><div><Beaker size={15} /><strong>检索评估</strong><span>HUMAN RELEVANCE · GATE 20</span></div>{canReview ? <button className="button button-muted" type="button" onClick={() => setEvaluationBuilderOpen((value) => !value)}>{evaluationBuilderOpen ? <X size={14} /> : <Plus size={14} />}{evaluationBuilderOpen ? "取消" : "新建评估集"}</button> : null}</header>
        {evaluationBuilderOpen ? <div className="context-evaluation-builder">
          <form className="context-evaluation-case-form" onSubmit={addEvaluationCase}>
            <label><span>真实用户会使用的检索问题</span><input name="query" required minLength={2} maxLength={1000} /></label>
            <label><span>人工确认相关的样本 chunk</span><select name="sourcePublicId" required defaultValue=""><option value="">选择已授权样本</option>{evaluationSources.map((source) => <option key={source.publicId} value={source.publicId}>{source.title} · {source.contentPreview.slice(0, 72)}</option>)}</select></label>
            <div><label><span>Top K</span><input name="topK" type="number" min={1} max={20} defaultValue={8} /></label><label><span>相关性判断依据</span><input name="labelNote" required minLength={2} maxLength={1000} /></label></div>
            <button className="button button-muted" type="submit" disabled={!evaluationSources.length}><Plus size={14} />加入标签</button>
          </form>
          <form className="context-evaluation-set-form" onSubmit={createEvaluationSet}>
            <header><strong>待保存标签</strong><span>{evaluationCases.length} / 20</span></header>
            <div className="context-evaluation-case-drafts">{evaluationCases.map((item, index) => <article key={`${item.expectedChunkPublicIds[0]}:${index}`}><div><strong>{item.query}</strong><span>{item.sourceTitle}</span><small>{item.labelNote}</small></div><button type="button" title="移除标签" onClick={() => setEvaluationCases((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={14} /></button></article>)}{evaluationCases.length === 0 ? <p>尚无标签</p> : null}</div>
            <div><label><span>评估集名称</span><input name="name" required minLength={2} maxLength={180} /></label><label><span>描述</span><input name="description" maxLength={1000} /></label></div>
            <footer><span>{evaluationSources.length} 个合规样本 chunk 可标注</span><button className="button button-green" type="submit" disabled={!evaluationCases.length || busy !== null}>{busy === "evaluation:create" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存评估集</button></footer>
          </form>
        </div> : null}
        <div className="context-evaluation-list">{evaluationSets.map((evaluationSet) => {
          const latestRun = evaluationSet.runs[0] ?? null;
          const gate = latestRun ? evaluationGate(latestRun.metrics) : null;
          const ready = evaluationSet.humanLabeledCaseCount >= 20;
          return <article key={evaluationSet.publicId}>
            <div className="context-evaluation-heading"><div><strong>{evaluationSet.name}</strong><code>{evaluationSet.labelingProtocol}</code></div><span className={ready ? "ready" : "pending"}>{evaluationSet.humanLabeledCaseCount} / 20</span></div>
            <div className="context-evaluation-progress"><span style={{ width: `${Math.min(100, evaluationSet.humanLabeledCaseCount * 5)}%` }} /></div>
            <dl><div><dt>Precision@K</dt><dd>{latestRun ? evaluationMetric(latestRun.metrics, "precisionAtK") : "—"}</dd></div><div><dt>Recall@K</dt><dd>{latestRun ? evaluationMetric(latestRun.metrics, "recallAtK") : "—"}</dd></div><div><dt>MRR</dt><dd>{latestRun ? evaluationMetric(latestRun.metrics, "meanReciprocalRank") : "—"}</dd></div></dl>
            <footer><span>{gate?.eligibleForIndexTrial ? "已通过 shadow index 门槛" : latestRun ? gate?.reasons?.[0] ?? latestRun.status : "尚未运行"}</span>{canReview ? <div><button type="button" title="运行确定性基线" disabled={busy !== null} onClick={() => runEvaluation(evaluationSet.publicId, "baseline")}>{busy === `evaluation:${evaluationSet.publicId}:baseline` ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}Baseline</button><button type="button" title="评估生产 embedding 候选" disabled={busy !== null || !ready} onClick={() => runEvaluation(evaluationSet.publicId, "openai")}>{busy === `evaluation:${evaluationSet.publicId}:openai` ? <LoaderCircle className="spin" size={14} /> : <Beaker size={14} />}Candidate</button></div> : null}</footer>
          </article>;
        })}{evaluationSets.length === 0 ? <p className="context-agent-eval-empty">尚无人工相关性评估集。</p> : null}</div>
      </section>

      <section className="context-agent-evals" aria-label="Agent Eval">
        <header><FileCheck2 size={15} /><strong>Agent Eval</strong><span>授权源 · 人工标签与裁决分离</span></header>
        {initialAgentEvalSuites.length ? <div className="context-agent-eval-list">
          {initialAgentEvalSuites.map((suite) => <article key={suite.publicId}>
            <div className="context-agent-eval-name"><strong>{suite.name}</strong><code>{suite.suiteKey} · v{suite.version}</code></div>
            <div className="context-agent-eval-dimensions">{suite.trustDimensions.map((dimension) => <span key={dimension}>{dimension === "fabricated_citation" ? "引用真实性" : "Persona 收敛"}</span>)}</div>
            <dl><div><dt>Cases</dt><dd>{suite.caseCount}</dd></div><div><dt>状态</dt><dd>{suite.status === "active" ? "已启用" : suite.status}</dd></div><div><dt>最近运行</dt><dd>{suite.latestRun ? `${suite.latestRun.passedCount} 通过 / ${suite.latestRun.failedCount} 失败` : "未运行"}</dd></div></dl>
            {suite.latestRun?.failedCount ? <small className="context-agent-eval-failure">{suite.latestRun.failedCount} 个失败等待人工复核</small> : null}
          </article>)}
        </div> : <p className="context-agent-eval-empty">尚无 Agent Eval。仅能使用已授权的 Context 版本、报告版本或保留 Persona 创建评估集。</p>}
      </section>

      <section className="context-memory-policies" aria-label="Memory policy">
        <header><SlidersHorizontal size={15} /><strong>Memory policy</strong><span>目的约束 · 版本化</span></header>
        <div>
          {policies.map((policy) => (
            <details key={policy.publicId} className={`memory-policy kind-${policy.memoryKind}`}>
              <summary><span>{policy.name}</span><code>v{policy.version}</code><small>{policy.allowedPurposes.length} purposes</small></summary>
              <form onSubmit={(event) => updatePolicy(event, policy)}>
                <fieldset><legend>允许用途</legend>{Object.entries(purposeLabels).map(([value, label]) => <label key={value}><input name="allowedPurposes" type="checkbox" value={value} defaultChecked={policy.allowedPurposes.includes(value as never)} />{label}</label>)}</fieldset>
                <div className="memory-policy-fields">
                  <label><span>默认保留天数</span><input name="defaultRetentionDays" type="number" min={1} max={3650} defaultValue={policy.defaultRetentionDays ?? ""} /></label>
                  <label><span>衰减天数</span><input name="decayDays" type="number" min={1} max={3650} defaultValue={policy.decayDays ?? ""} /></label>
                  <label><span>晋升观察数</span><input name="promotionMinObservations" type="number" min={1} max={20} defaultValue={policy.promotionMinObservations} /></label>
                  <label><span>冲突策略</span><select name="conflictStrategy" defaultValue={policy.conflictStrategy}><option value="manual_review">人工审核</option><option value="keep_parallel">并行保留</option><option value="newest_verified">最新已验证</option></select></label>
                </div>
                <footer><label><input name="reviewRequired" type="checkbox" defaultChecked={policy.reviewRequired} />需要审核</label>{canReview ? <button className="button button-muted" type="submit" disabled={busy !== null}>{busy === `policy:${policy.publicId}` ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}发布新版本</button> : null}</footer>
              </form>
            </details>
          ))}
        </div>
      </section>

      <div className="context-asset-toolbar">
        <div className="context-filter-tabs" role="tablist" aria-label="资产筛选">
          {([['all','全部'],['memory','Memory'],['pending','待审核'],['active','可检索'],['attention','治理待处理']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <label className="context-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索资产" /></label>
        {canCreate ? <button className="button button-green" type="button" onClick={() => setImportOpen((value) => !value)}>{importOpen ? <X size={16} /> : <Plus size={16} />}{importOpen ? "取消" : "导入资产"}</button> : null}
      </div>

      {importOpen ? (
        <form className="context-import-form" onSubmit={submitImport}>
          <header><div><span>INGESTION</span><h2>新建待审核资产</h2></div><Upload size={20} /></header>
          <div className="context-form-grid">
            <label><span>文件</span><input name="file" type="file" accept=".txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json" /></label>
            <label><span>名称</span><input name="title" minLength={2} maxLength={180} /></label>
            <label><span>资产类型</span><select name="assetType" value={assetType} onChange={(event) => { const value = event.target.value; setAssetType(value); if (value === "core_memory") setScope("user"); else if (value === "team_memory") setScope("workspace"); else if (value === "working_memory" && scope === "workspace") setScope("user"); }}><option value="document">Document</option><option value="research_sample">Research Sample</option><option value="persona">Persona</option><option value="core_memory">Core Memory</option><option value="working_memory">Working Memory</option><option value="team_memory">Team Memory</option><option value="study_context">Study Context</option></select></label>
            <label><span>范围</span><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>{assetType !== "core_memory" && assetType !== "working_memory" ? <option value="workspace">工作区</option> : null}{assetType !== "team_memory" ? <option value="user">个人</option> : null}{assetType !== "core_memory" && assetType !== "team_memory" ? <option value="study">研究</option> : null}</select></label>
            {scope === "study" ? <label><span>Study Public ID</span><input name="studyPublicId" required minLength={8} maxLength={120} /></label> : null}
            <label><span>证据类型</span><select name="evidenceKind" defaultValue="not_applicable"><option value="human">真人</option><option value="synthetic">AI 合成</option><option value="mixed">混合</option><option value="not_applicable">不适用</option></select></label>
            <label><span>同意状态</span><select name="consentStatus" defaultValue="not_required"><option value="confirmed">已确认</option><option value="restricted">受限</option><option value="unknown">待确认</option><option value="not_required">不适用</option></select></label>
            <label><span>PII</span><select name="piiStatus" defaultValue="not_reviewed"><option value="none">无</option><option value="present">包含 PII</option><option value="redacted">已脱敏</option><option value="not_reviewed">待检查</option></select></label>
            <label><span>保留至</span><input name="retentionExpiresAt" type="date" /></label>
            {assetType.endsWith("_memory") ? <label><span>Memory 置信度</span><select name="memoryConfidence" defaultValue="low"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label> : <input name="memoryConfidence" type="hidden" value="low" />}
            <label className="context-form-wide"><span>来源 URL</span><input name="sourceUri" type="url" /></label>
            <label className="context-form-wide"><span>来源名称</span><input name="sourceName" maxLength={500} /></label>
            <label className="context-form-wide"><span>描述</span><input name="description" maxLength={1000} /></label>
            <label className="context-form-wide"><span>内容</span><textarea name="content" maxLength={200000} /></label>
          </div>
          <footer><span>创建后状态：待审核</span><button className="button button-green" type="submit" disabled={busy === "import"}>{busy === "import" ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}导入</button></footer>
        </form>
      ) : null}

      <div className="context-browser-layout">
        <section className="context-asset-list" aria-label="Context 资产列表">
          {visibleAssets.map((asset) => (
            <button type="button" className={selected?.publicId === asset.publicId ? "active" : ""} key={asset.publicId} onClick={() => setSelectedId(asset.publicId)}>
              <span className={`context-asset-icon type-${asset.assetType}`}>{assetIcon(asset.assetType)}</span>
              <span className="context-asset-row-main"><span><strong>{asset.title}</strong><code>{assetTypeLabels[asset.assetType] ?? asset.assetType}</code></span><small>{asset.description || asset.contentPreview || "—"}</small></span>
              <span className={`context-status review-${asset.reviewStatus}`}>{statusLabel(asset)}</span>
            </button>
          ))}
          {visibleAssets.length === 0 ? <div className="context-empty"><Database size={22} /><span>没有匹配的 Context 资产</span></div> : null}
        </section>

        <aside className="context-asset-detail" aria-label="Context 资产详情">
          {selected ? <>
            <header><div><span>{assetTypeLabels[selected.assetType] ?? selected.assetType}</span><h2>{selected.title}</h2></div><span className={`context-status review-${selected.reviewStatus}`}>{statusLabel(selected)}</span></header>
            <p className="context-detail-preview">{selected.contentPreview || "暂无内容预览"}</p>
            <dl className="context-governance-grid">
              <div><dt>来源</dt><dd>{selected.sourceName ?? selected.originKind ?? "手动录入"}</dd></div>
              <div><dt>版本 / Chunks</dt><dd>v{selected.currentVersion} / {selected.chunkCount}</dd></div>
              <div><dt>证据</dt><dd>{selected.evidenceKind}</dd></div>
              <div><dt>同意</dt><dd>{selected.consentStatus}</dd></div>
              <div><dt>PII</dt><dd>{selected.piiStatus}</dd></div>
              <div><dt>关系</dt><dd>{selected.relationCount}</dd></div>
              <div><dt>内容 Hash</dt><dd><code title={selected.contentHash}>{selected.contentHash.slice(0, 12)}</code></dd></div>
              <div><dt>保留期</dt><dd>{selected.retentionExpiresAt ? new Date(selected.retentionExpiresAt).toLocaleDateString("zh-CN") : "工作区默认"}</dd></div>
            </dl>
            {selected.memoryKind ? <section className="context-memory-detail">
              {!memoryDetail || memoryDetail.publicId !== selected.publicId ? <div className="context-memory-loading"><LoaderCircle className="spin" size={16} />加载 Memory 治理记录</div> : null}
              {memoryDetail && memoryDetail.publicId === selected.publicId ? <>
                <header><BrainCircuit size={15} /><strong>{memoryDetail.memoryKind.toUpperCase()} MEMORY</strong><code>{memoryDetail.policy.publicId} · v{memoryDetail.policy.version}</code></header>
                <dl className="context-memory-summary">
                  <div><dt>主体</dt><dd>{memoryDetail.binding.subjectType}{memoryDetail.binding.subjectPublicId ? ` · ${memoryDetail.binding.subjectPublicId}` : ""}</dd></div>
                  <div><dt>置信度</dt><dd>{memoryDetail.binding.confidence}</dd></div>
                  <div><dt>有效期</dt><dd>{memoryDetail.binding.validUntil ? new Date(memoryDetail.binding.validUntil).toLocaleDateString("zh-CN") : "持续有效"}</dd></div>
                  <div><dt>晋升状态</dt><dd>{memoryDetail.binding.promotionStatus}</dd></div>
                </dl>
                <div className="context-memory-purposes">{memoryDetail.policy.allowedPurposes.map((purpose) => <span key={purpose}>{purposeLabels[purpose] ?? purpose}</span>)}</div>

                {memoryDetail.memoryKind === "working" && canCreate && selected.status !== "tombstoned" ? <form className="context-observation-form" onSubmit={submitObservation}>
                  <header><strong>添加行为观察</strong><span>{memoryDetail.observations.filter((item) => item.status === "approved").length} / {memoryDetail.policy.promotionMinObservations} 已批准</span></header>
                  <select name="sourceAssetPublicId" required defaultValue=""><option value="">选择证据来源</option>{assets.filter((asset) => asset.publicId !== selected.publicId && asset.status === "active").map((asset) => <option key={asset.publicId} value={asset.publicId}>{asset.title}</option>)}</select>
                  <div><select name="observationType" defaultValue="preference"><option value="preference">偏好</option><option value="habit">习惯</option><option value="constraint">约束</option><option value="decision_signal">决策信号</option></select><select name="evidenceKind" defaultValue="human_observation"><option value="human_observation">人类观察</option><option value="public_source">公开资料</option><option value="synthetic_simulation">合成模拟</option><option value="model_inference">模型推断</option></select><select name="confidence" defaultValue="medium"><option value="low">低置信</option><option value="medium">中置信</option><option value="high">高置信</option></select></div>
                  <textarea name="statement" required minLength={2} maxLength={2000} placeholder="行为观察" />
                  <div><label><span>观察时间</span><input name="observedAt" type="datetime-local" required /></label><label><span>有效至</span><input name="validUntil" type="date" /></label></div>
                  <button className="button button-muted" type="submit" disabled={busy !== null}>{busy === `observation:${selected.publicId}` ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}提交观察</button>
                </form> : null}

                <section className="context-observation-list">
                  <header><strong>行为观察</strong><span>{memoryDetail.observations.length}</span></header>
                  {memoryDetail.observations.map((observation) => <article key={observation.publicId}>
                    <div><span className={`context-status review-${observation.status}`}>{observation.status}</span><code>{observation.observationType} · {observation.confidence}</code></div>
                    <p>{observation.statement}</p>
                    <small>{observation.sourceAssetTitle ?? observation.sourceAssetPublicId} · {new Date(observation.observedAt).toLocaleString("zh-CN")}</small>
                    {canReview && observation.status === "pending" ? <footer><button type="button" title="批准观察" disabled={busy !== null} onClick={() => reviewObservation(observation.publicId, "approve")}><Check size={14} /></button><button type="button" title="拒绝观察" disabled={busy !== null} onClick={() => reviewObservation(observation.publicId, "reject")}><X size={14} /></button></footer> : null}
                  </article>)}
                  {memoryDetail.observations.length === 0 ? <p className="context-memory-empty">尚无行为观察</p> : null}
                </section>

                {memoryDetail.memoryKind === "working" && canCreate && selected.status === "active" ? <form className="context-memory-promotion" onSubmit={promoteMemory}>
                  <header><ArrowUpRight size={15} /><strong>晋升候选</strong></header>
                  <div className="context-segmented" role="radiogroup" aria-label="晋升目标"><button type="button" role="radio" aria-checked={promotionTarget === "core"} className={promotionTarget === "core" ? "active" : ""} onClick={() => setPromotionTarget("core")}>Core</button><button type="button" role="radio" aria-checked={promotionTarget === "team"} className={promotionTarget === "team" ? "active" : ""} onClick={() => setPromotionTarget("team")}>Team</button></div>
                  <textarea name="note" required minLength={2} maxLength={1000} placeholder="晋升备注" />
                  <button className="button button-muted" type="submit" disabled={busy !== null || memoryDetail.observations.filter((item) => item.status === "approved").length < memoryDetail.policy.promotionMinObservations}>{busy === `promote:${selected.publicId}` ? <LoaderCircle className="spin" size={14} /> : <ArrowUpRight size={14} />}创建待审核候选</button>
                </form> : null}

                <details className="context-memory-events"><summary>治理记录 <span>{memoryDetail.events.length}</span></summary>{memoryDetail.events.map((event) => <div key={event.publicId}><code>{event.eventType}</code><span>{event.actorName ?? "System"}</span><time>{new Date(event.createdAt).toLocaleString("zh-CN")}</time></div>)}</details>
              </> : null}
            </section> : null}
            {canReview && selected.status !== "tombstoned" ? <section className="context-review-controls"><label><span>审核备注</span><textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} maxLength={1000} /></label><div>{selected.reviewStatus === "pending" ? <><button className="button button-green" type="button" disabled={busy !== null} onClick={() => review("approve")}><Check size={15} />批准</button><button className="button button-muted" type="button" disabled={busy !== null} onClick={() => review("reject")}><X size={15} />拒绝</button></> : null}<button className="button button-muted" type="button" disabled={busy !== null || selected.status !== "active"} onClick={reindex}><RefreshCw size={15} />重建索引</button><button className="button button-danger" type="button" disabled={busy !== null} onClick={tombstone}><Archive size={15} />下架</button></div></section> : null}
            {canCreate && selected.status !== "tombstoned" ? <form className="context-relation-form" onSubmit={linkAsset}><header><Link2 size={15} /><strong>建立资产关系</strong></header><select value={relation} onChange={(event) => setRelation(event.target.value)}>{Object.entries(relationLabels).map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select><select value={relationTarget} required onChange={(event) => setRelationTarget(event.target.value)}><option value="">选择目标资产</option>{assets.filter((asset) => asset.publicId !== selected.publicId && asset.status !== "tombstoned").map((asset) => <option value={asset.publicId} key={asset.publicId}>{asset.title}</option>)}</select><input value={relationNote} onChange={(event) => setRelationNote(event.target.value)} maxLength={500} placeholder="备注" /><button className="button button-muted" type="submit" disabled={busy !== null || !relationTarget}><Link2 size={15} />保存关系</button></form> : null}
            <footer><ShieldCheck size={14} /><span>{selected.creatorName ?? "System"} · {new Date(selected.updatedAt).toLocaleString("zh-CN")}</span></footer>
          </> : <div className="context-empty"><Database size={22} /><span>选择一个资产</span></div>}
        </aside>
      </div>
    </div>
  );
}
