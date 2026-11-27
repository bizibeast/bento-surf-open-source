import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ProductWebsiteEditor } from "./ProductWebsiteEditor";
import { productWebsite, type ProductWebsite } from "@/lib/product-website";

function Editor({
  initial = productWebsite({}),
  kind = "course",
  legacy = [],
}: {
  initial?: ProductWebsite;
  kind?: string;
  legacy?: string[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ProductWebsiteEditor
        value={value}
        onChange={setValue}
        title="Course"
        subtitle="Learn with me"
        kind={kind}
        legacyBuyerQuestions={legacy}
      />
      <output data-testid="settings">{JSON.stringify(value)}</output>
    </>
  );
}

describe("product website buyer-question editor", () => {
  it("inherits Link styling while retaining branding and layout", () => {
    render(<Editor />);
    expect(screen.getByText(/inherit.*Link|Link.*theme/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Website accent color")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Background")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Headline style")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Brand name")).toBeInTheDocument();
    expect(screen.getByLabelText("Hero alignment")).toBeInTheDocument();
  });

  it("adds buyer intake in a custom section with required as the default", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Add section" }));
    fireEvent.click(screen.getByRole("button", { name: "Add buyer question" }));
    const prompt = screen.getByRole("textbox", { name: "Buyer question 1" });
    fireEvent.change(prompt, { target: { value: "What do you want to learn?" } });
    expect(screen.getByRole("checkbox", { name: "Required answer for question 1" })).toBeChecked();
    const before = JSON.parse(screen.getByTestId("settings").textContent!).sections[0]
      .buyerQuestions[0];
    fireEvent.change(prompt, { target: { value: "Your learning goal?" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Required answer for question 1" }));
    const after = JSON.parse(screen.getByTestId("settings").textContent!).sections[0]
      .buyerQuestions[0];
    expect(after).toMatchObject({
      id: before.id,
      question: "Your learning goal?",
      required: false,
    });
    expect(screen.getByText(/Buyers answer these questions before purchase/i)).toBeInTheDocument();
  });

  it("counts legacy questions and reserves the initial priority message slot", () => {
    const questions = Array.from({ length: 19 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      question: `Question ${index}`,
      required: true,
    }));
    render(
      <Editor
        kind="priority_dm"
        initial={productWebsite({
          sections: [{ id: "section", title: "Details", body: "", buyerQuestions: questions }],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Add buyer question" })).toBeDisabled();
  });

  it("retains question IDs when a custom section moves", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    render(
      <Editor
        initial={productWebsite({
          sections: [
            {
              id: "one",
              title: "Intake",
              body: "",
              buyerQuestions: [{ id, question: "Goal?", required: true }],
            },
            { id: "two", title: "Story", body: "" },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Move section 1 down" }));
    const settings = JSON.parse(screen.getByTestId("settings").textContent!);
    expect(settings.sections[1].buyerQuestions[0].id).toBe(id);
    const preview = screen.getByLabelText("Website preview");
    expect(within(preview).getByText("Course")).toBeInTheDocument();
  });
});
