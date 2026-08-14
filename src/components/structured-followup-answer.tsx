type AnswerSection = {
  heading: string;
  body: string;
  bullets: string[];
};

type AnswerPresentation = {
  title: string;
  summary: string;
  sections: AnswerSection[];
  conclusion: string;
};

function cleanText(value: string) {
  return value
    .replace(/\[(?:nextQuestions|findings|recommendations|limitations)\]/gi, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stringValue(value: unknown) {
  return typeof value === "string" ? cleanText(value) : "";
}

function parsePresentation(value: unknown): AnswerPresentation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const sections = Array.isArray(item.sections)
    ? item.sections.flatMap((section) => {
        if (!section || typeof section !== "object") return [];
        const entry = section as Record<string, unknown>;
        const heading = stringValue(entry.heading);
        const body = stringValue(entry.body);
        const bullets = Array.isArray(entry.bullets)
          ? entry.bullets.map(stringValue).filter(Boolean)
          : [];
        return heading && (body || bullets.length) ? [{ heading, body, bullets }] : [];
      })
    : [];
  const title = stringValue(item.title);
  const summary = stringValue(item.summary);
  const conclusion = stringValue(item.conclusion);

  return title && summary && sections.length && conclusion
    ? { title, summary, sections, conclusion }
    : null;
}

function parseLegacyAnswer(content: string): AnswerPresentation {
  const cleaned = cleanText(content);
  const sectionPattern = /(?:^|\s)([一二三四五六七八九十]+[、.]|\d+[、.])\s*([^。！？\n]{2,42})[。:：]\s*/g;
  const matches = [...cleaned.matchAll(sectionPattern)];

  if (!matches.length) {
    const sentences = cleaned.split(/(?<=[。！？])\s+/).filter(Boolean);
    return {
      title: "回答摘要",
      summary: sentences.slice(0, 2).join(" ") || cleaned,
      sections: sentences.length > 2
        ? [{ heading: "分析与建议", body: "", bullets: sentences.slice(2) }]
        : [],
      conclusion: sentences.at(-1) ?? cleaned,
    };
  }

  const firstIndex = matches[0].index ?? 0;
  const summary = cleanText(cleaned.slice(0, firstIndex));
  const sections = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? cleaned.length;
    const sectionText = cleanText(cleaned.slice(start, end));
    const sentences = sectionText.split(/(?<=[。！？])\s+/).filter(Boolean);
    return {
      heading: `${match[1]} ${cleanText(match[2])}`,
      body: sentences[0] ?? "",
      bullets: sentences.slice(1),
    };
  });

  return {
    title: "回答摘要",
    summary: summary || sections[0]?.body || cleaned,
    sections,
    conclusion: sections.at(-1)?.bullets.at(-1) ?? sections.at(-1)?.body ?? cleaned,
  };
}

export function StructuredFollowupAnswer({
  content,
  presentation,
}: {
  content: string;
  presentation: unknown;
}) {
  const answer = parsePresentation(presentation) ?? parseLegacyAnswer(content);

  return (
    <div className="agent-answer-document">
      <header>
        <span>REPORT FOLLOW-UP</span>
        <h3>{answer.title}</h3>
        <p>{answer.summary}</p>
      </header>
      <div className="agent-answer-sections">
        {answer.sections.map((section, index) => (
          <section key={`${section.heading}-${index}`}>
            <h4><span>{String(index + 1).padStart(2, "0")}</span>{section.heading.replace(/^[\d一-龥]+[、.]\s*/, "")}</h4>
            {section.body ? <p>{section.body}</p> : null}
            {section.bullets.length ? <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul> : null}
          </section>
        ))}
      </div>
      <footer><strong>总结</strong><p>{answer.conclusion}</p></footer>
    </div>
  );
}
