import { ArrowLeft, Boxes, FileText, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { getAdminReport } from "@/lib/admin";
import { formatStudyDate, studyStatusLabels } from "@/lib/study-display";

export const metadata = { title: "研究报告详情" };

export default async function AdminReportPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const viewer = await getViewer();
  if (!viewer) redirect(`/auth/signin?callbackUrl=${encodeURIComponent(`/admin/reports/${publicId}`)}`);
  if (viewer.isPlatformAdmin !== true) redirect("/studies");
  const report = await getAdminReport(viewer, publicId);
  if (!report) notFound();
  return <WorkspaceShell viewer={viewer}><div className="workspace-page admin-report-page"><Link className="workspace-text-link" href="/admin"><ArrowLeft size={15} />返回管理员总览</Link><header className="admin-report-header"><div><span className="admin-eyebrow"><ShieldCheck size={14} /> PLATFORM ADMIN · READ ONLY</span><h1>{report.title}</h1><p>{report.description || "研究报告"}</p></div><dl><div><dt>创建者</dt><dd>{report.owner.displayName} · {report.owner.email}</dd></div><div><dt>工作区</dt><dd>{report.workspaceName}</dd></div><div><dt>生成时间</dt><dd>{formatStudyDate(report.generatedAt)}</dd></div></dl></header><section className="admin-report-study"><FileText size={18} /><div><strong>{report.study.title}</strong><p>{report.study.brief}</p></div><span className={`study-status status-${report.study.status}`}>{studyStatusLabels[report.study.status] ?? report.study.status}</span></section><FullReport content={report.content} /><section className="admin-report-artifacts"><header><h2><Boxes size={17} />研究产物</h2><span>{report.artifacts.length} 个</span></header>{report.artifacts.length ? <div>{report.artifacts.map((artifact) => <details key={artifact.publicId}><summary><span>{artifact.type}</span><strong>{artifact.title}</strong><time>{formatStudyDate(artifact.createdAt)}</time></summary><pre>{JSON.stringify(artifact.content, null, 2)}</pre></details>)}</div> : <p className="admin-empty">该研究没有附加产物。</p>}</section></div></WorkspaceShell>;
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function list(value: unknown) { return Array.isArray(value) ? value : []; }

function FullReport({ content }: { content: Record<string, unknown> }) {
  const findings = list(content.findings).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const recommendations = list(content.recommendations).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const limitations = list(content.limitations).filter((item): item is string => typeof item === "string");
  const citations = list(content.citations).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const nextQuestions = list(content.nextQuestions).filter((item): item is string => typeof item === "string");
  return <article className="admin-full-report"><section><h2>执行摘要</h2><p>{text(content.executiveSummary) || "未提供执行摘要。"}</p></section><section><h2>核心洞察 <span>{findings.length}</span></h2>{findings.length ? <div className="admin-finding-list">{findings.map((finding, index) => <article key={`${text(finding.title)}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{text(finding.title) || `洞察 ${index + 1}`}</h3><p>{text(finding.insight) || text(finding.description)}</p>{text(finding.evidence) ? <small>证据：{text(finding.evidence)}</small> : null}{text(finding.implication) ? <small>行动含义：{text(finding.implication)}</small> : null}</div></article>)}</div> : <p>未提供核心洞察。</p>}</section><section><h2>建议 <span>{recommendations.length}</span></h2>{recommendations.length ? <ol className="admin-recommendation-list">{recommendations.map((recommendation, index) => <li key={`${text(recommendation.title)}-${index}`}><strong>{text(recommendation.title) || `建议 ${index + 1}`}</strong><p>{text(recommendation.action) || text(recommendation.description) || text(recommendation.rationale)}</p></li>)}</ol> : <p>未提供建议。</p>}</section>{limitations.length ? <section><h2>研究局限</h2><ul>{limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></section> : null}{nextQuestions.length ? <section><h2>后续问题 <span>{nextQuestions.length}</span></h2><ul>{nextQuestions.map((question) => <li key={question}>{question}</li>)}</ul></section> : null}{citations.length ? <section><h2>来源 <span>{citations.length}</span></h2><ol className="admin-citation-list">{citations.map((citation, index) => <li key={`${text(citation.url)}-${index}`}><span>{index + 1}</span><div><strong>{text(citation.title) || "来源"}</strong>{text(citation.url) ? <a href={text(citation.url)} target="_blank" rel="noreferrer">{text(citation.url)}</a> : null}</div></li>)}</ol></section> : null}</article>;
}
