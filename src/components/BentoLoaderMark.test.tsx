import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BentoLoaderMark } from "./BentoLoaderMark";

describe("BentoLoaderMark", () => {
  afterEach(() => cleanup());

  it("renders the official brand paths at a bounded size", () => {
    const { getByTestId } = render(<BentoLoaderMark animated={false} />);
    const svg = getByTestId("bento-loader-mark");

    expect(svg.querySelector('[data-card="red"]')).toHaveAttribute("fill", "#FC514E");
    expect(svg.querySelector('[data-card="yellow"]')).toHaveAttribute("fill", "#FDC307");
    expect(svg.querySelector('[data-card="blue"]')).toHaveAttribute("fill", "#2581FA");
    expect(svg.querySelector(".bento-loader-card")).toBeNull();
    expect(svg.getAttribute("width")).toBe("70");
    expect(svg.getAttribute("height")).toBe("62");
  });

  it("loops the grid rearrange with CSS after mount so hydration stays static", async () => {
    const { getByTestId } = render(<BentoLoaderMark />);
    const svg = getByTestId("bento-loader-mark");

    expect(svg).toHaveAttribute("data-animated", "true");
    expect(svg.querySelector("animateTransform")).toBeNull();

    await waitFor(() => {
      expect(svg.querySelector(".bento-loader-card-red")).not.toBeNull();
    });
    expect(svg.querySelector(".bento-loader-card-yellow")).not.toBeNull();
    expect(svg.querySelector(".bento-loader-card-blue")).not.toBeNull();
  });
});
