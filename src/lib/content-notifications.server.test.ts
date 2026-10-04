import { expect, it, vi } from "vitest";
import { notifyContentDraftsReady } from "./content-notifications.server";

it("notifies email and Telegram without failing drafts when one channel is down", async () => {
  const input = {
    userId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    draftCount: 3,
    platforms: ["linkedin", "twitter"],
  };
  const email = vi.fn().mockResolvedValue({ id: "email" });
  const telegram = vi.fn().mockRejectedValue(new Error("Telegram unavailable"));
  await expect(notifyContentDraftsReady(input, { email, telegram })).resolves.toEqual({
    email: "sent",
    telegram: "failed",
  });
  expect(email).toHaveBeenCalledWith(input);
  expect(telegram).toHaveBeenCalledWith(input);
});

it("marks unconfigured channels as skipped", async () => {
  await expect(
    notifyContentDraftsReady(
      { userId: "creator", runId: "run", draftCount: 1, platforms: [] },
      {
        email: vi.fn().mockResolvedValue(null),
        telegram: vi.fn().mockResolvedValue(null),
      },
    ),
  ).resolves.toEqual({ email: "skipped", telegram: "skipped" });
});
