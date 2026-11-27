import {
  MAX_COMMERCE_BUYER_QUESTIONS,
  normalizeBuyerQuestionLabel,
  type CommerceBuyerQuestion,
} from "@/lib/commerce-buyer-questions";

export function BuyerQuestionsEditor({
  value,
  onChange,
  maxQuestions = MAX_COMMERCE_BUYER_QUESTIONS,
  existingQuestions = [],
}: {
  value: CommerceBuyerQuestion[];
  onChange: (value: CommerceBuyerQuestion[]) => void;
  maxQuestions?: number;
  existingQuestions?: string[];
}) {
  const labels = [...existingQuestions, ...value.map((question) => question.question)]
    .map(normalizeBuyerQuestionLabel)
    .filter(Boolean);
  const duplicate = new Set(labels).size !== labels.length;
  return (
    <div className="space-y-3 border-t border-black/10 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h5 className="text-sm font-semibold">Buyer questions</h5>
        <button
          type="button"
          disabled={value.length >= maxQuestions}
          className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-40"
          onClick={() =>
            onChange([...value, { id: crypto.randomUUID(), question: "", required: true }])
          }
        >
          Add buyer question
        </button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Buyers answer these questions before purchase. Answers are private and appear with the
        order. New questions require an answer by default; turn off Required for optional details.
      </p>
      {duplicate ? (
        <p role="alert" className="text-xs text-rose-700">
          Each buyer question must have a unique prompt.
        </p>
      ) : null}
      {value.map((question, index) => (
        <div key={question.id} className="space-y-2 rounded-lg border border-black/10 p-3">
          <label className="block text-xs font-medium">
            Buyer question {index + 1}
            <input
              value={question.question}
              maxLength={500}
              placeholder="What would help you get started?"
              className="mt-2 w-full rounded-lg border border-black/10 bg-white px-3 py-2.5 text-sm"
              onChange={(event) =>
                onChange(
                  value.map((item) =>
                    item.id === question.id ? { ...item, question: event.target.value } : item,
                  ),
                )
              }
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                aria-label={`Required answer for question ${index + 1}`}
                checked={question.required}
                onChange={(event) =>
                  onChange(
                    value.map((item) =>
                      item.id === question.id ? { ...item, required: event.target.checked } : item,
                    ),
                  )
                }
              />
              Required
            </label>
            <button
              type="button"
              aria-label={`Remove buyer question ${index + 1}`}
              className="rounded px-2 py-1 text-xs text-rose-700"
              onClick={() => onChange(value.filter((item) => item.id !== question.id))}
            >
              Remove question
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
