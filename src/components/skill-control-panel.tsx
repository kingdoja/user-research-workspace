"use client";

import {
  Ban,
  Blocks,
  Cable,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FileUp,
  HeartPulse,
  LoaderCircle,
  Plus,
  ServerCog,
  ShieldCheck,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useState, useTransition } from "react";
import type { SkillCapability, SkillSummary } from "@/lib/skill-gateway";

type Notice = { kind: "success" | "error"; text: string } | null;

const capabilityOptions: Array<{ value: SkillCapability; label: string }> = [
  { value: "network", label: "Network" },
  { value: "context_read", label: "Context" },
  { value: "files_read", label: "Files" },
  { value: "files_write", label: "Files write" },
  { value: "provider_invoke", label: "Provider" },
  { value: "code_execute", label: "Code" },
];

function executorLabel(type: SkillSummary["executorType"]) {
  if (type === "declarative_http") return "HTTP JSON";
  if (type === "mcp") return "MCP";
  if (type === "sandbox") return "Sandbox";
  if (type === "builtin") return "Builtin";
  return "未配置";
}

function statusLabel(status: SkillSummary["status"]) {
  if (status === "submitted") return "待审批";
  if (status === "revoked") return "已撤销";
  if (status === "draft") return "草稿";
  if (status === "archived") return "已归档";
  return "已批准";
}

function grantsFor(skill: SkillSummary) {
  return (skill.requestedCapabilities ?? []).map((capability) => ({ capability, scope: {} }));
}

