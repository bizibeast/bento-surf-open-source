import { expect, it, vi } from "vitest";
import { routinePostId, saveRoutineOutputs } from "./content-routine-output.server";
import type { ContentAgentResult } from "./content-agent";
const result: ContentAgentResult = {
  action: "draft",
  message: "Draft",
  cards: [
    {
      type: "draft",
      cardId: "draft-one",
      platform: "linkedin",
      format: "post",
      title: "A launch",
      body: "A real lesson",
      sourceUrls: [],
      rationale: "A source-backed story",
      visualBrief: null,
    },
  ],
};
function fixture(runExists = true) {
  const rows = new Map<string, Record<string, unknown>>();
  const prepared: Array<Record<string, unknown>> = [];
  const filters: Array<[string, string]> = [];
  const savePost = vi.fn();
  const db = {
    from(table: string) {
      let id = "";
      const scopedFilters: Array<[string, string]> = [];
      let patch: Record<string, unknown> | undefined;
      const query = {
        select() {
          return query;
        },
        eq(key: string, value: string) {
          filters.push([key, value]);
          scopedFilters.push([key, value]);
          if (key === "id") id = value;
          return query;
        },
        async upsert(row: Record<string, unknown>) {
          if (!rows.has(String(row.id))) rows.set(String(row.id), row);
          return { error: null };
        },
        update(value: Record<string, unknown>) {
          patch = value;
          return query;
        },
        async maybeSingle() {
          return {
            data: runExists
              ? { id: "run-1", prepared_output: prepared.at(-1)?.prepared_output }
              : null,
            error: null,
          };
        },
        async single() {
          return { data: rows.get(id), error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          if (table === "content_routine_runs" && patch) prepared.push(patch);
          return Promise.resolve({
            data:
              table === "social_posts"
                ? [...rows.values()].filter((row) =>
                    scopedFilters.every(
                      ([key, value]) =>
                        (key.startsWith("settings->>")
                          ? (row.settings as Record<string, unknown>)?.[key.split("->>")[1]]
                          : row[key]) === value,
                    ),
                  )
                : [],
            error: null,
          }).then(resolve);
        },
      };
      return query;
    },
  };
  return { db, savePost, rows, prepared, filters };
}
const base = {
  userId: "owner",
  runId: "run-1",
  routineId: "routine-1",
  result,
  platforms: ["linkedin"],
  timezone: "UTC",
  slots: [{ scheduledAt: "2099-10-06T10:00:00Z" }],
};
it("defaults to durable drafts and never schedules without opt-in", async () => {
  const deps = fixture();
  await saveRoutineOutputs(base, deps);
  expect(deps.savePost).not.toHaveBeenCalled();
  expect([...deps.rows.values()][0]).toMatchObject({
    user_id: "owner",
    body: "A real lesson",
    status: "draft",
  });
});
it("rejects automatic scheduling and unsupported formats before storing anything", async () => {
  const deps = fixture();
  await expect(saveRoutineOutputs({ ...base, outputMode: "schedule" }, deps)).rejects.toThrow(
    /review/i,
  );
  await expect(
    saveRoutineOutputs(
      {
        ...base,
        result: {
          ...result,
          cards: [{ ...result.cards[0], platform: "youtube", format: "short_script" } as never],
        },
      },
      deps,
    ),
  ).rejects.toThrow(/supported/i);
  expect(deps.rows.size).toBe(0);
});
it("retains complete cards and canonical identities without overwriting creator edits on retry", async () => {
  const deps = fixture();
  await saveRoutineOutputs(base, deps);
  const id = await routinePostId(base.runId, result.cards[0].cardId);
  const row = deps.rows.get(id)!;
  expect(row.settings).toMatchObject({
    routineRunId: base.runId,
    routineOutputReady: true,
    routineSlotAt: base.slots[0].scheduledAt,
    card: result.cards[0],
  });
  row.body = "Creator edit";
  row.status = "scheduled";
  await saveRoutineOutputs(base, deps);
  expect(row.body).toBe("Creator edit");
  expect(row.status).toBe("scheduled");
  expect(deps.savePost).not.toHaveBeenCalled();
});
it("assigns different stable post identities to distinct runs and drafts", async () => {
  expect(await routinePostId("run", 0)).toBe(await routinePostId("run", 0));
  expect(await routinePostId("run", 0)).not.toBe(await routinePostId("run", 1));
});

it("persists a prepared batch with canonical post identity and checks run ownership", async () => {
  const deps = fixture();
  await saveRoutineOutputs(base, deps);
  expect(deps.prepared[0]).toMatchObject({
    prepared_output: {
      version: 1,
      userId: "owner",
      runId: "run-1",
      drafts: [
        {
          socialPostId: await routinePostId("run-1", result.cards[0].cardId),
          runId: "run-1",
          card: result.cards[0],
        },
      ],
    },
  });
  expect(deps.filters).toContainEqual(["user_id", "owner"]);
  const missing = fixture(false);
  await expect(saveRoutineOutputs(base, missing)).rejects.toThrow(/unavailable/);
  expect(missing.rows.size).toBe(0);
});
it("retains carousel provenance and slides in both saved post and prepared output", async () => {
  const deps = fixture();
  const card = {
    ...result.cards[0],
    platform: "instagram",
    format: "carousel",
    slides: [{ heading: "Decision", body: "Complete slide copy" }],
    editorial: {
      sourceIds: ["evidence"],
      angle: "Specific angle",
      whyNow: "Practical relevance",
      validationState: "passed",
    },
  };
  await saveRoutineOutputs(
    { ...base, platforms: ["instagram"], result: { ...result, cards: [card as never] } },
    deps,
  );
  expect(deps.rows.values().next().value?.settings).toMatchObject({
    card,
    visualReadiness: "visuals_needed",
  });
  expect(deps.prepared[0]).toMatchObject({ prepared_output: { drafts: [{ card }] } });
});

const idea = {
  type: "idea" as const,
  cardId: "routine-1",
  title: "Need an example",
  premise: "A useful next step",
  format: "linkedin/post",
  takeaway: "Add a concrete example",
  sourceUrls: [],
};
it("keeps both canonical bindings when a retry changes a draft slot into an idea", async () => {
  const deps = fixture();
  const first = { ...result.cards[0], cardId: "routine-1" };
  const second = { ...result.cards[0], cardId: "routine-2", title: "Second argument" };
  await saveRoutineOutputs({ ...base, result: { ...result, cards: [first, second] } }, deps);
  const canonical = [...deps.rows.values()];
  canonical[0].body = "Creator's edited first argument";
  canonical[0].status = "published";
  await saveRoutineOutputs({ ...base, result: { ...result, cards: [idea, second] } }, deps);
  const batch = deps.prepared.at(-1)?.prepared_output as {
    drafts: Array<{ socialPostId: string; card: { cardId: string; body: string } }>;
    result: ContentAgentResult;
  };
  expect(batch.drafts).toHaveLength(2);
  expect(batch.drafts.map((item) => item.socialPostId).sort()).toEqual(
    canonical.map((row) => String(row.id)).sort(),
  );
  expect(new Set(batch.result.cards.map((card) => card.cardId)).size).toBe(2);
  expect(batch.result.cards.every((card) => card.type === "draft")).toBe(true);
  expect(batch.drafts.find((item) => item.card.cardId === "routine-1")?.card.body).toBe(
    "Creator's edited first argument",
  );
  expect(canonical[0].status).toBe("published");
});
it("recovers a legacy positional post after interrupted persistence and merges a new earlier slot", async () => {
  const deps = fixture();
  const legacyId = await routinePostId(base.runId, 0);
  const second = { ...result.cards[0], cardId: "routine-2", title: "Second slot" };
  deps.rows.set(legacyId, {
    id: legacyId,
    user_id: base.userId,
    title: second.title,
    body: "Creator's second-slot edit",
    status: "scheduled",
    settings: { routineRunId: base.runId, routineId: base.routineId, card: second },
  });
  const first = { ...result.cards[0], cardId: "routine-1" };
  await saveRoutineOutputs({ ...base, result: { ...result, cards: [first, second] } }, deps);
  const batch = deps.prepared.at(-1)?.prepared_output as {
    drafts: Array<{ socialPostId: string; card: { cardId: string; body: string } }>;
    result: ContentAgentResult;
  };
  expect(batch.drafts).toHaveLength(2);
  expect(deps.rows.size).toBe(2);
  expect(batch.drafts.find((item) => item.card.cardId === "routine-2")).toMatchObject({
    socialPostId: legacyId,
    card: { body: "Creator's second-slot edit" },
  });
  expect(new Set(batch.result.cards.map((card) => card.cardId)).size).toBe(2);
});

it("uses the persisted canonical binding when a creator edit replaces post settings", async () => {
  const deps = fixture();
  await saveRoutineOutputs(base, deps);
  const post = deps.rows.values().next().value!;
  post.body = "Edited in scheduler";
  post.settings = {};
  post.status = "scheduled";
  await saveRoutineOutputs(
    { ...base, result: { ...result, cards: [{ ...idea, cardId: result.cards[0].cardId }] } },
    deps,
  );
  expect(deps.rows.size).toBe(1);
  expect(post.status).toBe("scheduled");
  expect(deps.prepared.at(-1)).toMatchObject({
    prepared_output: {
      drafts: [
        {
          socialPostId: post.id,
          card: { cardId: result.cards[0].cardId, body: "Edited in scheduler" },
        },
      ],
    },
  });
});
