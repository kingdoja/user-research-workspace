"use client";

import { ChevronDown, ExternalLink, Eye, FileText, X } from "lucide-react";
import { useState } from "react";
import type { StudyDetail } from "@/lib/studies";

export function StudyReportPreview({ study }: { study: StudyDetail }) {
  const [open, setOpen] = useState(false);
  const report = study.report;
  const findingCount = report?.content.findings.length ?? 0;
  const recommendationCount = report?.content.recommendations.length ?? 0;
  const sourceCount = report?.citations.length ?? 0;

  return (
    <aside className="agent-report-pane" aria-label="研究报告预览">
      <button className="report-type-button" type="button">
        <FileText size={16} />报告<ChevronDown size={15} />
      </button>
      <div className="report-stage">
        <article className="report-cover-sheet">
          <div className="report-cover-kicker">RESEARCH INTELLIGENCE REPORT · {new Date().getFullYear()}</div>
          <h2>{report?.title ?? study.title}</h2>
          <p>{report?.content.executiveSummary ?? study.plan.rationale}</p>
          <div className="report-cover-rule" />
          <dl className="report-cover-metrics">
            <div><dt>{findingCount || study.plan.personaCount}</dt><dd>{report ? "核心研究洞察" : "计划研究样本"}<br />结构化分析</dd></div>
            <div><dt>{recommendationCount || study.plan.methods.length}</dt><dd>{report ? "行动建议" : "研究方法"}<br />优先级排序</dd></div>
            <div><dt>{sourceCount}</dt><dd>公开资料来源<br />可核查引用</dd></div>
          </dl>
          <footer>基于可核查公开资料与 AI 综合分析 · atypica.AI Business Research Intelligence</footer>
        </article>
        <button className="view-report-button" type="button" disabled={!report} onClick={() => setOpen(true)}>
          <Eye size={18} />{report ? "查看报告" : "报告生成中"}
        </button>
      </div>

      {open && report ? (
        <div className="report-reader" role="dialog" aria-modal="true" aria-label={report.title}>
          <header>
            <div><span>研究报告</span><strong>{report.title}</strong></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭报告"><X size={20} /></button>
          </header>
          <div className="report-reader-content">
            <section className="report-reader-summary">
              <span>EXECUTIVE SUMMARY</span>
              <h2>{report.title}</h2>
              <p>{report.content.executiveSummary}</p>
            </section>
            {report.content.findings.map((finding, index) => (
              <section className="report-reader-finding" key={`${finding.title}-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{finding.title}</h3>
                  <p>{finding.insight}</p>
                  <dl><div><dt>证据</dt><dd>{finding.evidence}</dd></div><div><dt>业务含义</dt><dd>{finding.implication}</dd></div></dl>
                </div>
              </section>
            ))}
            <section className="report-reader-recommendations">
              <h3>行动建议</h3>
              {report.content.recommendations.map((item) => (
                <article key={item.title}><span>{item.priority}</span><div><h4>{item.title}</h4><p>{item.action}</p><small>{item.rationale}</small></div></article>
              ))}
            </section>
            <section className="report-reader-sources">
              <h3>公开来源</h3>
              {report.citations.length ? report.citations.map((citation) => (
                <a href={citation.url} target="_blank" rel="noreferrer" key={citation.url}>{citation.title}<ExternalLink size={13} /></a>
              )) : <p>本次报告没有返回可展示的 URL 注释。</p>}
            </section>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
