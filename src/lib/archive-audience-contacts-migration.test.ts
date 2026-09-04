import archiveMigration from "../../supabase/migrations/20260901065324_archive_audience_contacts.sql?raw";
import { describe, expect, it } from "vitest";

describe("archive audience contacts migration", () => {
  it("serializes subscribed creator contacts and exposes only a service RPC", () => {
    expect(archiveMigration).toMatch(
      /create or replace function public\.archive_audience_contacts\(\s*p_creator_id uuid,\s*p_contact_ids uuid\[\]\s*\)[\s\S]*security definer[\s\S]*set search_path = ''/,
    );
    expect(archiveMigration).toMatch(
      /from public\.profiles profile[\s\S]*where profile\.id = p_creator_id[\s\S]*for update/,
    );
    expect(archiveMigration).toMatch(
      /from public\.audience_contacts contact[\s\S]*contact\.creator_id = p_creator_id[\s\S]*contact\.id = any\(p_contact_ids\)[\s\S]*contact\.marketing_status = 'subscribed'[\s\S]*for update/,
    );
    expect(archiveMigration).toContain("'creator_archive'");
    expect(archiveMigration).toContain("return transitioned_count;");
    expect(archiveMigration).toContain(
      "revoke all on function public.archive_audience_contacts(uuid, uuid[])\n  from public, anon, authenticated;",
    );
    expect(archiveMigration).toContain(
      "grant execute on function public.archive_audience_contacts(uuid, uuid[]) to service_role;",
    );
    expect(archiveMigration).not.toMatch(/grant execute[\s\S]*to (anon|authenticated)/);
  });
});
