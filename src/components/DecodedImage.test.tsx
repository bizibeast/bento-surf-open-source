import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecodedImage } from "./DecodedImage";

describe("DecodedImage", () => {
  afterEach(() => cleanup());

  it("reveals an image only after its complete frame has decoded", async () => {
    let resolveDecode: (() => void) | undefined;
    const decodeComplete = new Promise<void>((resolve) => {
      resolveDecode = resolve;
    });
    const observedTargets: Array<EventTarget | null> = [];
    const onLoad = vi.fn((event) => observedTargets.push(event.currentTarget));
    const { getByAltText } = render(
      <DecodedImage src="https://cdn.bento.surf/avatar.jpg" alt="Creator" onLoad={onLoad} />,
    );
    const image = getByAltText("Creator") as HTMLImageElement;
    image.decode = vi.fn(() => decodeComplete);

    expect(image).toHaveClass("opacity-0");
    fireEvent.load(image);

    expect(onLoad).toHaveBeenCalledOnce();
    expect(observedTargets).toEqual([image]);
    expect(image).toHaveClass("opacity-0");

    resolveDecode?.();
    await waitFor(() => expect(image).toHaveClass("opacity-100"));
    expect(image.decode).toHaveBeenCalledOnce();
  });

  it("hides a previous frame when the source changes", async () => {
    const { getByAltText, rerender } = render(
      <DecodedImage src="https://cdn.bento.surf/first.jpg" alt="Preview" />,
    );
    const image = getByAltText("Preview") as HTMLImageElement;
    image.decode = vi.fn().mockResolvedValue(undefined);
    fireEvent.load(image);
    await waitFor(() => expect(image).toHaveClass("opacity-100"));

    rerender(<DecodedImage src="https://cdn.bento.surf/second.jpg" alt="Preview" />);
    await waitFor(() => expect(getByAltText("Preview")).toHaveClass("opacity-0"));
  });

  it("reveals an image that completed before the load handler attached", async () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    const naturalWidth = vi
      .spyOn(HTMLImageElement.prototype, "naturalWidth", "get")
      .mockReturnValue(512);
    const originalDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = vi.fn().mockResolvedValue(undefined);

    const { getByAltText } = render(
      <DecodedImage src="https://cdn.bento.surf/cached.jpg" alt="Cached" />,
    );

    await waitFor(() => expect(getByAltText("Cached")).toHaveClass("opacity-100"));
    complete.mockRestore();
    naturalWidth.mockRestore();
    HTMLImageElement.prototype.decode = originalDecode;
  });
});
