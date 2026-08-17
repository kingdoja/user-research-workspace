"use client";

import { Check, Copy, KeyRound, LoaderCircle, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState, useTransition } from "react";
import type { ApiKeyScope, WorkspaceApiKey } from "@/lib/api-access";

const API_KEY_SCOPES: ApiKeyScope[] = [
  "context:read",
  "personas:read",
  "studies:read",
  "studies:write",
  "runs:read",
  "runs:write",
];

const scopeLabels: Record<ApiKeyScope, string> = {
  "context:read": "Context 检索",
  "personas:read": "Persona 读取",
  "studies:read": "研究读取",
  "studies:write": "研究创建与确认",
  "runs:read": "Run 与产物读取",
  "runs:write": "Run 取消",
};

function formatDate(value: string | null) {
  if (!value) return "不过期";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function AccountApiKeyManager({ initialApiKeys }: { initialApiKeys: WorkspaceApiKey[] }) {
  const router = useRouter();
  const [createdApiKeys, setCreatedApiKeys] = useState<WorkspaceApiKey[]>([]);
  const [revokedAtByPublicId, setRevokedAtByPublicId] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["context:read", "personas:read", "studies:read", "runs:read"]);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(90);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const createdIds = new Set(createdApiKeys.map((item) => item.publicId));
  const apiKeys = [...createdApiKeys, ...initialApiKeys.filter((item) => !createdIds.has(item.publicId))]
    .map((item) => revokedAtByPublicId[item.publicId]
      ? { ...item, revokedAt: revokedAtByPublicId[item.publicId] }
      : item);

  function toggleScope(scope: ApiKeyScope) {
    setScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]);
  }

  function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/account/api-keys", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, scopes, expiresInDays }),
        });
        const result = await response.json() as (WorkspaceApiKey & { secret: string }) | { error?: string };
        if (!response.ok || !("secret" in result)) {
          setError("error" in result ? result.error ?? "创建 API 密钥失败" : "创建 API 密钥失败");
          return;
        }
        const { secret: createdSecret, ...apiKey } = result;
        setSecret(createdSecret);
        setCreatedApiKeys((current) => [apiKey, ...current.filter((item) => item.publicId !== apiKey.publicId)]);
        setName("");
        setCreating(false);
        router.refresh();
      } catch {
        setError("网络异常，请稍后重试");
      }
    });
  }

  function revokeKey(publicId: string) {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/account/api-keys/${publicId}`, { method: "DELETE" });
        const result = await response.json() as { revokedAt?: string; error?: string };
        if (!response.ok || !result.revokedAt) {
          setError(result.error ?? "撤销 API 密钥失败");
          return;
        }
        setRevokedAtByPublicId((current) => ({ ...current, [publicId]: result.revokedAt as string }));
        router.refresh();
      } catch {
        setError("网络异常，请稍后重试");
      }
    });
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("浏览器未允许复制，请手动选择密钥");
    }
  }

  return (
    <section className="account-api-section">
      <header>
        <div><span>PROGRAMMATIC ACCESS</span><h2>Workspace API 密钥</h2><p>为外部 API 和 MCP 客户端分配最小权限。每次调用都会绑定工作区并记录审计事件。</p></div>
        <button type="button" className="button" onClick={() => setCreating((value) => !value)} disabled={pending}>
          {creating ? <X size={15} /> : <Plus size={15} />}{creating ? "取消" : "创建密钥"}
        </button>
      </header>

      {secret ? <div className="account-api-secret" role="status">
        <ShieldCheck size={19} />
        <div><strong>立即保存这个密钥</strong><p>它只显示这一次，服务端只保留哈希。</p><code>{secret}</code></div>
        <button type="button" onClick={copySecret} aria-label="复制 API 密钥" title="复制 API 密钥">{copied ? <Check size={16} /> : <Copy size={16} />}</button>
      </div> : null}

      {error ? <div className="account-api-message error">{error}</div> : null}

      {creating ? <form className="account-api-form" onSubmit={createKey}>
        <label><span>密钥名称</span><input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} placeholder="例如：Research automation" required /></label>
        <fieldset><legend>权限范围</legend><div>{API_KEY_SCOPES.map((scope) => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} /><span>{scopeLabels[scope]}</span><code>{scope}</code></label>)}</div></fieldset>
        <label><span>有效期</span><select value={expiresInDays ?? "never"} onChange={(event) => setExpiresInDays(event.target.value === "never" ? null : Number(event.target.value))}><option value="30">30 天</option><option value="90">90 天</option><option value="365">1 年</option><option value="never">不过期</option></select></label>
        <button type="submit" className="button button-green" disabled={pending || scopes.length === 0}>{pending ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}创建密钥</button>
      </form> : null}

      <div className="account-api-list">
        {apiKeys.length ? apiKeys.map((apiKey) => {
          const expired = apiKey.expired;
          const inactive = Boolean(apiKey.revokedAt) || expired;
          return <article key={apiKey.publicId} className={inactive ? "inactive" : ""}>
            <KeyRound size={17} />
            <div className="account-api-key-main"><strong>{apiKey.name}</strong><code>{apiKey.secretPrefix}</code><div>{apiKey.scopes.map((scope) => <span key={scope}>{scope}</span>)}</div></div>
            <dl><div><dt>状态</dt><dd>{apiKey.revokedAt ? "已撤销" : expired ? "已过期" : "有效"}</dd></div><div><dt>最后调用</dt><dd>{apiKey.lastUsedAt ? formatDate(apiKey.lastUsedAt) : "尚未调用"}</dd></div><div><dt>过期</dt><dd>{formatDate(apiKey.expiresAt)}</dd></div></dl>
            {!inactive ? <button type="button" onClick={() => revokeKey(apiKey.publicId)} disabled={pending} aria-label={`撤销 ${apiKey.name}`} title="撤销密钥"><Trash2 size={15} /></button> : null}
          </article>;
        }) : <div className="account-api-empty"><KeyRound size={22} /><span>尚未创建 API 密钥</span></div>}
      </div>
    </section>
  );
}
