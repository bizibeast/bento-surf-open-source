import { render, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SchedulerConnection } from "@/lib/social-scheduler";
import { cancelSocialPost, savePostingSchedule } from "@/lib/social-scheduler.functions";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({
    to,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/social-scheduler.functions", () => ({
  cancelSocialPost: vi.fn(),
  deleteSocialPost: vi.fn(),
  duplicateSocialPost: vi.fn(),
  getRedditCommunities: vi.fn(),
  getSocialScheduler: vi.fn(),
  getTikTokCreatorInfo: vi.fn(),
  refreshSocialConnectionAvatar: vi.fn(),
  rescheduleSocialPost: vi.fn(),
  savePostingSchedule: vi.fn(),
  saveSocialPost: vi.fn(),
}));

import {
  createAvatarRepairHandler,
  createSchedulerWebMcpTools,
  SchedulerStatusLine,
} from "./post-scheduler";

const missingAvatar: SchedulerConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "instagram",
  handle: "bizibeast",
  displayName: "Bizibeast",
  avatarUrl: null,
  status: "active",
  connectedAt: "2026-08-24T00:00:00.000Z",
  canPublish: true,
  publishBlockReason: null,
};

describe("SchedulerStatusLine", () => {
  it("requests another repair when missing-account data is refreshed", async () => {
    const onAvatarError = vi.fn();
    const { rerender } = render(
      <SchedulerStatusLine
        connections={[missingAvatar]}
        posts={[]}
        onAvatarError={onAvatarError}
      />,
    );

    await waitFor(() => expect(onAvatarError).toHaveBeenCalledWith(missingAvatar.id));

    rerender(
      <SchedulerStatusLine
        connections={[{ ...missingAvatar }]}
        posts={[]}
        onAvatarError={onAvatarError}
      />,
    );
    expect(onAvatarError).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent repairs and retries a failed repair after cooldown", async () => {
    let now = 1_000;
    const refresh = vi
      .fn<() => Promise<{ id: string; avatarUrl: string }>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ id: missingAvatar.id, avatarUrl: "https://bento.surf/avatar.png" });
    const onSuccess = vi.fn();
    const repair = createAvatarRepairHandler({
      refresh,
      onSuccess,
      now: () => now,
      retryDelayMs: 30_000,
    });

    await Promise.all([repair(missingAvatar.id), repair(missingAvatar.id)]);
    expect(refresh).toHaveBeenCalledOnce();

    await repair(missingAvatar.id);
    expect(refresh).toHaveBeenCalledOnce();

    now += 30_000;
    await repair(missingAvatar.id);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith({
      id: missingAvatar.id,
      avatarUrl: "https://bento.surf/avatar.png",
    });
  });
});

describe("scheduler WebMCP tools", () => {
  it("caps projected scheduler connections", async () => {
    const tools = createSchedulerWebMcpTools({
      data: {
        locked: false,
        connections: Array.from({ length: 125 }, (_, index) => ({
          ...missingAvatar,
          id: `${index}`,
        })),
        posts: [],
        postingSchedule: null,
      } as never,
      onData: vi.fn(),
      onAvatar: vi.fn(),
    });
    const read = tools.find((tool) => tool.name === "bento_get_scheduler_workspace")!;
    const result = (await read.execute({}, { signal: new AbortController().signal })) as {
      structuredContent: { scheduler: { connections: unknown[] } };
    };

    expect(result.structuredContent.scheduler.connections).toHaveLength(100);
  });

  it("fails closed before mutations and applies an approved lifecycle result", async () => {
    const onData = vi.fn();
    const onAvatar = vi.fn();
    const tools = createSchedulerWebMcpTools({
      data: undefined,
      onData,
      onAvatar,
    });
    const manage = tools.find((tool) => tool.name === "bento_manage_scheduler")!;
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(
      manage.execute(
        { action: "cancel_post", id: missingAvatar.id },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("did not approve");
    expect(cancelSocialPost).not.toHaveBeenCalled();

    const next = {
      locked: false,
      plan: "creator",
      connections: [],
      posts: [],
      providers: [],
      readiness: {},
      postingSchedule: { timezone: "UTC", slots: [], naturalOffset: false },
    };
    vi.mocked(cancelSocialPost).mockResolvedValue(next as never);
    await manage.execute(
      { action: "cancel_post", id: missingAvatar.id },
      { signal: new AbortController().signal },
    );
    expect(cancelSocialPost).toHaveBeenCalledWith({ data: { id: missingAvatar.id } });
    expect(onData).toHaveBeenCalledWith(next);
    expect(savePostingSchedule).not.toHaveBeenCalled();
  });
});
