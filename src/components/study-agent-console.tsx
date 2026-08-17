"use client";

import {
  ArrowLeft,
  BookOpenText,
  CheckCircle2,
  ExternalLink,
  Eye,
  FileSearch,
  FileText,
  Hash,
  MessagesSquare,
  Search,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";
import { StudyReportPreview } from "@/components/study-report-preview";
import type { StudyDetail } from "@/lib/studies";

type Artifact = StudyDetail["artifacts"][number];
type PersonaProfile = StudyDetail["personas"][number]["profile"];
type ConsoleContextValue = {
  selectedArtifactId: string | null;
  openArtifact: (artifactId: string) => void;
};

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function StudyArtifactConsoleProvider({
  initialArtifactId,
  children,
}: {
  initialArtifactId: string | null;
  children: React.ReactNode;
}) {
  const [selectedArtifactId, setSelectedArtifactId] = useState(initialArtifactId);
  const value = useMemo(() => ({ selectedArtifactId, openArtifact: setSelectedArtifactId }), [selectedArtifactId]);
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useStudyArtifactConsole() {
  const context = useContext(ConsoleContext);
  if (!context) throw new Error("Study artifact controls must be rendered inside StudyArtifactConsoleProvider");
  return context;
}

export function StudyArtifactOpenButton({
  artifactId,
  label = "查看详情",
  className = "agent-artifact-open",
}: {
  artifactId: string;
  label?: string;
  className?: string;
}) {
  const { openArtifact } = useStudyArtifactConsole();
  return <button type="button" className={className} onClick={() => openArtifact(artifactId)}><Eye size={14} />{label}</button>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function textValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" ? value : fallback;
}

function profileFrom(value: unknown): PersonaProfile | null {
  const profile = asRecord(value);
  const required = ["name", "archetype", "city", "occupation", "commute", "budget", "currentSituation", "decisionStyle"];
  if (!required.every((key) => typeof profile[key] === "string") || typeof profile.age !== "number") return null;
  return {
    name: textValue(profile.name),
    archetype: textValue(profile.archetype),
    age: profile.age,
    city: textValue(profile.city),
    occupation: textValue(profile.occupation),
    commute: textValue(profile.commute),
    budget: textValue(profile.budget),
    currentSituation: textValue(profile.currentSituation),
    goals: asStrings(profile.goals),
    painPoints: asStrings(profile.painPoints),
    decisionStyle: textValue(profile.decisionStyle),
    tags: asStrings(profile.tags),
  };
}

function PersonaDetail({ profile, onBack }: { profile: PersonaProfile; onBack: () => void }) {
  return (
    <article className="console-persona-detail">
      <button type="button" className="console-back" onClick={onBack}><ArrowLeft size={15} />返回 Persona 列表</button>
      <header>
        <span>AI SYNTHETIC PERSONA</span>
        <h2>{profile.name}</h2>
        <p>{profile.age} 岁 · {profile.city} · {profile.occupation}</p>
      </header>
      <div className="console-persona-hero">
        <span><UserRound size={28} /></span>
        <div><strong>{profile.archetype}</strong><p>{profile.currentSituation}</p></div>
      </div>
      <dl className="console-persona-fields">
        <div><dt>使用情境</dt><dd>{profile.commute}</dd></div>
        <div><dt>预算</dt><dd>{profile.budget}</dd></div>
        <div><dt>决策方式</dt><dd>{profile.decisionStyle}</dd></div>
        <div><dt>目标</dt><dd>{profile.goals.join("；")}</dd></div>
        <div><dt>痛点</dt><dd>{profile.painPoints.join("；")}</dd></div>
      </dl>
      <div className="console-persona-tags">{profile.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
      <p className="console-disclaimer">这是研究用 AI 合成画像，不代表现实中的具体个人。</p>
    </article>
  );
}

function PersonasConsole({ study, artifact }: { study: StudyDetail; artifact: Artifact }) {
  const [selected, setSelected] = useState<PersonaProfile | null>(null);
  const content = asRecord(artifact.content);
  const artifactPersonas = artifact.type === "persona_search"
    ? asRecords(content.matches).flatMap((item) => {
        const profile = profileFrom(item.profile);
        return profile ? [{ ...profile, name: textValue(item.name, profile.name), archetype: textValue(item.archetype, profile.archetype) }] : [];
      })
    : asRecords(content.personas).flatMap((item) => {
        const profile = profileFrom(item);
        return profile ? [profile] : [];
      });
  const personas = artifactPersonas.length ? artifactPersonas : study.personas.map((persona) => persona.profile);

  if (selected) return <PersonaDetail profile={selected} onBack={() => setSelected(null)} />;

  return (
    <section className="console-personas">
      <header className="console-section-heading">
        <div><Search size={18} /><span>{artifact.type === "persona_search" ? "PERSONA SEARCH" : "PERSONA BUILDER"}</span></div>
        <h2>{artifact.title}</h2>
        <p>{artifact.type === "persona_search" ? `围绕“${textValue(content.query, study.plan.personaFilters.audience)}”匹配工作区现有画像。` : "基于研究 Brief、公开证据与受众约束生成的差异化研究画像。"}</p>
      </header>
      {personas.length ? (
        <div className="console-persona-grid">
          {personas.map((persona, index) => (
            <button type="button" onClick={() => setSelected(persona)} key={`${persona.name}-${index}`}>
              <span className="console-persona-avatar"><UserRound size={22} /></span>
              <strong>{persona.name}</strong>
              <small>{persona.age} 岁 · {persona.city}</small>
              <p>{persona.archetype}</p>
              <i>{persona.tags.slice(0, 2).join(" · ")}</i>
            </button>
          ))}
        </div>
      ) : <div className="console-empty-inline"><FileSearch size={26} /><strong>没有匹配到可复用 Persona</strong><p>Agent 会继续执行 `buildPersona`，为当前研究补充新的差异化画像。</p></div>}
    </section>
  );
}

function PanelConsole({ study, artifact }: { study: StudyDetail; artifact: Artifact }) {
  const personaArtifact = study.artifacts.findLast((item) => item.type === "persona_set");
  const artifactPersonas = !personaArtifact || Array.isArray(personaArtifact.content)
    ? []
    : asRecords(personaArtifact.content.personas).flatMap((item, index) => {
        const profile = profileFrom(item);
        return profile ? [{ publicId: `${personaArtifact.publicId}-${index}`, name: profile.name, archetype: profile.archetype, profile }] : [];
      });
  const personas = study.personas.length ? study.personas : artifactPersonas;
  const [selectedId, setSelectedId] = useState(personas[0]?.publicId ?? "");
  const selected = personas.find((persona) => persona.publicId === selectedId);
  const content = asRecord(artifact.content);
  return (
    <section className="console-panel">
      <header className="console-section-heading">
        <div><UsersRound size={18} /><span>RESEARCH PANEL</span></div>
        <h2>{textValue(content.title, study.panel?.title ?? artifact.title)}</h2>
        <p>{textValue(content.description, study.panel?.description ?? "由 AI 合成 Persona 组成的研究 Panel。")}</p>
      </header>
      <div className="console-panel-layout">
        <nav aria-label="Panel Persona">
          {personas.map((persona, index) => <button type="button" className={persona.publicId === selectedId ? "active" : ""} onClick={() => setSelectedId(persona.publicId)} key={persona.publicId}><span>{index + 1}</span><div><strong>{persona.name}</strong><small>{persona.archetype}</small></div></button>)}
        </nav>
        {selected ? <PersonaDetail profile={selected.profile} onBack={() => setSelectedId("")} /> : <p className="status-empty">选择一位 Persona 查看完整画像。</p>}
      </div>
    </section>
  );
}

function DiscussionConsole({ artifact }: { artifact: Artifact }) {
  const content = asRecord(artifact.content);
  const messages = asRecords(content.messages);
  const findings = asStrings(content.findings);
  const insightGroups = [
    { title: "共识", items: asStrings(content.consensus) },
    { title: "关键分歧", items: asStrings(content.disagreements) },
    { title: "立场变化", items: asStrings(content.positionShifts) },
    { title: "意外主题", items: asStrings(content.unexpectedThemes) },
  ];
  return (
    <section className="console-discussion">
      <header className="console-section-heading">
        <div><MessagesSquare size={18} /><span>DISCUSSION CHAT</span></div>
        <h2>{textValue(content.title, artifact.title)}</h2>
        <p>{textValue(content.topic)}</p>
        <small>{numberValue(content.participantCount)} 位 AI 合成参与者 · {messages.length} 条讨论发言</small>
      </header>
      <div className="console-transcript">
        {messages.map((message, index) => (
          <article key={textValue(message.id, String(index))}>
            <span className="console-transcript-avatar"><UserRound size={16} /></span>
            <div><header><strong>{textValue(message.speaker, "Persona")}</strong><small>{textValue(message.archetype)} · 第 {numberValue(message.round, 1)} 轮</small></header><p>{textValue(message.content)}</p></div>
          </article>
        ))}
      </div>
      {findings.length ? <section className="console-discussion-findings"><h3>讨论归纳</h3>{findings.map((finding) => <p key={finding}><CheckCircle2 size={14} />{finding}</p>)}</section> : null}
      {insightGroups.map((group) => group.items.length ? <section className="console-discussion-findings" key={group.title}><h3>{group.title}</h3>{group.items.map((item) => <p key={item}><CheckCircle2 size={14} />{item}</p>)}</section> : null)}
      <p className="console-disclaimer">{textValue(content.disclaimer, "该内容为 AI 合成 Persona 推演，不代表真人研究或统计结论。")}</p>
    </section>
  );
}

function InterviewsConsole({ artifact }: { artifact: Artifact }) {
  const interviews = Array.isArray(artifact.content) ? artifact.content.map(asRecord) : [];
  return (
    <section className="console-discussion">
      <header className="console-section-heading">
        <div><MessagesSquare size={18} /><span>INTERVIEW CHAT</span></div>
        <h2>{artifact.title}</h2>
        <p>按 Persona 展示单独的模拟访谈摘要、原话与结构化洞察。</p>
        <small>{interviews.length} 位 AI 合成参与者</small>
      </header>
      <div className="console-interview-list">
        {interviews.map((interview, index) => (
          <article key={`${textValue(interview.personaName, "Persona")}-${index}`}>
            <header><span><UserRound size={16} /></span><div><strong>{textValue(interview.personaName, "Persona")}</strong><small>第 {numberValue(interview.batch, 1)} 批 · {textValue(interview.objective)}</small></div></header>
            <p>{textValue(interview.summary)}</p>
            <div>{asStrings(interview.quotes).map((quote) => <blockquote key={quote}>{quote}</blockquote>)}</div>
            <ul>{asStrings(interview.insights).map((insight) => <li key={insight}>{insight}</li>)}</ul>
          </article>
        ))}
      </div>
      <p className="console-disclaimer">以上内容由结构化 Persona 推演生成，不是现实受访者陈述。</p>
    </section>
  );
}

function SourcesConsole({ artifact }: { artifact: Artifact }) {
  const content = asRecord(artifact.content);
  const sources = asRecords(content.sources);
  const queries = asStrings(content.queries);
  const audit = asRecord(content.audit);
  const listedAudits = asRecords(content.audits);
  const audits = listedAudits.length ? listedAudits : Object.keys(audit).length ? [audit] : [];
  const candidates = audits.flatMap((item) => asRecords(item.candidates));
  const rejectedCandidates = candidates.filter((candidate) => textValue(candidate.status) !== "collected");
  return (
    <section className="console-sources">
      <header className="console-section-heading"><div><FileSearch size={18} /><span>SCOUT AGENT</span></div><h2>{artifact.title}</h2><p>公开网页与官方社交 API 证据按实际检索词归档，只有完成快照的来源才供后续工具读取。</p></header>
      <div className="console-query-list">{queries.map((query) => <span key={query}>{query}</span>)}</div>
      {audits.length ? <div className="console-source-audit-list">{audits.map((item, index) => <dl className="console-source-audit-summary" key={textValue(item.publicId, String(index))}>
        <div><dt>Connector</dt><dd>{textValue(item.connectorKey, textValue(item.provider, "public-web"))}</dd></div>
        <div><dt>候选</dt><dd>{numberValue(item.candidateCount)}</dd></div>
        <div><dt>已快照</dt><dd>{numberValue(item.collectedCount)}</dd></div>
        <div><dt>拒绝 / 不可用</dt><dd>{numberValue(item.rejectedCount) + numberValue(item.unavailableCount)}</dd></div>
      </dl>)}</div> : null}
      <ol>{sources.map((source, index) => <li key={textValue(source.url, String(index))}>
        <span>{String(index + 1).padStart(2, "0")}</span>
        <div>
          <strong>{textValue(source.title, "公开来源")}</strong>
          <p>{textValue(source.excerpt)}</p>
          {textValue(source.snapshotPublicId) ? <small className="console-source-snapshot"><ShieldCheck size={12} />{textValue(source.snapshotPublicId)}<Hash size={11} />{textValue(source.contentHash).slice(0, 12)}</small> : null}
        </div>
        {textValue(source.url) ? <a href={textValue(source.url)} target="_blank" rel="noreferrer" aria-label="打开公开来源"><ExternalLink size={15} /></a> : null}
      </li>)}</ol>
      {rejectedCandidates.length ? <details className="console-source-rejections">
        <summary>查看 {rejectedCandidates.length} 条未采用候选</summary>
        <ul>{rejectedCandidates.map((candidate, index) => <li key={textValue(candidate.publicId, String(index))}>
          <div><strong>{textValue(candidate.resolvedTitle, textValue(candidate.title, "候选来源"))}</strong><small>{textValue(candidate.status)} · {textValue(candidate.rejectionReason, "SOURCE_UNAVAILABLE")}</small></div>
          <span>{textValue(candidate.provider)}</span>
        </li>)}</ul>
      </details> : null}
    </section>
  );
}

function ValidationConsole({ artifact }: { artifact: Artifact }) {
  const content = asRecord(artifact.content);
  const directions = asRecords(content.directions);
  const calls = asRecords(content.calls);
  return (
    <section className="console-validation">
      <header className="console-section-heading"><div><BookOpenText size={18} /><span>AUDIENCE CALL</span></div><h2>{artifact.title}</h2><p>{textValue(content.summary)}</p></header>
      <div className="console-direction-grid">{directions.map((direction, index) => <article key={textValue(direction.title, String(index))}><header><span>{textValue(direction.verdict, "mixed")}</span><h3>{textValue(direction.title)}</h3></header><dl><div><dt>吸引力</dt><dd>{textValue(direction.appeal)}</dd></div><div><dt>阻力</dt><dd>{textValue(direction.resistance)}</dd></div></dl></article>)}</div>
      {calls.length ? <div className="console-interview-list">{calls.map((call, index) => <article key={`${textValue(call.personaName, "Persona")}-${index}`}><header><span><UserRound size={16} /></span><div><strong>{textValue(call.personaName, "Persona")}</strong><small>{textValue(call.archetype)} · 深度回答</small></div></header><p>{textValue(call.response)}</p><div>{asStrings(call.quotes).map((quote) => <blockquote key={quote}>{quote}</blockquote>)}</div><ul>{asStrings(call.signals).map((signal) => <li key={signal}>{signal}</li>)}</ul></article>)}</div> : null}
    </section>
  );
}

function GenericConsole({ artifact }: { artifact: Artifact }) {
  const entries = Object.entries(asRecord(artifact.content)).filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean");
  return (
    <section className="console-generic">
      <header className="console-section-heading"><div><FileText size={18} /><span>ARTIFACT</span></div><h2>{artifact.title}</h2><p>该结果已持久化到当前 Run，可用于回放、恢复和后续工具输入。</p></header>
      <dl>{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
    </section>
  );
}

export function StudyAgentConsole({ study }: { study: StudyDetail }) {
  const { selectedArtifactId } = useStudyArtifactConsole();
  const artifact = study.artifacts.find((item) => item.publicId === selectedArtifactId) ?? null;

  if (artifact?.type === "research_report" || (!artifact && study.report)) return <StudyReportPreview study={study} />;

  let content: React.ReactNode = null;
  if (artifact?.type === "persona_search" || artifact?.type === "persona_set") content = <PersonasConsole study={study} artifact={artifact} />;
  else if (artifact?.type === "panel") content = <PanelConsole study={study} artifact={artifact} />;
  else if (artifact?.type === "discussion_transcript") content = <DiscussionConsole artifact={artifact} />;
  else if (artifact?.type.startsWith("synthetic_interviews")) content = <InterviewsConsole artifact={artifact} />;
  else if (artifact?.type === "public_sources") content = <SourcesConsole artifact={artifact} />;
  else if (artifact?.type === "direction_validation") content = <ValidationConsole artifact={artifact} />;
  else if (artifact) content = <GenericConsole artifact={artifact} />;

  return (
    <aside className="agent-console-pane" aria-label="研究产物 Console">
      <header className="agent-console-header"><div><span>Console</span><strong>{artifact?.title ?? "研究产物"}</strong></div>{artifact ? <small>{new Date(artifact.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small> : null}</header>
      <div className="agent-console-stage">
        {content ?? <div className="agent-console-empty"><span><Eye size={24} /></span><h2>等待研究产物</h2><p>执行工具后，选择左侧的“查看详情”即可在这里检查 Persona、Panel、访谈过程、焦点讨论和最终报告。</p></div>}
      </div>
    </aside>
  );
}
