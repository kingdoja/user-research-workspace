"use client";

/* eslint-disable @next/next/no-img-element -- previews include local blob URLs and runtime storage URLs */

import { ArrowDown, ArrowUp, Check, ChevronRight, Copy, Edit3, ImagePlus, Link2, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InterviewProjectDetail } from "@/lib/interviews";

type EditableQuestion = InterviewProjectDetail["questions"][number];
type QuestionDraft = { content: string; questionType: "open" | "single" | "multiple"; optionsText: string; aiPrompt: string };
const emptyQuestion: QuestionDraft = { content: "", questionType: "open", optionsText: "", aiPrompt: "" };
const maxQuestionImages = 4;

function formatRunTime(value: string | null) {
  if (!value) return "尚未开始";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function InterviewProjectSettings({ project }: { project: InterviewProjectDetail }) {
  const router = useRouter();
  const [objective, setObjective] = useState(project.objective);
  const [editingObjective, setEditingObjective] = useState(false);
  const [questionEditorOpen, setQuestionEditorOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<EditableQuestion | null>(null);
  const [questionDraft, setQuestionDraft] = useState<QuestionDraft>(emptyQuestion);
  const [existingImages, setExistingImages] = useState<Array<{ path: string; url: string }>>([]);
  const [newImages, setNewImages] = useState<File[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [duration, setDuration] = useState<"1" | "3" | "7" | "30" | "permanent">("3");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();

  const newImagePreviews = useMemo(() => newImages.map((file) => URL.createObjectURL(file)), [newImages]);
  useEffect(() => () => newImagePreviews.forEach(URL.revokeObjectURL), [newImagePreviews]);

  function showQuestionEditor(question?: EditableQuestion) {
    setQuestionEditorOpen(true);
    setEditingQuestion(question ?? null);
    setQuestionDraft(question ? {
      content: question.question,
      questionType: question.questionType,
      optionsText: question.options.join("\n"),
      aiPrompt: question.aiPrompt ?? "",
    } : emptyQuestion);
    setExistingImages(question ? question.imagePaths.map((path, index) => ({ path, url: question.imageUrls[index] })) : []);
    setNewImages([]);
  }

  function chooseImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const remaining = maxQuestionImages - existingImages.length - newImages.length;
    if (files.some((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024)) {
      setError("仅支持 5 MB 以内的 JPEG、PNG 或 WebP 图片");
      event.target.value = "";
      return;
    }
    setNewImages((current) => [...current, ...files.slice(0, Math.max(0, remaining))]);
    if (files.length > remaining) setError("每个问题最多上传 4 张图片");
    event.target.value = "";
  }

  async function uploadImages(questionPublicId: string, files: File[]) {
    for (const file of files) {
      const formData = new FormData();
      formData.set("image", file);
      const response = await fetch(`/api/interviews/${project.publicId}/questions/${questionPublicId}/images`, { method: "POST", body: formData });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "图片上传失败");
    }
  }

  async function removeExistingImage(imagePath: string) {
    if (!editingQuestion) return;
    setError("");
    const response = await fetch(`/api/interviews/${project.publicId}/questions/${editingQuestion.publicId}/images`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ imagePath }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setError(result.error ?? "图片删除失败"); return; }
    setExistingImages((current) => current.filter((image) => image.path !== imagePath));
  }

  function saveObjective(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    startTransition(async () => {
      const response = await fetch(`/api/interviews/${project.publicId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error ?? "暂时无法更新项目简介"); return; }
      setEditingObjective(false); setNotice("项目简介已更新"); router.refresh();
    });
  }

  function saveQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const options = questionDraft.optionsText.split("\n").map((item) => item.trim()).filter(Boolean);
    startTransition(async () => {
      const url = editingQuestion ? `/api/interviews/${project.publicId}/questions/${editingQuestion.publicId}` : `/api/interviews/${project.publicId}/questions`;
      const response = await fetch(url, { method: editingQuestion ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: questionDraft.content, questionType: questionDraft.questionType, options, aiPrompt: questionDraft.aiPrompt || null }) });
      const result = await response.json() as { error?: string; publicId?: string };
      if (!response.ok) { setError(result.error ?? "暂时无法保存问题"); return; }
      const questionPublicId = editingQuestion?.publicId ?? result.publicId;
      if (questionPublicId && newImages.length > 0) {
        try { await uploadImages(questionPublicId, newImages); } catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : "图片上传失败"); router.refresh(); return; }
      }
      setQuestionEditorOpen(false); setEditingQuestion(null); setQuestionDraft(emptyQuestion); setNotice(editingQuestion ? "问题已更新" : "问题已添加"); router.refresh();
    });
  }

  function questionAction(question: EditableQuestion, action: "up" | "down" | "delete") {
    if (action === "delete" && !window.confirm(`确定删除问题“${question.question}”吗？历史会话不会被修改。`)) return;
    setError(""); setNotice("");
    startTransition(async () => {
      const response = await fetch(`/api/interviews/${project.publicId}/questions/${question.publicId}`, action === "delete" ? { method: "DELETE" } : { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ direction: action }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error ?? "暂时无法更新问题"); return; }
      setNotice(action === "delete" ? "问题已删除" : "问题顺序已更新"); router.refresh();
    });
  }

  function createInvitation() {
    setError(""); setNotice("");
    startTransition(async () => {
      const response = await fetch(`/api/interviews/${project.publicId}/invitations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ durationDays: duration === "permanent" ? null : Number(duration) }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error ?? "暂时无法创建邀请链接"); return; }
      setNotice("邀请链接已创建"); router.refresh();
    });
  }

  function revokeInvitation(publicId: string) {
    setError(""); setNotice("");
    startTransition(async () => {
      const response = await fetch(`/api/interviews/${project.publicId}/invitations/${publicId}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error ?? "暂时无法撤销邀请"); return; }
      setNotice("邀请链接已撤销"); router.refresh();
    });
  }

  async function copyInvitation(token: string) {
    await navigator.clipboard.writeText(`${window.location.origin}/interview/invite/${token}`);
    setNotice("邀请链接已复制");
  }

  return <main className="interview-settings-view">
    <header><div><span>PROJECT SETUP</span><h2>访谈配置</h2><p>编辑研究简介、管理问题，并邀请真人参与访谈。</p></div><strong>{project.questions.length} 个问题</strong></header>
    {error || notice ? <div className={error ? "interview-settings-message error" : "interview-settings-message"}>{pending ? <LoaderCircle className="spin" size={14} /> : notice ? <Check size={14} /> : null}{error || notice}</div> : null}
    <section className="interview-settings-section"><header><div><h3>项目简介</h3><p>向参与者说明研究目标和背景。</p></div><button type="button" onClick={() => setEditingObjective((value) => !value)}><Edit3 size={14} />{editingObjective ? "取消" : "编辑"}</button></header>{editingObjective ? <form className="interview-objective-form" onSubmit={saveObjective}><textarea value={objective} onChange={(event) => setObjective(event.target.value)} minLength={12} maxLength={2000} required /><footer><span>{objective.length} / 2000</span><button type="submit" disabled={pending}>保存简介</button></footer></form> : <p className="interview-settings-objective">{project.objective}</p>}</section>
    <section className="interview-settings-section"><header><div><h3>问题列表</h3><p>开放题、单选题和多选题将按顺序展示给受访者。</p></div><button type="button" onClick={() => showQuestionEditor()}><Plus size={14} />添加问题</button></header><div className="interview-question-editor-list">{project.questions.map((question, index) => <article key={question.publicId}><span>{String(question.index).padStart(2, "0")}</span><div><h4>{question.question}</h4><p>{question.questionType === "open" ? "开放式问题" : question.questionType === "single" ? `单选题 · ${question.options.length} 个选项` : `多选题 · ${question.options.length} 个选项`}{question.imagePaths.length > 0 ? ` · ${question.imagePaths.length} 张图片` : ""}</p></div><nav><button type="button" disabled={pending || index === 0} onClick={() => questionAction(question, "up")} aria-label="上移问题" title="上移"><ArrowUp size={14} /></button><button type="button" disabled={pending || index === project.questions.length - 1} onClick={() => questionAction(question, "down")} aria-label="下移问题" title="下移"><ArrowDown size={14} /></button><button type="button" onClick={() => showQuestionEditor(question)} aria-label="编辑问题" title="编辑"><Edit3 size={14} /></button><button className="danger" type="button" onClick={() => questionAction(question, "delete")} aria-label="删除问题" title="删除"><Trash2 size={14} /></button></nav></article>)}</div>{project.questions.length === 0 ? <div className="interview-settings-empty">还没有问题。添加至少一个问题后才能开始真人访谈。</div> : null}</section>
    <section className="interview-settings-section"><header><div><h3>真人访谈邀请</h3><p>创建无需登录的参与链接，可设置有效期或永久有效。</p></div></header><div className="interview-invitation-create"><select value={duration} onChange={(event) => setDuration(event.target.value as typeof duration)} aria-label="邀请链接有效期"><option value="1">1 天</option><option value="3">3 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="permanent">永久有效</option></select><button type="button" disabled={pending || project.questions.length === 0} onClick={createInvitation}><Link2 size={14} />生成邀请链接</button></div><div className="interview-invitation-list">{project.invitations.map((invitation) => <article key={invitation.publicId}><div><strong>{invitation.expiresAt ? `有效至 ${new Date(invitation.expiresAt).toLocaleDateString("zh-CN")}` : "永久邀请链接"}</strong><code>{`/interview/invite/${invitation.token}`}</code></div><button type="button" onClick={() => copyInvitation(invitation.token)} aria-label="复制邀请链接" title="复制"><Copy size={14} /></button><button type="button" onClick={() => revokeInvitation(invitation.publicId)} aria-label="撤销邀请链接" title="撤销"><X size={14} /></button></article>)}</div></section>
    {project.runHistory.length > 0 ? <section className="interview-settings-section"><header><div><h3>AI 生成记录</h3><p>保留每次排队、执行和失败原因，便于追溯或排障。</p></div><strong>{project.runHistory.length} 次</strong></header><details className="interview-run-history" open><summary><ChevronRight size={14} /><strong>执行历史</strong><span>{project.runHistory.length} 次</span></summary><ol>{project.runHistory.toReversed().map((run) => <li key={run.publicId}><i className={run.status} /><div><strong>第 {run.attempt} 次执行 · {run.status === "completed" ? "已完成" : run.status === "failed" ? "失败" : run.status === "running" ? "执行中" : "排队中"}</strong><p>{run.provider ?? "模型服务"}{run.model ? ` · ${run.model}` : ""}</p>{run.error ? <small>{run.error}</small> : null}</div><time>{formatRunTime(run.finishedAt ?? run.startedAt ?? run.createdAt)}</time></li>)}</ol></details></section> : null}
    {questionEditorOpen ? <div className="interview-question-dialog-backdrop" role="presentation"><form className="interview-question-dialog" onSubmit={saveQuestion}>
      <header><div><span>{editingQuestion ? "EDIT QUESTION" : "NEW QUESTION"}</span><h3>{editingQuestion ? "编辑问题" : "添加问题"}</h3></div><button type="button" onClick={() => { setQuestionEditorOpen(false); setEditingQuestion(null); setQuestionDraft(emptyQuestion); setExistingImages([]); setNewImages([]); }} aria-label="关闭问题编辑"><X size={18} /></button></header>
      <label>问题内容<textarea value={questionDraft.content} onChange={(event) => setQuestionDraft((current) => ({ ...current, content: event.target.value }))} minLength={4} maxLength={1000} required placeholder="输入访谈问题..." /></label>
      <fieldset><legend>问题类型</legend><div>{([['open','开放式'],['single','单选题'],['multiple','多选题']] as const).map(([value,label]) => <label key={value}><input type="radio" name="questionType" value={value} checked={questionDraft.questionType === value} onChange={() => setQuestionDraft((current) => ({ ...current, questionType:value }))} />{label}</label>)}</div></fieldset>
      {questionDraft.questionType !== "open" ? <label>选项（每行一个）<textarea value={questionDraft.optionsText} onChange={(event) => setQuestionDraft((current) => ({ ...current, optionsText:event.target.value }))} required placeholder={"选项 A\n选项 B"} /></label> : null}
      <section className="interview-question-images"><div><strong>问题图片</strong><span>{existingImages.length + newImages.length} / {maxQuestionImages}</span></div><div className="interview-question-image-grid">
        {existingImages.map((image) => <figure key={image.path}><img src={image.url} alt="问题参考图" /><button type="button" onClick={() => removeExistingImage(image.path)} aria-label="删除已上传图片"><X size={14} /></button></figure>)}
        {newImages.map((file, index) => <figure key={`${file.name}-${file.lastModified}-${index}`}><img src={newImagePreviews[index]} alt="待上传问题参考图" /><button type="button" onClick={() => setNewImages((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label="移除待上传图片"><X size={14} /></button></figure>)}
        {existingImages.length + newImages.length < maxQuestionImages ? <button className="interview-question-image-add" type="button" onClick={() => imageInputRef.current?.click()}><ImagePlus size={18} /><span>添加图片</span></button> : null}
      </div><input ref={imageInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={chooseImages} /><small>支持 JPEG、PNG、WebP，单张不超过 5 MB。</small></section>
      <label>AI 提示（可选）<textarea value={questionDraft.aiPrompt} onChange={(event) => setQuestionDraft((current) => ({ ...current, aiPrompt:event.target.value }))} placeholder="描述后续 AI 分析时应关注的行为或条件..." /></label>
      <footer><button type="button" onClick={() => { setQuestionEditorOpen(false); setEditingQuestion(null); setQuestionDraft(emptyQuestion); setExistingImages([]); setNewImages([]); }}>取消</button><button className="primary" type="submit" disabled={pending}>{pending ? <LoaderCircle className="spin" size={14} /> : null}保存问题</button></footer>
    </form></div> : null}
  </main>;
}
