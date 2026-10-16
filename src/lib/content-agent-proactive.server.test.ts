vi.mock("./content-access.server", () => ({
  requireContentWorkspace: vi.fn().mockResolvedValue(undefined),
}));
const rollout = vi.hoisted(() => ({ enabled: true }));
vi.mock("./content-agent-config.server", () => ({
  proactiveDeliveryAvailable: () => rollout.enabled,
  proactiveWorkspaceIds: () => (rollout.enabled ? ["owner"] : []),
}));
import { describe, expect, it, vi } from "vitest";
import {
  contentSignalFingerprint,
  processDueContentAgentSignals,
  type ProactiveDependencies,
} from "./content-agent-proactive.server";

const signal = {
  id: "signal",
  user_id: "owner",
  kind: "fresh_source" as const,
  source_ids: ["x:123"],
  observed_at: new Date().toISOString(),
  lease_key: "lease",
  attempts: 1,
};
const payload = {
  action: "draft",
  message: "One useful draft",
  cards: [{ type: "draft", cardId: "draft", body: "Editable copy" }],
  proactive: { whyNow: "A new original source", signalId: signal.id },
};
function dependencies() {
  return {
    claim: vi.fn().mockResolvedValue([signal]),
    authorize: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn().mockResolvedValue(payload),
    finish: vi.fn().mockResolvedValue("message"),
    release: vi.fn().mockResolvedValue(undefined),
  } as unknown as ProactiveDependencies;
}
describe("proactive worker", () => {
  it("deduplicates repeated refreshes by original source, including URL aliases", async () => {
    expect(
      await contentSignalFingerprint({
        kind: "fresh_source",
        sourceIds: ["https://twitter.com/a/status/123?utm_source=x"],
        observedAt: "2026-10-12T00:00:00Z",
      }),
    ).toEqual(
      await contentSignalFingerprint({
        kind: "fresh_source",
        sourceIds: ["https://x.com/b/status/123"],
        observedAt: "2026-10-13T00:00:00Z",
      }),
    );
  });
  it("saves editable cards once across simultaneous claims and local retries", async () => {
    const deps = dependencies();
    vi.mocked(deps.claim).mockResolvedValueOnce([signal]).mockResolvedValue([]);
    await Promise.all([
      processDueContentAgentSignals(1, deps),
      processDueContentAgentSignals(1, deps),
    ]);
    await processDueContentAgentSignals(1, deps);
    expect(deps.finish).toHaveBeenCalledOnce();
    expect(deps.finish).toHaveBeenCalledWith(signal, payload);
  });
  it("does not generate stale signals", async () => {
    const deps = dependencies();
    vi.mocked(deps.claim).mockResolvedValue([{ ...signal, observed_at: "2020-01-01T00:00:00Z" }]);
    await processDueContentAgentSignals(1, deps);
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.release).toHaveBeenCalledWith(expect.anything(), "skipped");
  });
  it("rechecks workspace entitlement before provider calls and isolates failure", async () => {
    const deps = dependencies();
    vi.mocked(deps.authorize).mockRejectedValue(new Error("Inactive"));
    await processDueContentAgentSignals(1, deps);
    expect(deps.authorize).toHaveBeenCalledWith("owner");
    expect(deps.prepare).not.toHaveBeenCalled();
  });
  it("weak evidence produces no filler message and releases the reservation", async () => {
    const deps = dependencies();
    vi.mocked(deps.prepare).mockResolvedValue(null);
    await processDueContentAgentSignals(1, deps);
    expect(deps.finish).not.toHaveBeenCalled();
    expect(deps.release).toHaveBeenCalledWith(signal, "skipped");
  });
  it("failed generation retries are bounded", async () => {
    const deps = dependencies();
    vi.mocked(deps.claim).mockResolvedValue([{ ...signal, attempts: 3 }]);
    vi.mocked(deps.prepare).mockRejectedValue(new Error("provider"));
    await processDueContentAgentSignals(1, deps);
    expect(deps.release).toHaveBeenCalledWith(expect.anything(), "failed");
  });
});

