import { afterEach, expect, it, vi } from "vitest";
import { appOriginForPublicHost, redirectPublicHostToAppHost } from "./app-host-handoff";
afterEach(() => vi.unstubAllEnvs());
it("hands off only the configured public host while preserving the full path", () => {
  vi.stubEnv("VITE_APP_URL", "https://app.example.com");
  vi.stubEnv("VITE_PUBLIC_URL", "https://example.com");
  const replace = vi.fn();
  expect(
    redirectPublicHostToAppHost(
      {
        hostname: "example.com",
        pathname: "/signup",
        search: "?redirect=%2Flink",
        hash: "#account",
      },
      replace,
    ),
  ).toBe(true);
  expect(replace).toHaveBeenCalledWith("https://app.example.com/signup?redirect=%2Flink#account");
  expect(appOriginForPublicHost("attacker.example")).toBeNull();
  expect(appOriginForPublicHost("app.example.com")).toBeNull();
});
it("keeps a single-origin or unconfigured installation on its own origin", () => {
  vi.stubEnv("VITE_APP_URL", "http://localhost:8080");
  vi.stubEnv("VITE_PUBLIC_URL", "http://localhost:8080");
  const replace = vi.fn();
  expect(
    redirectPublicHostToAppHost(
      { hostname: "localhost", pathname: "/login", search: "", hash: "" },
      replace,
    ),
  ).toBe(false);
  expect(replace).not.toHaveBeenCalled();
});
