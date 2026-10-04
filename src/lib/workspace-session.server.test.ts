import { beforeEach, describe, expect, it, vi } from "vitest";

const ids = {
  auth: "11111111-1111-4111-8111-111111111111",
  original: "22222222-2222-4222-8222-222222222222",
  second: "33333333-3333-4333-8333-333333333333",
  foreign: "44444444-4444-4444-8444-444444444444",
};

const mocks = vi.hoisted(() => ({
  memberships: [] as Array<Record<string, unknown>>,
  preference: null as { app_theme: string } | null,
}));

function queryFor(table: string) {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.order = vi.fn(async () => ({
    data: table === "workspace_memberships" ? mocks.memberships : [],
    error: null,
  }));
  query.maybeSingle = vi.fn(async () => ({
    data: table === "account_preferences" ? mocks.preference : null,
    error: null,
  }));
  return query;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => queryFor(table) },
}));

import {
  resolveWorkspace,
  signWorkspaceCookie,
  verifyWorkspaceCookie,
} from "./workspace-session.server";

function membership(
  workspaceId: string,
  status: "pending" | "active" | "locked",
  createdAt: string,
) {
  return {
    workspace_id: workspaceId,
    created_at: createdAt,
    profiles: {
      id: workspaceId,
      username: `profile-${workspaceId[0]}`,
      display_name: `Workspace ${workspaceId[0]}`,
      avatar_url: null,
      workspace_status: status,
      plan_id: "creator",
    },
  };
}

beforeEach(() => {
  mocks.memberships = [
    membership(ids.original, "active", "2026-01-01T00:00:00.000Z"),
    membership(ids.second, "active", "2026-02-01T00:00:00.000Z"),
  ];
  mocks.preference = { app_theme: "dark" };
});

describe("workspace cookie signing", () => {
  it("accepts a valid workspace signature and rejects a one-byte forgery", async () => {
    const secret = "s".repeat(32);
    const signed = await signWorkspaceCookie(ids.second, secret);
    const parts = signed.split(".");
    parts[2] = `${parts[2][0] === "a" ? "b" : "a"}${parts[2].slice(1)}`;

    expect(await verifyWorkspaceCookie(signed, secret)).toBe(ids.second);
    expect(await verifyWorkspaceCookie(parts.join("."), secret)).toBeNull();
  });
});

describe("workspace resolution", () => {
  it("uses an accessible active workspace", async () => {
    await expect(resolveWorkspace(ids.auth, ids.second)).resolves.toMatchObject({
      authUserId: ids.auth,
      workspaceId: ids.second,
      appTheme: "dark",
    });
  });

  it("falls back to the oldest active workspace for a foreign request", async () => {
    await expect(resolveWorkspace(ids.auth, ids.foreign)).resolves.toMatchObject({
      workspaceId: ids.original,
    });
  });

  it("does not select a locked workspace", async () => {
    mocks.memberships[1] = membership(ids.second, "locked", "2026-02-01T00:00:00.000Z");

    const session = await resolveWorkspace(ids.auth, ids.second);

    expect(session.workspaceId).toBe(ids.original);
    expect(session.workspaces.find((workspace) => workspace.id === ids.second)?.status).toBe(
      "locked",
    );
  });

  it("uses the oldest active workspace and light theme when selection and preference are missing", async () => {
    mocks.preference = null;

    await expect(resolveWorkspace(ids.auth)).resolves.toMatchObject({
      workspaceId: ids.original,
      appTheme: "light",
    });
  });
});