const productionMocks = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  queries: [] as Array<[string, string, unknown]>,
  prefs: { proactive_paused: false, platforms: ["linkedin"] },
  rpc: vi.fn(),
  generate: vi.fn(),
  context: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => {
      productionMocks.rpc(...args);
      const [name] = args;
      const data =
        name === "claim_due_content_agent_signals"
          ? productionMocks.rows.claims || []
          : name === "unindexed_content_agent_sources"
            ? []
            : name === "claim_content_agent_recommendations"
              ? productionMocks.rows.creator_content_recommendations || []
              : name === "get_content_agent_source"
                ? productionMocks.rows.creator_content_recommendations || []
                : name === "content_agent_suppressed_topics"
                  ? productionMocks.rows.blockedTopics || []
                  : name === "content_agent_suppressed_sources"
                    ? productionMocks.rows.blockedSources || []
                    : "signal";
      return Promise.resolve({ data, error: null });
    },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order", "limit", "in", "gte", "lte"])
        q[method] = (key: string, value?: unknown) => {
          productionMocks.queries.push([table, key, value]);
          return q;
        };
      q.maybeSingle = async () => ({ data: productionMocks.rows[table], error: null });
      q.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: productionMocks.rows[table] || [], error: null }).then(resolve);
      return q;
    },
  },
}));
vi.mock("./content-agent-identity.server", () => ({
  getContentAgentPreferencesForWorkspace: async () => productionMocks.prefs,
}));
vi.mock("./content-agent.server", () => ({
  loadContentEditorialContext: (...args: unknown[]) => productionMocks.context(...args),
}));
vi.mock("./content-editorial.server", () => ({
  generateEditorialDraft: (...args: unknown[]) => productionMocks.generate(...args),
}));
import { prepareContentAgentSignal, usefulDiscoverSources } from "./content-agent-proactive.server";
import { contentAgentResultSchema } from "./content-agent";
import { storedContentAgentResultSchema } from "./content-agent-proactive";
const postId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const draft = {
  type: "draft",
  cardId: "draft",
  platform: "linkedin",
  format: "post",
  title: "Original title",
  body: "Original checked body",
  sourceUrls: ["https://example.com/source"],
  visualBrief: null,
  rationale: "A concrete reader benefit",
  editorial: {
    sourceIds: ["source-1"],
    angle: "A concrete reader benefit",
    whyNow: "Useful for this decision",
    validationState: "passed",
  },
};
function preparedRows() {
  productionMocks.prefs = { proactive_paused: false, platforms: ["linkedin"] };
  productionMocks.queries = [];
  productionMocks.rows = {
    content_routine_runs: {
      id: runId,
      routine_id: "routine",
      prepared_output: {
        version: 1,
        runId,
        routineId: "routine",
        userId: "owner",
        result: {
          action: "draft",
          message: "What evidence can you provide?",
          cards: [
            draft,
            {
              type: "idea",
              cardId: "fallback",
              title: "Evidence missing",
              premise: "A topic",
              format: "post",
              takeaway: "Provide details",
              sourceUrls: [],
            },
          ],
        },
        drafts: [{ runId, socialPostId: postId, card: draft }],
      },
    },
    social_posts: {
      id: postId,
      title: "Original title",
      body: "Creator edited body",
      status: "draft",
      settings: { card: draft, routineRunId: runId },
    },
  };
}
const preparedSignal = { ...signal, kind: "prepared_routine" as const, source_ids: [runId] };
it("delivers only useful bound drafts, reads owned canonical copy and invalidates edited validation", async () => {
  preparedRows();
  const result = await prepareContentAgentSignal(preparedSignal);
  expect(result?.message).toBe("A draft is ready for your review.");
  expect(result?.cards).toHaveLength(1);
  expect(result?.cards[0]).toMatchObject({
    body: "Creator edited body",
    editorial: { validationState: "needs_review" },
  });
  expect(result?.proactive?.draftBindings[0]).toMatchObject({
    socialPostId: postId,
    runId,
    cardId: "draft",
    body: "Creator edited body",
  });
  expect(productionMocks.queries).toContainEqual(["social_posts", "user_id", "owner"]);
  expect(productionMocks.queries).toContainEqual(["content_routine_runs", "user_id", "owner"]);
  expect(storedContentAgentResultSchema.safeParse(result).success).toBe(true);
  expect(contentAgentResultSchema.safeParse(result).success).toBe(false); // model cannot assign bindings
});
it("does not offer a prepared draft already scheduled or a foreign batch", async () => {
  preparedRows();
  (productionMocks.rows.social_posts as { status: string }).status = "scheduled";
  expect(await prepareContentAgentSignal(preparedSignal)).toBeNull();
  preparedRows();
  (
    productionMocks.rows.content_routine_runs as { prepared_output: { userId: string } }
  ).prepared_output.userId = "someone-else";
  expect(await prepareContentAgentSignal(preparedSignal)).toBeNull();
});
it("paused preference prevents generation and prepared delivery", async () => {
  preparedRows();
  productionMocks.prefs.proactive_paused = true;
  expect(await prepareContentAgentSignal(signal)).toBeNull();
  expect(await prepareContentAgentSignal(preparedSignal)).toBeNull();
  expect(productionMocks.generate).not.toHaveBeenCalled();
});
it("weekly advice requires trusted preparation evidence and no filler", async () => {
  preparedRows();
  const row = productionMocks.rows.content_routine_runs as {
    prepared_output: Record<string, unknown>;
  };
  row.prepared_output.drafts = [];
  row.prepared_output.result = {
    action: "answer",
    message:
      "Your recent source comparison explains a useful tradeoff. Build the next post around the observed difference, test one small offer, and compare the responses before expanding.",
    cards: [],
  };
  expect(await prepareContentAgentSignal(preparedSignal)).toBeNull();
  row.prepared_output.adviceEvidence = { sourceIds: ["source-1"] };
  expect(await prepareContentAgentSignal(preparedSignal)).toMatchObject({
    action: "answer",
    cards: [],
    proactive: { draftBindings: [] },
  });
});
it("Discover variants share dismissed/saved feedback and require fresh substantive evidence", () => {
  const source = {
    id: "a",
    fingerprint: "trend:a",
    source_url: "https://twitter.com/a/status/123",
    source_published_at: new Date().toISOString(),
    summary: "Original evidence. ".repeat(10),
    reason: "A practical application for this creator",
    feedback: "pending",
  };
  expect(
    usefulDiscoverSources([
      source,
      { ...source, id: "b", source_url: "https://x.com/b/status/123?utm_source=refresh" },
    ]),
  ).toHaveLength(1);
  for (const feedback of ["saved", "not_relevant"])
    expect(usefulDiscoverSources([source, { ...source, id: "b", feedback }])).toEqual([]);
  expect(
    usefulDiscoverSources([
      { ...source, summary: "weak" },
      { ...source, source_published_at: "2020-01-01" },
    ]),
  ).toEqual([]);
});

