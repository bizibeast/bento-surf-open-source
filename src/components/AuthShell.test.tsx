import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AuthBrand, AuthShell } from "./AuthShell";
it("links the auth logo home by default for signup and login", () => {
  render(<AuthBrand />);
  expect(screen.getByRole("link", { name: "bento.surf home" }).getAttribute("href")).toBeTruthy();
});
it("renders the same logo without an exit during onboarding", () => {
  const { container } = render(<AuthBrand linked={false} />);
  expect(container.querySelector("a")).toBeNull();
  expect(container.querySelector("img")).not.toBeNull();
});

it("protects signup content from translation DOM mutations when requested", () => {
  const { container } = render(
    <AuthShell translate="no">
      <p>Create account</p>
    </AuthShell>,
  );
  expect(container.querySelector("main")?.getAttribute("translate")).toBe("no");
  expect(container.querySelector("main")?.classList.contains("notranslate")).toBe(true);
});
