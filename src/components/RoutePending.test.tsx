import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RoutePending } from "./RoutePending";

describe("RoutePending", () => {
  afterEach(() => document.body.replaceChildren());

  it("shows a silent branded mark instead of loading copy", () => {
    render(<RoutePending />);

    const status = screen.getByRole("status", { name: "Loading" });
    expect(status).toHaveTextContent("");
    expect(status.querySelector('[data-testid="bento-loader-mark"]')).not.toBeNull();
  });
});
