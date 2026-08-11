"use client";

import { ArrowUp, Clock3, Lightbulb, LoaderCircle, Paperclip, Sparkles } from "lucide-react";
import Link from "next/link";
import { FormEvent, useState, useTransition } from "react";
import type { StudySummary } from "@/lib/studies";
import {
  formatStudyDate,
  methodLabels,
  studyStatusLabels,
  studyTypeLabels,
} from "@/lib/study-display";

const scenarioPrompts = [
  ["消费者洞察", "研究目标消费者在选择新品类时的真实动机、顾虑与决策路径。"],
  ["产品研发", "寻找现有产品体验中的关键问题，并评估最值得优先投入的改进方向。"],
  ["概念测试", "比较三个产品概念对目标人群的吸引力、理解偏差和购买阻力。"],
  ["竞品分析", "研究目标用户如何比较主要竞品，以及品牌切换发生在哪些关键时刻。"],
  ["品牌定位", "梳理品牌在不同细分人群心中的认知位置和差异化机会。"],
  ["内容策略", "研究目标受众会主动分享、收藏和信任哪类内容及其原因。"],
] as const;

export function StudyWorkspace({ studies }: { studies: StudySummary[] }) {
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function submitStudy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    startTransition(async () => {
      try {
        const response = await fetch("/api/studies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ brief }),
        });
        const result = (await response.json()) as { error?: string; redirectTo?: string };

        if (!response.ok || !result.redirectTo) {
          setError(result.error ?? "暂时无法创建研究计划");
          return;
        }

        window.location.assign(result.redirectTo);
      } catch {
        setError("网络连接失败，请稍后重试");
      }
    });
  }

  return (
    <div className="workspace-content-grid">
      <section className="study-entry-column">
        <div className="workspace-heading-row">
          <div>
            <h1>开始新研究</h1>
            <p>提出关于人类行为和决策的商业问题，我们会先生成一份可确认的研究计划。</p>
          </div>
          <Link className="workspace-text-link" href="/studies">我的项目</Link>
        </div>

        <form className="study-composer" onSubmit={submitStudy}>
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="提出任何关于人类行为和决策的商业问题。我们将为驱动真实选择的主观因素建模。"
            maxLength={4000}
            aria-label="研究问题"
          />
          <div className="study-composer-toolbar">
            <button type="button" className="composer-icon" disabled title="后续阶段支持附件">
              <Paperclip size={18} />
              <span className="sr-only">添加附件</span>
            </button>
            <span className="composer-count">{brief.length} / 4000</span>
            <button className="composer-submit" type="submit" disabled={pending || brief.trim().length < 12} title="生成研究计划">
              {pending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}
              <span className="sr-only">生成研究计划</span>
            </button>
          </div>
        </form>
        {error ? <p className="workspace-inline-error" role="alert">{error}</p> : null}

        <div className="scenario-section">
          <div className="scenario-title">
            <Sparkles size={17} />
            <h2>研究场景</h2>
          </div>
          <div className="scenario-grid">
            {scenarioPrompts.map(([label, prompt]) => (
              <button type="button" key={label} onClick={() => setBrief(prompt)}>
                <span>{label}</span>
                <small>{prompt}</small>
              </button>
            ))}
          </div>
        </div>

        <section className="recent-studies">
          <div className="section-heading-inline">
            <h2>最近研究</h2>
            {studies.length > 0 ? <Link href="/studies">查看全部</Link> : null}
          </div>
          {studies.length === 0 ? (
            <div className="workspace-empty-state">
              <Lightbulb size={22} />
              <div>
                <strong>还没有研究项目</strong>
                <p>输入第一个真实业务问题，系统会保存 Brief 并生成计划草案。</p>
              </div>
            </div>
          ) : (
            <div className="study-table-wrap">
              <table className="study-table">
                <thead><tr><th>项目</th><th>状态</th><th>方法</th><th>更新时间</th></tr></thead>
                <tbody>
                  {studies.slice(0, 6).map((study) => (
                    <tr key={study.publicId}>
                      <td>
                        <Link href={`/study/${study.publicId}`}>
                          <strong>{study.title}</strong>
                          <span>{studyTypeLabels[study.studyType] ?? study.studyType}</span>
                        </Link>
                      </td>
                      <td><span className={`study-status status-${study.status}`}>{studyStatusLabels[study.status] ?? study.status}</span></td>
                      <td>{study.methods.map((method) => methodLabels[method]).join(" + ") || "Persona 构建"}</td>
                      <td><Clock3 size={14} />{formatStudyDate(study.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </section>

      <aside className="study-progress-rail">
        <h2>计划进度</h2>
        <div className="progress-overview">
          <div><span style={{ width: brief.trim().length >= 12 ? "32%" : "12%" }} /></div>
          <strong>{brief.trim().length >= 12 ? "32%" : "12%"}</strong>
        </div>
        <ol className="progress-steps">
          <li className="active"><span>1</span><div><strong>Brief</strong><p>描述需要研究的问题</p></div></li>
          <li><span>2</span><div><strong>澄清</strong><p>补充目标与范围</p></div></li>
          <li><span>3</span><div><strong>确认计划</strong><p>确认方法与研究范围</p></div></li>
          <li><span>4</span><div><strong>执行</strong><p>研究执行与资料检索</p></div></li>
          <li><span>5</span><div><strong>报告</strong><p>生成洞察报告</p></div></li>
        </ol>
        <div className="progress-note">
          <Lightbulb size={18} />
          <p>完整描述业务背景、目标人群和决策场景，可以减少后续澄清轮次。</p>
        </div>
      </aside>
    </div>
  );
}
