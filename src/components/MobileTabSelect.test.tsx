import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileTabSelect } from "./MobileTabSelect";

describe("MobileTabSelect", () => {
  it("shows the active section and reports changes", () => {
    const onChange = vi.fn();
    render(
      <MobileTabSelect
        value="plan"
        options={[
          { value: "overview", label: "Overview" },
          { value: "plan", label: "Plan", count: 2 },
        ]}
        onChange={onChange}
        ariaLabel="Settings section"
      />,
    );

    const select = screen.getByRole("combobox", { name: "Settings section" });
    expect(select).toHaveValue("plan");

    fireEvent.change(select, { target: { value: "overview" } });

    expect(onChange).toHaveBeenCalledWith("overview");
  });
});
