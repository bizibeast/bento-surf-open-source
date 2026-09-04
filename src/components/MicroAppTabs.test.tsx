import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Circle } from "lucide-react";
import { MicroAppTabs } from "./MicroAppTabs";

describe("MicroAppTabs", () => {
  it("uses the shared mobile dropdown without changing desktop tabs", () => {
    const onChange = vi.fn();
    render(
      <MicroAppTabs
        tabs={[
          { id: "overview", label: "Overview", icon: Circle },
          { id: "analytics", label: "Analytics", icon: Circle, count: 3 },
        ]}
        value="overview"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Page section" }), {
      target: { value: "analytics" },
    });

    expect(onChange).toHaveBeenCalledWith("analytics");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveClass("rounded-xl", "text-white");
    expect(screen.getByRole("tab", { name: "Overview" })).not.toHaveClass("rounded-lg", "bg-white");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("data-micro-app-tab");
    expect(screen.getByText("3")).toHaveClass("rounded-lg", "bg-[#f2f5fb]", "text-[#17213a]/55");
  });
});
