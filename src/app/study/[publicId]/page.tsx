import {
  Bot,
  Check,
  CircleDashed,
  Clock3,
  Coins,
  Database,
  LockKeyhole,
  MessageSquareText,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { StudyDetailActions } from "@/components/study-detail-actions";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { getStudy } from "@/lib/studies";
import {
  formatDuration,
  formatTokens,
  methodLabels,
  studyStatusLabels,
  studyTypeLabels,
} from "@/lib/study-display";

export default async function StudyDetailPage({ params }: PageProps<"/study/[publicId]">) {
  const viewer = await getViewer();

  if (!viewer) {
    const { publicId } = await params;
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(`/study/${publicId}`)}`);
  }

  const { publicId } = await params;
  const study = await getStudy(viewer, publicId);

  if (!study) {
    notFound();
  }

  const confirmed = study.plan.status === "confirmed";
  const executionWaiting = study.runStatus === "awaiting_provider";

  return (
    <WorkspaceShell viewer={viewer}>
      <div className="study-detail-grid">
        <section className="study-conversation">
          <div className="study-detail-header">
            <div>
              <Link href="/studies">研究项目</Link>
              <h1>{study.title}</h1>
            </div>
            <span className={`study-status status-${study.status}`}>{studyStatusLabels[study.status] ?? study.status}</span>
          </div>

          <div className="conversation-stream">
            <article className="conversation-message user-message">
              <span className="message-avatar"><UserRound size={18} /></span>
              <div>
                <strong>您</strong>
                <p>{study.brief}</p>
              </div>
            </article>

            <article className="conversation-message assistant-message">
              <span className="message-avatar"><Bot size={19} /></span>
              <div className="assistant-message-body">
                <strong>atypica.AI</strong>
                <p>我已根据您的 Brief 整理研究目标，并生成一份本地计划草案。确认前请检查研究类型、方法组合与人设范围。</p>

                <section className="study-plan-panel">
                  <div className="plan-panel-header">
                    <div>
                      <span>Plan Mode</span>
                      <h2>研究计划</h2>
                    </div>
                    {confirmed ? <span className="plan-lock"><LockKeyhole size={15} />已锁定</span> : <span className="plan-draft"><CircleDashed size={15} />等待确认</span>}
                  </div>
                  <dl className="plan-rows">
                    <div><dt>研究类型</dt><dd>{studyTypeLabels[study.studyType] ?? study.studyType}</dd></div>
                    <div><dt>方法论框架</dt><dd>{study.plan.framework}</dd></div>
                    <div><dt>方法组合</dt><dd>{study.plan.methods.map((method) => methodLabels[method]).join(" + ") || "仅构建人设池"}</dd></div>
                    <div><dt>人设池</dt><dd>{study.plan.personaCount} 个 Persona · {study.plan.personaFilters.source}</dd></div>
                  </dl>
                  <div className="plan-metrics">
                    <div><Clock3 size={16} /><span>预计用时</span><strong>{formatDuration(study.plan.estimatedDurationMinutes)}</strong></div>
                    <div><Coins size={16} /><span>预计 Token</span><strong>{formatTokens(study.plan.estimatedTokens)}</strong></div>
                  </div>
                  {confirmed ? null : <StudyDetailActions publicId={study.publicId} />}
                </section>
              </div>
            </article>

            {confirmed ? (
              <article className="conversation-message assistant-message">
                <span className="message-avatar"><Bot size={19} /></span>
                <div className="assistant-message-body">
                  <strong>atypica.AI</strong>
                  <p>研究计划已经锁定。项目数据已进入执行队列，但当前本地版本还没有配置模型与后台任务提供商。</p>
                  <div className="provider-waiting">
                    <Database size={20} />
                    <div>
                      <strong>{executionWaiting ? "等待接入研究执行引擎" : "执行状态待更新"}</strong>
                      <p>Brief、计划、事件和运行记录已经持久化。接入模型后可从此状态继续，而不需要重新创建项目。</p>
                    </div>
                  </div>
                </div>
              </article>
            ) : null}
          </div>
        </section>

        <aside className="study-progress-rail detail-progress">
          <h2>研究进度</h2>
          <div className="progress-overview">
            <div><span style={{ width: confirmed ? "60%" : "42%" }} /></div>
            <strong>{confirmed ? "60%" : "42%"}</strong>
          </div>
          <ol className="progress-steps">
            <li className="complete"><span><Check size={14} /></span><div><strong>Brief</strong><p>研究问题已保存</p></div></li>
            <li className="complete"><span><Check size={14} /></span><div><strong>澄清与规划</strong><p>计划草案已生成</p></div></li>
            <li className={confirmed ? "complete" : "active"}><span>{confirmed ? <Check size={14} /> : "3"}</span><div><strong>确认计划</strong><p>{confirmed ? "计划已经锁定" : "检查方法与人设池"}</p></div></li>
            <li className={confirmed ? "active" : ""}><span>4</span><div><strong>执行</strong><p>{confirmed ? "等待执行提供商" : "AI 深研与数据收集"}</p></div></li>
            <li><span>5</span><div><strong>报告</strong><p>生成洞察报告</p></div></li>
          </ol>
          <div className="progress-note">
            <MessageSquareText size={18} />
            <p>计划确认后保持不可变，后续执行事件会按顺序追加到这条研究会话。</p>
          </div>
        </aside>
      </div>
    </WorkspaceShell>
  );
}
