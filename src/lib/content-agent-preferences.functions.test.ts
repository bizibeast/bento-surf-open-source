import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), access: vi.fn(), validatePhotos: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const fn = {
      middleware: () => fn,
      validator: (schema: typeof validate) => {
        validate = schema;
        return fn;
      },
      handler:
        (handler: (input: { context: { userId: string }; data: unknown }) => unknown) =>
        async (input?: { data?: unknown }) =>
          handler({ context: { userId: "workspace" }, data: validate(input?.data) }),
    };
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: mocks.access }));

vi.mock("./content-agent-images.server", () => ({
  imageProviderAvailable: () => true,
  validateReferenceSelection: mocks.validatePhotos,
}));
// Namespace import lets missing new exports fail as assertions in the red run.
import * as preferences from "./content-agent-preferences.functions";
import * as identity from "./content-agent-identity.server";

const state = {
  thread: { id: "agent-id", kind: "agent", title: "Bento", unread_count: 0 },
  preferences: {
    user_id: "workspace",
    display_name: "Bento",
    proactive_paused: false,
    generate_images: false,
    use_face_references: false,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: state, error: null });
});

describe("content agent identity and preferences", () => {
  it("uses the active workspace when creating the named agent", async () => {
    expect(preferences.getOrCreateNamedAgentThread).toBeTypeOf("function");
    await preferences.getOrCreateNamedAgentThread();
    expect(mocks.rpc).toHaveBeenCalledWith("ensure_content_named_agent", {
      p_user_id: "workspace",
    });
    expect(mocks.access).toHaveBeenCalledWith("workspace");
  });
  it("returns persisted preferences for the active workspace", async () => {
    await expect(preferences.getContentAgentPreferences()).resolves.toEqual(state.preferences);
    expect(mocks.rpc).toHaveBeenCalledWith("ensure_content_named_agent", {
      p_user_id: "workspace",
    });
  });
  it("exposes identity to trusted jobs without auth middleware", async () => {
    expect(identity.getOrCreateNamedAgentThreadForWorkspace).toBeTypeOf("function");
    await expect(
      identity.getOrCreateNamedAgentThreadForWorkspace("job-workspace"),
    ).resolves.toEqual(state);
    expect(mocks.rpc).toHaveBeenCalledWith("ensure_content_named_agent", {
      p_user_id: "job-workspace",
    });
  });
  it("trims a rename and scopes preference updates to auth workspace", async () => {
    await preferences.updateContentAgentPreferences({
      data: {
        displayName: "  Miso  ",
        generateImages: true,
        useFaceReferences: false,
        userId: "intruder",
      },
    } as never);
    expect(mocks.rpc).toHaveBeenCalledWith("update_content_agent_preferences", {
      p_user_id: "workspace",
      p_patch: { display_name: "Miso", generate_images: true, use_face_references: false },
    });
  });
  it.each(["", "   ", "x".repeat(81), "Bad\nName", "Bento\n"])(
    "rejects an unsafe display name %j",
    async (displayName) => {
      await expect(
        preferences.updateContentAgentPreferences({ data: { displayName } }),
      ).rejects.toThrow();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("does not change independent opt-ins when pausing proactive delivery", async () => {
    await preferences.updateContentAgentPreferences({ data: { proactivePaused: true } });
    expect(mocks.rpc).toHaveBeenCalledWith("update_content_agent_preferences", {
      p_user_id: "workspace",
      p_patch: { proactive_paused: true },
    });
  });
  it("persists a supported platform subset", async () => {
    await preferences.updateContentAgentPreferences({
      data: { platforms: ["linkedin", "instagram"] },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("update_content_agent_preferences", {
      p_user_id: "workspace",
      p_patch: { platforms: ["linkedin", "instagram"] },
    });
  });
  it("rejects unsupported automatic platforms", async () => {
    await expect(
      preferences.updateContentAgentPreferences({ data: { platforms: ["youtube"] } } as never),
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("reports database failures instead of returning missing owner state", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "failed" } });
    await expect(preferences.getOrCreateNamedAgentThread()).rejects.toThrow("could not be loaded");
  });
});

describe("content agent identity migration", () => {
  const path = `${process.cwd()}/supabase/migrations/20261012120000_content_agent_identity.sql`;
  function sql() {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }
  it("keeps existing threads chats and makes agent identity unique per workspace", () => {
    expect(sql()).toMatch(/kind text not null default 'chat'/);
    expect(sql()).toMatch(/unique index[\s\S]*?\(user_id\) where kind = 'agent'/);
  });
  it("isolates preferences with workspace membership checks on both reads and writes", () => {
    expect(sql()).toContain("enable row level security");
    expect(sql()).toContain("using (private.is_workspace_member(user_id))");
    expect(sql()).toContain("with check (private.is_workspace_member(user_id))");
  });
  it("counts only retained assistant messages after the read watermark", () => {
    expect(sql()).toContain("m.role = 'assistant'");
    expect(sql()).toContain("m.expires_at > now()");
    expect(sql()).toContain("m.created_at > t.last_read_at");
    expect(sql()).not.toMatch(/alter table[^;]*expires_at/i);
  });
  it("revokes privileged RPCs from public roles", () => {
    for (const name of [
      "ensure_content_named_agent",
      "update_content_agent_preferences",
      "list_content_agent_threads_page",
      "set_content_agent_thread_state",
    ]) {
      expect(sql()).toMatch(
        new RegExp(
          `revoke all on function public\\.${name}\\([\\s\\S]*?from public, anon, authenticated`,
        ),
      );
    }
  });
});

it("revokes image/photo consent with unchanged unavailable selected photos without reading R2", async () => {
  mocks.rpc.mockResolvedValue({
    data: {
      ...state,
      preferences: {
        ...state.preferences,
        generate_images: true,
        use_face_references: true,
        reference_photo_ids: ["70000000-0000-4000-8000-000000000001"],
      },
    },
    error: null,
  });
  mocks.validatePhotos.mockRejectedValue(new Error("R2 unavailable"));
  await preferences.updateContentAgentPreferences({
    data: {
      generateImages: false,
      useFaceReferences: false,
      referencePhotoIds: ["70000000-0000-4000-8000-000000000001"],
    },
  });
  expect(mocks.validatePhotos).not.toHaveBeenCalled();
  expect(mocks.rpc).toHaveBeenLastCalledWith("update_content_agent_preferences", {
    p_user_id: "workspace",
    p_patch: {
      generate_images: false,
      use_face_references: false,
      reference_photo_ids: ["70000000-0000-4000-8000-000000000001"],
      references_confirmed: false,
    },
  });
});
