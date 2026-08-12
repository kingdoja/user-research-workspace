"use client";

export function StudyFollowupSuggestions({ questions }: { questions: string[] }) {
  return (
    <div className="agent-suggested-questions">
      {questions.slice(0, 4).map((question) => (
        <button
          type="button"
          key={question}
          onClick={() => window.dispatchEvent(new CustomEvent("atypica:followup", { detail: question }))}
        >
          {question}
        </button>
      ))}
    </div>
  );
}
