import { expect, test } from "@playwright/test";

const routes = ["/", "/explore", "/pricing", "/login", "/signup"];
const isLocalRun = !process.env.PLAYWRIGHT_BASE_URL;

function isExpectedLocalInfrastructureMiss(url: string, status: number) {
  if (!isLocalRun || status !== 503) return false;
  return new URL(url).pathname.startsWith("/api/og/");
}

for (const route of routes) {
  test(`${route} renders without browser exceptions or horizontal overflow`, async ({ page }) => {
    const pageErrors: string[] = [];
    const failedResponses: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (
        response.status() >= 500 &&
        !isExpectedLocalInfrastructureMiss(response.url(), response.status())
      ) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `${route} document response`).toBeLessThan(500);
    await expect(page.locator("body")).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => undefined);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${route} horizontal overflow in pixels`).toBeLessThanOrEqual(1);
    expect(pageErrors, `${route} uncaught browser errors`).toEqual([]);
    expect(failedResponses, `${route} 5xx responses`).toEqual([]);
  });
}
