import { ExternalLink, FileText, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ReportClaimEvidence } from "@/components/report-claim-evidence";
import { getSharedStudyReport } from "@/lib/studies";

type SharedPageProps = { params: Promise<{ shareToken: string }> };
const getSharedReport = cache(getSharedStudyReport);

export async function generateMetadata({ params }: SharedPageProps): Promise<Metadata> {
  const { shareToken } = await params;
  const study = await getSharedReport(shareToken);
  return study ? { title: study.report.title, robots: { index: false, follow: false } } : {};
}

export default async function SharedStudyPage({ params }: SharedPageProps) {
  const { shareToken } = await params;
  const study = await getSharedReport(shareToken);
  if (!study) notFound();
  const findingNodes = study.report.evidenceGraph?.nodes.filter((node) => node.nodeType === "finding") ?? [];

  return (
    <main className="shared-report-page">
      <header className="shared-report-header">
        <strong>Cognara AI</strong>
        <span><FileText size={15} />只读研究报告</span>
      </header>
      <article className="shared-report-document">
        <section className="shared-report-hero">
          <span>RESEARCH INTELLIGENCE REPORT · {new Date(study.generatedAt).getFullYear()}</span>
          <h1>{study.report.title}</h1>
          <div className={`report-answerability report-answerability-${study.report.content.answerability?.level ?? "decision_ready"}`}>
            <strong>{study.report.content.answerability?.reportLabel ?? "研究报告"}</strong>
            <span>{study.report.content.answerability?.basisLabel ?? "结论、业务含义与行动建议"}</span>
          </div>
          <p>{study.report.content.executiveSummary}</p>
          <dl>
            <div><dt>{study.report.content.findings.length}</dt><dd>核心洞察</dd></div>
            <div><dt>{study.report.content.recommendations.length}</dt><dd>行动建议</dd></div>
            <div><dt>{study.personas.length}</dt><dd>AI 合成 Persona</dd></div>
          </dl>
        </section>
        <p className="shared-evidence-notice">本页面包含公开资料综合与 AI 合成 Persona/模拟访谈，不代表真人样本或统计结论。</p>
        {study.report.content.findings.map((finding, index) => (
          <section className="shared-report-finding" key={finding.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div><h2>{finding.title}</h2><ReportClaimEvidence claim={findingNodes[index]?.claim ?? null} /><p>{finding.insight}</p><dl><div><dt>证据总结</dt><dd>{finding.evidence}</dd></div><div><dt>业务含义</dt><dd>{finding.implication}</dd></div></dl></div>
          </section>
        ))}
        {study.panel ? (
          <section className="shared-panel-section">
            <div><UsersRound size={18} /><h2>{study.panel.title}</h2></div>
            <p>{study.panel.description}</p>
            <div className="shared-persona-grid">{study.personas.map((persona) => <article key={persona.publicId}><strong>{persona.name}</strong><span>{persona.archetype}</span><p>{persona.profile.city} · {persona.profile.occupation}</p></article>)}</div>
            {study.interviews.length ? <div className="shared-interview-list"><h3>模拟访谈摘要</h3>{study.interviews.map((interview) => <article key={`${interview.personaPublicId}-${interview.batch}`}><header><span>第 {interview.batch} 批 · {interview.personaName}</span><strong>{interview.objective}</strong></header><p>{interview.content.summary}</p><blockquote>“{interview.content.quotes[0]}”</blockquote></article>)}</div> : null}
          </section>
        ) : null}
        <section className="shared-recommendations"><h2>行动建议</h2>{study.report.content.recommendations.map((item) => <article key={item.title}><span>{item.priority}</span><div><h3>{item.title}</h3><p>{item.action}</p><small>{item.rationale}</small></div></article>)}</section>
        <section className="shared-limitations"><h2>研究局限</h2><ul>{study.report.content.limitations.map((item) => <li key={item}>{item}</li>)}</ul></section>
        <section className="shared-sources"><h2>公开来源</h2>{study.report.citations.map((citation) => <a href={citation.url} target="_blank" rel="noreferrer" key={citation.url}>{citation.title}<ExternalLink size={13} /></a>)}</section>
      </article>
    </main>
  );
}
