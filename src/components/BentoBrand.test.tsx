import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  BENTO_FULL_LOGO_SRC,
  BENTO_ICON_SRC,
  BentoBrand,
  BentoFullLogo,
  BentoIcon,
} from "./BentoBrand";

describe("BentoBrand", () => {
  it("uses the canonical full logo and icon assets", () => {
    const { container } = render(
      <>
        <BentoFullLogo />
        <BentoIcon />
        <BentoBrand />
      </>,
    );

    expect(screen.getByAltText("bento.surf")).toHaveAttribute("src", BENTO_FULL_LOGO_SRC);
    expect(container.querySelectorAll(`img[src="${BENTO_ICON_SRC}"]`)).toHaveLength(2);
    expect(screen.getByText("bento.surf")).toBeInTheDocument();
  });
});
