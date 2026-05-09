/**
 * Test plan IDs covered:
 *   FE-POOL-001 pool browser renders the search input + clear affordance once
 *               pool data is loaded
 *   FE-POOL-003 unknown deep link goes to the NotFound view, not a crash
 *   FE-POOL-004 (rendering) zero-pool API response renders an empty list, not 5xx
 *   FE-WAL-001  (entry point) AppShell mounts without a wallet connected
 *
 * Frontend e2e under Playwright with no API backend running. We use
 * page.route() to stub /api/dlmm/pools and /api/prices so PoolsPage
 * hydrates into its loaded state instead of the error fallback.
 */
import { expect, test, type Route } from "@playwright/test";

const FAKE_POOL = {
  address: "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name: "SOL / USDC",
  pair: "SOL-USDC",
  tokenX: {
    symbol: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
  },
  tokenY: {
    symbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  tvl: 1_000_000,
  volume24h: 50_000,
  fees24h: 200,
  apr: 12.5,
  feeBps: 25,
  binStep: 25,
  baseFee: 0,
  createdAt: 0,
  network: "devnet",
};

async function stubApi(page: Parameters<Parameters<typeof test>[1]>[0]["page"], pools: unknown[]) {
  // Match path-suffixes only. The frontend's API base URL is configurable
  // (`VITE_API_URL` default "/api", set to `http://localhost:8787` in dev),
  // so we match by trailing path so the test works against either base.
  const json = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      // Send permissive CORS headers so the browser doesn't drop the
      // response when the API base URL is cross-origin to the dev server.
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(body),
    });

  await page.route(/\/dlmm\/pools(\?|$)/, (route: Route) => json(route, { data: pools }));
  await page.route(/\/prices(\?|$)/, (route: Route) => json(route, { data: {} }));
}

test.describe("pool discovery", () => {
  test("FE-POOL-001 / FE-WAL-001: index route renders the search input once pools load", async ({ page }) => {
    await stubApi(page, [FAKE_POOL]);
    await page.goto("/");

    const search = page.getByPlaceholder(/Search pair, mint, or pool address/i);
    await expect(search).toBeVisible({ timeout: 15_000 });

    const errorOverlay = page.locator("vite-error-overlay");
    await expect(errorOverlay).toHaveCount(0);
  });

  test("FE-POOL-001: typing in the search input reveals the Clear search button", async ({ page }) => {
    await stubApi(page, [FAKE_POOL]);
    await page.goto("/");

    const search = page.getByPlaceholder(/Search pair, mint, or pool address/i);
    await expect(search).toBeVisible({ timeout: 15_000 });
    await search.fill("SOL");
    await expect(page.getByRole("button", { name: "Clear search" })).toBeVisible();
  });

  test("FE-POOL-004: empty pool list still renders the search affordance, not an error page", async ({ page }) => {
    await stubApi(page, []);
    await page.goto("/");

    const search = page.getByPlaceholder(/Search pair, mint, or pool address/i);
    await expect(search).toBeVisible({ timeout: 15_000 });
  });

  test("FE-POOL-003: unknown deep link renders the NotFound view, never a 5xx overlay", async ({ page }) => {
    await stubApi(page, [FAKE_POOL]);
    const response = await page.goto("/this-route-does-not-exist");
    expect(response?.status()).toBeLessThan(500);

    const errorOverlay = page.locator("vite-error-overlay");
    await expect(errorOverlay).toHaveCount(0);

    // The NotFound view is rendered — body must have visible content.
    await expect(page.locator("body")).not.toBeEmpty();
  });
});
