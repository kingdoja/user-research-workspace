"use client";

import {
  Blocks,
  Cable,
  Check,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Plus,
  ServerCog,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState, useTransition } from "react";
import type { SkillSummary } from "@/lib/skill-gateway";

type Notice = { kind: "success" | "error"; text: string } | null;

function executorLabel(type: SkillSummary["executorType"]) {
  if (type === "declarative_http") return "HTTP JSON";
  if (type === "mcp") return "MCP";
  if (type === "builtin") return "Builtin";
  return "未配置";
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
  const [executorType, setExecutorType] = useState<"declarative_http" | "mcp">("mcp");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function toggle(skill: SkillSummary) {
    const key = `${skill.source}:${skill.slug}`;
    setBusyKey(key);
    setNotice(null);
    try {
      const response = await fetch("/api/skills/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: skill.source,
          slug: skill.slug,
          publicId: skill.publicId,
          enabled: !skill.enabled,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Skill 设置更新失败");
      setSkills((current) => current.map((item) => (
        item.source === skill.source && item.slug === skill.slug
          ? { ...item, enabled: !item.enabled, status: !item.enabled && item.status === "draft" ? "active" : item.status }
          : item
      )));
      setNotice({ kind: "success", text: `${skill.name} 已${skill.enabled ? "禁用" : "启用"}` });
      startTransition(() => router.refresh());
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
        inputSchema,
        outputSchema,
        executor,
      }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) {
      setNotice({ kind: "error", text: body.error ?? "Skill 注册失败" });
      return;
    }
    event.currentTarget.reset();
    setCreateOpen(false);
    setNotice({ kind: "success", text: "远程 Skill 已注册，启用后可执行" });
    startTransition(() => router.refresh());
  }

  const builtin = skills.filter((skill) => skill.source === "builtin");
  const workspace = skills.filter((skill) => skill.source === "workspace");

  function renderSkills(items: SkillSummary[]) {
    return items.map((skill) => {
      const key = `${skill.source}:${skill.slug}`;
      const canToggle = skill.source === "workspace" ? canCreate : canManageBuiltins;
      return (
        <article className="skill-gateway-row" key={key}>
          <div className={`skill-gateway-icon executor-${skill.executorType}`}>
            {skill.executorType === "builtin" ? <Blocks size={18} /> : skill.executorType === "mcp" ? <Cable size={18} /> : <ServerCog size={18} />}
          </div>
          <div className="skill-gateway-main">
            <div><h3>{skill.name}</h3><code>{skill.slug}@{skill.version}</code></div>
            <p>{skill.description || "—"}</p>
            <div className="skill-capability-list">
              {skill.capabilities.slice(0, 5).map((capability) => <span key={capability}>{capability}</span>)}
            </div>
          </div>
          <div className="skill-gateway-version">
            <span>{executorLabel(skill.executorType)}</span>
            <code title={skill.contentHash ?? undefined}>{skill.contentHash?.slice(0, 10) ?? "runtime"}</code>
          </div>
          <div className="skill-gateway-state">
            <span className={skill.enabled ? "is-enabled" : "is-disabled"}>{skill.enabled ? "Enabled" : "Disabled"}</span>
            <button
              className={skill.enabled ? "skill-switch active" : "skill-switch"}
              type="button"
              role="switch"
              aria-checked={skill.enabled}
              aria-label={`${skill.enabled ? "禁用" : "启用"} ${skill.name}`}
              disabled={!canToggle || !skill.executable || busyKey === key || pending}
              onClick={() => toggle(skill)}
            >
              <span>{busyKey === key ? <LoaderCircle className="spin" size={12} /> : null}</span>
            </button>
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
          <div><span>工作区能力</span><h2>远程 Skills</h2></div>
          {canCreate ? <button className="button button-muted" type="button" onClick={() => setCreateOpen((value) => !value)}><Plus size={16} />注册 Skill<ChevronDown className={createOpen ? "rotate" : ""} size={15} /></button> : null}
        </header>
        {createOpen ? (
          <form className="skill-register-form" onSubmit={createSkill}>
            <div className="skill-form-grid">
              <label><span>名称</span><input name="name" required minLength={2} maxLength={120} /></label>
              <label><span>Slug</span><input name="slug" required pattern="[a-z][a-z0-9-]+" placeholder="customer-signal" /></label>
              <label className="skill-form-wide"><span>描述</span><input name="description" maxLength={1000} /></label>
              <label><span>Executor</span><select value={executorType} onChange={(event) => setExecutorType(event.target.value as "declarative_http" | "mcp")}><option value="mcp">MCP Streamable HTTP</option><option value="declarative_http">HTTP JSON POST</option></select></label>
              <label><span>Endpoint</span><input name="endpoint" type="url" required placeholder="https://executor.example.com/mcp" /></label>
              {executorType === "mcp" ? <label><span>Tool name</span><input name="toolName" required placeholder="research_signal" /></label> : null}
              <label><span>Capabilities</span><input name="capabilities" placeholder="research.read, insight.create" /></label>
              <label className="skill-form-schema"><span>Input Schema</span><textarea name="inputSchema" defaultValue={'{"type":"object","additionalProperties":true}'} /></label>
              <label className="skill-form-schema"><span>Output Schema</span><textarea name="outputSchema" defaultValue={'{"type":"object"}'} /></label>
            </div>
            <div className="skill-form-actions"><button className="button button-muted" type="button" onClick={() => setCreateOpen(false)}>取消</button><button className="button button-green" type="submit" disabled={pending}><Plus size={15} />注册</button></div>
          </form>
        ) : null}
        <div className="skill-gateway-list">
          {workspace.length ? renderSkills(workspace) : <div className="skill-gateway-empty"><Cable size={22} /><span>暂无远程 Skill</span></div>}
        </div>
      </section>
    </div>
  );
}
