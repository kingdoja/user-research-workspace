import { Bot, CircleAlert, ExternalLink, Globe2, Lightbulb, ShieldCheck, UserRound } from "lucide-react";
import type { ReportEvidenceGraph } from "@/lib/evidence-graph";

type ReportClaim = NonNullable<ReportEvidenceGraph["nodes"][number]["claim"]>;

const claimLabels: Record<string, string> = {
  fact: "公开事实",
  human_observation: "真人观察",
  synthetic_simulation: "合成模拟",
  model_inference: "模型推断",
  recommendation: "行动建议",
};
const confidenceLabels: Record<string, string> = { low: "低置信", medium: "中置信", high: "高置信" };
const evidenceLabels: Record<string, string> = {
  fact: "公开来源",
  human_observation: "真人访谈",
  synthetic_simulation: "AI 合成模拟",
  model_inference: "模型推断",
  calculation: "结构化计算",
};

function EvidenceIcon({ type }: { type: string }) {
  if (type === "fact") return <Globe2 size={13} />;
  if (type === "human_observation") return <UserRound size={13} />;
  if (type === "synthetic_simulation") return <Bot size={13} />;
  return <Lightbulb size={13} />;
}

export function ReportClaimEvidence({ claim, visible = false }: { claim: ReportClaim | null; visible?: boolean }) {
  if (!visible) return null;
  if (!claim) return <div className="claim-evidence-legacy"><CircleAlert size={13} /><span>历史报告：尚未建立逐条证据映射。</span></div>;
  const direct = claim.supportStatus === "supported" && claim.evidence.length > 0;
  const mixed = claim.supportStatus === "mixed" && claim.evidence.length > 0;
  return <div className="claim-evidence-block">
    <div className="claim-evidence-status">
      <span data-claim-type={claim.claimType}>{claimLabels[claim.claimType] ?? claim.claimType}</span>
      <span>{confidenceLabels[claim.confidence] ?? claim.confidence}</span>
      <span className={direct ? "supported" : mixed ? "mixed" : "unsupported"}>{direct || mixed ? <ShieldCheck size={12} /> : <CircleAlert size={12} />}{direct ? `${claim.evidence.length} 条直接证据` : mixed ? `${claim.evidence.length} 条参考资料` : "未绑定直接证据"}</span>
    </div>
    {claim.evidence.length ? <details className="claim-evidence-details">
      <summary>查看逐条证据</summary>
      <ol>{claim.evidence.map((evidence) => <li key={evidence.publicId}>
        <div className="claim-evidence-source"><EvidenceIcon type={evidence.evidenceType} /><span>{evidenceLabels[evidence.evidenceType] ?? evidence.evidenceType}</span><code>{evidence.ref}</code></div>
        <strong>{evidence.title}</strong>
        <p>{evidence.content}</p>
        {evidence.sourceUri ? <a href={evidence.sourceUri} target="_blank" rel="noreferrer">打开原始来源<ExternalLink size={11} /></a> : null}
      </li>)}</ol>
    </details> : <p className="claim-evidence-boundary">该结论是分析推断或证据不足，不能作为已验证事实发布。</p>}
  </div>;
}
