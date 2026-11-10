import { describe, expect, it } from "vitest";
import {
  runSocialPublishSequence,
  type SocialPublishProgress,
} from "./social-publish-sequence.server";
import { ProviderError } from "./social-provider-error";

const empty = (): SocialPublishProgress => ({ completed: [], pending: null });
describe("checkpointed social publishing", () => {
  it("returns the original post and chains confirmed IDs", async () => {
    let stored = empty();
    const seen: string[] = [];
    const result = await runSocialPublishSequence(
      stored,
      [
        async () => ({ id: "root", url: "https://x.com/i/web/status/root" }),
        async (previous) => {
          seen.push(previous!.id);
          return { id: "reply" };
        },
        async (previous) => {
          seen.push(previous!.id);
          return { id: "last" };
        },
      ],
      async (progress) => {
        stored = structuredClone(progress);
      },
    );
    expect(result.id).toBe("root");
    expect(seen).toEqual(["root", "reply"]);
    expect(stored.completed.map((part) => part.id)).toEqual(["root", "reply", "last"]);
    expect(stored.pending).toBeNull();
  });
  it("resumes after a definite rejection without repeating a published part", async () => {
    let stored = empty();
    let rootCalls = 0;
    let reject = true;
    const steps = [
      async () => {
        rootCalls++;
        return { id: "root" };
      },
      async () => {
        if (reject) throw new ProviderError("Slow down", "429", true, 429);
        return { id: "reply" };
      },
    ];
    await expect(
      runSocialPublishSequence(stored, steps, async (p) => {
        stored = structuredClone(p);
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(stored.pending).toBeNull();
    reject = false;
    expect(
      (
        await runSocialPublishSequence(stored, steps, async (p) => {
          stored = structuredClone(p);
        })
      ).id,
    ).toBe("root");
    expect(rootCalls).toBe(1);
  });
  it("stops unknown network outcomes and refuses to repeat the uncertain step", async () => {
    let stored = empty();
    let calls = 0;
    const steps = [
      async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
    ];
    await expect(
      runSocialPublishSequence(stored, steps, async (p) => {
        stored = structuredClone(p);
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown", retryable: false });
    expect(stored.pending).toBe(0);
    await expect(runSocialPublishSequence(stored, steps, async () => {})).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(calls).toBe(1);
  });
  it("does not send when the pre-write checkpoint fails", async () => {
    let calls = 0;
    await expect(
      runSocialPublishSequence(
        empty(),
        [
          async () => {
            calls++;
            return { id: "root" };
          },
        ],
        async () => {
          throw new Error("DB down");
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("stops after a success whose checkpoint was lost", async () => {
    let stored = empty();
    let saves = 0;
    await expect(
      runSocialPublishSequence(stored, [async () => ({ id: "root" })], async (p) => {
        if (++saves === 2) throw new Error("DB down");
        stored = structuredClone(p);
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(stored.pending).toBe(0);
    expect(stored.completed).toEqual([]);
  });
  it("keeps the completed post when a follow-up budget reservation is denied", async () => {
    let stored = empty();
    await expect(
      runSocialPublishSequence(
        stored,
        [
          async () => ({ id: "root" }),
          async () => {
            throw new ProviderError("Budget exhausted", "budget_exhausted", false);
          },
        ],
        async (p) => {
          stored = structuredClone(p);
        },
      ),
    ).rejects.toMatchObject({
      code: "budget_exhausted",
      message: expect.stringMatching(/1.*published/),
    });
    expect(stored.completed[0].id).toBe("root");
    expect(stored.pending).toBeNull();
  });
  it("treats a server error or missing remote ID as uncertain", async () => {
    for (const step of [
      async () => {
        throw new ProviderError("Server error", "500", true, 500);
      },
      async () => ({ id: "" }),
    ]) {
      await expect(runSocialPublishSequence(empty(), [step], async () => {})).rejects.toMatchObject(
        { code: "outcome_unknown" },
      );
    }
  });
});
