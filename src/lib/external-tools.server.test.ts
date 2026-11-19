import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveHeyGenJob,
  handleHeyGenAssetRequest,
  prepareHeyGenJob,
  readHeyGenJob,
  readGithubPullRequest,
  startHeyGenJob,
} from "./external-tools.server";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  reserve: vi.fn(),
  pullRequest: vi.fn(),
  submit: vi.fn(),
  selection: vi.fn(),
  decrypt: vi.fn(),
  workspace: vi.fn(),
  bucket: { head: vi.fn(), get: vi.fn() },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async (_name: string, input: { p_action: string }) => state.reserve(input),
    from(name: string) {
      const filters: Record<string, unknown> = {};
      let write: Record<string, unknown> | undefined;
      let insert: Record<string, unknown> | undefined;
      async function run() {
        const rows = (state.rows[name] ??= []);
        if (insert) {
          const row = {
            id: "1d8a6d2f-5f74-4aa3-93d9-a4c7000a8ada",
            status: "awaiting_approval",
            created_at: new Date().toISOString(),
            ...insert,
          };
          rows.push(row);
          return { data: { ...row }, error: null };
        }
        const row = rows.find((candidate) =>
          Object.entries(filters).every(([column, value]) => candidate[column] === value),
        );
        if (row && write) Object.assign(row, write);
        return { data: row ? { ...row } : null, error: null };
      }
      const query = {
        select: () => query,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return query;
        },
        is(column: string, value: unknown) {
          filters[column] = value;
          return query;
        },
        update(fields: Record<string, unknown>) {
          write = fields;
          return query;
        },
        insert(fields: Record<string, unknown>) {
          insert = fields;
          return query;
        },
        maybeSingle: run,
        single: run,
        then: (done: (result: unknown) => unknown) => run().then(done),
      };
      return query;
    },
  },
}));

vi.mock("./secret-crypto.server", () => ({
  isServerSecretEncryptionKeyValid: () => true,
  decryptServerSecret: state.decrypt,
  encryptServerSecret: async () => "encrypted-fixture",
}));
vi.mock("./workspace-session.server", () => ({ resolveWorkspace: state.workspace }));
vi.mock("./r2-storage.server", () => ({ getMediaBucket: () => state.bucket }));
vi.mock("./heygen.server", () => ({
  createHeyGenClient: () => ({ selection: state.selection, submit: state.submit }),
  HeyGenRequestError: Error,
  validatedHeyGenAssetUrl: vi.fn(),
}));
vi.mock("./github-gateway.server", () => ({
  createGithubGateway: () => ({ pullRequest: state.pullRequest }),
}));

const actor = {
  workspaceId: "974a76fd-a418-4cc5-9f77-765d36ee6d3b",
  authUserId: "928c714b-7601-411c-a830-805223e7006d",
  clientId: "fixture-claude-client",
};
const browser = { ...actor, clientId: "bento-browser" };
const input = {
  requestKey: "de1a68b3-83be-4a04-a878-f0f1c1327d6e",
  avatarId: "avatar_owned",
  voiceId: "voice_owned",
  script: "An approved script.",
  requestedSeconds: 4,
};

beforeEach(() => {
  vi.stubEnv("BENTO_EXTERNAL_TOOLS_ENABLED", "true");
  state.rows = {
    external_tool_connections: [
      {
        id: "b0e2cf61-ac41-41a6-8f6a-e4956163bdd3",
        workspace_id: actor.workspaceId,
        auth_user_id: actor.authUserId,
        provider: "heygen",
        credential_encrypted: "encrypted-fixture",
        revision: "fixture-revision",
        revoked_at: null,
      },
    ],
  };
  state.reserve.mockReset().mockResolvedValue({ data: "audit-id", error: null });
  state.pullRequest.mockReset();
  state.decrypt.mockReset().mockResolvedValue("fixture-user-credential");
  state.workspace
    .mockReset()
    .mockResolvedValue({ workspaceId: actor.workspaceId, workspace: { status: "active" } });
  state.bucket.get.mockReset();
  state.bucket.head.mockReset();
  state.selection.mockReset().mockResolvedValue({
    avatar: { id: input.avatarId, name: "Approved look", estimatedUsdPerMinute: 4.83 },
    voice: { id: input.voiceId, name: "Approved voice" },
  });
  state.submit.mockReset().mockResolvedValue("provider-video-id");
});

it("only delegates GitHub pull request reads for the approved repository and current grant", async () => {
  const connection = {
    workspace_id: actor.workspaceId,
    auth_user_id: actor.authUserId,
    provider: "github_mcp",
    credential_encrypted: "encrypted-fixture",
    revision: "fixture-revision",
    revoked_at: null,
    capabilities: ["get_me", "pull_request_read:bizibeast/bento-surf"],
  };
  state.rows.external_tool_connections.push(connection);
  const input = { repository: "bizibeast/bento-surf", number: 352 };
  state.pullRequest.mockResolvedValue({ number: 352, title: "Bento V2" });
  await expect(
    readGithubPullRequest(actor, { ...input, repository: "bizibeast/other" }),
  ).rejects.toThrow("Allow this repository");
  await expect(
    readGithubPullRequest({ ...actor, workspaceId: "other-workspace" }, input),
  ).rejects.toThrow("Connect this provider");
  expect(state.pullRequest).not.toHaveBeenCalled();
  await expect(readGithubPullRequest(actor, input)).resolves.toEqual({
    number: 352,
    title: "Bento V2",
  });
  state.pullRequest.mockImplementationOnce(async () => {
    connection.revision = "changed";
    return { number: 352 };
  });
  await expect(readGithubPullRequest(actor, input)).rejects.toThrow("connection changed");
});

