import { test, expect } from "@playwright/test";
test("V3.2 save library and flagged character lock", async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Studio V3.2" })).toBeVisible();
  await expect(page.getByText(/Google Drive:/)).toContainText("unconfigured");
  await expect(page.getByRole("heading", { name: /Saved projects/ })).toBeVisible();
  await page.locator("input[type=file]").first().setInputFiles("evidence/smoke-output.mp4");
  await expect(page.locator(".scene")).toHaveCount(3, { timeout: 30000 });
  await page.getByLabel("Tên nhân vật").fill("Mai");
  await page.getByLabel("rightsStatus").selectOption("unknown");
  await page.getByLabel("Prompt prefix khóa").fill("LOCKED same face");
  await page.getByRole("button", { name: "Tạo nhân vật" }).click();
  await expect(page.getByText(/rightsStatus unknown/)).toBeVisible();
  await page.getByRole("button", { name: "Gắn vào dự án" }).click();
  await expect(page.getByText("rightsStatus: unknown")).toBeVisible();
  await expect(page.getByLabel("Prefix khóa cảnh 1")).toContainText("LOCKED same face");
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  expect(errors).toEqual([]);
});
