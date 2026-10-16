import { afterEach, describe, expect, it, vi } from "vitest";
import { toJpeg } from "html-to-image";
import { renderCarouselImage } from "./content-carousel-export";

vi.mock("html-to-image", () => ({ toJpeg: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe("carousel export background fidelity", () => {
  it.each([
    ["cover", "#17213a", "rgb(23, 33, 58)"],
    ["body", "#f7f4ed", "rgb(247, 244, 237)"],
  ])("preserves the rendered %s background", async (_kind, color, expected) => {
    const node = document.createElement("div");
    node.style.backgroundColor = color;
    document.body.appendChild(node);
    const blob = new Blob(["jpeg"], { type: "image/jpeg" });
    vi.mocked(toJpeg).mockResolvedValue("data:image/jpeg;base64,AA==");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: async () => blob }));
    try {
      expect(await renderCarouselImage(node)).toBe(blob);
      expect(toJpeg).toHaveBeenLastCalledWith(
        node,
        expect.objectContaining({ backgroundColor: expected }),
      );
    } finally {
      node.remove();
    }
  });
});
