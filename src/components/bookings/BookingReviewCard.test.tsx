import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BookingReviewCard } from "./BookingReviewCard";

const review = { rating: 5, body: "Exactly what I needed.", reviewerName: "Ava" };

describe("BookingReviewCard", () => {
  it("lets the creator hide a review from the calendar page", () => {
    const onChange = vi.fn();
    render(
      <BookingReviewCard
        review={review}
        visibility={{ isPublic: true, pending: false, onChange }}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Show review from Ava on calendar page" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does not show visibility controls to public visitors", () => {
    render(<BookingReviewCard review={review} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