it("advances beyond already-seen Discover originals in a bounded scan", async () => {
  const { enqueueFreshSourceSignals } = await import("./content-agent-proactive.server");
  const date = new Date().toISOString();
  productionMocks.rows.creator_content_recommendations = [1, 2, 3, 4].map((id) => ({
    fingerprint: `source:${id}`,
    source_url: `https://x.com/creator/status/${id}`,
    source_published_at: date,
    summary: "Original evidence. ".repeat(10),
    reason: "A practical application for this creator",
    feedback: "pending",
  }));
  productionMocks.rows.content_agent_signals = await Promise.all(
    [1, 2, 3].map(async (id) => ({
      fingerprint: await contentSignalFingerprint({
        kind: "fresh_source",
        sourceIds: [`x:${id}`],
        observedAt: date,
      }),
    })),
  );
  productionMocks.rpc.mockClear();
  expect(await enqueueFreshSourceSignals("owner")).toBe(1);
  expect(productionMocks.rpc).toHaveBeenCalledWith(
    "enqueue_content_agent_signal",
    expect.objectContaining({ p_user_id: "owner", p_source_ids: ["x:4"] }),
  );
});

it("retains needs_review when canonical settings have already invalidated the original check", async () => {
  preparedRows();
  productionMocks.rows.social_posts = {
    id: postId,
    title: draft.title,
    body: draft.body,
    status: "draft",
    settings: {
      card: { ...draft, editorial: { ...draft.editorial, validationState: "needs_review" } },
    },
  };
  expect((await prepareContentAgentSignal(preparedSignal))?.cards[0]).toMatchObject({
    editorial: { validationState: "needs_review" },
  });
});

