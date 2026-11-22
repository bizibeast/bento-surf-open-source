import { beforeEach, expect, it, vi } from "vitest";
import { studioStarter } from "./content-studio";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
const mock = vi.hoisted(() => ({ read: vi.fn(), active: "active" }));
const workspaceId = "00000000-0000-4000-8000-000000000001",
  entryId = "00000000-0000-4000-8000-000000000002";
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (x: unknown) => x;
    const fn = {
      middleware: () => fn,
      validator: (v: typeof validate) => {
        validate = v;
        return fn;
      },
      handler: (h: (x: unknown) => unknown) => (input: { data: unknown }) =>
        h({
          data: validate(input.data),
          context: {
            workspaceId: "00000000-0000-4000-8000-000000000001",
            workspaceSession: { workspace: { status: mock.active } },
          },
        }),
    };
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./content-chat.server", () => ({ readChatContentEntry: mock.read }));
import { getChatContentArtifact } from "./content-chat.functions";
beforeEach(() => {
  vi.clearAllMocks();
  mock.active = "active";
  mock.read.mockResolvedValue({
    ...studioStarter("reel", "kinetic", DEFAULT_AGENT_BRANDING),
    id: entryId,
    revision: 1,
  });
});
it("returns a safe summary without the editable document", async () => {
  const result = await getChatContentArtifact({ data: { workspaceId, entryId } });
  expect(result).toMatchObject({ id: entryId, format: "reel", revision: 1 });
  expect(result).not.toHaveProperty("document");
  expect(result.outline).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        heading: expect.any(String),
        text: expect.any(String),
        duration: expect.any(Number),
      }),
    ]),
  );
  expect(result.outline[0]).not.toHaveProperty("mediaId");
  expect(result.outline[0]).not.toHaveProperty("narrationJobId");
  expect(mock.read).toHaveBeenCalledWith(workspaceId, entryId);
});
it("rejects another workspace before reading content", async () => {
  await expect(getChatContentArtifact({ data: { workspaceId: entryId, entryId } })).rejects.toThrow(
    "unavailable",
  );
  expect(mock.read).not.toHaveBeenCalled();
});
it("rejects an inactive workspace", async () => {
  mock.active = "suspended";
  await expect(getChatContentArtifact({ data: { workspaceId, entryId } })).rejects.toThrow(
    "unavailable",
  );
  expect(mock.read).not.toHaveBeenCalled();
});