export function SkillControlPanel({
  initialSkills,
  canManageBuiltins,
  canCreate,
}: {
  initialSkills: SkillSummary[];
  canManageBuiltins: boolean;
  canCreate: boolean;
}) {
  const router = useRouter();
  const [skills, setSkills] = useState(initialSkills);
  const [notice, setNotice] = useState<Notice>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [executorType, setExecutorType] = useState<"declarative_http" | "mcp">("mcp");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function readJson(response: Response) {
    return response.json().catch(() => ({})) as Promise<{ error?: string }>;
  }

  async function toggle(skill: SkillSummary) {
    const key = `${skill.source}:${skill.slug}`;
    setBusyKey(key);
    setNotice(null);
    try {
      const response = await fetch("/api/skills/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: skill.source, slug: skill.slug, publicId: skill.publicId, enabled: !skill.enabled }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error ?? "Skill 设置更新失败");
      setSkills((current) => current.map((item) => (
        item.source === skill.source && item.slug === skill.slug
          ? { ...item, enabled: !item.enabled, status: !item.enabled && item.status === "draft" ? "active" : item.status }
          : item
      )));
      setNotice({ kind: "success", text: `${skill.name} 已${skill.enabled ? "禁用" : "启用"}` });
      refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Skill 设置更新失败" });
    } finally {
      setBusyKey(null);
    }
  }

  async function createSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    const data = new FormData(event.currentTarget);
    let inputSchema: Record<string, unknown>;
    let outputSchema: Record<string, unknown>;
    try {
      inputSchema = JSON.parse(String(data.get("inputSchema"))) as Record<string, unknown>;
      outputSchema = JSON.parse(String(data.get("outputSchema"))) as Record<string, unknown>;
    } catch {
      setNotice({ kind: "error", text: "Input / Output Schema 必须是有效 JSON" });
      return;
    }
    const executor = {
      kind: executorType,
      endpoint: String(data.get("endpoint")),
      timeoutMs: 30_000,
      maxResponseBytes: 262_144,
      headersFromEnv: {},
      ...(executorType === "mcp" ? { toolName: String(data.get("toolName")) } : { method: "POST" }),
    };
    const response = await fetch("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: String(data.get("slug")),
        name: String(data.get("name")),
        description: String(data.get("description")),
        visibility: "workspace",
        capabilities: String(data.get("capabilities")).split(",").map((item) => item.trim()).filter(Boolean),
        capabilityRequests: data.getAll("capabilityRequests").map(String),
        inputSchema,
        outputSchema,
        executor,
      }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      setNotice({ kind: "error", text: body.error ?? "Skill 注册失败" });
      return;
    }
    event.currentTarget.reset();
    setCreateOpen(false);
    setNotice({ kind: "success", text: "远程 Skill 已注册，权限已按最小范围记录" });
    refresh();
  }

  async function importPackage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > 256_000) {
      setNotice({ kind: "error", text: ".skill 包超过 256 KB 限制" });
      return;
    }
    setBusyKey("package-import");
    setNotice(null);
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as unknown;
      const response = await fetch("/api/skills/packages/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error ?? "Skill 包导入失败");
      setImportOpen(false);
      setNotice({ kind: "success", text: "Skill 包已提交，等待管理员审批权限" });
      refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : ".skill 包不是有效 JSON" });
    } finally {
      setBusyKey(null);
    }
  }

  async function approve(skill: SkillSummary) {
    if (!skill.publicId) return;
    const key = `approve:${skill.publicId}`;
    setBusyKey(key);
    setNotice(null);
    try {
      const response = await fetch(`/api/skills/${skill.publicId}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grants: grantsFor(skill) }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error ?? "Skill 审批失败");
      setNotice({ kind: "success", text: `${skill.name} 已审批，可选择启用` });
      refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Skill 审批失败" });
    } finally {
      setBusyKey(null);
    }
  }

  async function probe(skill: SkillSummary) {
    if (!skill.publicId) return;
    const key = `health:${skill.publicId}`;
    setBusyKey(key);
    setNotice(null);
    try {
      const response = await fetch(`/api/skills/${skill.publicId}/health`, { method: "POST" });
      const body = await readJson(response) as { error?: string; status?: string; latencyMs?: number };
      if (!response.ok) throw new Error(body.error ?? "Executor 探测失败");
      setNotice({ kind: "success", text: body.status === "healthy" ? `${skill.name} 可达${body.latencyMs ? `，${body.latencyMs} ms` : ""}` : `${skill.name} 探测未通过` });
      refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Executor 探测失败" });
    } finally {
      setBusyKey(null);
    }
  }

  async function revoke(skill: SkillSummary) {
    if (!skill.publicId) return;
    const key = `revoke:${skill.publicId}`;
    setBusyKey(key);
    setNotice(null);
    try {
      const response = await fetch(`/api/skills/${skill.publicId}/revoke`, { method: "POST" });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error ?? "Skill 撤销失败");
      setNotice({ kind: "success", text: `${skill.name} 已撤销，未来执行已阻断` });
      refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Skill 撤销失败" });
    } finally {
      setBusyKey(null);
    }
  }

  async function downloadPackage(skill: SkillSummary) {
    if (!skill.publicId) return;
    const key = `export:${skill.publicId}`;
    setBusyKey(key);
    setNotice(null);
    try {
      const response = await fetch(`/api/skills/${skill.publicId}/package`);
      if (!response.ok) {
        const body = await readJson(response);
        throw new Error(body.error ?? "Skill 包导出失败");
      }
      const content = await response.text();
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${skill.slug}.skill`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice({ kind: "success", text: `${skill.name} 已导出` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Skill 包导出失败" });
    } finally {
      setBusyKey(null);
    }
  }

  const builtin = skills.filter((skill) => skill.source === "builtin");
  const workspace = skills.filter((skill) => skill.source === "workspace");

  function renderActions(skill: SkillSummary) {
    if (skill.source === "builtin") return null;
    const actionBusy = (prefix: string) => busyKey === `${prefix}:${skill.publicId}` || pending;
    return (
      <div className="skill-governance-actions">
        {skill.status === "submitted" && canManageBuiltins ? (
          <button type="button" className="button button-green" disabled={actionBusy("approve")} onClick={() => approve(skill)}>
            {actionBusy("approve") ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}审批
          </button>
        ) : null}
        {skill.status === "active" && skill.packageFormat?.startsWith("atypica.skill/") ? (
          <button type="button" className="skill-icon-button" title="导出 .skill 包" aria-label={`导出 ${skill.name}`} disabled={actionBusy("export")} onClick={() => downloadPackage(skill)}>
            {actionBusy("export") ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
          </button>
        ) : null}
        {skill.status === "active" && canManageBuiltins ? (
          <button type="button" className="skill-icon-button" title="探测 Executor 健康状态" aria-label={`探测 ${skill.name}`} disabled={actionBusy("health")} onClick={() => probe(skill)}>
            {actionBusy("health") ? <LoaderCircle className="spin" size={14} /> : <HeartPulse size={14} />}
          </button>
        ) : null}
        {skill.status !== "revoked" && skill.status !== "archived" && canManageBuiltins ? (
          <button type="button" className="skill-icon-button danger" title="撤销 Skill" aria-label={`撤销 ${skill.name}`} disabled={actionBusy("revoke")} onClick={() => revoke(skill)}>
            {actionBusy("revoke") ? <LoaderCircle className="spin" size={14} /> : <Ban size={14} />}
          </button>
        ) : null}
      </div>
    );
  }

  function renderSkills(items: SkillSummary[]) {
    return items.map((skill) => {
      const key = `${skill.source}:${skill.slug}`;
      const canToggle = skill.source === "workspace" ? canCreate : canManageBuiltins;
      const hasPendingCapabilities = skill.capabilityState === "pending";
      return (
        <article className="skill-gateway-row" key={key}>
          <div className={`skill-gateway-icon executor-${skill.executorType}`}>
            {skill.executorType === "builtin" ? <Blocks size={18} /> : skill.executorType === "mcp" ? <Cable size={18} /> : <ServerCog size={18} />}
          </div>
          <div className="skill-gateway-main">
            <div><h3>{skill.name}</h3><code>{skill.slug}@{skill.version}</code></div>
            <p>{skill.description || "—"}</p>
            <div className="skill-capability-list">
              {skill.capabilities.slice(0, 4).map((capability) => <span key={capability}>{capability}</span>)}
              {(skill.requestedCapabilities ?? []).map((capability) => <span className="skill-security-capability" key={`requested-${capability}`}>{capability}</span>)}
            </div>
            {skill.source === "workspace" ? (
              <div className="skill-governance-meta">
                <span className={`skill-lifecycle ${skill.status}`}>{statusLabel(skill.status)}</span>
                <span>{skill.packageFormat === "atypica.skill/v2" ? ".skill v2 / sandbox" : skill.packageFormat === "atypica.skill/v1" ? ".skill / SKILL.md" : "inline manifest"}</span>
                <span>{hasPendingCapabilities ? "权限待批准" : skill.capabilityState === "granted" ? "权限已锁定" : "无需外部权限"}</span>
                {skill.packageFormat?.startsWith("atypica.skill/") ? <span>签名：{skill.signatureState === "declared_unverified" ? "已声明，未验证" : "未提供"}</span> : null}
                {skill.health ? <span className={`skill-health ${skill.health.status}`}>{skill.health.status === "healthy" ? "Executor healthy" : "Executor unhealthy"}</span> : null}
              </div>
            ) : null}
          </div>
          <div className="skill-gateway-version">
            <span>{executorLabel(skill.executorType)}</span>
            <code title={skill.contentHash ?? undefined}>{skill.contentHash?.slice(0, 10) ?? "runtime"}</code>
          </div>
          <div className="skill-gateway-state">
            <span className={skill.enabled ? "is-enabled" : "is-disabled"}>{skill.enabled ? "Enabled" : statusLabel(skill.status)}</span>
            <button
              className={skill.enabled ? "skill-switch active" : "skill-switch"}
              type="button"
              role="switch"
              aria-checked={skill.enabled}
              aria-label={`${skill.enabled ? "禁用" : "启用"} ${skill.name}`}
              disabled={!canToggle || !skill.executable || skill.status === "submitted" || skill.status === "revoked" || busyKey === key || pending}
              onClick={() => toggle(skill)}
            >
              <span>{busyKey === key ? <LoaderCircle className="spin" size={12} /> : null}</span>
            </button>
            {renderActions(skill)}
          </div>
        </article>
      );
    });
  }

  return (
    <div className="skill-control-panel">
      {notice ? (
        <div className={`skill-notice ${notice.kind}`} role="status">
          {notice.kind === "success" ? <Check size={15} /> : <CircleAlert size={15} />}
          <span>{notice.text}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button>
        </div>
      ) : null}

      <section className="skill-gateway-section">
        <header><div><span>平台能力</span><h2>内置 Skills</h2></div><strong>{builtin.filter((skill) => skill.enabled).length}/{builtin.length} enabled</strong></header>
        <div className="skill-gateway-list">{renderSkills(builtin)}</div>
      </section>

      <section className="skill-gateway-section">
        <header>
          <div><span>工作区能力</span><h2>受治理的远程 Skills</h2></div>
          {canCreate ? (
            <div className="skill-section-actions">
              <button className="button button-muted" type="button" onClick={() => setImportOpen((value) => !value)}><FileUp size={16} />导入 .skill<ChevronDown className={importOpen ? "rotate" : ""} size={15} /></button>
              <button className="button button-muted" type="button" onClick={() => setCreateOpen((value) => !value)}><Plus size={16} />注册 Skill<ChevronDown className={createOpen ? "rotate" : ""} size={15} /></button>
            </div>
          ) : null}
        </header>
        {importOpen ? (
          <div className="skill-package-import">
            <div><strong>导入受治理的 `.skill` 包</strong><p>v1 接受 manifest 与 `SKILL.md`；v2 可携带受限源码并绑定隔离 Runner。两者导入后都需要管理员审批精确权限。</p></div>
            <label className="button button-green" aria-disabled={busyKey === "package-import"}>
              {busyKey === "package-import" ? <LoaderCircle className="spin" size={15} /> : <FileUp size={15} />}选择 .skill
              <input type="file" accept=".skill,application/json" onChange={importPackage} disabled={busyKey === "package-import"} />
            </label>
          </div>
        ) : null}
        {createOpen ? (
          <form className="skill-register-form" onSubmit={createSkill}>
            <div className="skill-form-grid">
              <label><span>名称</span><input name="name" required minLength={2} maxLength={120} /></label>
              <label><span>Slug</span><input name="slug" required pattern="[a-z][a-z0-9-]+" placeholder="customer-signal" /></label>
              <label className="skill-form-wide"><span>描述</span><input name="description" maxLength={1000} /></label>
              <label><span>Executor</span><select value={executorType} onChange={(event) => setExecutorType(event.target.value as "declarative_http" | "mcp")}><option value="mcp">MCP Streamable HTTP</option><option value="declarative_http">HTTP JSON POST</option></select></label>
              <label><span>Endpoint</span><input name="endpoint" type="url" required placeholder="https://executor.example.com/mcp" /></label>
              {executorType === "mcp" ? <label><span>Tool name</span><input name="toolName" required placeholder="research_signal" /></label> : null}
              <label><span>业务能力</span><input name="capabilities" placeholder="research.read, insight.create" /></label>
              <fieldset className="skill-capability-requests"><legend>请求权限</legend>{capabilityOptions.map((option) => <label key={option.value}><input name="capabilityRequests" type="checkbox" value={option.value} />{option.label}</label>)}</fieldset>
              <label className="skill-form-schema"><span>Input Schema</span><textarea name="inputSchema" defaultValue={'{"type":"object","additionalProperties":true}'} /></label>
              <label className="skill-form-schema"><span>Output Schema</span><textarea name="outputSchema" defaultValue={'{"type":"object"}'} /></label>
            </div>
            <div className="skill-form-actions"><button className="button button-muted" type="button" onClick={() => setCreateOpen(false)}>取消</button><button className="button button-green" type="submit" disabled={pending}><Plus size={15} />注册</button></div>
          </form>
        ) : null}
        <div className="skill-gateway-list">
          {workspace.length ? renderSkills(workspace) : <div className="skill-gateway-empty"><Cable size={22} /><span>暂无工作区 Skill</span></div>}
        </div>
      </section>
    </div>
  );
}