it("checks real configured gaps by platform and slot rather than any saved post", async () => {
  const { upcomingContentGap } = await import("./content-agent-proactive.server");
  const schedule = {
    timezone: "UTC",
    naturalOffset: false,
    slots: [
      { day: 1, time: "09:00" },
      { day: 2, time: "09:00" },
    ],
  };
  const now = new Date("2026-10-12T08:00:00Z");
  const stale = {
    id: "old",
    status: "draft",
    body: "Old",
    created_at: "2020-01-01",
    settings: { platform: "linkedin" },
  };
  const future = {
    id: "future",
    status: "scheduled",
    scheduled_at: "2026-11-02T09:00:00Z",
    targets: [{ provider: "linkedin" }],
  };
  expect(upcomingContentGap(schedule, [stale, future], ["linkedin"], now)).toEqual({
    platform: "linkedin",
    scheduledAt: "2026-10-12T09:00:00.000Z",
  });
  const filled = {
    id: "filled",
    status: "scheduled",
    scheduled_at: "2026-10-12T09:00:00Z",
    targets: [{ provider: "linkedin" }],
  };
  expect(upcomingContentGap(schedule, [filled], ["linkedin"], now)?.scheduledAt).toBe(
    "2026-10-13T09:00:00.000Z",
  );
  expect(upcomingContentGap(schedule, [filled], ["twitter"], now)?.scheduledAt).toBe(
    "2026-10-12T09:00:00.000Z",
  );
  expect(upcomingContentGap({ ...schedule, slots: [] }, [], ["linkedin"], now)).toBeNull();
  const prepared = {
    ...stale,
    settings: {
      platform: "linkedin",
      routineRunId: runId,
      routineOutputReady: true,
      routineSlotAt: "2026-10-13T09:00:00.000Z",
    },
  };
  expect(upcomingContentGap(schedule, [filled, prepared], ["linkedin"], now)).toBeNull();
});
it("topic preferences suppress another source about the same topic but retain unrelated topics", async () => {
  const { contentTopicKeys, topicIsSuppressed } = await import("./content-agent-proactive");
  const rejected = contentTopicKeys("Creator burnout prevention");
  expect(topicIsSuppressed(contentTopicKeys("New creator burnout research"), rejected)).toBe(true);
  expect(topicIsSuppressed(contentTopicKeys("Creator pricing experiments"), rejected)).toBe(false);
  expect(contentTopicKeys("https://example.com/source")).not.toContain(
    "https://example.com/source",
  );
});

