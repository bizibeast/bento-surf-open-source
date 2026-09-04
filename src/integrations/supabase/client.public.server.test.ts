import { afterEach, describe, expect, it, vi } from "vitest";

const createClient = vi.fn(() => ({ from: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient }));

describe("public server Supabase client", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
    createClient.mockClear();
  });

  it("uses the publishable key without requiring a service-role key", async () => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    };
    delete (process.env as Record<string, string | undefined>).SUPABASE_SERVICE_ROLE_KEY;

    const { supabasePublic } = await import("./client.public.server");
    void supabasePublic.from;

    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "publishable-key",
      expect.objectContaining({
        auth: expect.objectContaining({
          persistSession: false,
          autoRefreshToken: false,
        }),
      }),
    );
  });

  it("reports missing public configuration without mentioning the service-role key", async () => {
    process.env = { ...originalEnv };
    delete (process.env as Record<string, string | undefined>).SUPABASE_URL;
    delete (process.env as Record<string, string | undefined>).SUPABASE_PUBLISHABLE_KEY;
    delete (process.env as Record<string, string | undefined>).SUPABASE_SERVICE_ROLE_KEY;

    const { supabasePublic } = await import("./client.public.server");

    expect(() => supabasePublic.from).toThrow(
      "Missing Supabase environment variable(s): SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY.",
    );
  });
});
