import { beforeEach, expect, it, vi } from "vitest";
const getUser = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { auth: { getUser } } }));
import { guardCreatorDocument } from "./creator-document-auth.server";
beforeEach(() => getUser.mockReset());
it("redirects signed-out private documents before rendering and preserves the destination", async () => {
  const result = await guardCreatorDocument(
    new Request("http://localhost:8080/store?tab=products"),
  );
  expect(result?.status).toBe(302);
  expect(result?.headers.get("location")).toBe(
    "http://localhost:8080/login?redirect=%2Fstore%3Ftab%3Dproducts",
  );
  expect(getUser).not.toHaveBeenCalled();
});
it("validates the token instead of trusting cookie presence", async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
  const request = new Request("http://localhost:8080/home", {
    headers: { cookie: "bento_creator_access=" + "x".repeat(40) },
  });
  expect((await guardCreatorDocument(request))?.status).toBe(302);
  getUser.mockResolvedValue({ data: { user: { id: "creator" } }, error: null });
  expect(await guardCreatorDocument(request)).toBeNull();
});
it("does not gate login, buyer access, or public pages", async () => {
  for (const path of [
    "/login",
    "/signup",
    "/library",
    "/review/customer-token",
    "/payments/paypal/return",
    "/integrations/social/instagram/callback",
    "/access/token",
    "/@creator/products/course",
  ])
    expect(await guardCreatorDocument(new Request("http://localhost:8080" + path))).toBeNull();
});

it("leaves custom-domain creator pages alone", async () => {
  expect(await guardCreatorDocument(new Request("https://creator.example/settings"))).toBeNull();
});
