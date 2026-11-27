import {
  MAX_COMMERCE_BUYER_ANSWER_LENGTH,
  type CanonicalCommerceBuyerQuestion,
} from "@/lib/commerce-buyer-questions";

export function BuyerQuestionsFields({
  questions,
  answers,
  onChange,
  disabled,
  className = "space-y-4",
  inputClassName = "w-full rounded-lg border px-4 py-3.5 text-sm",
}: {
  questions: CanonicalCommerceBuyerQuestion[];
  answers: Record<string, string>;
  onChange: (answers: Record<string, string>) => void;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
}) {
  if (questions.length === 0) return null;
  return (
    <div className={className}>
      {questions.map((question) => (
        <label key={question.id} className="block">
          <span className="mb-2 block text-xs font-semibold">
            {question.question}
            {question.required ? " *" : " (optional)"}
          </span>
          <textarea
            name={question.answerKey}
            required={question.required}
            disabled={disabled}
            rows={3}
            maxLength={MAX_COMMERCE_BUYER_ANSWER_LENGTH}
            value={answers[question.answerKey] || ""}
            onChange={(event) => onChange({ ...answers, [question.answerKey]: event.target.value })}
            placeholder="Your answer"
            className={`${inputClassName} resize-y`}
          />
        </label>
      ))}
      <p className="text-xs opacity-65">
        Your answers are shared privately with the creator to fulfill your purchase.
      </p>
    </div>
  );
}
