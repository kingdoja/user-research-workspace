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
  PanelRight,
  Play,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import type { UniversalAgentWorkspace as AgentWorkspaceData } from "@/lib/universal-agent";

type RightTab = "skills" | "files" | "runs";
type FilePreview = { path: string; content: string; version: number; byteSize: number; checksum: string } | null;

function runStatusLabel(status: AgentWorkspaceData["recentRuns"][number]["status"] | null) {
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
  const [rightTab, setRightTab] = useState<RightTab>("skills");
  const [createOpen, setCreateOpen] = useState(initialWorkspace.threads.length === 0);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [externalAllowed, setExternalAllowed] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview>(null);
  const [fileLoading, setFileLoading] = useState<string | null>(null);
  const selectedThread = initialWorkspace.threads.find((thread) => thread.publicId === initialWorkspace.selectedThreadPublicId) ?? null;

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
    if (!selectedThread) return;
    setNotice(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch(`/api/agent/threads/${selectedThread.publicId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: String(data.get("message")),
        skillPublicIds: selectedSkills,
        externalExecutionAllowed: externalAllowed,
      }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      setNotice({ kind: "error", text: body.error ?? "Agent 执行失败" });
      startTransition(() => router.refresh());
      return;
    }
    form.reset();
    setExternalAllowed(false);
    setNotice({ kind: "success", text: "本轮已完成并写入审计记录" });
    startTransition(() => router.refresh());
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
    <div className="universal-agent-shell">
      {notice ? (
        <div className={`universal-agent-notice ${notice.kind}`} role="status">
          {notice.kind === "error" ? <CircleAlert size={15} /> : <Check size={15} />}
          <span>{notice.text}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button>
        </div>
      ) : null}

      <aside className="agent-thread-rail">
        <header><div><span>CONVERSATIONS</span><strong>会话</strong></div><button type="button" title="新建会话" aria-label="新建会话" onClick={() => setCreateOpen((value) => !value)}><Plus size={16} /></button></header>
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
          <div className="agent-thread-security"><ShieldCheck size={14} />版本锁定</div>
        </header>
        <div className="agent-message-list">
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
          <textarea name="message" required minLength={1} maxLength={12000} disabled={!selectedThread || !canRun || pending} placeholder="交给 Universal Agent…" />
          <div>
            <label className={externalAllowed ? "agent-execution-toggle active" : "agent-execution-toggle"}>
              <input type="checkbox" checked={externalAllowed} onChange={(event) => setExternalAllowed(event.target.checked)} disabled={!canRun || pending} />
              <ShieldCheck size={14} />允许本轮执行已选 Skill
            </label>
            <button className="button button-green" type="submit" disabled={!selectedThread || !canRun || pending || !initialWorkspace.provider.configured}>
              {pending ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{pending ? "执行中" : "运行"}
            </button>
          </div>
        </form>
      </section>

      <aside className="agent-resource-pane">
        <header><PanelRight size={15} /><strong>运行资源</strong></header>
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
          {rightTab === "skills" && !initialWorkspace.skills.length ? <div className="agent-resource-empty"><Code2 size={21} /><span>没有已启用的工作区 Skill</span></div> : null}
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
