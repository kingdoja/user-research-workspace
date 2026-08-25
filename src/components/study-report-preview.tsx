"use client";

import { ChevronDown, ClipboardCheck, Download, ExternalLink, Eye, FileText, Hash, Printer, X } from "lucide-react";
import { useState } from "react";
import { ReportClaimEvidence } from "@/components/report-claim-evidence";
import type { StudyDetail } from "@/lib/studies";

export function StudyReportPreview({ study }: { study: StudyDetail }) {
  const [open, setOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const report = study.report;
  const findingCount = report?.content.findings.length ?? 0;
  const recommendationCount = report?.content.recommendations.length ?? 0;
  const sourceCount = report?.citations.length ?? 0;
  const findingNodes = report?.evidenceGraph?.nodes.filter((node) => node.nodeType === "finding") ?? [];
  const reportSections = [
    { id: "report-summary", label: "执行摘要" },
    { id: "report-findings", label: `核心发现 · ${findingCount}` },
    { id: "report-recommendations", label: `行动建议 · ${recommendationCount}` },
    { id: "report-limitations", label: "局限与后续问题" },
    { id: "report-sources", label: `公开来源 · ${sourceCount}` },
  ];

  function downloadMarkdown() {
    if (!report) return;
    const findings = report.content.findings.map((finding, index) => [
      `## ${index + 1}. ${finding.title}`,
      finding.insight,
      `**证据**：${finding.evidence}`,
      `**业务含义**：${finding.implication}`,
    ].join("\n\n")).join("\n\n");
    const recommendations = report.content.recommendations.map((item) => (
      `- **${item.title}**（${item.priority}）：${item.action}\n  - ${item.rationale}`
    )).join("\n");
    const sources = report.citations.map((citation) => `- [${citation.title}](${citation.url})`).join("\n");
    const markdown = [
      `# ${report.title}`,
      `**结论性质**：${report.content.answerability?.reportLabel ?? "研究报告"}`,
      report.content.answerability?.basisLabel ?? "",
      report.content.executiveSummary,
      findings,
      `## 行动建议\n\n${recommendations}`,
      `## 研究局限\n\n${report.content.limitations.map((item) => `- ${item}`).join("\n")}`,
      `## 后续问题\n\n${report.content.nextQuestions.map((item) => `- ${item}`).join("\n")}`,
      `## 公开来源\n\n${sources || "本报告没有可展示的 URL 注释。"}`,
      "---\n本报告包含公开资料综合与 AI 合成 Persona 模拟，不代表真人样本或统计结论。",
    ].join("\n\n");
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${report.title.replace(/[\\/:*?\"<>|]/g, "-")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

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
            <div><dt>{findingCount || study.plan.personaCount}</dt><dd>{report ? "核心研究洞察" : "计划合成 Persona"}<br />结构化分析</dd></div>
            <div><dt>{recommendationCount || study.plan.methods.length}</dt><dd>{report ? "行动建议" : "研究方法"}<br />优先级排序</dd></div>
            <div><dt>{sourceCount}</dt><dd>公开资料来源<br />可核查引用</dd></div>
          </dl>
          <footer>基于可核查公开资料与透明标注的 AI 合成 Persona 模拟 · Cognara AI Research Intelligence</footer>
        </article>
        <button className="view-report-button" type="button" disabled={!report} onClick={() => setOpen(true)}>
          <Eye size={18} />{report ? "查看报告" : "报告生成中"}
        </button>
      </div>

      {open && report ? (
        <div className="report-reader" role="dialog" aria-modal="true" aria-label={report.title}>
          <header>
            <div><span>研究报告</span><strong>{report.title}</strong></div>
            <nav aria-label="报告工具">
              <button type="button" onClick={downloadMarkdown} aria-label="下载 Markdown 报告" title="下载 Markdown"><Download size={18} /></button>
              <button type="button" onClick={() => window.print()} aria-label="打印或另存为 PDF" title="打印或另存为 PDF"><Printer size={18} /></button>
              <button type="button" onClick={() => setAuditOpen((value) => !value)} aria-label="切换证据审计" aria-pressed={auditOpen} title="证据审计"><ClipboardCheck size={18} /></button>
              <button type="button" onClick={() => setOpen(false)} aria-label="关闭报告"><X size={20} /></button>
            </nav>
          </header>
          <div className="report-reader-layout">
            <nav className="report-reader-nav" aria-label="报告章节">
              <span>章节</span>
              {reportSections.map((section) => <a href={`#${section.id}`} key={section.id}>{section.label}</a>)}
              <div className="report-reader-nav-note"><Hash size={13} />公开证据可回溯</div>
            </nav>
            <div className="report-reader-content">
            <section className="report-reader-summary" id="report-summary">
              <span>EXECUTIVE SUMMARY</span>
              <h2>{report.title}</h2>
              <div className={`report-answerability report-answerability-${report.content.answerability?.level ?? "decision_ready"}`}>
                <strong>{report.content.answerability?.reportLabel ?? "研究报告"}</strong>
                <span>{report.content.answerability?.basisLabel ?? "结论、业务含义与行动建议"}</span>
              </div>
              <p>{report.content.executiveSummary}</p>
              <dl className="report-reader-metrics">
                <div><dt>洞察</dt><dd>{findingCount}</dd></div>
                <div><dt>建议</dt><dd>{recommendationCount}</dd></div>
                <div><dt>来源</dt><dd>{sourceCount}</dd></div>
                <div><dt>生成时间</dt><dd>{new Date(report.generatedAt).toLocaleDateString("zh-CN")}</dd></div>
              </dl>
            </section>
            <section id="report-findings" aria-label="核心发现">
              {report.content.findings.map((finding, index) => (
                <section className="report-reader-finding" key={`${finding.title}-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{finding.title}</h3>
                  <ReportClaimEvidence claim={findingNodes[index]?.claim ?? null} visible={auditOpen} />
                  <p>{finding.insight}</p>
                  <dl><div><dt>证据</dt><dd>{finding.evidence}</dd></div><div><dt>业务含义</dt><dd>{finding.implication}</dd></div></dl>
                </div>
                </section>
              ))}
            </section>
            <section className="report-reader-recommendations" id="report-recommendations">
              <h3>行动建议</h3>
              {report.content.recommendations.map((item) => (
                <article key={item.title}><span>{item.priority}</span><div><h4>{item.title}</h4><p>{item.action}</p><small>{item.rationale}</small></div></article>
              ))}
            </section>
            <section className="report-reader-limitations" id="report-limitations">
              <h3>研究局限</h3>
              <ul>{report.content.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
              <h3>后续问题</h3>
              <ul>{report.content.nextQuestions.map((question) => <li key={question}>{question}</li>)}</ul>
            </section>
            <section className="report-reader-sources" id="report-sources">
              <h3>公开来源</h3>
              {report.citations.length ? report.citations.map((citation, index) => (
                <a href={citation.url} target="_blank" rel="noreferrer" key={citation.url}><span>{String(index + 1).padStart(2, "0")}</span>{citation.title}<ExternalLink size={13} /></a>
              )) : <p>本次报告没有返回可展示的 URL 注释。</p>}
            </section>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