describe("HeyGen generation approval and tenant boundary", () => {
  it("requires browser approval for an immutable request and submits concurrently at most once", async () => {
    const job = await prepareHeyGenJob(actor, input);
    expect(job).toMatchObject({
      status: "awaiting_approval",
      approvalPath: `/mcp?heygenJob=${job.jobId}&heygenWorkspace=${actor.workspaceId}`,
    });
    await expect(startHeyGenJob(actor, job.jobId)).rejects.toThrow(/approve/);
    await expect(approveHeyGenJob(actor, job.jobId)).rejects.toThrow(/in Bento/);
    await expect(
      prepareHeyGenJob(actor, { ...input, script: "Different script." }),
    ).rejects.toThrow(/new request key/);
    expect(state.submit).not.toHaveBeenCalled();
    expect((await approveHeyGenJob(browser, job.jobId)).status).toBe("approved");
    await Promise.all([startHeyGenJob(actor, job.jobId), startHeyGenJob(actor, job.jobId)]);
    expect(state.submit).toHaveBeenCalledOnce();
    expect(state.submit).toHaveBeenCalledWith({
      jobId: job.jobId,
      avatarId: input.avatarId,
      voiceId: input.voiceId,
      script: input.script,
    });
    expect(await readHeyGenJob(actor, job.jobId)).toMatchObject({ status: "queued" });
  });

  it("rejects another tenant, MCP client, a denied reservation and a revoked credential", async () => {
    const job = await prepareHeyGenJob(actor, input);
    await expect(
      readHeyGenJob({ ...actor, clientId: "other-mcp-client" }, job.jobId),
    ).rejects.toThrow(/unavailable/);
    await expect(
      readHeyGenJob({ ...actor, workspaceId: "other-workspace" }, job.jobId),
    ).rejects.toThrow(/unavailable/);
    await expect(readHeyGenJob({ ...actor, authUserId: "other-user" }, job.jobId)).rejects.toThrow(
      /unavailable/,
    );
    await approveHeyGenJob(browser, job.jobId);
    state.reserve.mockResolvedValueOnce({ data: null, error: null });
    await expect(startHeyGenJob(actor, job.jobId)).rejects.toThrow(/usage limit/);
    state.rows.external_tool_connections[0].revision = "rotated-revision";
    await expect(startHeyGenJob(actor, job.jobId)).rejects.toThrow(/connect/i);
    expect(await readHeyGenJob(actor, job.jobId)).toMatchObject({ status: "revoked" });
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("keeps unconfirmed provider submissions from being charged again", async () => {
    const job = await prepareHeyGenJob(actor, input);
    await approveHeyGenJob(browser, job.jobId);
    state.submit.mockRejectedValueOnce(new Error("Network failure"));
    await expect(startHeyGenJob(actor, job.jobId)).rejects.toThrow(/Network failure/);
    expect(await startHeyGenJob(actor, job.jobId)).toMatchObject({ status: "submission_unknown" });
    expect(state.submit).toHaveBeenCalledOnce();
  });
});

it("streams a private range for a valid grant and denies access when workspace access is gone", async () => {
  const job = await prepareHeyGenJob(actor, input);
  const key = `private/users/${actor.workspaceId}/heygen/${job.jobId}.mp4`;
  Object.assign(state.rows.heygen_generation_jobs[0], { status: "ready", asset_key: key });
  const asset = await readHeyGenJob(actor, job.jobId);
  expect(asset.assetUrl).toBe("/api/external-tools/heygen/asset?grant=encrypted-fixture");
  state.decrypt.mockResolvedValue(
    JSON.stringify({
      jobId: job.jobId,
      workspaceId: actor.workspaceId,
      authUserId: actor.authUserId,
      expiresAt: Date.now() + 1000,
    }),
  );
  state.bucket.head.mockResolvedValue({ size: 200 });
  state.bucket.get.mockImplementation(async () => ({ body: new Response("video").body }));
  const target = new URL(asset.assetUrl!, "https://app.bento.surf");
  const withRange = await handleHeyGenAssetRequest(
    new Request(target, { headers: { range: "bytes=0-4" } }),
  );
  expect(withRange.status).toBe(206);
  expect(withRange.headers.get("cache-control")).toBe("private, no-store");
  expect(withRange.headers.get("content-range")).toBe("bytes 0-4/200");
  expect(await withRange.text()).toBe("video");
  expect(state.bucket.get).toHaveBeenCalledExactlyOnceWith(key, {
    range: { offset: 0, length: 5 },
  });
  state.workspace.mockResolvedValue({ workspaceId: "other", workspace: { status: "active" } });
  expect((await handleHeyGenAssetRequest(new Request(target))).status).toBe(404);
  expect(state.bucket.get).toHaveBeenCalledOnce();
});
