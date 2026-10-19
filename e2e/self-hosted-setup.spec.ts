import { expect, test } from "@playwright/test";

test("self-hosted setup is usable before provider configuration", async ({ page }) => {
  const errors: string[] = [];
  const mutations: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
      mutations.push(request.url());
  });
  await page.goto("/self-hosted-setup", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Make this instance yours." })).toBeVisible();
  const signingKey = page.getByLabel("WORKSPACE_COOKIE_SIGNING_KEY", { exact: true });
  await expect(signingKey).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Generate a random key" }).click();
  await expect(signingKey).toHaveValue(/^[a-f0-9]{96}$/);
  await page.getByRole("button", { name: "Show WORKSPACE_COOKIE_SIGNING_KEY" }).click();
  await expect(signingKey).toHaveAttribute("type", "text");
  await expect(page.getByRole("heading", { name: "Choose your integrations" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
  expect(mutations).toEqual([]);
});
