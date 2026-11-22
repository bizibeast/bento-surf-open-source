/* eslint-disable @typescript-eslint/no-explicit-any -- In-memory database/provider boundaries for workflow tests. */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  jobs: new Map<string, any>(),
  requests: new Map<string, string>(),
  send: vi.fn(),
  start: vi.fn(),
  save: vi.fn(),
  eligible: true,
  rate: 2.31,
  unknown: false,
  rendered: null as any,
  events: [] as string[],
}));
function database(table: string) {
  const filters: Array<(row: any) => boolean> = [];
  let change: any;
  let insert: any;
  let maximum = Infinity;
  const query: any = {
    select: () => query,
    order: () => query,
    limit: (count: number) => {
      maximum = count;
      return query;
    },
    eq: (field: string, value: any) => {
      filters.push((row) => row[field] === value);
      return query;
    },
    is: (field: string, value: any) => {
      filters.push((row) => row[field] === value);
      return query;
    },
    in: (field: string, values: any[]) => {
      filters.push((row) => values.includes(row[field]));
      return query;
    },
    lte: (field: string, value: any) => {
      filters.push((row) => row[field] <= value);
      return query;
    },
    gte: (field: string, value: any) => {
      filters.push((row) => row[field] >= value);
      return query;
    },
    update: (value: any) => {
      change = value;
      return query;
    },
    insert: (value: any) => {
      insert = value;
      return query;
    },
  };
  const execute = () => {
    fixture.tables[table] ||= [];
    let insertedRow: any;
    if (insert) {
      insertedRow = structuredClone({
        id: crypto.randomUUID(),
        status: "awaiting_approval",
        media_ids: [],
        approved_at: null,
        steps: 0,
        lease_id: null,
        lease_expires_at: null,
        error_code: null,
        created_at: new Date().toISOString(),
        ...insert,
      });
      fixture.tables[table].push(insertedRow);
    }
    const rows = (insertedRow ? [insertedRow] : fixture.tables[table])
      .filter((row) => filters.every((filter) => filter(row)))
      .slice(0, maximum);
    if (change) rows.forEach((row) => Object.assign(row, structuredClone(change)));
    return { data: structuredClone(rows), error: null };
  };
  query.maybeSingle = query.single = async () => {
    const result = execute();
    return { ...result, data: result.data[0] || null };
  };
  query.then = (resolve: any, reject: any) => Promise.resolve(execute()).then(resolve, reject);
  return query;
}
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: database,
    rpc: vi.fn(async (_name: string, { p_production_id }: any) => {
      const row = fixture.tables.studio_reel_productions.find((row) => row.id === p_production_id);
      fixture.rendered = {
        id: crypto.randomUUID(),
        status: "ready",
        media_ids: [],
        revision: row.state.renderRevision,
        private_output: true,
        production_id: row.id,
      };
      fixture.events.push("render");
      return { data: fixture.rendered.id, error: null };
    }),
  },
}));
vi.mock("./content-studio.server", () => ({
  requireStudioWorkspace: async () => {},
  saveContentStudioEntryForWorkspace: (...args: any[]) => fixture.save(...args),
}));
vi.mock("./workspace-session.server", () => ({
  resolveWorkspace: async (_user: string, workspaceId: string) => ({
    workspaceId,
    workspace: { status: "active" },
  }),
}));
vi.mock("./provider-budget.server", () => ({
  getManagedSpendStatus: async () =>
    fixture.eligible
      ? {
          eligible: true,
          monthly: { remainingMicrousd: 25_000_000 },
          weekly: { remainingMicrousd: 6_250_000 },
        }
      : { eligible: false },
}));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: async () => {} }));
vi.mock("./studio-reel-host.server", () => ({ hostedStudioReelAttemptCost: () => 10_000 }));
vi.mock("./studio-carousel-jobs.server", () => ({
  studioCarouselJobStatus: async (input: any) => ({
    available: true,
    job: fixture.rendered?.revision === input.revision ? fixture.rendered : null,
  }),
}));
vi.mock("./heygen.server", () => ({
  createHeyGenClient: () => ({
    selection: async () => ({ avatar: { estimatedUsdPerMinute: fixture.rate } }),
  }),
}));

