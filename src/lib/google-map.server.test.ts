import { describe, expect, it } from "vitest";
import { handleGoogleMapEmbedRequest } from "./google-map.server";

const origins = {
  VITE_APP_URL: "https://app.self.example",
  VITE_PUBLIC_URL: "https://public.self.example",
};
const mapEnv = { ...origins, GOOGLE_MAPS_BROWSER_KEY: "restricted-browser-key" };

function request(referer = "https://app.self.example/link") {
  return new Request("https://app.self.example/api/maps/embed?lat=19.076&lng=72.8777&zoom=12", {
    headers: { referer },
  });
}

describe("Google map embed boundary", () => {
  it("trusts only exact configured app and public origins before custom-domain lookup", async () => {
    const env = {
      GOOGLE_MAPS_BROWSER_KEY: "restricted-browser-key",
      VITE_APP_URL: "https://app.self.example",
      VITE_PUBLIC_URL: "https://public.self.example",
    };
    const dependencies = { isActiveCustomDomain: async () => false };

    for (const parent of [
      "https://app.self.example/link",
      "https://public.self.example/@creator",
    ]) {
      const response = await handleGoogleMapEmbedRequest(request(parent), env, dependencies);
      expect(response?.status).toBe(200);
    }
    const rejected = await handleGoogleMapEmbedRequest(
      request("https://unrelated.self.example/link"),
      env,
      dependencies,
    );
    expect(rejected?.status).toBe(403);
  });

  it("serves a control-free lazy map only to Bento surfaces", async () => {
    const response = await handleGoogleMapEmbedRequest(request(), mapEnv);
    expect(response?.status).toBe(200);
    const html = await response!.text();
    expect(html).toContain("maps.googleapis.com/maps/api/js");
    expect(html).toContain("disableDefaultUI:true");
    expect(html).toContain('gestureHandling:config.interactive?"greedy":"none"');
    expect(response?.headers.get("content-security-policy")).toContain("https://app.self.example");
  });

  it("accepts an active custom domain and rejects untrusted embeds", async () => {
    const active = await handleGoogleMapEmbedRequest(
      request("https://creator.example/profile"),
      mapEnv,
      { isActiveCustomDomain: async (hostname) => hostname === "creator.example" },
    );
    expect(active?.status).toBe(200);

    const rejected = await handleGoogleMapEmbedRequest(
      request("https://attacker.example/"),
      mapEnv,
      { isActiveCustomDomain: async () => false },
    );
    expect(rejected?.status).toBe(403);
  });

  it("does not expose an embed when configuration or view data is invalid", async () => {
    const missingKey = await handleGoogleMapEmbedRequest(request(), origins);
    expect(missingKey?.status).toBe(503);
    const badView = await handleGoogleMapEmbedRequest(
      new Request("https://app.self.example/api/maps/embed?lat=999&lng=0&zoom=12", {
        headers: { referer: "https://app.self.example/link" },
      }),
      mapEnv,
    );
    expect(badView?.status).toBe(400);
  });
});
