import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { BuyerQuestionsFields } from "./BuyerQuestionsFields";
import { commerceBuyerQuestions } from "@/lib/commerce-buyer-questions";

const id = "11111111-1111-4111-8111-111111111111";
const questions = commerceBuyerQuestions({
  website: {
    sections: [
      {
        id: "intake",
        title: "Before joining",
        buyerQuestions: [
          { id, question: "Your goal?", required: true },
          {
            id: "22222222-2222-4222-8222-222222222222",
            question: "Anything else?",
            required: false,
          },
        ],
      },
    ],
  },
});
function Fields() {
  const [answers, setAnswers] = useState<Record<string, string>>({
    priority_message: "Keep this message",
  });
  return (
    <>
      <BuyerQuestionsFields questions={questions} answers={answers} onChange={setAnswers} />
      <output data-testid="answers">{JSON.stringify(answers)}</output>
    </>
  );
}

describe("buyer intake fields", () => {
  it("collects required and optional answers under stable keys while preserving other checkout fields", () => {
    render(<Fields />);
    const required = screen.getByRole("textbox", { name: /Your goal/ });
    expect(required).toBeRequired();
    expect(required).toHaveAttribute("maxlength", "5000");
    expect(screen.getByRole("textbox", { name: /Anything else/ })).not.toBeRequired();
    fireEvent.change(required, { target: { value: "Launch a course" } });
    expect(JSON.parse(screen.getByTestId("answers").textContent!)).toEqual({
      priority_message: "Keep this message",
      [`bq_${id}`]: "Launch a course",
    });
    expect(screen.getByText(/private.*creator|creator.*private/i)).toBeInTheDocument();
  });

  it("renders no fields or privacy copy when no questions are configured", () => {
    const { container } = render(
      <BuyerQuestionsFields questions={[]} answers={{}} onChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
