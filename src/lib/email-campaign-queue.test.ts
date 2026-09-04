import { describe, expect, it, vi } from "vitest";
import { CampaignDeliveryError, processAudienceCampaignQueueMessage } from "./email.server";

function message(attempts: number) {
  return {
    body: { kind: "audience_campaign" as const, campaignId: "campaign-1" },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe("audience campaign queue delivery", () => {
  it("acks only after campaign processing succeeds", async () => {
    const queued = message(1);

    await expect(
      processAudienceCampaignQueueMessage(queued as never, {
        process: vi.fn().mockResolvedValue({ recipients: 1, linked: 1 }),
        fail: vi.fn(),
      }),
    ).resolves.toBe("acked");
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("retries transient failures without marking the campaign failed", async () => {
    const queued = message(1);
    const fail = vi.fn();

    await expect(
      processAudienceCampaignQueueMessage(queued as never, {
        process: vi.fn().mockRejectedValue(new Error("database unavailable")),
        fail,
      }),
    ).resolves.toBe("retrying");
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(queued.ack).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("marks final and non-retryable failures before sending them to the DLQ", async () => {
    for (const error of [
      new Error("still unavailable"),
      new CampaignDeliveryError("invalid newsletter", false),
    ]) {
      const queued = message(error instanceof CampaignDeliveryError ? 1 : 8);
      const fail = vi.fn().mockResolvedValue(undefined);

      await expect(
        processAudienceCampaignQueueMessage(queued as never, {
          process: vi.fn().mockRejectedValue(error),
          fail,
        }),
      ).resolves.toBe("failed");
      expect(fail).toHaveBeenCalledWith("campaign-1", error);
      expect(queued.retry).toHaveBeenCalledWith();
      expect(queued.ack).not.toHaveBeenCalled();
    }
  });
});
