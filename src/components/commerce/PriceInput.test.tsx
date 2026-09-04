import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PriceInput } from "./PriceInput";

describe("PriceInput", () => {
  it("lets a creator clear and type a decimal without forcing trailing zeroes", () => {
    const onAmountChange = vi.fn();
    render(<PriceInput amount={1900} onAmountChange={onAmountChange} />);

    const input = screen.getByLabelText("Price");
    expect(input).toHaveValue(19);

    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue(null);
    expect(onAmountChange).toHaveBeenLastCalledWith(0);

    fireEvent.change(input, { target: { value: "19.95" } });
    expect(input).toHaveValue(19.95);
    expect(onAmountChange).toHaveBeenLastCalledWith(1995);
  });

  it("uses a numeric input while visually removing browser steppers", () => {
    render(<PriceInput amount={500} onAmountChange={() => undefined} />);
    const input = screen.getByLabelText("Price");
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveAttribute("inputmode", "decimal");
    expect(input).toHaveClass("[appearance:textfield]");
  });

  it("uses its supplied accessible label", () => {
    render(
      <PriceInput amount={500} ariaLabel="Paid follow-up price" onAmountChange={() => undefined} />,
    );
    expect(screen.getByLabelText("Paid follow-up price")).toBeInTheDocument();
  });
});
