import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ContentCarouselDraft } from "./ContentCarouselDraft";
import { exportCarouselSlides } from "@/lib/content-carousel-export";
import { carouselCopyIssues, carouselReady } from "@/lib/content-carousel";
const slides = [
  { heading: "Start here", body: "A clear promise." },
  { heading: "Try this", body: "One concrete action." },
];
describe("static carousel", () => {
  it("keeps cover and final slide order and editable copy", () => {
    render(<ContentCarouselDraft slides={slides} onChange={vi.fn()} editing />);
    expect(
      screen.getAllByLabelText(/Slide \d+ heading/).map((el) => (el as HTMLInputElement).value),
    ).toEqual(["Start here", "Try this"]);
  });
  it("keeps historical long copy readable but blocks export with guidance", () => {
    expect(carouselCopyIssues([{ ...slides[0], body: "x".repeat(1500) }, slides[1]])[0]).toMatch(
      /Shorten slide 1/,
    );
  });
  it("matches a numbered cover promise to the actual body points", () => {
    expect(
      carouselCopyIssues([
        { heading: "3 ways to improve a reply", body: "Try these." },
        ...slides,
        slides[1],
      ]),
    ).toContainEqual(
      expect.stringContaining("cover promises 3 points but there are 2 body slides"),
    );
    expect(
      carouselCopyIssues([
        { heading: "Two ways to improve a reply", body: "Try these." },
        ...slides,
        slides[1],
      ]),
    ).toEqual([]);
  });
  it("rejects empty, partial and stale exports", () => {
    expect(carouselReady(slides, { revision: 1, exportRevision: 1, mediaIds: [] })).toBe(false);
    expect(carouselReady(slides, { revision: 1, exportRevision: 1, mediaIds: ["a"] })).toBe(false);
    expect(carouselReady(slides, { revision: 2, exportRevision: 1, mediaIds: ["a", "b"] })).toBe(
      false,
    );
    expect(carouselReady(slides, { revision: 1, exportRevision: 1, mediaIds: ["a", "b"] })).toBe(
      true,
    );
  });
  it("retries failed export without uploading already completed slides", async () => {
    const nodes = [document.createElement("div"), document.createElement("div")];
    const cache = new Map<number, string>();
    const upload = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("second");
    const renderImage = vi.fn().mockResolvedValue(new Blob(["image"], { type: "image/jpeg" }));
    await expect(exportCarouselSlides(nodes, cache, { renderImage, upload })).rejects.toThrow(
      "offline",
    );
    expect(await exportCarouselSlides(nodes, cache, { renderImage, upload })).toEqual([
      "first",
      "second",
    ]);
    expect(upload).toHaveBeenCalledTimes(3);
  });
  it("surfaces export failure and allows retry", async () => {
    const onExport = vi
      .fn()
      .mockRejectedValueOnce(new Error("Try again"))
      .mockResolvedValue(undefined);
    render(<ContentCarouselDraft slides={slides} onExport={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: "Export images" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Export images" }));
    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(2));
  });
});
