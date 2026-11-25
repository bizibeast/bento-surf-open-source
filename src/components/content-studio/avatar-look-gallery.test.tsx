import { fireEvent, render, screen } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import { AvatarLookGallery } from "./avatar-look-gallery";

it("shows preview faces, retains the selection and makes no generation request", () => {
  const onSelect = vi.fn();
  const looks = [
    { id: "one", name: "First", previewImageUrl: "https://cdn.example.com/one.jpg" },
    { id: "two", name: "Second", previewImageUrl: null },
  ];
  const { rerender } = render(
    <AvatarLookGallery looks={looks} selectedId="one" onSelect={onSelect} />,
  );
  expect(screen.getByRole("img", { name: "First avatar preview" })).toHaveAttribute(
    "src",
    looks[0].previewImageUrl,
  );
  expect(screen.getByRole("button", { name: "Use First" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Use First" }));
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use Second" }));
  expect(onSelect).toHaveBeenCalledWith("two");
  rerender(<AvatarLookGallery looks={looks} selectedId="one" onSelect={onSelect} disabled />);
  expect(screen.getByRole("button", { name: "Use Second" })).toBeDisabled();
});
it("recovers from a broken preview without inventing a face", () => {
  render(
    <AvatarLookGallery
      looks={[{ id: "one", name: "First", previewImageUrl: "https://cdn.example.com/missing.jpg" }]}
      selectedId="one"
      onSelect={vi.fn()}
    />,
  );
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText("Preview unavailable")).toBeVisible();
  expect(screen.getByText("Selected presenter")).toBeVisible();
});