it("candidate selection consumes durable topic preferences before spending provider work", async () => {
  const { enqueueFreshSourceSignals } = await import("./content-agent-proactive.server");
  const { contentTopicKeys } = await import("./content-agent-proactive");
  const row = {
    fingerprint: "source:1",
    source_url: "https://example.com/new-burnout-study",
    source_published_at: new Date().toISOString(),
    title: "New creator burnout research",
    summary: "A concrete observed result. ".repeat(10),
    reason: "Useful creator decisions backed by research",
    feedback: "pending",
  };
  productionMocks.rows = {
    creator_content_recommendations: [
      row,
      {
        ...row,
        fingerprint: "source:2",
        source_url: "https://example.com/pricing",
        title: "Creator pricing experiments",
      },
    ],
    content_agent_signals: [],
    blockedTopics: contentTopicKeys("Creator burnout prevention"),
  };
  productionMocks.rpc.mockClear();
  expect(await enqueueFreshSourceSignals("owner")).toBe(1);
  expect(productionMocks.rpc).toHaveBeenCalledWith(
    "enqueue_content_agent_signal",
    expect.objectContaining({ p_source_ids: ["example.com/pricing"] }),
  );
});
it("the worker prepares only a real gap and carries its exact platform and slot", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T08:00:00Z"));
  try {
    preparedRows();
    productionMocks.rows.social_posting_schedules = {
      timezone: "UTC",
      natural_offset: false,
      slots: [],
    };
    productionMocks.rows.social_posts = [];
    productionMocks.context.mockClear();
    expect(
      await prepareContentAgentSignal({
        ...signal,
        kind: "schedule_gap",
        source_ids: ["upcoming-schedule"],
      }),
    ).toBeNull();
    expect(productionMocks.context).not.toHaveBeenCalled();
    productionMocks.rows.social_posting_schedules = {
      timezone: "UTC",
      natural_offset: false,
      slots: [{ day: 1, time: "09:00" }],
    };
    productionMocks.context.mockResolvedValue({
      brain: [],
      sources: [
        {
          id: "source-1",
          title: "Creator pricing experiments",
          text: "A concrete pricing decision with a measured comparison. ".repeat(5),
          occurredAt: "2026-10-11T09:00:00Z",
          external: false,
        },
      ],
    });
    productionMocks.generate.mockResolvedValue({ status: "ready", card: draft });
    const result = await prepareContentAgentSignal({
      ...signal,
      kind: "schedule_gap",
      source_ids: ["upcoming-schedule"],
    });
    expect(result?.proactive?.gap).toEqual({
      platform: "linkedin",
      scheduledAt: "2026-10-12T09:00:00.000Z",
    });
    expect(result?.proactive?.sourceKeys).not.toContain("upcoming-schedule");
    expect(productionMocks.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        platform: "linkedin",
        request: expect.stringContaining("2026-10-12T09:00:00.000Z"),
      }),
      expect.anything(),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("disabled rollout skips enqueue, scanning and claims without disabling routine authorization", async () => {
  const api = await import("./content-agent-proactive.server");
  rollout.enabled = false;
  productionMocks.rpc.mockClear();
  productionMocks.rows.profiles = { id: "owner", workspace_status: "active" };
  try {
    await api.authorizeContentAgentWork("owner");
    expect(
      await api.enqueueContentAgentSignal({
        userId: "owner",
        kind: "schedule_gap",
        sourceIds: ["gap"],
        observedAt: new Date().toISOString(),
      }),
    ).toBeNull();
    expect(await api.scanContentAgentSignals()).toEqual({ checked: 0, enqueued: 0 });
    expect(await api.processDueContentAgentSignals()).toEqual({
      claimed: 0,
      delivered: 0,
      skipped: 0,
      failed: 0,
    });
    expect(productionMocks.rpc).not.toHaveBeenCalled();
  } finally {
    rollout.enabled = true;
  }
});

it("rechecks production rollout after preparation and releases the lease without delivery", async () => {
  preparedRows();
  productionMocks.rows.profiles = { id: "owner", workspace_status: "active" };
  productionMocks.rows.claims = [preparedSignal];
  const canonical = productionMocks.rows.social_posts;
  Object.defineProperty(productionMocks.rows, "social_posts", {
    configurable: true,
    get: () => {
      rollout.enabled = false;
      return canonical;
    },
  });
  productionMocks.rpc.mockClear();
  try {
    const result = await processDueContentAgentSignals();
    expect(result).toEqual({ claimed: 1, delivered: 0, skipped: 0, failed: 1 });
    expect(productionMocks.rpc).toHaveBeenCalledWith("claim_due_content_agent_signals", {
      p_limit: 1,
      p_workspace_ids: ["owner"],
    });
    expect(
      productionMocks.rpc.mock.calls.some(([name]) => name === "finish_content_agent_signal"),
    ).toBe(false);
    expect(productionMocks.rpc).toHaveBeenCalledWith(
      "release_content_agent_signal",
      expect.objectContaining({ p_user_id: "owner", p_status: "pending" }),
    );
  } finally {
    rollout.enabled = true;
    preparedRows();
  }
});
