import { expect, test } from "@playwright/test";

test("landing page renders the branded hero", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Add liquidity to Meteora/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Launch app" }).first()).toBeVisible();
});

test("app route renders the pool discovery view", async ({ page }) => {
  await page.goto("/app");

  await expect(page.getByRole("heading", { name: "Discover pools" })).toBeVisible();
  await expect(page.getByPlaceholder("Search SOL, JUP, or paste CA...")).toBeVisible();
});
