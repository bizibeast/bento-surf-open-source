import { beforeEach, expect, it, vi } from "vitest";
import { studioStarter } from "./content-studio";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  authorize: vi.fn(),
  filters: [] as [string, unknown][],
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./content-studio.server", () => ({ requireStudioWorkspace: mocks.authorize }));
import { readChatContentEntry } from "./content-chat.server";
const owner = "00000000-0000-4000-8000-000000000001",
  id = "00000000-0000-4000-8000-000000000002";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.filters = [];
  mocks.authorize.mockResolvedValue(undefined);
});
function row(data: unknown, error: unknown = null) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn((key, value) => {
      mocks.filters.push([key, value]);
      return query;
    }),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  mocks.from.mockReturnValue(query);
  return query;
}
it("reads a single saved entry only after plan authorization and workspace filtering", async () => {
  const entry = { ...studioStarter("reel", "kinetic", DEFAULT_AGENT_BRANDING), id, revision: 2 };
  row(entry);
  expect((await readChatContentEntry(owner, id)).id).toBe(id);
  expect(mocks.authorize).toHaveBeenCalledWith(owner);
  expect(mocks.filters).toEqual([
    ["workspace_id", owner],
    ["id", id],
  ]);
});
it("does not expose foreign, deleted or invalid entries", async () => {
  row(null);
  await expect(readChatContentEntry(owner, id)).rejects.toThrow("unavailable");
  await expect(readChatContentEntry(owner, "invented")).rejects.toThrow();
});
it("does not read content when plan access is denied", async () => {
  mocks.authorize.mockRejectedValue(new Error("Unavailable plan"));
  await expect(readChatContentEntry(owner, id)).rejects.toThrow("Unavailable plan");
  expect(mocks.from).not.toHaveBeenCalled();
});
