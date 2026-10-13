import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  requireContentWorkspace: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./content-access.server", () => ({
  requireContentWorkspace: mocks.requireContentWorkspace,
}));

import {
  manageMcpContentBrain,
  manageMcpContentMedia,
  manageMcpContentRoutine,
} from "./mcp.content-ops.server";

const userId = "00000000-0000-4000-8000-000000000001";
const itemId = "00000000-0000-4000-8000-000000000002";

function query(result: { data: unknown; error: unknown }) {
  const conditions: Array<[string, unknown]> = [];
  const builder = {
    conditions,
    update: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      conditions.push([column, value]);
      return builder;
    }),
    maybeSingle: vi.fn(async () => result),
  };
  return builder;
}

describe("Content MCP ownership", () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.rpc.mockReset();
    mocks.requireContentWorkspace.mockReset();
  });

  it("rejects edits to another creator's Brain item", async () => {
    const row = query({ data: null, error: null });
    mocks.from.mockReturnValue(row);

    await expect(
      manageMcpContentBrain(userId, { action: "lock_item", id: itemId, locked: true }),
    ).rejects.toThrow("could not be changed");
    expect(mocks.requireContentWorkspace).toHaveBeenCalledWith(userId);
    expect(row.conditions).toContainEqual(["id", itemId]);
    expect(row.conditions).toContainEqual(["user_id", userId]);
  });

  it("checks both the routine read and update against the owner", async () => {
    const loaded = query({
      data: { schedule: { intervalMinutes: 1_440, time: "09:00" }, timezone: "UTC" },
      error: null,
    });
    const updated = query({ data: null, error: null });
    mocks.from.mockReturnValueOnce(loaded).mockReturnValueOnce(updated);

    await expect(
      manageMcpContentRoutine(userId, { action: "pause", id: itemId, paused: true }),
    ).rejects.toThrow("could not be changed");
    expect(loaded.conditions).toContainEqual(["user_id", userId]);
    expect(updated.conditions).toContainEqual(["user_id", userId]);
  });

  it("checks folder and Media ownership before moving an item", async () => {
    const folder = query({ data: { id: itemId }, error: null });
    const media = query({ data: null, error: null });
    mocks.from.mockReturnValueOnce(folder).mockReturnValueOnce(media);

    await expect(
      manageMcpContentMedia(userId, { action: "move_item", id: itemId, folderId: itemId }),
    ).rejects.toThrow("could not be moved");
    expect(folder.conditions).toContainEqual(["user_id", userId]);
    expect(media.conditions).toContainEqual(["user_id", userId]);
    expect(media.conditions).toContainEqual(["status", "ready"]);
  });

  it("rejects a Brain upload key outside the signed-in account", async () => {
    await expect(
      manageMcpContentMedia(userId, {
        action: "register_upload",
        key: "users/00000000-0000-4000-8000-000000000099/image/photo.jpg",
        name: "Photo",
      }),
    ).rejects.toThrow("not in your Media library");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes the authorized account to hero-image assignment", async () => {
    mocks.rpc.mockResolvedValue({ error: null });
    await expect(
      manageMcpContentMedia(userId, { action: "set_hero", slot: 2, id: itemId }),
    ).resolves.toEqual({ saved: true });
    expect(mocks.rpc).toHaveBeenCalledWith("set_creator_hero_media", {
      p_user_id: userId,
      p_media_id: itemId,
      p_slot: 2,
    });
  });
});
