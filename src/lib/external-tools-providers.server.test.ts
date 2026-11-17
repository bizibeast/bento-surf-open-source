import { describe, expect, it, vi } from "vitest";
import { createGithubGateway } from "./github-gateway.server";
import { createHeyGenClient, validatedHeyGenAssetUrl } from "./heygen.server";
import { heyGenEstimateRenderSeconds, heyGenGenerationInput } from "./external-tools";

const avatar = {
  id: "look_1",
  name: "Studio",
  avatar_type: "studio_avatar",
  supported_api_engines: ["avatar_iv"],
  status: "completed",
};
const voice = { voice_id: "voice_1", name: "Narrator", status: "ACTIVE" };
const rpc = (id: number, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });

describe("HeyGen provider adapter", () => {
  it("verifies scoped credentials and filters the account catalogs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            status: "active",
            scope_mode: "custom",
            scopes: ["avatars:read", "voices:read", "videos:write"],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [avatar, { ...avatar, id: "unfinished", status: "pending" }],
          next_token: "page2",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [voice, { ...voice, voice_id: "pending", status: "PENDING" }],
        }),
      );
    const client = createHeyGenClient("fixture-key", fetcher);
    await client.verifyCredential();
    expect(await client.avatars({ scope: "private" })).toMatchObject({
      avatars: [{ id: "look_1", estimatedUsdPerMinute: 4.83 }],
      nextToken: "page2",
    });
    expect(await client.voices({ scope: "public" })).toEqual({
      voices: [{ id: "voice_1", name: "Narrator", language: null }],
      nextToken: null,
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.heygen.com/v3/api_keys/self",
      "https://api.heygen.com/v3/avatars/looks?ownership=private&limit=20",
      "https://api.heygen.com/v3/models/audio/voices?type=public&limit=20",
    ]);
  });

  it.each([
    { status: "active", scope_mode: "full", scopes: ["*:*"] },
    { status: "active", scope_mode: "read_only", scopes: ["*:read"] },
    {
      status: "active",
      scope_mode: "custom",
      scopes: ["avatars:read", "voices:read", "videos:read"],
    },
    {
      status: "expired",
      scope_mode: "custom",
      scopes: ["avatars:read", "voices:read", "videos:write"],
    },
  ])("rejects unsuitable key metadata (%j)", async (metadata) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: metadata }));
    await expect(createHeyGenClient("fixture-key", fetcher).verifyCredential()).rejects.toThrow(
      "Use an active scoped HeyGen key",
    );
  });

  it("submits with durable idempotency and never retries a billable request automatically", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 502 }));
    await expect(
      createHeyGenClient("fixture-key", fetcher).submit({
        jobId: "job_1",
        avatarId: "look_1",
        voiceId: "voice_1",
        script: "Hello",
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://api.heygen.com/v3/videos");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "idempotency-key": "job_1", "x-api-key": "fixture-key" },
      redirect: "error",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      type: "avatar",
      avatar_id: "look_1",
      voice_id: "voice_1",
      script: "Hello",
      engine: { type: "avatar_iv" },
      aspect_ratio: "9:16",
      resolution: "720p",
    });
  });

  it("bounds transient read retry and restricts remote URLs and approval input", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            id: "video_1",
            status: "completed",
            duration: 8.5,
            video_url: "https://files.heygen.ai/clip.mp4",
          },
        }),
      );
    const result = await createHeyGenClient("fixture-key", fetcher).status("video_1");
    expect(result.duration).toBe(8.5);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(validatedHeyGenAssetUrl(result.video_url)?.hostname).toBe("files.heygen.ai");
    expect(validatedHeyGenAssetUrl("https://files.heygen.ai.example.invalid/clip.mp4")).toBeNull();
    expect(validatedHeyGenAssetUrl("https://user@files.heygen.ai/clip.mp4")).toBeNull();
    expect(
      heyGenGenerationInput.safeParse({
        avatarId: "look_1",
        voiceId: "voice_1",
        script: "hello",
        requestedSeconds: 2,
        requestKey: "21c51bd7-a146-4cc8-aba7-a97b268af681",
        approved: true,
      }).success,
    ).toBe(false);
    expect(
      heyGenGenerationInput.safeParse({
        avatarId: "look_1",
        voiceId: "voice_1",
        script: 'hello <break time="600s"/>',
        requestedSeconds: 2,
        requestKey: "21c51bd7-a146-4cc8-aba7-a97b268af681",
      }).success,
    ).toBe(false);
    expect(heyGenEstimateRenderSeconds(1, "A good example script".repeat(8))).toBeGreaterThan(1);
  });
});

describe("GitHub MCP gateway", () => {
  it("calls a read-only pull request tool and returns only its metadata", async () => {
    const request = {
      number: 17,
      title: "Release metadata",
      state: "open",
      draft: true,
      body: "Excluded",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rpc(1, {}))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        rpc(2, {
          tools: [
            {
              name: "get_me",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
            {
              name: "pull_request_read",
              inputSchema: {
                type: "object",
                required: ["owner", "repo", "pullNumber", "method"],
                properties: { owner: {}, repo: {}, pullNumber: {}, method: {} },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(rpc(3, { structuredContent: { pull_request: request } }));
    await expect(
      createGithubGateway("github_pat_fixture", fetcher, true).pullRequest({
        repository: "BiziBeast/Bento-Surf",
        number: 17,
      }),
    ).resolves.toEqual({
      number: 17,
      title: "Release metadata",
      state: "open",
      draft: true,
      url: "https://github.com/bizibeast/bento-surf/pull/17",
    });
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body)).params).toEqual({
      name: "pull_request_read",
      arguments: { method: "get", owner: "bizibeast", repo: "bento-surf", pullNumber: 17 },
    });
    expect(new Headers(fetcher.mock.calls[3][1]?.headers).get("X-MCP-Toolsets")).toBe(
      "context,pull_requests",
    );
  });

  it("discovers the allowlisted tool and strips unrelated GitHub profile data", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rpc(1, { protocolVersion: "2025-06-18" }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        rpc(2, {
          tools: [
            {
              name: "get_me",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
            { name: "delete_repository", inputSchema: { type: "object" } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        rpc(3, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                login: "fixture-account",
                email: "private@example.invalid",
              }),
            },
          ],
        }),
      );
    await expect(createGithubGateway("github_pat_fixture", fetcher).account()).resolves.toEqual({
      login: "fixture-account",
    });
    expect(
      fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).method),
    ).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe("https://api.githubcopilot.com/mcp/");
      const headers = new Headers(options?.headers);
      expect(headers.get("x-mcp-readonly")).toBe("true");
      expect(headers.get("authorization")).toBe("Bearer github_pat_fixture");
      expect(options?.redirect).toBe("error");
    }
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body)).params).toEqual({
      name: "get_me",
      arguments: {},
    });
  });

  it("rejects an incompatible discovered tool and does not forward Bento credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rpc(1, {}))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        rpc(2, {
          tools: [
            {
              name: "get_me",
              inputSchema: {
                type: "object",
                required: ["unexpected"],
              },
            },
          ],
        }),
      );
    await expect(createGithubGateway("github_pat_fixture", fetcher).account()).rejects.toThrow(
      /compatible read-only/,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(() => createGithubGateway("bento-oauth-token", fetcher)).toThrow(/fine-grained/);
  });
});
