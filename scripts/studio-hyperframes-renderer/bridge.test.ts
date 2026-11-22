// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { routeRendererRequest, rendererExecutionRequest } from "./bridge";
const token = "synthetic_renderer_token_1234567890123456789";
const request = (extra: Record<string, string> = {}, path = "/render") =>
  new Request(new URL(path, "https://renderer.example"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-bento-workspace-id": "11111111-1111-4111-8111-111111111111",
      "content-type": "multipart/form-data; boundary=fixture",
      ...extra,
    },
    body: "fixture",
  });
describe("private container bridge", () => {
  it("never gives the shared bridge credential to the renderer execution", async () => {
    const first = rendererExecutionRequest(request({ cookie: "private-session" }));
    const second = rendererExecutionRequest(request());
    expect(first.env.STUDIO_REEL_RENDERER_TOKEN).not.toBe(token);
    expect(first.env.STUDIO_REEL_RENDERER_TOKEN).not.toBe(second.env.STUDIO_REEL_RENDERER_TOKEN);
    expect(first.request.headers.get("authorization")).toBe(
      `Bearer ${first.env.STUDIO_REEL_RENDERER_TOKEN}`,
    );
    expect(first.request.headers.get("cookie")).toBeNull();
    expect(await first.request.text()).toBe("fixture");
  });
  it("does not start containers when disabled or unauthorized", async () => {
    const forward = vi.fn();
    expect(
      (await routeRendererRequest(request(), { enabled: "false", token }, forward)).status,
    ).toBe(503);
    expect(
      (
        await routeRendererRequest(
          request({ authorization: "Bearer wrong" }),
          { enabled: "true", token },
          forward,
        )
      ).status,
    ).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });
  it("rejects oversized and unscoped jobs before compute starts", async () => {
    const forward = vi.fn();
    expect(
      (
        await routeRendererRequest(
          request({ "content-length": String(25 * 1024 * 1024) }),
          { enabled: "true", token },
          forward,
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await routeRendererRequest(
          request({ "x-bento-workspace-id": "other" }),
          { enabled: "true", token },
          forward,
        )
      ).status,
    ).toBe(422);
    expect(forward).not.toHaveBeenCalled();
  });
  it("uses only two fixed slots and forwards no browser sessions", async () => {
    const forward = vi.fn(async (_slot, request: Request) => {
      expect(request.headers.get("cookie")).toBeNull();
      expect(await request.text()).toBe("fixture");
      return new Response("MP4");
    });
    await routeRendererRequest(
      request({ cookie: "session=must-not-forward" }),
      { enabled: "true", token },
      forward,
    );
    expect(forward.mock.calls[0][0]).toBe("render-slot-1");
    await routeRendererRequest(
      request({ "x-bento-workspace-id": "11111111-1111-4111-8111-111111111112" }),
      { enabled: "true", token },
      forward,
    );
    expect(forward.mock.calls[1][0]).toBe("render-slot-0");
  });
  it("authenticates and preserves /frames while using the existing slots", async () => {
    const forward = vi.fn(async (slot: string, forwarded: Request) => {
      expect(slot).toBe("render-slot-1");
      const execution = rendererExecutionRequest(forwarded);
      expect(new URL(execution.request.url).pathname).toBe("/frames");
      expect(execution.request.headers.get("authorization")).not.toBe(`Bearer ${token}`);
      expect(await execution.request.text()).toBe("fixture");
      return new Response("{}");
    });
    const configuration = { enabled: "true", token };
    expect(
      (
        await routeRendererRequest(
          request({ authorization: "" }, "/frames"),
          configuration,
          forward,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await routeRendererRequest(
          request({ "content-length": String(25 * 1024 * 1024) }, "/frames"),
          configuration,
          forward,
        )
      ).status,
    ).toBe(413);
    expect(
      (await routeRendererRequest(request({}, "/frames/other"), configuration, forward)).status,
    ).toBe(404);
    expect(forward).not.toHaveBeenCalled();
    expect(
      (await routeRendererRequest(request({}, "/frames"), configuration, forward)).status,
    ).toBe(200);
  });
});
