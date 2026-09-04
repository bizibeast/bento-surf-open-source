import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HoverGuide } from "./HoverGuide";

describe("HoverGuide", () => {
  afterEach(() => vi.useRealTimers());

  it("shows short guidance after the delay and hides it when the pointer leaves", () => {
    vi.useFakeTimers();
    render(
      <>
        <button type="button" aria-label="Open scheduler settings">
          icon
        </button>
        <HoverGuide delay={900} />
      </>,
    );
    const button = screen.getByRole("button");

    fireEvent.pointerOver(button, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(899));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Open scheduler settings");

    fireEvent.pointerOut(button, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("also guides keyboard focus using visible button text", () => {
    vi.useFakeTimers();
    render(
      <>
        <button type="button">Save draft</button>
        <HoverGuide delay={900} />
      </>,
    );

    fireEvent.focusIn(screen.getByRole("button"));
    act(() => vi.advanceTimersByTime(900));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Save draft");
  });

  it("supports explicitly guided non-button elements", () => {
    vi.useFakeTimers();
    render(
      <>
        <span tabIndex={0} data-hover-guide="Instagram · @creator">
          avatar
        </span>
        <HoverGuide delay={900} />
      </>,
    );

    fireEvent.pointerOver(screen.getByText("avatar"), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(900));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Instagram · @creator");
  });
});
