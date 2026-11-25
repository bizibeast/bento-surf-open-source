import { it, expect, vi } from "vitest";
import worker from "./media-resolver.worker-core";
const token = "private-resolver-service-secret-long-enough";
const request = (url = "https://youtu.be/jNQXAC9IVRw", authorized = true) =>
  new Request("https://media.test.bento.surf/post-stats", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: `Api-Key ${token}` } : {}),
    },
    body: JSON.stringify({ url }),
  });
it("requires the existing service credential before calling metadata compute", async () => {
  const fetcher = vi.fn();
  const env = {
    RESOLVER_SHARED_SECRET: token,
    BASIC_MEDIA_TOKEN: "private-only",
    BASIC_MEDIA_RESOLVER: { fetch: fetcher },
  };
  expect((await worker.fetch(request(undefined, false), env)).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await worker.fetch(request("https://127.0.0.1/private"), env)).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it("returns metadata through the same private service binding as downloads", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      platform: "youtube",
      id: "jNQXAC9IVRw",
      counts: { views: 100, likes: 4, comments: 2 },
    }),
  );
  const response = await worker.fetch(request(), {
    RESOLVER_SHARED_SECRET: token,
    BASIC_MEDIA_TOKEN: "private-only",
    BASIC_MEDIA_RESOLVER: { fetch: fetcher },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ counts: { views: 100, likes: 4, comments: 2 } });
  expect(fetcher).toHaveBeenCalledOnce();
});
