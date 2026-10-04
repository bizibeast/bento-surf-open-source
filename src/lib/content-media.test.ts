import { describe, expect, it, vi } from "vitest";
import { contentMediaSources, relevantContentMedia, type ContentMediaAsset } from "./content-media";
import { downloadConnectedMedia, importedMediaType } from "./content-media.server";
const asset = (id: string, caption: string, tags: string[]): ContentMediaAsset => ({
  id,
  type: "image",
  url: `https://example.com/cdn/${id}.jpg`,
  title: caption,
  caption,
  tags,
  provider: "instagram",
  sourceUrl: null,
});
describe("connected media index", () => {
  it("retrieves topic-relevant assets and ignores unrelated photos", () => {
    const selected = relevantContentMedia("Write about my startup distribution", [
      asset("one", "Mumbai selling challenge", ["Startup hustle"]),
      asset("two", "A lunch photo", ["food"]),
    ]);
    expect(selected.map((media) => media.id)).toEqual(["one"]);
  });
  it("rejects private URLs and unsupported attachments at ingestion", () => {
    expect(
      contentMediaSources([{ id: "asset", type: "image", url: "https://127.0.0.1/private" }]),
    ).toEqual([]);
    expect(
      importedMediaType(new TextEncoder().encode("<script>bad</script>"), "image/jpeg"),
    ).toBeNull();
  });
  it("downloads approved provider media and refuses redirect escapes", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        headers: { "content-type": "image/jpeg" },
      }),
    );
    const image = await downloadConnectedMedia(
      "instagram",
      "https://scontent.cdninstagram.com/photo.jpg",
      1024,
      fetcher,
    );
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.bytes.byteLength).toBe(4);
    fetcher.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }),
    );
    await expect(
      downloadConnectedMedia(
        "instagram",
        "https://scontent.cdninstagram.com/photo.jpg",
        1024,
        fetcher,
      ),
    ).rejects.toThrow("approved provider asset");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
