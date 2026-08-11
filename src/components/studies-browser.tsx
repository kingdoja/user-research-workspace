"use client";

import { Clock3, Search } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useState } from "react";
import type { StudySummary } from "@/lib/studies";
import { formatStudyDate, methodLabels, studyStatusLabels, studyTypeLabels } from "@/lib/study-display";

export function StudiesBrowser({ studies }: { studies: StudySummary[] }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const filtered = deferredQuery
    ? studies.filter((study) => study.title.toLowerCase().includes(deferredQuery))
    : studies;

  return (
    <div className="studies-browser">
      <label className="study-search">
        <Search size={18} />
        <span className="sr-only">搜索研究项目</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索研究项目..." />
      </label>
      <p className="study-count">{filtered.length} 个项目</p>
      <div className="study-table-wrap">
        <table className="study-table study-table-full">
          <thead><tr><th>项目</th><th>类型</th><th>状态</th><th>研究方法</th><th>更新时间</th></tr></thead>
          <tbody>
            {filtered.map((study) => (
              <tr key={study.publicId}>
                <td><Link href={`/study/${study.publicId}`}><strong>{study.title}</strong></Link></td>
                <td>{studyTypeLabels[study.studyType] ?? study.studyType}</td>
                <td><span className={`study-status status-${study.status}`}>{studyStatusLabels[study.status] ?? study.status}</span></td>
                <td>{study.methods.map((method) => methodLabels[method]).join(" + ") || "Persona 构建"}</td>
                <td><Clock3 size={14} />{formatStudyDate(study.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 ? <div className="workspace-empty-state compact"><Search size={20} /><p>没有找到匹配的研究项目。</p></div> : null}
    </div>
  );
}
