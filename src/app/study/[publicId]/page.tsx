import {
  Bot,
  Check,
  CircleDashed,
  Clock3,
  Coins,
  Database,
  ExternalLink,
  FileCheck2,
  LockKeyhole,
  LoaderCircle,
  MessageSquareText,
  Search,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { StudyAutoRefresh } from "@/components/study-auto-refresh";
import { StudyDetailActions } from "@/components/study-detail-actions";
import { StudyRunActions } from "@/components/study-run-actions";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { getOpenAIProviderStatus } from "@/lib/openai-provider";
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
  const executionActive = study.runStatus === "queued" || study.runStatus === "running";
  const executionFailed = study.runStatus === "failed";
  const provider = getOpenAIProviderStatus();
  const progress = study.report ? 100 : executionActive ? 74 : confirmed ? 60 : 42;

  return (
    <WorkspaceShell viewer={viewer}>
      {executionActive ? <StudyAutoRefresh /> : null}
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
                <p>
                  {study.plan.source === "openai"
                    ? `我已使用 ${study.plan.providerModel ?? "OpenAI"} 分析您的 Brief，并生成结构化研究计划。`
                    : provider.configured
                      ? "模型计划生成暂时未完成，当前展示可继续确认的本地规则草案。"
                      : "我已根据您的 Brief 生成本地规则草案；配置 OpenAI 后，新项目会使用模型生成计划。"}
                  确认前请检查研究类型、方法组合与研究范围。
                </p>

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
                    <div><dt>目标受众</dt><dd>{study.plan.personaFilters.audience}</dd></div>
                    <div><dt>信息来源</dt><dd>{study.plan.personaFilters.source}</dd></div>
                    <div><dt>计划依据</dt><dd>{study.plan.rationale}</dd></div>
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
                  <p>研究计划已经锁定。当前执行器只研究公开网页，并会把模型、响应 ID、Token 用量、来源与错误状态写入运行记录。</p>
                  <div className={`provider-waiting run-state-${study.runStatus ?? "unknown"}`}>
                    {study.report
                      ? <FileCheck2 size={20} />
                      : executionActive
                        ? <LoaderCircle className="spin" size={20} />
                        : executionFailed
                          ? <Database size={20} />
                          : <Search size={20} />}
                    <div>
                      <strong>
                        {study.report
                          ? "公开网页研究已完成"
                          : study.runStatus === "running"
                            ? "正在检索与综合公开资料"
                            : study.runStatus === "queued"
                              ? "研究任务已进入执行队列"
                              : executionFailed
                                ? "研究执行失败"
                                : executionWaiting && !provider.configured
                                  ? "等待服务器配置 OpenAI API Key"
                                  : "研究执行可以启动"}
                      </strong>
                      <p>
                        {executionFailed
                          ? study.runError ?? "错误已记录，可以重新执行。"
                          : study.report
                            ? `${study.runModel ?? provider.researchModel} 已生成报告，并保留 ${study.report.citations.length} 个可核查来源。`
                            : `执行模型：${study.runModel ?? provider.researchModel}。不会调用 Atypica 线上 Token，也不会伪造真人访谈。`}
                      </p>
                    </div>
                  </div>
                  {!study.report && !executionActive ? (
                    <StudyRunActions
                      publicId={study.publicId}
                      configured={provider.configured}
                      retry={executionFailed}
                    />
                  ) : null}
                </div>
              </article>
            ) : null}

            {study.report ? (
              <article className="conversation-message assistant-message report-message">
                <span className="message-avatar"><FileCheck2 size={19} /></span>
                <div className="assistant-message-body">
                  <strong>研究报告</strong>
                  <section className="research-report">
                    <header>
                      <span>Public Web Research</span>
                      <h2>{study.report.title}</h2>
                      <p>{study.report.content.executiveSummary}</p>
                    </header>
                    <div className="report-findings">
                      {study.report.content.findings.map((finding, index) => (
                        <article key={`${finding.title}-${index}`}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <div>
                            <h3>{finding.title}</h3>
                            <p>{finding.insight}</p>
                            <dl>
                              <div><dt>证据</dt><dd>{finding.evidence}</dd></div>
                              <div><dt>业务含义</dt><dd>{finding.implication}</dd></div>
                            </dl>
                          </div>
                        </article>
                      ))}
                    </div>
                    <section className="report-section">
                      <h3>行动建议</h3>
                      <div className="recommendation-list">
                        {study.report.content.recommendations.map((item) => (
                          <article key={item.title}>
                            <span className={`priority priority-${item.priority}`}>{item.priority}</span>
                            <h4>{item.title}</h4>
                            <p>{item.action}</p>
                            <small>{item.rationale}</small>
                          </article>
                        ))}
                      </div>
                    </section>
                    <section className="report-section report-columns">
                      <div>
                        <h3>研究局限</h3>
                        <ul>{study.report.content.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
                      </div>
                      <div>
                        <h3>下一步问题</h3>
                        <ul>{study.report.content.nextQuestions.map((item) => <li key={item}>{item}</li>)}</ul>
                      </div>
                    </section>
                    <section className="report-sources">
                      <h3>公开来源</h3>
                      {study.report.citations.length > 0 ? (
                        <ol>
                          {study.report.citations.map((citation) => (
                            <li key={citation.url}>
                              <a href={citation.url} target="_blank" rel="noreferrer">
                                <span>{citation.title}</span><ExternalLink size={14} />
                              </a>
                            </li>
                          ))}
                        </ol>
                      ) : <p>本次响应没有返回可展示的 URL 注释，报告已在局限部分标注证据边界。</p>}
                    </section>
                  </section>
                </div>
              </article>
            ) : null}
          </div>
        </section>

        <aside className="study-progress-rail detail-progress">
          <h2>研究进度</h2>
          <div className="progress-overview">
            <div><span style={{ width: `${progress}%` }} /></div>
            <strong>{progress}%</strong>
          </div>
          <ol className="progress-steps">
            <li className="complete"><span><Check size={14} /></span><div><strong>Brief</strong><p>研究问题已保存</p></div></li>
            <li className="complete"><span><Check size={14} /></span><div><strong>澄清与规划</strong><p>计划草案已生成</p></div></li>
            <li className={confirmed ? "complete" : "active"}><span>{confirmed ? <Check size={14} /> : "3"}</span><div><strong>确认计划</strong><p>{confirmed ? "计划已经锁定" : "检查方法与研究范围"}</p></div></li>
            <li className={study.report ? "complete" : confirmed ? "active" : ""}><span>{study.report ? <Check size={14} /> : "4"}</span><div><strong>执行</strong><p>{executionActive ? "公开网页研究进行中" : executionFailed ? "执行失败，可重试" : confirmed ? "等待 OpenAI 执行" : "公开网页研究"}</p></div></li>
            <li className={study.report ? "complete" : ""}><span>{study.report ? <Check size={14} /> : "5"}</span><div><strong>报告</strong><p>{study.report ? "报告已生成" : "生成洞察报告"}</p></div></li>
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
