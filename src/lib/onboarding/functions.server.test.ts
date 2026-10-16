import { beforeEach, expect, it, vi } from "vitest";
import { buildManualCandidates, onboardingBriefSchema } from "./brief";
const mocks = vi.hoisted(() => ({ row: {} as Record<string, unknown>, generate: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      validator: (schema: (value: unknown) => unknown) => {
        validate = schema;
        return chain;
      },
      handler:
        (handler: (input: { context: { userId: string }; data: unknown }) => unknown) =>
        (input?: { data?: unknown }) =>
          handler({ context: { userId: "workspace" }, data: validate(input?.data) }),
    };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("../request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("../username-alias.server", () => ({
  resolvePublicUsername: vi.fn().mockResolvedValue(null),
}));
vi.mock("./export.server", () => ({
  readOnboardingExport: vi.fn().mockResolvedValue({ brain: [], drafts: [] }),
}));
vi.mock("./generation.server", () => ({ processOnboardingGeneration: mocks.generate }));
vi.mock("./session.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.server")>();
  return {
    ...actual,
    requireOnboardingPreview: async () => mocks.row,
    readOnboardingSession: async () => mocks.row,
    onboardingDb: {
      from: () => {
        let patch: Record<string, unknown> = {};
        const query = {
          update: (value: Record<string, unknown>) => {
            patch = value;
            return query;
          },
          eq: () => query,
          select: () => query,
          maybeSingle: async () => {
            Object.assign(mocks.row, patch);
            return { data: mocks.row, error: null };
          },
        };
        return query;
      },
    },
  };
});
import {
  prepareOnboarding,
  approveOnboarding,
  saveOnboarding,
  editOnboardingCandidates,
  exportOnboardingContent,
} from "./functions";
beforeEach(() => {
  vi.clearAllMocks();
  const brief = onboardingBriefSchema.parse({
    displayName: "Ari",
    username: "ari_studio",
    expertise: "Photography",
    audience: "Beginners",
    platform: "instagram",
  });
  mocks.row = {
    workspace_id: "workspace",
    revision: 4,
    step: 3,
    brief,
    candidates: {
      ...buildManualCandidates(brief),
      drafts: [{ title: "Earlier idea", body: "Creator's legacy script and edits" }],
    },
    status: "draft",
    job_status: "ready",
    job_attempts: 2,
    generation_count: 2,
    job_error: null,
  };
});
it("lets an exhausted legacy preparation explicitly continue without applying or deleting its draft copy", async () => {
  const earlier = structuredClone(mocks.row.candidates);
  await expect(prepareOnboarding({ data: { revision: 4, generate: true } })).rejects.toThrow(
    /allowance/,
  );
  const manual = await prepareOnboarding({ data: { revision: 4, generate: false } });
  expect(manual.generationCount).toBe(2);
  expect(manual.candidates?.drafts).toEqual([]);
  expect(manual.candidates?.deferredDrafts).toEqual((earlier as { drafts: unknown[] }).drafts);
  expect(mocks.generate).not.toHaveBeenCalled();
  // Postgres JSONB can return keys in a different order than schema-parsed input.
  mocks.row.candidates = Object.fromEntries(
    Object.entries(mocks.row.candidates as Record<string, unknown>).reverse(),
  );
  await expect(
    approveOnboarding({
      data: { revision: 4, candidates: manual.candidates, allowPartial: false },
    }),
  ).rejects.toThrow(/without starter drafts/);
  const approved = await approveOnboarding({
    data: { revision: 4, candidates: manual.candidates, allowPartial: true },
  });
  expect(approved.status).toBe("prepared");
  expect(approved.candidates?.drafts).toEqual([]);
  expect(approved.candidates?.deferredDrafts).toEqual(manual.candidates?.deferredDrafts);
  const repeated = await prepareOnboarding({ data: { revision: 4, generate: false } });
  expect(repeated.candidates?.deferredDrafts).toEqual(manual.candidates?.deferredDrafts);
});

it("retains deferred copy through changed answers, fresh preparation and export while invalidating stale drafts and Brain", async () => {
  const manual = await prepareOnboarding({ data: { revision: 4, generate: false } });
  const deferred = structuredClone(manual.candidates!.deferredDrafts);
  const edited = await editOnboardingCandidates({
    data: {
      revision: manual.revision,
      candidates: {
        ...manual.candidates!,
        brain: manual.candidates!.brain.map((item) =>
          item.kind === "instruction" ? { ...item, content: "Old custom voice" } : item,
        ),
      },
    },
  });
  const withDraft = await editOnboardingCandidates({
    data: {
      revision: edited.revision,
      candidates: {
        ...edited.candidates!,
        drafts: [
          {
            title: "Stale active post",
            body: "An argument for the old audience",
            platform: "linkedin",
            format: "post",
          },
        ],
      },
    },
  });
  const changed = await saveOnboarding({
    data: {
      revision: withDraft.revision,
      step: 3,
      brief: {
        ...manual.brief,
        voice: "Concise and specific",
        platform: "linkedin",
        audience: "Experienced editors",
      },
    },
  });
  expect(changed.candidates?.deferredDrafts).toEqual(deferred);
  expect(changed.candidates?.drafts).toEqual([]);
  expect(changed.candidates?.brain.find((item) => item.kind === "instruction")?.content).toContain(
    "Concise and specific",
  );
  expect(
    changed.candidates?.brain.find((item) => item.kind === "instruction")?.content,
  ).not.toContain("Old custom voice");
  expect(changed.candidates?.brain.find((item) => item.kind === "profile")?.content).toContain(
    "Experienced editors",
  );
  expect(changed.jobStatus).toBe("idle");
  expect(mocks.row.approved_revision).toBeNull();
  expect(mocks.row.job_lease).toBeNull();
  const rebuilt = await prepareOnboarding({
    data: { revision: changed.revision, generate: false },
  });
  expect(rebuilt.candidates?.deferredDrafts).toEqual(deferred);
  expect(rebuilt.generationCount).toBe(2);
  const exported = JSON.parse(await exportOnboardingContent());
  expect(exported.preparation.deferredDrafts).toEqual(deferred);
  expect(exported.preparation.drafts).toEqual([]);
  expect(exported.brief.platform).toBe("linkedin");
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("preserves the server's deferred archive when a Brain edit omits or clears the read-only field", async () => {
  const manual = await prepareOnboarding({ data: { revision: 4, generate: false } });
  const { deferredDrafts, ...withoutArchive } = manual.candidates!;
  const edited = await editOnboardingCandidates({
    data: {
      revision: manual.revision,
      candidates: {
        ...withoutArchive,
        brain: withoutArchive.brain.map((item) =>
          item.kind === "instruction" ? { ...item, content: "My updated voice" } : item,
        ),
      },
    },
  });
  expect(edited.candidates?.deferredDrafts).toEqual(deferredDrafts);
  const approved = await approveOnboarding({
    data: { revision: edited.revision, candidates: edited.candidates, allowPartial: true },
  });
  expect(approved.status).toBe("prepared");
  const cleared = await editOnboardingCandidates({
    data: { revision: edited.revision, candidates: { ...edited.candidates!, deferredDrafts: [] } },
  });
  expect(cleared.candidates?.deferredDrafts).toEqual(deferredDrafts);
});
