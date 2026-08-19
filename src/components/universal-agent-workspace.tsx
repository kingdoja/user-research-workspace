"use client";

import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  File,
  FileCode2,
  FolderOpen,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState, useTransition } from "react";
import type { UniversalAgentWorkspace as AgentWorkspaceData } from "@/lib/universal-agent";

type RightTab = "skills" | "files" | "runs";
type FilePreview = { path: string; content: string; version: number; byteSize: number; checksum: string } | null;
type AgentLiveEvent = {
  id: string;
  runPublicId: string;
  kind: string;
  status: string;
  sequence: number;
  summary: string;
  toolName: string | null;
  errorCode: string | null;
};

function createAgentRequestId() {
  const browserCrypto = globalThis.crypto as Crypto | undefined;
  if (typeof browserCrypto?.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }
  if (typeof browserCrypto?.getRandomValues === "function") {
    const entropy = new Uint32Array(4);
    browserCrypto.getRandomValues(entropy);
    return `web:${Date.now().toString(36)}:${Array.from(entropy, (value) => value.toString(36)).join("")}`;
  }
  return `web:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function runStatusLabel(status: AgentWorkspaceData["recentRuns"][number]["status"] | null) {
  if (status === "queued") return "排队中";
  if (status === "running") return "运行中";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "取消";
  return "待运行";
}

export function UniversalAgentWorkspace({
  initialWorkspace,
  canRun,
}: {
  initialWorkspace: AgentWorkspaceData;
  canRun: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sending, setSending] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("skills");
  const [leftRailOpen, setLeftRailOpen] = useState(true);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(initialWorkspace.threads.length === 0);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [externalAllowed, setExternalAllowed] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview>(null);
  const [fileLoading, setFileLoading] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<AgentLiveEvent[]>([]);
  const selectedThread = initialWorkspace.threads.find((thread) => thread.publicId === initialWorkspace.selectedThreadPublicId) ?? null;
  const threadBusy = selectedThread?.lastRunStatus === "queued" || selectedThread?.lastRunStatus === "running";
  const activeRun = selectedThread
    ? initialWorkspace.recentRuns.find((run) => run.threadPublicId === selectedThread.publicId && (run.status === "queued" || run.status === "running"))
    : null;

  useEffect(() => {
    const hasActiveRun = initialWorkspace.recentRuns.some((run) => run.status === "queued" || run.status === "running");
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => router.refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [initialWorkspace.recentRuns, router]);

  const selectedThreadPublicId = selectedThread?.publicId ?? null;
  const activeRunPublicId = activeRun?.publicId ?? null;

  useEffect(() => {
    if (!selectedThreadPublicId || !activeRunPublicId) return;
    const source = new EventSource(`/api/agent/threads/${encodeURIComponent(selectedThreadPublicId)}/events?run=${encodeURIComponent(activeRunPublicId)}`);
    source.addEventListener("agent-step", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as AgentLiveEvent;
        setLiveEvents((current) => current.some((item) => item.id === payload.id) ? current : [...current, payload].slice(-40));
      } catch {
        // Ignore a malformed event; the server snapshot remains authoritative.
      }
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [activeRunPublicId, selectedThreadPublicId]);

  async function createThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/agent/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: String(data.get("title")) }),
    });
    const body = await response.json().catch(() => ({})) as { publicId?: string; error?: string };
    if (!response.ok || !body.publicId) {
      setNotice({ kind: "error", text: body.error ?? "会话创建失败" });
      return;
    }
    setCreateOpen(false);
    startTransition(() => router.push(`/agent?thread=${encodeURIComponent(body.publicId!)}`));
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedThread || sending) return;
    setNotice(null);
    setSending(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const response = await fetch(`/api/agent/threads/${selectedThread.publicId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: String(data.get("message")),
          skillPublicIds: selectedSkills,
          externalExecutionAllowed: externalAllowed,
          requestId: createAgentRequestId(),
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; message?: string; runPublicId?: string };
      if (!response.ok) {
        setNotice({ kind: "error", text: body.message ?? body.error ?? "Agent 执行失败" });
        startTransition(() => router.refresh());
        return;
      }
      form.reset();
      setExternalAllowed(false);
      setNotice({ kind: "success", text: "任务已入队，页面会自动更新运行状态" });
      startTransition(() => router.refresh());
    } catch {
      setNotice({ kind: "error", text: "Agent 请求中断，请在 Runs 中核对状态后再试" });
    } finally {
      setSending(false);
    }
  }

  function toggleSkill(publicId: string) {
    setSelectedSkills((current) => current.includes(publicId)
      ? current.filter((item) => item !== publicId)
      : [...current, publicId]);
  }

  async function openFile(publicId: string) {
    setFileLoading(publicId);
    setNotice(null);
    try {
      const response = await fetch(`/api/agent/files/${publicId}`);
      const body = await response.json() as FilePreview & { error?: string };
      if (!response.ok || !body) throw new Error(body?.error ?? "文件读取失败");
      setFilePreview(body);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "文件读取失败" });
    } finally {
      setFileLoading(null);
    }
  }

  return (
    <div className={`universal-agent-shell${leftRailOpen ? "" : " left-rail-collapsed"}${rightRailOpen ? " right-rail-open" : ""}`}>
      {notice ? (
        <div className={`universal-agent-notice ${notice.kind}`} role="status">
          {notice.kind === "error" ? <CircleAlert size={15} /> : <Check size={15} />}
          <span>{notice.text}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button>
        </div>
      ) : null}

      <aside className="agent-thread-rail">
        <header>
          <div><span>CONVERSATIONS</span><strong>会话</strong></div>
          <div className="agent-rail-header-actions">
            <button type="button" title="新建会话" aria-label="新建会话" onClick={() => setCreateOpen((value) => !value)}><Plus size={16} /></button>
            <button type="button" title="收起会话栏" aria-label="收起会话栏" onClick={() => setLeftRailOpen(false)}><PanelLeftClose size={16} /></button>
          </div>
        </header>
        {createOpen ? (
          <form className="agent-thread-create" onSubmit={createThread}>
            <input name="title" required minLength={2} maxLength={160} placeholder="会话名称" autoFocus />
            <button className="button button-green" type="submit" disabled={pending}><MessageSquarePlus size={14} />创建</button>
          </form>
        ) : null}
        <nav aria-label="Universal Agent 会话">
          {initialWorkspace.threads.map((thread) => (
            <Link className={thread.publicId === selectedThread?.publicId ? "active" : ""} href={`/agent?thread=${encodeURIComponent(thread.publicId)}`} key={thread.publicId}>
              <span><Bot size={15} /></span>
              <div><strong>{thread.title}</strong><small>{thread.lastMessage ?? "空会话"}</small></div>
              <i className={thread.lastRunStatus ?? "idle"}>{runStatusLabel(thread.lastRunStatus)}</i>
            </Link>
          ))}
          {!initialWorkspace.threads.length && !createOpen ? <div className="agent-rail-empty"><Bot size={21} /><span>暂无会话</span></div> : null}
        </nav>
      </aside>

      <section className="universal-conversation-pane">
        <header>
          <div><span>ACTIVE THREAD</span><strong>{selectedThread?.title ?? "Universal Agent"}</strong></div>
          <div className="agent-conversation-actions">
            <div className={initialWorkspace.provider.configured ? "agent-provider-state ready" : "agent-provider-state"}>
              <span />{initialWorkspace.provider.providerName} / {initialWorkspace.provider.model}
            </div>
            <div className="agent-thread-security"><ShieldCheck size={14} />版本锁定</div>
            <button
              className="agent-pane-toggle"
              type="button"
              title={leftRailOpen ? "收起会话栏" : "展开会话栏"}
              aria-label={leftRailOpen ? "收起会话栏" : "展开会话栏"}
              aria-expanded={leftRailOpen}
              onClick={() => setLeftRailOpen((value) => !value)}
            >
              {leftRailOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            </button>
            <button
              className="agent-pane-toggle"
              type="button"
              title={rightRailOpen ? "收起运行资源" : "展开运行资源"}
              aria-label={rightRailOpen ? "收起运行资源" : "展开运行资源"}
              aria-expanded={rightRailOpen}
              onClick={() => setRightRailOpen((value) => !value)}
            >
              {rightRailOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
            </button>
          </div>
        </header>
        <div className="agent-message-list">
          {liveEvents.filter((event) => event.runPublicId === activeRunPublicId).map((event) => (
            <article className={`universal-message tool ${event.status}`} key={`live-${event.id}`}>
              <span><Code2 size={14} /></span>
              <div><small>{event.kind.toUpperCase()} · {event.toolName ?? "DECISION"}</small><p>{event.summary}{event.errorCode ? `（${event.errorCode}）` : ""}</p></div>
            </article>
          ))}
          {initialWorkspace.messages.length ? initialWorkspace.messages.map((message) => (
            <article className={`universal-message ${message.role}`} key={message.publicId}>
              <span>{message.role === "user" ? "你" : message.role === "assistant" ? <Bot size={15} /> : <Code2 size={14} />}</span>
              <div><small>{message.role === "user" ? "YOU" : message.role === "assistant" ? "UNIVERSAL AGENT" : message.role.toUpperCase()}</small><p>{message.content}</p></div>
            </article>
          )) : (
            <div className="agent-conversation-empty"><Bot size={28} /><strong>{selectedThread ? "准备执行" : "创建一个会话"}</strong></div>
          )}
        </div>
        <form className="agent-composer" onSubmit={sendMessage}>
          <textarea name="message" required minLength={1} maxLength={12000} disabled={!selectedThread || !canRun || pending || sending || threadBusy} placeholder="交给 Universal Agent…" />
          <div>
            <label className={externalAllowed ? "agent-execution-toggle active" : "agent-execution-toggle"}>
              <input type="checkbox" checked={externalAllowed} onChange={(event) => setExternalAllowed(event.target.checked)} disabled={!canRun || pending || sending || threadBusy} />
              <ShieldCheck size={14} />允许本轮执行已选能力
            </label>
            <button className="button button-green" type="submit" disabled={!selectedThread || !canRun || pending || sending || threadBusy || !initialWorkspace.provider.configured}>
              {sending || threadBusy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{sending ? "提交中" : threadBusy ? "运行中" : "运行"}
            </button>
          </div>
        </form>
      </section>

      <aside className="agent-resource-pane">
        <header>
          <div><PanelRightOpen size={15} /><strong>运行资源</strong></div>
          <button type="button" title="收起运行资源" aria-label="收起运行资源" onClick={() => setRightRailOpen(false)}><PanelRightClose size={16} /></button>
        </header>
        <div className="agent-resource-tabs" role="tablist">
          <button className={rightTab === "skills" ? "active" : ""} type="button" role="tab" onClick={() => setRightTab("skills")}>Skills</button>
          <button className={rightTab === "files" ? "active" : ""} type="button" role="tab" onClick={() => setRightTab("files")}>Files</button>
          <button className={rightTab === "runs" ? "active" : ""} type="button" role="tab" onClick={() => setRightTab("runs")}>Runs</button>
        </div>
        <div className="agent-resource-list">
          {rightTab === "skills" ? initialWorkspace.skills.map((skill) => (
            <label className={selectedSkills.includes(skill.publicId) ? "agent-skill-option active" : "agent-skill-option"} key={skill.publicId}>
              <input type="checkbox" checked={selectedSkills.includes(skill.publicId)} onChange={() => toggleSkill(skill.publicId)} />
              <span>{skill.executorType === "sandbox" ? <FileCode2 size={15} /> : <Code2 size={15} />}</span>
              <div><strong>{skill.name}</strong><small>{skill.slug}@{skill.version} · {skill.executorType}</small></div>
            </label>
          )) : null}
          {rightTab === "skills" && initialWorkspace.productTools.map((tool) => (
            <article className="agent-skill-option agent-product-tool-option" key={tool.name}>
              <span><Bot size={15} /></span>
              <div><strong>{tool.title}</strong><small>{tool.name} · {tool.mutates ? "执行需确认" : "只读"}</small></div>
            </article>
          ))}
          {rightTab === "skills" && !initialWorkspace.skills.length ? (
            <div className="agent-resource-empty">
              <Code2 size={21} />
              <span>当前工作区还没有可用 Skill，请先导入、启用并完成权限授权。</span>
              <Link className="agent-resource-empty-action" href="/skills">去配置 Skills<ChevronRight size={14} /></Link>
            </div>
          ) : null}
          {rightTab === "files" ? initialWorkspace.files.map((file) => (
            <button className="agent-file-row" type="button" key={file.publicId} onClick={() => openFile(file.publicId)}>
              <span>{file.path.includes("/") ? <FolderOpen size={15} /> : <File size={15} />}</span>
              <div><strong>{file.path}</strong><small>{file.byteSize} B · v{file.version}</small></div>
              {fileLoading === file.publicId ? <LoaderCircle className="spin" size={14} /> : <ChevronRight size={14} />}
            </button>
          )) : null}
          {rightTab === "files" && !initialWorkspace.files.length ? <div className="agent-resource-empty"><FolderOpen size={21} /><span>Workspace 为空</span></div> : null}
          {rightTab === "runs" ? initialWorkspace.recentRuns.map((run) => (
            <article className="agent-run-row" key={run.publicId}>
              <span className={run.status}>{runStatusLabel(run.status)}</span>
              <strong>{run.publicId}</strong>
              <small>{run.stepsUsed}/{run.maxSteps} steps · {run.externalExecutionAllowed ? "Skill confirmed" : "files only"}</small>
            </article>
          )) : null}
          {rightTab === "runs" && !initialWorkspace.recentRuns.length ? <div className="agent-resource-empty"><Play size={21} /><span>暂无 Run</span></div> : null}
        </div>
      </aside>

      {filePreview ? (
        <div className="agent-file-preview" role="dialog" aria-modal="true" aria-labelledby="agent-file-title">
          <header><div><span>WORKSPACE FILE · v{filePreview.version}</span><strong id="agent-file-title">{filePreview.path}</strong></div><button type="button" aria-label="关闭文件预览" onClick={() => setFilePreview(null)}><X size={17} /></button></header>
          <pre>{filePreview.content}</pre>
          <footer><span>{filePreview.byteSize} bytes</span><code>{filePreview.checksum.slice(0, 16)}</code></footer>
        </div>
      ) : null}
    </div>
  );
}