async function prepare(kind: "audio" | "video", input: any) {
  const prior = fixture.requests.get(input.requestKey);
  if (prior) return structuredClone(fixture.jobs.get(prior));
  const id = crypto.randomUUID();
  const cost =
    kind === "audio"
      ? input.script.length
      : Math.round(
          (Math.ceil(((input.requestedSeconds * fixture.rate) / 60) * 100) / 100) * 1_000_000,
        );
  const job = {
    jobId: id,
    outputKind: kind,
    status: "awaiting_approval",
    script: input.script,
    voiceId: input.voiceId,
    avatarId: input.avatarId,
    sourceAudioJobId: input.sourceAudioJobId ?? null,
    billing: "bento_managed",
    durationSeconds: null,
    speechWords: [],
    estimatedMicrousd: cost,
    estimatedUsd: cost / 1_000_000,
    requestedSeconds: input.requestedSeconds,
  };
  fixture.jobs.set(id, job);
  fixture.requests.set(input.requestKey, id);
  return structuredClone(job);
}
vi.mock("./external-tools.server", () => ({
  managedHeyGenConnection: async () => {
    if (!fixture.eligible) throw new Error("Managed allowance required");
    return { credential: "test-key" };
  },
  requireManagedHeyGenAssets: async () => () => true,
  heyGenSpeechCost: (script: string) => script.length,
  managedHeyGenAvatarCost: (seconds: number) =>
    Math.round((Math.ceil(((seconds * fixture.rate) / 60) * 100) / 100) * 1_000_000),
  prepareHeyGenSpeechJob: (_actor: any, input: any) => prepare("audio", input),
  prepareHeyGenJob: (_actor: any, input: any) => prepare("video", input),
  readHeyGenJob: async (_actor: any, id: string) => structuredClone(fixture.jobs.get(id)),
  approveHeyGenJob: async (_actor: any, id: string) => {
    fixture.jobs.get(id).status = "approved";
    return structuredClone(fixture.jobs.get(id));
  },
  startHeyGenJob: (...args: any[]) => fixture.start(...args),
  pollHeyGenJob: async (_actor: any, id: string) => structuredClone(fixture.jobs.get(id)),
}));

import {
  prepareReelProduction,
  approveReelProduction,
  processReelProductionMessage,
  readReelProduction,
  reelProductionActivity,
  latestReelProduction,
} from "./content-reel-production.server";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
import { newReelScene } from "./content-studio";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const authUserId = "22222222-2222-4222-8222-222222222222";
const entryId = "33333333-3333-4333-8333-333333333333";
const actor = { workspaceId, authUserId, clientId: "bento-browser" };
const input = () => ({
  workspaceId,
  entryId,
  revision: fixture.tables.content_studio_entries[0].revision,
  requestId: crypto.randomUUID(),
});
const stored = () => fixture.tables.studio_reel_productions.at(-1)!;

