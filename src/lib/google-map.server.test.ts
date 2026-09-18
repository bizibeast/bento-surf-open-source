import { describe, expect, it } from "vitest";
import { handleGoogleMapEmbedRequest } from "./google-map.server";

function request(referer = "http://localhost:8080/link") {
  return new Request("http://localhost:8080/api/maps/embed?lat=19.076&lng=72.8777&zoom=12", {
    headers: { referer },
  });
}

describe("Google map embed boundary", () => {
  it("serves a control-free lazy map only to Bento surfaces", async () => {
    const response = await handleGoogleMapEmbedRequest(request(), {
      GOOGLE_MAPS_BROWSER_KEY: "restricted-browser-key",
    });
    expect(response?.status).toBe(200);
    const html = await response!.text();
    expect(html).toContain("maps.googleapis.com/maps/api/js");
    expect(html).toContain("disableDefaultUI:true");
    expect(html).toContain('gestureHandling:config.interactive?"greedy":"none"');
    expect(response?.headers.get("content-security-policy")).toContain("http://localhost:8080");
  });

  it("accepts an active custom domain and rejects untrusted embeds", async () => {
    const active = await handleGoogleMapEmbedRequest(
      request("https://creator.example/profile"),
      { GOOGLE_MAPS_BROWSER_KEY: "restricted-browser-key" },
      { isActiveCustomDomain: async (hostname) => hostname === "creator.example" },
    );
    expect(active?.status).toBe(200);

    const rejected = await handleGoogleMapEmbedRequest(
      request("https://attacker.example/"),
      { GOOGLE_MAPS_BROWSER_KEY: "restricted-browser-key" },
      { isActiveCustomDomain: async () => false },
    );
    expect(rejected?.status).toBe(403);
  });

  it("does not expose an embed when configuration or view data is invalid", async () => {
    const missingKey = await handleGoogleMapEmbedRequest(request(), {});
    expect(missingKey?.status).toBe(503);
    const badView = await handleGoogleMapEmbedRequest(
      new Request("http://localhost:8080/api/maps/embed?lat=999&lng=0&zoom=12", {
        headers: { referer: "http://localhost:8080/link" },
      }),
      { GOOGLE_MAPS_BROWSER_KEY: "restricted-browser-key" },
    );
    expect(badView?.status).toBe(400);
  });
});