beforeEach(() => {
  fixture.jobs.clear();
  fixture.requests.clear();
  fixture.eligible = true;
  fixture.rate = 2.31;
  fixture.unknown = false;
  fixture.rendered = null;
  fixture.events = [];
  fixture.start.mockReset();
  fixture.save.mockReset();
  fixture.send.mockClear();
  fixture.tables = {
    studio_reel_productions: [],
    content_studio_entries: [
      {
        id: entryId,
        workspace_id: workspaceId,
        kind: "project",
        title: "45 second Reel",
        revision: 1,
        document: {
          schemaVersion: 1,
          format: "reel",
          style: "captions",
          brand: DEFAULT_AGENT_BRANDING,
          avatarId: "avatar",
          voiceId: "voice",
          scenes: [8, 15, 15, 7].map((duration, index) =>
            newReelScene({
              duration,
              kind: index === 0 || index === 3 ? "avatar" : "card",
              avatarScript: `Approved narration ${index}`,
              title: `Scene ${index}`,
            }),
          ),
        },
      },
    ],
  };
  fixture.start.mockImplementation(async (_actor, id) => {
    const job = fixture.jobs.get(id);
    fixture.events.push(`start-${job.outputKind}`);
    job.status = fixture.unknown ? "submission_unknown" : "ready";
    job.durationSeconds = job.requestedSeconds;
    job.speechWords = [
      { word: "Approved", start: 0, end: 0.5 },
      { word: "narration", start: 0.5, end: 1 },
    ];
    return structuredClone(job);
  });
  fixture.save.mockImplementation(async (_workspace, entry) => {
    const current = fixture.tables.content_studio_entries[0];
    if (current.revision === entry.revision)
      Object.assign(current, structuredClone(entry), { revision: entry.revision + 1 });
    else if (
      current.revision !== entry.revision + 1 ||
      JSON.stringify(current.document) !== JSON.stringify(entry.document)
    )
      throw new Error("Another session changed this project");
    return structuredClone(current);
  });
  vi.stubEnv("BENTO_V2_REEL_PRODUCTION_ENABLED", "true");
  vi.stubEnv("BENTO_MANAGED_HEYGEN_ENABLED", "true");
  vi.stubGlobal("__env__", { CONTENT_MEDIA_QUEUE: { send: fixture.send } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function finish(id: string) {
  for (let step = 0; step < 40; step++) {
    await processReelProductionMessage({ kind: "studio_reel_production", jobId: id });
    if (["ready", "failed", "needs_revision"].includes(stored().status)) return;
  }
  throw new Error("Workflow did not terminate");
}

describe("durable Reel production with provider fixtures", () => {
  it("requires browser approval, generates four audio clips and only fifteen avatar seconds, then privately renders", async () => {
    const prepared = await prepareReelProduction(actor, input());
    expect(prepared.avatarSeconds).toBe(15);
    await processReelProductionMessage({ kind: "studio_reel_production", jobId: prepared.id });
    expect(fixture.start).not.toHaveBeenCalled();
    await expect(
      approveReelProduction({ ...actor, clientId: "external-mcp" }, prepared.id),
    ).rejects.toThrow(/Bento/);
    await approveReelProduction(actor, prepared.id);
    await finish(prepared.id);
    expect(stored().status).toBe("ready");
    const audio = [...fixture.jobs.values()].filter((job) => job.outputKind === "audio");
    const avatar = [...fixture.jobs.values()].filter((job) => job.outputKind === "video");
    expect(audio).toHaveLength(4);
    expect(avatar).toHaveLength(2);
    expect(avatar.map((job) => job.requestedSeconds)).toEqual([8, 7]);
    expect(
      avatar.every((job) => audio.some((speech) => speech.jobId === job.sourceAudioJobId)),
    ).toBe(true);
    expect(
      stored().state.completedDocument.scenes.reduce(
        (sum: number, scene: any) => sum + scene.duration,
        0,
      ),
    ).toBe(45);
    expect(stored().media_ids).toEqual([]); // No public publishing copy before preview approval.
    expect(stored().state.renderJobId).toBeTruthy();
    expect(fixture.events.at(-1)).toBe("render");
  });
  it("fences duplicate deliveries and makes at most one generation attempt per queue step", async () => {
    const prepared = await prepareReelProduction(actor, input());
    await approveReelProduction(actor, prepared.id);
    await Promise.all([
      processReelProductionMessage({ kind: "studio_reel_production", jobId: prepared.id }),
      processReelProductionMessage({ kind: "studio_reel_production", jobId: prepared.id }),
    ]);
    expect(fixture.start).toHaveBeenCalledOnce();
  });
  it("reuses ready narration and avatars after a caption-only revision", async () => {
    const first = await prepareReelProduction(actor, input());
    await approveReelProduction(actor, first.id);
    await finish(first.id);
    const calls = fixture.start.mock.calls.length;
    const entry = fixture.tables.content_studio_entries[0];
    expect(entry.document.scenes[0].avatarJobId).toBeTruthy();
    expect(fixture.jobs.get(entry.document.scenes[0].avatarJobId)).toMatchObject({
      avatarId: entry.document.avatarId,
      voiceId: entry.document.voiceId,
      sourceAudioJobId: entry.document.scenes[0].narrationJobId,
      script: entry.document.scenes[0].avatarScript,
    });
    entry.document.scenes[0].caption = "A revised caption";
    entry.revision++;
    const second = await prepareReelProduction(actor, input());
    expect(second.avatarSeconds).toBe(0);
    expect(second.estimatedMicrousd).toBe(20_000);
    await approveReelProduction(actor, second.id);
    await finish(second.id);
    expect(stored().status).toBe("ready");
    expect(fixture.start).toHaveBeenCalledTimes(calls);
    expect(stored().state.completedDocument.scenes[0].caption).toBe("A revised caption");
  });
  it("stops future spending when the creator edits the approved project", async () => {
    const prepared = await prepareReelProduction(actor, input());
    await approveReelProduction(actor, prepared.id);
    fixture.tables.content_studio_entries[0].revision++;
    await finish(prepared.id);
    expect(stored()).toMatchObject({ status: "needs_revision", error_code: "project_changed" });
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
  });
  it("requires chosen B-roll before any production spend can be approved", async () => {
    fixture.tables.content_studio_entries[0].document.scenes[1].kind = "media";
    fixture.tables.content_studio_entries[0].document.scenes[1].mediaId = null;
    await expect(prepareReelProduction(actor, input())).rejects.toThrow(/Choose owned B-roll/);
    expect(fixture.start).not.toHaveBeenCalled();
  });
  it("stops before avatar generation if measured costs exceed approval", async () => {
    const prepared = await prepareReelProduction(actor, input());
    await approveReelProduction(actor, prepared.id);
    fixture.rate = 4.83;
    await finish(prepared.id);
    expect(stored()).toMatchObject({ status: "needs_revision", error_code: "estimate_changed" });
    expect(fixture.events).not.toContain("start-video");
  });
  it("does not resubmit an uncertain provider attempt on redelivery or a new estimate", async () => {
    const prepared = await prepareReelProduction(actor, input());
    await approveReelProduction(actor, prepared.id);
    fixture.unknown = true;
    await finish(prepared.id);
    await finish(prepared.id);
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(stored().error_code).toBe("provider_review_required");
    await expect(prepareReelProduction(actor, input())).rejects.toThrow(/previous generation/);
  });
  it("rejects unpaid plans and scopes status to the requesting creator", async () => {
    fixture.eligible = false;
    await expect(prepareReelProduction(actor, input())).rejects.toThrow(/allowance/);
    fixture.eligible = true;
    const prepared = await prepareReelProduction(actor, input());
    await expect(
      readReelProduction({ ...actor, authUserId: crypto.randomUUID() }, prepared.id),
    ).rejects.toThrow(/unavailable/);
    expect(fixture.start).not.toHaveBeenCalled();
  });
  it("surfaces scoped pending approvals in Pulse and hides managed production from Creator", async () => {
    const prepared = await prepareReelProduction(actor, input());
    const activity = await reelProductionActivity(actor);
    expect(activity).toEqual([
      expect.objectContaining({ id: prepared.id, status: "awaiting_approval" }),
    ]);
    expect(await reelProductionActivity({ ...actor, authUserId: crypto.randomUUID() })).toEqual([]);
    fixture.eligible = false;
    expect(await latestReelProduction(actor, input().entryId)).toEqual({
      available: false,
      job: null,
    });
    await expect(approveReelProduction(actor, prepared.id)).rejects.toThrow(/allowance changed/);
    expect(fixture.start).not.toHaveBeenCalled();
  });
});
